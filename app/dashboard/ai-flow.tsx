"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadAiFlow } from "../actions";
import {
  FLOW_STEPS,
  STEP_HINT,
  STEP_LABEL,
  dayLabel,
  failedWord,
  fillLine,
  nowStep,
  nyDate,
  nyTime,
  pathSteps,
  recentDays,
  summarize,
  toneOf,
  totalCount,
  type AiEvent,
  type AiFlowData,
  type FlowStep,
} from "@/lib/aitrader/flow";
import { marketOpenET } from "@/lib/livequotes";
import { LABEL } from "./ai-run";
import { AiChartPanel } from "./ai-charts";

const OPEN_MS = 15_000; // same cadence as LiveUpdates
const CLOSED_MS = 120_000;
const PAGE = 200;

/**
 * Desktop: a snake over two rows (1→5 left to right, then 6→9 right to left under it); phones: a column.
 * Static class strings so Tailwind sees them.
 */
const PLACE = [
  "md:col-start-1 md:row-start-1",
  "md:col-start-2 md:row-start-1",
  "md:col-start-3 md:row-start-1",
  "md:col-start-4 md:row-start-1",
  "md:col-start-5 md:row-start-1",
  "md:col-start-5 md:row-start-2",
  "md:col-start-4 md:row-start-2",
  "md:col-start-3 md:row-start-2",
  "md:col-start-2 md:row-start-2",
];
/** The desktop arrow leaving node i: right along row 1, down at its end, left along row 2. */
const ARROW: (null | { glyph: string; cls: string })[] = [
  { glyph: "→", cls: "md:-right-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "→", cls: "md:-right-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "→", cls: "md:-right-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "→", cls: "md:-right-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "↓", cls: "md:-bottom-[1.15rem] md:left-1/2 md:-translate-x-1/2" },
  { glyph: "←", cls: "md:-left-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "←", cls: "md:-left-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  { glyph: "←", cls: "md:-left-[1.1rem] md:top-1/2 md:-translate-y-1/2" },
  null,
];

const TONE_DOT = { ok: "bg-gain", bad: "bg-loss", neutral: "bg-faint" } as const;
const TONE_TEXT = { ok: "text-text", bad: "text-loss", neutral: "text-text" } as const;

function SymbolChip({ sym, on, onPick }: { sym: string; on?: boolean; onPick: (s: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPick(sym);
      }}
      title={`Follow ${sym} through the steps`}
      className={`rounded px-1.5 py-0.5 font-display text-[11px] font-semibold transition ${on ? "bg-text text-surface" : "bg-surface2 text-text hover:bg-border"}`}
    >
      {sym}
    </button>
  );
}

function Node({
  step,
  i,
  s,
  now,
  withDay,
  countLabel,
  symbol,
  onPick,
}: {
  step: FlowStep;
  i: number;
  s: ReturnType<typeof summarize>[FlowStep];
  now: boolean;
  withDay: boolean;
  countLabel: string;
  symbol: string | null;
  onPick: (s: string) => void;
}) {
  const arrow = ARROW[i];
  const idle = s.count === 0;
  return (
    <li className={`relative ${PLACE[i]}`}>
      <div
        className={`h-full rounded-lg border px-2.5 py-2 transition ${now ? "border-gain bg-gain/5 ring-2 ring-gain/40" : idle ? "border-dashed border-border bg-surface" : "border-border bg-surface2/40"}`}
        title={STEP_HINT[step]}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className={`font-display text-[13px] font-semibold ${idle ? "text-dim" : "text-text"}`}>
              <span className="mr-1 font-mono text-[10px] font-normal text-faint tnum">{i + 1}</span>
              {STEP_LABEL[step]}
            </div>
          </div>
          <div className="text-right">
            <div className={`font-mono text-base font-semibold leading-none tnum ${idle ? "text-faint" : "text-text"}`} title={countLabel}>
              {s.count}
            </div>
          </div>
        </div>
        {(now || s.failed > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {now && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gain/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gain">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gain" aria-hidden /> now
            </span>
          )}
          {s.failed > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-loss/10 px-1.5 py-0.5 text-[10px] font-semibold text-loss">
              <span className="h-1.5 w-1.5 rounded-full bg-loss" aria-hidden />
              {s.failed} {failedWord(step)}
            </span>
          )}
        </div>
        )}
        {s.latest && (
          <p className="mt-1 truncate text-[11px] leading-snug text-dim" title={s.latest.title}>
            <span className="font-mono text-[10px] text-faint tnum">{nyTime(s.latest.at, withDay)}</span> {s.latest.title}
          </p>
        )}
        {!symbol && s.symbols.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.symbols.slice(0, 3).map((sym) => (
              <SymbolChip key={sym} sym={sym} onPick={onPick} />
            ))}
            {s.symbols.length > 3 && <span className="self-center text-[10px] text-faint">+{s.symbols.length - 3}</span>}
          </div>
        )}
      </div>
      {i < FLOW_STEPS.length - 1 && (
        <>
          <span className="flex justify-center py-0.5 text-faint md:hidden" aria-hidden>
            ↓
          </span>
          {arrow && (
            <span className={`absolute hidden text-sm leading-none text-faint md:block ${arrow.cls}`} aria-hidden>
              {arrow.glyph}
            </span>
          )}
        </>
      )}
    </li>
  );
}

function FeedRow({ e, withDay, symbol, onPick }: { e: AiEvent; withDay: boolean; symbol: string | null; onPick: (s: string) => void }) {
  const tone = toneOf(e);
  const fill = fillLine(e);
  return (
    <li className="flex gap-3 px-3.5 py-2 text-sm">
      <span className="w-[4.5rem] shrink-0 pt-0.5 font-mono text-[11px] text-faint tnum">{nyTime(e.at, withDay)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone === "bad" ? "bg-loss/10 text-loss" : "bg-surface2 text-dim"}`}
          >
            {STEP_LABEL[e.step]}
          </span>
          {e.symbol && <SymbolChip sym={e.symbol} on={symbol === e.symbol} onPick={onPick} />}
          {e.ok === false && <span className="text-[10px] font-semibold text-loss">{failedWord(e.step)}</span>}
          {e.ok === true && e.step === "check" && <span className="text-[10px] font-semibold text-gain">allowed</span>}
        </span>
        <span className={`mt-0.5 block text-[13px] leading-snug ${TONE_TEXT[tone]}`}>{e.title}</span>
        {fill && <span className="block font-mono text-[11px] text-dim tnum">{fill}</span>}
      </span>
    </li>
  );
}

/**
 * "How it works — live" for a Claude box: the Mac's recorded steps (ai_events) as a flow chart plus a
 * feed. Loads only while open; while it shows today it re-reads every 15 s (market open) or 2 min
 * (closed), pausing while the tab is hidden, like LiveUpdates.
 */
export function HowItWorksLive({ bookKey, marketOpen: clockOpen }: { bookKey: string; marketOpen: boolean | null }) {
  // The Alpaca clock when the website has it, else New York's regular session hours.
  const marketOpen = clockOpen ?? marketOpenET();
  const [open, setOpen] = useState(true);
  const [day, setDay] = useState<string | null>(null); // null = today
  const [symbol, setSymbol] = useState<string | null>(null);
  const [withWatch, setWithWatch] = useState(false);
  const [showDetails, setShowDetails] = useState(false); // the step-by-step history: hidden until asked for
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState<AiFlowData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const seq = useRef(0);

  // Remember open/closed per browser (a convenience only).
  const storeKey = `ai-flow-open:${bookKey}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storeKey);
      // Read after hydration so the server and first client render match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved != null) setOpen(saved === "1");
    } catch {
      /* storage blocked */
    }
  }, [storeKey]);

  const fetchNow = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await loadAiFlow({ bookKey, day, symbol, limit: showDetails ? limit : 1, withWatch });
      if (n !== seq.current) return; // a newer request (filter change) superseded this one
      if ("error" in r) setErr(r.error);
      else {
        setErr(null);
        setData(r);
      }
    } catch {
      if (n === seq.current) setErr("connection problem");
    } finally {
      if (n === seq.current) {
        setLoading(false);
        setNowMs(Date.now());
      }
    }
  }, [bookKey, day, symbol, limit, withWatch, showDetails]);

  // Load on open and on every filter change; keep today current, paused while the tab is hidden.
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const live = day == null;

    async function tick() {
      clearTimeout(timer);
      if (document.visibilityState === "visible") await fetchNow();
      if (!stopped && live) timer = setTimeout(tick, marketOpen ? OPEN_MS : CLOSED_MS);
    }
    function onVisible() {
      if (live && document.visibilityState === "visible") void tick();
    }

    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, day, marketOpen, fetchNow]);

  const summary = useMemo(() => (data ? summarize(data.nodes, data.watch ?? undefined) : null), [data]);
  const today = data?.today ?? nyDate();
  const days = recentDays(today);
  const showingToday = data ? data.day === data.today : day == null;
  const current = summary && showingToday ? nowStep(summary, nowMs) : null;
  const multiDay = !!data?.symbol;
  const countLabel = multiDay ? "7 days" : showingToday ? "today" : "that day";
  const path = data?.symbol ? pathSteps(data.nodes) : [];
  // Data for another filter is still on screen while the new one loads.
  const stale = !!data && (data.symbol !== symbol || (day != null && data.day !== day) || (day == null && data.day !== data.today));

  function pick(sym: string) {
    setSymbol((s) => (s === sym ? null : sym));
    setLimit(PAGE);
  }

  return (
    <details
      open={open}
      onToggle={(e) => {
        const o = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(o);
        try {
          localStorage.setItem(storeKey, o ? "1" : "0");
        } catch {
          /* storage blocked */
        }
      }}
      className="group rounded-xl border border-border"
    >
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-4 py-3">
        <span className="font-display text-sm font-semibold text-text">How it works — live</span>
        {showingToday && open && !err && (
          <span className={`h-2 w-2 rounded-full ${marketOpen ? "animate-pulse bg-gain" : "bg-faint"}`} aria-hidden />
        )}
        <span className="ml-auto text-[11px] text-faint">
          {open ? (loading ? "updating…" : data ? `updated ${nyTime(data.at)} NY` : "") : "every step the Mac records, as it happens"}
        </span>
      </summary>

      <div className="space-y-3 border-t border-border p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {days.map((d) => {
            const on = (day ?? today) === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDay(d === today ? null : d);
                  setLimit(PAGE);
                }}
                aria-pressed={on}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${on ? "bg-text font-semibold text-surface" : "bg-surface2 text-dim hover:text-text"}`}
              >
                {dayLabel(d, today)}
              </button>
            );
          })}
        </div>

        {/* The stock's chart above its path, when the Mac has sent one (nothing otherwise). */}
        {symbol && <AiChartPanel key={symbol} bookKey={bookKey} symbol={symbol} marketOpen={clockOpen} quietIfMissing />}

        {symbol && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface2/70 px-3 py-2 text-xs text-dim">
            <span>
              Following <b className="font-display text-text">{symbol}</b> over the last 7 days
              {path.length > 0 && ":"}
            </span>
            {path.length > 0 && (
              <span className="font-mono text-[11px] text-text">{path.map((p) => STEP_LABEL[p]).join(" → ")}</span>
            )}
            <button type="button" onClick={() => setSymbol(null)} className="ml-auto font-medium text-accent hover:underline">
              Show all
            </button>
          </div>
        )}

        {err && <p className="rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">Couldn&apos;t load the steps: {err}</p>}

        {!data && !err && <p className="text-sm text-dim">Loading…</p>}

        {data && summary && (
          <div className={`space-y-4 transition-opacity ${stale ? "opacity-50" : ""}`}>
            {totalCount(summary) === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
                {data.symbol
                  ? `No steps recorded for ${data.symbol} in the last 7 days.`
                  : showingToday
                    ? "No steps recorded yet today — the Mac starts writing these from its next check."
                    : "No steps recorded on this day."}
              </p>
            ) : (
              <>
                <ol className="flex flex-col md:grid md:grid-cols-5 md:gap-x-5 md:gap-y-4">
                  {FLOW_STEPS.map((step, i) => (
                    <Node
                      key={step}
                      step={step}
                      i={i}
                      s={summary[step]}
                      now={current === step}
                      withDay={multiDay}
                      countLabel={countLabel}
                      symbol={data.symbol}
                      onPick={pick}
                    />
                  ))}
                </ol>

                {summary.error.count > 0 && (
                  <div
                    className={`rounded-xl border border-loss/40 bg-loss/5 p-3 ${current === "error" ? "ring-2 ring-loss/40" : ""}`}
                    title={STEP_HINT.error}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-display text-sm font-semibold text-loss">
                        <span className="h-2 w-2 rounded-full bg-loss" aria-hidden />
                        {STEP_LABEL.error}
                      </span>
                      <span className="font-mono text-sm font-semibold text-loss tnum">
                        {summary.error.count} <span className="text-[10px] font-normal">{countLabel}</span>
                      </span>
                    </div>
                    {summary.error.latest && (
                      <p className="mt-1 text-[12px] leading-snug text-loss">
                        <span className="font-mono text-[11px] tnum">{nyTime(summary.error.latest.at, multiDay)}</span>{" "}
                        {summary.error.latest.title}
                      </p>
                    )}
                  </div>
                )}

                {data.truncated && <p className="text-[11px] text-faint">Very busy day: counts show the newest 2,000 steps.</p>}
              </>
            )}

            {totalCount(summary) > 0 && !showDetails && (
              <button type="button" onClick={() => setShowDetails(true)} className="text-xs font-medium text-accent hover:underline">
                Show details — every step, newest first
              </button>
            )}

            {totalCount(summary) > 0 && showDetails && (
              <section>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className={LABEL}>
                    Step by step, newest first{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setShowDetails(false);
                        setLimit(PAGE);
                      }}
                      className="ml-2 font-sans text-[11px] font-medium normal-case tracking-normal text-accent hover:underline"
                    >
                      Hide details
                    </button>
                  </h4>
                  {!data.symbol && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
                      <input
                        type="checkbox"
                        checked={withWatch}
                        onChange={(e) => {
                          setWithWatch(e.target.checked);
                          setLimit(PAGE);
                        }}
                        className="accent-current"
                      />
                      Show the every-minute checks{data.watch ? ` (${data.watch.count})` : ""}
                    </label>
                  )}
                </div>
                {data.feed.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-xs text-dim">
                    Only the every-minute checks so far — tick the box above to see them.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {data.feed.map((e) => (
                      <FeedRow key={e.id} e={e} withDay={multiDay} symbol={data.symbol} onPick={pick} />
                    ))}
                  </ul>
                )}
                {data.feedMore && (
                  <button
                    type="button"
                    onClick={() => setLimit((l) => l + PAGE)}
                    disabled={loading}
                    className="mt-2 text-xs font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    {loading ? "Loading…" : "Show more"}
                  </button>
                )}
              </section>
            )}
          </div>
        )}

        <p className="text-[11px] text-faint">Click a stock to follow it through the steps. Hover a step for its full text.</p>
      </div>
    </details>
  );
}
