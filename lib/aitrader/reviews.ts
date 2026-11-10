/**
 * After-close reviews of the Claude boxes (stocky-trader bin/reviewer.py → Supabase ai_reviews,
 * supabase/ai_reviews.sql). One row per box per trading day: a short plain-English summary, 3–5 lessons
 * (also kept on the Mac in the book's trader/lessons.md) and the day's numbers computed in code.
 * The table may not exist yet: the loader then gets an error and the box simply shows no reviews.
 */

export interface AiReviewStats {
  trades?: number;
  wins?: number;
  losses?: number;
  pnl?: number;
  avg_r?: number | null;
  exit_reasons?: Record<string, number>;
  model?: string;
}

export interface AiReview {
  day: string; // YYYY-MM-DD (New York)
  summary: string;
  lessons: string[];
  stats: AiReviewStats;
  costUsd: number | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

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
      lessons: Array.isArray(r.lessons) ? r.lessons.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [],
      stats: {
        trades: num(s.trades),
        wins: num(s.wins),
        losses: num(s.losses),
        pnl: num(s.pnl),
        avg_r: num(s.avg_r) ?? null,
        exit_reasons: Object.fromEntries(Object.entries(reasons).filter(([, v]) => typeof v === "number")) as Record<string, number>,
        model: typeof s.model === "string" ? s.model : undefined,
      },
      costUsd: num(r.cost_usd) ?? null,
    });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, cap);
}
