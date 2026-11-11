import { describe, expect, it } from "vitest";
import { adjustedSince, baselineOf, sizeOf } from "./cash";

const adj = [
  { book_id: "a", at: "2026-11-01T15:00:00Z", amount: 5000 },
  { book_id: "a", at: "2026-11-11T15:00:00Z", amount: -2000 },
  { book_id: "b", at: "2026-11-11T15:00:00Z", amount: 999 },
];

describe("cash adjustments (fix #9)", () => {
  it("baseline = start_cash + the book's adjustments", () => {
    expect(baselineOf(5000, adj, "a")).toBe(8000);
  });
  it("the halt adds only adjustments after the snapshot's day", () => {
    expect(adjustedSince(adj, "a", "2026-11-10")).toBe(-2000);
    expect(adjustedSince(adj, "a", "2026-10-31")).toBe(3000);
  });
  it("a Claude box without adjustments follows its saved budget; a Rules box its start_cash", () => {
    expect(sizeOf({ id: "c", key: "claude-free", start_cash: 5000, settings: { budget: 10000 } }, [])).toBe(10000);
    expect(sizeOf({ id: "c", key: "claude-free", start_cash: 5000, settings: {} }, [])).toBe(5000);
    expect(sizeOf({ id: "r", key: "free", start_cash: 7000, settings: { budget: 10000 } }, [])).toBe(7000);
    expect(sizeOf({ id: "a", key: "claude-free", start_cash: 5000, settings: { budget: 1 } }, adj)).toBe(8000);
  });
});
