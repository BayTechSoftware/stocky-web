import { describe, expect, it } from "vitest";
import { CLAUDE_LIMITS, defsForBook, effective, validateLimits } from "./limits";
import { PRESETS, matchPreset, presetKeys, presetValues } from "./presets";
import { isShown, sectionOf, SECTIONS } from "./layout";

describe("presets", () => {
  for (const key of ["mylist", "free", "claude-mylist", "claude-free"]) {
    const claude = key.startsWith("claude-");
    const defs = defsForBook(key);
    it(`${key}: Balanced is exactly the defaults`, () => {
      const v = presetValues(defs, "balanced", claude);
      for (const [k, val] of Object.entries(v)) expect(val, k).toEqual(defs.find((d) => d.key === k)!.def);
      expect(matchPreset(defs, claude, (d, x) => x === d.def)).toBe("balanced");
    });
    it(`${key}: every preset validates, stays in bounds, never turns on shorting or margin`, () => {
      for (const p of PRESETS) {
        const v = presetValues(defs, p.id, claude);
        for (const k of ["allow_short", "allow_margin", "margin_multiplier", "budget"]) expect(k in v, `${p.id} ${k}`).toBe(false);
        const r = validateLimits(defs, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])));
        expect(r.ok, p.id).toBe(true);
        if (r.ok) expect(r.settings).toEqual(v);
      }
    });
  }

  it("has the agreed values", () => {
    const c = presetValues(CLAUDE_LIMITS, "roomier", true);
    expect(c).toMatchObject({ max_trades_per_day: 6, max_daily_loss_usd: 250, max_orders_per_day: 30, no_entries_before: "09:35", no_entries_after: "15:45", allow_reentry: true, breakeven_at_r: 1.5 });
    expect(presetValues(defsForBook("free"), "roomier", false)).toEqual({ risk_pct: 1, max_position_pct: 30, max_positions: 8 });
    expect(presetValues(defsForBook("free"), "cautious", false)).toEqual({ risk_pct: 0.5, max_position_pct: 15, max_positions: 4 });
    expect(presetValues(CLAUDE_LIMITS, "cautious", true)).toMatchObject({ max_loss_per_trade_usd: 25, max_daily_loss_usd: 75, max_trades_per_day: 2, no_entries_before: "10:00", no_entries_after: "15:00", allow_reentry: false });
    expect(presetKeys(CLAUDE_LIMITS, true)).not.toContain("allow_short");
  });
});

describe("new Claude keys", () => {
  it("have the agreed defaults", () => {
    const e = effective(CLAUDE_LIMITS, {});
    expect([e.market_read, e.flatten_backup, e.entry_orders, e.bear_fail_closed, e.min_stop_atr, e.max_breakout_age_min, e.lesson_min_trades]).toEqual([
      true, true, "all", false, 0, 0, 0,
    ]);
  });
});

describe("settings layout", () => {
  it("puts every field in one of the eight sections", () => {
    for (const key of ["mylist", "free", "claude-free"]) {
      for (const d of defsForBook(key)) expect(SECTIONS, d.key).toContain(sectionOf(d));
    }
  });
  it("hides child fields while the parent is off", () => {
    const d = (k: string) => CLAUDE_LIMITS.find((x) => x.key === k)!;
    expect(isShown(d("margin_multiplier"), { allow_margin: "false" })).toBe(false);
    expect(isShown(d("margin_multiplier"), { allow_margin: "true" })).toBe(true);
    expect(isShown(d("bear_block_conf"), { bear_mode: "warn" })).toBe(false);
    expect(isShown(d("trail_pct"), { trail_mode: "atr" })).toBe(false);
    expect(isShown(d("trail_atr_mult"), { trail_mode: "atr" })).toBe(true);
    expect(isShown(d("sentiment"), {})).toBe(false);
  });
});
