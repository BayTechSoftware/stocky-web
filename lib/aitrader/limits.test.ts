import { describe, expect, it } from "vitest";
import {
  CLAUDE_LIMITS,
  RULES_LIMITS,
  RUNNER_LIMITS,
  defsForBook,
  effective,
  rulesDefs,
  validateLimits,
} from "./limits";
import { RULES, anchorToFill, bracket, entryOrderBody, isStaleEntry, reservedCash, rulesFor, sizeQty } from "./plan";

const ok = (v: ReturnType<typeof validateLimits>) => {
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.settings;
};

describe("contract tables", () => {
  it("has every contract key with its default", () => {
    const keys = (defs: { key: string }[]) => defs.map((d) => d.key).sort();
    expect(keys(CLAUDE_LIMITS)).toEqual(
      [
        "budget", "max_loss_per_trade_usd", "max_daily_loss_usd", "max_trades_per_day", "max_orders_per_day",
        "max_order_usd", "max_position_pct", "cash_buffer_pct", "min_reward_risk", "no_entries_before",
        "no_entries_after", "flat_by", "blocked", "allow_reentry",
      ].sort()
    );
    expect(keys(RUNNER_LIMITS)).toEqual(
      [
        "model", "interval_min", "weekly_cap_usd", "throttle_pct", "throttle_interval_min", "run_timeout_s",
        "wake_min_gap_min", "news_wake", "news_scope", "news_tags", "premarket_time", "flatten_lead_min", "web_news",
      ].sort()
    );
    expect(keys(RULES_LIMITS)).toEqual(
      [
        "budget", "risk_pct", "max_position_pct", "cash_buffer_pct", "max_positions", "max_new_per_run",
        "daily_loss_halt_pct", "reward_risk", "atr_mult", "min_stop_pct", "max_stop_pct", "entry_slip_pct",
        "entry_valid_days", "min_price", "min_score", "enter_on_watch", "exit_on_overbought", "max_hold_days",
        "max_rsi", "uptrend_only", "universe_add", "universe_remove",
      ].sort()
    );
  });

  it("splits rules fields by box and resolves per-box defaults", () => {
    const my = rulesDefs("mylist").map((d) => d.key);
    const fr = rulesDefs("free").map((d) => d.key);
    expect(my).toContain("min_score");
    expect(my).toContain("enter_on_watch");
    expect(my).not.toContain("max_rsi");
    expect(fr).toContain("universe_add");
    expect(fr).not.toContain("exit_on_overbought");
    expect(effective(rulesDefs("mylist"), {}).max_hold_days).toBe(0);
    expect(effective(rulesDefs("free"), {}).max_hold_days).toBe(21);
    expect(defsForBook("claude-free")).toBe(CLAUDE_LIMITS);
  });
});

describe("validateLimits", () => {
  it("number: clamps to bounds, rounds ints, drops unknown keys", () => {
    expect(ok(validateLimits(RULES_LIMITS, { risk_pct: "999", max_positions: "0", evil: "x" }))).toEqual({
      risk_pct: 100,
      max_positions: 1,
    });
    expect(ok(validateLimits(RULES_LIMITS, { max_positions: "4.6", budget: "50" }))).toEqual({ max_positions: 5, budget: 100 });
    expect(ok(validateLimits(RULES_LIMITS, { daily_loss_halt_pct: "0", reward_risk: "0" }))).toEqual({
      daily_loss_halt_pct: 0,
      reward_risk: 0,
    });
    expect(validateLimits(RUNNER_LIMITS, { interval_min: "soon" }).ok).toBe(false);
  });

  it("min_stop_pct must be ≤ max_stop_pct", () => {
    expect(validateLimits(RULES_LIMITS, { min_stop_pct: 15 }).ok).toBe(false); // vs default max 12
    expect(validateLimits(RULES_LIMITS, { min_stop_pct: 5, max_stop_pct: 4 }).ok).toBe(false);
    expect(ok(validateLimits(RULES_LIMITS, { min_stop_pct: 5, max_stop_pct: 5 }))).toEqual({ min_stop_pct: 5, max_stop_pct: 5 });
  });

  it("time: inside the window, ordered, off only where allowed", () => {
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_before: "09:00" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_before: "15:40" }).ok).toBe(false); // after 15:30 default
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_after: "15:58" }).ok).toBe(false); // after flat_by 15:55
    expect(ok(validateLimits(CLAUDE_LIMITS, { no_entries_before: "10:00", no_entries_after: "15:00", flat_by: "15:50" }))).toEqual({
      no_entries_before: "10:00",
      no_entries_after: "15:00",
      flat_by: "15:50",
    });
    // off skips ordering: with no_entries_after off, before only has to precede flat_by
    expect(ok(validateLimits(CLAUDE_LIMITS, { no_entries_after: "off", no_entries_before: "15:40" }))).toEqual({
      no_entries_after: "",
      no_entries_before: "15:40",
    });
    expect(validateLimits(CLAUDE_LIMITS, { no_entries_after: "off", no_entries_before: "15:58" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { flat_by: "off" }).ok).toBe(false); // required
    // premarket has its own window
    expect(ok(validateLimits(RUNNER_LIMITS, { premarket_time: "08:00" }))).toEqual({ premarket_time: "08:00" });
    expect(validateLimits(RUNNER_LIMITS, { premarket_time: "09:45" }).ok).toBe(false);
    expect(ok(validateLimits(RUNNER_LIMITS, { premarket_time: "off" }))).toEqual({ premarket_time: "" });
  });

  it("bool: true/false/on/off, rejects junk", () => {
    expect(ok(validateLimits(CLAUDE_LIMITS, { allow_reentry: "true" }))).toEqual({ allow_reentry: true });
    expect(ok(validateLimits(RUNNER_LIMITS, { news_wake: "false", web_news: false }))).toEqual({ news_wake: false, web_news: false });
    expect(validateLimits(CLAUDE_LIMITS, { allow_reentry: "maybe" }).ok).toBe(false);
  });

  it("symbols: uppercase, dedupe, validate, cap", () => {
    expect(ok(validateLimits(CLAUDE_LIMITS, { blocked: " tsla, brk.b,TSLA  gme " }))).toEqual({ blocked: "TSLA,BRK.B,GME" });
    expect(validateLimits(CLAUDE_LIMITS, { blocked: "AAPL, $$$" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { blocked: "TOOLONGTICKER1" }).ok).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => `S${i}`).join(",");
    expect(validateLimits(RULES_LIMITS, { universe_add: many }).ok).toBe(false);
    expect(ok(validateLimits(RULES_LIMITS, { universe_add: "" }))).toEqual({});
  });

  it("tags: lowercase list", () => {
    expect(ok(validateLimits(RUNNER_LIMITS, { news_tags: "Earnings, deal,deal" }))).toEqual({ news_tags: "earnings,deal" });
    expect(validateLimits(RUNNER_LIMITS, { news_tags: "earn-ings" }).ok).toBe(false);
  });

  it("select: only listed options", () => {
    expect(ok(validateLimits(RUNNER_LIMITS, { model: "opus", news_scope: "held" }))).toEqual({ model: "opus", news_scope: "held" });
    expect(validateLimits(RUNNER_LIMITS, { model: "gpt" }).ok).toBe(false);
  });

  it("empty input resets to defaults", () => {
    expect(validateLimits(CLAUDE_LIMITS, {})).toEqual({ ok: true, settings: {} });
    expect(effective(CLAUDE_LIMITS, {}).max_trades_per_day).toBe(3);
    expect(effective(RUNNER_LIMITS, {}).model).toBe("sonnet");
    expect(effective(CLAUDE_LIMITS, { no_entries_after: "" }).no_entries_after).toBe(""); // stored off stays off
  });
});

describe("rulesFor", () => {
  it("defaults when nothing is saved", () => {
    expect(rulesFor({})).toEqual(RULES);
    expect(rulesFor(null)).toEqual(RULES);
    expect(RULES).toMatchObject({
      budget: 5000, riskPct: 0.01, maxPositionPct: 0.2, cashBufferPct: 0.1, maxPositions: 5, maxNewPerRun: 3,
      dailyLossHaltPct: 0.03, rewardRisk: 2, atrMult: 2, minStopPct: 0.03, maxStopPct: 0.12, entrySlipPct: 0.01,
      entryValidDays: 1, staleEntryHours: 20, minPrice: 10, minScore: 60, enterOnWatch: false, exitOnOverbought: true,
      maxHoldDays: 21, maxRsi: 75, uptrendOnly: true, universeAdd: [], universeRemove: [],
    });
    expect(rulesFor({}, "mylist").maxHoldDays).toBe(0);
  });

  it("maps every rules key", () => {
    const free = rulesFor(
      {
        budget: 20000, risk_pct: 2, max_position_pct: 50, cash_buffer_pct: 0, max_positions: 8, max_new_per_run: 4,
        daily_loss_halt_pct: 0, reward_risk: 0, atr_mult: 3, min_stop_pct: 2, max_stop_pct: 20, entry_slip_pct: 0.5,
        entry_valid_days: 3, min_price: 5, max_hold_days: 0, max_rsi: 90, uptrend_only: false,
        universe_add: "PLTR,SMCI", universe_remove: "TSLA",
        min_score: 99, // mylist-only: ignored for free
      },
      "free"
    );
    expect(free).toMatchObject({
      budget: 20000, riskPct: 0.02, maxPositionPct: 0.5, cashBufferPct: 0, maxPositions: 8, maxNewPerRun: 4,
      dailyLossHaltPct: 0, rewardRisk: 0, atrMult: 3, minStopPct: 0.02, maxStopPct: 0.2, entrySlipPct: 0.005,
      entryValidDays: 3, staleEntryHours: 68, minPrice: 5, maxHoldDays: 0, maxRsi: 90, uptrendOnly: false,
      universeAdd: ["PLTR", "SMCI"], universeRemove: ["TSLA"], minScore: 60,
    });
    const my = rulesFor({ min_score: 70, enter_on_watch: true, exit_on_overbought: false, max_hold_days: 10, max_rsi: 10 }, "mylist");
    expect(my).toMatchObject({ minScore: 70, enterOnWatch: true, exitOnOverbought: false, maxHoldDays: 10, maxRsi: 75 });
  });

  it("changes sizing, stops and targets", () => {
    const R = rulesFor({ risk_pct: 2, reward_risk: 3, max_position_pct: 100, atr_mult: 1, entry_slip_pct: 0 });
    const br = bracket(100, 5, R); // 1×ATR = 5% (inside 3–12%)
    expect(br.limit).toBe(100);
    expect(br.stop).toBe(95);
    expect(br.target).toBeCloseTo(br.limit + 3 * br.riskPerShare, 2);
    const base = sizeQty({ equity: 5000, available: 5000, price: br.limit, riskPerShare: br.riskPerShare });
    const more = sizeQty({ equity: 5000, available: 5000, price: br.limit, riskPerShare: br.riskPerShare }, R);
    expect(more.qty).toBeGreaterThan(base.qty);
    const wide = rulesFor({ min_stop_pct: 10, max_stop_pct: 10 });
    expect(bracket(100, 1, wide).stop).toBe(90);
  });
});

describe("orders", () => {
  it("reward_risk 0 → OTO with only a stop", () => {
    const R = rulesFor({ reward_risk: 0 });
    const br = bracket(100, 2, R);
    expect(br.target).toBeNull();
    const body = entryOrderBody("XOM", 7, br, "stk-free-e-XOM-1");
    expect(body).toEqual({
      symbol: "XOM", qty: "7", side: "buy", type: "limit", limit_price: "101.00", time_in_force: "gtc",
      order_class: "oto", stop_loss: { stop_price: "96.00" }, client_order_id: "stk-free-e-XOM-1",
    });
    expect(body).not.toHaveProperty("take_profit");
  });

  it("reward_risk > 0 → bracket with both legs", () => {
    const body = entryOrderBody("XOM", 7, bracket(100, 2), "c");
    expect(body.order_class).toBe("bracket");
    expect(body.take_profit).toEqual({ limit_price: "111.00" });
    expect(body.stop_loss).toEqual({ stop_price: "96.00" });
  });

  it("re-anchors stop and target to the fill price", () => {
    // planned from ref 100: limit 101, stop 96 (4%), target 111
    const a = anchorToFill(98, 2, RULES); // 2×ATR = 4 → stop 94, risk 4 → target 106
    expect(a).toEqual({ stop: 94, target: 106 });
    expect(anchorToFill(98, 0.1, RULES).stop).toBe(95.06); // min 3% of the fill
    expect(anchorToFill(98, 2, rulesFor({ reward_risk: 0 })).target).toBeNull();
  });

  it("reserves cash only for the unfilled remainder of working entries", () => {
    expect(
      reservedCash([
        { qty: 10, filled_qty: 0, limit_price: 50 },
        { qty: 10, filled_qty: 4, limit_price: 100 }, // partial: 6 left
        { qty: 5, filled_qty: 5, limit_price: 20 },
      ])
    ).toBe(500 + 600);
  });

  it("an entry goes stale after entry_valid_days × 24 − 4 hours", () => {
    const now = new Date("2026-11-10T22:30:00Z");
    expect(isStaleEntry("2026-11-09T22:30:00Z", now, RULES)).toBe(true); // 24h > 20h
    expect(isStaleEntry("2026-11-10T14:00:00Z", now, RULES)).toBe(false);
    expect(isStaleEntry("2026-11-09T22:30:00Z", now, rulesFor({ entry_valid_days: 2 }))).toBe(false); // 44h window
  });
});
