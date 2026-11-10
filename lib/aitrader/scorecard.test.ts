import { describe, expect, it } from "vitest";
import { gateCounts, gateTone, scoreBand, scoreOf, scorecardOf } from "./scorecard";
import type { Decision } from "./engine";

const base: Decision = { symbol: "ACME", action: "buy", reason: "r" };

describe("decision scorecards", () => {
  it("old decisions have no score and no card", () => {
    expect(scoreOf(base)).toBeNull();
    expect(scorecardOf(base)).toBeNull();
    expect(scorecardOf({ ...base, scorecard: [] as never })).toBeNull();
    expect(scorecardOf({ ...base, scorecard: {} })).toBeNull();
  });

  it("reads the score from the decision or its card, clamped", () => {
    expect(scoreOf({ ...base, score: 72.4 })).toBe(72);
    expect(scoreOf({ ...base, score: 140 })).toBe(100);
    expect(scoreOf({ ...base, scorecard: { score: 55 } })).toBe(55);
    expect(scoreOf({ ...base, score: "high" as never })).toBeNull();
  });

  it("gate tones follow status and the owner's mode", () => {
    expect(gateTone({ k: "rvol", s: "pass", m: "warn" })).toBe("pass");
    expect(gateTone({ k: "rvol", s: "fail", m: "warn" })).toBe("warn");
    expect(gateTone({ k: "rvol", s: "fail", m: "block" })).toBe("block");
    expect(gateTone({ k: "rvol", s: "fail", m: "off" })).toBe("fail-off");
    expect(gateTone({ k: "rvol", s: "na", m: "block" })).toBe("na");
  });

  it("counts gates, and falls back to Claude's own lists", () => {
    const card = scorecardOf({
      ...base,
      score: 61,
      scorecard: {
        gates: [
          { k: "tradability", s: "pass", m: "block" },
          { k: "rvol", s: "fail", m: "warn" },
          { k: "trend", s: "fail", m: "block" },
          { k: "sector", s: "na", m: "warn" },
          { bogus: 1 } as never,
        ],
      },
    })!;
    expect(card.gates).toHaveLength(4);
    expect(gateCounts(card)).toBe("1 pass · 1 warn · 1 block");
    const hand = scorecardOf({ ...base, scorecard: { support: ["trend"], warned: ["rvol"] } })!;
    expect(gateCounts(hand)).toBe("supports: trend · warns: rvol");
  });

  it("bands", () => {
    expect([scoreBand(80), scoreBand(55), scoreBand(10), scoreBand(null)]).toEqual(["high", "mid", "low", "none"]);
  });
});
