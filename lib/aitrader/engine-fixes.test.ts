import { describe, expect, it } from "vitest";
import { mylistCandidates } from "./decide";
import { rulesFor } from "./plan";
import { lastTry } from "../refresh";

describe("stale signals (fix #3)", () => {
  const R = rulesFor({}, "mylist"); // max_signal_age_days 3
  const sig = (updated_at: string | null) => ({ assessment: "BUY", score: 80, updated_at });

  it("a signal with no update time counts as stale", () => {
    const r = mylistCandidates(["AAA", "BBB"], (s) => (s === "AAA" ? sig(null) : sig("2026-11-10T22:00:00Z")), R, "2026-11-11");
    expect(r.list.map((c) => c.symbol)).toEqual(["BBB"]);
    expect(r.stale).toEqual([{ symbol: "AAA", days: null }]);
  });

  it("with the age check off, a missing time is still traded", () => {
    const off = rulesFor({ max_signal_age_days: 0 }, "mylist");
    expect(mylistCandidates(["AAA"], () => sig(null), off, "2026-11-11").list.length).toBe(1);
  });

  it("the rotation queue orders by the later of attempt and signal", () => {
    expect(lastTry({ updated_at: "2026-11-01T00:00:00Z", attempted_at: "2026-11-10T00:00:00Z" })).toBe("2026-11-10T00:00:00Z");
    expect(lastTry({ updated_at: "2026-11-01T00:00:00Z", attempted_at: null })).toBe("2026-11-01T00:00:00Z");
    expect(lastTry({ updated_at: null })).toBe("");
  });
});

import { gapDownReason, planEntry } from "./decide";
import { dailyBars } from "./fakes";

describe("max_gap_down_pct and min_atr_pct (fix #13)", () => {
  const cand = { symbol: "QYLD", setups: [], score: 80, ret20: 0, rsi: null, reason: "test" };
  it("both default to off", () => {
    const R = rulesFor({}, "free");
    expect(R.maxGapDownPct).toBe(0);
    expect(R.minAtrPct).toBe(0);
    expect(gapDownReason(50, 100, R)).toBeUndefined();
  });
  it("min_atr_pct skips a stock that barely moves", () => {
    const bars = dailyBars(80, 100).map((b) => ({ ...b, h: b.c * 1.001, l: b.c * 0.999 }));
    expect(planEntry(cand, bars, 100, rulesFor({ min_atr_pct: 1 }, "free"), 5000, 5000)).toMatchObject({ ok: false, reason: expect.stringMatching(/moves too little/) });
    expect(planEntry(cand, bars, 100, rulesFor({}, "free"), 5000, 5000).ok).toBe(true);
  });
  it("max_gap_down_pct skips an entry after a gap-down session", () => {
    const bars = dailyBars(80, 100);
    bars[bars.length - 1] = { ...bars[bars.length - 1], o: 90 }; // opened 10% under the prior close
    const R = rulesFor({ max_gap_down_pct: 5 }, "free");
    expect(gapDownReason(90, 100, R)).toMatch(/gapped down 10.0%/);
    expect(planEntry(cand, bars, 100, R, 5000, 5000)).toMatchObject({ ok: false, reason: expect.stringMatching(/gapped down/) });
  });
});
