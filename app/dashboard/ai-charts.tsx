"use client";

/**
 * Stock charts for the two Claude boxes (claude-day / claude-long), drawn from the `ai_charts` rows
 * the Mac upserts: one symbol's chart (AiChartPanel, used on the open-position cards and in the flow
 * panel) and the "Charts" tab (AiChartsSection: Holding / Watching chips + the chart). Each loads only
 * while shown and re-reads at the flow panel's cadence, paused while the browser tab is hidden.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { loadAiChart, loadAiCharts } from "../actions";
import {
  FALLBACK_PALETTE,
  asOfLabel,
  chartHeight,
  chooseFrame,
  defaultChartSymbol,
  groupCharts,
  legendOf,
  paletteFrom,
  samePalette,
  type ChartData,
  type ChartFrame,
  type ChartListItem,
  type ChartPalette,
  type ChartRole,
} from "@/lib/aitrader/charts";
import { marketOpenET } from "@/lib/livequotes";
import { price as fprice, shares } from "@/lib/portfolio";

// Same cadence as the "How it works — live" panel (and LiveUpdates).
const OPEN_MS = 15_000;
const CLOSED_MS = 120_000;

function ChartLoading({ height = chartHeight(0) }: { height?: number }) {
  return <div className="w-full animate-pulse rounded-lg bg-surface2/60" style={{ height: height + 40 }} aria-label="Loading the chart" />;
}

const StockChart = dynamic(() => import("./stock-chart").then((m) => m.StockChart), { ssr: false, loading: () => <ChartLoading /> });

/* ---------------- theme colours (re-read when the theme changes) ---------------- */

let cached: ChartPalette = FALLBACK_PALETTE;
let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour as something the chart library can parse (#hex / rgba): modern forms via a 1-px canvas. */
function toChartColor(c: string): string {
  if (/^#|^rgba?\(/i.test(c)) return c;
  try {
    if (probe === undefined) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      probe = cv.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return c;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = c;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  } catch {
    return c;
  }
}

function readPalette(): ChartPalette {
  const css = getComputedStyle(document.documentElement);
  const next = paletteFrom((v) => {
    const raw = css.getPropertyValue(v).trim();
    return raw ? toChartColor(raw) : null;
  });
  if (!samePalette(next, cached)) cached = next;
  return cached;
}

function subscribeTheme(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

/** The theme's chart colours (CHART_CSS_VAR in lib/aitrader/charts), following theme switches. */
export function useChartPalette(): ChartPalette {
  return useSyncExternalStore(subscribeTheme, readPalette, () => FALLBACK_PALETTE);
}

/* ---------------- polling ---------------- */

/** Runs `load` now and then every 15 s (market open) / 2 min (closed) while the browser tab is visible. */
function usePoll(load: () => Promise<void>, marketOpen: boolean, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      clearTimeout(timer);
      if (document.visibilityState === "visible") await load();
      if (!stopped) timer = setTimeout(tick, marketOpen ? OPEN_MS : CLOSED_MS);
    }
    function onVisible() {
      if (document.visibilityState === "visible") void tick();
    }
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, marketOpen, enabled]);
}

type ChartState =
  | { symbol: string; status: "loading" }
  | { symbol: string; status: "none" }
  | { symbol: string; status: "error"; error: string; prev: Extract<ChartState, { status: "ok" }> | null }
  | { symbol: string; status: "ok"; chart: ChartData; role: ChartRole; updatedAt: string | null; at: number };

function useAiChart(bookKey: string, symbol: string, marketOpen: boolean): ChartState {
  const [state, setState] = useState<ChartState>({ symbol, status: "loading" });
  const seq = useRef(0);
  const have = useRef<{ symbol: string; updatedAt: string | null } | null>(null);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const since = have.current?.symbol === symbol ? have.current.updatedAt : null;
    try {
      const r = await loadAiChart(bookKey, symbol, since);
      if (n !== seq.current) return;
      if ("error" in r) {
        setState((s) => ({ symbol, status: "error", error: r.error, prev: s.symbol === symbol && s.status === "ok" ? s : s.symbol === symbol && s.status === "error" ? s.prev : null }));
      } else if (r.status === "none") {
        have.current = null;
        setState({ symbol, status: "none" });
      } else if (r.status === "same") {
        setState((s) => (s.symbol === symbol && s.status === "ok" ? { ...s, at: Date.now() } : s));
      } else {
        have.current = { symbol, updatedAt: r.updatedAt };
        setState({ symbol, status: "ok", chart: r.chart, role: r.role, updatedAt: r.updatedAt, at: Date.now() });
      }
    } catch {
      if (n === seq.current)
        setState((s) => ({ symbol, status: "error", error: "connection problem", prev: s.symbol === symbol && s.status === "ok" ? s : null }));
    }
  }, [bookKey, symbol]);

  usePoll(load, marketOpen, true);
  // A different symbol than the state holds = still loading it.
  return state.symbol === symbol ? state : { symbol, status: "loading" };
}

/* ---------------- one symbol's chart ---------------- */

function Swatch({ color, style }: { color: string; style: "solid" | "dashed" | "dotted" }) {
  return <span className="inline-block w-4 shrink-0 self-center" style={{ borderTop: `2px ${style} ${color}` }} aria-hidden />;
}

const MARKER_GLYPH = { arrowUp: "▲", arrowDown: "▼", circle: "●", square: "■" } as const;

function Legend({ frame, palette }: { frame: ChartFrame; palette: ChartPalette }) {
  const items = legendOf(frame);
  // One legend entry per distinct marker (e.g. "BUY ★", "SELL ★", "filled").
  const marks = new Map<string, ChartFrame["markers"][number]>();
  for (const m of frame.markers) {
    const k = `${m.shape}|${m.color}|${m.text ?? ""}`;
    if (!marks.has(k)) marks.set(k, m);
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-flex gap-px" aria-hidden>
          <span className="inline-block h-2.5 w-1.5 rounded-[1px]" style={{ backgroundColor: palette.gain }} />
          <span className="inline-block h-2.5 w-1.5 rounded-[1px]" style={{ backgroundColor: palette.loss }} />
        </span>
        Candles: green = closed higher, red = closed lower ({frame.label.toLowerCase()} bars)
      </li>
      {items.map((it, i) => (
        <li key={`${it.kind}-${i}`} className="inline-flex items-center gap-1.5">
          <Swatch color={palette[it.color]} style={it.style} />
          <span>
            <span className="text-text">{it.label || "Level"}</span>
            {it.value != null && it.kind !== "line" && <span className="font-mono tnum"> {fprice(it.value)}</span>}
            {it.where !== "price" && <span className="text-faint"> · {it.where}</span>}
            {it.kind === "level" && <span className="text-faint"> · price line</span>}
          </span>
        </li>
      ))}
      {[...marks.values()].map((m, i) => (
        <li key={`m-${i}`} className="inline-flex items-center gap-1.5">
          <span style={{ color: palette[m.color] }} aria-hidden>
            {MARKER_GLYPH[m.shape]}
          </span>
          <span className="text-text">{m.text ?? (m.shape === "arrowUp" ? "Buy mark" : m.shape === "arrowDown" ? "Sell mark" : "Mark")}</span>
        </li>
      ))}
    </ul>
  );
}

function TradeLine({ chart }: { chart: ChartData }) {
  const t = chart.trade;
  if (!t) return null;
  const parts: string[] = [];
  if (t.status === "held") parts.push(`${t.side === "short" ? "Short" : "Holding"} ${shares(t.qty)} sh · in at $${fprice(t.entry)}`);
  else if (t.status === "armed") parts.push(`Ready to ${t.side === "short" ? "short" : "buy"} near $${fprice(t.entry)}`);
  else parts.push(`Watching · would ${t.side === "short" ? "short" : "buy"} near $${fprice(t.entry)}`);
  return (
    <div className="text-xs text-dim">
      <span className="font-mono tnum">{parts.join(" · ")}</span>
      {t.stop != null && <span className="font-mono text-loss tnum"> · stop ${fprice(t.stop)}</span>}
      {t.target != null && <span className="font-mono text-gain tnum"> · target ${fprice(t.target)}</span>}
      {t.why && <p className="mt-1 leading-relaxed">{t.why}</p>}
    </div>
  );
}

/**
 * One symbol's chart with its frame switcher, legend and notes. `quietIfMissing`: render nothing
 * (instead of "No chart yet") when the Mac hasn't sent a chart for this symbol.
 */
export function AiChartPanel({
  bookKey,
  symbol,
  marketOpen: clockOpen,
  quietIfMissing = false,
}: {
  bookKey: string;
  symbol: string;
  marketOpen: boolean | null;
  quietIfMissing?: boolean;
}) {
  const marketOpen = clockOpen ?? marketOpenET();
  const palette = useChartPalette();
  const state = useAiChart(bookKey, symbol, marketOpen);
  const [picked, setPicked] = useState<string | null>(null);
  const ok = state.status === "ok" ? state : state.status === "error" ? state.prev : null;
  const frame = useMemo(() => (ok ? chooseFrame(ok.chart, picked) : null), [ok, picked]);

  if (state.status === "loading") return quietIfMissing ? null : <ChartLoading />;
  if (state.status === "none" || (state.status === "error" && !ok)) {
    if (quietIfMissing) return null;
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-dim">
        {state.status === "none" ? "No chart yet — the Mac sends one with its next scan." : `Couldn't load the chart: ${state.error}`}
      </p>
    );
  }
  if (!ok || !frame) return null;
  const chart = ok.chart;
  const asOf = asOfLabel(chart.asOf ?? ok.updatedAt);

  return (
    <div className="min-w-0 space-y-2.5 rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">{chart.symbol}</span>
        {chart.title && <span className="min-w-0 truncate text-xs text-dim">{chart.title}</span>}
        {chart.frames.length > 1 && (
          <div className="ml-auto flex gap-1" role="group" aria-label="Chart time frame">
            {chart.frames.map((f) => {
              const on = f.id === frame.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setPicked(f.id)}
                  aria-pressed={on}
                  title={f.label}
                  className={`rounded-md px-2 py-0.5 text-[11px] transition ${on ? "bg-text font-semibold text-surface" : "bg-surface2 text-dim hover:text-text"}`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
        <span className={`text-[11px] text-faint ${chart.frames.length > 1 ? "w-full sm:w-auto" : "ml-auto"}`}>
          {chart.frames.length === 1 && <>{frame.label} · </>}
          {asOf ? `updated ${asOf}` : ""}
        </span>
      </div>

      <TradeLine chart={chart} />

      <StockChart frame={frame} symbol={chart.symbol} palette={palette} />

      <Legend frame={frame} palette={palette} />

      {chart.notes.length > 0 && (
        <ul className="space-y-0.5 border-t border-border pt-2 text-xs leading-relaxed text-dim">
          {chart.notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}
      {state.status === "error" && <p className="text-[11px] text-loss">Couldn&apos;t refresh: {state.error}. Showing the last chart.</p>}
    </div>
  );
}

/* ---------------- the "Charts" tab ---------------- */

function Chip({ it, on, onPick }: { it: ChartListItem; on: boolean; onPick: (s: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(it.symbol)}
      aria-pressed={on}
      title={it.title ?? it.symbol}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-display text-xs font-semibold transition ${on ? "bg-text text-surface" : "bg-surface2 text-text hover:bg-border"}`}
    >
      {it.symbol}
      {it.status === "armed" && <span className={`text-[9px] font-bold uppercase tracking-wider ${on ? "text-surface/80" : "text-watch"}`}>ready</span>}
      {it.side === "short" && it.role === "held" && <span className={`text-[9px] font-bold uppercase tracking-wider ${on ? "text-surface/80" : "text-loss"}`}>short</span>}
    </button>
  );
}

/** Every symbol the Mac sent a chart for (held first, then watched) and the picked one's chart. */
export function AiChartsSection({ bookKey, marketOpen: clockOpen }: { bookKey: string; marketOpen: boolean | null }) {
  const marketOpen = clockOpen ?? marketOpenET();
  const [items, setItems] = useState<ChartListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await loadAiCharts(bookKey);
      if (n !== seq.current) return;
      if ("error" in r) setErr(r.error);
      else {
        setErr(null);
        setItems(r.items);
      }
    } catch {
      if (n === seq.current) setErr("connection problem");
    }
  }, [bookKey]);
  usePoll(load, marketOpen, true);

  const symbol = items ? defaultChartSymbol(items, picked) : null;
  const groups = items ? groupCharts(items) : null;

  return (
    <div className="space-y-3">
      {err && <p className="rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">Couldn&apos;t load the chart list: {err}</p>}
      {!items && !err && <p className="text-sm text-dim">Loading…</p>}
      {items && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
          No charts yet — the Mac sends one for each stock it holds or watches with its next scan.
        </p>
      )}
      {groups && items && items.length > 0 && (
        <div className="space-y-2">
          {(
            [
              ["Holding", groups.holding],
              ["Watching", groups.watching],
            ] as const
          ).map(([label, list]) =>
            list.length ? (
              <div key={label} className="flex flex-wrap items-center gap-1.5">
                <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</span>
                {list.map((it) => (
                  <Chip key={it.symbol} it={it} on={it.symbol === symbol} onPick={setPicked} />
                ))}
              </div>
            ) : null,
          )}
        </div>
      )}
      {symbol && <AiChartPanel key={symbol} bookKey={bookKey} symbol={symbol} marketOpen={clockOpen} />}
      <p className="text-[11px] leading-relaxed text-faint">
        The Mac sends these charts with each scan{bookKey === "claude-long" ? " (about every 15 minutes)" : " (about every 5 minutes in market hours)"}. Drag
        sideways to scroll back in time; pinch or scroll to zoom.
      </p>
    </div>
  );
}
