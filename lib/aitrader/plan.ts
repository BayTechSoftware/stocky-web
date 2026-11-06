/**
 * Risk rules + order planning — pure and deterministic (no model judgement).
 * Defaults mirror the Trader skill's config.example.json scaled to a $5K book:
 * $50 max loss per trade (1%), 3 new trades a day, $150 daily loss halt (3%).
 */

export const RULES = {
  riskPct: 0.01, // risk 1% of book equity per trade
  maxPositionPct: 0.2, // ≤ 20% of book equity in any one name
  cashBufferPct: 0.1, // always keep 10% cash
  maxPositions: 5,
  maxNewPerRun: 3,
  dailyLossHaltPct: 0.03, // stop opening trades after a 3% down day
  atrMult: 2, // stop = entry − 2 × ATR(14) …
  minStopPct: 0.03, // … but no tighter than 3%
  maxStopPct: 0.12, // … and no wider than 12%
  rewardRisk: 2, // target = entry + 2 × risk
  entrySlipPct: 0.01, // limit entry ≤ 1% above the reference price
  freeMaxHoldDays: 21, // Free Choice time stop (~15 trading days)
  minPrice: 10,
  staleEntryHours: 20, // cancel entries that haven't filled by the next run
} as const;

/** Round to a valid US equity tick: cents at ≥ $1. */
export const tick = (p: number) => Math.round(p * 100) / 100;

export interface Bracket {
  limit: number; // entry limit price
  stop: number;
  target: number;
  riskPerShare: number; // measured from the limit (worst-case entry)
}

/** Entry limit + stop + 2R target from a reference price and ATR(14). */
export function bracket(ref: number, atr14: number | null): Bracket {
  const limit = tick(ref * (1 + RULES.entrySlipPct));
  const raw = atr14 != null ? RULES.atrMult * atr14 : ref * 0.06;
  const dist = Math.min(Math.max(raw, ref * RULES.minStopPct), ref * RULES.maxStopPct);
  const stop = tick(ref - dist);
  const riskPerShare = limit - stop;
  const target = tick(limit + RULES.rewardRisk * riskPerShare);
  return { limit, stop, target, riskPerShare };
}

export interface SizeInput {
  equity: number; // book equity now
  available: number; // book cash minus cash reserved by pending entries
  price: number; // limit price
  riskPerShare: number;
}

/** Whole shares (bracket GTC orders can't be fractional), or 0 with a reason. */
export function sizeQty(s: SizeInput): { qty: number; why?: string } {
  if (s.riskPerShare <= 0) return { qty: 0, why: "invalid stop" };
  const byRisk = Math.floor((s.equity * RULES.riskPct) / s.riskPerShare);
  const byPosition = Math.floor((s.equity * RULES.maxPositionPct) / s.price);
  const spendable = s.available - s.equity * RULES.cashBufferPct;
  const byCash = Math.floor(spendable / s.price);
  const qty = Math.min(byRisk, byPosition, byCash);
  if (qty >= 1) return { qty };
  if (byCash < 1) return { qty: 0, why: "not enough cash" };
  if (byPosition < 1) return { qty: 0, why: `one share > ${RULES.maxPositionPct * 100}% of book` };
  return { qty: 0, why: "one share risks more than 1% of book" };
}
