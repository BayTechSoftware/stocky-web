import { describe, expect, it } from "vitest";
import { CLAUDE_LIMITS, RUNNER_LIMITS, clampSaved, overridesOnly, rulesDefs, validateLimits } from "./limits";
import { rulesFor } from "./plan";

describe("saving only overrides (fix #10)", () => {
  it("drops values equal to their defaults", () => {
    const defs = rulesDefs("free");
    const v = validateLimits(defs, { budget: "5000", risk_pct: "1", max_positions: "7", uptrend_only: "on" });
    expect(v.ok && overridesOnly(defs, v.settings)).toEqual({ max_positions: 7 });
  });
  it("keeps an off time (\"\") that differs from the default", () => {
    const v = validateLimits(CLAUDE_LIMITS, { flat_by: "off" });
    expect(v.ok && overridesOnly(CLAUDE_LIMITS, v.settings)).toEqual({ flat_by: "" });
  });
});

describe("validateLimits cross-checks (fix #10)", () => {
  it("max_position_pct > 100 needs allow_margin", () => {
    expect(validateLimits(CLAUDE_LIMITS, { max_position_pct: 150 }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { max_position_pct: 150, allow_margin: true }).ok).toBe(true);
  });
  it("throttle interval can't be below the normal interval", () => {
    expect(validateLimits(RUNNER_LIMITS, { interval_min: 30, throttle_interval_min: 20 }).ok).toBe(false);
    expect(validateLimits(RUNNER_LIMITS, { interval_min: 30, throttle_interval_min: 30 }).ok).toBe(true);
  });
  it("the early look can't be after the pre-market scan", () => {
    expect(validateLimits(RUNNER_LIMITS, { premarket_early: "09:20", premarket_time: "09:15" }).ok).toBe(false);
    expect(validateLimits(RUNNER_LIMITS, { premarket_early: "off", premarket_time: "09:15" }).ok).toBe(true);
  });
});

describe("the engine re-clamps saved values (fix #10)", () => {
  it("clamps out-of-bounds and ignores unreadable values", () => {
    expect(clampSaved(rulesDefs("free"), { risk_pct: 500, max_positions: 2.6, atr_mult: "x" })).toEqual({ risk_pct: 100, max_positions: 3 });
    const R = rulesFor({ max_positions: -4, entry_valid_days: 0.2, min_stop_pct: 10, max_stop_pct: 5 }, "free");
    expect(R.maxPositions).toBe(1);
    expect(R.entryValidDays).toBe(1);
    expect(R.maxStopPct).toBeGreaterThanOrEqual(R.minStopPct);
  });
});
