/**
 * The Rules books' decisions — pure and deterministic, shared by the live engine
 * (lib/aitrader/engine.ts) and the backtest (lib/aitrader/backtest.ts) so a
 * backtest replays exactly what the engine would decide from the same bars and
 * signals: which candidates qualify, how many new entries a run may place, how
 * an entry is bracketed and sized, when a position is exited, when the book halts.
 * No I/O here.
 */
import type { Bar } from "../alpaca";
import { bracket, sizeQty, type Bracket, type Rules } from "./plan";
import { atr, rankCandidates, scoreCandidate, type Candidate } from "./setups";
import { claudeOrderRole } from "./live";

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in New York time. */
export function etDate(d: Date = new Date()): string {
  return NY_DATE.format(d);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Order statuses that can still fill. */
const CAN_STILL_FILL = new Set([
  "new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding", "pending_replace", "pending_cancel",
]);

/** Result of looking up the shared account's shorts; a failed lookup must stop new entries. */
export type ShortCheck = { ok: true; symbols: Set<string> } | { ok: false; error: string };

/**
 * Symbols a Rules book must not buy: short anywhere on the shared account, or with
 * a Claude short entry still working. A buy there would silently cover that short.
 * Only `claude-…-s-…` counts: a Rules book's own protective stop is `stk-…-s-…`.
 */
export function shortBlockedSymbols(
  positions: { symbol: string; qty: string; side?: string }[],
  orders: { symbol: string; side: string; status: string; client_order_id?: string | null }[]
): Set<string> {
  const out = new Set<string>();
  for (const p of positions) if (Number(p.qty) < 0 || p.side === "short") out.add(p.symbol);
  for (const o of orders) {
    if (o.side === "sell" && CAN_STILL_FILL.has(o.status) && claudeOrderRole(o.client_order_id ?? "") === "s") out.add(o.symbol);
  }
  return out;
}

/** Why a run can't open anything at all, or null when the lookup worked. */
export function shortLookupSkip(check: ShortCheck): string | null {
  return check.ok ? null : `no new entries this run: couldn't check the account for shorts (${check.error})`;
}

/** Why this symbol can't be bought, or null when it can. */
export function shortConflict(symbol: string, check: ShortCheck): string | null {
  if (!check.ok) return shortLookupSkip(check);
  return check.symbols.has(symbol) ? "short in another box on this account — buying here would cover it" : null;
}

/** Whole calendar days (NY) between a timestamp and `today` (YYYY-MM-DD), or null if unknown. */
export function signalAgeDays(updatedAt: string | null | undefined, today: string): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.parse(today) - Date.parse(etDate(new Date(t)))) / 86_400_000);
}

/** The fields of a Stocky signal the Rules books read (a symbol_signals row, or lib/signals.ts assess()). */
export interface SignalLite {
  assessment?: string | null;
  tag?: string | null;
  score?: number | null;
  updated_at?: string | null;
}

/** A skipped signal: its age in days, or null when it has no update time. */
export interface StaleSignal {
  symbol: string;
  days: number | null;
}

/** My List candidates: BUY / WASHOUT (+ WATCH if enabled) at ≥ min score, fresh signals only, best score first. */
export function mylistCandidates(
  list: string[],
  sigOf: (symbol: string) => SignalLite | undefined,
  R: Rules,
  today: string
): { list: Candidate[]; stale: StaleSignal[] } {
  const ok = new Set(["BUY", "WASHOUT", ...(R.enterOnWatch ? ["WATCH"] : [])]);
  const stale: StaleSignal[] = [];
  const picks = list
    .map((sym) => ({ sym, sig: sigOf(sym) }))
    .filter(({ sig }) => ok.has(String(sig?.assessment)) && (sig?.score ?? 0) >= R.minScore)
    .filter(({ sym, sig }) => {
      const days = signalAgeDays(sig?.updated_at, today);
      // No update time = unknown age = stale (never trusted when the age check is on).
      if (R.maxSignalAgeDays > 0 && (days == null || days > R.maxSignalAgeDays)) {
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

/** Free Choice candidates: the Trader skill's setups on each universe symbol's daily closes, ranked. */
export function freeCandidates(universe: string[], barsOf: (symbol: string) => Bar[] | undefined, R: Rules): Candidate[] {
  const cs: Candidate[] = [];
  for (const sym of universe) {
    const bars = barsOf(sym);
    if (!bars || bars.length < 60) continue;
    const c = scoreCandidate(sym, bars.map((x) => x.c), { maxRsi: R.maxRsi, uptrendOnly: R.uptrendOnly });
    if (c) cs.push(c);
  }
  return rankCandidates(cs);
}

/** Why a held position is sold at market this run (OVERBOUGHT signal on My List, or the time stop), if at all. */
export function exitReason(p: {
  mylist: boolean;
  R: Rules;
  sig: SignalLite | undefined;
  openedAt: string;
  now: Date;
}): string | undefined {
  if (p.mylist && p.R.exitOnOverbought && p.sig?.assessment === "OVERBOUGHT") {
    return `signal turned OVERBOUGHT${p.sig.tag ? ` · ${p.sig.tag}` : ""}`;
  }
  if (p.R.maxHoldDays > 0) {
    const days = (p.now.getTime() - new Date(p.openedAt).getTime()) / 86_400_000;
    if (days > p.R.maxHoldDays) return `time stop — held ${Math.round(days)} days (max ${p.R.maxHoldDays})`;
  }
  return undefined;
}

/** Daily-loss halt: equity down more than the rule allows since the previous snapshot → no new entries. */
export function haltReason(equity: number, prev: number | null | undefined, R: Rules): string | undefined {
  if (R.dailyLossHaltPct > 0 && prev != null && prev > 0 && equity < prev * (1 - R.dailyLossHaltPct)) {
    return `down $${round2(prev - equity)} (${((1 - equity / prev) * 100).toFixed(1)}%) since the last snapshot — no new entries (${+(R.dailyLossHaltPct * 100).toFixed(2)}% daily-loss halt)`;
  }
  return undefined;
}

/** Why a run during market hours opens nothing new (midday_entries off), or undefined. */
export function middaySkip(R: Rules, marketOpen: boolean): string | undefined {
  return marketOpen && !R.middayEntries ? "no new trades in runs during market hours (setting) — the evening run opens them" : undefined;
}

/**
 * Why `symbol` can't be re-entered yet (reentry_cooldown_days), or undefined. Days are NY calendar
 * dates since the last closed trade in it: 1 blocks only the same day.
 */
export function reentrySkip(symbol: string, closed: { symbol: string; closedAt: string }[], today: string, R: Rules): string | undefined {
  if (R.reentryCooldownDays <= 0) return undefined;
  const last = closed.filter((c) => c.symbol === symbol).reduce((m, c) => (c.closedAt > m ? c.closedAt : m), "");
  if (!last) return undefined;
  const days = Math.round((Date.parse(today) - Date.parse(etDate(new Date(last)))) / 86_400_000);
  return days < R.reentryCooldownDays
    ? `closed a trade in it ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`} — waiting ${R.reentryCooldownDays} day${R.reentryCooldownDays === 1 ? "" : "s"} before re-entering`
    : undefined;
}

/** How many new entries this run may place given the occupied slots (positions + working entries). */
export function entrySlots(R: Rules, occupied: number): { wantN: number; skip?: string } {
  const wantN = Math.max(0, Math.min(R.maxPositions - occupied, R.maxNewPerRun));
  if (wantN > 0) return { wantN };
  return { wantN, skip: R.maxNewPerRun === 0 ? "new trades per run set to 0" : `book full (${R.maxPositions} positions/orders)` };
}

/** Why a session's open is too far below the previous close (max_gap_down_pct), or undefined. */
export function gapDownReason(open: number | null | undefined, prevClose: number | null | undefined, R: Rules): string | undefined {
  if (R.maxGapDownPct <= 0 || open == null || prevClose == null || !(prevClose > 0)) return undefined;
  const gap = 1 - open / prevClose;
  return gap > R.maxGapDownPct
    ? `gapped down ${(gap * 100).toFixed(1)}% at the open (limit ${+(R.maxGapDownPct * 100).toFixed(2)}%)`
    : undefined;
}

export type EntryPlan = { ok: false; reason: string } | { ok: true; qty: number; br: Bracket; reason: string };

/**
 * One candidate's entry: enough history, min price, bracket from the reference
 * price + ATR(14), whole shares sized by risk / position cap / cash.
 */
export function planEntry(
  c: Candidate,
  bars: Bar[] | undefined,
  ref: number | null,
  R: Rules,
  equity: number,
  available: number
): EntryPlan {
  if (!bars || bars.length < 30 || ref == null) return { ok: false, reason: "not enough price history" };
  if (ref < R.minPrice) return { ok: false, reason: `price under $${R.minPrice}` };
  const a14 = atr(bars);
  if (R.minAtrPct > 0 && (a14 == null || a14 / ref < R.minAtrPct)) {
    return { ok: false, reason: `moves too little: ATR(14) ${a14 == null ? "n/a" : `${((a14 / ref) * 100).toFixed(2)}%`} < ${+(R.minAtrPct * 100).toFixed(2)}% of the price` };
  }
  const last = bars[bars.length - 1];
  const gap = gapDownReason(last?.o, bars[bars.length - 2]?.c, R);
  if (gap) return { ok: false, reason: `${c.reason} — ${gap}` };
  const br = bracket(ref, a14, R);
  const sz = sizeQty({ equity, available, price: br.limit, riskPerShare: br.riskPerShare }, R);
  if (!sz.qty) return { ok: false, reason: `${c.reason} — ${sz.why}` };
  return { ok: true, qty: sz.qty, br, reason: br.target == null ? `${c.reason} · stop only` : c.reason };
}

/**
 * Re-anchoring a bracket leg to the fill: a stop that would land at/above the
 * current price (or a target at/below it) is kept where it is. Returns the
 * reason it's kept, or undefined when the leg may move.
 */
export function keepLegReason(isStop: boolean, cur: number, next: number, px: number | null): string | undefined {
  if (isStop && px != null && next >= px) {
    return `kept stop at ${cur.toFixed(2)} — from the fill it would be ${next.toFixed(2)}, at/above the price ${px.toFixed(2)}`;
  }
  if (!isStop && px != null && next <= px) {
    return `kept target at ${cur.toFixed(2)} — from the fill it would be ${next.toFixed(2)}, at/below the price ${px.toFixed(2)}`;
  }
  return undefined;
}

/** Daily bars whose session had closed when `atIso` happened (bar t = session date at midnight NY; close ≈ +16 h). */
export function barsAsOf(bars: Bar[], atIso: string): Bar[] {
  const at = Date.parse(atIso);
  return bars.filter((x) => Date.parse(x.t) + 16 * 3_600_000 <= at);
}

/** Calendar days of daily history the live engine loads for its indicators (and the backtest mirrors). */
export const HISTORY_DAYS = 420;
