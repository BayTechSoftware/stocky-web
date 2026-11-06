/**
 * Daily swing setups for the Free Choice book.
 *
 * The four pattern rules are ported from the Trader skill's daily scanner
 * (Jakeschincariol/day-trader-skill, trader-scanner/scan.py, MIT License) so the
 * book trades "the skills' choices". On top of them we add a trend filter the
 * skill doesn't have: momentum setups must be above their 50-day average and a
 * bounce must be above its 200-day average — buying dips in uptrends only.
 */
import { rsi, sma } from "../signals";
import type { Bar } from "../alpaca";

export type SetupName = "breakout_20d" | "bull_flag" | "reclaim_ma20" | "oversold_bounce";

/** Skill rules, from daily closes (oldest → newest). Needs ≥ 30 closes. */
export function findSetups(c: number[]): SetupName[] {
  if (c.length < 30) return [];
  const n = c.length;
  const last = c[n - 1];
  const out: SetupName[] = [];

  // breakout_20d: last close above the highest of the prior 20 closes.
  const hi20 = Math.max(...c.slice(n - 21, n - 1));
  if (last > hi20) out.push("breakout_20d");

  // bull_flag: >10% run (16→6 bars ago), then a tight <5% range over the last 5 closes.
  const run = c[n - 6] / c[n - 16] - 1;
  const last5 = c.slice(n - 5);
  const rng5 = (Math.max(...last5) - Math.min(...last5)) / last;
  if (run > 0.1 && rng5 < 0.05) out.push("bull_flag");

  // reclaim_ma20: prior close below its 20-day average, last close back above.
  const prevMa20 = sma(c.slice(0, n - 1), 20);
  const ma20 = sma(c, 20);
  if (prevMa20 != null && ma20 != null && c[n - 2] < prevMa20 && last > ma20) out.push("reclaim_ma20");

  // oversold_bounce: RSI(14) was < 30 yesterday and today closed up.
  const prevRsi = rsi(c.slice(0, n - 1));
  if (prevRsi != null && prevRsi < 30 && last > c[n - 2]) out.push("oversold_bounce");

  return out;
}

/** Average true range over `period` bars (simple mean of true ranges). */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return sum / period;
}

const WEIGHT: Record<SetupName, number> = {
  breakout_20d: 3,
  bull_flag: 3,
  reclaim_ma20: 2,
  oversold_bounce: 2,
};

export interface Candidate {
  symbol: string;
  setups: SetupName[];
  score: number;
  ret20: number; // 20-day % return, tie-break (relative strength)
  rsi: number | null;
  reason: string;
}

/**
 * Apply the trend filter and score a symbol's setups. Returns null when nothing
 * qualifies. Momentum setups need close > 50-day MA; a bounce needs close >
 * 200-day MA; anything with RSI ≥ 75 is too extended to chase.
 */
export function scoreCandidate(symbol: string, closes: number[]): Candidate | null {
  const raw = findSetups(closes);
  if (raw.length === 0) return null;
  const last = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const r = rsi(closes);
  if (r != null && r >= 75) return null;

  const setups = raw.filter((s) =>
    s === "oversold_bounce" ? ma200 != null && last > ma200 : ma50 != null && last > ma50
  );
  if (setups.length === 0) return null;

  const score = setups.reduce((a, s) => a + WEIGHT[s], 0);
  const base = closes[closes.length - 21];
  const ret20 = base > 0 ? (last / base - 1) * 100 : 0;
  const reason =
    setups.join(" + ") +
    (r != null ? ` · RSI ${Math.round(r)}` : "") +
    ` · ${ret20 >= 0 ? "+" : ""}${ret20.toFixed(1)}% 20d`;
  return { symbol, setups, score, ret20, rsi: r, reason };
}

/** Rank: higher setup score first, then stronger 20-day relative strength. */
export function rankCandidates(cs: Candidate[]): Candidate[] {
  return cs.slice().sort((a, b) => b.score - a.score || b.ret20 - a.ret20);
}
