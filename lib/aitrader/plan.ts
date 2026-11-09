/**
 * Risk rules + order planning — pure and deterministic (no model judgement).
 * Every number comes from the book's settings (lib/aitrader/limits.ts), with the
 * contract's defaults where nothing is saved.
 */
import { effective, parseSymbols, rulesDefs, type BoxKey } from "./limits";

export interface Rules {
  budget: number;
  riskPct: number;
  maxPositionPct: number;
  cashBufferPct: number;
  maxPositions: number;
  maxNewPerRun: number;
  dailyLossHaltPct: number; // 0 = off
  atrMult: number;
  minStopPct: number;
  maxStopPct: number;
  rewardRisk: number; // 0 = stop only (no take-profit)
  entrySlipPct: number;
  entryValidDays: number;
  staleEntryHours: number; // entryValidDays × 24 − 4 (so a 1-day entry is gone by the next evening run)
  minPrice: number;
  minScore: number;
  maxSignalAgeDays: number; // 0 = off
  enterOnWatch: boolean;
  exitOnOverbought: boolean;
  maxHoldDays: number; // 0 = off
  maxRsi: number;
  uptrendOnly: boolean;
  universeAdd: string[];
  universeRemove: string[];
}

/** A book's effective rules: the contract defaults overlaid with its saved (validated) settings. */
export function rulesFor(settings: Record<string, unknown> | null | undefined, box: BoxKey = "free"): Rules {
  const e = effective(rulesDefs(box), settings);
  // Fields that don't apply to this box still get the contract default, so the shape is stable.
  const all = { ...effective(rulesDefs(box === "free" ? "mylist" : "free"), {}), ...e };
  const num = (k: string) => Number(all[k]);
  const pct = (k: string) => Number(all[k]) / 100;
  const bool = (k: string) => all[k] === true;
  const validDays = Math.max(1, num("entry_valid_days"));
  return {
    budget: num("budget"),
    riskPct: pct("risk_pct"),
    maxPositionPct: pct("max_position_pct"),
    cashBufferPct: pct("cash_buffer_pct"),
    maxPositions: num("max_positions"),
    maxNewPerRun: num("max_new_per_run"),
    dailyLossHaltPct: pct("daily_loss_halt_pct"),
    atrMult: num("atr_mult"),
    minStopPct: pct("min_stop_pct"),
    maxStopPct: pct("max_stop_pct"),
    rewardRisk: num("reward_risk"),
    entrySlipPct: pct("entry_slip_pct"),
    entryValidDays: validDays,
    staleEntryHours: validDays * 24 - 4,
    minPrice: num("min_price"),
    minScore: num("min_score"),
    maxSignalAgeDays: num("max_signal_age_days"),
    enterOnWatch: bool("enter_on_watch"),
    exitOnOverbought: bool("exit_on_overbought"),
    maxHoldDays: num("max_hold_days"),
    maxRsi: num("max_rsi"),
    uptrendOnly: bool("uptrend_only"),
    universeAdd: parseSymbols(all.universe_add),
    universeRemove: parseSymbols(all.universe_remove),
  };
}

/** Default rules (nothing saved) for the Free Choice box. */
export const RULES: Rules = rulesFor({}, "free");

/** Round to a valid US equity tick: cents at ≥ $1. */
export const tick = (p: number) => Math.round(p * 100) / 100;

export interface Bracket {
  limit: number; // entry limit price
  stop: number;
  target: number | null; // null = stop only
  riskPerShare: number; // measured from the limit (worst-case entry)
}

/** Stop distance from a price: ATR multiple clamped to [min, max] % of the price (6% without ATR). */
function stopDistance(price: number, atr14: number | null, R: Rules): number {
  const raw = atr14 != null ? R.atrMult * atr14 : price * 0.06;
  return Math.min(Math.max(raw, price * R.minStopPct), price * R.maxStopPct);
}

/** Entry limit + stop + R-multiple target from a reference price and ATR(14). */
export function bracket(ref: number, atr14: number | null, R: Rules = RULES): Bracket {
  const limit = tick(ref * (1 + R.entrySlipPct));
  const stop = tick(ref - stopDistance(ref, atr14, R));
  const riskPerShare = limit - stop;
  const target = R.rewardRisk > 0 ? tick(limit + R.rewardRisk * riskPerShare) : null;
  return { limit, stop, target, riskPerShare };
}

/** Stop + target recomputed from the actual fill price (same rules, risk measured from the fill). */
export function anchorToFill(fill: number, atr14: number | null, R: Rules = RULES): { stop: number; target: number | null } {
  const stop = tick(fill - stopDistance(fill, atr14, R));
  const target = R.rewardRisk > 0 ? tick(fill + R.rewardRisk * (fill - stop)) : null;
  return { stop, target };
}

/**
 * The Alpaca body for an entry: a GTC limit buy with an attached stop — a
 * bracket (stop + take-profit), or an OTO with only the stop when there's no target.
 */
export function entryOrderBody(symbol: string, qty: number, br: Bracket, clientId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: "limit",
    limit_price: br.limit.toFixed(2),
    time_in_force: "gtc",
    order_class: br.target != null ? "bracket" : "oto",
    stop_loss: { stop_price: br.stop.toFixed(2) },
    client_order_id: clientId,
  };
  if (br.target != null) body.take_profit = { limit_price: br.target.toFixed(2) };
  return body;
}

export interface SizeInput {
  equity: number; // book equity now
  available: number; // book cash minus cash reserved by pending entries
  price: number; // limit price
  riskPerShare: number;
}

/** Whole shares (bracket GTC orders can't be fractional), or 0 with a reason. */
export function sizeQty(s: SizeInput, R: Rules = RULES): { qty: number; why?: string } {
  if (s.riskPerShare <= 0) return { qty: 0, why: "invalid stop" };
  const byRisk = Math.floor((s.equity * R.riskPct) / s.riskPerShare);
  const byPosition = Math.floor((s.equity * R.maxPositionPct) / s.price);
  const spendable = s.available - s.equity * R.cashBufferPct;
  const byCash = Math.floor(spendable / s.price);
  const qty = Math.min(byRisk, byPosition, byCash);
  if (qty >= 1) return { qty };
  if (byCash < 1) return { qty: 0, why: "not enough cash" };
  if (byPosition < 1) return { qty: 0, why: `one share > ${+(R.maxPositionPct * 100).toFixed(1)}% of book` };
  return { qty: 0, why: `one share risks more than ${+(R.riskPct * 100).toFixed(2)}% of book` };
}

export interface WorkingEntry {
  qty: number;
  filled_qty: number;
  limit_price: number | null;
}

/** Cash still committed to working entries: the unfilled remainder at its limit (filled shares are already in the ledger). */
export function reservedCash(entries: WorkingEntry[]): number {
  return entries.reduce((a, e) => a + Math.max(0, e.qty - (e.filled_qty || 0)) * (e.limit_price ?? 0), 0);
}

/** True when a working entry is older than the book allows. */
export function isStaleEntry(createdAt: string, now: Date, R: Rules): boolean {
  return (now.getTime() - new Date(createdAt).getTime()) / 3_600_000 > R.staleEntryHours;
}
