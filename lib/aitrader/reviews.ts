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
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

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
