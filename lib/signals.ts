/**
 * Stocky Watcher — signal engine (pure, dependency-free).
 *
 * From a series of daily closes it computes RSI(14), 50/200-day moving averages,
 * a Fibonacci-retracement "buy zone" price band, and a BUY / WASHOUT / WATCH /
 * OVERBOUGHT assessment with a 0–100 attractiveness score.
 *
 * Philosophy (mirrors Portfolio Radar's shape): buy weakness into a defined zone,
 * scale into washouts, stay away from names that have run above the zone / are
 * overbought. Every threshold is a named constant below, so the rules are easy to
 * tune against a real eye once wired to live data.
 */

export type Assessment = "BUY" | "WASHOUT" | "WATCH" | "OVERBOUGHT";
export type ZonePos = "below" | "in" | "above";

export interface SignalInput {
  /** Daily closes, oldest → newest. ≥15 needed for RSI; ~250 ideal for the zone. */
  closes: number[];
  /** Latest/intraday price; defaults to the last close. */
  price?: number;
}

export interface Signal {
  price: number;
  rsi: number | null; // RSI(14), null if < 15 closes
  ma50: number | null;
  ma200: number | null;
  trendUp: boolean | null; // price ≥ 200-day MA
  zoneLow: number; // buy-zone band (Fibonacci retracement of the trailing swing)
  zoneHigh: number;
  zonePos: ZonePos;
  /** % above zoneHigh (+) or below zoneLow (−); 0 when in-zone. */
  pctFromZone: number;
  /** 52-week (trailing ~1y) high and low from the daily closes. */
  week52High: number;
  week52Low: number;
  /** Trailing ~1-year return %, first→last close in the window; null if too few closes. */
  ret1y: number | null;
  assessment: Assessment;
  /** Human tag: SWEET / OK / OVERSOLD / EXPENSIVE / FALLING / NEAR. */
  tag: string;
  /** 0–100; higher = more attractive entry right now. */
  score: number;
}

/* ---- tunable thresholds (one place to dial the whole engine) ---- */
export const RSI_PERIOD = 14;
export const RSI_OVERSOLD = 38; // washout / oversold line
export const RSI_OVERBOUGHT = 70;
export const RSI_SWEET_LO = 35; // "sweet" pullback band
export const RSI_SWEET_HI = 50;
export const EXPENSIVE_ABOVE_PCT = 8; // % above zoneHigh to flag as expensive
export const SWING_WINDOW = 252; // ~1 trading year for the swing hi/lo
export const FIB_DEEP = 0.618; // deeper retracement from the high → zoneLow (better value)
export const FIB_SHALLOW = 0.382; // shallower retracement → zoneHigh

/** Simple moving average of the last `period` values, or null if too few. */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** Wilder's RSI over daily closes. Returns null if fewer than period+1 closes. */
export function rsi(closes: number[], period = RSI_PERIOD): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // flat → neutral; all-gains → 100
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Buy-zone band = Fibonacci retracement of the trailing swing (low..high).
 * A pullback from the high into [0.618-retr, 0.382-retr] is a classic value entry;
 * a name ripping to new highs sits ABOVE the zone (→ "expensive, wait for a dip").
 */
export function buyZone(
  closes: number[],
  window = SWING_WINDOW
): { low: number; high: number } {
  const w = closes.slice(-window);
  const hi = Math.max(...w);
  const lo = Math.min(...w);
  const range = hi - lo;
  return { low: hi - FIB_DEEP * range, high: hi - FIB_SHALLOW * range };
}

function scoreOf(
  zonePos: ZonePos,
  pctFromZone: number,
  rsiVal: number,
  trendUp: boolean | null
): number {
  // Zone component (0–60): most attractive in-zone or a shallow dip below it.
  let z: number;
  if (zonePos === "in") z = 60;
  else if (zonePos === "below") z = pctFromZone >= -10 ? 45 : 30;
  else z = pctFromZone <= 5 ? 35 : pctFromZone <= 15 ? 20 : 8;
  // RSI component (0–30): peaks near 40 (a healthy pullback), falls off either side.
  const rsiComp = Math.max(0, 30 - Math.abs(rsiVal - 40) * 0.9);
  // Trend component (0–10): prefer buying dips in uptrends.
  const t = trendUp === null ? 5 : trendUp ? 10 : 2;
  return Math.round(Math.max(0, Math.min(100, z + rsiComp + t)));
}

/** Full assessment for one symbol from its daily closes (+ optional live price). */
export function assess(input: SignalInput): Signal {
  const { closes } = input;
  const price = input.price ?? closes[closes.length - 1];
  const r = rsi(closes);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const trendUp = ma200 == null ? null : price >= ma200;
  const { low: zoneLow, high: zoneHigh } = buyZone(closes);

  // 52-week range + 1y return from the same trailing-year window as the zone.
  const win = closes.slice(-SWING_WINDOW);
  const week52High = Math.max(...win);
  const week52Low = Math.min(...win);
  const ret1y = win.length >= 2 && win[0] > 0 ? ((price - win[0]) / win[0]) * 100 : null;

  let zonePos: ZonePos;
  let pctFromZone = 0;
  if (price < zoneLow) {
    zonePos = "below";
    pctFromZone = ((price - zoneLow) / zoneLow) * 100;
  } else if (price > zoneHigh) {
    zonePos = "above";
    pctFromZone = ((price - zoneHigh) / zoneHigh) * 100;
  } else {
    zonePos = "in";
  }

  const rr = r ?? 50;
  let assessment: Assessment;
  let tag: string;
  if (zonePos === "above" && (pctFromZone > EXPENSIVE_ABOVE_PCT || rr >= RSI_OVERBOUGHT)) {
    assessment = "OVERBOUGHT";
    tag = rr >= RSI_OVERBOUGHT ? "OVERBOUGHT" : "EXPENSIVE";
  } else if (zonePos === "below") {
    if (rr <= RSI_OVERSOLD) {
      assessment = "WASHOUT";
      tag = "OVERSOLD";
    } else {
      assessment = "WATCH";
      tag = "FALLING"; // below the zone but not oversold → "fall not over"
    }
  } else if (zonePos === "in") {
    assessment = "BUY";
    tag = rr < RSI_SWEET_LO ? "OVERSOLD" : rr <= RSI_SWEET_HI ? "SWEET" : "OK";
  } else {
    assessment = "WATCH"; // just above the zone, not expensive yet
    tag = "NEAR";
  }

  return {
    price,
    rsi: r,
    ma50,
    ma200,
    trendUp,
    zoneLow,
    zoneHigh,
    zonePos,
    pctFromZone,
    week52High,
    week52Low,
    ret1y,
    assessment,
    tag,
    score: scoreOf(zonePos, pctFromZone, rr, trendUp),
  };
}
