/**
 * Portfolio math — pure, mirrors the Stocky device's model (symbol + lots).
 * A "lot" is one purchase: qty at a price on a date (epoch seconds, optional).
 */

export interface Lot {
  qty: number;
  price: number;
  date?: number; // epoch seconds
}

export interface HoldingStats {
  qty: number;
  avgCost: number; // weighted-average buy price
  costBasis: number; // total invested
  value: number | null; // market value (qty × price)
  pnl: number | null; // value − costBasis (unrealized)
  pnlPct: number | null;
  dayChange: number | null; // qty × (price − prevClose)
  dayPct: number | null; // (price − prevClose) / prevClose
}

export function aggregate(lots: Lot[] | null | undefined): {
  qty: number;
  costBasis: number;
  avgCost: number;
} {
  let qty = 0;
  let costBasis = 0;
  for (const l of lots ?? []) {
    const q = Number(l.qty) || 0;
    const p = Number(l.price) || 0;
    qty += q;
    costBasis += q * p;
  }
  return { qty, costBasis, avgCost: qty > 0 ? costBasis / qty : 0 };
}

export function holdingStats(
  lots: Lot[] | null | undefined,
  price: number | null,
  prevClose: number | null
): HoldingStats {
  const { qty, costBasis, avgCost } = aggregate(lots);
  const value = price != null ? qty * price : null;
  const pnl = value != null ? value - costBasis : null;
  const pnlPct = pnl != null && costBasis > 0 ? (pnl / costBasis) * 100 : null;
  const dayChange = price != null && prevClose != null ? qty * (price - prevClose) : null;
  const dayPct =
    price != null && prevClose != null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null;
  return { qty, avgCost, costBasis, value, pnl, pnlPct, dayChange, dayPct };
}

/* ---- formatters ---- */

const num = (v: number, dp: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** "$1,234" / "-$1,234" */
export const money = (v: number | null, dp = 0): string =>
  v == null ? "—" : (v < 0 ? "−" : "") + "$" + num(Math.abs(v), dp);

/** "+$1,234" / "−$1,234" (signed) */
export const moneySigned = (v: number | null, dp = 0): string =>
  v == null ? "—" : (v < 0 ? "−" : "+") + "$" + num(Math.abs(v), dp);

/** "+1.23%" / "−1.23%" */
export const pct = (v: number | null, dp = 2): string =>
  v == null ? "—" : (v < 0 ? "−" : "+") + num(Math.abs(v), dp) + "%";

/** compact share count: "177.26" / "1,234" */
export const shares = (v: number | null): string =>
  v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 3 });

/** plain price: "204.64" */
export const price = (v: number | null, dp = 2): string => (v == null ? "—" : num(v, dp));
