import { describe, expect, it } from "vitest";
import { cleanSymbols, isFresh, marketOpenET, parseFinnhubQuote, ttlFor } from "./livequotes";

describe("marketOpenET", () => {
  it("is open mid-session on a weekday (EST)", () => {
    expect(marketOpenET(new Date("2026-11-11T15:00:00Z"))).toBe(true); // Wed 10:00 ET
  });
  it("opens at 9:30 and closes at 16:00 ET", () => {
    expect(marketOpenET(new Date("2026-11-11T14:29:00Z"))).toBe(false); // 9:29
    expect(marketOpenET(new Date("2026-11-11T14:30:00Z"))).toBe(true); // 9:30
    expect(marketOpenET(new Date("2026-11-11T20:59:00Z"))).toBe(true); // 15:59
    expect(marketOpenET(new Date("2026-11-11T21:00:00Z"))).toBe(false); // 16:00
  });
  it("follows daylight saving (EDT in summer)", () => {
    expect(marketOpenET(new Date("2026-07-15T13:30:00Z"))).toBe(true); // 9:30 EDT
    expect(marketOpenET(new Date("2026-07-15T13:29:00Z"))).toBe(false);
  });
  it("is closed at weekends", () => {
    expect(marketOpenET(new Date("2026-11-14T16:00:00Z"))).toBe(false); // Sat
    expect(marketOpenET(new Date("2026-11-15T16:00:00Z"))).toBe(false); // Sun
  });
});

describe("ttlFor", () => {
  it("is at least 30 s while open", () => {
    expect(ttlFor(1, true)).toBe(30);
    expect(ttlFor(22, true)).toBe(30);
  });
  it("grows so a big list stays under ~45 calls/min", () => {
    expect(ttlFor(45, true)).toBe(60);
    expect(ttlFor(80, true)).toBe(107);
    for (const n of [10, 40, 80]) expect((n * 60) / ttlFor(n, true)).toBeLessThanOrEqual(45);
  });
  it("is 15 min when closed", () => {
    expect(ttlFor(5, false)).toBe(900);
  });
});

describe("parseFinnhubQuote", () => {
  it("keeps the price fields", () => {
    expect(parseFinnhubQuote({ c: 190.5, pc: 188, dp: 1.33, d: 2.5, o: 189, h: 191, l: 187.5, t: 1 })).toEqual({
      c: 190.5,
      pc: 188,
      dp: 1.33,
      o: 189,
      h: 191,
      l: 187.5,
    });
  });
  it("treats Finnhub's all-zero answer for an unknown ticker as no price", () => {
    expect(parseFinnhubQuote({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 })).toBeNull();
  });
  it("rejects junk", () => {
    expect(parseFinnhubQuote(null)).toBeNull();
    expect(parseFinnhubQuote("x")).toBeNull();
    expect(parseFinnhubQuote({ c: "190" })).toBeNull();
  });
  it("nulls non-numeric side fields", () => {
    expect(parseFinnhubQuote({ c: 10, pc: null, dp: "x" })).toMatchObject({ c: 10, pc: null, dp: null });
  });
});

describe("cleanSymbols", () => {
  it("uppercases, dedupes, sorts and drops bad tickers", () => {
    expect(cleanSymbols([" nvda", "NVDA", "brk.b", "bad ticker", "", "AAPL"])).toEqual(["AAPL", "BRK.B", "NVDA"]);
  });
});

describe("isFresh", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  it("is fresh within the window", () => {
    expect(isFresh({ symbol: "A", c: 1, pc: 1, dp: 0, o: 1, h: 1, l: 1, fetched_at: "2026-11-11T14:59:00Z" }, 90, now)).toBe(true);
  });
  it("is stale past the window or without a fetch time", () => {
    expect(isFresh({ symbol: "A", c: 1, pc: 1, dp: 0, o: 1, h: 1, l: 1, fetched_at: "2026-11-11T14:58:00Z" }, 90, now)).toBe(false);
    expect(isFresh(undefined, 90, now)).toBe(false);
  });
});
