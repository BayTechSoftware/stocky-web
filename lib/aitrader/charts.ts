/**
 * Stock charts for the two Claude boxes (claude-day, claude-long): the Mac upserts one `ai_charts` row
 * per held / watched symbol, and the website draws it. This file validates and normalises that row's
 * `data`, maps its semantic colours onto the theme, orders the symbol list and picks frames. Pure (no
 * server or DOM imports), so the server actions, the client components and the tests share it.
 */

/* ---------------- types ---------------- */

export const CHART_COLORS = ["gain", "loss", "accent", "muted", "warn", "info", "price"] as const;
export type ChartColor = (typeof CHART_COLORS)[number];
export type ChartLineStyle = "solid" | "dashed" | "dotted";
export type ChartPane = "price" | "osc" | "osc2";
export type OscPane = Exclude<ChartPane, "price">;
export type ChartRole = "held" | "watch";
export type ChartKind = "long" | "day";

export interface ChartCandle {
  /** Unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface ChartLine {
  id: string;
  label: string;
  pane: ChartPane;
  color: ChartColor;
  style: ChartLineStyle;
  width: number;
  /** Ascending, one per bar (snapped onto the candles' times). */
  points: { t: number; v: number }[];
}

export interface ChartMarker {
  /** A candle's time (snapped onto the bar the marker falls in). */
  t: number;
  position: "above" | "below" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: ChartColor;
  text: string | null;
  size: number | null;
}

export interface ChartLevel {
  label: string;
  price: number;
  color: ChartColor;
  style: ChartLineStyle;
}

export interface ChartOscLevel {
  pane: OscPane;
  label: string;
  value: number;
  color: ChartColor;
}

export interface ChartFrame {
  id: string;
  label: string;
  candles: ChartCandle[];
  lines: ChartLine[];
  markers: ChartMarker[];
  levels: ChartLevel[];
  oscLevels: ChartOscLevel[];
  panes: { osc: string | null; osc2: string | null };
}

export interface ChartTrade {
  side: "long" | "short";
  qty: number;
  entry: number;
  stop: number | null;
  target: number | null;
  enteredAt: string | null;
  status: "held" | "watch" | "armed";
  why: string | null;
}

export interface ChartData {
  symbol: string;
  kind: ChartKind;
  asOf: string | null;
  title: string | null;
  trade: ChartTrade | null;
  /** In display order (see FRAME_ORDER). Never empty. */
  frames: ChartFrame[];
  defaultFrame: string;
  notes: string[];
}

/** One row of the symbol list (no candles: just enough for the chips). */
export interface ChartListItem {
  symbol: string;
  role: ChartRole;
  updatedAt: string | null;
  kind: ChartKind | null;
  title: string | null;
  status: ChartTrade["status"] | null;
  side: ChartTrade["side"] | null;
  asOf: string | null;
}

/* ---------------- small validators ---------------- */

const LIMITS = { candles: 6000, lines: 24, points: 6000, markers: 600, levels: 40, oscLevels: 20, notes: 16, frames: 8 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown, max = 120): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** Unix seconds; millisecond values (> year 5000 in seconds) are converted. */
function secs(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const isChartColor = (v: unknown): v is ChartColor => typeof v === "string" && (CHART_COLORS as readonly string[]).includes(v);
const color = (v: unknown, fallback: ChartColor = "muted"): ChartColor => (isChartColor(v) ? v : fallback);
const lineStyle = (v: unknown): ChartLineStyle => oneOf(v, ["solid", "dashed", "dotted"] as const, "solid");

/** A ticker as the database stores it: upper case, letters/digits/dot/dash, at most 16. */
export const cleanChartSymbol = (raw: unknown): string =>
  typeof raw === "string" ? raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16) : "";

/* ---------------- frames ---------------- */

/** Frame ids in display order; unknown ids follow, alphabetically. */
export const FRAME_ORDER = ["1m", "5m", "15m", "30m", "1h", "D", "W", "M"] as const;
const FRAME_ID_RE = /^[A-Za-z0-9_-]{1,8}$/;

function frameRank(id: string): number {
  const i = (FRAME_ORDER as readonly string[]).indexOf(id);
  return i >= 0 ? i : FRAME_ORDER.length;
}
export const compareFrames = (a: string, b: string): number => frameRank(a) - frameRank(b) || (a < b ? -1 : a > b ? 1 : 0);

const FRAME_FALLBACK_LABEL: Record<string, string> = { "1m": "1-min", "5m": "5-min", "15m": "15-min", "30m": "30-min", "1h": "Hourly", D: "Daily", W: "Weekly", M: "Monthly" };

/** Candles ascending, one per time (the last wins), high/low widened to cover open/close. */
export function normalizeCandles(raw: unknown): ChartCandle[] {
  const byT = new Map<number, ChartCandle>();
  for (const r of arr(raw).slice(-LIMITS.candles * 2)) {
    if (!isObj(r)) continue;
    const t = secs(r.t);
    const o = num(r.o);
    const h = num(r.h);
    const l = num(r.l);
    const c = num(r.c);
    if (t == null || o == null || h == null || l == null || c == null) continue;
    const v = num(r.v);
    byT.set(t, { t, o, h: Math.max(o, h, l, c), l: Math.min(o, h, l, c), c, v: v != null && v >= 0 ? v : null });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(-LIMITS.candles);
}

/** Index of the last candle at or before `t` (-1 when `t` is before the first). Candles ascending. */
export function barIndexAt(candles: { t: number }[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Points onto the candles' times (so a line never adds its own slots to the time axis); last value per bar wins. */
export function snapPoints(candles: { t: number }[], raw: unknown): { t: number; v: number }[] {
  const byBar = new Map<number, number>();
  const pts: { t: number; v: number }[] = [];
  for (const p of arr(raw).slice(-LIMITS.points * 2)) {
    if (!isObj(p)) continue;
    const t = secs(p.t);
    const v = num(p.v);
    if (t != null && v != null) pts.push({ t, v });
  }
  pts.sort((a, b) => a.t - b.t);
  for (const p of pts) {
    const i = barIndexAt(candles, p.t);
    if (i >= 0) byBar.set(candles[i].t, p.v);
  }
  return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

const MARKER_POS = ["above", "below", "inBar"] as const;
const MARKER_SHAPE = ["arrowUp", "arrowDown", "circle", "square"] as const;

function normalizeMarkers(candles: ChartCandle[], raw: unknown): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const m of arr(raw)) {
    if (!isObj(m)) continue;
    const t = secs(m.t);
    if (t == null) continue;
    const i = barIndexAt(candles, t);
    if (i < 0) continue;
    const shape = oneOf(m.shape, MARKER_SHAPE, "circle");
    const size = num(m.size);
    out.push({
      t: candles[i].t,
      position: oneOf(m.position, MARKER_POS, shape === "arrowDown" ? "above" : "below"),
      shape,
      color: color(m.color, "accent"),
      text: str(m.text, 40),
      size: size != null ? Math.min(3, Math.max(0.5, size)) : null,
    });
    if (out.length >= LIMITS.markers) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

function normalizeFrame(id: string, raw: unknown): ChartFrame | null {
  if (!isObj(raw)) return null;
  const candles = normalizeCandles(raw.candles);
  if (candles.length === 0) return null;

  const ids = new Set<string>();
  const lines: ChartLine[] = [];
  for (const [i, l] of arr(raw.lines).entries()) {
    if (!isObj(l) || lines.length >= LIMITS.lines) continue;
    const pane = oneOf(l.pane, ["price", "osc", "osc2"] as const, "price");
    const points = snapPoints(candles, l.points);
    if (points.length === 0) continue;
    let lid = str(l.id, 40) ?? `line${i}`;
    while (ids.has(lid)) lid = `${lid}_${i}`;
    ids.add(lid);
    const w = num(l.width);
    lines.push({
      id: lid,
      label: str(l.label, 60) ?? lid,
      pane,
      color: color(l.color),
      style: lineStyle(l.style),
      width: w != null ? Math.min(4, Math.max(1, Math.round(w))) : pane === "price" ? 2 : 1,
      points,
    });
  }

  const levels: ChartLevel[] = [];
  for (const lv of arr(raw.levels)) {
    if (!isObj(lv) || levels.length >= LIMITS.levels) continue;
    const price = num(lv.price);
    if (price == null || (lv.pane != null && lv.pane !== "price")) continue;
    levels.push({ label: str(lv.label, 40) ?? "Level", price, color: color(lv.color), style: lineStyle(lv.style) });
  }

  const oscLevels: ChartOscLevel[] = [];
  for (const ol of arr(raw.osc_levels)) {
    if (!isObj(ol) || oscLevels.length >= LIMITS.oscLevels) continue;
    const value = num(ol.value);
    if (value == null) continue;
    oscLevels.push({ pane: oneOf(ol.pane, ["osc", "osc2"] as const, "osc"), label: str(ol.label, 40) ?? "", value, color: color(ol.color) });
  }

  const panes = isObj(raw.panes) ? raw.panes : {};
  return {
    id,
    label: str(raw.label, 40) ?? FRAME_FALLBACK_LABEL[id] ?? id,
    candles,
    lines,
    markers: normalizeMarkers(candles, raw.markers),
    levels,
    oscLevels,
    panes: { osc: str(panes.osc, 60), osc2: str(panes.osc2, 60) },
  };
}

function normalizeTrade(raw: unknown): ChartTrade | null {
  if (!isObj(raw)) return null;
  const entry = num(raw.entry);
  if (entry == null) return null;
  const qty = num(raw.qty);
  return {
    side: oneOf(raw.side, ["long", "short"] as const, "long"),
    qty: qty != null ? Math.abs(qty) : 0,
    entry,
    stop: num(raw.stop),
    target: num(raw.target),
    enteredAt: str(raw.entered_at, 40),
    status: oneOf(raw.status, ["held", "watch", "armed"] as const, qty ? "held" : "watch"),
    why: str(raw.why, 600),
  };
}

/**
 * An `ai_charts.data` value as a ChartData, or null when nothing in it can be drawn (no frame with
 * candles). Unknown fields are ignored; bad candles, points, markers and levels are dropped one by one.
 */
export function normalizeChart(raw: unknown, fallbackSymbol = ""): ChartData | null {
  if (!isObj(raw)) return null;
  const framesRaw = isObj(raw.frames) ? raw.frames : {};
  const frames: ChartFrame[] = [];
  for (const id of Object.keys(framesRaw).filter((k) => FRAME_ID_RE.test(k)).sort(compareFrames)) {
    if (frames.length >= LIMITS.frames) break;
    const f = normalizeFrame(id, framesRaw[id]);
    if (f) frames.push(f);
  }
  if (frames.length === 0) return null;
  const symbol = cleanChartSymbol(raw.symbol) || cleanChartSymbol(fallbackSymbol);
  if (!symbol) return null;
  const kind: ChartKind = raw.kind === "day" || raw.kind === "long" ? raw.kind : frames.some((f) => /m$|h$/.test(f.id)) ? "day" : "long";
  const asOf = str(raw.as_of, 40);
  const notes = arr(raw.notes)
    .map((n) => str(n, 300))
    .filter((n): n is string => n != null)
    .slice(0, LIMITS.notes);
  const data: Omit<ChartData, "defaultFrame"> = {
    symbol,
    kind,
    asOf: asOf && !Number.isNaN(Date.parse(asOf)) ? asOf : null,
    title: str(raw.title, 120),
    trade: normalizeTrade(raw.trade),
    frames,
    notes,
  };
  return { ...data, defaultFrame: chooseFrame({ ...data, defaultFrame: str(raw.default_frame, 8) ?? "" }, null).id };
}

/** The frame to show: the one picked, else the row's default, else the kind's usual one, else the first. */
export function chooseFrame(data: Pick<ChartData, "frames" | "defaultFrame" | "kind">, picked: string | null): ChartFrame {
  const find = (id: string | null | undefined) => (id ? data.frames.find((f) => f.id === id) : undefined);
  return find(picked) ?? find(data.defaultFrame) ?? find(data.kind === "day" ? "5m" : "D") ?? data.frames[0];
}

/** Which lower panes a frame needs, in order (pane 1, pane 2…). Price is always pane 0. */
export function oscPanesOf(frame: Pick<ChartFrame, "lines">): OscPane[] {
  const out: OscPane[] = [];
  if (frame.lines.some((l) => l.pane === "osc")) out.push("osc");
  if (frame.lines.some((l) => l.pane === "osc2")) out.push("osc2");
  return out;
}

/** Chart height in px: price only, or with one / two lower panes (phones and desktop alike). */
export const chartHeight = (oscCount: number): number => (oscCount <= 0 ? 340 : oscCount === 1 ? 400 : 420);

/** Bars per day spacing below 20 hours = an intraday frame (times shown as clock times). */
export function isIntraday(candles: { t: number }[]): boolean {
  if (candles.length < 2) return false;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) gaps.push(candles[i].t - candles[i - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] < 20 * 3600;
}

/** How many bars to show at first (null = all): about six months of days, two years of weeks. */
export function initialBars(frameId: string, intraday: boolean): number | null {
  if (intraday) return null;
  if (frameId === "D") return 130;
  if (frameId === "W") return 104;
  if (frameId === "M") return null;
  return 150;
}

/* ---------------- the symbol list ---------------- */

/** A list query row ({symbol, role, updated_at, kind, title, status, side, as_of}) as a ChartListItem. */
export function toChartListItem(row: unknown): ChartListItem | null {
  if (!isObj(row)) return null;
  const symbol = cleanChartSymbol(row.symbol);
  if (!symbol) return null;
  const kind = row.kind === "day" || row.kind === "long" ? row.kind : null;
  const status = row.status === "held" || row.status === "watch" || row.status === "armed" ? row.status : null;
  const side = row.side === "long" || row.side === "short" ? row.side : null;
  return {
    symbol,
    role: row.role === "held" ? "held" : "watch",
    updatedAt: str(row.updated_at, 40),
    kind,
    title: str(row.title, 120),
    status,
    side,
    asOf: str(row.as_of, 40),
  };
}

/** Held first, then watched; A→Z inside each group; one entry per symbol. Doesn't mutate. */
export function sortCharts(items: ChartListItem[]): ChartListItem[] {
  const seen = new Set<string>();
  return items
    .slice()
    .sort((a, b) => Number(a.role !== "held") - Number(b.role !== "held") || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .filter((i) => (seen.has(i.symbol) ? false : (seen.add(i.symbol), true)));
}

export function groupCharts(items: ChartListItem[]): { holding: ChartListItem[]; watching: ChartListItem[] } {
  const s = sortCharts(items);
  return { holding: s.filter((i) => i.role === "held"), watching: s.filter((i) => i.role !== "held") };
}

/** The symbol to show: the current pick while it is still listed, else the first held, else the first watched. */
export function defaultChartSymbol(items: ChartListItem[], current: string | null): string | null {
  if (current && items.some((i) => i.symbol === current)) return current;
  return sortCharts(items)[0]?.symbol ?? null;
}

/* ---------------- theme colours ---------------- */

export interface ChartPalette extends Record<ChartColor, string> {
  text: string;
  dim: string;
  faint: string;
  border: string;
  surface: string;
}

/**
 * Which CSS variable each colour reads. The app's "accent" token is near-black (the same as the text),
 * so chart "accent" lines use the burnt-orange token to stay distinct from the candles and price.
 */
export const CHART_CSS_VAR: Record<keyof ChartPalette, string> = {
  gain: "--color-gain",
  loss: "--color-loss",
  accent: "--color-overbought",
  muted: "--color-dim",
  warn: "--color-watch",
  info: "--color-washout",
  price: "--color-text",
  text: "--color-text",
  dim: "--color-dim",
  faint: "--color-faint",
  border: "--color-border",
  surface: "--color-surface",
};

/** The light theme's values (app/globals.css), used when a variable can't be read. */
export const FALLBACK_PALETTE: ChartPalette = {
  gain: "#0a7c42",
  loss: "#cf2f2f",
  accent: "#d2582a",
  muted: "#6c6b64",
  warn: "#b07403",
  info: "#2563eb",
  price: "#1b1a17",
  text: "#1b1a17",
  dim: "#6c6b64",
  faint: "#9c9b92",
  border: "#e5e5df",
  surface: "#ffffff",
};

/** The palette from a CSS-variable reader (the component passes getComputedStyle; tests pass a map). */
export function paletteFrom(read: (cssVar: string) => string | null | undefined): ChartPalette {
  const out = { ...FALLBACK_PALETTE };
  for (const k of Object.keys(CHART_CSS_VAR) as (keyof ChartPalette)[]) {
    const v = read(CHART_CSS_VAR[k])?.trim();
    if (v) out[k] = v;
  }
  return out;
}

export const samePalette = (a: ChartPalette, b: ChartPalette): boolean =>
  (Object.keys(CHART_CSS_VAR) as (keyof ChartPalette)[]).every((k) => a[k] === b[k]);

/** A #rgb / #rrggbb / rgb() / rgba() colour at `alpha` opacity; other forms come back unchanged. */
export function withAlpha(c: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("").map((x) => parseInt(x + x, 16));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const h = m[1];
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
  return s;
}

/* ---------------- legend ---------------- */

export interface LegendItem {
  kind: "line" | "level" | "oscLevel";
  label: string;
  color: ChartColor;
  style: ChartLineStyle;
  /** Where it is drawn, in plain words. */
  where: string;
  value: number | null;
}

/** Every line and level of a frame, in plain words, for the legend under the chart. */
export function legendOf(frame: ChartFrame): LegendItem[] {
  const paneName = (p: ChartPane) => (p === "price" ? "price" : (frame.panes[p] ?? (p === "osc" ? "lower panel" : "bottom panel")));
  return [
    ...frame.lines.map((l): LegendItem => ({ kind: "line", label: l.label, color: l.color, style: l.style, where: paneName(l.pane), value: l.points[l.points.length - 1]?.v ?? null })),
    ...frame.levels.map((l): LegendItem => ({ kind: "level", label: l.label, color: l.color, style: l.style, where: "price", value: l.price })),
    ...frame.oscLevels
      .filter((l) => frame.lines.some((x) => x.pane === l.pane))
      .map((l): LegendItem => ({ kind: "oscLevel", label: l.label, color: l.color, style: "dashed", where: paneName(l.pane), value: l.value })),
  ];
}

/* ---------------- times (New York) ---------------- */

const NY = "America/New_York";
const F_TIME = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" });
const F_DATE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: NY, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const F_DATE = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const F_MON_DAY = new Intl.DateTimeFormat("en-US", { timeZone: NY, month: "short", day: "numeric" });
const F_MON = new Intl.DateTimeFormat("en-US", { timeZone: NY, month: "short" });
const F_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric" });
const F_NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: NY });

/**
 * The instant to read a bar's date from. Daily-or-longer bars may be stamped at midnight UTC (the
 * evening before in New York) or midnight / the open in New York: 12 hours later is the right New
 * York date for all of them.
 */
const dateInstant = (t: number, intraday: boolean) => new Date((intraday ? t : t + 12 * 3600) * 1000);

/** The crosshair's time: "Nov 23, 10:35 AM" (intraday) or "Mon, Nov 23, 2026". */
export const fmtBarTime = (t: number, intraday: boolean): string =>
  intraday ? F_DATE_TIME.format(new Date(t * 1000)) : F_DATE.format(dateInstant(t, false));

/** Axis labels; `type` is lightweight-charts' TickMarkType (0 year, 1 month, 2 day, 3 time, 4 time+seconds). */
export function fmtTick(t: number, type: number, intraday: boolean): string {
  const d = dateInstant(t, intraday);
  if (type === 0) return F_YEAR.format(d);
  if (type === 1) return F_MON.format(d);
  if (type === 2) return F_MON_DAY.format(d);
  return F_TIME.format(d);
}

/** "12:31 PM ET" when `iso` is today in New York, else "Nov 21, 12:31 PM ET"; "" when unreadable. */
export function asOfLabel(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const sameDay = F_NY_DATE.format(d) === F_NY_DATE.format(new Date(nowMs));
  return `${sameDay ? F_TIME.format(d) : F_DATE_TIME.format(d)} ET`;
}
