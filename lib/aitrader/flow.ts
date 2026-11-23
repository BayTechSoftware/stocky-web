/**
 * The "How it works — live" flow chart for the Claude boxes: the steps the Mac records in ai_events,
 * grouped by step, counted per New York day, and filtered to one stock's path. Pure (no server
 * imports), so the client component and the server action share it.
 */

/** The flow, in the order a trade moves through it. */
export const FLOW_STEPS = ["watch", "wake", "look", "decide", "check", "order", "fill", "exit", "close"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];
/** A recorded step: one of the flow's, or a failure. */
export type EventStep = FlowStep | "error";
export const EVENT_STEPS: readonly EventStep[] = [...FLOW_STEPS, "error"];

export interface AiEvent {
  id: number;
  at: string;
  step: EventStep;
  symbol: string | null;
  /** One plain-English sentence. */
  title: string;
  /** true = ok / allowed, false = blocked / failed, null = neutral. */
  ok: boolean | null;
  /** Groups the events of one Claude run. */
  run_ref: string | null;
  detail: Record<string, unknown> | null;
}

export const STEP_LABEL: Record<EventStep, string> = {
  watch: "Watching",
  wake: "Woke Claude",
  look: "Claude looked",
  decide: "Decided",
  check: "Risk check",
  order: "Order sent",
  fill: "Filled",
  exit: "Managing exits",
  close: "End of day",
  error: "Problems",
};

/** What each step means, in plain words (shown under the step name). */
export const STEP_HINT: Record<EventStep, string> = {
  watch: "The Mac checks every minute and says why it is waiting.",
  wake: "Why the Mac asked Claude to take a look.",
  look: "What Claude was shown: the board, the news, what it holds.",
  decide: "Each choice Claude made, and why.",
  check: "Your limits checked against each order.",
  order: "Orders placed at Alpaca (paper).",
  fill: "Orders that went through, and at what price.",
  exit: "The Mac looking after open trades: stops moved, time and market-turn exits.",
  close: "Closing out at the end of the day, or deciding what to hold overnight.",
  error: "Something went wrong.",
};

const STEP_SET = new Set<string>(EVENT_STEPS);
export const isEventStep = (s: unknown): s is EventStep => typeof s === "string" && STEP_SET.has(s);

/** A database row as an AiEvent; null when it isn't one (unknown step, missing fields). */
export function toEvent(row: unknown): AiEvent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : typeof r.id === "string" ? Number(r.id) : NaN;
  if (!Number.isFinite(id) || typeof r.at !== "string" || !isEventStep(r.step)) return null;
  const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : null;
  return {
    id,
    at: r.at,
    step: r.step,
    symbol: typeof r.symbol === "string" && r.symbol ? r.symbol.toUpperCase() : null,
    title: typeof r.title === "string" ? r.title : "",
    ok: typeof r.ok === "boolean" ? r.ok : null,
    run_ref: typeof r.run_ref === "string" ? r.run_ref : null,
    detail,
  };
}

export const toEvents = (rows: unknown[] | null | undefined): AiEvent[] =>
  (rows ?? []).map(toEvent).filter((e): e is AiEvent => e != null);

/* ---------------- New York dates ---------------- */

const NY = "America/New_York";
const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: NY });
const NY_OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "longOffset" });
const NY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" });
const NY_DAY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", hour: "numeric", minute: "2-digit" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === "string" && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** The New York calendar date (YYYY-MM-DD) of an instant. */
export const nyDate = (d: Date = new Date()): string => NY_DATE.format(d);

/** A YYYY-MM-DD date `n` calendar days later (negative = earlier). */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T12:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
export const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();

/** New York's UTC offset ("-05:00" / "-04:00") at midnight starting `day`. */
export function nyOffset(day: string): string {
  // 05:00Z is midnight EST / 1 am EDT: both before the 2 am switch, so this is midnight's own offset.
  const v = NY_OFFSET.formatToParts(new Date(`${day}T05:00:00Z`)).find((p) => p.type === "timeZoneName")?.value;
  const off = v?.replace("GMT", "");
  return off && /^[+-]\d{2}:\d{2}$/.test(off) ? off : "-05:00";
}

/** The New York day `day` as UTC ISO instants: [start, end). */
export function nyDayBounds(day: string): { start: string; end: string } {
  const next = addDays(day, 1);
  return {
    start: new Date(`${day}T00:00:00${nyOffset(day)}`).toISOString(),
    end: new Date(`${next}T00:00:00${nyOffset(next)}`).toISOString(),
  };
}

/** Today plus the weekdays among the previous `span - 1` calendar days, newest first. */
export function recentDays(today: string, span = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(today, -i);
    const wd = weekday(d);
    if (i === 0 || (wd !== 0 && wd !== 6)) out.push(d);
  }
  return out;
}

/** Whether `day` is one of the last `span` calendar days (today included). */
export const inRecent = (day: string, today: string, span = 7): boolean =>
  isDay(day) && day <= today && day >= addDays(today, -(span - 1));

/** How far back a stock's path reaches: a week of calendar days, about five trading days. */
export const SYMBOL_SPAN_DAYS = 7;

/** "Today", "Yesterday" or "Fri, Nov 20". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return DAY_LABEL.format(new Date(`${day}T12:00:00Z`));
}

/** "9:41 AM" New York time (with the weekday when `withDay`). */
export const nyTime = (iso: string, withDay = false): string => (withDay ? NY_DAY_TIME : NY_TIME).format(new Date(iso));

/* ---------------- grouping ---------------- */

export interface StepSummary {
  count: number;
  /** Blocked / failed events (ok = false; every "error"). */
  failed: number;
  latest: AiEvent | null;
  /** Stocks seen at this step, most recent first. */
  symbols: string[];
}

export type FlowSummary = Record<EventStep, StepSummary>;

export const isFailed = (e: Pick<AiEvent, "step" | "ok">): boolean => e.step === "error" || e.ok === false;

/** How the feed colours an event. */
export const toneOf = (e: Pick<AiEvent, "step" | "ok">): "ok" | "bad" | "neutral" =>
  isFailed(e) ? "bad" : e.ok === true ? "ok" : "neutral";

/** "blocked" for a risk check, "failed" otherwise. */
export const failedWord = (step: EventStep): string => (step === "check" ? "blocked" : "failed");

const later = (a: AiEvent | null, b: AiEvent): boolean => !a || b.at > a.at || (b.at === a.at && b.id > a.id);

/**
 * Count, failures, latest event and stocks per step. `watch` replaces the watch step's numbers when the
 * minute checks were counted separately (they are too many to fetch one by one).
 */
export function summarize(events: AiEvent[], watch?: { count: number; failed: number; latest: AiEvent | null }): FlowSummary {
  const out = {} as FlowSummary;
  for (const s of EVENT_STEPS) out[s] = { count: 0, failed: 0, latest: null, symbols: [] };
  const seen = {} as Record<EventStep, Map<string, string>>;
  for (const s of EVENT_STEPS) seen[s] = new Map();
  for (const e of events) {
    const g = out[e.step];
    g.count++;
    if (isFailed(e)) g.failed++;
    if (later(g.latest, e)) g.latest = e;
    if (e.symbol) {
      const prev = seen[e.step].get(e.symbol);
      if (!prev || e.at > prev) seen[e.step].set(e.symbol, e.at);
    }
  }
  for (const s of EVENT_STEPS) {
    out[s].symbols = [...seen[s].entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([sym]) => sym);
  }
  if (watch) out.watch = { count: watch.count, failed: watch.failed, latest: watch.latest, symbols: [] };
  return out;
}

/** Total recorded events in a summary. */
export const totalCount = (s: FlowSummary): number => EVENT_STEPS.reduce((a, k) => a + s[k].count, 0);

/** The step of the most recent event, when it happened within `windowMs` of `nowMs` (else null). */
export function nowStep(s: FlowSummary, nowMs: number, windowMs = 3 * 60_000): EventStep | null {
  let best: AiEvent | null = null;
  for (const k of EVENT_STEPS) {
    const e = s[k].latest;
    if (e && later(best, e)) best = e;
  }
  if (!best) return null;
  const age = nowMs - Date.parse(best.at);
  // A little slack the other way: the Mac's clock may run a few seconds ahead.
  return age <= windowMs && age >= -60_000 ? best.step : null;
}

/** One stock's events, newest first. */
export function symbolEvents(events: AiEvent[], symbol: string): AiEvent[] {
  const sym = symbol.trim().toUpperCase();
  return events.filter((e) => e.symbol === sym).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}

/** The steps a stock went through, oldest first, repeats in a row folded (e.g. wake → decide → check → order → fill → exit). */
export function pathSteps(events: AiEvent[]): EventStep[] {
  const asc = events.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  const out: EventStep[] = [];
  for (const e of asc) if (out[out.length - 1] !== e.step) out.push(e.step);
  return out;
}

/** Newest first (ties: higher id first). Doesn't mutate. */
export const newestFirst = (events: AiEvent[]): AiEvent[] =>
  events.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

const SIDE_WORD: Record<string, string> = { buy: "Bought", sell: "Sold", short: "Sold short", sell_short: "Sold short", cover: "Bought to cover" };

/** A fill's "Bought 10 at $12.34" (null for other steps or missing numbers). */
export function fillLine(e: AiEvent): string | null {
  if (e.step !== "fill" || !e.detail) return null;
  const side = typeof e.detail.side === "string" ? e.detail.side.toLowerCase() : "";
  const qty = num(e.detail.qty);
  const price = num(e.detail.price);
  if (!side || qty == null || price == null) return null;
  return `${SIDE_WORD[side] ?? side} ${qty} at $${price.toFixed(2)}`;
}

/** What the server action returns for the flow chart + feed. */
export interface AiFlowData {
  /** The New York day shown (YYYY-MM-DD). */
  day: string;
  /** New York's today, by the server's clock. */
  today: string;
  /** Set when showing one stock's path. */
  symbol: string | null;
  /** Start of the events' window (ISO): the day's start, or a week back for a stock. */
  since: string;
  /** Events for the chart's nodes, newest first: every step but the minute checks (a stock's: all of its steps). */
  nodes: AiEvent[];
  /** The minute checks, counted separately (null for a stock's path). */
  watch: { count: number; failed: number; latest: AiEvent | null } | null;
  /** The feed, newest first. */
  feed: AiEvent[];
  /** More feed rows exist beyond `feed`. */
  feedMore: boolean;
  /** The nodes hit their cap: counts are "at least". */
  truncated: boolean;
  /** When the server read this (ISO). */
  at: string;
}
