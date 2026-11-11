import { describe, expect, it } from "vitest";
import { notesFrom, reviewsFrom } from "./reviews";

describe("reviewsFrom", () => {
  it("keeps one box's rows, newest first, and skips junk", () => {
    const rows = [
      { book_id: "B", day: "2026-11-09", summary: "Older.", lessons: ["a"], stats: { trades: 2, pnl: -5, exit_reasons: { stop: 2 } }, cost_usd: 0.003 },
      { book_id: "B", day: "2026-11-10", summary: "Newer.", lessons: ["x", "", 3, "y"], stats: { trades: 1, model: "haiku", exit_reasons: { trail: 1, bad: "n" } }, cost_usd: null },
      { book_id: "OTHER", day: "2026-11-11", summary: "not mine", lessons: [], stats: {} },
      { book_id: "B", summary: "no day" },
      null,
    ];
    const r = reviewsFrom(rows, "B");
    expect(r.map((x) => x.day)).toEqual(["2026-11-10", "2026-11-09"]);
    expect(r[0]).toMatchObject({ summary: "Newer.", lessons: ["x", "y"], costUsd: null, stats: { trades: 1, model: "haiku", exit_reasons: { trail: 1 } } });
    expect(r[1].stats).toMatchObject({ pnl: -5, exit_reasons: { stop: 2 } });
  });

  it("parses suggestions like lessons (missing column → none)", () => {
    const r = reviewsFrom(
      [
        { book_id: "B", day: "2026-11-10", summary: "", lessons: [], suggestions: ["Raise the min score to 60", " ", 7], stats: {} },
        { book_id: "B", day: "2026-11-09", summary: "", lessons: ["a"], stats: {} },
      ],
      "B"
    );
    expect(r[0].suggestions).toEqual(["Raise the min score to 60"]);
    expect(r[1].suggestions).toEqual([]);
  });

  it("no table (an error, data null) means no reviews", () => {
    expect(reviewsFrom(null, "B")).toEqual([]);
    expect(reviewsFrom(undefined, "B")).toEqual([]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ book_id: "B", day: `2026-11-0${i + 1}`, summary: "", lessons: [], stats: {} }));
    expect(reviewsFrom(rows, "B", 3).map((x) => x.day)).toEqual(["2026-11-09", "2026-11-08", "2026-11-07"]);
  });
});

describe("notesFrom", () => {
  const n = (o: Record<string, unknown>) => ({ book_id: "B", kind: "lesson", text: "t", created_at: "2026-11-10T21:00:00+00:00", ...o });

  it("keeps one box's valid rows, newest day first, then newest written first", () => {
    const rows = [
      n({ id: "1", day: "2026-11-09", text: "old lesson" }),
      n({ id: "2", day: "2026-11-10", text: "first", created_at: "2026-11-10T21:00:00+00:00" }),
      n({ id: "3", day: "2026-11-10", kind: "suggestion", text: "  later  ", created_at: "2026-11-10T21:00:05.5+00:00" }),
      n({ id: "4", day: "2026-11-11", book_id: "OTHER" }),
      n({ id: "5", day: "2026-11-10", kind: "rule" }),
      n({ id: "6", day: "Nov 10" }),
      n({ id: "7", day: "2026-11-10", text: "   " }),
      n({ id: "", day: "2026-11-10" }),
      n({ id: "8", day: "2026-11-08", created_at: null }),
      null,
      "junk",
    ];
    expect(notesFrom(rows, "B")).toEqual([
      { id: "3", day: "2026-11-10", kind: "suggestion", text: "later" },
      { id: "2", day: "2026-11-10", kind: "lesson", text: "first" },
      { id: "1", day: "2026-11-09", kind: "lesson", text: "old lesson" },
      { id: "8", day: "2026-11-08", kind: "lesson", text: "t" },
    ]);
  });

  it("no table (an error, data null) means no notes; caps the list", () => {
    expect(notesFrom(null, "B")).toEqual([]);
    expect(notesFrom({}, "B")).toEqual([]);
    const rows = Array.from({ length: 6 }, (_, i) => n({ id: String(i), day: `2026-11-0${i + 1}` }));
    expect(notesFrom(rows, "B", 2).map((x) => x.id)).toEqual(["5", "4"]);
  });
});
