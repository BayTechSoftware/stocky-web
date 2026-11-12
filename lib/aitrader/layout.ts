/**
 * How the settings forms are laid out — display only. The data groups in limits.ts (`group`) stay as
 * the contract has them; this file maps every field onto the same eight sections for Rules and Claude
 * boxes, says which fields are "advanced" (folded away), and which fields only matter while another
 * field has a certain value (hidden otherwise; their stored value is kept and still saved).
 */
import type { LimitDef } from "./limits";

export const SECTIONS = [
  "Money & risk",
  "When to trade",
  "What to trade",
  "How it decides",
  "In-play board",
  "Checks",
  "Learning",
  "Exits",
  "Schedule & cost",
] as const;
export type SettingsSection = (typeof SECTIONS)[number];

/** Data group → section. Unknown groups (e.g. ones added later) fall back to "How it decides". */
const GROUP_SECTION: Record<string, SettingsSection> = {
  "Risk & size": "Money & risk",
  Timing: "When to trade",
  Symbols: "What to trade",
  Strategy: "What to trade",
  Universe: "What to trade",
  Rules: "How it decides",
  "In-play board": "In-play board",
  "Entries & exits": "Exits",
  Scorecard: "How it decides",
  "Scorecard weights": "How it decides",
  "Scorecard gates": "Checks",
  Checks: "Checks",
  Exits: "Exits",
  Schedule: "Schedule & cost",
  Usage: "Schedule & cost",
  News: "Schedule & cost",
};

/** Per-key placement where the data group doesn't say it (keys that exist in one table only). */
const KEY_SECTION: Record<string, SettingsSection> = {
  // Claude boxes
  max_trades_per_day: "When to trade",
  or_minutes: "How it decides",
  review: "Learning",
  shadow_review: "Learning",
  review_model: "Learning",
  use_lessons: "Learning",
  lessons_count: "Learning",
  // Rules boxes
  entry_slip_pct: "How it decides",
  entry_valid_days: "When to trade",
};

export function sectionOf(d: LimitDef): SettingsSection {
  if (KEY_SECTION[d.key]) return KEY_SECTION[d.key];
  if ((SECTIONS as readonly string[]).includes(d.group)) return d.group as SettingsSection;
  return GROUP_SECTION[d.group] ?? "How it decides";
}

/** Order inside a section: these keys first, in this order; everything else after, in table order. */
const ORDER = [
  // Money & risk
  "enabled", "budget", "risk_pct", "max_loss_per_trade_usd", "max_daily_loss_usd", "daily_loss_halt_pct", "max_position_pct",
  "max_positions", "max_new_per_run", "cash_buffer_pct", "min_reward_risk",
  "allow_short", "allow_margin", "margin_multiplier", "allow_loosen_stop",
  // When to trade
  "no_entries_before", "no_entries_after", "flat_by", "flatten_backup", "premarket_queue", "queue_ttl_min",
  // What to trade
  "blocked", "universe_remove", "universe_add", "allow_reentry",
  // How it decides
  "entry_orders", "scorecard", "min_score",
  // In-play board
  "board", "board_top_n", "board_watch_n", "board_setups", "early_or_minutes", "board_regime", "regime_pct", "inplay_min_change_pct", "inplay_min_rvol", "premarket_min_vol_pct", "inplay_min_price", "stop_max_datr", "max_chase_r",
  // Checks
  "market_read", "bear_mode", "bear_block_conf", "bear_fail_closed", "bear_model", "memory_trades",
  // Learning
  "review", "review_model", "shadow_review", "use_lessons", "lessons_count", "lesson_min_trades",
  // Exits
  "reward_risk", "atr_mult", "target_r", "breakeven_at_r", "trail_mode", "trail_start_r", "trail_atr_mult", "trail_pct",
  "partial_pct", "partial_r", "time_stop_mode", "time_stop_min", "time_stop_min_r", "market_turn_mode", "market_turn_pct",
  // Schedule & cost
  "model", "interval_min", "weekly_cap_usd", "throttle_pct", "throttle_interval_min", "premarket_early", "premarket_time",
  "news_wake", "news_scope", "news_wakes_per_day", "wake_min_gap_min", "news_ticker_cooldown_min", "web_news",
];

export function sortDefs(defs: LimitDef[]): LimitDef[] {
  const rank = (d: LimitDef, i: number) => {
    const k = ORDER.indexOf(d.key);
    return k >= 0 ? k : 1000 + i;
  };
  return defs
    .map((d, i) => ({ d, r: rank(d, i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.d);
}

/** Folded behind "Advanced (n)". Claude-box and runner fields only (Rules boxes have their own min_stop_pct). */
const ADVANCED = new Set([
  "earnings_window_days", "max_vwap_atr", "max_adr_used", "extension_penalty",
  "max_orders_per_day", "max_order_usd", "min_order_usd", "fractional", "pdt_guard", "min_stop_pct", "min_stop_atr",
  "or_minutes", "max_breakout_age_min", "board_watch_n", "early_or_minutes", "inplay_min_price", "regime_pct", "stop_max_datr", "board_wakes_per_symbol", "board_rewake_datr",
  "queue_ttl_min", "flatten_lead_min", "run_timeout_s", "news_tags", "wake_min_gap_min",
]);

/** The scorecard weights, folded on their own behind "Fine-tune how the score is calculated". */
export const isWeight = (d: LimitDef) => d.key.startsWith("w_") && d.key !== "w_sentiment";

export function isAdvanced(d: LimitDef, claude: boolean): boolean {
  return claude && ADVANCED.has(d.key);
}

/** Never shown (kept and saved as they are): StockTwits sentiment has no effect for now. */
const HIDDEN = new Set(["sentiment", "w_sentiment"]);

const on = (v: string | undefined) => v === "true";
/** A number parent that is on (> 0). Empty = its default, which isn't known here, so it counts as on. */
const pos = (v: string | undefined) => v === undefined || v.trim() === "" || Number(v) > 0;

/** Fields that only matter while a parent field is set a certain way. vals: the form's current values. */
const SHOW_IF: Record<string, (v: Record<string, string>) => boolean> = {
  margin_multiplier: (v) => on(v.allow_margin),
  bear_block_conf: (v) => v.bear_mode === "block",
  bear_fail_closed: (v) => v.bear_mode === "block",
  bear_model: (v) => v.bear_mode !== "off",
  trail_start_r: (v) => v.trail_mode !== "off",
  trail_atr_mult: (v) => v.trail_mode === "atr",
  trail_pct: (v) => v.trail_mode === "pct",
  partial_r: (v) => pos(v.partial_pct),
  time_stop_min: (v) => v.time_stop_mode !== "off",
  time_stop_min_r: (v) => v.time_stop_mode !== "off" && pos(v.time_stop_min),
  market_turn_pct: (v) => v.market_turn_mode !== "off",
  lessons_count: (v) => on(v.use_lessons),
  review_model: (v) => on(v.review),
  throttle_interval_min: (v) => pos(v.throttle_pct) && pos(v.weekly_cap_usd),
  wake_min_gap_min: (v) => on(v.news_wake),
  news_ticker_cooldown_min: (v) => on(v.news_wake),
  news_wakes_per_day: (v) => on(v.news_wake),
  premarket_min_vol_pct: (v) => on(v.board),
  board_top_n: (v) => on(v.board),
  inplay_min_price: (v) => on(v.board),
  inplay_min_change_pct: (v) => on(v.board),
  inplay_min_rvol: (v) => on(v.board),
  board_regime: (v) => on(v.board),
  regime_pct: (v) => on(v.board) && v.board_regime !== "off",
  board_setups: (v) => on(v.board),
  board_watch_n: (v) => on(v.board),
  early_or_minutes: (v) => on(v.board),
  stop_max_datr: (v) => on(v.board),
  max_chase_r: (v) => on(v.board),
  queue_ttl_min: (v) => on(v.premarket_queue),
  board_wakes_per_symbol: (v) => on(v.board),
  board_rewake_datr: (v) => on(v.board),
  news_tags: (v) => on(v.news_wake),
};

/** Whether a field is shown, given the form's current values (a parent missing from the form doesn't hide it). */
export function isShown(d: LimitDef, vals: Record<string, string>): boolean {
  if (HIDDEN.has(d.key)) return false;
  const f = SHOW_IF[d.key];
  if (!f) return true;
  try {
    return f(vals);
  } catch {
    return true;
  }
}
