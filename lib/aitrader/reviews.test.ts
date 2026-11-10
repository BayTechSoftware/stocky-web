import { describe, expect, it } from "vitest";
import { reviewsFrom } from "./reviews";

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

  it("no table (an error, data null) means no reviews", () => {
    expect(reviewsFrom(null, "B")).toEqual([]);
    expect(reviewsFrom(undefined, "B")).toEqual([]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ book_id: "B", day: `2026-11-0${i + 1}`, summary: "", lessons: [], stats: {} }));
    expect(reviewsFrom(rows, "B", 3).map((x) => x.day)).toEqual(["2026-11-09", "2026-11-08", "2026-11-07"]);
  });
});
