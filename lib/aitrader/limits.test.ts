import { describe, expect, it } from "vitest";
import {
  CHECK_LIMITS,
  CLAUDE_LIMITS,
  EXIT_LIMITS,
  SCORECARD_GATES,
  SCORECARD_WEIGHTS,
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
        "no_entries_after", "flat_by", "blocked", "allow_reentry", "fractional", "allow_margin", "allow_short",
        "min_order_usd", "or_minutes", "margin_multiplier", "pdt_guard", "min_stop_pct", "allow_loosen_stop",
        "scorecard", "min_score", "max_spread_pct", "min_avg_dollar_vol", "min_rvol", "earnings_window_days",
        "max_vwap_atr", "max_adr_used", "extension_penalty",
        ...SCORECARD_GATES.map((g) => `gate_${g}`),
        ...Object.keys(SCORECARD_WEIGHTS).map((k) => `w_${k}`),
        "bear_mode", "bear_block_conf", "bear_model", "memory_trades", "sentiment", "w_sentiment",
        "breakeven_at_r", "trail_mode", "trail_start_r", "trail_atr_mult", "trail_pct", "partial_pct", "partial_r",
        "time_stop_min", "time_stop_min_r", "time_stop_mode", "market_turn_mode", "market_turn_pct", "review", "review_model",
        "use_lessons", "lessons_count", "shadow_review",
        "market_read", "flatten_backup", "entry_orders", "bear_fail_closed", "min_stop_atr", "max_breakout_age_min",
        "lesson_min_trades",
      ].sort()
    );
    expect(keys(RUNNER_LIMITS)).toEqual(
      [
        "model", "interval_min", "weekly_cap_usd", "throttle_pct", "throttle_interval_min", "run_timeout_s",
        "wake_min_gap_min", "news_wake", "news_scope", "news_tags", "premarket_early", "premarket_time", "flatten_lead_min", "web_news",
      ].sort()
    );
    expect(keys(RULES_LIMITS)).toEqual(
      [
        "budget", "risk_pct", "max_position_pct", "cash_buffer_pct", "max_positions", "max_new_per_run",
        "daily_loss_halt_pct", "reward_risk", "atr_mult", "min_stop_pct", "max_stop_pct", "entry_slip_pct",
        "entry_valid_days", "min_price", "min_score", "max_signal_age_days", "enter_on_watch", "exit_on_overbought", "max_hold_days",
        "max_rsi", "uptrend_only", "universe_add", "universe_remove", "midday_entries", "reentry_cooldown_days", "max_gap_down_pct", "min_atr_pct",
      ].sort()
    );
  });

  it("every whole-number field's default and minimum are whole, so the browser accepts them", () => {
    for (const d of [...CLAUDE_LIMITS, ...RULES_LIMITS, ...RUNNER_LIMITS]) {
      if (d.kind !== "number" || !d.int) continue;
      expect(Number.isInteger(d.def), d.key).toBe(true);
      expect(Number.isInteger(d.min ?? 0), d.key).toBe(true);
    }
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
    expect(ok(validateLimits(CLAUDE_LIMITS, { flat_by: "off" }))).toEqual({ flat_by: "" }); // off = may hold overnight
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
      budget: 5000, riskPct: 0.01, maxPositionPct: 0.2, cashBufferPct: 0, maxPositions: 5, maxNewPerRun: 3,
      dailyLossHaltPct: 0.03, rewardRisk: 2, atrMult: 2, minStopPct: 0.03, maxStopPct: 0.12, entrySlipPct: 0.01,
      entryValidDays: 1, minPrice: 10, minScore: 60, enterOnWatch: false, exitOnOverbought: true,
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
      entryValidDays: 3, minPrice: 5, maxHoldDays: 0, maxRsi: 90, uptrendOnly: false,
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

  it("an entry goes stale after entry_valid_days trading sessions", () => {
    const now = new Date("2026-11-10T22:30:00Z"); // Tue evening
    expect(isStaleEntry("2026-11-09T22:30:00Z", now, RULES)).toBe(true); // Mon-evening entry had Tue's session
    expect(isStaleEntry("2026-11-10T14:00:00Z", now, RULES)).toBe(true); // 09:00 NY, before Tue's open: had all of Tue
    expect(isStaleEntry("2026-11-10T16:00:00Z", now, RULES)).toBe(false); // placed mid-session: Tue doesn't count
    expect(isStaleEntry("2026-11-09T22:30:00Z", now, rulesFor({ entry_valid_days: 2 }))).toBe(false);
  });

  it("a Friday-evening entry survives Monday's midday run and goes at Monday's evening run", () => {
    const fri = "2026-11-06T22:30:00Z";
    expect(isStaleEntry(fri, new Date("2026-11-09T15:00:00Z"), RULES)).toBe(false); // Mon midday
    expect(isStaleEntry(fri, new Date("2026-11-09T22:30:00Z"), RULES)).toBe(true); // Mon evening
    expect(isStaleEntry(fri, new Date("2026-11-09T22:30:00Z"), rulesFor({ entry_valid_days: 2 }))).toBe(false);
  });

  it("holidays from the calendar don't count", () => {
    const fri = "2026-11-06T22:30:00Z";
    const tue = { date: "2026-11-10", open: "2026-11-10T14:30:00.000Z", close: "2026-11-10T21:00:00.000Z" };
    // Monday is a holiday in this calendar: only Tuesday counts.
    expect(isStaleEntry(fri, new Date("2026-11-09T22:30:00Z"), RULES, [tue])).toBe(false);
    expect(isStaleEntry(fri, new Date("2026-11-10T22:30:00Z"), RULES, [tue])).toBe(true);
  });
});

describe("scorecard settings", () => {
  it("has 12 gates (tradability blocks by default) and weights that sum to 100", () => {
    expect(SCORECARD_GATES).toHaveLength(12);
    const gate = (g: string) => CLAUDE_LIMITS.find((d) => d.key === `gate_${g}`)!;
    expect(gate("tradability").def).toBe("block");
    for (const g of SCORECARD_GATES) if (g !== "tradability") expect(gate(g).def).toBe("warn");
    expect(Object.values(SCORECARD_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const e = effective(CLAUDE_LIMITS, {});
    expect([e.scorecard, e.min_score, e.max_spread_pct, e.min_avg_dollar_vol, e.min_rvol, e.earnings_window_days]).toEqual([
      true, 0, 0.5, 5_000_000, 1, 1,
    ]);
    expect([e.max_vwap_atr, e.max_adr_used, e.extension_penalty, e.gate_extension]).toEqual([1.5, 2, 15, "warn"]);
  });

  it("validates modes, clamps weights and thresholds", () => {
    const v = ok(
      validateLimits(CLAUDE_LIMITS, {
        gate_rvol: "block", w_rsi: "250", min_score: "-5", max_spread_pct: "0.2", scorecard: "false",
        earnings_window_days: "2.6",
      })
    );
    expect(v).toMatchObject({ gate_rvol: "block", w_rsi: 100, min_score: 0, max_spread_pct: 0.2, scorecard: false, earnings_window_days: 3 });
    const bad = validateLimits(CLAUDE_LIMITS, { gate_trend: "maybe" });
    expect(bad.ok).toBe(false);
  });
});

describe("exit settings", () => {
  it("has the contract's defaults (docs/SETTINGS_CONTRACT.md, Exits)", () => {
    const d = Object.fromEntries(EXIT_LIMITS.map((x) => [x.key, x.def]));
    expect(d).toEqual({
      breakeven_at_r: 1, trail_mode: "atr", trail_start_r: 1, trail_atr_mult: 2, trail_pct: 1, partial_pct: 0, partial_r: 1,
      time_stop_min: 120, time_stop_min_r: 0.3, time_stop_mode: "wake", market_turn_mode: "wake", market_turn_pct: 0.5,
      review: true, shadow_review: true, review_model: "haiku", use_lessons: true, lessons_count: 8,
    });
    expect(EXIT_LIMITS.every((x) => x.group === "Exits")).toBe(true);
    expect(defsForBook("claude-free").filter((x) => x.group === "Exits")).toHaveLength(EXIT_LIMITS.length);
    expect(defsForBook("free").some((x) => x.group === "Exits")).toBe(false);
  });

  it("validates and clamps like the Mac", () => {
    const v = ok(
      validateLimits(CLAUDE_LIMITS, {
        partial_pct: "250", trail_mode: "pct", time_stop_min: "90.6", time_stop_mode: "exit", review: "off", review_model: "sonnet",
        breakeven_at_r: "-1",
      })
    );
    expect(v).toMatchObject({ partial_pct: 100, trail_mode: "pct", time_stop_min: 91, time_stop_mode: "exit", review: false, review_model: "sonnet", breakeven_at_r: 0 });
    const bad = validateLimits(CLAUDE_LIMITS, { trail_mode: "wild", market_turn_mode: "panic" });
    expect(bad.ok).toBe(false);
    expect(effective(CLAUDE_LIMITS, {}).trail_mode).toBe("atr");
  });
});

describe("check settings (bear case, trade memory, sentiment)", () => {
  it("has the contract's defaults and bounds (docs/SETTINGS_CONTRACT.md, Checks)", () => {
    expect(Object.fromEntries(CHECK_LIMITS.map((x) => [x.key, x.def]))).toEqual({
      bear_mode: "warn", bear_block_conf: 70, bear_model: "haiku", memory_trades: 5, sentiment: "off", w_sentiment: 10,
    });
    const d = (k: string) => CLAUDE_LIMITS.find((x) => x.key === k)!;
    expect(d("bear_mode").options).toEqual(["off", "warn", "block"]);
    expect(d("bear_model").options).toEqual(["haiku", "sonnet", "opus"]);
    expect(d("sentiment").options).toEqual(["off", "stocktwits"]);
    expect([d("bear_block_conf").min, d("bear_block_conf").max, d("bear_block_conf").int]).toEqual([0, 100, true]);
    expect([d("memory_trades").min, d("memory_trades").max, d("memory_trades").int]).toEqual([0, 20, true]);
    expect([d("w_sentiment").min, d("w_sentiment").max, d("w_sentiment").kind]).toEqual([0, 100, "number"]);
    expect(d("shadow_review")).toMatchObject({ kind: "bool", def: true, group: "Exits" });
  });

  it("Claude boxes only; the Checks group sits right after the scorecard groups", () => {
    expect(defsForBook("mylist").some((x) => x.group === "Checks" || x.key === "shadow_review")).toBe(false);
    expect(defsForBook("free").some((x) => x.group === "Checks")).toBe(false);
    const groups = Array.from(new Set(CLAUDE_LIMITS.map((x) => x.group)));
    expect(groups.indexOf("Checks")).toBe(groups.indexOf("Scorecard weights") + 1);
    // unique keys across the whole Claude table
    expect(new Set(CLAUDE_LIMITS.map((x) => x.key)).size).toBe(CLAUDE_LIMITS.length);
  });

  it("leaves the scorecard weights (sum 100) and their defaults alone", () => {
    expect(SCORECARD_WEIGHTS.sentiment).toBeUndefined();
    expect(Object.values(SCORECARD_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const e = effective(CLAUDE_LIMITS, {});
    for (const [k, w] of Object.entries(SCORECARD_WEIGHTS)) expect(e[`w_${k}`], k).toBe(w);
    expect(e.w_sentiment).toBe(10);
  });

  it("validates and clamps", () => {
    const v = ok(
      validateLimits(CLAUDE_LIMITS, {
        bear_mode: "block", bear_block_conf: "150", bear_model: "opus", memory_trades: "3.4", sentiment: "stocktwits",
        w_sentiment: "-3", shadow_review: "off",
      })
    );
    expect(v).toEqual({
      bear_mode: "block", bear_block_conf: 100, bear_model: "opus", memory_trades: 3, sentiment: "stocktwits", w_sentiment: 0,
      shadow_review: false,
    });
    expect(validateLimits(CLAUDE_LIMITS, { bear_mode: "maybe" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { sentiment: "reddit" }).ok).toBe(false);
    expect(validateLimits(CLAUDE_LIMITS, { bear_model: "gpt" }).ok).toBe(false);
    expect(ok(validateLimits(CLAUDE_LIMITS, { memory_trades: "0", bear_block_conf: "0" }))).toEqual({ memory_trades: 0, bear_block_conf: 0 });
  });
});
