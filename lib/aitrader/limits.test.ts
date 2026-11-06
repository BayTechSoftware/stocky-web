import { describe, expect, it } from "vitest";
import { CLAUDE_LIMITS, RULES_LIMITS, RUNNER_LIMITS, effective, validateLimits } from "./limits";
import { RULES, bracket, rulesFor, sizeQty } from "./plan";

describe("validateLimits", () => {
  it("clamps numbers to bounds and drops unknown keys", () => {
    const v = validateLimits(RULES_LIMITS, { risk_pct: "99", max_positions: "0", evil: "x" });
    expect(v).toEqual({ ok: true, settings: { risk_pct: 5, max_positions: 1 } });
  });

  it("rejects non-numbers", () => {
    const v = validateLimits(RUNNER_LIMITS, { interval_min: "soon" });
    expect(v.ok).toBe(false);
  });

  it("checks times are inside the session and ordered", () => {
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_before: "09:00" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_before: "15:40" }).ok).toBe(false); // after 15:30 default
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_after: "15:58" }).ok).toBe(false); // after flat_by 15:55
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_before: "10:00", no_entries_after: "15:00", flat_by: "15:50" })).toEqual({
      ok: true,
      settings: { no_entries_before: "10:00", no_entries_after: "15:00", flat_by: "15:50" },
    });
  });

  it("empty input resets to defaults", () => {
    expect(validateLimits(CLAUDE_LIMITS, {})).toEqual({ ok: true, settings: {} });
    expect(effective(CLAUDE_LIMITS, {}).max_trades_per_day).toBe(3);
  });
});

describe("rulesFor", () => {
  it("defaults when nothing is saved", () => {
    expect(rulesFor({})).toEqual(RULES);
    expect(rulesFor(null)).toEqual(RULES);
  });

  it("maps percent settings to fractions", () => {
    const R = rulesFor({ risk_pct: 2, max_position_pct: 50, cash_buffer_pct: 0, daily_loss_halt_pct: 5, min_score: 70, max_hold_days: 10 });
    expect(R.riskPct).toBe(0.02);
    expect(R.maxPositionPct).toBe(0.5);
    expect(R.cashBufferPct).toBe(0);
    expect(R.dailyLossHaltPct).toBe(0.05);
    expect(R.minScore).toBe(70);
    expect(R.freeMaxHoldDays).toBe(10);
  });

  it("changes sizing and targets", () => {
    const R = rulesFor({ risk_pct: 2, reward_risk: 3, max_position_pct: 100 });
    const br = bracket(100, 2, R);
    expect(br.target).toBeCloseTo(br.limit + 3 * br.riskPerShare, 2);
    const base = sizeQty({ equity: 5000, available: 5000, price: br.limit, riskPerShare: br.riskPerShare });
    const more = sizeQty({ equity: 5000, available: 5000, price: br.limit, riskPerShare: br.riskPerShare }, R);
    expect(more.qty).toBeGreaterThan(base.qty);
  });
});
