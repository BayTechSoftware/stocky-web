/**
 * AI Trader engine — runs the Rules paper books (mylist / free). SERVER ONLY.
 *
 *   My List     — trades the user's own watchlist on Stocky's signals.
 *   Free Choice — scans a curated large-cap universe (minus the user's list) for
 *                 the Trader skill's daily setups.
 *
 * What qualifies, how big, where the stop and target go, how long an entry
 * waits and how long a position is held all come from the book's settings
 * (ai_books.settings, see lib/aitrader/limits.ts), editable in the tab. Every
 * entry carries a stop (a bracket, or stop-only when there's no target).
 *
 * Each user's books trade with that user's own paper keys from Supabase Vault — a
 * user who hasn't connected an Alpaca paper account is simply skipped. Each run:
 * sync Alpaca → ledger, cancel stale entries, re-anchor legs to fills, exits,
 * stop check, entries, then an equity snapshot and a run log with every decision
 * and its reason. A rejected order is logged and the run carries on. `dry` mode
 * computes everything but places, replaces and cancels nothing.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import * as A from "@/lib/alpaca";
import { bookState } from "./ledger";
import {
  anchorToFill,
  bracket,
  entryOrderBody,
  isStaleEntry,
  reservedCash,
  rulesFor,
  sizeQty,
  type Rules,
} from "./plan";
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
  settings: Record<string, unknown> | null;
}

interface OrderRow {
  id: string;
  book_id: string;
  symbol: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  qty: number;
  limit_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  leg_ids: string[];
  alpaca_order_id: string | null;
  status: string;
  filled_qty: number;
  filled_avg: number | null;
  created_at: string;
}

export interface Decision {
  symbol: string;
  action: "buy" | "sell" | "skip" | "cancel" | "hold" | "watch";
  qty?: number;
  price?: number;
  stop?: number;
  target?: number;
  reason: string;
}

/** One thing Claude did during a run (from its stream-json transcript, recorded on the Mac). */
export interface TraceItem {
  at?: number; // seconds since the run started
  t?: number; // (older name for `at`)
  tool?: string;
  ok?: boolean;
  kind: "tool" | "text" | "blocked" | "error" | string;
  label: string;
  detail?: string;
}

/** One structured result from the repo's pipeline (scanner, news, entry, …, broker). */
export interface PipelineStep {
  t?: number;
  stage: string;
  symbol?: string;
  verdict?: string;
  ok?: boolean | null;
  summary: string;
  data?: Record<string, unknown>;
}

export interface RunUsage {
  cost_usd?: number | null;
  turns?: number | null;
  secs?: number | null;
  week_usage_usd?: number | null;
  weekly_cap_usd?: number | null;
}

export interface RunSummary {
  book: string;
  mode: RunMode | "claude" | "claude-dry";
  phase?: string;
  reason?: string;
  usage?: RunUsage;
  trace?: TraceItem[];
  steps?: PipelineStep[];
  limits?: {
    config?: Record<string, number | string>;
    used?: {
      trades_today?: number | null;
      loss_today_usd?: number | null; // realized loss today (positive = loss)
      realized_pnl_today_usd?: number | null;
      loss_at_risk_usd?: number | null; // what the repo's daily-loss check counts: today's entries' loss at their stops
      open_risk_usd?: number | null;
      cash?: number | null;
    };
  };
  guard_blocks?: { at?: string; tool?: string; why?: string }[];
  settings_source?: "web" | "default";
  marks?: Record<string, number>;
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

/** The user's Alpaca paper keys from Vault (service role only), or null if not connected. */
export async function loadCreds(admin: Admin, userId: string): Promise<A.Creds | null> {
  const { data, error } = await admin.rpc("get_alpaca_credentials", { p_user: userId });
  if (error) throw new Error(`vault: ${error.message}`);
  const c = data as { key_id?: string; secret?: string } | null;
  return c?.key_id && c?.secret ? { keyId: c.key_id, secret: c.secret } : null;
}

export async function runAiTrader(opts: { admin: Admin; mode: RunMode; userId?: string }): Promise<RunSummary[]> {
  const { admin, mode } = opts;

  // Only the two rules books — the "claude-*" books are run by Claude on the Mac.
  let bq = admin
    .from("ai_books")
    .select("id, user_id, key, name, start_cash, created_at, settings")
    .in("key", ["mylist", "free"]);
  if (opts.userId) bq = bq.eq("user_id", opts.userId);
  const { data: booksData, error: booksErr } = await bq;
  if (booksErr) throw new Error(booksErr.message);
  const all = (booksData ?? []) as BookRow[];

  // Each user trades with their own paper account.
  const out: RunSummary[] = [];
  for (const userId of Array.from(new Set(all.map((b) => b.user_id)))) {
    const books = all.filter((b) => b.user_id === userId);
    const skip = (note: string) =>
      books.map((b) => ({ book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], note }));
    try {
      const creds = await loadCreds(admin, userId);
      if (!creds) {
        out.push(...skip("Alpaca paper account not connected — skipped"));
        continue;
      }
      out.push(...(await runForUser(admin, mode, books, creds)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push(...skip("").map((s) => ({ ...s, note: undefined, error: msg })));
    }
  }
  return out;
}

async function runForUser(admin: Admin, mode: RunMode, books: BookRow[], creds: A.Creds): Promise<RunSummary[]> {
  const bookIds = books.map((b) => b.id);

  // Safety first: paper key + paper account, or nothing runs.
  await A.getPaperAccount(creds);
  const clock = await A.getClock(creds);
  const now = new Date(clock.timestamp);
  const today = etDate(now);
  if (mode === "cron" && !(await A.isTradingDay(creds, today))) {
    return books.map((b) => ({
      book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], note: "market holiday — skipped",
    }));
  }
  const since = books.map((b) => b.created_at).sort()[0];

  /* ---- 1. sync Alpaca order status + fills into the ledger ---- */
  const { data: ordersData } = await admin
    .from("ai_orders")
    .select("id, book_id, symbol, side, kind, qty, limit_price, stop_price, target_price, leg_ids, alpaca_order_id, status, filled_qty, filled_avg, created_at")
    .in("book_id", bookIds);
  const ours = (ordersData ?? []) as OrderRow[];
  const bookOfOrder = new Map<string, string>();
  for (const o of ours) {
    if (o.alpaca_order_id) bookOfOrder.set(o.alpaca_order_id, o.book_id);
    for (const l of o.leg_ids ?? []) bookOfOrder.set(l, o.book_id);
  }

  const remote = await A.listOrders(creds, since);
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

  const acts = await A.listFills(creds, since);
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

  const rulesOf = new Map(books.map((b) => [b.id, rulesFor(b.settings, b.key)]));
  const universeOf = (b: BookRow) => {
    const R = rulesOf.get(b.id)!;
    return freeUniverse(listOf.get(b.user_id) ?? [], R.universeAdd, R.universeRemove);
  };

  const wanted = new Set<string>();
  for (const b of books) {
    if (b.key === "mylist") (listOf.get(b.user_id) ?? []).forEach((s) => wanted.add(s));
    else universeOf(b).forEach((s) => wanted.add(s));
  }
  for (const f of allFills) wanted.add(f.symbol as string);
  for (const o of ours) wanted.add(o.symbol);
  const symbols = Array.from(wanted);

  const barsBy = await A.getDailyBars(creds, symbols, etDate(new Date(now.getTime() - 420 * 86_400_000)));
  if (clock.is_open) {
    // Today's daily bar is still forming — use completed sessions for signals.
    for (const bars of Object.values(barsBy)) {
      if (bars.length && etDate(new Date(bars[bars.length - 1].t)) === today) bars.pop();
    }
  }
  const live = clock.is_open ? await A.getLatestPrices(creds, symbols) : {};
  const priceOf = (s: string): number | null => {
    if (live[s]) return live[s];
    const bars = barsBy[s];
    return bars?.length ? bars[bars.length - 1].c : null;
  };

  const listSymbols = Array.from(new Set(Array.from(listOf.values()).flat()));
  const { data: sigData } = listSymbols.length
    ? await admin.from("symbol_signals").select("symbol, assessment, tag, score, updated_at").in("symbol", listSymbols)
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
      await admin.from("ai_runs").insert({ book_id: b.id, mode, summary: s, error: s.error ?? null });
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
    const notes: string[] = [];
    const orders = ours.filter((o) => o.book_id === b.id);
    const R = rulesOf.get(b.id)!;
    const dry = mode === "dry";

    let value = 0;
    for (const p of st.positions.values()) value += p.qty * (priceOf(p.symbol) ?? p.avgCost);
    const equity = st.cash + value;
    let available = st.cash;
    let halted: string | undefined;
    let runError: string | undefined;

    /** Run one Alpaca call; a rejection becomes a "skip" decision and the run carries on. */
    async function attempt<T>(symbol: string, fn: () => Promise<T>): Promise<T | undefined> {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        decisions.push({ symbol, action: "skip", reason: `rejected by Alpaca: ${msg}` });
        return undefined;
      }
    }

    try {
      /* a) cancel entries (or the unfilled rest of them) older than the book allows */
      let working = orders.filter((o) => o.kind === "entry" && OPEN.has(o.status));
      const cancelledPartials: OrderRow[] = [];
      for (const p of working) {
        if (!p.alpaca_order_id || !isStaleEntry(p.created_at, now, R)) continue;
        const ageH = Math.round((now.getTime() - new Date(p.created_at).getTime()) / 3_600_000);
        const partial = p.filled_qty > 0;
        if (!dry) {
          const ok = await attempt(p.symbol, () => A.cancelOrder(creds, p.alpaca_order_id!).then(() => true));
          if (!ok) continue;
          await admin.from("ai_orders").update({ status: "canceled" }).eq("id", p.id);
          p.status = "canceled";
          if (partial) cancelledPartials.push(p);
        }
        decisions.push({
          symbol: p.symbol,
          action: "cancel",
          reason: partial
            ? `cancelled the unfilled ${p.qty - p.filled_qty} of ${p.qty} after ${ageH}h — keeping the ${p.filled_qty} filled`
            : `entry didn't fill in ${ageH}h`,
        });
      }
      working = working.filter((p) => p.status !== "canceled");
      available = st.cash - reservedCash(working);

      /* b) re-anchor bracket legs of filled entries to the actual fill price */
      for (const o of orders) {
        if (o.kind !== "entry" || o.status !== "filled" || o.filled_avg == null || !st.positions.has(o.symbol)) continue;
        await reanchor(o, R);
      }

      /* c) daily-loss halt: vs the previous snapshot's equity */
      const prev = prevEquity.get(b.id);
      if (R.dailyLossHaltPct > 0 && prev != null && prev > 0 && equity < prev * (1 - R.dailyLossHaltPct)) {
        halted = `down $${round2(prev - equity)} (${((1 - equity / prev) * 100).toFixed(1)}%) since the last snapshot — no new entries (${+(R.dailyLossHaltPct * 100).toFixed(2)}% daily-loss halt)`;
      }

      /* d) rule-based exits (the attached stop / target handle themselves) */
      const exited = new Set<string>();
      for (const pos of st.positions.values()) {
        let why: string | undefined;
        if (b.key === "mylist" && R.exitOnOverbought) {
          const sig = sigBy.get(pos.symbol);
          if (sig?.assessment === "OVERBOUGHT") why = `signal turned OVERBOUGHT${sig.tag ? ` · ${sig.tag}` : ""}`;
        }
        if (!why && R.maxHoldDays > 0) {
          const days = (now.getTime() - new Date(pos.openedAt).getTime()) / 86_400_000;
          if (days > R.maxHoldDays) why = `time stop — held ${Math.round(days)} days (max ${R.maxHoldDays})`;
        }
        if (!why) continue;
        if (orders.some((o) => o.kind === "exit" && o.stop_price == null && o.symbol === pos.symbol && OPEN.has(o.status))) continue;
        if (!dry) {
          const ok = await attempt(pos.symbol, () => exitPosition(b, pos.symbol, pos.qty, why!, orders).then(() => true));
          if (!ok) continue;
        }
        exited.add(pos.symbol);
        decisions.push({ symbol: pos.symbol, action: "sell", qty: pos.qty, price: priceOf(pos.symbol) ?? undefined, reason: why });
      }

      /* e) every held position keeps a working stop */
      for (const pos of st.positions.values()) {
        if (exited.has(pos.symbol)) continue;
        await ensureStop(b, pos.symbol, pos.qty, pos.avgCost, orders, cancelledPartials, R, decisions, lastFillAt(fills, pos.symbol));
      }

      /* f) new entries */
      if (!halted) {
        const occupied = new Set([...st.positions.keys(), ...working.map((p) => p.symbol)]);
        const slots = R.maxPositions - occupied.size;
        const wantN = Math.max(0, Math.min(slots, R.maxNewPerRun));
        let placed = 0;
        if (wantN === 0) {
          decisions.push({
            symbol: "—",
            action: "skip",
            reason: R.maxNewPerRun === 0 ? "new trades per run set to 0" : `book full (${R.maxPositions} positions/orders)`,
          });
        }

        const { list: cands, stale } = wantN > 0 ? candidatesFor(b, R) : { list: [], stale: [] };
        for (const s of stale) decisions.push({ symbol: s.symbol, action: "skip", reason: `signal is ${s.days} days old` });
        if (stale.length) {
          notes.push(`Not entered on ${stale.length} stale signal${stale.length > 1 ? "s" : ""} (> 3 days old): ${stale.map((s) => s.symbol).join(", ")} — refresh signals to trade them.`);
        }

        for (const c of cands) {
          if (placed >= wantN) break;
          if (occupied.has(c.symbol)) continue;
          const bars = barsBy[c.symbol];
          const ref = priceOf(c.symbol);
          if (!bars || bars.length < 30 || ref == null) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: "not enough price history" });
            continue;
          }
          if (ref < R.minPrice) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: `price under $${R.minPrice}` });
            continue;
          }
          const br = bracket(ref, atr(bars), R);
          const sz = sizeQty({ equity, available, price: br.limit, riskPerShare: br.riskPerShare }, R);
          if (!sz.qty) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: `${c.reason} — ${sz.why}` });
            continue;
          }
          if (!dry) {
            const clientId = `stk-${b.key}-e-${c.symbol}-${now.getTime()}`;
            const o = await attempt(c.symbol, () => A.submitOrder(creds, entryOrderBody(c.symbol, sz.qty, br, clientId)));
            if (!o) continue;
            const { error } = await admin.from("ai_orders").insert({
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
            if (error) notes.push(`${c.symbol}: order ${o.id} placed but not recorded (${error.message}) — check Alpaca.`);
          }
          available -= sz.qty * br.limit;
          occupied.add(c.symbol);
          placed++;
          decisions.push({
            symbol: c.symbol,
            action: "buy",
            qty: sz.qty,
            price: br.limit,
            stop: br.stop,
            target: br.target ?? undefined,
            reason: br.target == null ? `${c.reason} · stop only` : c.reason,
          });
        }
        if (wantN > 0 && placed === 0 && !decisions.some((d) => d.action === "skip")) {
          decisions.push({ symbol: "—", action: "skip", reason: "no qualifying setups today" });
        }
      }
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e);
    }

    if (!dry) {
      await admin.from("ai_equity").upsert(
        { book_id: b.id, as_of: today, equity: round2(equity), cash: round2(st.cash) },
        { onConflict: "book_id,as_of" }
      );
    }
    return {
      book: b.name,
      mode,
      equity: round2(equity),
      cash: round2(st.cash),
      available: round2(available),
      halted,
      note: notes.length ? notes.join(" ") : undefined,
      error: runError,
      decisions,
    };

    /** Move a filled entry's open stop / target legs to where the rules put them from the fill price. */
    async function reanchor(o: OrderRow, R: Rules) {
      const fill = o.filled_avg!;
      const want = anchorToFill(fill, atr(barsAsOf(barsBy[o.symbol] ?? [], o.created_at)), R);
      const parent = o.alpaca_order_id ? remoteById.get(o.alpaca_order_id) : undefined;
      const px = priceOf(o.symbol);
      let legIds = o.leg_ids ?? [];
      for (const id of o.leg_ids ?? []) {
        const leg = remoteById.get(id);
        if (!leg || !OPEN.has(leg.status) || leg.status === "accepted" || leg.status === "pending_new") continue;
        const isStop = leg.type === "stop" || leg.type === "stop_limit";
        const field = isStop ? "stop_price" : "limit_price";
        const cur = Number(leg[field]);
        const stored = isStop ? o.stop_price : o.target_price;
        const next = isStop ? want.stop : want.target;
        // Only legs we computed (still at our recorded price), only a real change.
        if (next == null || !Number.isFinite(cur) || stored == null || Math.abs(cur - stored) >= 0.005) continue;
        if (Math.abs(next - cur) < 0.01) continue;
        const what = isStop ? "stop" : "target";
        const tag = `re-anchored ${what} to the $${fill.toFixed(2)} fill: ${cur.toFixed(2)} → ${next.toFixed(2)}`;
        if (parent?.order_class === "oto") {
          decisions.push({ symbol: o.symbol, action: "hold", reason: `stop-only (OTO) legs can't be replaced at Alpaca — ${what} stays at ${cur.toFixed(2)} (from the fill it would be ${next.toFixed(2)})` });
          continue;
        }
        if (isStop && px != null && next >= px) {
          decisions.push({ symbol: o.symbol, action: "hold", reason: `kept stop at ${cur.toFixed(2)} — from the fill it would be ${next.toFixed(2)}, at/above the price ${px.toFixed(2)}` });
          continue;
        }
        if (!isStop && px != null && next <= px) {
          decisions.push({ symbol: o.symbol, action: "hold", reason: `kept target at ${cur.toFixed(2)} — from the fill it would be ${next.toFixed(2)}, at/below the price ${px.toFixed(2)}` });
          continue;
        }
        if (!dry) {
          const nu = await attempt(o.symbol, () => A.replaceOrder(creds, id, { [field]: next.toFixed(2) }));
          if (!nu) continue;
          legIds = legIds.map((x) => (x === id ? nu.id : x));
          bookOfOrder.set(nu.id, o.book_id);
          remoteById.set(nu.id, nu);
          const patch = { leg_ids: legIds, ...(isStop ? { stop_price: next } : { target_price: next }) };
          await admin.from("ai_orders").update(patch).eq("id", o.id);
          Object.assign(o, patch);
        }
        decisions.push({ symbol: o.symbol, action: "hold", reason: tag });
      }
    }
  }

  /** Is this leg / order a working stop? Unknown ids are looked up (a replaced leg may not be in the list). */
  async function stopIsLive(id: string): Promise<boolean> {
    let r = remoteById.get(id);
    if (!r) {
      try {
        r = await A.getOrder(creds, id);
        remoteById.set(id, r);
      } catch {
        return true; // can't tell — never risk a second stop
      }
    }
    return (r.type === "stop" || r.type === "stop_limit") && LIVE.has(r.status);
  }

  /**
   * A held position must have a working stop (bracket/OTO leg or our own stop
   * order). If its legs went away — e.g. the unfilled rest of an entry was
   * cancelled — place a GTC stop for the shares at the entry's recorded stop.
   */
  async function ensureStop(
    b: BookRow,
    symbol: string,
    qty: number,
    avgCost: number,
    orders: OrderRow[],
    justCancelled: OrderRow[],
    R: Rules,
    decisions: Decision[],
    ledgerAsOf: string
  ) {
    const entries = orders.filter((o) => o.kind === "entry" && o.symbol === symbol);
    // Entries cancelled this run: their legs change state at Alpaca — re-read them.
    for (const o of justCancelled.filter((x) => x.symbol === symbol && x.alpaca_order_id)) {
      for (let i = 0; i < 6; i++) {
        try {
          const fresh = await A.getOrder(creds, o.alpaca_order_id!);
          for (const l of fresh.legs ?? []) remoteById.set(l.id, l);
          if ((fresh.legs ?? []).every((l) => l.status !== "pending_cancel" && l.status !== "pending_replace")) break;
        } catch {
          break;
        }
        await sleep(500);
      }
    }
    // Legs not on record yet (e.g. the submit reply had none): read them from the parent.
    for (const o of entries) {
      if ((o.leg_ids?.length ?? 0) > 0 || !o.alpaca_order_id) continue;
      let parent = remoteById.get(o.alpaca_order_id);
      if (!parent?.legs?.length) {
        try {
          parent = await A.getOrder(creds, o.alpaca_order_id);
        } catch {
          return; // can't tell — never risk a second stop
        }
      }
      const legs = parent?.legs ?? [];
      for (const l of legs) remoteById.set(l.id, l);
      o.leg_ids = legs.map((l) => l.id);
    }
    const ids = [
      ...entries.flatMap((o) => o.leg_ids ?? []),
      ...orders.filter((o) => o.kind === "exit" && o.symbol === symbol && o.stop_price != null && o.alpaca_order_id).map((o) => o.alpaca_order_id!),
    ];
    for (const id of ids) if (await stopIsLive(id)) return;
    // A stop that filled after the ledger was built: the position is already gone — never place a second sell.
    if (ids.some((id) => { const r = remoteById.get(id); return r?.filled_at != null && r.filled_at > ledgerAsOf && Number(r.filled_qty) > 0; })) return;
    // A market exit already queued covers it too.
    if (orders.some((o) => o.kind === "exit" && o.stop_price == null && o.symbol === symbol && OPEN.has(o.status))) return;

    const last = entries.filter((o) => o.stop_price != null).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
    const stop = last?.stop_price ?? anchorToFill(avgCost, atr(barsBy[symbol] ?? []), R).stop;
    const px = priceOf(symbol);
    const crossed = px != null && px <= stop;
    const why = crossed
      ? `no working stop and the price ${px!.toFixed(2)} is at/below the ${stop.toFixed(2)} stop — selling`
      : `no working stop on record — placed a GTC stop at ${stop.toFixed(2)}`;
    if (mode !== "dry") {
      const clientId = `stk-${b.key}-s-${symbol}-${now.getTime()}`;
      const body = crossed
        ? { symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: clientId }
        : { symbol, qty: String(qty), side: "sell", type: "stop", stop_price: stop.toFixed(2), time_in_force: "gtc", client_order_id: clientId };
      const o = await A.submitOrder(creds, body).catch((e: unknown) => {
        decisions.push({ symbol, action: "skip", reason: `rejected by Alpaca: ${e instanceof Error ? e.message : String(e)}` });
        return undefined;
      });
      if (!o) return;
      const row = {
        book_id: b.id, symbol, side: "sell" as const, kind: "exit" as const, qty, reason: why,
        stop_price: crossed ? null : stop, alpaca_order_id: o.id, client_order_id: clientId, status: o.status,
      };
      await admin.from("ai_orders").insert(row);
      remoteById.set(o.id, o);
    }
    decisions.push({ symbol, action: crossed ? "sell" : "hold", qty, stop: crossed ? undefined : stop, reason: why });
  }

  function candidatesFor(b: BookRow, R: Rules): { list: Candidate[]; stale: { symbol: string; days: number }[] } {
    const list = listOf.get(b.user_id) ?? [];
    if (b.key === "mylist") {
      const ok = new Set(["BUY", "WASHOUT", ...(R.enterOnWatch ? ["WATCH"] : [])]);
      const stale: { symbol: string; days: number }[] = [];
      const picks = list
        .map((sym) => ({ sym, sig: sigBy.get(sym) }))
        .filter(({ sig }) => ok.has(String(sig?.assessment)) && (sig?.score ?? 0) >= R.minScore)
        .filter(({ sym, sig }) => {
          const days = signalAgeDays(sig?.updated_at as string | undefined, today);
          if (days != null && days > STALE_SIGNAL_DAYS) {
            stale.push({ symbol: sym, days });
            return false;
          }
          return true;
        })
        .sort((x, y) => (y.sig?.score ?? 0) - (x.sig?.score ?? 0))
        .map(({ sym, sig }) => ({
          symbol: sym,
          setups: [],
          score: sig?.score ?? 0,
          ret20: 0,
          rsi: null,
          reason: `Stocky ${sig?.assessment}${sig?.tag ? ` · ${sig.tag}` : ""} · score ${sig?.score}`,
        }));
      return { list: picks, stale };
    }
    const cs: Candidate[] = [];
    for (const sym of universeOf(b)) {
      const bars = barsBy[sym];
      if (!bars || bars.length < 60) continue;
      const c = scoreCandidate(sym, bars.map((x) => x.c), { maxRsi: R.maxRsi, uptrendOnly: R.uptrendOnly });
      if (c) cs.push(c);
    }
    return { list: rankCandidates(cs), stale: [] };
  }

  /** Cancel the position's open stop/target legs and our own stops, then sell it at market (queues if closed). */
  async function exitPosition(b: BookRow, symbol: string, qty: number, why: string, orders: OrderRow[]) {
    const ids = [
      ...orders.filter((o) => o.kind === "entry" && o.symbol === symbol).flatMap((o) => o.leg_ids ?? []),
      ...orders
        .filter((o) => o.kind === "exit" && o.symbol === symbol && o.stop_price != null && o.alpaca_order_id)
        .map((o) => o.alpaca_order_id!),
    ].filter((id) => LIVE.has(remoteById.get(id)?.status ?? ""));
    for (const id of ids) await A.cancelOrder(creds, id).catch(() => undefined);
    for (let i = 0; i < 6 && ids.length; i++) {
      const states = await Promise.all(ids.map((id) => A.getOrder(creds, id).then((o) => o.status).catch(() => "canceled")));
      if (states.every((s) => !LIVE.has(s) && s !== "pending_cancel")) break;
      await sleep(500);
    }
    const clientId = `stk-${b.key}-x-${symbol}-${now.getTime()}`;
    const o = await A.submitOrder(creds, {
      symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: clientId,
    });
    await admin.from("ai_orders").insert({
      book_id: b.id, symbol, side: "sell", kind: "exit", qty, reason: why,
      alpaca_order_id: o.id, client_order_id: clientId, status: o.status,
    });
  }
}

const LIVE = new Set([...OPEN, "pending_replace"]);

/** Time of the latest fill of `symbol` in the ledger. */
function lastFillAt(fills: { symbol: string; transacted_at: string }[], symbol: string): string {
  return fills.filter((f) => f.symbol === symbol).reduce((m, f) => (f.transacted_at > m ? f.transacted_at : m), "");
}

/** Signals older than this many calendar days aren't entered on (exits still use them). */
export const STALE_SIGNAL_DAYS = 3;

/** Whole calendar days (NY) between a timestamp and `today` (YYYY-MM-DD), or null if unknown. */
export function signalAgeDays(updatedAt: string | null | undefined, today: string): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.parse(today) - Date.parse(etDate(new Date(t)))) / 86_400_000);
}

/** Daily bars whose session had closed when `atIso` happened (bar t = session date at midnight NY; close ≈ +16 h). */
export function barsAsOf(bars: A.Bar[], atIso: string): A.Bar[] {
  const at = Date.parse(atIso);
  return bars.filter((x) => Date.parse(x.t) + 16 * 3_600_000 <= at);
}
