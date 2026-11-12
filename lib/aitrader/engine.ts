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
import { bookState, ledgerFills, shortOrderIds } from "./ledger";
import { loadFills, loadOrders, must } from "./rows";
import { ownerOf } from "./live";
import { adjustedSince, baselineOf, loadAdjustments } from "./cash";
import { anchorToFill, entryOrderBody, isStaleEntry, nyIso, reservedCash, rulesFor, weekdaySessions, type Rules, type Session } from "./plan";
import { freeUniverse } from "./universe";
import { CLOSE_OUT_REASON, matchConfirmed, planCloseOut, type CloseOutItem, type ConfirmedItem } from "./closeout";
import { atr, type Candidate } from "./setups";
import {
  HISTORY_DAYS,
  barsAsOf,
  entrySlots,
  etDate,
  exitReason,
  freeCandidates,
  gapDownReason,
  haltReason,
  keepLegReason,
  middaySkip,
  offSkip,
  mylistCandidates,
  planEntry,
  reentrySkip,
  shortBlockedSymbols,
  shortConflict,
  shortLookupSkip,
  type ShortCheck,
  type StaleSignal,
} from "./decide";

// Kept exported from here for existing importers; the pure logic lives in ./decide.
export { etDate, barsAsOf, signalAgeDays } from "./decide";

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
  client_order_id?: string | null;
  created_at: string;
}

export interface Decision {
  symbol: string;
  action: "buy" | "sell" | "short" | "cover" | "skip" | "cancel" | "hold" | "watch";
  qty?: number;
  price?: number;
  stop?: number;
  target?: number;
  reason: string;
  trigger?: string; // Claude: what would make it act on a stock it's watching
  /** Claude books: the scorecard (stocky-trader bin/rate.py) for this stock and direction, when it was rated. */
  score?: number | null;
  scorecard?: DecisionScorecard;
  /** Claude books: the bear check — a separate Claude call's case against the trade (read with bearOf()). */
  bear?: DecisionBear;
}

/** The case against a trade (stocky-trader bear check). confidence is 0–100. */
export interface DecisionBear {
  verdict: "against" | "mixed" | "weak" | "unavailable";
  confidence?: number | null;
  case?: string;
}

/** One gate of a scorecard: s = pass / fail / na, m = the owner's mode, v = the numbers. */
export interface ScorecardGateRow {
  k: string;
  s?: "pass" | "fail" | "na" | string;
  m?: "off" | "warn" | "block" | string;
  v?: string;
}

/** The compact scorecard a decision carries (docs/SETTINGS_CONTRACT.md "Scorecard"). Older decisions have none. */
export interface DecisionScorecard {
  v?: number;
  dir?: "long" | "short" | string;
  at?: string;
  score?: number | null;
  gates?: ScorecardGateRow[];
  parts?: { k: string; w?: number; s?: number | null }[];
  blocked?: string[];
  failed?: string[];
  warned?: string[];
  support?: string[];
  why?: string;
  /** Points taken off the score, e.g. { extension: 15 } for a chase. */
  penalty?: Record<string, number>;
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

/** A simulated fill in a Claude replay (against 1-min bars, on the Mac). */
export interface ReplaySimTrade {
  at?: string; // HH:MM NY
  symbol: string;
  side: string;
  qty: number;
  price: number;
  why?: string;
}

/** `summary.replay` on a "claude-replay" run (SETTINGS_CONTRACT.md → Replay runs). */
export interface ReplayInfo {
  id: string; // "<book>-<YYYY-MM-DD>-<n>"
  date: string;
  at?: string; // pinned NY time of this step, HH:MM
  final?: boolean;
  step?: number;
  steps?: number;
  sim_trades?: ReplaySimTrade[]; // cumulative for the day
  sim_positions?: { symbol: string; qty: number; avg: number | null; mark: number | null }[];
  sim_cash?: number;
  sim_equity?: number;
  sim_pnl?: number;
  start_cash?: number;
  cost_usd_total?: number;
}

export interface RunSummary {
  book: string;
  mode: RunMode | "claude" | "claude-dry" | "claude-replay";
  replay?: ReplayInfo;
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
      // One run per user at a time (supabase/ai_run_lock.sql); a dry run places nothing, so it never waits.
      const lock = mode === "dry" ? { ok: true as const, note: null } : await takeRunLock(admin, userId);
      if (!lock.ok) {
        out.push(...skip("another run for this account is in progress — skipped"));
        continue;
      }
      try {
        const res = await runForUser(admin, mode, books, creds);
        if (lock.note) for (const r of res) r.note = [r.note, lock.note].filter(Boolean).join(" ");
        out.push(...res);
      } finally {
        if (lock.runId) await releaseRunLock(admin, userId, lock.runId);
      }
    } catch (e) {
      // A failure before the per-book loop (keys, clock, ledger reads): leave a trace on every book.
      const msg = e instanceof Error ? e.message : String(e);
      out.push(...skip("").map((s) => ({ ...s, note: undefined, error: msg })));
      for (const b of books) await logRun(admin, b.id, mode, { book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], error: msg }, msg);
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
  /* ---- 1. sync Alpaca order status + fills into the ledger ---- */
  const { ours, bookOfOrder, remote, remoteById, recoveryNotes, allFills, shortEntries } = await syncLedger(admin, books, creds);

  // Claude books short on this same account; Rules books must never buy into that.
  let shorts: ShortCheck;
  try {
    shorts = { ok: true, symbols: shortBlockedSymbols(await A.getPositions(creds), remote) };
  } catch (e) {
    shorts = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  /* ---- 2. market data for every symbol we might touch ---- */
  const userIds = Array.from(new Set(books.map((b) => b.user_id)));
  const { data: wl, error: wlErr } = await admin.from("watchlist").select("user_id, symbol").in("user_id", userIds);
  if (wlErr) throw new Error(`watchlist: ${wlErr.message}`);
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

  const barsBy = await A.getDailyBars(creds, symbols, etDate(new Date(now.getTime() - HISTORY_DAYS * 86_400_000)));
  /** Today's forming bar during the session (its open is known): for max_gap_down_pct. */
  const todayOpen = new Map<string, number>();
  if (clock.is_open) {
    // Today's daily bar is still forming — use completed sessions for signals.
    for (const [sym, bars] of Object.entries(barsBy)) {
      if (bars.length && etDate(new Date(bars[bars.length - 1].t)) === today) todayOpen.set(sym, bars.pop()!.o);
    }
  }
  const live = clock.is_open ? await A.getLatestPrices(creds, symbols) : {};
  const priceOf = (s: string): number | null => {
    if (live[s]) return live[s];
    const bars = barsBy[s];
    return bars?.length ? bars[bars.length - 1].c : null;
  };

  const listSymbols = Array.from(new Set(Array.from(listOf.values()).flat()));
  const { data: sigData, error: sigErr } = listSymbols.length
    ? await admin.from("symbol_signals").select("symbol, assessment, tag, score, updated_at").in("symbol", listSymbols)
    : { data: [], error: null };
  if (sigErr) throw new Error(`symbol_signals: ${sigErr.message}`);
  const sigBy = new Map((sigData ?? []).map((s) => [s.symbol as string, s]));

  // The previous snapshot per book (the daily-loss halt's baseline): one row each.
  const prevEquity = new Map<string, number>();
  const prevAsOf = new Map<string, string>();
  // Box size changes (supabase/ai_cash_adjustments.sql): part of the baseline, never a loss.
  const { list: adjustments } = await loadAdjustments(admin, bookIds);
  for (const id of bookIds) {
    const { data: r, error: eqErr } = await admin
      .from("ai_equity")
      .select("book_id, as_of, equity")
      .eq("book_id", id)
      .lt("as_of", today)
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eqErr) throw new Error(`ai_equity: ${eqErr.message}`);
    if (r) {
      prevEquity.set(id, r.equity as number);
      prevAsOf.set(id, r.as_of as string);
    }
  }

  // Trading sessions since the oldest working entry (entry age counts sessions, not hours).
  const oldestWorking = ours.filter((o) => o.kind === "entry" && OPEN.has(o.status)).map((o) => o.created_at).sort()[0];
  let sessions: Session[] | undefined;
  let calendarNote: string | undefined;
  if (oldestWorking) {
    const from = etDate(new Date(oldestWorking));
    try {
      sessions = (await A.getCalendar(creds, from, today)).map((d) => ({ date: d.date, open: nyIso(d.date, d.open), close: nyIso(d.date, d.close) }));
    } catch (e) {
      sessions = weekdaySessions(from, today);
      calendarNote = `market calendar unavailable (${e instanceof Error ? e.message : String(e)}) — entry age counted in weekdays.`;
    }
  }

  /* ---- 3. run each book ---- */
  const out: RunSummary[] = [];
  for (const b of books) {
    try {
      const s = await runBook(b);
      out.push(s);
      await logRun(admin, b.id, mode, s, s.error ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ book: b.name, mode, equity: 0, cash: 0, available: 0, decisions: [], error: msg });
      await logRun(admin, b.id, mode, {}, msg);
    }
  }
  return out;

  async function runBook(b: BookRow): Promise<RunSummary> {
    const fills = ledgerFills(allFills.filter((f) => f.book_id === b.id), shortEntries);
    const st = bookState(baselineOf(b.start_cash, adjustments, b.id), fills);
    const decisions: Decision[] = [];
    const notes: string[] = [recoveryNotes.get(b.id), calendarNote].filter((n): n is string => !!n);
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
        decisions.push({
          symbol,
          action: "skip",
          reason: isDuplicateClientId(msg) ? `already placed today (another run) — Alpaca rejected the duplicate: ${msg}` : `rejected by Alpaca: ${msg}`,
        });
        return undefined;
      }
    }

    try {
      /* a) cancel entries (or the unfilled rest of them) older than the book allows */
      let working = orders.filter((o) => o.kind === "entry" && OPEN.has(o.status));
      const cancelledPartials: OrderRow[] = [];
      for (const p of working) {
        // During the session: a resting entry in a stock that gapped down too far is cancelled (max_gap_down_pct).
        const bars = barsBy[p.symbol];
        const gapped = clock.is_open ? gapDownReason(todayOpen.get(p.symbol), bars?.[bars.length - 1]?.c, R) : undefined;
        if (gapped && p.alpaca_order_id && !p.filled_qty) {
          if (!dry) {
            const ok = await attempt(p.symbol, () => A.cancelOrder(creds, p.alpaca_order_id!).then(() => true));
            if (!ok) continue;
            const { error: gErr } = await admin.from("ai_orders").update({ status: "canceled" }).eq("id", p.id);
            if (gErr) notes.push(`${p.symbol}: cancelled at Alpaca but not recorded (${gErr.message}) — the next sync fixes it.`);
            p.status = "canceled";
          }
          decisions.push({ symbol: p.symbol, action: "cancel", reason: `resting entry cancelled: ${gapped}` });
          continue;
        }
        if (!p.alpaca_order_id || !isStaleEntry(p.created_at, now, R, sessions)) continue;
        const ageH = Math.round((now.getTime() - new Date(p.created_at).getTime()) / 3_600_000);
        const sess = `${R.entryValidDays} trading session${R.entryValidDays === 1 ? "" : "s"}`;
        const partial = p.filled_qty > 0;
        if (!dry) {
          const ok = await attempt(p.symbol, () => A.cancelOrder(creds, p.alpaca_order_id!).then(() => true));
          if (!ok) continue;
          const { error: cErr } = await admin.from("ai_orders").update({ status: "canceled" }).eq("id", p.id);
          if (cErr) notes.push(`${p.symbol}: cancelled at Alpaca but not recorded (${cErr.message}) — the next sync fixes it.`);
          p.status = "canceled";
          if (partial) cancelledPartials.push(p);
        }
        decisions.push({
          symbol: p.symbol,
          action: "cancel",
          reason: partial
            ? `cancelled the unfilled ${p.qty - p.filled_qty} of ${p.qty} after ${sess} (${ageH}h) — keeping the ${p.filled_qty} filled`
            : `entry didn't fill in ${sess} (${ageH}h)`,
        });
      }
      working = working.filter((p) => p.status !== "canceled");
      available = st.cash - reservedCash(working);

      /* b) re-anchor bracket legs of filled entries to the actual fill price */
      for (const o of orders) {
        if (o.kind !== "entry" || o.status !== "filled" || o.filled_avg == null || !st.positions.has(o.symbol)) continue;
        await reanchor(o, R);
      }

      /* c) daily-loss halt: vs the previous snapshot's equity, plus any size change since (not a loss) */
      const prev = prevEquity.get(b.id);
      halted = haltReason(equity, prev == null ? prev : prev + adjustedSince(adjustments, b.id, prevAsOf.get(b.id)!), R);

      /* d) rule-based exits (the attached stop / target handle themselves) */
      const exited = new Set<string>();
      for (const pos of st.positions.values()) {
        const why = exitReason({ mylist: b.key === "mylist", R, sig: sigBy.get(pos.symbol), openedAt: pos.openedAt, now });
        if (!why) continue;
        if (orders.some((o) => o.kind === "exit" && o.stop_price == null && o.symbol === pos.symbol && OPEN.has(o.status))) continue;
        if (!dry) {
          const res = await attempt(pos.symbol, () => exitPosition(b, pos.symbol, pos.qty, why!, orders).then((n) => ({ n })));
          if (!res) continue;
          if (res.n) notes.push(res.n);
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
      const lookupSkip = shortLookupSkip(shorts);
      const midday = middaySkip(R, clock.is_open);
      const off = offSkip(R);
      if (off) {
        decisions.push({ symbol: "—", action: "skip", reason: off });
        notes.push(off);
      } else if (!halted && midday) {
        decisions.push({ symbol: "—", action: "skip", reason: midday });
      } else if (!halted && lookupSkip) {
        decisions.push({ symbol: "—", action: "skip", reason: lookupSkip });
        notes.push(lookupSkip);
      } else if (!halted) {
        const occupied = new Set([...st.positions.keys(), ...working.map((p) => p.symbol)]);
        const { wantN, skip: noSlots } = entrySlots(R, occupied.size);
        let placed = 0;
        if (noSlots) decisions.push({ symbol: "—", action: "skip", reason: noSlots });

        const { list: cands, stale } = wantN > 0 ? candidatesFor(b, R) : { list: [], stale: [] };
        for (const s of stale) {
          decisions.push({ symbol: s.symbol, action: "skip", reason: s.days == null ? "signal has no update time" : `signal is ${s.days} days old` });
        }
        if (stale.length) {
          notes.push(`Not entered on ${stale.length} stale signal${stale.length > 1 ? "s" : ""} (> ${R.maxSignalAgeDays} day${R.maxSignalAgeDays === 1 ? "" : "s"} old): ${stale.map((s) => s.symbol).join(", ")} — refresh signals to trade them.`);
        }

        for (const c of cands) {
          if (placed >= wantN) break;
          if (occupied.has(c.symbol)) continue;
          const cooling = reentrySkip(c.symbol, st.closed, today, R);
          if (cooling) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: cooling });
            continue;
          }
          const conflict = shortConflict(c.symbol, shorts);
          if (conflict) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: conflict });
            continue;
          }
          const ref = priceOf(c.symbol);
          const cBars = barsBy[c.symbol];
          const gapToday = clock.is_open ? gapDownReason(todayOpen.get(c.symbol), cBars?.[cBars.length - 1]?.c, R) : undefined;
          if (gapToday) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: `${c.reason} — ${gapToday}` });
            continue;
          }
          const plan = planEntry(c, cBars, ref, R, equity, available);
          if (!plan.ok) {
            decisions.push({ symbol: c.symbol, action: "skip", reason: plan.reason });
            continue;
          }
          const { br, qty } = plan;
          if (!dry) {
            const clientId = clientOrderId(b.key, "e", c.symbol, today);
            const o = await attempt(c.symbol, () => A.submitOrder(creds, entryOrderBody(c.symbol, qty, br, clientId)));
            if (!o) continue;
            const error = await recordOrder(admin, {
              book_id: b.id,
              symbol: c.symbol,
              side: "buy",
              kind: "entry",
              qty,
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
            if (error) notes.push(`${c.symbol}: order ${o.id} placed but not recorded (${error}) — the next run records it from Alpaca.`);
          }
          available -= qty * br.limit;
          occupied.add(c.symbol);
          placed++;
          decisions.push({
            symbol: c.symbol,
            action: "buy",
            qty,
            price: br.limit,
            stop: br.stop,
            target: br.target ?? undefined,
            reason: plan.reason,
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
      const { error: eqErr } = await admin.from("ai_equity").upsert(
        { book_id: b.id, as_of: today, equity: round2(equity), cash: round2(st.cash) },
        { onConflict: "book_id,as_of" }
      );
      if (eqErr) notes.push(`equity snapshot not saved (${eqErr.message}).`);
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
        const kept = keepLegReason(isStop, cur, next, px);
        if (kept) {
          decisions.push({ symbol: o.symbol, action: "hold", reason: kept });
          continue;
        }
        if (!dry) {
          const nu = await attempt(o.symbol, () => A.replaceOrder(creds, id, { [field]: next.toFixed(2) }));
          if (!nu) continue;
          legIds = legIds.map((x) => (x === id ? nu.id : x));
          bookOfOrder.set(nu.id, o.book_id);
          remoteById.set(nu.id, nu);
          const patch = { leg_ids: legIds, ...(isStop ? { stop_price: next } : { target_price: next }) };
          const { error: uErr } = await admin.from("ai_orders").update(patch).eq("id", o.id);
          if (uErr) notes.push(`${o.symbol}: ${what} moved at Alpaca but not recorded (${uErr.message}).`);
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
      const body = crossed
        ? { symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" }
        : { symbol, qty: String(qty), side: "sell", type: "stop", stop_price: stop.toFixed(2), time_in_force: "gtc" };
      const placed = await submitProtective(creds, body, clientOrderId(b.key, "s", symbol, today)).catch((e: unknown) => {
        decisions.push({ symbol, action: "skip", reason: `rejected by Alpaca: ${e instanceof Error ? e.message : String(e)}` });
        return undefined;
      });
      if (!placed) return;
      const { order: o, clientId } = placed;
      const row = {
        book_id: b.id, symbol, side: "sell" as const, kind: "exit" as const, qty, reason: why,
        stop_price: crossed ? null : stop, alpaca_order_id: o.id, client_order_id: clientId, status: o.status,
      };
      const recErr = await recordOrder(admin, row);
      if (recErr) decisions.push({ symbol, action: "hold", reason: `stop ${o.id} placed but not recorded (${recErr}) — the next run records it from Alpaca` });
      remoteById.set(o.id, o);
    }
    decisions.push({ symbol, action: crossed ? "sell" : "hold", qty, stop: crossed ? undefined : stop, reason: why });
  }

  function candidatesFor(b: BookRow, R: Rules): { list: Candidate[]; stale: StaleSignal[] } {
    if (b.key === "mylist") return mylistCandidates(listOf.get(b.user_id) ?? [], (s) => sigBy.get(s), R, today);
    return { list: freeCandidates(universeOf(b), (s) => barsBy[s], R), stale: [] };
  }

  /** Cancel the position's open stop/target legs and our own stops, then sell it at market (queues if closed). */
  async function exitPosition(b: BookRow, symbol: string, qty: number, why: string, orders: OrderRow[]) {
    const ids = [
      ...orders.filter((o) => o.kind === "entry" && o.symbol === symbol).flatMap((o) => o.leg_ids ?? []),
      ...orders
        .filter((o) => o.kind === "exit" && o.symbol === symbol && o.stop_price != null && o.alpaca_order_id)
        .map((o) => o.alpaca_order_id!),
    ].filter((id) => LIVE.has(remoteById.get(id)?.status ?? ""));
    const { note } = await closeAtMarket({ admin, creds, remoteById, today }, b, symbol, qty, "sell", why, ids);
    return note;
  }
}

const LIVE = new Set([...OPEN, "pending_replace"]);

/**
 * Cancel these orders (the position's own stops / targets), wait until they're gone, then close the
 * position at market (a day order: queued for the next open when the market is closed) under the box's
 * deterministic exit id stk-<key>-x-<SYMBOL>-<NY date> (-2 … -5 when used today), and record it.
 * Shared by the rule exits and closeOutBook. Never throws after the order is placed: a recording
 * failure comes back as `note` (the order is queued; the caller must treat the position as exited).
 */
async function closeAtMarket(
  ctx: { admin: Admin; creds: A.Creds; remoteById: Map<string, A.Order>; today: string },
  b: { id: string; key: string },
  symbol: string,
  qty: number,
  side: "sell" | "buy",
  why: string,
  ids: string[]
): Promise<{ order: A.Order; clientId: string; note: string | null }> {
  const { admin, creds, remoteById, today } = ctx;
  for (const id of ids) await A.cancelOrder(creds, id).catch(() => undefined);
  // Poll the legs and write what we see back into the cache, so a later stop check reads the truth.
  const poll = (id: string) =>
    A.getOrder(creds, id).then(
      (o) => {
        remoteById.set(id, o);
        return o.status;
      },
      () => {
        remoteById.delete(id); // unknown now: stopIsLive() re-reads it
        return "unknown";
      }
    );
  for (let i = 0; i < 6 && ids.length; i++) {
    const states = await Promise.all(ids.map(poll));
    if (states.every((s) => !LIVE.has(s) && s !== "pending_cancel")) break;
    await sleep(500);
  }
  let o: A.Order;
  let clientId: string;
  try {
    ({ order: o, clientId } = await submitProtective(
      creds,
      { symbol, qty: String(qty), side, type: "market", time_in_force: "day" },
      clientOrderId(b.key, "x", symbol, today)
    ));
  } catch (e) {
    // The order failed after the stop legs were cancelled: re-read them so the stop check that follows
    // (runBook step e) sees fresh states and places a stop if none is left.
    await Promise.all(ids.map(poll));
    throw e;
  }
  const recErr = await recordOrder(admin, {
    book_id: b.id, symbol, side, kind: "exit", qty, reason: why,
    alpaca_order_id: o.id, client_order_id: clientId, status: o.status,
  });
  return { order: o, clientId, note: recErr ? `${symbol}: exit ${o.id} placed but not recorded (${recErr}) — the next run records it from Alpaca.` : null };
}

/** The synced ledger of a user's Rules books (step 1 of a run, shared with closeOutBook). */
interface SyncedLedger {
  ours: OrderRow[];
  bookOfOrder: Map<string, string>;
  remote: A.Order[];
  remoteById: Map<string, A.Order>;
  recoveryNotes: Map<string, string>;
  allFills: { book_id: string; order_id: string; symbol: string; side: string; qty: number; price: number; transacted_at: string }[];
  shortEntries: Set<string>;
}

/**
 * Sync Alpaca order status + fills into the ledger for these books (all of one user). Paged and
 * fail-loud: a read error throws before anything is placed. Writes only ai_orders / ai_fills.
 */
async function syncLedger(admin: Admin, books: BookRow[], creds: A.Creds): Promise<SyncedLedger> {
  const bookIds = books.map((b) => b.id);
  const since = books.map((b) => b.created_at).sort()[0];

  // Paged and fail-loud: a run never trades from half a ledger (a read error fails the run before anything is placed).
  const ours = await loadOrders<OrderRow>(
    admin,
    bookIds,
    "id, book_id, symbol, side, kind, qty, limit_price, stop_price, target_price, leg_ids, alpaca_order_id, client_order_id, status, filled_qty, filled_avg, created_at"
  );
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

  // Our own orders by their client id prefix (stk-<book>-…), as syncLive does: an order that was placed
  // but never recorded (the insert failed) still owns its fills, and is recorded now so its stop counts.
  const bookIdByKey = new Map(books.map((b) => [b.key as string, b.id]));
  const known = new Set(ours.map((o) => o.alpaca_order_id).filter(Boolean));
  const recovered = recoveredOrders(remote, bookIdByKey, known);
  for (const r of remote) {
    const key = ownerOf(r.client_order_id ?? "");
    const bid = key ? bookIdByKey.get(key) : undefined;
    if (!bid) continue;
    bookOfOrder.set(r.id, bid);
    for (const l of r.legs ?? []) bookOfOrder.set(l.id, bid);
  }
  const recoveryNotes = new Map<string, string>();
  if (recovered.length) {
    const { data: rec, error: recErr } = await admin
      .from("ai_orders")
      .upsert(recovered, { onConflict: "alpaca_order_id", ignoreDuplicates: true })
      .select("id, book_id, symbol, side, kind, qty, limit_price, stop_price, target_price, leg_ids, alpaca_order_id, client_order_id, status, filled_qty, filled_avg, created_at");
    if (recErr) throw new Error(`ai_orders (recovering unrecorded orders): ${recErr.message}`);
    for (const o of (rec ?? []) as OrderRow[]) {
      ours.push(o);
      known.add(o.alpaca_order_id);
      recoveryNotes.set(o.book_id, [recoveryNotes.get(o.book_id), `recorded ${o.symbol} order ${o.alpaca_order_id} that was placed but missing from the ledger.`].filter(Boolean).join(" "));
    }
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
      must(`ai_orders update ${o.id}`, await admin.from("ai_orders").update(patch).eq("id", o.id));
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
    must("ai_fills upsert", await admin.from("ai_fills").upsert(fillRows, { onConflict: "activity_id", ignoreDuplicates: true }));
  }
  const allFills = await loadFills<{ book_id: string; order_id: string; symbol: string; side: string; qty: number; price: number; transacted_at: string }>(
    admin,
    bookIds,
    "book_id, order_id, symbol, side, qty, price, transacted_at"
  );
  const { shortEntries } = shortOrderIds(ours);
  return { ours, bookOfOrder, remote, remoteById, recoveryNotes, allFills, shortEntries };
}

/** How long a run may hold the per-user lock (longer than any function timeout). */
export const RUN_LOCK_TTL_S = 300;

/**
 * Take the per-user run lock. Before supabase/ai_run_lock.sql is applied the RPC is missing:
 * run unlocked (today's behaviour) and say so. Any other error fails the run (never run twice blindly).
 */
export async function takeRunLock(
  admin: Admin,
  userId: string
): Promise<{ ok: true; runId?: string; note: string | null } | { ok: false }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { data, error } = await admin.rpc("try_lock_ai_run", { p_user: userId, p_run: runId, p_ttl_sec: RUN_LOCK_TTL_S });
  if (error) {
    // Only "the function isn't there" (SQL not applied) runs unlocked; anything else fails the run.
    if (error.code === "PGRST202" || error.code === "42883" || /could not find the function|schema cache/i.test(error.message)) {
      return { ok: true, note: "(run lock not installed — supabase/ai_run_lock.sql)" };
    }
    throw new Error(`run lock: ${error.message}`);
  }
  return data === true ? { ok: true, runId, note: null } : { ok: false };
}

async function releaseRunLock(admin: Admin, userId: string, runId: string) {
  const { error } = await admin.rpc("release_ai_run", { p_user: userId, p_run: runId });
  if (error) console.error(`release_ai_run (${userId}): ${error.message}`); // it expires on its own
}

/**
 * The client order id of a Rules order: one per book + kind + symbol + NY date, so a second run
 * (or a retry) placing the same order the same day is rejected by Alpaca as a duplicate.
 * kind: e = entry, s = protective stop (or a market sell when the stop is crossed), x = rule exit.
 */
export function clientOrderId(book: string, kind: "e" | "s" | "x", symbol: string, nyDate: string): string {
  return `stk-${book}-${kind}-${symbol}-${nyDate}`;
}

/** Alpaca's answer to a reused client_order_id. */
export const isDuplicateClientId = (msg: string) => /client_order_id/i.test(msg) && /unique|exists|duplicate/i.test(msg);

/**
 * Submit a protective order (stop / exit) under its deterministic id; if that id was already used today
 * (an earlier stop of the same day was cancelled or filled), retry as <id>-2 … <id>-5. Only callers that
 * already checked no such order is working use this — a protective stop must never be lost to a used id.
 */
export async function submitProtective(creds: A.Creds, body: Record<string, unknown>, baseId: string): Promise<{ order: A.Order; clientId: string }> {
  for (let n = 1; ; n++) {
    const clientId = n === 1 ? baseId : `${baseId}-${n}`;
    try {
      return { order: await A.submitOrder(creds, { ...body, client_order_id: clientId }), clientId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (n >= 5 || !isDuplicateClientId(msg)) throw e;
    }
  }
}

/** Insert an ai_orders row, retried (3 tries); returns the last error message, or null once recorded. */
export async function recordOrder(admin: Admin, row: Record<string, unknown>, tries = 3): Promise<string | null> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    // upsert on alpaca_order_id: a retry after a lost reply can't create a duplicate row.
    const { error } = await admin.from("ai_orders").upsert(row, { onConflict: "alpaca_order_id", ignoreDuplicates: true });
    if (!error) return null;
    last = error.message;
    if (i < tries - 1) await sleep(300 * (i + 1));
  }
  return last;
}

const numOrNull = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

/**
 * ai_orders rows for Rules orders that exist at Alpaca (client id stk-<book>-…) but not in the ledger.
 * The kind comes from the id's role: -e- entry; -s- (protective stop) and -x- (market exit) are exits.
 */
export function recoveredOrders(remote: A.Order[], bookIdByKey: Map<string, string>, known: Set<string | null>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of remote) {
    const cid = r.client_order_id ?? "";
    const key = ownerOf(cid);
    const bid = key ? bookIdByKey.get(key) : undefined;
    if (!bid || !cid.startsWith("stk-") || known.has(r.id)) continue;
    const role = cid.slice(`stk-${key}-`.length).split("-")[0];
    const legs = r.legs ?? [];
    const legStop = legs.find((l) => l.type === "stop" || l.type === "stop_limit")?.stop_price;
    out.push({
      book_id: bid,
      symbol: r.symbol,
      side: r.side,
      kind: role === "e" ? "entry" : "exit",
      qty: numOrNull(r.qty) ?? 0,
      limit_price: numOrNull(r.limit_price),
      stop_price: numOrNull(role === "e" ? legStop : r.stop_price),
      target_price: numOrNull(legs.find((l) => l.type === "limit")?.limit_price),
      reason: "recovered from Alpaca (placed but not recorded)",
      alpaca_order_id: r.id,
      leg_ids: legs.map((l) => l.id),
      client_order_id: cid,
      status: r.status,
      filled_qty: numOrNull(r.filled_qty) ?? 0,
      filled_avg: numOrNull(r.filled_avg_price),
      created_at: r.created_at,
    });
  }
  return out;
}

/** Record a run; a failed insert is logged (the run itself already happened). */
async function logRun(admin: Admin, bookId: string, mode: RunMode, summary: unknown, error: string | null) {
  const { error: e } = await admin.from("ai_runs").insert({ book_id: bookId, mode, summary, error });
  if (e) console.error(`ai_runs insert (${bookId}): ${e.message}`);
}

/** Time of the latest fill of `symbol` in the ledger. */
function lastFillAt(fills: { symbol: string; transacted_at: string }[], symbol: string): string {
  return fills.filter((f) => f.symbol === symbol).reduce((m, f) => (f.transacted_at > m ? f.transacted_at : m), "");
}

/* ---------------- Close everything in one Rules box ---------------- */

export type CloseOutStatus = "preview" | "skipped" | "queued" | "working" | "filled" | "rejected";

export interface CloseOutLine extends CloseOutItem {
  status: CloseOutStatus;
  detail: string;
  mark: number | null;
  orderId?: string;
  clientId?: string;
}

export interface CloseOutEntryLine {
  symbol: string;
  id: string;
  side: string;
  qty: number;
  status: "preview" | "cancelled" | "failed";
  detail: string;
}

export interface CloseOutResult {
  book: string;
  dry: boolean;
  marketOpen: boolean;
  items: CloseOutLine[];
  entries: CloseOutEntryLine[];
  note?: string;
}

/**
 * Close one Rules box (mylist | free): cancel its own working orders on each held symbol, then close only
 * its own ledger quantity at market (see ./closeout for the plan and the skip rules). Works while the box is
 * switched off. `dry` computes the plan (the confirm list) and places / cancels nothing.
 *
 * Same path as a run: the user's paper keys from Vault, the paper-account check, the per-user run lock
 * (a scheduled run and this can't overlap), the ledger sync, closeAtMarket() for the orders, and an ai_runs
 * row (mode "manual", phase CLOSE) so the box's history shows it. `confirmed` limits the close to what the
 * owner saw in the confirm list.
 */
export async function closeOutBook(opts: {
  admin: Admin;
  userId: string;
  bookKey: "mylist" | "free";
  dry: boolean;
  confirmed?: ConfirmedItem[];
}): Promise<CloseOutResult> {
  const { admin, userId, bookKey, dry } = opts;
  const { data: booksData, error: booksErr } = await admin
    .from("ai_books")
    .select("id, user_id, key, name, start_cash, created_at, settings")
    .eq("user_id", userId)
    .in("key", ["mylist", "free"]);
  if (booksErr) throw new Error(booksErr.message);
  const books = (booksData ?? []) as BookRow[];
  const book = books.find((b) => b.key === bookKey);
  if (!book) throw new Error("no such box");

  const creds = await loadCreds(admin, userId);
  if (!creds) throw new Error("Connect your Alpaca paper account first.");
  const lock = dry ? { ok: true as const, note: null } : await takeRunLock(admin, userId);
  if (!lock.ok) throw new Error("Another run (the scheduled one or a second click) is in progress — try again in a minute.");
  try {
    // Safety first: paper key + paper account, or nothing happens.
    await A.getPaperAccount(creds);
    const clock = await A.getClock(creds);
    const today = etDate(new Date(clock.timestamp));
    const { ours, remote, remoteById, allFills, shortEntries } = await syncLedger(admin, books, creds);

    const { list: adjustments } = await loadAdjustments(admin, [book.id]);
    const st = bookState(baselineOf(book.start_cash, adjustments, book.id), ledgerFills(allFills.filter((f) => f.book_id === book.id), shortEntries));
    const ledgerFilled = new Map<string, number>();
    for (const f of allFills) ledgerFilled.set(f.order_id, (ledgerFilled.get(f.order_id) ?? 0) + Number(f.qty));
    let account: A.Position[] | null = null;
    try {
      account = await A.getPositions(creds);
    } catch {
      account = null; // planCloseOut then skips every symbol: never close without the quantity check
    }
    let plan = planCloseOut({ key: book.key, positions: st.positions.values(), remote, rows: ours.filter((o) => o.book_id === book.id), ledgerFilled, account });
    if (opts.confirmed) plan = matchConfirmed(plan, opts.confirmed);
    const markOf = (s: string) => {
      const a = account?.find((x) => x.symbol === s);
      const v = a ? Number(a.current_price) : NaN;
      return Number.isFinite(v) && v > 0 ? v : (st.positions.get(s)?.avgCost ?? null);
    };

    const items: CloseOutLine[] = plan.items.map((it) => ({
      ...it,
      mark: markOf(it.symbol),
      status: it.skip ? "skipped" : "preview",
      detail:
        it.skip ??
        `${it.side === "sell" ? "sell" : "buy to cover"} ${it.qty} at market${it.cancel.length ? `, after cancelling ${it.cancel.length} of this box's own order${it.cancel.length === 1 ? "" : "s"} on it` : ""}`,
    }));
    const entries: CloseOutEntryLine[] = plan.entries.map((e) => ({ ...e, status: "preview", detail: "resting entry — cancelled so it can't re-open a position" }));
    const result: CloseOutResult = { book: book.name, dry, marketOpen: clock.is_open, items, entries, note: lock.note ?? undefined };
    if (dry) return result;

    const ctx = { admin, creds, remoteById, today };
    for (const e of entries) {
      try {
        await A.cancelOrder(creds, e.id);
        const { error } = await admin.from("ai_orders").update({ status: "canceled" }).eq("alpaca_order_id", e.id);
        e.status = "cancelled";
        e.detail = error ? `cancelled at Alpaca but not recorded (${error.message}) — the next sync fixes it` : "resting entry cancelled";
      } catch (err) {
        e.status = "failed";
        e.detail = `cancel rejected by Alpaca: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    for (const it of items) {
      if (it.skip) continue;
      const verb = it.side === "sell" ? "sell" : "buy-to-cover";
      try {
        const { order, clientId, note } = await closeAtMarket(ctx, book, it.symbol, it.qty, it.side, CLOSE_OUT_REASON, it.cancel);
        it.orderId = order.id;
        it.clientId = clientId;
        let o = order;
        // During the session a market order usually fills at once: look for a second or two.
        for (let i = 0; clock.is_open && i < 4 && o.status !== "filled"; i++) {
          await sleep(500);
          o = await A.getOrder(creds, order.id).catch(() => o);
        }
        if (o.status === "filled") {
          it.status = "filled";
          it.detail = `${verb} filled at $${Number(o.filled_avg_price).toFixed(2)} (${clientId})`;
        } else if (!clock.is_open) {
          it.status = "queued";
          it.detail = `market closed — ${verb} queued for the open (${clientId})`;
        } else {
          it.status = "working";
          it.detail = `${verb} placed at market, not filled yet (${o.status}, ${clientId})`;
        }
        if (note) it.detail += ` · ${note}`;
      } catch (err) {
        it.status = "rejected";
        it.detail = `${verb} rejected by Alpaca: ${err instanceof Error ? err.message : String(err)} — if its stop was cancelled, the next scheduled run places a new one`;
      }
    }

    const decisions: Decision[] = [
      ...entries.map((e): Decision => ({ symbol: e.symbol, action: e.status === "failed" ? "skip" : "cancel", qty: e.qty, reason: `close-out: ${e.detail}` })),
      ...items.map((it): Decision => ({
        symbol: it.symbol,
        action: it.status === "skipped" || it.status === "rejected" ? "skip" : it.side === "sell" ? "sell" : "cover",
        qty: it.qty,
        price: it.mark ?? undefined,
        reason: `close-out: ${it.detail}`,
      })),
    ];
    let value = 0;
    for (const p of st.positions.values()) value += p.qty * (markOf(p.symbol) ?? p.avgCost);
    const sent = items.filter((i) => i.orderId).length;
    const cancelled = entries.filter((e) => e.status === "cancelled").length;
    const summary: RunSummary = {
      book: book.name,
      mode: "manual",
      phase: "CLOSE",
      equity: round2(st.cash + value),
      cash: round2(st.cash),
      available: round2(st.cash),
      note:
        `Owner closed everything in this box: ${sent} of ${items.length} position${items.length === 1 ? "" : "s"} sent to close` +
        (sent && !clock.is_open ? " (market closed — queued for the open)" : "") +
        (entries.length ? `; ${cancelled} resting entr${cancelled === 1 ? "y" : "ies"} cancelled` : "") +
        ".",
      decisions,
    };
    await logRun(admin, book.id, "manual", summary, null);
    return result;
  } finally {
    if ("runId" in lock && lock.runId) await releaseRunLock(admin, userId, lock.runId);
  }
}
