/**
 * The AI Trader's one-page box view and overview: the plain-English numbers and sentences they show.
 * Pure (no server imports), so the client components and the tests share it.
 */
import { addDays, nyDate, type EventStep } from "./flow";
import type { ExitReason } from "./ledger";

/* ---------------- time ---------------- */

const NY = "America/New_York";
const NY_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const NY_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" });
const DAY_SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

/** "13:45" New York time. */
export const nyClock = (iso: string | number): string => NY_CLOCK.format(new Date(iso));

/** "Nov 17" for a YYYY-MM-DD calendar day (no time-zone shift). */
export const shortDate = (day: string): string => DAY_SHORT.format(new Date(`${day}T12:00:00Z`));

/** A daily point's time: noon UTC on its calendar day (so a date never shifts a day either way). */
export const dayMs = (day: string): number => Date.parse(`${day}T12:00:00Z`);

/* ---------------- box vs the S&P 500 ---------------- */

export type Range = "today" | "week" | "all";
export const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "all", label: "All" },
];

/** A point on a line: time in ms, value. */
export interface Pt {
  t: number;
  v: number;
}

export interface Compare {
  /** % from the start of the period, oldest first; both start at 0 at the same time. */
  box: Pt[];
  spy: Pt[];
  boxPct: number;
  spyPct: number;
  /** boxPct − spyPct, in percentage points. */
  diffPts: number;
  /** Where the period starts (ms), for the axis label. */
  startMs: number;
}

/**
 * The period's base (the last value before `startMs`, else the first one in it) and its points from `startMs`.
 * null when nothing is in the period or the base is not a usable number.
 */
export function windowed(points: Pt[], startMs: number): { base: number; baseT: number; points: Pt[] } | null {
  const sorted = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  const inside = sorted.filter((p) => p.t >= startMs);
  if (!inside.length) return null;
  const before = sorted.filter((p) => p.t < startMs);
  const from = before.length ? before[before.length - 1] : inside[0];
  if (!(from.v > 0)) return null;
  return { base: from.v, baseT: from.t, points: before.length ? inside : inside.slice(1) };
}

const pctOf = (v: number, base: number) => (v / base - 1) * 100;

/** The box and the S&P 500 over the same period, as % from its start. null without both lines. */
export function compareSeries(box: Pt[], spy: Pt[], startMs: number): Compare | null {
  const b = windowed(box, startMs);
  const s = windowed(spy, startMs);
  if (!b || !s) return null;
  // Both lines start at 0 from the same moment: the earlier of their two bases (e.g. the close before the period).
  const origin = Math.min(b.baseT, s.baseT);
  const line = (w: { base: number; points: Pt[] }): Pt[] => [{ t: origin, v: 0 }, ...w.points.map((p) => ({ t: p.t, v: pctOf(p.v, w.base) }))];
  const boxLine = line(b);
  const spyLine = line(s);
  const boxPct = boxLine[boxLine.length - 1].v;
  const spyPct = spyLine[spyLine.length - 1].v;
  return { box: boxLine, spy: spyLine, boxPct, spyPct, diffPts: boxPct - spyPct, startMs };
}

export type Tone = "gain" | "loss" | "flat";
export const toneOf = (v: number | null | undefined, eps = 0.005): Tone => (v == null || Math.abs(v) < eps ? "flat" : v > 0 ? "gain" : "loss");

const one = (v: number) => Math.abs(v).toFixed(1);

/** "Ahead of the market by 0.6 points. The S&P 500 fell 2.2% over the same days." */
export function compareSentence(c: Pick<Compare, "boxPct" | "spyPct" | "diffPts">, range: Range): { tone: Tone; text: string } {
  const over = range === "today" ? "today" : "over the same days";
  const spy =
    Math.abs(c.spyPct) < 0.05 ? `The S&P 500 was flat ${over}.` : `The S&P 500 ${c.spyPct > 0 ? "rose" : "fell"} ${one(c.spyPct)}% ${over}.`;
  if (Math.abs(c.diffPts) < 0.05) return { tone: "flat", text: `Level with the market. ${spy}` };
  const ahead = c.diffPts > 0;
  return { tone: ahead ? "gain" : "loss", text: `${ahead ? "Ahead of" : "Behind"} the market by ${one(c.diffPts)} point${one(c.diffPts) === "1.0" ? "" : "s"}. ${spy}` };
}

/** Where the period starts (ms): Week = the last 7 calendar days, All = the box's first day. */
export function rangeStart(range: Exclude<Range, "today">, today: string, firstDay: string | null): number {
  if (range === "week") return dayMs(addDays(today, -6));
  return dayMs(firstDay ?? addDays(today, -6));
}

/**
 * A box's value by day: its start cash the day before it began, the end-of-day snapshots (ai_equity), and
 * its value now as today's point (a snapshot for today is replaced by the live value).
 */
export function boxDaily(opts: {
  series: { as_of: string; equity: number }[];
  startCash: number;
  firstDay: string | null;
  equityNow: number;
  today: string;
}): Pt[] {
  const out: Pt[] = [];
  if (opts.firstDay && opts.startCash > 0) out.push({ t: dayMs(addDays(opts.firstDay, -1)), v: opts.startCash });
  for (const s of opts.series) {
    if (s.as_of >= opts.today) continue;
    if (opts.firstDay && s.as_of < opts.firstDay) continue;
    if (Number.isFinite(s.equity)) out.push({ t: dayMs(s.as_of.slice(0, 10)), v: s.equity });
  }
  out.push({ t: dayMs(opts.today), v: opts.equityNow });
  return out;
}

/** Daily bars (Alpaca `t` is the session's ISO date) as points on their calendar day. */
export function barsDaily(bars: { t: string; c: number }[]): Pt[] {
  return bars.map((b) => ({ t: dayMs(nyDate(new Date(b.t))), v: b.c })).filter((p) => Number.isFinite(p.t) && p.v > 0);
}

/** Intraday bars as points at the end of each bar (`minutes` long). */
export function barsIntraday(bars: { t: string; c: number }[], minutes = 5): Pt[] {
  return bars.map((b) => ({ t: Date.parse(b.t) + minutes * 60_000, v: b.c })).filter((p) => Number.isFinite(p.t) && p.v > 0);
}

/**
 * The box's value through today, rebuilt from what it holds now and today's fills: at each time, the
 * positions and cash it had then (today's later fills undone), marked at that time's bar closes.
 * `cashNow` is the ledger cash (value now less the positions' value). Ends at the value now.
 */
export function intradayEquity(opts: {
  equityNow: number;
  positions: { symbol: string; qty: number; value: number; price: number | null }[];
  fills: { at: string; symbol: string; side: string; qty: number; price: number }[];
  /** Per symbol, oldest first: bar start (ISO), open and close. */
  bars: Record<string, { t: string; o: number; c: number }[]>;
  /** Times (ms) to value the box at, oldest first. */
  times: number[];
  nowMs: number;
  barMinutes?: number;
}): Pt[] {
  const barMs = (opts.barMinutes ?? 5) * 60_000;
  const cashNow = opts.equityNow - opts.positions.reduce((a, p) => a + p.value, 0);
  const qtyNow = new Map<string, number>();
  const fallback = new Map<string, number>();
  for (const p of opts.positions) {
    qtyNow.set(p.symbol, p.qty);
    const px = p.price ?? (p.qty ? p.value / p.qty : null);
    if (px != null && px > 0) fallback.set(p.symbol, px);
  }
  const fills = opts.fills.map((f) => ({ ...f, ms: Date.parse(f.at), sign: f.side === "buy" ? 1 : -1 })).filter((f) => Number.isFinite(f.ms));
  for (const f of fills) if (!fallback.has(f.symbol) && f.price > 0) fallback.set(f.symbol, f.price);
  const symbols = new Set([...qtyNow.keys(), ...fills.map((f) => f.symbol)]);
  const barsOf = new Map<string, { end: number; o: number; c: number }[]>();
  for (const s of symbols) {
    const list = (opts.bars[s] ?? [])
      .map((b) => ({ end: Date.parse(b.t) + barMs, o: b.o, c: b.c }))
      .filter((b) => Number.isFinite(b.end) && b.c > 0)
      .sort((a, b) => a.end - b.end);
    barsOf.set(s, list);
  }
  const priceAt = (s: string, t: number): number | null => {
    const list = barsOf.get(s) ?? [];
    let last: number | null = null;
    for (const b of list) {
      if (b.end <= t) last = b.c;
      else break;
    }
    if (last != null) return last;
    if (list.length) return list[0].o > 0 ? list[0].o : list[0].c;
    return fallback.get(s) ?? null;
  };

  const out: Pt[] = [];
  for (const t of opts.times) {
    if (!(t < opts.nowMs)) continue;
    let cash = cashNow;
    const qty = new Map(qtyNow);
    for (const f of fills) {
      if (f.ms <= t) continue;
      // Undo a later fill: a buy spent cash and added shares; a sell (or short) did the reverse.
      cash += f.sign * f.qty * f.price;
      qty.set(f.symbol, (qty.get(f.symbol) ?? 0) - f.sign * f.qty);
    }
    let value = 0;
    let ok = true;
    for (const [s, q] of qty) {
      if (Math.abs(q) < 1e-9) continue;
      const px = priceAt(s, t);
      if (px == null) {
        ok = false;
        break;
      }
      value += q * px;
    }
    if (ok) out.push({ t, v: cash + value });
  }
  out.push({ t: opts.nowMs, v: opts.equityNow });
  return out;
}

/* ---------------- the performance card ---------------- */

export type RiskLevel = "Low" | "Medium" | "High";

/** How much of the day's risk limit is used, as Low / Medium / High. null without both numbers. */
export function riskLevel(used: number | null | undefined, limit: number | null | undefined): { level: RiskLevel; pct: number } | null {
  if (used == null || !Number.isFinite(used) || limit == null || !(limit > 0)) return null;
  const pct = Math.max(0, (used / limit) * 100);
  return { level: pct < 25 ? "Low" : pct < 60 ? "Medium" : "High", pct };
}

/** Average winning and losing closed trade ($, losses as a positive number); null when there are none. */
export function winLoss(trades: { pnl: number }[]): { avgWin: number | null; avgLoss: number | null; winPct: number | null } {
  const wins = trades.filter((t) => t.pnl > 0.005);
  const losses = trades.filter((t) => t.pnl < -0.005);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const decided = wins.length + losses.length;
  return {
    avgWin: avg(wins.map((t) => t.pnl)),
    avgLoss: avg(losses.map((t) => -t.pnl)),
    winPct: decided ? (wins.length / decided) * 100 : null,
  };
}

/** The change since yesterday's close: value now less the last end-of-day snapshot before today (null without one). */
export function sinceYesterday(series: { as_of: string; equity: number }[], equityNow: number, today: string): number | null {
  let prev: { as_of: string; equity: number } | null = null;
  for (const s of series) if (s.as_of < today && (!prev || s.as_of > prev.as_of)) prev = s;
  return prev && Number.isFinite(prev.equity) ? equityNow - prev.equity : null;
}

/** "Too early to judge: 1 week of results." while a long-term box has under `minWeeks` weeks; else null. */
export function tooEarly(firstDay: string | null, today: string, minWeeks = 8): string | null {
  if (!firstDay) return null;
  const days = Math.round((dayMs(today) - dayMs(firstDay)) / 86_400_000);
  if (days < 0) return null;
  const weeks = Math.floor(days / 7);
  if (weeks >= minWeeks) return null;
  if (weeks < 1) return "Too early to judge: less than a week of results.";
  return `Too early to judge: ${weeks} week${weeks === 1 ? "" : "s"} of results.`;
}

/* ---------------- holdings ---------------- */

/** Where a position stands against its stop and target. Distances are % of the price now. */
export function stopPlan(p: { qty: number; price: number | null; stop: number | null; target: number | null }): {
  stopPct: number | null;
  targetPct: number | null;
  /** 0 = at the stop, 1 = at the target (null without both). */
  pos: number | null;
  close: boolean;
} {
  const short = p.qty < 0;
  if (p.price == null || !(p.price > 0)) return { stopPct: null, targetPct: null, pos: null, close: false };
  const stopPct = p.stop != null ? ((short ? p.stop - p.price : p.price - p.stop) / p.price) * 100 : null;
  const targetPct = p.target != null ? ((short ? p.price - p.target : p.target - p.price) / p.price) * 100 : null;
  const pos =
    p.stop != null && p.target != null && p.target !== p.stop ? Math.max(0, Math.min(1, (p.price - p.stop) / (p.target - p.stop))) : null;
  return { stopPct, targetPct, pos, close: stopPct != null && stopPct < 1.5 };
}

/** "1.2% above its stop · 3.6% to target" (short: "from its stop"). */
export function stopLine(plan: ReturnType<typeof stopPlan>, short: boolean): string | null {
  const parts: string[] = [];
  if (plan.stopPct != null) {
    if (plan.stopPct <= 0) parts.push("At its stop");
    else if (plan.close) parts.push(`Close to its stop: ${plan.stopPct.toFixed(1)}% ${short ? "away" : "above"}`);
    else parts.push(`${plan.stopPct.toFixed(1)}% ${short ? "from" : "above"} its stop`);
  }
  if (plan.targetPct != null) parts.push(plan.targetPct <= 0 ? "at its target" : `${plan.targetPct.toFixed(1)}% to target`);
  return parts.length ? parts.join(" · ") : null;
}

/* ---------------- watching ---------------- */

export interface WatchRow {
  symbol: string;
  /** The price it buys (or sells short) at, when known. */
  buyAt: number | null;
  /** |buyAt − price| as % of the price, when both are known. */
  away: number | null;
  /** 0–100 for the bar: how close the price is to the buy price. */
  closeness: number | null;
  note: string;
  kind: "order" | "watch" | "signal";
  short: boolean;
}

const PRICE_IN_TEXT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/;

/** The first "$123.45" in a sentence (Claude's "would buy if" trigger), else null. */
export function priceInText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = PRICE_IN_TEXT.exec(text);
  if (!m) return null;
  const v = Number(`${m[1].replace(/,/g, "")}${m[2] ?? ""}`);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Resting entry orders, Claude's "watch" decisions and (Long-Term) fresh indicator signals, one row per
 * stock (an order wins), closest to buying first; rows without a distance after, in that order.
 */
export function watchRows(opts: {
  orders: { symbol: string; side: string; kind: string; limit: number | null; stop: number | null; reason: string | null }[];
  watches: { symbol: string; trigger?: string | null; reason?: string | null }[];
  signals?: { symbol: string; note: string }[];
  prices: Record<string, number>;
  held?: string[];
}): WatchRow[] {
  const held = new Set(opts.held ?? []);
  const seen = new Set<string>();
  const rows: WatchRow[] = [];
  const add = (r: Omit<WatchRow, "away" | "closeness">) => {
    if (!r.symbol || seen.has(r.symbol)) return;
    seen.add(r.symbol);
    const px = opts.prices[r.symbol];
    const away = r.buyAt != null && px > 0 ? (Math.abs(r.buyAt - px) / px) * 100 : null;
    rows.push({ ...r, away, closeness: away == null ? null : Math.max(4, Math.min(100, 100 - away * 18)) });
  };
  for (const o of opts.orders) {
    if (o.kind !== "entry") continue;
    const short = o.side === "sell";
    add({
      symbol: o.symbol,
      buyAt: o.limit ?? o.stop,
      note: o.reason ? `Order waiting at Alpaca · ${clip(o.reason, 70)}` : "Order waiting at Alpaca",
      kind: "order",
      short,
    });
  }
  for (const w of opts.watches) {
    if (held.has(w.symbol)) continue;
    add({ symbol: w.symbol, buyAt: priceInText(w.trigger), note: "Claude is watching · no order yet", kind: "watch", short: false });
  }
  for (const s of opts.signals ?? []) {
    if (held.has(s.symbol)) continue;
    add({ symbol: s.symbol, buyAt: null, note: s.note, kind: "signal", short: false });
  }
  const withAway = rows.filter((r) => r.away != null).sort((a, b) => (a.away as number) - (b.away as number));
  return [...withAway, ...rows.filter((r) => r.away == null)];
}

/* ---------------- the status sentence ---------------- */

const truthy = (v: unknown) => v === true || v === "true";

/** The line under a box's name: how it works right now, in plain words. */
export function statusSentence(opts: {
  key: string;
  off: boolean;
  /** The box's effective settings. */
  cfg: Record<string, unknown>;
  /** The shared runner's effective settings (interval_min). */
  runner: Record<string, unknown>;
  lastRunAt: string | null;
  nowMs: number;
  marketOpen: boolean | null;
}): string {
  if (opts.off) return "Switched off: opens nothing new, still manages what it holds";
  const { cfg } = opts;
  if (opts.key === "claude-day") {
    const every = Number(opts.runner.interval_min) || 0;
    const next = opts.lastRunAt && every ? Date.parse(opts.lastRunAt) + every * 60_000 : NaN;
    const flat = typeof cfg.flat_by === "string" && cfg.flat_by ? `closes everything by ${cfg.flat_by}` : "may hold overnight";
    return [
      "Checks the market every minute",
      opts.marketOpen !== false && Number.isFinite(next) && next > opts.nowMs ? `next Claude look about ${nyClock(next)}` : null,
      flat,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (opts.key === "claude-long") {
    if (!truthy(cfg.intraday_watch)) return `Holds for weeks · looks once a day at ${String(cfg.run_at ?? "09:00")}`;
    const moves = Number(cfg.move_pct) > 0;
    const news = truthy(cfg.news_wakes);
    const wakes = moves && news ? "wakes Claude on big moves and news" : moves ? "wakes Claude on big moves" : news ? "wakes Claude on news" : null;
    return ["Holds for weeks", `re-checks its signals every ${Number(cfg.scan_min) || 15} min`, wakes].filter(Boolean).join(" · ");
  }
  if (opts.key === "claude-free") return "Old shared account: opens nothing new; its last positions run out on their stops";
  if (opts.key.startsWith("claude-")) return `Claude checks every ${Number(opts.runner.interval_min) || 15} min in market hours`;
  return "Runs on the website on weekday schedules, by fixed rules";
}

/* ---------------- today's trades ---------------- */

export interface TodayTrade {
  at: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  role: "short" | "cover" | null;
  pnl: number | null;
  reason?: string | null;
  exit?: ExitReason | null;
}

const EXIT_WHY: Record<ExitReason, string> = {
  stop: "fell to its stop",
  target: "hit its target",
  trail: "the trailing stop locked in the gain",
  breakeven: "came back to the buy price",
  partial: "took part of the profit",
  time: "the time limit: it had barely moved",
  market: "the market turned",
  "close-out": "the end-of-day close",
  claude: "Claude decided to sell",
  exit: "sold",
};

/** One line of the "Today" list: "Bought PDD — <why>" and the qty @ price or the result. */
export function tradeLine(t: TodayTrade): { title: string; why: string | null; right: string; tone: Tone } {
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const at = `${fmt(t.qty)} @ $${t.price.toFixed(2)}`;
  const exit = t.pnl != null;
  if (!exit) {
    const title = t.role === "short" ? `Sold ${t.symbol} short` : t.side === "buy" ? `Bought ${t.symbol}` : `Sold ${t.symbol}`;
    return { title, why: t.reason ? clip(t.reason, 110) : null, right: at, tone: "flat" };
  }
  const r = t.exit ?? "exit";
  const pnl = t.pnl as number;
  const money = `${pnl < 0 ? "−" : "+"}$${Math.abs(pnl).toFixed(2)}`;
  const title = t.role === "cover" ? `Bought back ${t.symbol}` : r === "stop" ? `Stopped out of ${t.symbol}` : `Sold ${t.symbol}`;
  const why = r === "exit" ? null : t.role === "cover" && r === "stop" ? "rose to its stop" : EXIT_WHY[r];
  return { title, why, right: money, tone: toneOf(pnl) };
}

/** Today's numbers: trades (fills), closed ones won, and the profit locked in. */
export function todayStats(trades: TodayTrade[]): { count: number; won: number; closed: number; locked: number } {
  const closed = trades.filter((t) => t.pnl != null);
  return {
    count: trades.length,
    closed: closed.length,
    won: closed.filter((t) => (t.pnl as number) > 0.005).length,
    locked: closed.reduce((a, t) => a + (t.pnl as number), 0),
  };
}

/* ---------------- right now ---------------- */

export interface RunLike {
  ran_at: string;
  error: string | null;
  summary: {
    phase?: string;
    note?: string;
    decisions?: { symbol: string; action: string; qty?: number; price?: number; reason?: string; trigger?: string }[];
  } | null;
}

export interface NowStep {
  key: "watch" | "look" | "decide" | "act" | "manage";
  label: string;
  sub: string;
  state: "done" | "now" | "idle";
}

const ACTION_WORD: Record<string, [string, string]> = {
  buy: ["buy", "buys"],
  sell: ["sell", "sells"],
  short: ["short", "shorts"],
  cover: ["buy-back", "buy-backs"],
  hold: ["hold", "holds"],
  watch: ["watch", "watches"],
  skip: ["skip", "skips"],
  cancel: ["skip", "skips"],
};

/** "1 buy · 3 skips" from a run's decisions; "no decisions" when there are none. */
export function decisionCounts(ds: { action: string }[] | undefined): string {
  const n = new Map<string, number>();
  for (const d of ds ?? []) {
    const w = ACTION_WORD[d.action];
    if (!w) continue;
    n.set(w[0], (n.get(w[0]) ?? 0) + 1);
  }
  if (!n.size) return "no decisions";
  const order = ["buy", "sell", "short", "buy-back", "hold", "watch", "skip"];
  return order
    .filter((k) => n.has(k))
    .map((k) => {
      const c = n.get(k) as number;
      const pair = Object.values(ACTION_WORD).find((w) => w[0] === k) as [string, string];
      return `${c} ${c === 1 ? pair[0] : pair[1]}`;
    })
    .join(" · ");
}

const STEP_INDEX: Partial<Record<EventStep, number>> = { watch: 0, wake: 1, look: 1, decide: 2, check: 2, order: 3, fill: 3, exit: 4, close: 4 };

const PHASE_SHORT: Record<string, string> = {
  PRE: "before the open",
  OPEN: "at the open",
  ENTRY: "looking for trades",
  MANAGE: "managing trades",
  FLATTEN: "closing for the day",
  CLOSE: "closing the box",
  CLOSED: "market closed",
};

/**
 * The five-step "where is it now" line. `current` is the step of the most recent recorded event
 * (lib/aitrader/flow nowStep), null when nothing happened in the last few minutes: then it is
 * Managing while something is open, else Watching.
 */
export function rightNowSteps(opts: {
  watchSub: string;
  watchSeen: boolean;
  run: RunLike | null;
  today: string;
  latestFill: TodayTrade | null;
  openCount: number;
  current: EventStep | null;
}): NowStep[] {
  const ranToday = !!opts.run && nyDate(new Date(opts.run.ran_at)) === opts.today;
  const phase = opts.run?.summary?.phase ? PHASE_SHORT[opts.run.summary.phase.toUpperCase()] : undefined;
  const f = opts.latestFill;
  const fillWord = f ? (f.role === "short" ? "Sold short" : f.role === "cover" ? "Bought back" : f.side === "buy" ? "Bought" : "Sold") : "Bought / sold";
  const steps: Omit<NowStep, "state">[] = [
    { key: "watch", label: "Watching", sub: opts.watchSub },
    {
      key: "look",
      label: "Claude looked",
      sub: opts.run ? `${ranToday ? nyClock(opts.run.ran_at) : "last " + shortDate(nyDate(new Date(opts.run.ran_at)))}${phase ? ` · ${phase}` : ""}` : "not yet",
    },
    { key: "decide", label: "Decided", sub: opts.run ? (opts.run.error ? "the check failed" : decisionCounts(opts.run.summary?.decisions)) : "—" },
    { key: "act", label: fillWord, sub: f ? `${f.symbol} at $${f.price.toFixed(2)}` : "nothing yet today" },
    { key: "manage", label: "Managing", sub: opts.openCount ? `${opts.openCount} open · stops at Alpaca` : "nothing open" },
  ];
  const has = [opts.watchSeen, ranToday, ranToday, !!f, opts.openCount > 0];
  const cur = opts.current != null && STEP_INDEX[opts.current] != null ? (STEP_INDEX[opts.current] as number) : opts.openCount > 0 ? 4 : 0;
  return steps.map((s, i) => ({ ...s, state: i === cur ? "now" : i < cur && has[i] ? "done" : "idle" }));
}

const VERB: Record<string, string> = { buy: "bought", sell: "sold", short: "sold short", cover: "bought back" };

/** One plain sentence for the latest Claude run: its own note, else its main decision. */
export function runSentence(run: RunLike | null): string | null {
  if (!run) return null;
  if (run.error) return `The last check didn't finish: ${clip(run.error, 160)}`;
  const s = run.summary;
  if (s?.note) return s.note;
  const ds = s?.decisions ?? [];
  const act = ds.find((d) => VERB[d.action]);
  if (act) {
    const qty = act.qty && act.qty > 0 ? `${act.qty} ` : "";
    const px = act.price && act.price > 0 ? ` at about $${act.price.toFixed(2)}` : "";
    return `Claude ${VERB[act.action]} ${qty}${act.symbol}${px}${act.reason ? `: ${clip(act.reason, 140)}` : "."}`;
  }
  const watch = ds.find((d) => d.action === "watch");
  if (watch) return `Claude is watching ${watch.symbol}${watch.reason ? `: ${clip(watch.reason, 140)}` : "."}`;
  const skips = ds.filter((d) => d.action === "skip" || d.action === "cancel").length;
  if (skips) return `Claude passed on ${skips} stock${skips === 1 ? "" : "s"} and opened nothing new.`;
  if (ds.some((d) => d.action === "hold")) return "Claude kept what it holds and opened nothing new.";
  return "Claude looked and made no changes.";
}

/* ---------------- the market clock ---------------- */

/** "Market open · closes in 2h 15m" / "Market closed · opens Mon 09:30". */
export function marketLine(clock: { isOpen: boolean; nextOpen: string | null; nextClose: string | null } | null, nowMs: number): string | null {
  if (!clock) return null;
  if (clock.isOpen) {
    const end = clock.nextClose ? Date.parse(clock.nextClose) : NaN;
    if (!Number.isFinite(end) || end <= nowMs) return "Market open";
    const mins = Math.round((end - nowMs) / 60_000);
    const h = Math.floor(mins / 60);
    return `Market open · closes in ${h ? `${h}h ` : ""}${mins % 60}m`;
  }
  const start = clock.nextOpen ? Date.parse(clock.nextOpen) : NaN;
  if (!Number.isFinite(start) || start <= nowMs) return "Market closed";
  const sameDay = nyDate(new Date(start)) === nyDate(new Date(nowMs));
  return `Market closed · opens ${sameDay ? "today" : NY_WEEKDAY.format(new Date(start))} ${nyClock(start)} New York time`;
}
