"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeSignalsForSymbols, hasAttemptedAt, lastTry } from "@/lib/refresh";
import { loadCreds, runAiTrader as runAiTraderEngine } from "@/lib/aitrader/engine";
import { RUNNER_LIMITS, defsForBook, effective, overridesOnly, validateLimits } from "@/lib/aitrader/limits";
import type { AiRun } from "@/lib/aitrader/view";
import { planLiveSync, syncWindow, type KnownOrder } from "@/lib/aitrader/live";
import { loadOrders, must } from "@/lib/aitrader/rows";
import { baselineOf, loadAdjustments, sizeOf } from "@/lib/aitrader/cash";
import { AlpacaError, getClock, getDailyBars, getPaperAccount, listFills, listOrders, type Bar, type Creds } from "@/lib/alpaca";
import { rulesFor } from "@/lib/aitrader/plan";
import { freeUniverse } from "@/lib/aitrader/universe";
import { etDate } from "@/lib/aitrader/decide";
import {
  historyStart,
  isPeriod,
  periodStart,
  runBacktest as simulateBacktest,
  type BacktestResult,
  type Period,
} from "@/lib/aitrader/backtest";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import type { Lot } from "@/lib/portfolio";
import { FinnhubError, fetchFinnhubQuote } from "@/lib/livequotes";
import { allow } from "@/lib/ratelimit";

/** One Twelve Data request stays within the free-tier 8-credits/minute budget. */
const REFRESH_BATCH = 8;

/** Per-user rate limits (lib/ratelimit.ts): each add spends a Twelve Data credit, each refresh up to 8. */
const ADD_TICKER_LIMIT = { max: 10, windowMs: 60_000 };
const REFRESH_LIMIT = { max: 1, windowMs: 60_000 };

/** Compute a signal for one symbol right away (best-effort; never blocks the UI
 *  on failure). Used when a ticker is first added so its metrics aren't blank
 *  until the next daily cron run. */
async function refreshOne(symbol: string) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return;
  try {
    await computeSignalsForSymbols([symbol], apiKey, createAdminClient());
  } catch {
    /* leave it for the manual Refresh button / daily cron */
  }
}

const MAX_WATCHLIST = 80; // per-user cap (also enforced by a DB trigger)
const MAX_DEVICE_TOKENS = 5; // per-user cap on paired devices

function cleanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
}

async function uid() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Add a watch-only ticker (no position yet). */
export async function addTicker(formData: FormData) {
  const symbol = cleanSymbol(String(formData.get("symbol") ?? ""));
  if (!symbol) return;
  const { supabase, user } = await uid();
  if (!user) return;
  if (!allow(`addTicker:${user.id}`, ADD_TICKER_LIMIT.max, ADD_TICKER_LIMIT.windowMs)) return;
  const { count } = await supabase
    .from("watchlist")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_WATCHLIST) return;
  const { error } = await supabase
    .from("watchlist")
    .insert({ user_id: user.id, symbol, watch_only: true, lots: [] });
  if (error) return;
  await refreshOne(symbol); // populate its metrics now, not on the next daily cron
  revalidatePath("/dashboard");
}

/**
 * Manually recompute signals for the signed-in user's watchlist, stalest first.
 * One batch (<= REFRESH_BATCH symbols) per call so it stays inside the free-tier
 * 8-credits/minute budget and returns fast; `total` vs `refreshed` lets the UI
 * say whether another click would cover more. Scoped to the user's own symbols.
 */
export async function refreshSignals(): Promise<
  { updated: number; refreshed: number; total: number } | { error: string }
> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return { error: "market data not configured" };
  if (!allow(`refreshSignals:${user.id}`, REFRESH_LIMIT.max, REFRESH_LIMIT.windowMs)) {
    return { error: "signals were just refreshed — try again in a minute" };
  }

  const { data: wl } = await supabase.from("watchlist").select("symbol").eq("user_id", user.id);
  const symbols = Array.from(new Set((wl ?? []).map((r) => r.symbol as string)));
  if (symbols.length === 0) return { updated: 0, refreshed: 0, total: 0 };

  const admin = createAdminClient();
  // Stalest first (by last attempt, else last signal) so repeated clicks rotate coverage.
  const { data: meta } = await admin
    .from("symbol_signals")
    .select((await hasAttemptedAt(admin)) ? "symbol, updated_at, attempted_at" : "symbol, updated_at")
    .in("symbol", symbols);
  const last = new Map(
    ((meta ?? []) as unknown as { symbol: string; updated_at: string | null; attempted_at?: string | null }[]).map((m) => [m.symbol, lastTry(m)])
  );
  const ordered = symbols
    .slice()
    .sort((a, b) => (last.get(a) ?? "").localeCompare(last.get(b) ?? ""));
  const batch = ordered.slice(0, REFRESH_BATCH);

  const { updated } = await computeSignalsForSymbols(batch, apiKey, admin);
  revalidatePath("/dashboard");
  return { updated, refreshed: batch.length, total: symbols.length };
}

export async function removeSymbol(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  if (!symbol) return;
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase.from("watchlist").delete().eq("user_id", user.id).eq("symbol", symbol);
  revalidatePath("/dashboard");
}

/** Record a buy (a lot): qty at price on an optional date. Promotes a watch-only
 *  ticker into a held position; creates the row if the symbol is new. */
export async function addLot(formData: FormData) {
  const symbol = cleanSymbol(String(formData.get("symbol") ?? ""));
  const qty = parseFloat(String(formData.get("qty") ?? ""));
  const priceV = parseFloat(String(formData.get("price") ?? ""));
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(priceV) || priceV < 0) return;

  const { supabase, user } = await uid();
  if (!user) return;

  const lot: Lot = { qty, price: priceV };
  if (dateStr) {
    const t = Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000);
    if (Number.isFinite(t)) lot.date = t;
  }

  const { data: row } = await supabase
    .from("watchlist")
    .select("id, lots")
    .eq("user_id", user.id)
    .eq("symbol", symbol)
    .maybeSingle();

  if (row) {
    const lots = (Array.isArray(row.lots) ? row.lots : []) as Lot[];
    lots.push(lot);
    await supabase.from("watchlist").update({ lots, watch_only: false }).eq("id", row.id);
  } else {
    const { count } = await supabase
      .from("watchlist")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);
    if ((count ?? 0) >= MAX_WATCHLIST) return;
    await supabase
      .from("watchlist")
      .insert({ user_id: user.id, symbol, lots: [lot], watch_only: false });
  }
  revalidatePath("/dashboard");
}

/** Remove one lot by index. If none remain, the row reverts to watch-only. */
export async function removeLot(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  const idx = parseInt(String(formData.get("index") ?? ""), 10);
  if (!symbol || !Number.isInteger(idx)) return;
  const { supabase, user } = await uid();
  if (!user) return;
  const { data: row } = await supabase
    .from("watchlist")
    .select("id, lots")
    .eq("user_id", user.id)
    .eq("symbol", symbol)
    .maybeSingle();
  if (!row) return;
  const lots = ((Array.isArray(row.lots) ? row.lots : []) as Lot[]).filter((_, i) => i !== idx);
  await supabase
    .from("watchlist")
    .update({ lots, watch_only: lots.length === 0 })
    .eq("id", row.id);
  revalidatePath("/dashboard");
}

/** Set / clear price alerts for a symbol. Empty string clears. */
export async function setAlerts(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  if (!symbol) return;
  const aStr = String(formData.get("above") ?? "").trim();
  const bStr = String(formData.get("below") ?? "").trim();
  const above = aStr === "" ? null : parseFloat(aStr);
  const below = bStr === "" ? null : parseFloat(bStr);
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase
    .from("watchlist")
    .update({
      alert_above: above != null && Number.isFinite(above) ? above : null,
      alert_below: below != null && Number.isFinite(below) ? below : null,
    })
    .eq("user_id", user.id)
    .eq("symbol", symbol);
  revalidatePath("/dashboard");
}

/**
 * Mint a device token so the Stocky hardware can read this user's signals.
 * Only the SHA-256 hash is stored; the raw token is returned once for display.
 */
export async function createDeviceToken(
  canWrite = false
): Promise<{ token: string } | { error: string }> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  const { count } = await supabase
    .from("device_tokens")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_DEVICE_TOKENS) return { error: `device limit reached (${MAX_DEVICE_TOKENS})` };
  const raw = "stk_" + randomBytes(24).toString("hex");
  const token_hash = createHash("sha256").update(raw).digest("hex");
  // Write scope is opt-in: a read-only token can display signals/holdings but
  // cannot push edits back to the watchlist.
  const { error } = await supabase
    .from("device_tokens")
    .insert({ user_id: user.id, token_hash, can_write: canWrite });
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { token: raw };
}

export async function revokeDeviceToken(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase.from("device_tokens").delete().eq("user_id", user.id).eq("id", id);
  revalidatePath("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Run the AI Trader's paper books now (Run now), or compute the decisions without
 * placing anything (Dry run). Only for a user who owns AI books.
 */
export async function runAiTrader(
  mode: "manual" | "dry"
): Promise<{ message: string } | { error: string }> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  const { data: books } = await supabase.from("ai_books").select("id").eq("user_id", user.id);
  if (!books?.length) return { error: "AI Trader isn't enabled for this account" };
  try {
    const res = await runAiTraderEngine({ admin: createAdminClient(), mode, userId: user.id });
    revalidatePath("/dashboard");
    const failed = res.filter((r) => r.error);
    if (failed.length) return { error: failed.map((r) => `${r.book}: ${r.error}`).join(" · ") };
    if (res.length && res.every((r) => r.note?.startsWith("Alpaca paper account not connected"))) {
      return { error: "Connect your Alpaca paper account first (card below)." };
    }
    if (res.length && res.every((r) => r.note?.startsWith("another run for this account is in progress"))) {
      return { error: "Another run (the scheduled one or a second click) is in progress — try again in a minute." };
    }
    const n = (a: string) => res.reduce((k, r) => k + r.decisions.filter((d) => d.action === a).length, 0);
    const verb = mode === "dry" ? "Dry run (nothing placed)" : "Run complete";
    return { message: `${verb}: ${n("buy")} buy, ${n("sell")} sell, ${n("cancel")} cancel` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}


/* ---------------- AI Trader: paper account + limits ---------------- */

type Result = { message: string } | { error: string };

/**
 * Connect the user's own Alpaca PAPER account. The keys are checked against
 * Alpaca (must be a PK… key on a PA… paper account), then stored encrypted in
 * Supabase Vault under the user's id — never in an env var, never sent back to
 * the browser. Only a hint ("PA…1234") is kept in a readable table.
 */
export async function connectAlpaca(formData: FormData): Promise<Result> {
  const { user } = await uid();
  if (!user) return { error: "not signed in" };
  const keyId = String(formData.get("key_id") ?? "").trim();
  const secret = String(formData.get("secret") ?? "").trim();
  if (!/^PK[A-Z0-9]{10,40}$/.test(keyId)) return { error: "That isn't a paper key ID (paper keys start with PK)." };
  if (secret.length < 20 || secret.length > 128 || /\s/.test(secret)) return { error: "That secret doesn't look right." };
  let account: string;
  try {
    account = (await getPaperAccount({ keyId, secret })).account_number;
  } catch (e) {
    const msg = e instanceof AlpacaError && e.status === 401 ? "Alpaca rejected these keys." : e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
  const admin = createAdminClient();
  const { error: vErr } = await admin.rpc("set_alpaca_credentials", { p_user: user.id, p_key_id: keyId, p_secret: secret });
  if (vErr) return { error: `Couldn't store the keys: ${vErr.message}` };
  const { error: cErr } = await admin
    .from("broker_connections")
    .upsert({ user_id: user.id, account_hint: `${account.slice(0, 2)}…${account.slice(-4)}`, connected_at: new Date().toISOString() });
  if (cErr) return { error: cErr.message };
  revalidatePath("/dashboard");
  return { message: "Paper account connected." };
}

export async function disconnectAlpaca(): Promise<Result> {
  const { user } = await uid();
  if (!user) return { error: "not signed in" };
  const admin = createAdminClient();
  const { error: vErr } = await admin.rpc("remove_alpaca_credentials", { p_user: user.id });
  if (vErr) return { error: vErr.message };
  const { error } = await admin.from("broker_connections").delete().eq("user_id", user.id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: "Disconnected — the keys were deleted." };
}

/* ---------------- Live prices: the user's Finnhub key ---------------- */

/**
 * Store the user's Finnhub key for live prices. It's checked with one real
 * /quote call, then kept encrypted in Supabase Vault. It is never put in an env
 * var or sent back to the browser; only a hint ("…a1b2") stays readable.
 */
export async function connectFinnhub(formData: FormData): Promise<Result> {
  const { user } = await uid();
  if (!user) return { error: "not signed in" };
  const key = String(formData.get("key") ?? "").trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(key)) return { error: "That doesn't look like a Finnhub API key." };
  try {
    const q = await fetchFinnhubQuote("AAPL", key);
    if (!q) return { error: "Finnhub answered but returned no price. Check the key on finnhub.io." };
  } catch (e) {
    const msg =
      e instanceof FinnhubError && (e.status === 401 || e.status === 403)
        ? "Finnhub rejected this key."
        : e instanceof FinnhubError && e.status === 429
          ? "Finnhub says this key is over its rate limit right now. Try again in a minute."
          : "Couldn't reach Finnhub to check the key.";
    return { error: msg };
  }
  const admin = createAdminClient();
  const { error: vErr } = await admin.rpc("set_finnhub_key", { p_user: user.id, p_key: key });
  if (vErr) return { error: `Couldn't store the key: ${vErr.message}` };
  const { error: cErr } = await admin
    .from("price_connections")
    .upsert({ user_id: user.id, key_hint: `…${key.slice(-4)}`, connected_at: new Date().toISOString() });
  if (cErr) return { error: cErr.message };
  revalidatePath("/dashboard");
  return { message: "Live prices on." };
}

export async function disconnectFinnhub(): Promise<Result> {
  const { user } = await uid();
  if (!user) return { error: "not signed in" };
  const admin = createAdminClient();
  const { error: vErr } = await admin.rpc("remove_finnhub_key", { p_user: user.id });
  if (vErr) return { error: vErr.message };
  const { error } = await admin.from("price_connections").delete().eq("user_id", user.id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: "Removed. The key was deleted." };
}

/**
 * Save one box's limits (validated + clamped against the shared definitions).
 * A change of the box's size (`budget`) is recorded as a dated cash adjustment
 * (supabase/ai_cash_adjustments.sql) — ai_books.start_cash is never rewritten,
 * so history and the daily-loss halt's baseline stay right. Rules and Claude boxes.
 */
export async function saveBookLimits(bookKey: string, values: Record<string, unknown>): Promise<Result> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  // RLS: only finds the user's own book.
  const { data: book, error: bookErr } = await supabase.from("ai_books").select("id, key, start_cash, settings").eq("key", bookKey).maybeSingle();
  if (bookErr) return { error: bookErr.message };
  if (!book) return { error: "no such book" };
  const isClaude = String(book.key).startsWith("claude-");
  const defs = defsForBook(String(book.key));
  const v = validateLimits(defs, values);
  if (!v.ok) return { error: v.errors.join(" · ") };
  const admin = createAdminClient();
  const sized = await recordSizeChange(admin, book, Number(effective(defs, v.settings).budget));
  if ("error" in sized) return sized;
  // Only what differs from the defaults is stored: a later default change reaches this box too.
  const { error } = await admin.from("ai_books").update({ settings: overridesOnly(defs, v.settings) }).eq("id", book.id);
  if (error) {
    if (sized.adjustmentId) await admin.from("ai_cash_adjustments").delete().eq("id", sized.adjustmentId);
    return { error: error.message };
  }
  revalidatePath("/dashboard");
  return { message: isClaude ? "Saved — the Mac applies them before Claude's next run." : "Saved — used from the next run." };
}

/**
 * Reset one box's limits to the defaults: clears every saved override EXCEPT the box's size (budget),
 * so start_cash, the P&L baseline and the ledger are untouched. Used by the tab's "Reset to defaults".
 */
export async function resetBookLimits(bookKey: string): Promise<Result> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  // RLS: only finds the user's own book.
  const { data: book, error: bookErr } = await supabase.from("ai_books").select("id, key, settings").eq("key", bookKey).maybeSingle();
  if (bookErr) return { error: bookErr.message };
  if (!book) return { error: "no such book" };
  const defs = defsForBook(String(book.key));
  const saved = (book.settings as Record<string, unknown> | null) ?? {};
  const keep = validateLimits(defs.filter((d) => d.key === "budget"), { budget: saved.budget });
  const settings = keep.ok ? overridesOnly(defs, keep.settings) : {};
  const { error } = await createAdminClient().from("ai_books").update({ settings }).eq("id", book.id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: "Reset to the defaults (the box size is kept)." };
}

/** Record a new box size as a dated cash adjustment (new − current baseline); nothing when the size is unchanged. */
async function recordSizeChange(
  admin: ReturnType<typeof createAdminClient>,
  book: { id: string; key: string; start_cash: number; settings: Record<string, unknown> | null },
  budget: number
): Promise<{ adjustmentId: string | null } | { error: string }> {
  if (!Number.isFinite(budget) || budget <= 0) return { adjustmentId: null };
  let adj;
  try {
    adj = await loadAdjustments(admin, [book.id]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (Math.abs(budget - sizeOf(book, adj.list)) < 0.005) return { adjustmentId: null };
  if (adj.missing) {
    return { error: "Book size can't change yet: apply supabase/ai_cash_adjustments.sql first (other settings save fine with the size unchanged)." };
  }
  const amount = Math.round((budget - baselineOf(book.start_cash, adj.list, book.id)) * 100) / 100;
  const { data, error } = await admin
    .from("ai_cash_adjustments")
    .insert({ book_id: book.id, amount, reason: `book size to ${budget}` })
    .select("id")
    .maybeSingle();
  if (error) return { error: `Couldn't record the size change: ${error.message}` };
  return { adjustmentId: (data?.id as string | undefined) ?? null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove one lesson or suggestion (ai_notes, supabase/ai_notes.sql) so Claude stops reading it.
 * Kept as a soft delete (removed_at): the Mac rebuilds the book's lessons file from the active notes
 * before every Claude run, and the unique key stops the same text coming back for that day.
 */
export async function removeNote(noteId: string): Promise<Result> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  if (typeof noteId !== "string" || !UUID_RE.test(noteId)) return { error: "no such note" };
  // RLS: only returns the user's own notes (owner-read policy through ai_books).
  const { data: note, error: readErr } = await supabase.from("ai_notes").select("id, removed_at").eq("id", noteId).maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!note) return { error: "no such note" };
  if (note.removed_at) return { message: "Already removed." };
  const { error } = await createAdminClient()
    .from("ai_notes")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", noteId)
    .is("removed_at", null);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: "Removed — Claude stops reading it from its next run." };
}

/** Save how often Claude runs and the weekly usage cap (read by the Mac's watcher). */
export async function saveRunnerSettings(values: Record<string, unknown>): Promise<Result> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  const { data: books } = await supabase.from("ai_books").select("id").like("key", "claude-%");
  if (!books?.length) return { error: "Claude books aren't enabled for this account" };
  const v = validateLimits(RUNNER_LIMITS, values);
  if (!v.ok) return { error: v.errors.join(" · ") };
  const { error } = await createAdminClient()
    .from("ai_runner")
    .upsert({ user_id: user.id, settings: v.settings, updated_at: new Date().toISOString() });
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: "Saved — the Mac picks it up within 5 minutes." };
}

/** One run in full (trace + pipeline), for the run timeline. */
/**
 * Bring the user's books up to date from Alpaca (called by the open AI Trader tab
 * every few seconds). Reads Alpaca, writes only the ledger; never touches an order.
 */
export async function syncLive(): Promise<{ ok: true } | { error: string }> {
  const { user } = await uid();
  if (!user) return { error: "not signed in" };
  const admin = createAdminClient();
  try {
    const creds = await loadCreds(admin, user.id);
    if (!creds) return { ok: true };
    const { data: books } = await admin.from("ai_books").select("id, key, created_at").eq("user_id", user.id);
    if (!books?.length) return { ok: true };
    const ids = books.map((b) => b.id as string);
    const known = await loadOrders<KnownOrder & { created_at: string }>(
      admin,
      ids,
      "id, book_id, alpaca_order_id, leg_ids, status, filled_qty, filled_avg, created_at"
    );
    const since = books.map((b) => b.created_at as string).sort()[0];
    // Cursor: the newest fill already recorded for this user's books — read only what's new since.
    const { data: lastFill, error: lfErr } = await admin
      .from("ai_fills")
      .select("transacted_at")
      .in("book_id", ids)
      .order("transacted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lfErr) return { error: `ai_fills: ${lfErr.message}` };
    const win = syncWindow(since, (lastFill?.transacted_at as string | undefined) ?? null, known);
    const [remote, fills] = await Promise.all([listOrders(creds, win.ordersAfter), listFills(creds, win.fillsAfter)]);
    const plan = planLiveSync(
      known,
      remote,
      fills,
      new Map(books.map((b) => [b.key as string, b.id as string]))
    );
    for (const r of await Promise.all(plan.updates.map((u) => admin.from("ai_orders").update(u.patch).eq("id", u.id)))) {
      must("ai_orders update", r);
    }
    if (plan.inserts.length) {
      must("ai_orders insert", await admin.from("ai_orders").upsert(plan.inserts, { onConflict: "alpaca_order_id", ignoreDuplicates: true }));
    }
    if (plan.fillRows.length) {
      must("ai_fills upsert", await admin.from("ai_fills").upsert(plan.fillRows, { onConflict: "activity_id", ignoreDuplicates: true }));
    }
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadRunDetail(runId: string): Promise<{ run: AiRun } | { error: string }> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  // RLS: only the user's own books' runs.
  const { data, error } = await supabase
    .from("ai_runs")
    .select("id, ran_at, mode, summary, error")
    .eq("id", runId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "run not found" };
  return { run: data as AiRun };
}


/* ---------------- AI Trader: Rules backtest ---------------- */

/** Daily bars for many symbols: chunks of 50 (getDailyBars pages each), a few chunks at a time. */
async function barsFor(creds: Creds, symbols: string[], start: string): Promise<Record<string, Bar[]>> {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 50) chunks.push(symbols.slice(i, i + 50));
  const out: Record<string, Bar[]> = {};
  for (let i = 0; i < chunks.length; i += 4) {
    const pages = await Promise.all(chunks.slice(i, i + 4).map((c) => getDailyBars(creds, c, start)));
    for (const p of pages) Object.assign(out, p);
  }
  return out;
}

/**
 * Backtest a Rules box over daily bars (free — no Claude, nothing placed). Uses
 * the box's saved limits, or `settingsOverride` (unsaved form values, validated
 * like a save) to try them first. Market data comes from the user's own Alpaca
 * paper keys.
 */
export async function runBacktest(
  bookKey: string,
  period: string,
  settingsOverride?: Record<string, unknown>
): Promise<{ result: BacktestResult; period: Period; source: "saved" | "form" } | { error: string }> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  if (!isPeriod(period)) return { error: "unknown period" };
  // RLS: only finds the user's own book.
  const { data: book } = await supabase.from("ai_books").select("id, key, start_cash, settings").eq("key", bookKey).maybeSingle();
  if (!book) return { error: "no such book" };
  if (book.key !== "mylist" && book.key !== "free") return { error: "backtests are for the Rules boxes" };
  const box = book.key as "mylist" | "free";

  let settings: Record<string, unknown>;
  if (settingsOverride) {
    const v = validateLimits(defsForBook(box), settingsOverride);
    if (!v.ok) return { error: v.errors.join(" · ") };
    settings = v.settings;
  } else {
    // Book size: the box's current size (start_cash + size changes), what the tab shows.
    let size = book.start_cash as number;
    try {
      const adj = await loadAdjustments(supabase, [book.id as string]);
      size = sizeOf({ id: book.id as string, key: box, start_cash: book.start_cash as number, settings: book.settings }, adj.list);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    settings = { ...((book.settings as Record<string, unknown> | null) ?? {}), budget: size };
  }
  const R = rulesFor(settings, box);

  try {
    const creds = await loadCreds(createAdminClient(), user.id);
    if (!creds) return { error: "Connect your Alpaca paper account first (card above) — the backtest uses its market data." };

    const { data: wl, error: wlErr } = await supabase.from("watchlist").select("symbol").eq("user_id", user.id);
    if (wlErr) return { error: wlErr.message };
    const list = Array.from(new Set((wl ?? []).map((r) => r.symbol as string)));
    const symbols = box === "mylist" ? list : freeUniverse(list, R.universeAdd, R.universeRemove);
    if (!symbols.length) return { error: box === "mylist" ? "Your list is empty — add tickers first." : "The universe is empty." };

    const clock = await getClock(creds);
    const today = etDate(new Date(clock.timestamp));
    const start = periodStart(today, period);
    const bars = await barsFor(creds, Array.from(new Set([...symbols, "SPY"])), historyStart(start));
    if (clock.is_open) {
      // Today's daily bar is still forming — completed sessions only.
      for (const b of Object.values(bars)) if (b.length && etDate(new Date(b[b.length - 1].t)) === today) b.pop();
    }
    const result = simulateBacktest({ box, rules: R, bars, symbols, start, end: today });
    return { result, period, source: settingsOverride ? "form" : "saved" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
