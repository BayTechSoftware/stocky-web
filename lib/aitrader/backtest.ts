/**
 * Rules backtest — replays a Rules box (mylist / free) over historical DAILY bars
 * with the box's effective rules and the live engine's own decision functions
 * (lib/aitrader/decide.ts + plan.ts). Pure: bars in, result out — no I/O, no orders.
 *
 * Per trading day D:
 *   1. the session of D (D > first day), in this order:
 *      - exits queued by the previous run (OVERBOUGHT / time stop) sell at D's open;
 *      - stop / target legs of positions filled BEFORE D: an open at/through a leg
 *        fills at the open (gap); else a low ≤ stop fills at the stop — when the
 *        bar also reaches the target, the STOP is assumed first (conservative);
 *        else a high ≥ target fills at the target;
 *      - working entry limits: open ≤ limit fills at the open, else low ≤ limit
 *        fills at the limit, else the order waits (until entry_valid_days expire).
 *   2. the run after D's close (what the engine's evening run does), using bars
 *      up to D's close only: cancel expired entries, re-anchor the legs of entries
 *      filled today to the fill, mark equity, daily-loss halt, queue rule exits,
 *      then new entries (limit orders that can fill from D+1).
 * My List signals are recomputed per day from the closes (lib/signals.ts, the
 * same 252-close window the refresh job uses); Free Choice uses setups.ts on the
 * same 420-calendar-day window the engine loads. Whole shares, no commissions.
 *
 * Only the evening run is simulated: new trades are opened after the close, which is the engine with
 * midday_entries off — so midday_entries doesn't change a backtest (with it on, the live engine can
 * also enter during the session). reentry_cooldown_days is applied like the engine.
 */
import type { Bar } from "../alpaca";
import { assess } from "../signals";
import { anchorToFill, isStaleEntry, nyIso, reservedCash, type Rules, type Session } from "./plan";
import { atr, type Candidate } from "./setups";
import {
  HISTORY_DAYS,
  entrySlots,
  etDate,
  exitReason,
  freeCandidates,
  haltReason,
  keepLegReason,
  mylistCandidates,
  planEntry,
  reentrySkip,
  type SignalLite,
  type StaleSignal,
} from "./decide";

export const PERIODS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 } as const;
export type Period = keyof typeof PERIODS;
export const DEFAULT_PERIOD: Period = "1Y";
export const isPeriod = (p: unknown): p is Period => typeof p === "string" && p in PERIODS;

/** Closes the refresh job's signals are computed from (Twelve Data outputsize). */
const SIGNAL_CLOSES = 252;
const DAY_MS = 86_400_000;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** `end` (YYYY-MM-DD) minus the period's months, clamped to the month's last day. */
export function periodStart(end: string, p: Period): string {
  const [y, m, d] = end.split("-").map(Number);
  const months = y * 12 + (m - 1) - PERIODS[p];
  const ny = Math.floor(months / 12);
  const nm = months % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}

/** First date of history to load so the first simulated day has the engine's full indicator window. */
export function historyStart(start: string): string {
  return new Date(Date.parse(start) - HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** When the simulated evening run happens on a date (the engine's 22:30 UTC cron). */
const runTime = (date: string) => new Date(`${date}T22:30:00Z`);
/** When a simulated fill happens (the open, ≈ 09:30 NY). */
const fillTime = (date: string) => `${date}T14:30:00Z`;

/** What a day's run can see: only bars up to that day's close. */
export interface DayCtx {
  date: string;
  now: Date;
  /** The engine's window for a symbol: bars from date − 420 calendar days up to and including `date`. */
  barsOf: (symbol: string) => Bar[] | undefined;
  /** Close on `date` (or the last close before it). */
  closeOf: (symbol: string) => number | null;
  /** Stocky signal recomputed from the closes up to `date`. */
  sigOf: (symbol: string) => SignalLite | undefined;
}

export type Picker = (ctx: DayCtx, R: Rules) => { list: Candidate[]; stale: StaleSignal[] };

export interface BacktestInput {
  box: "mylist" | "free";
  rules: Rules;
  /** Daily bars per symbol, oldest → newest (t = session date), incl. the warm-up history. */
  bars: Record<string, Bar[]>;
  /** What the box trades: the watchlist (mylist) or the Free Choice universe. */
  symbols: string[];
  /** Simulated window, YYYY-MM-DD inclusive. */
  start: string;
  end: string;
  /** Buy-and-hold benchmark symbol (default SPY). */
  benchmark?: string;
  /** Candidate selection override (tests). Defaults to the engine's for the box. */
  pick?: Picker;
}

export interface BacktestTrade {
  symbol: string;
  entryDate: string;
  entry: number;
  exitDate: string;
  exit: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  why: string; // exit reason
  setup: string; // entry reason
  open?: boolean; // still held at the end — marked to the last close
}

export interface BacktestResult {
  start: string;
  end: string;
  days: number;
  startCash: number;
  endEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number; // closed trades
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null; // null when there are no losing trades
  exposurePct: number; // average share of equity invested at the close
  buyHoldSpyPct: number | null;
  haltedDays: number;
  expiredEntries: number;
  missing: string[]; // symbols with no bars
  equity: { date: string; equity: number; spy: number | null }[];
  tradesList: BacktestTrade[];
}

interface Series {
  bars: Bar[];
  dates: string[];
  hi: number; // index of the last bar dated ≤ the current day (−1 = none yet)
  lo: number; // index of the first bar inside the engine's history window
}

interface Pos {
  symbol: string;
  qty: number;
  fill: number;
  entryDate: string;
  openedAt: string;
  stop: number;
  target: number | null;
  atr14: number | null; // ATR(14) when the entry was placed (what the engine re-anchors with)
  setup: string;
  exitWhy?: string; // market exit queued for the next open
}

interface Working {
  symbol: string;
  qty: number;
  limit: number;
  stop: number;
  target: number | null;
  createdAt: string;
  atr14: number | null;
  setup: string;
}

/** Peak-to-trough decline of a value series, in % of the peak (≥ 0). */
export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

/** Trade statistics over closed trades (|P&L| < 1 cent = flat: neither a win nor a loss, like the ledger). */
export function tradeStats(trades: { pnl: number; pnlPct: number }[]) {
  const wins = trades.filter((t) => t.pnl >= 0.005);
  const losses = trades.filter((t) => t.pnl <= -0.005);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const decided = wins.length + losses.length;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: decided ? (wins.length / decided) * 100 : null,
    avgWinPct: mean(wins.map((t) => t.pnlPct)),
    avgLossPct: mean(losses.map((t) => t.pnlPct)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

/** The engine's candidate selection for a box. */
export function defaultPicker(box: "mylist" | "free", symbols: string[]): Picker {
  return box === "mylist"
    ? (ctx, R) => mylistCandidates(symbols, ctx.sigOf, R, ctx.date)
    : (ctx, R) => ({ list: freeCandidates(symbols, ctx.barsOf, R), stale: [] });
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const R = input.rules;
  const bench = input.benchmark ?? "SPY";
  const pick = input.pick ?? defaultPicker(input.box, input.symbols);

  const series = new Map<string, Series>();
  for (const [sym, bars] of Object.entries(input.bars)) {
    if (!bars?.length) continue;
    series.set(sym, { bars, dates: bars.map((b) => etDate(new Date(b.t))), hi: -1, lo: 0 });
  }
  const missing = input.symbols.filter((s) => !series.has(s));

  // Trading calendar: every date any symbol traded inside the window.
  const cal = new Set<string>();
  for (const s of series.values()) for (const d of s.dates) if (d >= input.start && d <= input.end) cal.add(d);
  const days = Array.from(cal).sort();
  if (!days.length) throw new Error("no daily bars in the backtest window");
  // Entry age counts trading sessions, like the engine (the window's own trading days).
  const sessions: Session[] = days.map((d) => ({ date: d, open: nyIso(d, "09:30"), close: nyIso(d, "16:00") }));

  const startCash = R.budget;
  let cash = startCash;
  const positions = new Map<string, Pos>();
  let working: Working[] = [];
  const closed: BacktestTrade[] = [];
  /** Closed trades as the re-entry cooldown reads them (exit at the session's open/stop time). */
  const cooldownLog: { symbol: string; closedAt: string }[] = [];
  const equity: BacktestResult["equity"] = [];
  let prevEquity: number | null = null;
  let haltedDays = 0;
  let expiredEntries = 0;
  let invested = 0;
  let spy0: number | null = null;
  let spyLast: number | null = null;

  for (let i = 0; i < days.length; i++) {
    const D = days[i];
    const now = runTime(D);
    const windowStart = etDate(new Date(now.getTime() - HISTORY_DAYS * DAY_MS));
    for (const s of series.values()) {
      while (s.hi + 1 < s.dates.length && s.dates[s.hi + 1] <= D) s.hi++;
      while (s.lo < s.dates.length && s.dates[s.lo] < windowStart) s.lo++;
    }
    const barToday = (sym: string): Bar | undefined => {
      const s = series.get(sym);
      return s && s.hi >= 0 && s.dates[s.hi] === D ? s.bars[s.hi] : undefined;
    };
    const closeOf = (sym: string): number | null => {
      const s = series.get(sym);
      return s && s.hi >= 0 ? s.bars[s.hi].c : null;
    };
    const winCache = new Map<string, Bar[] | undefined>();
    const barsOf = (sym: string): Bar[] | undefined => {
      if (winCache.has(sym)) return winCache.get(sym);
      const s = series.get(sym);
      const w = s && s.hi >= s.lo ? s.bars.slice(s.lo, s.hi + 1) : undefined;
      winCache.set(sym, w);
      return w;
    };
    const sigCache = new Map<string, SignalLite | undefined>();
    const sigOf = (sym: string): SignalLite | undefined => {
      if (sigCache.has(sym)) return sigCache.get(sym);
      const s = series.get(sym);
      let sig: SignalLite | undefined;
      if (s && s.hi >= 14) {
        const closes = s.bars.slice(Math.max(0, s.hi + 1 - SIGNAL_CLOSES), s.hi + 1).map((b) => b.c);
        const a = assess({ closes });
        sig = { assessment: a.assessment, tag: a.tag, score: a.score, updated_at: now.toISOString() };
      }
      sigCache.set(sym, sig);
      return sig;
    };

    const close = (p: Pos, exit: number, why: string) => {
      cash += p.qty * exit;
      const pnl = p.qty * (exit - p.fill);
      closed.push({
        symbol: p.symbol, entryDate: p.entryDate, entry: p.fill, exitDate: D, exit, qty: p.qty,
        pnl: round2(pnl), pnlPct: (exit / p.fill - 1) * 100, why, setup: p.setup,
      });
      positions.delete(p.symbol);
      cooldownLog.push({ symbol: p.symbol, closedAt: fillTime(D) });
    };

    /* ---- 1. the session of D ---- */
    const filledToday: Pos[] = [];
    if (i > 0) {
      for (const p of Array.from(positions.values())) {
        const bar = barToday(p.symbol);
        if (!bar) continue;
        if (p.exitWhy) {
          close(p, bar.o, `${p.exitWhy} — sold at the open`);
          continue;
        }
        if (bar.o <= p.stop) close(p, bar.o, `gapped through the ${p.stop.toFixed(2)} stop — filled at the open`);
        else if (p.target != null && bar.o >= p.target) close(p, bar.o, `gapped over the ${p.target.toFixed(2)} target — filled at the open`);
        else if (bar.l <= p.stop) {
          const both = p.target != null && bar.h >= p.target;
          close(p, p.stop, both ? "stop — the bar also reached the target; stop assumed first" : "stop");
        } else if (p.target != null && bar.h >= p.target) close(p, p.target, "target");
      }
      const still: Working[] = [];
      for (const w of working) {
        const bar = barToday(w.symbol);
        const fill = !bar ? null : bar.o <= w.limit ? bar.o : bar.l <= w.limit ? w.limit : null;
        if (fill == null) {
          still.push(w);
          continue;
        }
        cash -= w.qty * fill;
        const p: Pos = {
          symbol: w.symbol, qty: w.qty, fill, entryDate: D, openedAt: fillTime(D),
          stop: w.stop, target: w.target, atr14: w.atr14, setup: w.setup,
        };
        positions.set(w.symbol, p);
        filledToday.push(p);
      }
      working = still;
    }

    /* ---- 2. the run after D's close ---- */
    // a) cancel entries older than the book allows
    const live = working.filter((w) => !isStaleEntry(w.createdAt, now, R, sessions));
    expiredEntries += working.length - live.length;
    working = live;

    // b) re-anchor today's fills' legs (a stop-only OTO can't be replaced at Alpaca)
    for (const p of filledToday) {
      if (p.target == null) continue;
      const want = anchorToFill(p.fill, p.atr14, R);
      const px = closeOf(p.symbol);
      if (Math.abs(want.stop - p.stop) >= 0.01 && !keepLegReason(true, p.stop, want.stop, px)) p.stop = want.stop;
      if (want.target != null && Math.abs(want.target - p.target) >= 0.01 && !keepLegReason(false, p.target, want.target, px)) {
        p.target = want.target;
      }
    }

    // c) equity at the close
    let value = 0;
    for (const p of positions.values()) value += p.qty * (closeOf(p.symbol) ?? p.fill);
    const eq = cash + value;
    let available = cash - reservedCash(working.map((w) => ({ qty: w.qty, filled_qty: 0, limit_price: w.limit })));
    invested += eq > 0 ? value / eq : 0;

    // d) daily-loss halt vs the previous close
    const halted = haltReason(eq, prevEquity, R);
    if (halted) haltedDays++;

    // e) rule exits → market sell at the next open
    for (const p of positions.values()) {
      if (p.exitWhy) continue;
      const mylist = input.box === "mylist";
      p.exitWhy = exitReason({ mylist, R, sig: mylist ? sigOf(p.symbol) : undefined, openedAt: p.openedAt, now });
    }

    // f) new entries
    if (!halted) {
      const occupied = new Set([...positions.keys(), ...working.map((w) => w.symbol)]);
      const { wantN } = entrySlots(R, occupied.size);
      let placed = 0;
      const cands = wantN > 0 ? pick({ date: D, now, barsOf, closeOf, sigOf }, R).list : [];
      for (const c of cands) {
        if (placed >= wantN) break;
        if (occupied.has(c.symbol)) continue;
        if (reentrySkip(c.symbol, cooldownLog, D, R)) continue;
        const bars = barsOf(c.symbol);
        const plan = planEntry(c, bars, closeOf(c.symbol), R, eq, available);
        if (!plan.ok) continue;
        working.push({
          symbol: c.symbol, qty: plan.qty, limit: plan.br.limit, stop: plan.br.stop, target: plan.br.target,
          createdAt: now.toISOString(), atr14: bars ? atr(bars) : null, setup: plan.reason,
        });
        available -= plan.qty * plan.br.limit;
        occupied.add(c.symbol);
        placed++;
      }
    }

    // g) snapshot
    const spyPx = closeOf(bench);
    if (spy0 == null && spyPx != null) spy0 = spyPx;
    if (spyPx != null) spyLast = spyPx;
    equity.push({ date: D, equity: round2(eq), spy: spy0 != null && spyPx != null ? round2((startCash * spyPx) / spy0) : null });
    prevEquity = eq;
  }

  const end = days[days.length - 1];
  const open: BacktestTrade[] = Array.from(positions.values()).map((p) => {
    const s = series.get(p.symbol)!;
    const px = s.hi >= 0 ? s.bars[s.hi].c : p.fill;
    return {
      symbol: p.symbol, entryDate: p.entryDate, entry: p.fill, exitDate: end, exit: px, qty: p.qty,
      pnl: round2(p.qty * (px - p.fill)), pnlPct: (px / p.fill - 1) * 100,
      why: p.exitWhy ? `${p.exitWhy} — exit queued at the end` : "still held — marked to the last close", setup: p.setup, open: true,
    };
  });

  const endEquity = equity[equity.length - 1].equity;
  return {
    start: days[0],
    end,
    days: days.length,
    startCash,
    endEquity,
    returnPct: (endEquity / startCash - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equity.map((e) => e.equity)),
    ...tradeStats(closed),
    exposurePct: (invested / days.length) * 100,
    buyHoldSpyPct: spy0 != null && spyLast != null ? (spyLast / spy0 - 1) * 100 : null,
    haltedDays,
    expiredEntries,
    missing,
    equity,
    tradesList: [...closed, ...open],
  };
}
