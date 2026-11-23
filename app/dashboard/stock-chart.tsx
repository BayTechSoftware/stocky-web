"use client";

/**
 * The canvas part of a Claude box's stock chart (TradingView's lightweight-charts, client only: the
 * parent loads this file with next/dynamic, ssr:false). Candles + "price" lines + levels + markers on
 * the top pane; "osc" / "osc2" lines and their levels on panes underneath, sharing the time axis.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type LineStyle,
  type LineWidth,
  type LogicalRange,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  barIndexAt,
  chartHeight,
  fmtBarTime,
  fmtTick,
  initialBars,
  isIntraday,
  oscPanesOf,
  withAlpha,
  type ChartFrame,
  type ChartLineStyle,
  type ChartPalette,
  type OscPane,
} from "@/lib/aitrader/charts";
import { pct, price as fprice } from "@/lib/portfolio";

// lightweight-charts' LineStyle values (its enum is a declared const enum: use the numbers).
const LINE_STYLE: Record<ChartLineStyle, LineStyle> = { solid: 0 as LineStyle, dotted: 1 as LineStyle, dashed: 2 as LineStyle };
const MARKER_POS = { above: "aboveBar", below: "belowBar", inBar: "inBar" } as const;

const asTime = (t: number) => t as UTCTimestamp;
const timeNum = (t: Time): number | null => (typeof t === "number" ? t : null);

/** The visible bars per symbol+frame, so a refresh (or a theme change) keeps the user's zoom. */
type SavedView = { key: string; range: LogicalRange; bars: number };

export function StockChart({ frame, symbol, palette }: { frame: ChartFrame; symbol: string; palette: ChartPalette }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SavedView | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([]);

  const intraday = useMemo(() => isIntraday(frame.candles), [frame]);
  const oscs = useMemo(() => oscPanesOf(frame), [frame]);
  const height = chartHeight(oscs.length);
  const viewKey = `${symbol}|${frame.id}`;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const p = palette;
    // Sub-dollar stocks get 4 decimals; everything else (oscillator panes included) 2.
    const dp = Math.abs(frame.candles[frame.candles.length - 1]?.c ?? 1) < 1 ? 4 : 2;
    const chart: IChartApi = createChart(el, {
      width: Math.max(el.clientWidth, 200),
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: p.dim,
        fontSize: 11,
        fontFamily: getComputedStyle(el).fontFamily || undefined,
        panes: { separatorColor: p.border, separatorHoverColor: withAlpha(p.faint, 0.25), enableResize: false },
      },
      grid: { vertLines: { color: withAlpha(p.border, 0.7) }, horzLines: { color: withAlpha(p.border, 0.7) } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: p.faint, labelBackgroundColor: p.text },
        horzLine: { color: p.faint, labelBackgroundColor: p.text },
      },
      rightPriceScale: { borderColor: p.border },
      timeScale: {
        borderColor: p.border,
        timeVisible: intraday,
        secondsVisible: false,
        rightOffset: 3,
        tickMarkFormatter: (t: Time, type: number) => {
          const n = timeNum(t);
          return n == null ? null : fmtTick(n, type, intraday);
        },
      },
      localization: {
        timeFormatter: (t: Time) => {
          const n = timeNum(t);
          return n == null ? "" : fmtBarTime(n, intraday);
        },
        priceFormatter: (v: number) => fprice(v, dp),
      },
      // Let a finger scroll the page up and down over the chart; horizontal drag still pans.
      handleScroll: { vertTouchDrag: false },
    });

    // ---- price pane: candles, levels, markers ----
    const candles = chart.addSeries(
      CandlestickSeries,
      {
        upColor: p.gain,
        downColor: p.loss,
        borderUpColor: p.gain,
        borderDownColor: p.loss,
        wickUpColor: p.gain,
        wickDownColor: p.loss,
        priceLineVisible: false,
      },
      0,
    );
    candles.setData(frame.candles.map((k) => ({ time: asTime(k.t), open: k.o, high: k.h, low: k.l, close: k.c })));
    for (const lv of frame.levels) {
      candles.createPriceLine({
        price: lv.price,
        color: p[lv.color],
        lineWidth: 1,
        lineStyle: LINE_STYLE[lv.style],
        axisLabelVisible: true,
        title: lv.label,
      });
    }
    if (frame.markers.length) {
      const markers: SeriesMarker<Time>[] = frame.markers.map((m) => ({
        time: asTime(m.t),
        position: MARKER_POS[m.position],
        shape: m.shape,
        color: p[m.color],
        ...(m.text ? { text: m.text } : {}),
        ...(m.size != null ? { size: m.size } : {}),
      }));
      createSeriesMarkers(candles, markers);
    }

    // ---- lines: price ones on pane 0, oscillators on panes 1 / 2 ----
    const paneOf = (pane: "price" | OscPane) => (pane === "price" ? 0 : 1 + oscs.indexOf(pane));
    const firstInPane = new Map<number, ISeriesApi<SeriesType>>();
    for (const l of frame.lines) {
      const pane = paneOf(l.pane);
      const s = chart.addSeries(
        LineSeries,
        {
          color: p[l.color],
          lineWidth: l.width as LineWidth,
          lineStyle: LINE_STYLE[l.style],
          priceLineVisible: false,
          lastValueVisible: pane > 0,
          crosshairMarkerRadius: 3,
        },
        pane,
      );
      s.setData(l.points.map((pt) => ({ time: asTime(pt.t), value: pt.v })));
      if (!firstInPane.has(pane)) firstInPane.set(pane, s);
    }
    for (const ol of frame.oscLevels) {
      const s = firstInPane.get(paneOf(ol.pane));
      if (!s || !oscs.includes(ol.pane)) continue;
      s.createPriceLine({ price: ol.value, color: p[ol.color], lineWidth: 1, lineStyle: LINE_STYLE.dashed, axisLabelVisible: true, title: ol.label });
    }
    const panes = chart.panes();
    panes[0]?.setStretchFactor(oscs.length ? 3 : 1);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);

    // ---- what to show: the user's zoom from before a refresh, else the latest bars ----
    const n = frame.candles.length;
    const saved = viewRef.current;
    if (saved && saved.key === viewKey) {
      // Following the newest bar? Keep following it as bars arrive.
      const shift = saved.range.to >= saved.bars - 1 ? n - saved.bars : 0;
      chart.timeScale().setVisibleLogicalRange({ from: saved.range.from + shift, to: saved.range.to + shift });
    } else {
      const first = initialBars(frame.id, intraday);
      if (first != null && n > first) chart.timeScale().setVisibleLogicalRange({ from: n - first, to: n + 2 });
      else chart.timeScale().fitContent();
    }
    // Remember the view only once the user has panned or zoomed (the chart's own layout passes report
    // ranges too); it's saved when this chart is replaced by a refresh or a theme change.
    let touched = false;
    const onTouch = () => {
      touched = true;
    };
    const touchEvents = ["pointerdown", "wheel", "touchstart"] as const;
    for (const ev of touchEvents) el.addEventListener(ev, onTouch, { passive: true });

    chart.subscribeCrosshairMove((param) => {
      const t = param.time != null && param.point ? timeNum(param.time) : null;
      setHover(t);
    });

    // ---- size: follow the box's width; place the lower panes' titles ----
    const measure = () => {
      const tops: number[] = [];
      let y = 0;
      for (let i = 0; i < chart.panes().length; i++) {
        tops.push(y);
        y += chart.paneSize(i).height + 1; // 1 px separator
      }
      setPaneTops(tops);
    };
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
      if (w > 0) chart.resize(w, height);
      requestAnimationFrame(measure);
    });
    ro.observe(el);
    const raf = requestAnimationFrame(measure);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const ev of touchEvents) el.removeEventListener(ev, onTouch);
      const r = touched ? chart.timeScale().getVisibleLogicalRange() : null;
      if (r) viewRef.current = { key: viewKey, range: { from: r.from, to: r.to } as LogicalRange, bars: n };
      chart.remove();
    };
  }, [frame, palette, intraday, oscs, height, viewKey]);

  // ---- the read-out: the hovered bar (or the latest one) with every line's value ----
  const lineMaps = useMemo(() => frame.lines.map((l) => new Map(l.points.map((pt) => [pt.t, pt.v]))), [frame]);
  const idx = hover != null ? barIndexAt(frame.candles, hover) : frame.candles.length - 1;
  const bar = frame.candles[Math.max(0, idx)];
  const prev = idx > 0 ? frame.candles[idx - 1] : null;
  const change = prev && prev.c ? (bar.c / prev.c - 1) * 100 : null;
  const values = frame.lines
    .map((l, i) => ({ l, v: lineMaps[i].get(bar.t) }))
    .filter((x): x is { l: (typeof frame.lines)[number]; v: number } => x.v != null);

  const dp = Math.abs(bar.c) < 1 ? 4 : 2;
  const paneTitle = (pane: OscPane) => frame.panes[pane] ?? (pane === "osc" ? "Momentum" : "Second indicator");

  return (
    <div className="min-w-0">
      <div className="mb-1.5 min-h-[2.5rem] font-mono text-[11px] leading-snug text-dim tnum" aria-live="off">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-text">{fmtBarTime(bar.t, intraday)}</span>
          <span>
            O <b className="font-medium text-text">{fprice(bar.o, dp)}</b>
          </span>
          <span>
            H <b className="font-medium text-text">{fprice(bar.h, dp)}</b>
          </span>
          <span>
            L <b className="font-medium text-text">{fprice(bar.l, dp)}</b>
          </span>
          <span>
            C <b className="font-medium text-text">{fprice(bar.c, dp)}</b>
          </span>
          {change != null && <span style={{ color: change >= 0 ? palette.gain : palette.loss }}>{pct(change)}</span>}
          {hover == null && <span className="font-sans text-faint">latest · touch or hover the chart for any bar</span>}
        </div>
        {values.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {values.map(({ l, v }) => (
              <span key={l.id} className="inline-flex items-baseline gap-1">
                <span className="inline-block h-0.5 w-2.5 self-center rounded" style={{ backgroundColor: palette[l.color] }} aria-hidden />
                <span className="font-sans">{l.label}</span>
                <b className="font-medium text-text">{fprice(v, dp)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative w-full" style={{ height }}>
        <div ref={boxRef} className="absolute inset-0" />
        {oscs.map((pane, i) =>
          paneTops[i + 1] != null ? (
            <span
              key={pane}
              className="pointer-events-none absolute left-1.5 rounded bg-surface/80 px-1 text-[10px] font-medium text-dim"
              style={{ top: paneTops[i + 1] + 2 }}
            >
              {paneTitle(pane)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
