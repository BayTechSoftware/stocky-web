"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadAiMarket } from "../actions";
import type { AiBookView } from "@/lib/aitrader/view";
import { addDays, nyDate } from "@/lib/aitrader/flow";
import {
  barsDaily,
  barsIntraday,
  boxDaily,
  compareSentence,
  compareSeries,
  intradayEquity,
  nyClock,
  rangeStart,
  shortDate,
  type Compare,
  type Pt,
  type Range,
  type Tone,
} from "@/lib/aitrader/page";

/* ---------------- market data (SPY), shared by every card on the page ---------------- */

type Daily = { today: string; daily: { t: string; c: number }[] };
type Intra = Record<string, { t: string; o: number; c: number }[]>;

const DAILY_TTL = 5 * 60_000;
const INTRA_TTL = 2 * 60_000;
const dailyCache = new Map<string, { at: number; p: Promise<Daily | null> }>();
const intraCache = new Map<string, { at: number; p: Promise<Intra | null> }>();

function fetchDaily(since: string): Promise<Daily | null> {
  const hit = dailyCache.get(since);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.p;
  const p = loadAiMarket({ since })
    .then((r) => ("error" in r ? null : { today: r.today, daily: r.daily }))
    .catch(() => null);
  dailyCache.set(since, { at: Date.now(), p });
  return p;
}

function fetchIntra(symbols: string[]): Promise<Intra | null> {
  const key = symbols.slice().sort().join(",");
  const hit = intraCache.get(key);
  if (hit && Date.now() - hit.at < INTRA_TTL) return hit.p;
  const p = loadAiMarket({ since: nyDate(), intraday: { symbols } })
    .then((r) => ("error" in r ? null : r.intraday))
    .catch(() => null);
  intraCache.set(key, { at: Date.now(), p });
  return p;
}

/** The box's first day (New York date), from ai_books.created_at. */
export const firstDayOf = (b: Pick<AiBookView, "createdAt">): string | null => (b.createdAt ? nyDate(new Date(b.createdAt)) : null);

/**
 * SPY's daily closes from a day (undefined while loading, null when they can't be read — the page then
 * hides the comparison). Re-read every few minutes while the page is open.
 */
export function useSpyDaily(since: string | null): Daily | null | undefined {
  const [data, setData] = useState<Daily | null | undefined>(undefined);
  useEffect(() => {
    if (!since) return;
    let stopped = false;
    const load = () => fetchDaily(since).then((d) => !stopped && setData(d));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, DAILY_TTL);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [since]);
  return since ? data : null;
}

/** Today's 5-minute bars for SPY and the given symbols, while `on`. */
function useIntraday(symbols: string[], on: boolean): Intra | null | undefined {
  const key = symbols.slice().sort().join(",");
  const [data, setData] = useState<{ key: string; v: Intra | null } | undefined>(undefined);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    const syms = key ? key.split(",") : [];
    const load = () => fetchIntra(syms).then((v) => !stopped && setData({ key, v }));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, INTRA_TTL);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, on]);
  if (!on) return null;
  return data && data.key === key ? data.v : undefined;
}

/** The earliest day any of these boxes needs SPY from (a week back at least). */
export function sinceFor(books: Pick<AiBookView, "createdAt">[]): string {
  const today = nyDate();
  const days = books.map(firstDayOf).filter((d): d is string => !!d);
  const week = addDays(today, -10);
  const first = days.length ? days.sort()[0] : week;
  return addDays(first < week ? first : week, -5);
}

/** A box against SPY over a range: the lines and the sentence; null while loading or without data. */
export function useCompare(b: AiBookView, range: Range, spy: Daily | null | undefined): { c: Compare; sentence: { tone: Tone; text: string } } | null {
  const today = nyDate();
  const first = firstDayOf(b);
  const symbols = useMemo(
    () => Array.from(new Set([...b.positions.map((p) => p.symbol), ...b.todayTrades.map((t) => t.symbol)])),
    [b.positions, b.todayTrades]
  );
  const intra = useIntraday(symbols, range === "today");
  return useMemo(() => {
    if (range === "today") {
      // The regular session only (the IEX feed has pre-market bars too).
      const session = (bars: Intra[string]) => bars.filter((x) => {
        const hm = nyClock(x.t);
        return hm >= "09:30" && hm < "16:00";
      });
      const bars: Intra = Object.fromEntries(Object.entries(intra ?? {}).map(([k, v]) => [k, session(v)]));
      if (!bars.SPY?.length) return null;
      const spyPts = barsIntraday(bars.SPY);
      const start = Date.parse(bars.SPY[0].t);
      // The live value goes at the newest bar's time, so both lines end together.
      const nowMs = spyPts.length ? spyPts[spyPts.length - 1].t : start + 1;
      const box = intradayEquity({
        equityNow: b.equity,
        positions: b.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, value: p.value, price: p.price })),
        fills: b.todayTrades,
        bars,
        times: [start, ...spyPts.map((p) => p.t)],
        nowMs,
      });
      // Both lines start from the first bar's open.
      const spyLine: Pt[] = [{ t: start - 1, v: bars.SPY[0].o }, ...spyPts];
      const boxLine: Pt[] = [{ t: start - 1, v: box[0]?.v ?? b.equity }, ...box];
      const c = compareSeries(boxLine, spyLine, start);
      return c ? { c, sentence: compareSentence(c, "today") } : null;
    }
    if (!spy?.daily.length) return null;
    const start = rangeStart(range, today, first);
    const boxPts = boxDaily({ series: b.series, startCash: b.startCash, firstDay: first, equityNow: b.equity, today });
    const c = compareSeries(boxPts, barsDaily(spy.daily), start);
    return c ? { c, sentence: compareSentence(c, range) } : null;
  }, [range, intra, spy, b.equity, b.positions, b.todayTrades, b.series, b.startCash, first, today]);
}

/* ---------------- the chart ---------------- */

const TONE_VAR: Record<Tone, string> = { gain: "var(--color-gain)", loss: "var(--color-loss)", flat: "var(--color-text)" };
const SPY_COLOR = "var(--color-faint)";
/** A white outline under the line labels so a line passing behind them doesn't cut through the text. */
const HALO = { stroke: "var(--color-surface)", strokeWidth: 4, paintOrder: "stroke" as const, strokeLinejoin: "round" as const };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((es) => setW(Math.round(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const signedPct = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(1)}%`;

/** A tidy step for the gridlines (0.5, 1, 2, 2.5, 5, 10 …). */
function niceStep(span: number): number {
  const raw = span / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

/**
 * The box (gain / loss colour) against the S&P 500 (grey), both as % from the start, labelled on the
 * lines. `mini` = the overview's small version: no axis labels.
 */
export function CompareChart({ c, range, mini = false, label = "This box" }: { c: Compare; range: Range; mini?: boolean; label?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = mini ? 90 : 220;
  const tone: Tone = c.boxPct > 0.005 ? "gain" : c.boxPct < -0.005 ? "loss" : "flat";
  const all = [...c.box, ...c.spy];
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  let lo = Math.min(0, ...all.map((p) => p.v));
  let hi = Math.max(0, ...all.map((p) => p.v));
  if (hi - lo < 0.5) {
    hi += 0.25;
    lo -= 0.25;
  }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const padL = mini ? 0 : 44;
  const padR = mini ? 2 : 8;
  const padT = mini ? 6 : 18;
  const padB = mini ? 6 : 26;
  const x = (t: number) => padL + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * Math.max(1, w - padL - padR));
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
  const path = (pts: Pt[]) => pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks: number[] = [];
  for (let v = hi; v >= lo - 1e-9; v -= step) ticks.push(Math.round(v * 100) / 100);

  // End labels: the box's below/above the S&P's, kept apart.
  const by = y(c.boxPct);
  const sy = y(c.spyPct);
  const boxAbove = by <= sy;
  let boxLabelY = boxAbove ? by - 8 : by + 16;
  let spyLabelY = boxAbove ? sy + 16 : sy - 8;
  if (Math.abs(boxLabelY - spyLabelY) < 14) {
    if (boxAbove) spyLabelY = boxLabelY + 15;
    else boxLabelY = spyLabelY + 15;
  }
  const clampY = (v: number) => Math.max(padT + 2, Math.min(h - padB - 2, v));
  const startLabel = range === "today" ? nyClock(c.startMs) : shortDate(new Date(c.startMs).toISOString().slice(0, 10));
  const desc = `${label} ${signedPct(c.boxPct)}, the S&P 500 ${signedPct(c.spyPct)}`;

  return (
    <div ref={ref} className="w-full" style={{ height: h }}>
      {w > 0 && (
        <svg width={w} height={h} role="img" aria-label={desc} className="block overflow-visible">
          {!mini &&
            ticks.map((v) => (
              <g key={v}>
                <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--color-surface2)" />
                <text x={0} y={y(v) + 4} fontSize={11} fill="var(--color-dim)" className="tnum">
                  {v === 0 ? "0%" : signedPct(v)}
                </text>
              </g>
            ))}
          {mini && <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--color-border)" strokeDasharray="3 4" />}
          <polyline points={path(c.spy)} fill="none" stroke={SPY_COLOR} strokeWidth={2} strokeLinejoin="round" />
          <polyline points={path(c.box)} fill="none" stroke={TONE_VAR[tone]} strokeWidth={mini ? 2.5 : 3} strokeLinejoin="round" />
          {mini ? (
            <text x={w - 2} y={clampY(spyLabelY)} fontSize={11} fill="var(--color-dim)" textAnchor="end" {...HALO}>
              S&amp;P 500
            </text>
          ) : (
            <>
              <text x={w - padR} y={clampY(spyLabelY)} fontSize={12} fill="var(--color-dim)" textAnchor="end" className="tnum" {...HALO}>
                S&amp;P 500 {signedPct(c.spyPct)}
              </text>
              <text x={w - padR} y={clampY(boxLabelY)} fontSize={12} fontWeight={600} fill={TONE_VAR[tone]} textAnchor="end" className="tnum" {...HALO}>
                {label} {signedPct(c.boxPct)}
              </text>
              <text x={padL} y={h - 6} fontSize={11} fill="var(--color-dim)">
                {startLabel}
              </text>
              <text x={w - padR} y={h - 6} fontSize={11} fill="var(--color-dim)" textAnchor="end">
                {range === "today" ? "Now" : "Today"}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}

/** The tinted "Ahead of / Behind the market" strip. */
export function CompareStrip({ sentence }: { sentence: { tone: Tone; text: string } }) {
  const cls =
    sentence.tone === "gain"
      ? "bg-gain-tint text-gain-ink"
      : sentence.tone === "loss"
        ? "bg-loss-tint text-loss-ink"
        : "bg-surface2 text-sub";
  return (
    <p className={`flex items-start gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[14px] font-medium leading-snug ${cls}`}>
      <span aria-hidden>{sentence.tone === "gain" ? "▲" : sentence.tone === "loss" ? "▼" : "="}</span>
      <span>{sentence.text}</span>
    </p>
  );
}

/** Today / Week / All. */
export function RangeSwitch({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: { id: Range; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "all", label: "All" },
  ];
  return (
    <div role="group" aria-label="Period" className="inline-flex gap-0.5 rounded-lg bg-surface2 p-[3px]">
      {opts.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={`min-h-9 rounded-md px-3 text-[13px] transition ${on ? "bg-surface font-semibold text-text shadow-sm" : "text-sub hover:text-text"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
