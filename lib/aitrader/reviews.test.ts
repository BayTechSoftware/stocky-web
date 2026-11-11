import { describe, expect, it } from "vitest";
import { closedFrom, gateVerdict, marketFrom, marketLine, notesFrom, reviewsFrom, shadowFrom, signedPct } from "./reviews";

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

describe("review stats: market, closed trades, trades not taken", () => {
  it("older reviews have none of the new fields", () => {
    const [r] = reviewsFrom([{ book_id: "B", day: "2026-11-10", summary: "", lessons: [], stats: { trades: 1 } }], "B");
    expect(r.stats.market).toBeUndefined();
    expect(r.stats.closed).toEqual([]);
    expect(r.stats.shadow).toBeUndefined();
    expect(marketLine(r.stats)).toBeNull();
  });

  it("market: keeps the numbers, skips junk", () => {
    expect(marketFrom(undefined)).toBeUndefined();
    expect(marketFrom([1, 2])).toBeUndefined();
    expect(marketFrom({ spy_day_pct: "1.4", book_pct: NaN, beat: "two" })).toBeUndefined();
    expect(marketFrom({ spy_day_pct: 1.4, book_pct: -0.8, alpha_pct: -0.6, beat: 1 })).toEqual({
      spy_day_pct: 1.4, book_pct: -0.8, alpha_pct: -0.6, beat: 1,
    });
    expect(marketFrom({ beat: true })).toEqual({ beat: true });
    expect(marketFrom({ beat: -2, spy_day_pct: 0.2 })).toEqual({ spy_day_pct: 0.2 });
  });

  it("market line in plain words", () => {
    expect(marketLine({ market: { spy_day_pct: 1.4, book_pct: -0.8, alpha_pct: -0.6, beat: 1 }, trades: 5 })).toBe(
      "Market (SPY) +1.4% · this box −0.8% · trades vs market −0.6% avg · 1 of 5 beat it"
    );
    expect(marketLine({ market: { spy_day_pct: -0.04, beat: 2 }, closed: [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }] })).toBe(
      "Market (SPY) +0.0% · 2 of 3 beat it"
    );
    expect(marketLine({ market: { beat: 3 }, trades: 1 })).toBe("3 beat it"); // inconsistent count: no "of"
    expect(marketLine({ market: { book_pct: 0.5, beat: false } })).toBe("this box +0.5% · behind the market");
    expect(signedPct(-1.26)).toBe("−1.3%");
  });

  it("closed trades: new fields parsed, bad items and values skipped", () => {
    const c = closedFrom([
      { symbol: "nvda", direction: "long", pnl: 12.5, r: 0.8, trade_pct: 1.2, spy_pct: 0.3, sector: "XLK", sector_pct: 0.9, alpha_pct: 0.9, qty: 3 },
      { symbol: "TSLA", dir: "short", pnl: "x", alpha_pct: null, sector: " " },
      { symbol: "bad symbol!" },
      { pnl: 4 },
      "junk",
      null,
    ]);
    expect(c).toEqual([
      { symbol: "NVDA", direction: "long", pnl: 12.5, r: 0.8, trade_pct: 1.2, spy_pct: 0.3, sector: "XLK", sector_pct: 0.9, alpha_pct: 0.9 },
      { symbol: "TSLA", direction: "short" },
    ]);
    expect(closedFrom({ symbol: "A" })).toEqual([]);
    expect(closedFrom(Array.from({ length: 40 }, () => ({ symbol: "A" })))).toHaveLength(30);
  });

  it("shadow: full shape", () => {
    const sh = shadowFrom({
      n: 12, would_win: 4, would_lose: 8,
      items: [
        { symbol: "AMD", dir: "long", at: "10:05", score: 48.6, failed: ["rvol", 3, "trend"], why: "blocked", result: "stop", r: -1, pct: -1.9 },
        { symbol: "PLTR", dir: "short", why: "not chosen", result: "target", r: 2, pct: 3.1 },
        { symbol: "", why: "skip" },
        { symbol: "META", why: "maybe", result: "boom", score: "high" },
      ],
      by_gate: {
        rvol: { n: 5, would_win: 1, would_lose: 4, avg_r: -0.6 },
        trend: { n: 7, would_win: 4, would_lose: 2, avg_r: 0.4 },
        catalyst: { n: 0, would_win: 0, would_lose: 0 },
        "Bad Key": { n: 3 },
        sector: "junk",
      },
    })!;
    expect([sh.n, sh.would_win, sh.would_lose]).toEqual([12, 4, 8]);
    expect(sh.items).toEqual([
      { symbol: "AMD", dir: "long", at: "10:05", score: 49, failed: ["rvol", "trend"], why: "blocked", result: "stop", r: -1, pct: -1.9 },
      { symbol: "PLTR", dir: "short", failed: [], why: "not chosen", result: "target", r: 2, pct: 3.1 },
      { symbol: "META", failed: [] },
    ]);
    expect(sh.by_gate).toEqual([
      { gate: "trend", n: 7, would_win: 4, would_lose: 2, avg_r: 0.4 },
      { gate: "rvol", n: 5, would_win: 1, would_lose: 4, avg_r: -0.6 },
    ]);
    expect(sh.by_gate.map(gateVerdict)).toEqual(["cost you", "helped"]);
    expect(gateVerdict({ would_win: 2, would_lose: 2 })).toBe("even");
  });

  it("shadow: missing counts fall back to the items; nothing usable → undefined", () => {
    const sh = shadowFrom({ items: [{ symbol: "A", result: "target" }, { symbol: "B", result: "stop" }, { symbol: "C", result: "open" }] })!;
    expect([sh.n, sh.would_win, sh.would_lose, sh.by_gate]).toEqual([3, 1, 1, []]);
    expect(shadowFrom(undefined)).toBeUndefined();
    expect(shadowFrom("x")).toBeUndefined();
    expect(shadowFrom({})).toBeUndefined();
    expect(shadowFrom({ n: "lots", items: "none", by_gate: [] })).toBeUndefined();
    expect(shadowFrom({ n: 2 })).toMatchObject({ n: 2, would_win: 0, would_lose: 0, items: [] });
  });

  it("reaches the review through reviewsFrom", () => {
    const [r] = reviewsFrom(
      [{
        book_id: "B", day: "2026-11-10", summary: "", lessons: [],
        stats: { trades: 2, market: { spy_day_pct: 0.5 }, closed: [{ symbol: "A", pnl: 1 }], shadow: { n: 1, items: [{ symbol: "Z" }] } },
      }],
      "B"
    );
    expect(r.stats.market).toEqual({ spy_day_pct: 0.5 });
    expect(r.stats.closed).toEqual([{ symbol: "A", pnl: 1 }]);
    expect(r.stats.shadow?.items).toEqual([{ symbol: "Z", failed: [] }]);
  });
});
