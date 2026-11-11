/**
 * After-close reviews of the Claude boxes (stocky-trader bin/reviewer.py → Supabase ai_reviews,
 * supabase/ai_reviews.sql). One row per box per trading day: a short plain-English summary, 3–5 lessons
 * (also kept on the Mac in the book's trader/lessons.md) and the day's numbers computed in code.
 * The table may not exist yet: the loader then gets an error and the box simply shows no reviews.
 *
 * The same review also writes each lesson and suggestion as its own row in ai_notes
 * (supabase/ai_notes.sql). Before every Claude run the Mac rebuilds the book's lessons file from the
 * active notes (removed_at is null), so removing one on the website stops Claude reading it.
 */

export interface AiReviewStats {
  trades?: number;
  wins?: number;
  losses?: number;
  pnl?: number;
  avg_r?: number | null;
  exit_reasons?: Record<string, number>;
  model?: string;
  /** The day vs the market (SPY). Older reviews have none. */
  market?: AiReviewMarket;
  /** The day's closed trades (only the fields the website shows). */
  closed?: AiReviewTrade[];
  /** The trades Claude didn't take, scored after the close (setting shadow_review). */
  shadow?: AiReviewShadow;
}

/** stats.market: SPY's day, the box's day and the trades' average edge over the market, all in %. */
export interface AiReviewMarket {
  spy_day_pct?: number;
  book_pct?: number;
  alpha_pct?: number;
  /** How many of the day's trades beat the market (a count), or whether the box did (true/false). */
  beat?: number | boolean;
}

export interface AiReviewTrade {
  symbol: string;
  direction?: "long" | "short";
  pnl?: number;
  r?: number;
  trade_pct?: number;
  spy_pct?: number;
  sector?: string;
  sector_pct?: number;
  /** The trade's % minus the market's % over the same time. */
  alpha_pct?: number;
}

export type ShadowWhy = "skip" | "blocked" | "not chosen";
export type ShadowResult = "target" | "stop" | "open";

/** One stock Claude passed on, and what it would have done. */
export interface AiShadowItem {
  symbol: string;
  dir?: "long" | "short";
  at?: string;
  score?: number;
  failed: string[];
  why?: ShadowWhy;
  result?: ShadowResult;
  r?: number;
  pct?: number;
}

/** Per scorecard check: of the stocks it kept out, how many would have won / lost. */
export interface AiShadowGate {
  gate: string;
  n: number;
  would_win: number;
  would_lose: number;
  avg_r?: number;
}

export interface AiReviewShadow {
  n: number;
  would_win: number;
  would_lose: number;
  items: AiShadowItem[];
  by_gate: AiShadowGate[];
}

export interface AiReview {
  day: string; // YYYY-MM-DD (New York)
  summary: string;
  lessons: string[];
  /** Setting changes the review proposes to the owner (the owner decides; Claude never acts against a setting). */
  suggestions: string[];
  stats: AiReviewStats;
  costUsd: number | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? Math.round(n) : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const dirOf = (v: unknown): "long" | "short" | undefined => (v === "long" || v === "short" ? v : undefined);
const SYM_RE = /^[A-Z0-9.]{1,10}$/;
const symOf = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return SYM_RE.test(s) ? s : undefined;
};
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** stats.market → the parsed numbers, or undefined when there are none. */
export function marketFrom(v: unknown): AiReviewMarket | undefined {
  const m = obj(v);
  if (!m) return undefined;
  const out: AiReviewMarket = {};
  if (num(m.spy_day_pct) !== undefined) out.spy_day_pct = num(m.spy_day_pct);
  if (num(m.book_pct) !== undefined) out.book_pct = num(m.book_pct);
  if (num(m.alpha_pct) !== undefined) out.alpha_pct = num(m.alpha_pct);
  if (typeof m.beat === "boolean") out.beat = m.beat;
  else if (count(m.beat) !== undefined) out.beat = count(m.beat);
  return Object.keys(out).length ? out : undefined;
}

/** stats.closed[] → the day's trades; items without a valid symbol are skipped. */
export function closedFrom(v: unknown, cap = 30): AiReviewTrade[] {
  if (!Array.isArray(v)) return [];
  const out: AiReviewTrade[] = [];
  for (const x of v) {
    const t = obj(x);
    const symbol = t && symOf(t.symbol);
    if (!t || !symbol) continue;
    const row: AiReviewTrade = { symbol };
    const dir = dirOf(t.direction) ?? dirOf(t.dir);
    if (dir) row.direction = dir;
    for (const k of ["pnl", "r", "trade_pct", "spy_pct", "sector_pct", "alpha_pct"] as const) {
      const n = num(t[k]);
      if (n !== undefined) row[k] = n;
    }
    const sector = str(t.sector);
    if (sector) row.sector = sector;
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

const WHY: ShadowWhy[] = ["skip", "blocked", "not chosen"];
const RESULT: ShadowResult[] = ["target", "stop", "open"];

/** stats.shadow → the trades not taken, or undefined when there's nothing usable. Counts fall back to the items. */
export function shadowFrom(v: unknown, cap = 100): AiReviewShadow | undefined {
  const sh = obj(v);
  if (!sh) return undefined;
  const items: AiShadowItem[] = [];
  for (const x of Array.isArray(sh.items) ? sh.items : []) {
    const it = obj(x);
    const symbol = it && symOf(it.symbol);
    if (!it || !symbol) continue;
    const row: AiShadowItem = { symbol, failed: texts(it.failed) };
    const dir = dirOf(it.dir) ?? dirOf(it.direction);
    if (dir) row.dir = dir;
    const at = str(it.at);
    if (at) row.at = at;
    const score = num(it.score);
    if (score !== undefined) row.score = Math.max(0, Math.min(100, Math.round(score)));
    if (WHY.includes(it.why as ShadowWhy)) row.why = it.why as ShadowWhy;
    if (RESULT.includes(it.result as ShadowResult)) row.result = it.result as ShadowResult;
    if (num(it.r) !== undefined) row.r = num(it.r);
    if (num(it.pct) !== undefined) row.pct = num(it.pct);
    items.push(row);
    if (items.length >= cap) break;
  }
  const by_gate: AiShadowGate[] = [];
  for (const [gate, x] of Object.entries(obj(sh.by_gate) ?? {})) {
    const g = obj(x);
    const n = g && count(g.n);
    if (!g || !n || !/^[a-z][a-z_]{0,39}$/.test(gate)) continue;
    const row: AiShadowGate = { gate, n, would_win: count(g.would_win) ?? 0, would_lose: count(g.would_lose) ?? 0 };
    if (num(g.avg_r) !== undefined) row.avg_r = num(g.avg_r);
    by_gate.push(row);
  }
  by_gate.sort((a, b) => b.n - a.n || (a.gate < b.gate ? -1 : 1));
  const n = count(sh.n) ?? items.length;
  if (!n && !items.length && !by_gate.length) return undefined;
  return {
    n,
    would_win: count(sh.would_win) ?? items.filter((i) => i.result === "target").length,
    would_lose: count(sh.would_lose) ?? items.filter((i) => i.result === "stop").length,
    items,
    by_gate,
  };
}

/** A check's plain verdict from what it kept out: it helped when it kept out more losers than winners. */
export function gateVerdict(g: Pick<AiShadowGate, "would_win" | "would_lose">): "helped" | "cost you" | "even" {
  return g.would_lose > g.would_win ? "helped" : g.would_win > g.would_lose ? "cost you" : "even";
}

/** "+1.4%" / "−0.8%" (one decimal; a tiny value reads +0.0%, never −0.0%). */
export function signedPct(v: number, dp = 1): string {
  const f = 10 ** dp;
  const r = Math.round(v * f) / f;
  return (r < 0 ? "−" : "+") + Math.abs(r).toFixed(dp) + "%";
}

/** "Market (SPY) +1.4% · this box −0.8% · trades vs market −0.6% avg · 1 of 5 beat it", or null. */
export function marketLine(s: Pick<AiReviewStats, "market" | "trades" | "closed">): string | null {
  const m = s.market;
  if (!m) return null;
  const bits: string[] = [];
  if (m.spy_day_pct !== undefined) bits.push(`Market (SPY) ${signedPct(m.spy_day_pct)}`);
  if (m.book_pct !== undefined) bits.push(`this box ${signedPct(m.book_pct)}`);
  if (m.alpha_pct !== undefined) bits.push(`trades vs market ${signedPct(m.alpha_pct)} avg`);
  if (typeof m.beat === "number") {
    const of = s.trades ?? (s.closed?.length || undefined);
    if (of !== undefined && of >= m.beat) bits.push(`${m.beat} of ${of} beat it`);
    else bits.push(`${m.beat} beat it`);
  } else if (typeof m.beat === "boolean") {
    bits.push(m.beat ? "beat the market" : "behind the market");
  }
  return bits.length ? bits.join(" · ") : null;
}

/** ai_reviews rows for one box → reviews, newest day first, at most `cap`. Bad rows are skipped, never thrown. */
export function reviewsFrom(rows: unknown, bookId: string, cap = 5): AiReview[] {
  if (!Array.isArray(rows)) return [];
  const out: AiReview[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || r.book_id !== bookId || typeof r.day !== "string") continue;
    const s = (r.stats && typeof r.stats === "object" ? r.stats : {}) as Record<string, unknown>;
    const reasons = s.exit_reasons && typeof s.exit_reasons === "object" ? (s.exit_reasons as Record<string, unknown>) : {};
    out.push({
      day: r.day,
      summary: typeof r.summary === "string" ? r.summary : "",
      lessons: texts(r.lessons),
      suggestions: texts(r.suggestions),
      stats: {
        trades: num(s.trades),
        wins: num(s.wins),
        losses: num(s.losses),
        pnl: num(s.pnl),
        avg_r: num(s.avg_r) ?? null,
        exit_reasons: Object.fromEntries(Object.entries(reasons).filter(([, v]) => typeof v === "number")) as Record<string, number>,
        model: typeof s.model === "string" ? s.model : undefined,
        market: marketFrom(s.market),
        closed: closedFrom(s.closed),
        shadow: shadowFrom(s.shadow),
      },
      costUsd: num(r.cost_usd) ?? null,
    });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, cap);
}

export type AiNoteKind = "lesson" | "suggestion";

/** One active lesson or suggestion (ai_notes, removed_at is null) — what Claude reads before its next run. */
export interface AiNote {
  id: string;
  day: string; // YYYY-MM-DD (New York): the review that wrote it
  kind: AiNoteKind;
  text: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ai_notes rows for one box → notes, newest day first (then newest written first), at most `cap`.
 * The order matches how the Mac picks "the newest N of each kind". Bad rows are skipped, never thrown.
 */
export function notesFrom(rows: unknown, bookId: string, cap = 200): AiNote[] {
  if (!Array.isArray(rows)) return [];
  const out: (AiNote & { at: number })[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || r.book_id !== bookId) continue;
    if (typeof r.id !== "string" || !r.id || typeof r.day !== "string" || !DAY_RE.test(r.day)) continue;
    if (r.kind !== "lesson" && r.kind !== "suggestion") continue;
    if (typeof r.text !== "string" || r.text.trim() === "") continue;
    out.push({ id: r.id, day: r.day, kind: r.kind, text: r.text.trim(), at: (typeof r.created_at === "string" && Date.parse(r.created_at)) || 0 });
  }
  out.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : b.at - a.at));
  return out.slice(0, cap).map((n) => ({ id: n.id, day: n.day, kind: n.kind, text: n.text }));
}
