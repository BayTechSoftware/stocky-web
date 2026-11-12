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

export type LimitKind = "number" | "time" | "bool" | "symbols" | "tags" | "select" | "words";
export type BoxKey = "mylist" | "free";
export type LimitValue = number | string | boolean;

export interface LimitDef {
  key: string;
  label: string;
  hint?: string;
  kind: LimitKind;
  group: string;
  unit?: "%" | "$" | "×" | "min" | "s" | "days" | "R" | "";
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
  /** select / words: the allowed values (words: any subset, stored as a comma list in this order). */
  options?: string[];
  /** select / words: how each stored value reads in the form (the stored value is unchanged). */
  optionLabels?: Record<string, string>;
  only?: BoxKey; // rules-only fields that apply to one box
}

export const MAX_SYMBOLS = 500;
const SYMBOL_RE = /^[A-Z0-9.]{1,10}$/;
const TAG_RE = /^[a-z][a-z_]{0,29}$/;

export const RULES_LIMITS: LimitDef[] = [
  { key: "enabled", group: "Risk & size", label: "Box is on", kind: "bool", def: true, hint: "off = the cron and Run buttons place no new trades for this box; open positions keep their protective orders" },
  // Risk & size
  { key: "budget", group: "Risk & size", label: "Box size", unit: "$", kind: "number", min: 100, max: 1_000_000, def: 5000, hint: "the box's starting cash; profit and loss are measured from it" },
  { key: "risk_pct", group: "Risk & size", label: "Most I can lose on one trade", unit: "%", kind: "number", min: 0.01, max: 100, def: 1, hint: "of the box's current value, if the trade hits its stop (the price where it sells at a loss)" },
  { key: "max_position_pct", group: "Risk & size", label: "Biggest single holding (% of box)", unit: "%", kind: "number", min: 1, max: 100, def: 20, hint: "of the box's current value" },
  { key: "cash_buffer_pct", group: "Risk & size", label: "Cash kept aside", unit: "%", kind: "number", min: 0, max: 90, def: 0, hint: "% of the box never invested; 0 = it may spend it all" },
  { key: "max_positions", group: "Risk & size", label: "Most stocks held at once", unit: "", kind: "number", min: 1, max: 500, int: true, def: 5 },
  { key: "max_new_per_run", group: "Risk & size", label: "Most new buys per run", unit: "", kind: "number", min: 0, max: 500, int: true, def: 3 },
  { key: "daily_loss_halt_pct", group: "Risk & size", label: "Stop buying after a bad day", unit: "%", kind: "number", min: 0, max: 100, def: 3, hint: "no new buys once the box is down this much since the last daily snapshot; 0 = off" },
  // Entries & exits
  { key: "reward_risk", group: "Entries & exits", label: "Take profit at", unit: "×", kind: "number", min: 0, max: 20, def: 2, hint: "× the risk: 2 = sell when it's up twice the amount risked. 0 = no profit target (stop only)" },
  { key: "atr_mult", group: "Entries & exits", label: "How much room before selling at a loss", unit: "×", kind: "number", min: 0.1, max: 20, def: 2, hint: "in normal daily swings (the stock's average daily range over 14 days): 2 = the stop sits two swings below the price" },
  { key: "min_stop_pct", group: "Entries & exits", label: "Stop at least this far below the price", unit: "%", kind: "number", min: 0.1, max: 90, def: 3 },
  { key: "max_stop_pct", group: "Entries & exits", label: "Stop at most this far below the price", unit: "%", kind: "number", min: 0.1, max: 90, def: 12, hint: "must be at least the setting above" },
  { key: "entry_slip_pct", group: "Entries & exits", label: "Pay at most this much above the signal price", unit: "%", kind: "number", min: 0, max: 50, def: 1 },
  { key: "entry_valid_days", group: "Entries & exits", label: "Keep an unfilled buy order for", unit: "days", kind: "number", min: 1, max: 60, int: true, def: 1, hint: "then the unfilled part is cancelled" },
  { key: "max_hold_days", group: "Entries & exits", label: "Sell after holding this long", unit: "days", kind: "number", min: 0, max: 3650, int: true, def: 21, defBy: { mylist: 0, free: 21 }, hint: "calendar days; 0 = off" },
  { key: "exit_on_overbought", group: "Entries & exits", label: "Sell when Stocky's signal says OVERBOUGHT", kind: "bool", def: true, only: "mylist" },
  { key: "midday_entries", group: "Entries & exits", label: "Also buy in the midday run", kind: "bool", def: true, hint: "the midday run (and Run now while the market is open); off = only the evening run opens trades, midday still manages stops and exits" },
  { key: "reentry_cooldown_days", group: "Entries & exits", label: "Wait before re-entering a stock", unit: "days", kind: "number", min: 0, max: 30, int: true, def: 0, hint: "after a trade in it closed; 1 = not the same day; 0 = off" },
  // Strategy
  { key: "min_price", group: "Strategy", label: "Cheapest share price to buy", unit: "$", kind: "number", min: 0, max: 100_000, def: 10 },
  { key: "min_score", group: "Strategy", label: "Lowest Stocky signal score to buy", unit: "", kind: "number", min: 0, max: 100, def: 60, only: "mylist" },
  { key: "max_signal_age_days", group: "Strategy", label: "Ignore signals older than", unit: "days", kind: "number", min: 0, max: 3650, int: true, def: 3, only: "mylist", hint: "0 = never ignore" },
  { key: "enter_on_watch", group: "Strategy", label: "Also buy on WATCH signals", kind: "bool", def: false, only: "mylist" },
  { key: "max_rsi", group: "Strategy", label: "Skip stocks that look overheated, at or above", unit: "", kind: "number", min: 0, max: 100, def: 75, only: "free", hint: "a 0–100 momentum reading (RSI 14); high = it has run up fast. 100 = never skip" },
  { key: "uptrend_only", group: "Strategy", label: "Only buy stocks in a long-term uptrend", kind: "bool", def: true, only: "free", hint: "the 50-day average price above the 200-day average" },
  { key: "max_gap_down_pct", group: "Strategy", label: "Skip a stock that opened down more than", unit: "%", kind: "number", min: 0, max: 50, def: 0, hint: "open vs the previous close: no new entry after such a day, and a resting entry is cancelled at the next run during the session (it can still fill at the open itself, before that run); 0 = off" },
  { key: "min_atr_pct", group: "Strategy", label: "Skip stocks that barely move (daily swing below)", unit: "%", kind: "number", min: 0, max: 50, def: 0, hint: "ATR(14) as % of the price — e.g. income ETFs like QYLD, JEPI; 0 = off" },
  // Universe
  { key: "universe_add", group: "Universe", label: "Also consider these stocks", kind: "symbols", def: "", only: "free", hint: "comma-separated tickers" },
  { key: "universe_remove", group: "Universe", label: "Never trade", kind: "symbols", def: "", only: "free", hint: "comma-separated tickers" },
];

/**
 * The scorecard (stocky-trader bin/rate.py): before an entry Claude rates its shortlist on the owner's
 * checklist — 12 gates (pass / fail / n/a) and a 0–100 score from weighted components. A gate on
 * "block" (or a score under min_score) is enforced by the Mac's guard; "warn" only informs Claude.
 * Mirrors docs/SETTINGS_CONTRACT.md "Scorecard" and stocky-trader bin/scorecard.py.
 */
export const SCORECARD_GATES = [
  "tradability", "catalyst", "market", "sector", "rel_strength", "rvol", "levels", "trend", "trigger", "room", "rr_size",
  "extension",
] as const;
export type ScorecardGate = (typeof SCORECARD_GATES)[number];

export const SCORECARD_GATE_LABEL: Record<string, string> = {
  tradability: "Easy to buy and sell",
  catalyst: "Has news or earnings",
  market: "Market heading the same way",
  sector: "Its industry heading the same way",
  rel_strength: "Doing better than the market",
  rvol: "Busier trading than usual",
  levels: "Past a key price level",
  trend: "Steady trend",
  trigger: "Buy signal fired and holding",
  room: "Room to move before the next level",
  rr_size: "Enough upside for the risk",
  extension: "Not chasing a stock that already ran",
};

const SCORECARD_GATE_HINT: Record<string, string> = {
  tradability: "small gap between buy and sell prices, and enough dollars traded each day; for a short: the stock can be borrowed",
  catalyst: "fresh news since yesterday's close, or earnings coming up soon",
  market: "SPY and QQQ above today's average price and yesterday's close (below, for a short)",
  sector: "the stock's industry fund (e.g. SMH for chips) the same way",
  rel_strength: "the stock is up more than SPY since the open and since yesterday's close",
  rvol: "today's volume so far vs the usual volume by this time of day",
  levels: "trading above the first minutes' high or yesterday's high (below the low, for a short)",
  trend: "higher highs and higher lows on 5-minute bars (lower, for a short)",
  trigger: "the buy rule (a break above the first minutes' range or a key price) fired and is still holding",
  room: "distance to the next key price, in multiples of the risk, at least the minimum below",
  rr_size: "the planned upside is at least the minimum × the risk, and the trade fits the size limits",
  extension: "price is stretched far past its short-term average, or the stock already moved much more than its usual daily range since the open; such stocks lose points",
};

/** Default weights (sum 100). Weights are relative: the score is normalised over the components with data. */
export const SCORECARD_WEIGHTS: Record<string, number> = {
  tradability: 8, catalyst: 8, market: 8, sector: 6, rel_strength: 8, rvol: 8, levels: 2, trend: 8, trigger: 6,
  room: 8, rr_size: 6, extension: 8, vwap: 2, ema: 2, rsi: 3, macd: 3, float: 2, fundamentals: 2, valuation: 2,
};

export const SCORECARD_PART_LABEL: Record<string, string> = {
  ...SCORECARD_GATE_LABEL,
  vwap: "Price vs today's average price",
  ema: "Short-term average prices",
  rsi: "Momentum, not overheated",
  macd: "Momentum turning up",
  float: "How much of the stock trades",
  fundamentals: "Company finances",
  valuation: "Price vs similar companies",
  sentiment: "Social media mood",
};

/** Off / warn / block, as the owner reads them. Stored values stay the same. */
const GATE_OPTION_LABEL: Record<string, string> = { off: "Ignore", warn: "Tell Claude", block: "Stop the trade" };
const MODEL_LABEL: Record<string, string> = { haiku: "Haiku (cheapest)", sonnet: "Sonnet", opus: "Opus (most capable)" };

/**
 * Extra checks before an entry (borrowed from TradingAgents): a bear case argued by a separate cheap
 * Claude call, Claude's own past trades in the stock, and optional StockTwits sentiment. Kept out of
 * SCORECARD_WEIGHTS so the default weights still sum to 100 and existing scores don't move: sentiment
 * only scores when it is on (weights are normalised over the components with data).
 * Mirrors docs/SETTINGS_CONTRACT.md "Checks".
 */
export const CHECK_LIMITS: LimitDef[] = [
  { key: "bear_mode", group: "Checks", label: "Second opinion against each trade", kind: "select", options: ["off", "warn", "block"], optionLabels: GATE_OPTION_LABEL, def: "warn", hint: "a separate, cheap Claude call argues against each trade first. Tell Claude: it must answer the case. Stop the trade: the trade is stopped when the case against wins" },
  { key: "bear_block_conf", group: "Checks", label: "Stop the trade when the case against is at least", unit: "%", kind: "number", min: 0, max: 100, int: true, def: 70, hint: "how sure the second opinion is" },
  { key: "bear_model", group: "Checks", label: "Second opinion model", kind: "select", options: ["haiku", "sonnet", "opus"], optionLabels: MODEL_LABEL, def: "haiku", hint: "counts toward the weekly usage cap" },
  { key: "memory_trades", group: "Checks", label: "Past trades Claude sees per stock", unit: "", kind: "number", min: 0, max: 20, int: true, def: 0, hint: "how many of this box's past trades in a stock Claude (and the second opinion) sees. 0 = none (the default: \"lost here before\" made Claude pass on good setups)" },
  { key: "sentiment", group: "Checks", label: "Social media mood (StockTwits)", kind: "select", options: ["off", "stocktwits"], optionLabels: { off: "Off", stocktwits: "StockTwits" }, def: "off", hint: "adds bullish/bearish chatter to the score. StockTwits currently blocks automated access, so it has no effect yet" },
  // Same shape as the generated w_* weights (Scorecard weights), shown next to the switch it belongs to.
  { key: "w_sentiment", group: "Checks", label: "Social media mood weight", unit: "", kind: "number", min: 0, max: 100, def: 10, hint: "only when social media mood is on" },
];

export const SCORECARD_LIMITS: LimitDef[] = [
  { key: "scorecard", group: "Scorecard", label: "Score every stock before buying", kind: "bool", def: true, hint: "off = Claude can still rate stocks; nothing is enforced" },
  { key: "min_score", group: "Scorecard", label: "Lowest score to buy", unit: "", kind: "number", min: 0, max: 100, def: 0, hint: "0 = advice only (Claude prefers higher scores but decides)" },
  { key: "max_spread_pct", group: "Scorecard", label: "Largest gap between buy and sell price", unit: "%", kind: "number", min: 0.01, max: 100, def: 0.5, hint: "of the price, from Alpaca's quotes (15 minutes delayed)" },
  { key: "min_avg_dollar_vol", group: "Scorecard", label: "Least dollars traded per day", unit: "$", kind: "number", min: 0, max: 1_000_000_000_000, def: 5_000_000, hint: "20-day average" },
  { key: "min_rvol", group: "Scorecard", label: "How much busier than usual", unit: "×", kind: "number", min: 0, max: 100, def: 1, hint: "today's volume vs the usual volume by this time of day; 1 = normal" },
  { key: "earnings_window_days", group: "Scorecard", label: "Earnings count as news within", unit: "days", kind: "number", min: 0, max: 30, int: true, def: 1 },
  { key: "max_vwap_atr", group: "Scorecard", label: "Don't chase: how far past its short-term average", unit: "×", kind: "number", min: 0.1, max: 20, def: 1.5, hint: "how far the price may be beyond its 5-minute 9-EMA (above for a buy, below for a short), measured in the stock's normal daily ranges (daily ATRs). Further out counts as chasing" },
  { key: "max_adr_used", group: "Scorecard", label: "Don't chase: how far since the open", unit: "×", kind: "number", min: 0.1, max: 20, def: 2, hint: "how far the stock may have moved since the open, in daily ATRs (its normal daily range). More than this counts as chasing" },
  { key: "extension_penalty", group: "Scorecard", label: "Don't chase: score points taken off", unit: "", kind: "number", min: 0, max: 100, def: 15, hint: "on top of its weight; 0 = only the weight" },
  ...SCORECARD_GATES.map(
    (g): LimitDef => ({
      key: `gate_${g}`,
      group: "Scorecard gates",
      label: SCORECARD_GATE_LABEL[g],
      kind: "select",
      options: ["off", "warn", "block"],
      optionLabels: GATE_OPTION_LABEL,
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

const TURN_LABEL: Record<string, string> = { off: "Ignore", wake: "Ask Claude to look", exit: "Sell" };

/**
 * Smart exits (stocky-trader bin/exit_manager.py): the Mac manages each Claude box's open trades every
 * minute between runs. "× the risk" = multiples of the distance from the entry to the first stop. A stop
 * only moves toward the price. Also the after-close review (bin/reviewer.py). Mirrors
 * docs/SETTINGS_CONTRACT.md "Exits".
 */
export const EXIT_LIMITS: LimitDef[] = [
  { key: "breakeven_at_r", group: "Exits", label: "Once up by this × the risk, move the stop to the entry price", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "measured at the best price since buying; the trade can then no longer lose. 0 = off" },
  { key: "trail_mode", group: "Exits", label: "Stop that follows the price up", kind: "select", options: ["off", "atr", "pct"], optionLabels: { off: "Off", atr: "By normal price swings", pct: "By a percentage" }, def: "atr", hint: "keeps the stop a set distance behind the best price so far" },
  { key: "trail_start_r", group: "Exits", label: "Start following once up by", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "× the risk" },
  { key: "trail_atr_mult", group: "Exits", label: "Follow this many normal swings behind", unit: "×", kind: "number", min: 0.1, max: 20, def: 2, hint: "normal 5-minute price swings" },
  { key: "trail_pct", group: "Exits", label: "Follow this far behind", unit: "%", kind: "number", min: 0.05, max: 50, def: 1 },
  { key: "partial_pct", group: "Exits", label: "Sell part of the trade early", unit: "%", kind: "number", min: 0, max: 100, def: 0, hint: "of the whole shares, once, at the level below; the rest keeps its stop and target. 0 = off" },
  { key: "partial_r", group: "Exits", label: "…once up by", unit: "×", kind: "number", min: 0.1, max: 20, def: 1, hint: "× the risk" },
  { key: "time_stop_min", group: "Exits", label: "Act on a trade that goes nowhere after", unit: "min", kind: "number", min: 0, max: 1440, int: true, def: 120, hint: "market minutes since buying; 0 = off" },
  { key: "time_stop_min_r", group: "Exits", label: "…unless it's up by at least", unit: "×", kind: "number", min: 0, max: 20, def: 0.3, hint: "× the risk, by then" },
  { key: "time_stop_mode", group: "Exits", label: "When a trade goes nowhere", kind: "select", options: ["off", "wake", "exit"], optionLabels: TURN_LABEL, def: "wake", hint: "Ask Claude to look: Claude decides. Sell: the Mac sells" },
  { key: "market_turn_mode", group: "Exits", label: "When the market turns against a trade", kind: "select", options: ["off", "wake", "exit"], optionLabels: TURN_LABEL, def: "wake", hint: "SPY (or the stock's industry fund) crosses today's average price against the trade, or SPY moves the % below against it" },
  { key: "market_turn_pct", group: "Exits", label: "Market turn: SPY moves against the trade by", unit: "%", kind: "number", min: 0.05, max: 20, def: 0.5, hint: "since buying" },
  { key: "review", group: "Exits", label: "Daily review after the close", kind: "bool", def: true, hint: "one cheap Claude call per box per trading day; writes lessons Claude reads the next morning. Counts toward the weekly usage cap" },
  { key: "shadow_review", group: "Exits", label: "Check what the skipped stocks did", kind: "bool", def: true, hint: "after the close: how the stocks Claude passed on or was stopped from buying did, per check" },
  { key: "review_model", group: "Exits", label: "Review model", kind: "select", options: ["haiku", "sonnet", "opus"], optionLabels: MODEL_LABEL, def: "haiku", hint: "Haiku once usage passes the slow-down %" },
  { key: "use_lessons", group: "Exits", label: "Claude reads its lessons & suggestions", kind: "bool", def: true, hint: "the review's notes below; remove any you disagree with" },
  { key: "lessons_count", group: "Exits", label: "How many it reads", unit: "", kind: "number", min: 0, max: 20, int: true, def: 8, hint: "the newest of each kind (lessons, suggestions)" },
];

/** Newer Claude-box keys; mirror stocky-trader bin/limits.py. */
export const CLAUDE_EXTRA_LIMITS: LimitDef[] = [
  { key: "market_read", group: "Checks", label: "Show Claude the market's mood each run", kind: "bool", def: true, hint: "SPY and QQQ against today's average price, and how many breakouts are still holding. Information only; never stops a trade" },
  { key: "flatten_backup", group: "When to trade", label: "Mac sells leftovers at 'Sell everything by'", kind: "bool", def: true, hint: "if Claude hasn't closed everything by that time, the Mac sells the remaining shares" },
  { key: "entry_orders", group: "How it decides", label: "Order types Claude may use to buy", hint: "the In-play board's armed setups wait at their trigger price, so they need the second choice", kind: "select", options: ["market_limit", "all"], optionLabels: { market_limit: "Market or limit (now)", all: "Also wait at a price (buy-stop or pullback limit)" }, def: "all" },
  { key: "bear_fail_closed", group: "Checks", label: "If the second opinion can't run, stop the trade", kind: "bool", def: false, hint: "only when the second opinion is set to Stop the trade" },
  { key: "min_stop_atr", group: "Money & risk", label: "Stop at least this many normal 5-minute swings away", unit: "×", kind: "number", min: 0, max: 5, def: 0, hint: "measured on 5-minute bars (ATR) at the time of the scorecard; 0 = off" },
  { key: "max_breakout_age_min", group: "How it decides", label: "Treat a breakout older than this as late", unit: "min", kind: "number", min: 0, max: 240, int: true, def: 0, hint: "minutes; 0 = off" },
  { key: "target_r", group: "Exits", label: "Take profit at (× the risk) on in-play board trades", unit: "×", kind: "number", min: 0, max: 20, def: 2, hint: "2 = sell at a profit twice the amount risked. 0 = no fixed target: the stop and the trailing stop end the trade (a runner). Claude can still name its own target on a trade" },
  { key: "lesson_min_trades", group: "Learning", label: "Trades needed before Claude writes lessons", unit: "", kind: "number", min: 0, max: 200, int: true, def: 0, hint: "0 = any time; around 20 avoids lessons drawn from noise" },
];

/**
 * The intraday board (Free Choice only; the My List box ignores these): the Mac ranks the whole market and
 * finds setups with a trigger and a stop. Mirrors docs/SETTINGS_CONTRACT.md "Intraday board".
 */
export const BOARD_SETUPS = ["pmh", "orh", "orb", "hod", "pullback", "reclaim", "bounce"];
export const BOARD_LIMITS: LimitDef[] = [
  { key: "board", group: "In-play board", label: "Use the in-play board", kind: "bool", def: true, hint: "the Mac ranks the whole market every ~2 minutes for stocks that are moving today, finds a buy point and stop for each, and wakes Claude on the best. Off = the older once-a-day opening-range scan" },
  { key: "board_top_n", group: "In-play board", label: "Stocks shown per side", unit: "", kind: "number", min: 1, max: 30, int: true, def: 10, hint: "how many rising stocks Claude sees in full, and the same number of falling ones for shorts (shorts are no longer halved). Fewer = fewer wake-ups and a cheaper week" },
  { key: "board_watch_n", group: "In-play board", label: "Stocks watched for setups (per side)", unit: "", kind: "number", min: 5, max: 60, int: true, def: 30, hint: "setups are worked out for this many stocks on each side; Claude is shown the top \"Stocks shown\" plus any of these whose setup is triggering. Must be at least \"Stocks shown per side\"" },
  { key: "early_or_minutes", group: "In-play board", label: "Early opening range", kind: "select", options: ["1", "2", "3", "5", "10"], optionLabels: { "1": "1 min", "2": "2 min", "3": "3 min", "5": "5 min", "10": "10 min" }, def: "5", hint: "the first minutes after the bell whose high and low the early range break (orh, or orl for a short) is measured from" },
  { key: "inplay_min_price", group: "In-play board", label: "Lowest share price", unit: "$", kind: "number", min: 0, max: 100_000, def: 5, hint: "stocks under this price never make the board" },
  { key: "inplay_min_change_pct", group: "In-play board", label: "Must be up or down at least", unit: "%", kind: "number", min: 0, max: 100, def: 2, hint: "versus yesterday's close, in either direction, to count as in play" },
  { key: "premarket_min_vol_pct", group: "In-play board", label: "Minimum pre-market volume", unit: "%", kind: "number", min: 0, max: 100, def: 0.3, hint: "before the open a gapper is left out when its pre-market volume is under this % of its normal full-day volume (20-day average); a stock whose volume isn't in the delayed tape yet is kept. 0 = no minimum" },
  { key: "inplay_min_rvol", group: "In-play board", label: "Must be this much busier than usual", unit: "×", kind: "number", min: 0, max: 100, def: 1.5, hint: "trading volume so far today versus a normal day by this time (1.5 = half as much again)" },
  { key: "board_regime", group: "In-play board", label: "Follow the market's direction", kind: "select", options: ["off", "inform", "filter"], optionLabels: { off: "Ignore", inform: "Show Claude", filter: "Hide trades against it" }, def: "filter", hint: "SPY and QQQ together. Show Claude: the board's header says which way the market is going. Hide trades against it: when both are clearly up there are no shorts on the board, when both are clearly down no buys" },
  { key: "regime_pct", group: "In-play board", label: "A clear up or down market is at least", unit: "%", kind: "number", min: 0, max: 10, def: 0.3, hint: "how far SPY and QQQ must both be from yesterday's close" },
  { key: "board_setups", group: "In-play board", label: "Kinds of setup to look for", kind: "words", options: BOARD_SETUPS, optionLabels: { pmh: "Pre-market high break", orh: "Early range break", orb: "Range break", hod: "New high of day", pullback: "First pullback", reclaim: "VWAP reclaim", bounce: "Failed bounce (short)" }, def: "pmh,orh,orb,hod,pullback", hint: "pmh = break of the pre-market high (or low, for a short). orh = break of the early range (the first minutes set below). orb = break of the opening range. hod = a new high (or low) after a pause. pullback = the first pullback in an uptrend. reclaim = VWAP reclaim. bounce = a short on a failed bounce. VWAP reclaim and Failed bounce are off by default; they lost money in the replays" },
  { key: "board_wakes_per_symbol", group: "In-play board", label: "Most wake-ups per stock per day", unit: "", kind: "number", min: 0, max: 100, int: true, def: 3, hint: "how many times one stock may wake Claude in a day. Later setups in it are still shown on the scheduled runs. 0 = no limit" },
  { key: "board_rewake_datr", group: "In-play board", label: "Wake again on a new high only if it is this much further", unit: "×", kind: "number", min: 0, max: 10, def: 0.25, hint: "a new high (or low) after a pause wakes Claude again only when it is at least this many daily ATRs (the stock's normal daily range) beyond the last level that woke it. 0 = every new level wakes" },
  { key: "max_chase_r", group: "In-play board", label: "Max chase past the trigger", unit: "R", kind: "number", min: 0, max: 5, def: 0.5, hint: "won't buy at market when the price is already more than this many R past the setup's trigger (R = trigger to stop); 0 = no limit" },
  { key: "stop_max_datr", group: "In-play board", label: "Widest stop allowed", unit: "×", kind: "number", min: 0.1, max: 5, def: 0.5, hint: "a board setup's stop is never further from its buy point than this many daily ATRs (the stock's normal daily range). Wider setups are tightened or skipped" },
];

export const CLAUDE_LIMITS: LimitDef[] = [
  { key: "enabled", group: "Risk & size", label: "Box is on", kind: "bool", def: true, hint: "off = the watcher starts no Claude runs for this box (no scans, no review); the Mac still manages exits for what it holds" },
  // Risk & size
  { key: "budget", group: "Risk & size", label: "Box size", unit: "$", kind: "number", min: 100, max: 1_000_000, def: 5000, hint: "what Claude sizes its trades from" },
  { key: "max_loss_per_trade_usd", group: "Risk & size", label: "Most I can lose on one trade", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 50, hint: "if the trade hits its stop" },
  { key: "max_daily_loss_usd", group: "Risk & size", label: "Total risk Claude may take per day", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 150, hint: "adds up each trade's worst case (its loss at the stop)" },
  { key: "max_trades_per_day", group: "Risk & size", label: "Most trades per day", unit: "", kind: "number", min: 0, max: 500, int: true, def: 3, hint: "0 = unlimited" },
  { key: "max_orders_per_day", group: "Risk & size", label: "Most orders per day", unit: "", kind: "number", min: 1, max: 2000, int: true, def: 10, hint: "every order placed, sells included" },
  { key: "max_order_usd", group: "Risk & size", label: "Largest single order", unit: "$", kind: "number", min: 1, max: 1_000_000, def: 4000 },
  { key: "max_position_pct", group: "Risk & size", label: "Biggest single holding (% of box)", unit: "%", kind: "number", min: 1, max: 400, def: 75, hint: "of the box's current value; over 100 needs borrowing (margin) on" },
  { key: "cash_buffer_pct", group: "Risk & size", label: "Cash kept aside", unit: "%", kind: "number", min: 0, max: 90, def: 0, hint: "% of the box never invested; 0 = it may spend it all" },
  { key: "min_order_usd", group: "Risk & size", label: "Smallest order", unit: "$", kind: "number", min: 0, max: 1_000_000, def: 5, hint: "0 = off" },
  { key: "min_reward_risk", group: "Risk & size", label: "Least upside per $ risked", unit: "×", kind: "number", min: 0, max: 20, def: 1, hint: "× the risk: 2 = the target must be at least twice as far as the stop. 0 = off" },
  // Timing
  { key: "no_entries_before", group: "Timing", label: "Start buying at (NY time)", kind: "time", def: "09:30", allowOff: true, hint: "off = from the open" },
  { key: "no_entries_after", group: "Timing", label: "Stop buying at (NY time)", kind: "time", def: "15:30", allowOff: true, hint: "off = until the close" },
  { key: "flat_by", group: "Timing", label: "Sell everything by (NY time)", kind: "time", def: "15:55", allowOff: true, hint: "off = may hold overnight (the stop and target orders stay at Alpaca; part-shares are still sold before the close). On a half-day: 5 minutes before the close at the latest" },
  { key: "or_minutes", group: "Timing", label: "Length of the opening range", kind: "select", options: ["5", "10", "15", "20", "30", "45", "60"], optionLabels: { "5": "5 min", "10": "10 min", "15": "15 min", "20": "20 min", "30": "30 min", "45": "45 min", "60": "60 min" }, def: "15", hint: "the first minutes after the open whose high and low a breakout is measured from; Claude can still pick another for one trade" },
  // Symbols
  { key: "blocked", group: "Symbols", label: "Never trade", kind: "symbols", def: "", hint: "comma-separated tickers" },
  { key: "allow_reentry", group: "Symbols", label: "Let Claude re-buy a stock it already traded today", kind: "bool", def: false },
  { key: "fractional", group: "Risk & size", label: "Buy part-shares", kind: "bool", def: true, hint: "whole shares get a stop and target order; the part-share gets its own same-day stop" },
  { key: "allow_margin", group: "Risk & size", label: "Allow borrowing (margin) during the day", kind: "bool", def: false, hint: "lets a buy use borrowed money up to the multiple below; cash kept aside stops applying. More risk" },
  { key: "margin_multiplier", group: "Risk & size", label: "Borrow up to", unit: "×", kind: "number", min: 1, max: 4, def: 2, hint: "buying power as a multiple of the box. Alpaca's own limit is shared by all boxes" },
  { key: "pdt_guard", group: "Risk & size", label: "Pattern-day-trader check", kind: "bool", def: false, hint: "blocks a 4th same-day round trip in 5 business days (a US rule for small accounts)" },
  { key: "min_stop_pct", group: "Risk & size", label: "Stop at least this far below the price", unit: "%", kind: "number", min: 0, max: 90, def: 0.05, hint: "0 = off" },
  { key: "allow_loosen_stop", group: "Risk & size", label: "Let Claude move a stop further away", kind: "bool", def: false, hint: "off = a stop can only be tightened. A stop is always kept" },
  { key: "allow_short", group: "Risk & size", label: "Allow short selling", kind: "bool", def: false, hint: "lets Claude bet a stock will fall. Whole shares only. A sudden jump up can lose more than the stop. Only stocks no other box holds or has an order on" },
  ...SCORECARD_LIMITS,
  ...EXIT_LIMITS,
  ...CLAUDE_EXTRA_LIMITS,
  ...BOARD_LIMITS,
];

export const RUNNER_LIMITS: LimitDef[] = [
  // Schedule
  { key: "interval_min", group: "Schedule", label: "Claude checks every", unit: "min", kind: "number", min: 1, max: 240, int: true, def: 15, hint: "in market hours" },
  { key: "premarket_early", group: "Schedule", label: "Early look (NY time)", kind: "time", def: "08:00", allowOff: true, tmin: "04:00", tmax: "09:29", hint: "overnight news, earnings, price gaps; news can wake Claude from here to the open" },
  { key: "premarket_time", group: "Schedule", label: "Before-the-open check (NY time)", kind: "time", def: "09:15", allowOff: true, tmin: "07:00", tmax: "09:29" },
  { key: "flatten_lead_min", group: "Schedule", label: "Start the sell-everything run this early", unit: "min", kind: "number", min: 1, max: 30, int: true, def: 5, hint: "minutes before 'Sell everything by'" },
  { key: "run_timeout_s", group: "Schedule", label: "Give up on a run after", unit: "s", kind: "number", min: 60, max: 3600, int: true, def: 720 },
  // Usage
  { key: "model", group: "Usage", label: "Model", kind: "select", options: ["sonnet", "opus", "haiku"], optionLabels: MODEL_LABEL, def: "sonnet" },
  { key: "weekly_cap_usd", group: "Usage", label: "Weekly usage cap", unit: "$", kind: "number", min: 0, max: 100_000, def: 30, hint: "in API-equivalent dollars; 0 = no cap" },
  { key: "throttle_pct", group: "Usage", label: "Slow down at", unit: "%", kind: "number", min: 0, max: 100, def: 80, hint: "of the weekly cap; 0 = never slow down" },
  { key: "throttle_interval_min", group: "Usage", label: "…then check every", unit: "min", kind: "number", min: 1, max: 240, int: true, def: 60 },
  // News
  { key: "news_wake", group: "News", label: "Wake Claude on important news", kind: "bool", def: true },
  { key: "wake_min_gap_min", group: "News", label: "Wait at least this long between news wake-ups", unit: "min", kind: "number", min: 1, max: 120, int: true, def: 5 },
  { key: "news_ticker_cooldown_min", group: "News", label: "Wait this long before waking on the same stock again", unit: "min", kind: "number", min: 0, max: 600, int: true, def: 60, hint: "for a stock the box does not hold; new articles on the same story are marked seen meanwhile. Stocks it holds always wake Claude. 0 = off" },
  { key: "news_scope", group: "News", label: "News about", kind: "select", options: ["held", "held_and_list", "market"], optionLabels: { held: "Stocks held", held_and_list: "Stocks held + my list", market: "Whole market (board books)" }, def: "held_and_list", hint: "\"+ my list\": the Claude · My List box also watches your list. \"Whole market\": the Claude · Free Choice box (with the in-play board on) also reads Alpaca's market-wide news about once a minute from 07:55 and wakes on a tagged headline about any stock that passes its price and volume floor; the My List box treats it like \"Stocks held + my list\"" },
  { key: "news_wakes_per_day", group: "News", label: "Most news wake-ups per box per day", unit: "", kind: "number", min: 0, max: 500, int: true, def: 20, hint: "every news wake-up counts; after the cap only news about stocks the box holds wakes Claude. 0 = no limit" },
  { key: "news_tags", group: "News", label: "Kinds of news that wake Claude", kind: "tags", def: "earnings,deal,legal,risk,halt,regulatory,people,analyst,capital,macro", hint: "comma-separated, lowercase" },
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
    } else if (d.kind === "words") {
      const got = String(v).split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (got.length === 0) continue; // empty = default
      const bad = got.filter((x) => !d.options?.includes(x));
      if (bad.length) {
        errors.push(`${d.label}: choose from ${d.options?.join(", ")}`);
        continue;
      }
      out[d.key] = (d.options ?? []).filter((o) => got.includes(o)).join(","); // the Mac's order
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

  // Over 100% of the book needs borrowed money: only with margin on.
  if (has("max_position_pct") && has("allow_margin") && Number(val("max_position_pct")) > 100 && val("allow_margin") !== true) {
    errors.push("Max position size over 100% needs Allow margin on");
  }
  // Slowing down must not run more often than normal.
  if (has("throttle_interval_min") && has("interval_min") && Number(val("throttle_interval_min")) < Number(val("interval_min"))) {
    errors.push("The slowed-down interval must be at least the normal run interval");
  }
  // The early look comes before the pre-market scan (when both are on).
  if (has("premarket_early") && has("premarket_time")) {
    const early = val("premarket_early");
    const scan = val("premarket_time");
    if (typeof early === "string" && typeof scan === "string" && TIME_RE.test(early) && TIME_RE.test(scan) && toMin(early) > toMin(scan)) {
      errors.push("The early look must not be later than the pre-market scan");
    }
  }

  // The board works out setups for at least the stocks it shows.
  if (has("board_watch_n") && has("board_top_n") && Number(val("board_watch_n")) < Number(val("board_top_n"))) {
    errors.push("\"Stocks watched for setups\" must be at least \"Stocks shown per side\"");
  }

  if (has("min_stop_pct") && has("max_stop_pct")) {
    const lo = Number(val("min_stop_pct"));
    const hi = Number(val("max_stop_pct"));
    if (lo > hi) errors.push("\"Stop at least this far\" must not be more than \"Stop at most this far\"");
  }

  // Time order: before < after < flat_by, over the ones that are set (not off).
  const order = [
    ["no_entries_before", "Start buying at"],
    ["no_entries_after", "Stop buying at"],
    ["flat_by", "Sell everything by"],
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

/**
 * Only the values that differ from their defaults (what a book stores), so a box saved before a
 * default changed still picks up the new default. Missing keys = defaults (the Mac merges the same way:
 * stocky-trader bin/limits.py apply_web).
 */
export function overridesOnly(defs: LimitDef[], settings: Settings): Settings {
  const out: Settings = {};
  for (const d of defs) {
    if (!(d.key in settings)) continue;
    const v = settings[d.key];
    if (v === d.def || (typeof v === "number" && typeof d.def === "number" && Math.abs(v - d.def) < 1e-9)) continue;
    out[d.key] = v;
  }
  return out;
}

/**
 * Saved settings made safe for an engine: each value re-validated against its definition (clamped,
 * rounded, parsed); a value that can't be read falls back to the default. Saved rows can predate a bound.
 */
export function clampSaved(defs: LimitDef[], saved: Record<string, unknown> | null | undefined): Settings {
  const out: Settings = {};
  for (const d of defs) {
    const v = saved?.[d.key];
    if (v === undefined || v === null) continue;
    const r = validateLimits([d], { [d.key]: v });
    if (r.ok && d.key in r.settings) out[d.key] = r.settings[d.key];
  }
  return out;
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

/** Whether a box is switched on (settings.enabled; missing or unreadable = on, like every default). */
export function boxEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const v = settings?.enabled;
  if (v === undefined || v === null) return true;
  return parseBool(v) !== false;
}
