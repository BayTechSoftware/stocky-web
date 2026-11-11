/**
 * Editable settings for the AI Trader boxes — one definition shared by the
 * settings forms, the server actions and the rules engine, so the bounds can't
 * drift. It mirrors stocky-trader/docs/SETTINGS_CONTRACT.md (the Mac clamps the
 * same keys in stocky-trader/bin/limits.py): key names, kinds, defaults, bounds.
 *
 * Defaults = the behaviour before the settings existed. Bounds are only technical
 * sanity ranges; how much risk to take is the user's choice. `0` means "off"
 * where a field's hint says so.
 *
 *   RULES_LIMITS  — the Rules boxes (mylist / free), run by lib/aitrader/engine.ts.
 *   CLAUDE_LIMITS — the Claude boxes; the Mac writes them into each book's
 *                   trader/config.json before every run.
 *   RUNNER_LIMITS — how and when the Mac runs Claude (ai_runner.settings).
 */

export type LimitKind = "number" | "time" | "bool" | "symbols" | "tags" | "select";
export type BoxKey = "mylist" | "free";
export type LimitValue = number | string | boolean;

export interface LimitDef {
  key: string;
  label: string;
  hint?: string;
  kind: LimitKind;
  group: string;
  unit?: "%" | "$" | "×" | "min" | "s" | "days" | "";
  min?: number;
  max?: number;
  int?: boolean; // whole numbers only (rounded)
  def: LimitValue;
  /** Per-box default (Rules boxes), resolved by rulesDefs(). */
  defBy?: Partial<Record<BoxKey, LimitValue>>;
  /** time: allowed window (default 09:30–16:00) and whether "" (off) is allowed. */
  tmin?: string;
  tmax?: string;
  allowOff?: boolean;
  /** select: the allowed values. */
  options?: string[];
  only?: BoxKey; // rules-only fields that apply to one box
}

export const MAX_SYMBOLS = 500;
const SYMBOL_RE = /^[A-Z0-9.]{1,10}$/;
const TAG_RE = /^[a-z][a-z_]{0,29}$/;

export const RULES_LIMITS: LimitDef[] = [
  // Risk & size
  { key: "budget", group: "Risk & size", label: "Book size", unit: "$", kind: "number", min: 100, max: 1_000_000, def: 5000, hint: "the book's starting cash; P&L is measured from it" },
  { key: "risk_pct", group: "Risk & size", label: "Risk per trade", unit: "%", kind: "number", min: 0.01, max: 100, def: 1, hint: "of the book's equity, measured to the stop" },
  { key: "max_position_pct", group: "Risk & size", label: "Max position size", unit: "%", kind: "number", min: 1, max: 100, def: 20 },
  { key: "cash_buffer_pct", group: "Risk & size", label: "Cash buffer", unit: "%", kind: "number", min: 0, max: 90, def: 0, hint: "% of the book kept uninvested; 0 = spend it all" },
  { key: "max_positions", group: "Risk & size", label: "Max positions", unit: "", kind: "number", min: 1, max: 500, int: true, def: 5 },
  { key: "max_new_per_run", group: "Risk & size", label: "New trades per run", unit: "", kind: "number", min: 0, max: 500, int: true, def: 3 },
  { key: "daily_loss_halt_pct", group: "Risk & size", label: "Daily-loss halt", unit: "%", kind: "number", min: 0, max: 100, def: 3, hint: "no new entries after equity falls this much since the last snapshot; 0 = off" },
  // Entries & exits
  { key: "reward_risk", group: "Entries & exits", label: "Target (reward : risk)", unit: "×", kind: "number", min: 0, max: 20, def: 2, hint: "0 = no take-profit (stop only)" },
  { key: "atr_mult", group: "Entries & exits", label: "Stop distance (× ATR14)", unit: "×", kind: "number", min: 0.1, max: 20, def: 2 },
  { key: "min_stop_pct", group: "Entries & exits", label: "Min stop distance", unit: "%", kind: "number", min: 0.1, max: 90, def: 3 },
  { key: "max_stop_pct", group: "Entries & exits", label: "Max stop distance", unit: "%", kind: "number", min: 0.1, max: 90, def: 12, hint: "≥ min stop distance" },
  { key: "entry_slip_pct", group: "Entries & exits", label: "Entry limit above reference", unit: "%", kind: "number", min: 0, max: 50, def: 1 },
  { key: "entry_valid_days", group: "Entries & exits", label: "Unfilled entries kept for", unit: "days", kind: "number", min: 1, max: 60, int: true, def: 1, hint: "then the unfilled part is cancelled" },
  { key: "max_hold_days", group: "Entries & exits", label: "Max holding period", unit: "days", kind: "number", min: 0, max: 3650, int: true, def: 21, defBy: { mylist: 0, free: 21 }, hint: "calendar days; 0 = off" },
  { key: "exit_on_overbought", group: "Entries & exits", label: "Sell when the signal turns OVERBOUGHT", kind: "bool", def: true, only: "mylist" },
  { key: "midday_entries", group: "Entries & exits", label: "Open new trades in runs during market hours", kind: "bool", def: true, hint: "the midday run (and Run now while the market is open); off = only the evening run opens trades, midday still manages stops and exits" },
  { key: "reentry_cooldown_days", group: "Entries & exits", label: "Wait before re-entering a stock", unit: "days", kind: "number", min: 0, max: 30, int: true, def: 0, hint: "after a trade in it closed; 1 = not the same day; 0 = off" },
  // Strategy
  { key: "min_price", group: "Strategy", label: "Min share price", unit: "$", kind: "number", min: 0, max: 100_000, def: 10 },
  { key: "min_score", group: "Strategy", label: "Min Stocky signal score", unit: "", kind: "number", min: 0, max: 100, def: 60, only: "mylist" },
  { key: "max_signal_age_days", group: "Strategy", label: "Skip signals older than", unit: "days", kind: "number", min: 0, max: 3650, int: true, def: 3, only: "mylist", hint: "0 = never skip" },
  { key: "enter_on_watch", group: "Strategy", label: "Also enter on WATCH signals", kind: "bool", def: false, only: "mylist" },
  { key: "max_rsi", group: "Strategy", label: "Skip setups with RSI(14) at or above", unit: "", kind: "number", min: 0, max: 100, def: 75, only: "free", hint: "100 = never skip" },
  { key: "uptrend_only", group: "Strategy", label: "Uptrend filter (50/200-day average)", kind: "bool", def: true, only: "free" },
  // Universe
  { key: "universe_add", group: "Universe", label: "Add to the universe", kind: "symbols", def: "", only: "free", hint: "comma-separated tickers" },
  { key: "universe_remove", group: "Universe", label: "Remove from the universe", kind: "symbols", def: "", only: "free", hint: "comma-separated tickers" },
];

/**
 * The scorecard (stocky-trader bin/rate.py): before an entry Claude rates its shortlist on the owner's
 * checklist — 11 gates (pass / fail / n/a) and a 0–100 score from weighted components. A gate on
 * "block" (or a score under min_score) is enforced by the Mac's guard; "warn" only informs Claude.
 * Mirrors docs/SETTINGS_CONTRACT.md "Scorecard" and stocky-trader bin/scorecard.py.
 */
export const SCORECARD_GATES = [
  "tradability", "catalyst", "market", "sector", "rel_strength", "rvol", "levels", "trend", "trigger", "room", "rr_size",
  "extension",
] as const;
export type ScorecardGate = (typeof SCORECARD_GATES)[number];

export const SCORECARD_GATE_LABEL: Record<string, string> = {
  tradability: "Tradable (spread, $ volume, borrow)",
  catalyst: "Catalyst (news / earnings)",
  market: "Market direction (SPY, QQQ)",
  sector: "Sector direction",
  rel_strength: "Relative strength",
  rvol: "Relative volume",
  levels: "Key level (support / resistance)",
  trend: "Trend structure",
  trigger: "Setup trigger",
  room: "Room to the next level",
  rr_size: "Reward : risk and size fit",
  extension: "Not extended (no chasing)",
};

const SCORECARD_GATE_HINT: Record<string, string> = {
  tradability: "spread ≤ max spread and 20-day $ volume ≥ the minimum; shorts: shortable and easy to borrow",
  catalyst: "tagged news since the last close, or earnings within the window — a flag",
  market: "SPY and QQQ above their VWAP and the prior close (below for a short)",
  sector: "the stock's SPDR sector ETF (SMH for chips) the same way",
  rel_strength: "the stock beats SPY since the open and since the prior close",
  rvol: "today's volume vs the 20-day average at the same time of day",
  levels: "trading beyond the opening-range or prior-day high (low for a short)",
  trend: "higher highs and higher lows on 5-minute swings (lower for a short)",
  trigger: "the entry rule (opening-range breakout or a level) fired and is holding",
  room: "distance to the next level, in multiples of the risk, ≥ min reward : risk",
  rr_size: "planned reward : risk ≥ the minimum, and the trade fits the size limits",
  extension: "flags a chase: price too far past VWAP (in 5-min ATRs) or too much of the usual daily range used; extended scores lose points",
};

/** Default weights (sum 100). Weights are relative: the score is normalised over the components with data. */
export const SCORECARD_WEIGHTS: Record<string, number> = {
  tradability: 8, catalyst: 8, market: 8, sector: 6, rel_strength: 8, rvol: 8, levels: 2, trend: 8, trigger: 6,
  room: 8, rr_size: 6, extension: 8, vwap: 2, ema: 2, rsi: 3, macd: 3, float: 2, fundamentals: 2, valuation: 2,
};

export const SCORECARD_PART_LABEL: Record<string, string> = {
  ...SCORECARD_GATE_LABEL,
  vwap: "Price vs VWAP",
  ema: "9 / 20 EMA",
  rsi: "RSI (14)",
  macd: "MACD (12, 26, 9)",
  float: "Float turnover",
  fundamentals: "Fundamentals",
  valuation: "Valuation vs sector",
  sentiment: "Social sentiment",
};

/**
 * Extra checks before an entry (borrowed from TradingAgents): a bear case argued by a separate cheap
 * Claude call, Claude's own past trades in the stock, and optional StockTwits sentiment. Kept out of
 * SCORECARD_WEIGHTS so the default weights still sum to 100 and existing scores don't move: sentiment
 * only scores when it is on (weights are normalised over the components with data).
 * Mirrors docs/SETTINGS_CONTRACT.md "Checks".
 */
export const CHECK_LIMITS: LimitDef[] = [
  { key: "bear_mode", group: "Checks", label: "Bear check before each entry", kind: "select", options: ["off", "warn", "block"], def: "warn", hint: "a separate cheap Claude call argues against each trade first; warn: Claude must answer it; block: the trade is stopped when the case against wins" },
  { key: "bear_block_conf", group: "Checks", label: "Block when the case against is at least", unit: "%", kind: "number", min: 0, max: 100, int: true, def: 70, hint: "confidence; only in block mode" },
  { key: "bear_model", group: "Checks", label: "Bear check model", kind: "select", options: ["haiku", "sonnet", "opus"], def: "haiku", hint: "counts toward the weekly cap" },
  { key: "memory_trades", group: "Checks", label: "Past trades shown per stock", unit: "", kind: "number", min: 0, max: 20, int: true, def: 5, hint: "Claude sees its own last trades in a stock before trading it again; 0 = off" },
  { key: "sentiment", group: "Checks", label: "Social sentiment (StockTwits)", kind: "select", options: ["off", "stocktwits"], def: "off", hint: "adds bullish/bearish chatter to the score. StockTwits currently blocks automated access, so it has no effect yet" },
  // Same shape as the generated w_* weights (Scorecard weights), shown next to the switch it belongs to.
  { key: "w_sentiment", group: "Checks", label: "Sentiment weight", unit: "", kind: "number", min: 0, max: 100, def: 10, hint: "only when social sentiment is on" },
];

export const SCORECARD_LIMITS: LimitDef[] = [
  { key: "scorecard", group: "Scorecard", label: "Scorecard before every entry", kind: "bool", def: true, hint: "off = Claude can still rate stocks; nothing is enforced" },
  { key: "min_score", group: "Scorecard", label: "Minimum score to enter", unit: "", kind: "number", min: 0, max: 100, def: 0, hint: "0 = advisory only (Claude prefers higher scores but decides)" },
  { key: "max_spread_pct", group: "Scorecard", label: "Max bid/ask spread", unit: "%", kind: "number", min: 0.01, max: 100, def: 0.5, hint: "of the price, from Alpaca's (15-min delayed) national best bid/offer" },
  { key: "min_avg_dollar_vol", group: "Scorecard", label: "Min average dollar volume", unit: "$", kind: "number", min: 0, max: 1_000_000_000_000, def: 5_000_000, hint: "per day, 20-day average" },
  { key: "min_rvol", group: "Scorecard", label: "Min relative volume", unit: "×", kind: "number", min: 0, max: 100, def: 1, hint: "vs the 20-day average at the same time of day" },
  { key: "earnings_window_days", group: "Scorecard", label: "Earnings counts as a catalyst within", unit: "days", kind: "number", min: 0, max: 30, int: true, def: 1 },
  { key: "max_vwap_atr", group: "Scorecard", label: "Extended: beyond VWAP by more than", unit: "×", kind: "number", min: 0.1, max: 20, def: 1.5, hint: "5-minute ATRs above VWAP (below for a short) — past this a breakout is a chase" },
  { key: "max_adr_used", group: "Scorecard", label: "Extended: daily range used more than", unit: "×", kind: "number", min: 0.1, max: 20, def: 2, hint: "the day's move so far vs the stock's 20-day average daily range" },
  { key: "extension_penalty", group: "Scorecard", label: "Score points off an extended stock", unit: "", kind: "number", min: 0, max: 100, def: 15, hint: "on top of the extension weight; 0 = only the weight" },
  ...SCORECARD_GATES.map(
    (g): LimitDef => ({
      key: `gate_${g}`,
      group: "Scorecard gates",
      label: SCORECARD_GATE_LABEL[g],
      kind: "select",
      options: ["off", "warn", "block"],
      def: g === "tradability" ? "block" : "warn",
      hint: SCORECARD_GATE_HINT[g],
    })
  ),
  ...Object.entries(SCORECARD_WEIGHTS).map(
    ([k, w]): LimitDef => ({
      key: `w_${k}`,
      group: "Scorecard weights",
      label: SCORECARD_PART_LABEL[k] ?? k,
      unit: "",
      kind: "number",
      min: 0,
      max: 100,
      def: w,
    })
  ),
  ...CHECK_LIMITS,
];

/**
 * Smart exits (stocky-trader bin/exit_manager.py): the Mac manages each Claude box's open trades every
 * minute between runs. R = the distance from the entry to the initial stop. A stop only moves toward the
 * price. Also the after-close review (bin/reviewer.py). Mirrors docs/SETTINGS_CONTRACT.md "Exits".
 */
export const EXIT_LIMITS: LimitDef[] = [
  { key: "breakeven_at_r", group: "Exits", label: "Stop to breakeven at", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "R in profit (best price since entry); the stop moves to the entry. 0 = off" },
  { key: "trail_mode", group: "Exits", label: "Trailing stop", kind: "select", options: ["off", "atr", "pct"], def: "atr", hint: "atr: a multiple of the 5-minute ATR(14) behind the best price; pct: a % behind it" },
  { key: "trail_start_r", group: "Exits", label: "Trail starts at", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "R in profit" },
  { key: "trail_atr_mult", group: "Exits", label: "Trail distance (× ATR)", unit: "×", kind: "number", min: 0.1, max: 20, def: 2 },
  { key: "trail_pct", group: "Exits", label: "Trail distance (%)", unit: "%", kind: "number", min: 0.05, max: 50, def: 1, hint: "used when the trailing stop is pct" },
  { key: "partial_pct", group: "Exits", label: "Take part off", unit: "%", kind: "number", min: 0, max: 100, def: 0, hint: "of the whole shares, once, at the R below; the rest keeps a stop and target. 0 = off" },
  { key: "partial_r", group: "Exits", label: "…at", unit: "×", kind: "number", min: 0.1, max: 20, def: 1, hint: "R in profit" },
  { key: "time_stop_min", group: "Exits", label: "Time stop after", unit: "min", kind: "number", min: 0, max: 1440, int: true, def: 120, hint: "market minutes since the entry; 0 = off" },
  { key: "time_stop_min_r", group: "Exits", label: "…unless it reached", unit: "×", kind: "number", min: 0, max: 20, def: 0.3, hint: "R in profit by then" },
  { key: "time_stop_mode", group: "Exits", label: "When the time stop hits", kind: "select", options: ["off", "wake", "exit"], def: "wake", hint: "wake: Claude looks and decides; exit: the Mac sells" },
  { key: "market_turn_mode", group: "Exits", label: "When the market turns", kind: "select", options: ["off", "wake", "exit"], def: "wake", hint: "SPY (or the stock's sector ETF) crosses VWAP against the trade, or SPY moves the % below against it" },
  { key: "market_turn_pct", group: "Exits", label: "Market turn: SPY move against", unit: "%", kind: "number", min: 0.05, max: 20, def: 0.5, hint: "since the entry" },
  { key: "review", group: "Exits", label: "Daily review after the close", kind: "bool", def: true, hint: "one cheap Claude call per box per trading day; writes lessons Claude reads the next morning. Counts toward the weekly cap" },
  { key: "shadow_review", group: "Exits", label: "Score the trades Claude didn't take", kind: "bool", def: true, hint: "after the close: what the skipped and blocked stocks did, per scorecard check" },
  { key: "review_model", group: "Exits", label: "Review model", kind: "select", options: ["haiku", "sonnet", "opus"], def: "haiku", hint: "haiku once usage passes the slow-down %" },
  { key: "use_lessons", group: "Exits", label: "Claude reads lessons & suggestions", kind: "bool", def: true, hint: "the review's notes below; remove any you disagree with" },
  { key: "lessons_count", group: "Exits", label: "How many it reads", unit: "", kind: "number", min: 0, max: 20, int: true, def: 8, hint: "the newest of each kind (lessons, suggestions)" },
];

export const CLAUDE_LIMITS: LimitDef[] = [
  // Risk & size
  { key: "budget", group: "Risk & size", label: "Book size", unit: "$", kind: "number", min: 100, max: 1_000_000, def: 5000, hint: "what the repo sizes from" },
  { key: "max_loss_per_trade_usd", group: "Risk & size", label: "Max loss per trade", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 50 },
  { key: "max_daily_loss_usd", group: "Risk & size", label: "Daily loss limit", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 150, hint: "counts each entry's loss at its stop" },
  { key: "max_trades_per_day", group: "Risk & size", label: "Entries per day", unit: "", kind: "number", min: 0, max: 500, int: true, def: 3, hint: "0 = unlimited (the repo's own meaning)" },
  { key: "max_orders_per_day", group: "Risk & size", label: "Orders per day", unit: "", kind: "number", min: 1, max: 2000, int: true, def: 10, hint: "all placed orders incl. exits" },
  { key: "max_order_usd", group: "Risk & size", label: "Max order size", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 4000 },
  { key: "max_position_pct", group: "Risk & size", label: "Max position size", unit: "%", kind: "number", min: 1, max: 400, def: 75, hint: "over 100 needs margin on" },
  { key: "cash_buffer_pct", group: "Risk & size", label: "Cash buffer", unit: "%", kind: "number", min: 0, max: 90, def: 0, hint: "% of the book kept uninvested; 0 = spend it all" },
  { key: "min_order_usd", group: "Risk & size", label: "Min order size", unit: "$", kind: "number", min: 0, max: 1_000_000, def: 5, hint: "0 = off" },
  { key: "min_reward_risk", group: "Risk & size", label: "Min reward : risk", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "0 = off" },
  // Timing
  { key: "no_entries_before", group: "Timing", label: "No entries before (NY)", kind: "time", def: "09:45", allowOff: true },
  { key: "no_entries_after", group: "Timing", label: "No entries after (NY)", kind: "time", def: "15:30", allowOff: true },
  { key: "flat_by", group: "Timing", label: "Flat by (NY)", kind: "time", def: "15:55", allowOff: true, hint: "off = Claude may hold overnight (brackets stay at Alpaca; fractions are still sold before the close). On a half-day: min(this, close − 5 min)" },
  { key: "or_minutes", group: "Timing", label: "Opening range", kind: "select", options: ["5", "10", "15", "20", "30", "45", "60"], def: "15", hint: "minutes; Claude can still choose another for one trade" },
  // Symbols
  { key: "blocked", group: "Symbols", label: "Never trade", kind: "symbols", def: "", hint: "comma-separated tickers" },
  { key: "allow_reentry", group: "Symbols", label: "Allow a 2nd entry in a symbol the same day", kind: "bool", def: false },
  { key: "fractional", group: "Risk & size", label: "Fractional shares", kind: "bool", def: true, hint: "whole shares go in a bracket; the fraction gets its own day stop" },
  { key: "allow_margin", group: "Risk & size", label: "Allow margin (intraday buying power)", kind: "bool", def: false, hint: "lets a buy use borrowed money up to the multiple below; the cash buffer stops applying. More risk" },
  { key: "margin_multiplier", group: "Risk & size", label: "Margin multiple", unit: "×", kind: "number", min: 1, max: 4, def: 2, hint: "buying power as a multiple of the book, when margin is on. Alpaca's own limit is shared by all boxes" },
  { key: "pdt_guard", group: "Risk & size", label: "Pattern-day-trader check", kind: "bool", def: false, hint: "blocks a 4th day trade in 5 business days" },
  { key: "min_stop_pct", group: "Risk & size", label: "Tightest allowed stop", unit: "%", kind: "number", min: 0, max: 90, def: 0.05, hint: "of the price; 0 = off" },
  { key: "allow_loosen_stop", group: "Risk & size", label: "Let Claude move a stop further away", kind: "bool", def: false, hint: "off = a stop can only be tightened. A stop is always kept" },
  { key: "allow_short", group: "Risk & size", label: "Allow short selling", kind: "bool", def: false, hint: "lets Claude bet a stock will fall. Whole shares only. A sudden jump up can lose more than the stop. Only stocks no other box holds or has an order on" },
  ...SCORECARD_LIMITS,
  ...EXIT_LIMITS,
];

export const RUNNER_LIMITS: LimitDef[] = [
  // Schedule
  { key: "interval_min", group: "Schedule", label: "Claude runs every", unit: "min", kind: "number", min: 1, max: 240, int: true, def: 15 },
  { key: "premarket_early", group: "Schedule", label: "Early look (NY)", kind: "time", def: "08:00", allowOff: true, tmin: "04:00", tmax: "09:29", hint: "overnight news, earnings, gaps; news wakes run from here to the open" },
  { key: "premarket_time", group: "Schedule", label: "Pre-market scan (NY)", kind: "time", def: "09:15", allowOff: true, tmin: "07:00", tmax: "09:29" },
  { key: "flatten_lead_min", group: "Schedule", label: "Close-out run starts before flat-by", unit: "min", kind: "number", min: 1, max: 30, int: true, def: 5 },
  { key: "run_timeout_s", group: "Schedule", label: "Run timeout", unit: "s", kind: "number", min: 60, max: 3600, int: true, def: 720 },
  // Usage
  { key: "model", group: "Usage", label: "Model", kind: "select", options: ["sonnet", "opus", "haiku"], def: "sonnet" },
  { key: "weekly_cap_usd", group: "Usage", label: "Weekly usage cap", unit: "$", kind: "number", min: 0, max: 100_000, def: 30, hint: "API-equivalent; 0 = no cap" },
  { key: "throttle_pct", group: "Usage", label: "Slow down at", unit: "%", kind: "number", min: 0, max: 100, def: 80, hint: "of the cap; 0 = never slow down" },
  { key: "throttle_interval_min", group: "Usage", label: "…then run every", unit: "min", kind: "number", min: 1, max: 240, int: true, def: 60 },
  // News
  { key: "news_wake", group: "News", label: "Wake Claude on important news", kind: "bool", def: true },
  { key: "wake_min_gap_min", group: "News", label: "Min gap between wakes", unit: "min", kind: "number", min: 1, max: 120, int: true, def: 5 },
  { key: "news_scope", group: "News", label: "News for", kind: "select", options: ["held", "held_and_list"], def: "held_and_list", hint: "held_and_list: My List book also watches its list" },
  { key: "news_tags", group: "News", label: "News tags that wake Claude", kind: "tags", def: "earnings,deal,legal,risk,halt,regulatory,people,analyst,capital,macro", hint: "comma-separated, lowercase" },
  { key: "web_news", group: "News", label: "Claude may read full stories on the web", kind: "bool", def: true },
];

/** A Rules box's fields: only its own, with its per-box defaults resolved. */
export function rulesDefs(box: BoxKey): LimitDef[] {
  return RULES_LIMITS.filter((d) => !d.only || d.only === box).map((d) =>
    d.defBy?.[box] !== undefined ? { ...d, def: d.defBy[box]! } : d
  );
}

/** The form fields for any box key. */
export function defsForBook(key: string): LimitDef[] {
  if (key.startsWith("claude-")) return CLAUDE_LIMITS;
  return rulesDefs(key === "mylist" ? "mylist" : "free");
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Split a comma/space list → uppercase, deduped tickers (order kept). */
export function parseSymbols(v: unknown): string[] {
  const parts = String(v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "on", "1", "yes"].includes(s)) return true;
  if (["false", "off", "0", "no"].includes(s)) return false;
  return null;
}

export type Settings = Record<string, LimitValue>;

/**
 * Validate a submitted form into a clean settings object: unknown keys dropped,
 * numbers clamped to their bounds, times checked against their window and order,
 * lists normalised. Missing / "" values fall back to the default (not stored);
 * a time field that allows it can be switched off with "off" (stored as "").
 */
export function validateLimits(
  defs: LimitDef[],
  raw: Record<string, unknown>
): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const out: Settings = {};
  const errors: string[] = [];
  for (const d of defs) {
    const v = raw[d.key];
    if (v === undefined || v === null) continue;
    if (d.kind === "time") {
      const s = String(v).trim();
      if (s === "") continue;
      if (s.toLowerCase() === "off") {
        if (d.allowOff) out[d.key] = "";
        else errors.push(`${d.label}: can't be off`);
        continue;
      }
      const lo = d.tmin ?? "09:30";
      const hi = d.tmax ?? "16:00";
      if (!TIME_RE.test(s) || toMin(s) < toMin(lo) || toMin(s) > toMin(hi)) {
        errors.push(`${d.label}: use HH:MM between ${lo} and ${hi}`);
        continue;
      }
      out[d.key] = s;
    } else if (d.kind === "bool") {
      if (v === "") continue;
      const b = parseBool(v);
      if (b === null) errors.push(`${d.label}: not on/off`);
      else out[d.key] = b;
    } else if (d.kind === "select") {
      const s = String(v).trim();
      if (s === "") continue;
      if (!d.options?.includes(s)) errors.push(`${d.label}: choose one of ${d.options?.join(", ")}`);
      else out[d.key] = s;
    } else if (d.kind === "symbols" || d.kind === "tags") {
      const list =
        d.kind === "symbols"
          ? parseSymbols(v)
          : Array.from(new Set(String(v).split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)));
      const re = d.kind === "symbols" ? SYMBOL_RE : TAG_RE;
      const bad = list.filter((s) => !re.test(s));
      if (bad.length) {
        errors.push(`${d.label}: not valid — ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}`);
        continue;
      }
      if (list.length > MAX_SYMBOLS) {
        errors.push(`${d.label}: at most ${MAX_SYMBOLS} entries`);
        continue;
      }
      if (String(v).trim() === "") continue; // empty = default
      out[d.key] = list.join(",");
    } else {
      if (v === "") continue;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (typeof v === "boolean" || !Number.isFinite(n)) {
        errors.push(`${d.label}: not a number`);
        continue;
      }
      const c = Math.min(d.max ?? n, Math.max(d.min ?? n, n));
      out[d.key] = d.int ? Math.round(c) : c;
    }
  }

  const val = (k: string) => (k in out ? out[k] : defs.find((d) => d.key === k)?.def);
  const has = (k: string) => defs.some((d) => d.key === k);

  if (has("min_stop_pct") && has("max_stop_pct")) {
    const lo = Number(val("min_stop_pct"));
    const hi = Number(val("max_stop_pct"));
    if (lo > hi) errors.push("Min stop distance must be ≤ Max stop distance");
  }

  // Time order: before < after < flat_by, over the ones that are set (not off).
  const order = [
    ["no_entries_before", "No entries before"],
    ["no_entries_after", "No entries after"],
    ["flat_by", "Flat by"],
  ].filter(([k]) => has(k));
  const set = order
    .map(([k, label]) => ({ label, t: val(k) }))
    .filter((x): x is { label: string; t: string } => typeof x.t === "string" && TIME_RE.test(x.t));
  for (let i = 1; i < set.length; i++) {
    if (toMin(set[i - 1].t) >= toMin(set[i].t)) {
      errors.push(`${set[i - 1].label} must be earlier than ${set[i].label}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}

/** Defaults overlaid with a book's saved settings (for display and engines). */
export function effective(defs: LimitDef[], saved: Record<string, unknown> | null | undefined): Settings {
  const out: Settings = {};
  for (const d of defs) {
    const v = saved?.[d.key];
    out[d.key] = v === undefined || v === null ? d.def : (v as LimitValue);
  }
  return out;
}
