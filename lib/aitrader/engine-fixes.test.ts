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
