/**
 * Builds the AI Trader tab's view model. SERVER ONLY. Reads the user's books via
 * their RLS-scoped Supabase client. Positions are priced live with the user's own
 * paper keys (Vault) when connected, else from the prices the Mac recorded at the
 * last Claude run.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/admin";
import * as A from "@/lib/alpaca";
import { bookState } from "./ledger";
import { loadCreds, type RunSummary, type RunUsage } from "./engine";

export interface AiPositionView {
  symbol: string;
  qty: number;
  avgCost: number;
  price: number | null; // null = no live price or Mac mark
  value: number; // at the price, or at cost when there's none (so equity still adds up)
  pnl: number | null; // null when there's no price
  pnlPct: number | null;
  stop: number | null;
  target: number | null;
  reason: string | null;
  openedAt: string;
}

export interface AiOrderView {
  symbol: string;
  side: string;
  kind: string;
  qty: number;
  limit: number | null;
  stop: number | null;
  target: number | null;
  status: string;
  reason: string | null;
  created_at: string;
}

export type AiBookKey = "mylist" | "free" | "claude-mylist" | "claude-free";

export interface AiBookView {
  key: AiBookKey;
  name: string;
  startCash: number;
  cash: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realized: number;
  closedTrades: number;
  wins: number;
  losses: number;
  flats: number;
  positions: AiPositionView[];
  pending: AiOrderView[];
  lastRun: AiRun | null;
  /** Today's runs (NY day), newest first, without the heavy trace — open one to load it. */
  today: AiRunLite[];
  /** This box's saved limits (validated on save; defaults apply where missing). */
  settings: Record<string, number | string>;
  weekCostUsd: number;
  series: { as_of: string; equity: number }[];
}

export interface AiRun {
  id: string;
  ran_at: string;
  mode: string;
  summary: RunSummary | null;
  error: string | null;
}

export interface AiRunLite {
  id: string;
  ran_at: string;
  mode: string;
  phase: string | null;
  reason: string | null;
  note: string | null;
  usage: RunUsage | null;
  buys: number;
  sells: number;
  error: string | null;
}

export interface AiView {
  books: AiBookView[];
  accountEquity: number | null;
  marketOpen: boolean | null;
  /** Where position prices came from. */
  prices: "live" | "mac";
  connection: { hint: string | null; connected_at: string } | null;
  runner: Record<string, number | string>;
  error: string | null;
}

type Admin = ReturnType<typeof createAdminClient>;

/** ISO timestamp of midnight, New York time, on the NY date `daysBack` days ago. */
function nyMidnight(daysBack = 0): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  const off =
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")
      ?.value.replace("GMT", "") || "-05:00";
  return `${date}T00:00:00${off}`;
}

/** Days since Monday in New York (Mon = 0). */
function nyWeekday(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
}

const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding"]);

export async function loadAiView(
  supabase: SupabaseClient,
  opts?: { admin: Admin; userId: string }
): Promise<AiView | null> {
  const { data: books } = await supabase
    .from("ai_books")
    .select("id, key, name, start_cash, settings")
    .order("key", { ascending: true });
  if (!books?.length) return null;
  const ids = books.map((b) => b.id as string);
  const claudeIds = books.filter((b) => String(b.key).startsWith("claude-")).map((b) => b.id as string);

  const [fillsR, ordersR, eqR, todayR, weekR, connR, runnerR, ...latestR] = await Promise.all([
    supabase.from("ai_fills").select("book_id, symbol, side, qty, price, transacted_at").in("book_id", ids),
    supabase
      .from("ai_orders")
      .select("book_id, symbol, side, kind, qty, limit_price, stop_price, target_price, status, reason, filled_qty, created_at")
      .in("book_id", ids)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("ai_equity").select("book_id, as_of, equity").in("book_id", ids).order("as_of", { ascending: true }),
    // Today's Claude runs, light fields only (the trace can be tens of KB per run).
    claudeIds.length
      ? supabase
          .from("ai_runs")
          .select(
            "id, book_id, ran_at, mode, error, phase:summary->>phase, reason:summary->>reason, note:summary->>note, usage:summary->usage, decisions:summary->decisions"
          )
          .in("book_id", claudeIds)
          .gte("ran_at", nyMidnight())
          .order("ran_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    claudeIds.length
      ? supabase
          .from("ai_runs")
          .select("book_id, mode, cost:summary->usage->cost_usd")
          .in("book_id", claudeIds)
          .gte("ran_at", nyMidnight(nyWeekday()))
          .limit(2000)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    supabase.from("broker_connections").select("account_hint, connected_at").maybeSingle(),
    supabase.from("ai_runner").select("settings").maybeSingle(),
    // Each box's latest run in full.
    ...ids.map((id) =>
      supabase
        .from("ai_runs")
        .select("id, book_id, ran_at, mode, summary, error")
        .eq("book_id", id)
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ),
  ]);

  // Live prices + account with the user's own paper keys (best-effort: the tab
  // still renders from the ledger and the Mac's recorded prices without them).
  let error: string | null = null;
  let accountEquity: number | null = null;
  let marketOpen: boolean | null = null;
  const px = new Map<string, number>();
  if (opts && connR.data) {
    try {
      const creds = await loadCreds(opts.admin, opts.userId);
      if (creds) {
        const [acct, clock, positions] = await Promise.all([
          A.getPaperAccount(creds),
          A.getClock(creds),
          A.getPositions(creds),
        ]);
        accountEquity = Number(acct.equity);
        marketOpen = clock.is_open;
        for (const p of positions) px.set(p.symbol, Number(p.current_price));
      }
    } catch (e) {
      error = `Live prices unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const fills = fillsR.data ?? [];
  const orders = ordersR.data ?? [];
  const eq = eqR.data ?? [];
  const latest = new Map<string, AiRun>();
  for (const r of latestR) {
    const row = r.data as (AiRun & { book_id: string }) | null;
    if (row) latest.set(row.book_id, row);
  }

  // Latest prices the Mac recorded for each book ("marks" in the run summary).
  const marksOf = new Map<string, Record<string, number>>();
  for (const [bookId, r] of latest) if (r.summary?.marks) marksOf.set(bookId, r.summary.marks);

  const weekCost = new Map<string, number>();
  for (const r of (weekR.data ?? []) as { book_id: string; mode: string; cost: number | null }[]) {
    weekCost.set(r.book_id, (weekCost.get(r.book_id) ?? 0) + (Number(r.cost) || 0));
  }

  const views: AiBookView[] = books.map((b) => {
    const st = bookState(
      b.start_cash as number,
      fills
        .filter((f) => f.book_id === b.id)
        .map((f) => ({
          symbol: f.symbol as string,
          side: f.side as "buy" | "sell",
          qty: f.qty as number,
          price: f.price as number,
          transacted_at: f.transacted_at as string,
        }))
    );
    const bookOrders = orders.filter((o) => o.book_id === b.id);

    const positions: AiPositionView[] = Array.from(st.positions.values()).map((p) => {
      const price = px.get(p.symbol) ?? marksOf.get(b.id as string)?.[p.symbol] ?? null;
      const mark = price ?? p.avgCost; // for the book's equity only
      const entry = bookOrders.find((o) => o.kind === "entry" && o.symbol === p.symbol && (o.filled_qty as number) > 0);
      // A stand-alone protective stop (placed when an entry's legs went away) wins over the entry's recorded stop.
      const guard = bookOrders.find(
        (o) => o.kind === "exit" && o.symbol === p.symbol && o.stop_price != null && OPEN.has(o.status as string)
      );
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgCost: p.avgCost,
        price,
        value: p.qty * mark,
        pnl: price != null ? p.qty * (price - p.avgCost) : null,
        pnlPct: price != null && p.avgCost > 0 ? (price / p.avgCost - 1) * 100 : null,
        stop: ((guard?.stop_price ?? entry?.stop_price) as number | null) ?? null,
        target: (entry?.target_price as number | null) ?? null,
        reason: (entry?.reason as string | null) ?? null,
        openedAt: p.openedAt,
      };
    });
    const value = positions.reduce((a, p) => a + p.value, 0);
    const equity = st.cash + value;
    const start = b.start_cash as number;

    const pending: AiOrderView[] = bookOrders
      .filter((o) => OPEN.has(o.status as string) && (o.kind === "exit" || (o.filled_qty as number) < (o.qty as number)))
      .map((o) => ({
        symbol: o.symbol as string,
        side: o.side as string,
        kind: o.kind as string,
        qty: o.kind === "entry" ? (o.qty as number) - ((o.filled_qty as number) || 0) : (o.qty as number),
        limit: (o.limit_price as number | null) ?? null,
        stop: (o.stop_price as number | null) ?? null,
        target: (o.target_price as number | null) ?? null,
        status: o.status as string,
        reason: (o.reason as string | null) ?? null,
        created_at: o.created_at as string,
      }));

    const run = latest.get(b.id as string) ?? null;
    const today: AiRunLite[] = ((todayR.data ?? []) as Record<string, unknown>[])
      .filter((r) => r.book_id === b.id)
      .map((r) => {
        const ds = (Array.isArray(r.decisions) ? r.decisions : []) as { action?: string }[];
        return {
          id: r.id as string,
          ran_at: r.ran_at as string,
          mode: r.mode as string,
          phase: (r.phase as string | null) ?? null,
          reason: (r.reason as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          usage: (r.usage as RunUsage | null) ?? null,
          buys: ds.filter((d) => d.action === "buy").length,
          sells: ds.filter((d) => d.action === "sell").length,
          error: (r.error as string | null) ?? null,
        };
      });
    return {
      key: b.key as AiBookKey,
      name: b.name as string,
      startCash: start,
      cash: st.cash,
      equity,
      pnl: equity - start,
      pnlPct: (equity / start - 1) * 100,
      realized: st.realized,
      closedTrades: st.closedTrades,
      wins: st.wins,
      losses: st.losses,
      flats: st.flats,
      positions,
      pending,
      lastRun: run,
      today,
      settings: (b.settings as Record<string, number | string> | null) ?? {},
      weekCostUsd: weekCost.get(b.id as string) ?? 0,
      series: eq.filter((e) => e.book_id === b.id).map((e) => ({ as_of: e.as_of as string, equity: e.equity as number })),
    };
  });

  // Side by side: each rules book next to its Claude twin.
  const ORDER: AiBookKey[] = ["mylist", "claude-mylist", "free", "claude-free"];
  views.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  const conn = connR.data as { account_hint: string | null; connected_at: string } | null;
  return {
    books: views,
    accountEquity,
    marketOpen,
    prices: px.size ? "live" : "mac",
    connection: conn ? { hint: conn.account_hint, connected_at: conn.connected_at } : null,
    runner: ((runnerR.data as { settings?: Record<string, number | string> } | null)?.settings) ?? {},
    error,
  };
}
