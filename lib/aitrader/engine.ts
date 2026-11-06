/**
 * AI Trader engine — runs the two $5K paper books. SERVER ONLY.
 *
 *   My List     — trades the user's own watchlist, entering on Stocky's BUY /
 *                 WASHOUT signals (score ≥ 60), exiting when the signal turns
 *                 OVERBOUGHT or the bracket stop/target fills.
 *   Free Choice — scans a curated large-cap universe (minus the user's list) for
 *                 the Trader skill's daily setups, with a trend filter; exits on
 *                 the bracket or a 21-day time stop.
 *
 * Every entry is a GTC bracket (limit entry + stop-loss + 2R take-profit), sized
 * to risk 1% of the book. Each run: sync Alpaca → ledger, exits, entries, then an
 * equity snapshot and a run log with every decision and its reason. `dry` mode
 * computes everything but places and cancels nothing.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import * as A from "@/lib/alpaca";
import { bookState } from "./ledger";
import { RULES, bracket, sizeQty } from "./plan";
import { freeUniverse } from "./universe";
import { atr, rankCandidates, scoreCandidate, type Candidate } from "./setups";

type Admin = ReturnType<typeof createAdminClient>;
export type RunMode = "cron" | "manual" | "dry";

interface BookRow {
  id: string;
  user_id: string;
  key: "mylist" | "free";
  name: string;
  start_cash: number;
  created_at: string;
}

interface OrderRow {
  id: string;
  book_id: string;
  symbol: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  qty: number;
  limit_price: number | null;
  leg_ids: string[];
  alpaca_order_id: string | null;
  status: string;
  filled_qty: number;
  filled_avg: number | null;
  created_at: string;
}

export interface Decision {
  symbol: string;
  action: "buy" | "sell" | "skip" | "cancel";
  qty?: number;
  price?: number;
  stop?: number;
  target?: number;
  reason: string;
}

export interface RunSummary {
  book: string;
  mode: RunMode;
  equity: number;
  cash: number;
  available: number;
  halted?: string;
  note?: string;
  error?: string;
  decisions: Decision[];
}

/** Statuses of an order that can still fill. */
const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding"]);

/** YYYY-MM-DD in New York time. */
export function etDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (v: number) => Math.round(v * 100) / 100;

export async function runAiTrader(opts: { admin: Admin; mode: RunMode; userId?: string }): Promise<RunSummary[]> {
  const { admin, mode } = opts;

  let bq = admin.from("ai_books").select("id, user_id, key, name, start_cash, created_at");
  if (opts.userId) bq = bq.eq("user_id", opts.userId);
  const { data: booksData, error: booksErr } = await bq;
  if (booksErr) throw new Error(booksErr.message);
  const books = (booksData ?? []) as BookRow[];
  if (books.length === 0) return [];
  const bookIds = books.map((b) => b.id);

  // Safety first: paper key + paper account, or nothing runs.
  await A.getPaperAccount();
  const clock = await A.getClock();
  const now = new Date(clock.timestamp);
  const today = etDate(now);
  if (mode === "cron" && !(await A.isTradingDay(today))) {
    return books.map((b) => ({
      book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], note: "market holiday — skipped",
    }));
  }
  const since = books.map((b) => b.created_at).sort()[0];

  /* ---- 1. sync Alpaca order status + fills into the ledger ---- */
  const { data: ordersData } = await admin
    .from("ai_orders")
    .select("id, book_id, symbol, side, kind, qty, limit_price, leg_ids, alpaca_order_id, status, filled_qty, filled_avg, created_at")
    .in("book_id", bookIds);
  const ours = (ordersData ?? []) as OrderRow[];
  const bookOfOrder = new Map<string, string>();
  for (const o of ours) {
    if (o.alpaca_order_id) bookOfOrder.set(o.alpaca_order_id, o.book_id);
    for (const l of o.leg_ids ?? []) bookOfOrder.set(l, o.book_id);
  }

  const remote = await A.listOrders(since);
  const remoteById = new Map<string, A.Order>();
  for (const r of remote) {
    remoteById.set(r.id, r);
    for (const l of r.legs ?? []) remoteById.set(l.id, l);
  }
  for (const o of ours) {
    const r = o.alpaca_order_id ? remoteById.get(o.alpaca_order_id) : undefined;
    if (!r) continue;
    const patch: Partial<OrderRow> = {};
    if (r.status !== o.status) patch.status = r.status;
    const fq = Number(r.filled_qty) || 0;
    if (fq !== o.filled_qty) patch.filled_qty = fq;
    const fa = r.filled_avg_price != null ? Number(r.filled_avg_price) : null;
    if (fa !== o.filled_avg) patch.filled_avg = fa;
    const legIds = (r.legs ?? []).map((l) => l.id);
    if (legIds.length && (o.leg_ids?.length ?? 0) === 0) {
      patch.leg_ids = legIds;
      for (const l of legIds) bookOfOrder.set(l, o.book_id);
    }
    if (Object.keys(patch).length) {
      await admin.from("ai_orders").update(patch).eq("id", o.id);
      Object.assign(o, patch);
    }
  }

  const acts = await A.listFills(since);
  const fillRows = acts
    .filter((a) => bookOfOrder.has(a.order_id))
    .map((a) => ({
      activity_id: a.id,
      book_id: bookOfOrder.get(a.order_id)!,
      order_id: a.order_id,
      symbol: a.symbol,
      side: a.side,
      qty: Number(a.qty),
      price: Number(a.price),
      transacted_at: a.transaction_time,
    }));
  if (fillRows.length) {
    await admin.from("ai_fills").upsert(fillRows, { onConflict: "activity_id", ignoreDuplicates: true });
  }
  const { data: fillsData } = await admin
    .from("ai_fills")
    .select("book_id, symbol, side, qty, price, transacted_at")
    .in("book_id", bookIds);
  const allFills = fillsData ?? [];

  /* ---- 2. market data for every symbol we might touch ---- */
  const userIds = Array.from(new Set(books.map((b) => b.user_id)));
  const { data: wl } = await admin.from("watchlist").select("user_id, symbol").in("user_id", userIds);
  const listOf = new Map<string, string[]>();
  for (const r of wl ?? []) {
    const u = r.user_id as string;
    listOf.set(u, [...(listOf.get(u) ?? []), r.symbol as string]);
  }

  const wanted = new Set<string>();
  for (const b of books) {
    const list = listOf.get(b.user_id) ?? [];
    if (b.key === "mylist") list.forEach((s) => wanted.add(s));
    else freeUniverse(list).forEach((s) => wanted.add(s));
  }
  for (const f of allFills) wanted.add(f.symbol as string);
  const symbols = Array.from(wanted);

  const barsBy = await A.getDailyBars(symbols, etDate(new Date(now.getTime() - 420 * 86_400_000)));
  if (clock.is_open) {
    // Today's daily bar is still forming — use completed sessions for signals.
    for (const bars of Object.values(barsBy)) {
      if (bars.length && etDate(new Date(bars[bars.length - 1].t)) === today) bars.pop();
    }
  }
  const live = clock.is_open ? await A.getLatestPrices(symbols) : {};
  const priceOf = (s: string): number | null => {
    if (live[s]) return live[s];
    const bars = barsBy[s];
    return bars?.length ? bars[bars.length - 1].c : null;
  };

  const listSymbols = Array.from(new Set(Array.from(listOf.values()).flat()));
  const { data: sigData } = listSymbols.length
    ? await admin.from("symbol_signals").select("symbol, assessment, tag, score").in("symbol", listSymbols)
    : { data: [] };
  const sigBy = new Map((sigData ?? []).map((s) => [s.symbol as string, s]));

  const { data: eqRows } = await admin
    .from("ai_equity")
    .select("book_id, as_of, equity")
    .in("book_id", bookIds)
    .lt("as_of", today)
    .order("as_of", { ascending: false });
  const prevEquity = new Map<string, number>();
  for (const r of eqRows ?? []) if (!prevEquity.has(r.book_id as string)) prevEquity.set(r.book_id as string, r.equity as number);

  /* ---- 3. run each book ---- */
  const out: RunSummary[] = [];
  for (const b of books) {
    try {
      const s = await runBook(b);
      out.push(s);
      await admin.from("ai_runs").insert({ book_id: b.id, mode, summary: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], error: msg });
      await admin.from("ai_runs").insert({ book_id: b.id, mode, summary: {}, error: msg });
    }
  }
  return out;

  async function runBook(b: BookRow): Promise<RunSummary> {
    const fills = allFills
      .filter((f) => f.book_id === b.id)
      .map((f) => ({
        symbol: f.symbol as string,
        side: f.side as "buy" | "sell",
        qty: f.qty as number,
        price: f.price as number,
        transacted_at: f.transacted_at as string,
      }));
    const st = bookState(b.start_cash, fills);
    const decisions: Decision[] = [];
    const orders = ours.filter((o) => o.book_id === b.id);

    let value = 0;
    for (const p of st.positions.values()) value += p.qty * (priceOf(p.symbol) ?? p.avgCost);
    const equity = st.cash + value;

    // a) cancel entries that never filled
    let pending = orders.filter((o) => o.kind === "entry" && OPEN.has(o.status) && o.filled_qty === 0);
    for (const p of pending) {
      const ageH = (now.getTime() - new Date(p.created_at).getTime()) / 3_600_000;
      if (ageH <= RULES.staleEntryHours || !p.alpaca_order_id) continue;
      if (mode !== "dry") {
        await A.cancelOrder(p.alpaca_order_id).catch(() => undefined);
        await admin.from("ai_orders").update({ status: "canceled" }).eq("id", p.id);
        p.status = "canceled";
      }
      decisions.push({ symbol: p.symbol, action: "cancel", reason: `entry didn't fill in ${Math.round(ageH)}h` });
    }
    pending = pending.filter((p) => p.status !== "canceled");
    const reserved = pending.reduce((a, p) => a + (p.qty - p.filled_qty) * (p.limit_price ?? 0), 0);
    let available = st.cash - reserved;

    // b) daily-loss halt
    const prev = prevEquity.get(b.id);
    const halted =
      prev != null && equity < prev - RULES.dailyLossHaltPct * b.start_cash
        ? `down $${round2(prev - equity)} since last close — no new entries (3% daily-loss halt)`
        : undefined;

    // c) rule-based exits (brackets handle stop/target on their own)
    for (const pos of st.positions.values()) {
      let why: string | undefined;
      if (b.key === "mylist") {
        const sig = sigBy.get(pos.symbol);
        if (sig?.assessment === "OVERBOUGHT") why = `signal turned OVERBOUGHT${sig.tag ? ` · ${sig.tag}` : ""}`;
      } else {
        const days = (now.getTime() - new Date(pos.openedAt).getTime()) / 86_400_000;
        if (days > RULES.freeMaxHoldDays) why = `time stop — held ${Math.round(days)} days`;
      }
      if (!why) continue;
      if (orders.some((o) => o.kind === "exit" && o.symbol === pos.symbol && OPEN.has(o.status))) continue;
      if (mode !== "dry") await exitPosition(b, pos.symbol, pos.qty, why, orders);
      decisions.push({ symbol: pos.symbol, action: "sell", qty: pos.qty, price: priceOf(pos.symbol) ?? undefined, reason: why });
    }

    // d) new entries
    if (!halted) {
      const occupied = new Set([...st.positions.keys(), ...pending.map((p) => p.symbol)]);
      const slots = RULES.maxPositions - st.positions.size - pending.length;
      const wantN = Math.max(0, Math.min(slots, RULES.maxNewPerRun));
      let placed = 0;
      if (wantN === 0) decisions.push({ symbol: "—", action: "skip", reason: `book full (${RULES.maxPositions} positions/orders)` });

      for (const c of wantN > 0 ? candidatesFor(b) : []) {
        if (placed >= wantN) break;
        if (occupied.has(c.symbol)) continue;
        const bars = barsBy[c.symbol];
        const ref = priceOf(c.symbol);
        if (!bars || bars.length < 30 || ref == null) {
          decisions.push({ symbol: c.symbol, action: "skip", reason: "not enough price history" });
          continue;
        }
        if (ref < RULES.minPrice) {
          decisions.push({ symbol: c.symbol, action: "skip", reason: `price under $${RULES.minPrice}` });
          continue;
        }
        const br = bracket(ref, atr(bars));
        const sz = sizeQty({ equity, available, price: br.limit, riskPerShare: br.riskPerShare });
        if (!sz.qty) {
          decisions.push({ symbol: c.symbol, action: "skip", reason: `${c.reason} — ${sz.why}` });
          continue;
        }
        if (mode !== "dry") {
          const clientId = `stk-${b.key}-e-${c.symbol}-${now.getTime()}`;
          const o = await A.submitOrder({
            symbol: c.symbol,
            qty: String(sz.qty),
            side: "buy",
            type: "limit",
            limit_price: br.limit.toFixed(2),
            time_in_force: "gtc",
            order_class: "bracket",
            take_profit: { limit_price: br.target.toFixed(2) },
            stop_loss: { stop_price: br.stop.toFixed(2) },
            client_order_id: clientId,
          });
          await admin.from("ai_orders").insert({
            book_id: b.id,
            symbol: c.symbol,
            side: "buy",
            kind: "entry",
            qty: sz.qty,
            ref_price: ref,
            limit_price: br.limit,
            stop_price: br.stop,
            target_price: br.target,
            reason: c.reason,
            alpaca_order_id: o.id,
            leg_ids: (o.legs ?? []).map((l) => l.id),
            client_order_id: clientId,
            status: o.status,
          });
        }
        available -= sz.qty * br.limit;
        occupied.add(c.symbol);
        placed++;
        decisions.push({
          symbol: c.symbol, action: "buy", qty: sz.qty, price: br.limit, stop: br.stop, target: br.target, reason: c.reason,
        });
      }
      if (wantN > 0 && placed === 0 && !decisions.some((d) => d.action === "skip")) {
        decisions.push({ symbol: "—", action: "skip", reason: "no qualifying setups today" });
      }
    }

    if (mode !== "dry") {
      await admin.from("ai_equity").upsert(
        { book_id: b.id, as_of: today, equity: round2(equity), cash: round2(st.cash) },
        { onConflict: "book_id,as_of" }
      );
    }
    return {
      book: b.name, mode, equity: round2(equity), cash: round2(st.cash), available: round2(available), halted, decisions,
    };
  }

  function candidatesFor(b: BookRow): Candidate[] {
    const list = listOf.get(b.user_id) ?? [];
    if (b.key === "mylist") {
      return list
        .map((sym) => ({ sym, sig: sigBy.get(sym) }))
        .filter(({ sig }) => (sig?.assessment === "BUY" || sig?.assessment === "WASHOUT") && (sig?.score ?? 0) >= 60)
        .sort((x, y) => (y.sig?.score ?? 0) - (x.sig?.score ?? 0))
        .map(({ sym, sig }) => ({
          symbol: sym,
          setups: [],
          score: sig?.score ?? 0,
          ret20: 0,
          rsi: null,
          reason: `Stocky ${sig?.assessment}${sig?.tag ? ` · ${sig.tag}` : ""} · score ${sig?.score}`,
        }));
    }
    const cs: Candidate[] = [];
    for (const sym of freeUniverse(list)) {
      const bars = barsBy[sym];
      if (!bars || bars.length < 60) continue;
      const c = scoreCandidate(sym, bars.map((x) => x.c));
      if (c) cs.push(c);
    }
    return rankCandidates(cs);
  }

  /** Cancel the position's open bracket legs, then sell it at market (queues if closed). */
  async function exitPosition(b: BookRow, symbol: string, qty: number, why: string, orders: OrderRow[]) {
    const legIds = orders
      .filter((o) => o.kind === "entry" && o.symbol === symbol)
      .flatMap((o) => o.leg_ids ?? [])
      .filter((id) => OPEN.has(remoteById.get(id)?.status ?? ""));
    for (const id of legIds) await A.cancelOrder(id).catch(() => undefined);
    for (let i = 0; i < 6 && legIds.length; i++) {
      const states = await Promise.all(legIds.map((id) => A.getOrder(id).then((o) => o.status).catch(() => "canceled")));
      if (states.every((s) => !OPEN.has(s) && s !== "pending_cancel")) break;
      await sleep(500);
    }
    const clientId = `stk-${b.key}-x-${symbol}-${now.getTime()}`;
    const o = await A.submitOrder({
      symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: clientId,
    });
    await admin.from("ai_orders").insert({
      book_id: b.id, symbol, side: "sell", kind: "exit", qty, reason: why,
      alpaca_order_id: o.id, client_order_id: clientId, status: o.status,
    });
  }
}
