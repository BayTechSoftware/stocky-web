/**
 * Reading a decision's scorecard (stocky-trader bin/rate.py, attached by bin/sync.py) for display.
 * Decisions from before the scorecard have neither `score` nor `scorecard`; a decision Claude wrote by
 * hand may carry only lists (failed / warned / support) and no gates. Everything here tolerates both.
 */
import type { Decision, DecisionScorecard, ScorecardGateRow } from "./engine";

export type GateTone = "pass" | "warn" | "block" | "fail-off" | "na";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The decision's score (0–100), or null when it has none. */
export function scoreOf(d: Pick<Decision, "score" | "scorecard">): number | null {
  if (isNum(d.score)) return Math.max(0, Math.min(100, Math.round(d.score)));
  const s = d.scorecard?.score;
  return isNum(s) ? Math.max(0, Math.min(100, Math.round(s))) : null;
}

/** A cleaned-up scorecard, or null when the decision has nothing worth showing. */
export function scorecardOf(d: Pick<Decision, "score" | "scorecard">): DecisionScorecard | null {
  const c = d.scorecard;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const gates: ScorecardGateRow[] = Array.isArray(c.gates)
    ? c.gates.filter((g): g is ScorecardGateRow => !!g && typeof g === "object" && typeof g.k === "string")
    : [];
  const parts = Array.isArray(c.parts)
    ? c.parts.filter((p) => !!p && typeof p === "object" && typeof p.k === "string")
    : [];
  const out: DecisionScorecard = {
    ...c,
    score: scoreOf(d),
    gates,
    parts,
    blocked: strs(c.blocked),
    failed: strs(c.failed),
    warned: strs(c.warned),
    support: strs(c.support),
    why: typeof c.why === "string" ? c.why : undefined,
  };
  const empty = !gates.length && !parts.length && !out.failed!.length && !out.warned!.length && !out.support!.length && !out.why;
  return empty ? null : out;
}

/** How a gate reads: passed, a warning, a block, a failure on a gate the owner switched off, or no data. */
export function gateTone(g: ScorecardGateRow): GateTone {
  if (g.s === "pass") return "pass";
  if (g.s === "fail") return g.m === "block" ? "block" : g.m === "off" ? "fail-off" : "warn";
  return "na";
}

/** Colour band of a score. */
export function scoreBand(score: number | null): "high" | "mid" | "low" | "none" {
  if (score == null) return "none";
  return score >= 70 ? "high" : score >= 50 ? "mid" : "low";
}

/** "3 pass · 2 warn · 1 block" for a scorecard's summary line. */
export function gateCounts(c: DecisionScorecard): string {
  const n = { pass: 0, warn: 0, block: 0 };
  for (const g of c.gates ?? []) {
    const t = gateTone(g);
    if (t === "pass" || t === "warn" || t === "block") n[t]++;
  }
  if (!c.gates?.length) {
    const bits = [];
    if (c.support?.length) bits.push(`supports: ${c.support.join(", ")}`);
    if (c.warned?.length) bits.push(`warns: ${c.warned.join(", ")}`);
    return bits.join(" · ");
  }
  return [`${n.pass} pass`, n.warn ? `${n.warn} warn` : "", n.block ? `${n.block} block` : ""].filter(Boolean).join(" · ");
}
