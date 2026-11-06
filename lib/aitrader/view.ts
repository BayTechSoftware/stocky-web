/**
 * Builds the AI Trader tab's view model. SERVER ONLY. Reads the user's books via
 * their RLS-scoped Supabase client, then prices positions live from Alpaca (paper).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import * as A from "@/lib/alpaca";
import { bookState } from "./ledger";
import type { RunSummary } from "./engine";

export interface AiPositionView {
  symbol: string;
  qty: number;
  avgCost: number;
  price: number | null;
  value: number;
  pnl: number;
  pnlPct: number;
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

export interface AiBookView {
  key: "mylist" | "free";
  name: string;
  startCash: number;
  cash: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realized: number;
  closedTrades: number;
  wins: number;
  positions: AiPositionView[];
  pending: AiOrderView[];
  lastRun: { ran_at: string; mode: string; summary: RunSummary | null; error: string | null } | null;
  series: { as_of: string; equity: number }[];
}

export interface AiView {
  books: AiBookView[];
  accountEquity: number | null;
  marketOpen: boolean | null;
  error: string | null;
}

const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding"]);

export async function loadAiView(supabase: SupabaseClient): Promise<AiView | null> {
  const { data: books } = await supabase
    .from("ai_books")
    .select("id, key, name, start_cash")
    .order("key", { ascending: true });
  if (!books?.length) return null;
  const ids = books.map((b) => b.id as string);

  const [fillsR, ordersR, runsR, eqR] = await Promise.all([
    supabase.from("ai_fills").select("book_id, symbol, side, qty, price, transacted_at").in("book_id", ids),
    supabase
      .from("ai_orders")
      .select("book_id, symbol, side, kind, qty, limit_price, stop_price, target_price, status, reason, filled_qty, created_at")
      .in("book_id", ids)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("ai_runs")
      .select("book_id, ran_at, mode, summary, error")
      .in("book_id", ids)
      .order("ran_at", { ascending: false })
      .limit(20),
    supabase.from("ai_equity").select("book_id, as_of, equity").in("book_id", ids).order("as_of", { ascending: true }),
  ]);

  // Live prices + account (best-effort: the tab still renders from the ledger without them).
  let error: string | null = null;
  let accountEquity: number | null = null;
  let marketOpen: boolean | null = null;
  const px = new Map<string, number>();
  if (!A.alpacaConfigured()) {
    error = "Alpaca paper keys aren't set on this deployment (ALPACA_KEY_ID / ALPACA_SECRET_KEY).";
  } else {
    try {
      const [acct, clock, positions] = await Promise.all([A.getPaperAccount(), A.getClock(), A.getPositions()]);
      accountEquity = Number(acct.equity);
      marketOpen = clock.is_open;
      for (const p of positions) px.set(p.symbol, Number(p.current_price));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const fills = fillsR.data ?? [];
  const orders = ordersR.data ?? [];
  const runs = runsR.data ?? [];
  const eq = eqR.data ?? [];

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
      const price = px.get(p.symbol) ?? null;
      const mark = price ?? p.avgCost;
      const entry = bookOrders.find((o) => o.kind === "entry" && o.symbol === p.symbol && (o.filled_qty as number) > 0);
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgCost: p.avgCost,
        price,
        value: p.qty * mark,
        pnl: p.qty * (mark - p.avgCost),
        pnlPct: p.avgCost > 0 ? (mark / p.avgCost - 1) * 100 : 0,
        stop: (entry?.stop_price as number | null) ?? null,
        target: (entry?.target_price as number | null) ?? null,
        reason: (entry?.reason as string | null) ?? null,
        openedAt: p.openedAt,
      };
    });
    const value = positions.reduce((a, p) => a + p.value, 0);
    const equity = st.cash + value;
    const start = b.start_cash as number;

    const pending: AiOrderView[] = bookOrders
      .filter((o) => OPEN.has(o.status as string) && (o.kind === "exit" || (o.filled_qty as number) === 0))
      .map((o) => ({
        symbol: o.symbol as string,
        side: o.side as string,
        kind: o.kind as string,
        qty: o.qty as number,
        limit: (o.limit_price as number | null) ?? null,
        stop: (o.stop_price as number | null) ?? null,
        target: (o.target_price as number | null) ?? null,
        status: o.status as string,
        reason: (o.reason as string | null) ?? null,
        created_at: o.created_at as string,
      }));

    const run = runs.find((r) => r.book_id === b.id);
    return {
      key: b.key as "mylist" | "free",
      name: b.name as string,
      startCash: start,
      cash: st.cash,
      equity,
      pnl: equity - start,
      pnlPct: (equity / start - 1) * 100,
      realized: st.realized,
      closedTrades: st.closedTrades,
      wins: st.wins,
      positions,
      pending,
      lastRun: run
        ? {
            ran_at: run.ran_at as string,
            mode: run.mode as string,
            summary: (run.summary as RunSummary) ?? null,
            error: (run.error as string | null) ?? null,
          }
        : null,
      series: eq.filter((e) => e.book_id === b.id).map((e) => ({ as_of: e.as_of as string, equity: e.equity as number })),
    };
  });

  // My List first, then Free Choice.
  views.sort((a, b) => (a.key === "mylist" ? -1 : 1) - (b.key === "mylist" ? -1 : 1));
  return { books: views, accountEquity, marketOpen, error };
}
