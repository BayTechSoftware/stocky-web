"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeSignalsForSymbols } from "@/lib/refresh";
import { loadCreds, runAiTrader as runAiTraderEngine } from "@/lib/aitrader/engine";
import { RUNNER_LIMITS, defsForBook, effective, validateLimits } from "@/lib/aitrader/limits";
import type { AiRun } from "@/lib/aitrader/view";
import { planLiveSync, type KnownOrder } from "@/lib/aitrader/live";
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

/** One Twelve Data request stays within the free-tier 8-credits/minute budget. */
const REFRESH_BATCH = 8;

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

  const { data: wl } = await supabase.from("watchlist").select("symbol").eq("user_id", user.id);
  const symbols = Array.from(new Set((wl ?? []).map((r) => r.symbol as string)));
  if (symbols.length === 0) return { updated: 0, refreshed: 0, total: 0 };

  const admin = createAdminClient();
  // Stalest first (by last signal update) so repeated clicks rotate coverage.
  const { data: meta } = await admin
    .from("symbol_signals")
    .select("symbol, updated_at")
    .in("symbol", symbols);
  const last = new Map((meta ?? []).map((m) => [m.symbol as string, (m.updated_at as string) ?? ""]));
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

/**
 * Save one box's limits (validated + clamped against the shared definitions).
 * A Rules box's `budget` is its size, so it also sets ai_books.start_cash (the
 * ledger's starting cash); resetting to defaults resets it to the default budget.
 */
export async function saveBookLimits(bookKey: string, values: Record<string, unknown>): Promise<Result> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  // RLS: only finds the user's own book.
  const { data: book } = await supabase.from("ai_books").select("id, key").eq("key", bookKey).maybeSingle();
  if (!book) return { error: "no such book" };
  const isClaude = String(book.key).startsWith("claude-");
  const defs = defsForBook(String(book.key));
  const v = validateLimits(defs, values);
  if (!v.ok) return { error: v.errors.join(" · ") };
  const patch: { settings: typeof v.settings; start_cash?: number } = { settings: v.settings };
  if (!isClaude) {
    const budget = Number(effective(defs, v.settings).budget);
    if (Number.isFinite(budget) && budget > 0) patch.start_cash = budget;
  }
  const { error } = await createAdminClient().from("ai_books").update(patch).eq("id", book.id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { message: isClaude ? "Saved — the Mac applies them before Claude's next run." : "Saved — used from the next run." };
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
    const { data: known, error } = await admin
      .from("ai_orders")
      .select("id, book_id, alpaca_order_id, leg_ids, status, filled_qty, filled_avg")
      .in("book_id", ids);
    if (error) return { error: error.message };
    const since = books.map((b) => b.created_at as string).sort()[0];
    const [remote, fills] = await Promise.all([listOrders(creds, since), listFills(creds, since)]);
    const plan = planLiveSync(
      (known ?? []) as KnownOrder[],
      remote,
      fills,
      new Map(books.map((b) => [b.key as string, b.id as string]))
    );
    await Promise.all(plan.updates.map((u) => admin.from("ai_orders").update(u.patch).eq("id", u.id)));
    if (plan.inserts.length) {
      await admin.from("ai_orders").upsert(plan.inserts, { onConflict: "alpaca_order_id", ignoreDuplicates: true });
    }
    if (plan.fillRows.length) {
      await admin.from("ai_fills").upsert(plan.fillRows, { onConflict: "activity_id", ignoreDuplicates: true });
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
    // Book size is the box's start_cash (what the Limits form shows when no budget is saved).
    settings = { budget: book.start_cash, ...((book.settings as Record<string, unknown> | null) ?? {}) };
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
