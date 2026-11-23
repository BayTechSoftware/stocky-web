"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadAiCharts, loadAiNow } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import { CLAUDE_LIMITS, LONG_LIMITS, RUNNER_LIMITS, boxEnabled, defsForBook, effective, type LimitValue } from "@/lib/aitrader/limits";
import { OWN_ACCOUNT_KEYS, isClaudeKey } from "@/lib/aitrader/boxes";
import type { SettingsSection } from "@/lib/aitrader/layout";
import { nowStep, nyDate, summarize, type AiEvent } from "@/lib/aitrader/flow";
import type { AiBookView } from "@/lib/aitrader/view";
import type { ChartListItem } from "@/lib/aitrader/charts";
import {
  nyClock,
  riskLevel,
  rightNowSteps,
  runSentence,
  shortDate,
  sinceYesterday,
  statusSentence,
  stopLine,
  stopPlan,
  todayStats,
  tooEarly,
  tradeLine,
  watchRows,
  winLoss,
  type NowStep,
  type Range,
  type Tone,
} from "@/lib/aitrader/page";
import { ClaudePlan, RunDetail, when } from "./ai-run";
import { BLURB, Block, ClosedTrades, CloseBoxPanel, DailyReviews, Empty, LimitsUsed, Replays, Timeline, exitBasis } from "./ai-book";
import { HowItWorksLive } from "./ai-flow";
import { AiChartPanel, AiChartsSection } from "./ai-charts";
import { CompareChart, CompareStrip, RangeSwitch, firstDayOf, useCompare, useSpyDaily, sinceFor } from "./ai-compare";

/* ---------------- shared bits (the overview uses them too) ---------------- */

export type BadgeTone = "paper" | "on" | "off" | "high" | "tag";

const BADGE: Record<BadgeTone, string> = {
  paper: "bg-paper-bg text-paper",
  on: "bg-gain-tint text-gain-ink",
  off: "bg-surface2 text-sub",
  high: "bg-loss-tint text-loss-ink",
  tag: "bg-surface2 text-sub rounded-[4px] px-1.5 py-0.5 text-[11px]",
};

/** One of the AI pages' few badges: Paper money, On / Off, a risk level, the SHORT tag. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  const shape = tone === "tag" ? "" : "rounded-full px-2.5 py-1 text-[12px]";
  return <span className={`inline-flex shrink-0 items-center font-semibold leading-none ${shape} ${BADGE[tone]}`}>{children}</span>;
}

export const PaperBadge = () => <Badge tone="paper">Paper money</Badge>;

/** ▲ / ▼ in front of a signed number (nothing for zero). */
export const arrow = (v: number | null | undefined) => (v == null || Math.abs(v) < 0.005 ? "" : v > 0 ? "▲ " : "▼ ");

export const TONE_TEXT: Record<Tone, string> = { gain: "text-gain", loss: "text-loss", flat: "text-text" };
export const toneText = (v: number | null | undefined) => (v == null || Math.abs(v) < 0.005 ? "text-text" : v > 0 ? "text-gain" : "text-loss");

export function CardTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="font-display text-[18px] font-semibold text-text md:text-[20px]">{children}</h2>
      {meta != null && <span className="text-[13px] text-dim tnum">{meta}</span>}
    </div>
  );
}

/** The link-blue text button. */
export function LinkButton({ onClick, children, className = "" }: { onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`text-left font-medium text-link hover:text-link-hover hover:underline ${className}`}>
      {children}
    </button>
  );
}

/* ---------------- data for "Right now" (claude-day / claude-long) ---------------- */

type NowData = { today: string; events: AiEvent[]; watch: { count: number; latestAt: string | null }; at: string };

/** Today's newest steps (light), re-read every minute while the market is open, and whenever the box's latest run changes. */
function useAiNow(bookKey: string, on: boolean, marketOpen: boolean | null, refreshKey: string): NowData | null {
  const [data, setData] = useState<NowData | null>(null);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const r = await loadAiNow(bookKey);
          if (!stopped && !("error" in r)) setData(r);
        } catch {
          /* keep what is shown */
        }
      }
      if (!stopped) timer = setTimeout(tick, marketOpen ? 60_000 : 300_000);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bookKey, on, marketOpen, refreshKey]);
  return on ? data : null;
}

/* ---------------- the page ---------------- */

type DetailKey = "flow" | "charts" | "trades" | "runs";

export function BoxPage({
  b,
  runner,
  marketOpen,
  clock,
  error,
  onBack,
  onSettings,
}: {
  b: AiBookView;
  runner: Record<string, LimitValue>;
  marketOpen: boolean | null;
  clock: { nextOpen: string; nextClose: string } | null;
  error: string | null;
  onBack: () => void;
  onSettings: (group?: SettingsSection) => void;
}) {
  const isClaude = isClaudeKey(b.key);
  const isLong = b.key === "claude-long";
  const own = OWN_ACCOUNT_KEYS.includes(b.key);
  const off = !boxEnabled(b.settings);
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // The clock is read after hydration (server and first client render match), then every minute.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const today = nyDate();
  const cfg = effective(defsForBook(b.key), b.settings);
  const runnerCfg = effective(RUNNER_LIMITS, runner);
  const spy = useSpyDaily(useMemo(() => sinceFor([b]), [b]));
  const now = useAiNow(b.key, own && isClaude, marketOpen, `${b.lastRun?.id ?? ""}|${b.todayTrades.length}`);
  const [openRows, setOpenRows] = useState<Set<DetailKey>>(new Set());
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const toggleRow = (k: DetailKey, force?: boolean) =>
    setOpenRows((s) => {
      const n = new Set(s);
      if (force ?? !n.has(k)) n.add(k);
      else n.delete(k);
      return n;
    });
  function seeAllTrades() {
    toggleRow("trades", true);
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const status = statusSentence({
    key: b.key,
    off,
    cfg,
    runner: runnerCfg,
    lastRunAt: b.lastRun?.ran_at ?? null,
    nowMs: nowMs || Date.parse(b.lastRun?.ran_at ?? "") || 0,
    marketOpen,
  });

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <nav className="flex items-center justify-between text-[14px]">
        <LinkButton onClick={onBack} className="min-h-11">
          ← All boxes
        </LinkButton>
        <LinkButton onClick={() => onSettings()} className="min-h-11 md:hidden">
          Settings
        </LinkButton>
      </nav>

      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-text md:text-[30px]">{b.name}</h1>
          <PaperBadge />
          <Badge tone={off ? "off" : "on"}>{off ? "Off" : "On"}</Badge>
          <LinkButton onClick={() => onSettings()} className="ml-auto hidden text-[14px] md:inline">
            Settings
          </LinkButton>
        </div>
        <p className="flex items-start gap-2 text-[15px] leading-snug text-sub">
          <span
            className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${off ? "bg-faint" : marketOpen === false ? "bg-faint" : "bg-gain"}`}
            aria-hidden
          />
          {status}
        </p>
        {error && <p className="rounded-[10px] bg-loss-tint px-3.5 py-2 text-[13px] text-loss-ink">{error}</p>}
      </header>

      <PerformanceCard b={b} spy={spy} today={today} />

      {isClaude && <RightNowCard b={b} cfg={cfg} runnerCfg={runnerCfg} now={now} today={today} nowMs={nowMs} />}

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-6">
        <HoldingCard b={b} charts={own} marketOpen={marketOpen} nowMs={nowMs} />
        <WatchingCard b={b} />
      </div>

      <TodayCard b={b} marketOpen={marketOpen} clock={clock} nowMs={nowMs} onSeeAll={seeAllTrades} />

      <div ref={detailsRef} className="ai-card-flush scroll-mt-4">
        {own && (
          <DetailRow k="flow" title="Every step, as it happens" hint="the live flow chart and log" open={openRows.has("flow")} onToggle={toggleRow}>
            <HowItWorksLive bookKey={b.key} marketOpen={marketOpen} embedded />
          </DetailRow>
        )}
        {own && (
          <DetailRow k="charts" title="Charts" hint="every held and watched stock with the signals Claude uses" open={openRows.has("charts")} onToggle={toggleRow}>
            <AiChartsSection bookKey={b.key} marketOpen={marketOpen} />
          </DetailRow>
        )}
        <DetailRow
          k="trades"
          title={isClaude && !isLong ? "Past trades and daily reviews" : isClaude ? "Past trades and reviews" : "Past trades"}
          hint={`${b.closed.length} closed trade${b.closed.length === 1 ? "" : "s"}${isClaude && b.reviews.length ? " · what Claude learned" : ""}`}
          open={openRows.has("trades")}
          onToggle={toggleRow}
        >
          <div className="space-y-7">
            <TodayFills trades={b.todayTrades} />
            <ClosedTrades trades={b.closed} />
            {isClaude && (!isLong || b.reviews.length > 0) && (
              <DailyReviews reviews={b.reviews} notes={b.notes} onLessons={() => onSettings("Learning")} />
            )}
          </div>
        </DetailRow>
        <DetailRow
          k="runs"
          title={isClaude ? "Claude's runs and costs" : "Runs, limits and closing the box"}
          hint={isClaude ? "each look, its steps and what it cost" : "the latest run, the limits used, close everything"}
          open={openRows.has("runs")}
          onToggle={toggleRow}
          last
        >
          <RunsDetail b={b} onSettings={onSettings} />
        </DetailRow>
      </div>
    </div>
  );
}

/* ---------------- performance ---------------- */

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-dim">{label}</div>
      <div className={`font-display text-[20px] font-semibold leading-tight tnum md:text-[28px] ${tone ?? "text-text"}`}>{value}</div>
      {sub != null && <div className="text-[13px] text-dim tnum">{sub}</div>}
    </div>
  );
}

const RISK_TONE = { Low: "on", Medium: "paper", High: "high" } as const;

function PerformanceCard({
  b,
  spy,
  today,
}: {
  b: AiBookView;
  spy: ReturnType<typeof useSpyDaily>;
  today: string;
}) {
  const isClaude = isClaudeKey(b.key);
  const isLong = b.key === "claude-long";
  const [range, setRange] = useState<Range>(b.key === "claude-day" ? "week" : "all");
  const cmp = useCompare(b, range, spy);
  const first = firstDayOf(b);
  const locked = b.todayTrades.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const openPnl = b.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const anyToday = b.todayTrades.some((t) => t.pnl != null) || b.positions.length > 0;
  const todayPnl = sinceYesterday(b.series, b.equity, today) ?? (anyToday ? locked + openPnl : null);
  const wl = winLoss(b.closed);
  const decided = b.wins + b.losses;

  // Risk today: the day's worst case at the stops against its limit (Claude day-trading boxes).
  const run = b.lastRun;
  const ranToday = !!run && nyDate(new Date(run.ran_at)) === today;
  const limitCfg = { ...effective(CLAUDE_LIMITS, b.settings), ...(run?.summary?.limits?.config ?? {}) };
  const risk =
    isClaude && !isLong
      ? riskLevel(ranToday ? run?.summary?.limits?.used?.loss_at_risk_usd ?? 0 : 0, Number(limitCfg.max_daily_loss_usd))
      : null;
  const cashPct = b.equity > 0 ? Math.max(0, (b.cash / b.equity) * 100) : null;
  const early = isLong ? tooEarly(first, today) : null;

  return (
    <section className="ai-card flex flex-col gap-5" aria-label="Performance">
      <div className="flex flex-wrap items-end gap-x-12 gap-y-5">
        <div className="basis-full sm:basis-auto">
          <div className="text-[13px] text-dim">Value now</div>
          <div className="font-display text-[40px] font-bold leading-[1.05] text-text md:text-[48px]">{money(b.equity, 0)}</div>
          <div className={`mt-1 text-[15px] font-semibold tnum ${toneText(b.pnl)}`}>
            {arrow(b.pnl)}
            {moneySigned(b.pnl, 0)} · {pct(b.pnlPct, 1)} {first ? `since ${shortDate(first)}` : "since the start"}
          </div>
        </div>
        <Stat
          label="Today"
          value={todayPnl != null ? moneySigned(todayPnl, 0) : "—"}
          tone={toneText(todayPnl)}
          sub={anyToday ? `${money(locked, 0)} locked in · ${money(openPnl, 0)} on open trades` : "no trades today"}
        />
        <Stat
          label="Trades won"
          value={decided ? `${Math.round((b.wins / decided) * 100)}%` : "—"}
          sub={
            decided
              ? [wl.avgWin != null ? `avg win ${money(wl.avgWin, 2)}` : null, wl.avgLoss != null ? `avg loss ${money(wl.avgLoss, 2)}` : null].filter(Boolean).join(" · ") ||
                `${b.wins} won · ${b.losses} lost`
              : "no closed trades yet"
          }
        />
        {risk ? (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="text-[13px] text-dim">Risk today</div>
            <div className="inline-flex items-center gap-2 text-[15px] font-semibold">
              <Badge tone={RISK_TONE[risk.level]}>{risk.level}</Badge>
              <span className="tnum">{Math.round(risk.pct)}% of daily limit</span>
            </div>
          </div>
        ) : isLong && cashPct != null ? (
          <Stat label="Cash" value={`${Math.round(cashPct)}%`} sub={`${money(b.cash, 0)} not invested`} />
        ) : null}
      </div>

      {spy !== null && (
        <>
          {cmp ? <CompareStrip sentence={cmp.sentence} /> : null}
          {early && <p className="-mt-2 text-[13px] text-dim">{early} A long-term box needs months.</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-text">This box vs the S&amp;P 500</h3>
            <RangeSwitch value={range} onChange={setRange} />
          </div>
          {cmp ? (
            <CompareChart c={cmp.c} range={range} />
          ) : (
            <p className="flex h-[120px] items-center justify-center rounded-[10px] bg-surface2/50 text-[13px] text-dim">
              {spy === undefined ? "Loading the market…" : range === "today" ? "No market data for today yet." : "Not enough days yet to compare."}
            </p>
          )}
        </>
      )}
      {spy === null && early && <p className="text-[13px] text-dim">{early} A long-term box needs months.</p>}
    </section>
  );
}

/* ---------------- right now ---------------- */

const STEP_BAR: Record<NowStep["state"], string> = { done: "bg-gain", now: "bg-link", idle: "bg-surface2" };

function RightNowCard({
  b,
  cfg,
  runnerCfg,
  now,
  today,
  nowMs,
}: {
  b: AiBookView;
  cfg: Record<string, LimitValue>;
  runnerCfg: Record<string, LimitValue>;
  now: NowData | null;
  today: string;
  nowMs: number;
}) {
  const [why, setWhy] = useState(false);
  const isLong = b.key === "claude-long";
  const watchSub =
    b.key === "claude-day"
      ? `every minute${now?.watch.count ? ` · ${now.watch.count} today` : ""}`
      : isLong
        ? String(cfg.intraday_watch) === "true"
          ? `every ${Number(cfg.scan_min) || 15} min`
          : `daily at ${String(cfg.run_at)}`
        : `every ${Number(runnerCfg.interval_min) || 15} min`;
  const current = useMemo(() => (now && nowMs ? nowStep(summarize(now.events), nowMs) : null), [now, nowMs]);
  const steps = rightNowSteps({
    watchSub,
    watchSeen: !!now?.watch.latestAt || !!b.lastRun,
    run: b.lastRun,
    today,
    latestFill: b.todayTrades[0] ?? null,
    openCount: b.positions.length,
    current,
  });
  const sentence = runSentence(b.lastRun);
  return (
    <section className="ai-card flex flex-col gap-4" aria-label="Right now">
      <CardTitle>Right now</CardTitle>
      <ol className="flex flex-col gap-2.5 md:grid md:grid-cols-5 md:gap-2" aria-label="Where this box is in its cycle">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2.5 md:flex-col md:gap-1.5" aria-current={s.state === "now" ? "step" : undefined}>
            <span className={`hidden h-1 w-full rounded-full md:block ${STEP_BAR[s.state]}`} aria-hidden />
            <span
              className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full md:hidden ${s.state === "now" ? "border-2 border-link" : STEP_BAR[s.state]}`}
              aria-hidden
            />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 md:flex-col md:gap-0.5">
              <span className={`text-[13px] font-semibold md:text-[13px] ${s.state === "now" ? "text-link" : "text-text"}`}>{s.label}</span>
              <span className="text-[12px] text-dim tnum">{s.sub}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[15px] leading-relaxed text-text">
        {sentence ?? "Claude hasn't looked at this box yet."}{" "}
        {b.lastRun && (
          <LinkButton onClick={() => setWhy((v) => !v)} className="whitespace-nowrap">
            {why ? "Hide why" : "Why? →"}
          </LinkButton>
        )}
      </p>
      {why && b.lastRun && (
        <div className="border-t border-surface2 pt-4">
          <ClaudePlan run={b.lastRun} />
        </div>
      )}
    </section>
  );
}

/* ---------------- holding ---------------- */

function heldFor(openedAt: string, nowMs: number): string {
  const days = Math.floor((nowMs - Date.parse(openedAt)) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

function HoldingCard({ b, charts, marketOpen, nowMs }: { b: AiBookView; charts: boolean; marketOpen: boolean | null; nowMs: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const isClaude = isClaudeKey(b.key);
  const isLong = b.key === "claude-long";
  const openPnl = b.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const flat = String(effective(defsForBook(b.key), b.settings).flat_by ?? "");
  return (
    <section className="ai-card flex flex-col" aria-label="Holding">
      <CardTitle meta={b.positions.length ? `${b.positions.length} stock${b.positions.length === 1 ? "" : "s"} · ${moneySigned(openPnl, 0)} open` : undefined}>
        Holding
      </CardTitle>
      {b.positions.length === 0 ? (
        <p className="border-t border-surface2 py-4 text-[15px] text-dim">
          Nothing held right now.
          {b.key === "claude-day" && flat ? ` Day Trader sells everything by ${flat} New York time, so it starts each day with nothing.` : ""}
        </p>
      ) : (
        <ul>
          {b.positions.map((p) => {
            const short = p.qty < 0;
            const plan = stopPlan(p);
            const line = stopLine(plan, short);
            const canOpen = charts || !!p.reason;
            const isOpen = open === p.symbol;
            return (
              <li key={p.symbol} className="border-t border-surface2">
                <button
                  type="button"
                  disabled={!canOpen}
                  onClick={() => setOpen(isOpen ? null : p.symbol)}
                  aria-expanded={canOpen ? isOpen : undefined}
                  className="flex min-h-11 w-full flex-col gap-2.5 py-3.5 text-left disabled:cursor-default"
                >
                  <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="w-14 font-display text-[17px] font-semibold text-text">{p.symbol}</span>
                    {short && <Badge tone="tag">SHORT</Badge>}
                    <span className="text-[13px] text-dim tnum">
                      {shares(Math.abs(p.qty))} sh · in ${fprice(p.avgCost)}
                      {isLong ? ` · ${heldFor(p.openedAt, nowMs || Date.parse(p.openedAt))}` : ""}
                    </span>
                    <span className={`ml-auto text-[16px] font-semibold tnum ${toneText(p.pnl)}`}>
                      {p.pnl != null ? `${arrow(p.pnl)}${moneySigned(p.pnl, 0)}` : "—"}
                    </span>
                  </span>
                  {plan.pos != null && p.stop != null && p.target != null && (
                    <span className="flex w-full items-center gap-2.5">
                      <span className="w-14 text-[12px] text-loss tnum">${fprice(p.stop)}</span>
                      <span
                        className="relative h-1.5 flex-1 rounded-full"
                        style={{ background: "linear-gradient(90deg, #f2c9be, var(--color-surface2) 40%, #cde7dd)" }}
                        aria-hidden
                      >
                        <span
                          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-text"
                          style={{ left: `${plan.pos * 100}%` }}
                        />
                      </span>
                      <span className="w-14 text-right text-[12px] text-gain tnum">${fprice(p.target)}</span>
                    </span>
                  )}
                  <span className={`text-[13px] ${plan.close ? "text-loss" : "text-dim"}`}>
                    {[line ?? (p.stop == null ? "no stop on record" : null), short ? "bets the price falls" : null].filter(Boolean).join(" · ")}
                    {canOpen && <span className="text-link">{line || short || p.stop == null ? " · " : ""}{isOpen ? "Hide" : charts ? "Chart" : "Why"}</span>}
                  </span>
                </button>
                {isOpen && (
                  <div className="space-y-3 pb-4">
                    {p.reason && (
                      <p className="text-[13px] leading-relaxed text-dim">
                        <span className="font-semibold text-text">{isClaude ? (short ? "Why Claude shorted: " : "Why Claude bought: ") : "Why: "}</span>
                        {p.reason}
                        <span className="text-dim"> · opened {when(p.openedAt)}</span>
                      </p>
                    )}
                    {charts && <AiChartPanel bookKey={b.key} symbol={p.symbol} marketOpen={marketOpen} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------------- watching ---------------- */

function WatchingCard({ b }: { b: AiBookView }) {
  const isLong = b.key === "claude-long";
  const [signals, setSignals] = useState<ChartListItem[]>([]);
  const [showOrders, setShowOrders] = useState(false);
  useEffect(() => {
    if (!isLong) return;
    let stopped = false;
    loadAiCharts(b.key)
      .then((r) => {
        if (!stopped && !("error" in r)) setSignals(r.items.filter((i) => i.role === "watch"));
      })
      .catch(() => {
        /* the watch list still shows Claude's own picks */
      });
    return () => {
      stopped = true;
    };
  }, [b.key, isLong]);

  const ds = b.lastRun?.summary?.decisions ?? [];
  const prices: Record<string, number> = { ...(b.lastRun?.summary?.marks ?? {}) };
  for (const d of ds) if (d.price && d.price > 0 && prices[d.symbol] == null) prices[d.symbol] = d.price;
  for (const p of b.positions) if (p.price != null) prices[p.symbol] = p.price;
  const rows = watchRows({
    orders: b.pending,
    watches: ds.filter((d) => d.action === "watch"),
    signals: signals.map((s) => ({ symbol: s.symbol, note: s.title ? s.title : "On its indicator watch list" })),
    prices,
    held: b.positions.map((p) => p.symbol),
  });
  const others = b.pending.filter((o) => o.kind !== "entry");
  return (
    <section className="ai-card flex flex-col" aria-label="Watching">
      <CardTitle meta={rows.length ? (isLong ? "fresh signals and orders" : "closest to buying first") : undefined}>Watching</CardTitle>
      {rows.length === 0 ? (
        <p className="border-t border-surface2 py-4 text-[15px] text-dim">
          {isClaudeKey(b.key) ? "Nothing on the watch list right now: no orders waiting and nothing Claude is waiting for." : "No buy orders waiting."}
        </p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.symbol} className="flex flex-col gap-2 border-t border-surface2 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-14 font-display text-[17px] font-semibold text-text">{r.symbol}</span>
                {r.buyAt != null && (
                  <span className="text-[14px] text-text tnum">
                    {r.short ? "sells short at" : "buys at"} ${fprice(r.buyAt)}
                  </span>
                )}
                {r.away != null && (
                  <span className={`ml-auto text-[14px] font-semibold tnum ${r.away < 1 ? "text-link" : "text-sub"}`}>{r.away.toFixed(1)}% away</span>
                )}
              </div>
              {r.closeness != null && (
                <div className="h-1.5 rounded-full bg-surface2" aria-hidden>
                  <div className={`h-1.5 rounded-full ${r.kind === "order" ? "bg-link" : "bg-faint"}`} style={{ width: `${r.closeness}%` }} />
                </div>
              )}
              <div className="text-[13px] text-dim">{r.note}</div>
            </li>
          ))}
        </ul>
      )}
      {b.pending.length > 0 && (
        <div className="border-t border-surface2 pt-3">
          <LinkButton onClick={() => setShowOrders((v) => !v)} className="text-[13px]">
            {showOrders ? "Hide the orders" : `Every order waiting at Alpaca (${b.pending.length}${others.length ? `, ${others.length} to sell or protect` : ""}) ›`}
          </LinkButton>
          {showOrders && (
            <ul className="mt-2">
              {b.pending.map((o, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 border-t border-surface2 py-2.5 text-[14px]">
                  <span className="min-w-0">
                    <span className={`font-semibold ${o.side === "buy" ? "text-gain" : "text-loss"}`}>
                      {o.side === "sell" && o.kind === "entry" ? "Sell short" : o.side === "buy" && o.kind === "exit" ? "Buy to cover" : o.side === "buy" ? "Buy" : "Sell"}
                    </span>{" "}
                    <span className="text-text tnum">{shares(o.qty)}</span> <span className="font-display font-semibold text-text">{o.symbol}</span>
                    <span className="block text-[12px] text-dim tnum">
                      {o.limit != null && `limit $${fprice(o.limit)} · `}
                      {o.stop != null && `stop $${fprice(o.stop)} · `}
                      {o.target != null && `target $${fprice(o.target)} · `}
                      {o.kind === "entry" ? "waiting to fill" : o.stop != null ? "protective stop" : "sell queued"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] text-dim tnum">{when(o.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- today ---------------- */

function TodayCard({
  b,
  marketOpen,
  clock,
  nowMs,
  onSeeAll,
}: {
  b: AiBookView;
  marketOpen: boolean | null;
  clock: { nextOpen: string; nextClose: string } | null;
  nowMs: number;
  onSeeAll: () => void;
}) {
  const st = todayStats(b.todayTrades);
  const shown = b.todayTrades.slice(0, 5);
  const opensToday = clock && nowMs && nyDate(new Date(clock.nextOpen)) === nyDate(new Date(nowMs));
  const empty =
    marketOpen === true
      ? "No trades yet today."
      : opensToday
        ? `No trades yet today — the market opens at ${nyClock(clock!.nextOpen)} New York time.`
        : "No trades today — the market is closed.";
  return (
    <section className="ai-card flex flex-col" aria-label="Today">
      <CardTitle
        meta={
          st.count
            ? `${st.count} trade${st.count === 1 ? "" : "s"}${st.closed ? ` · ${st.won} won · ${money(st.locked, 0)} locked in` : ""} · New York time`
            : undefined
        }
      >
        Today
      </CardTitle>
      {shown.length === 0 ? (
        <p className="border-t border-surface2 py-4 text-[15px] text-dim">{empty}</p>
      ) : (
        <ul>
          {shown.map((t, i) => {
            const l = tradeLine(t);
            return (
              <li key={i} className="grid grid-cols-[48px_1fr] gap-x-3 gap-y-0.5 border-t border-surface2 py-3 text-[14px] sm:grid-cols-[56px_1fr_auto] sm:items-baseline">
                <span className="text-dim tnum">{nyClock(t.at)}</span>
                <span className="min-w-0 text-text">
                  <b className="font-semibold">{l.title}</b>
                  {l.why && <span className="text-sub"> — {l.why}</span>}
                </span>
                <span className={`col-start-2 tnum sm:col-start-auto sm:text-right ${l.tone === "flat" ? "text-dim" : TONE_TEXT[l.tone]}`}>
                  {l.tone !== "flat" ? arrow(t.pnl) : ""}
                  {l.right}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {st.count > 0 && (
        <LinkButton onClick={onSeeAll} className="min-h-11 pt-2 text-[14px]">
          {st.count > shown.length ? `See all ${st.count} trades →` : "Past trades and reviews →"}
        </LinkButton>
      )}
    </section>
  );
}

/** Every fill today, newest first (the full list behind "See all"). */
function TodayFills({ trades }: { trades: AiBookView["todayTrades"] }) {
  return (
    <Block title={`Today (${trades.length})`} hint="New York time">
      {trades.length === 0 ? (
        <Empty>No trades today.</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {trades.map((t, i) => {
            const l = tradeLine(t);
            return (
              <li key={i} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold text-text">{l.title}</span>
                  {l.why && <span className="text-sub"> — {l.why}</span>}
                  <span className="block text-[12px] text-dim tnum">
                    {shares(t.qty)} at ${fprice(t.price)} · {nyClock(t.at)}
                  </span>
                </span>
                {t.pnl != null ? (
                  <span className={`shrink-0 text-right font-semibold tnum ${toneText(t.pnl)}`}>
                    {arrow(t.pnl)}
                    {moneySigned(t.pnl, 2)}
                    {exitBasis(t) > 0 && <span className="block text-[12px] font-normal">{pct((t.pnl / exitBasis(t)) * 100)}</span>}
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] text-dim">opened</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

/* ---------------- details ---------------- */

function DetailRow({
  k,
  title,
  hint,
  open,
  onToggle,
  last = false,
  children,
}: {
  k: DetailKey;
  title: string;
  hint: string;
  open: boolean;
  onToggle: (k: DetailKey) => void;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={last && !open ? "" : "border-b border-surface2"}>
      <button
        type="button"
        onClick={() => onToggle(k)}
        aria-expanded={open}
        className="flex min-h-[52px] w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-[18px] py-4 text-left hover:bg-surface2/40 md:px-6"
      >
        <span className="text-[15px] font-semibold text-text">{title}</span>
        <span className="hidden text-[13px] text-dim sm:inline">{hint}</span>
        <span className={`ml-auto text-dim transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
          ›
        </span>
      </button>
      {open && <div className="px-[18px] pb-6 md:px-6">{children}</div>}
    </div>
  );
}

/** Claude's runs, costs, limits and replays (Rules boxes: the latest run, limits and the close-everything panel). */
function RunsDetail({ b, onSettings }: { b: AiBookView; onSettings: (g?: SettingsSection) => void }) {
  const isClaude = isClaudeKey(b.key);
  const isLong = b.key === "claude-long";
  const run = b.lastRun;
  const todayCost = b.today.reduce((a, r) => a + (Number(r.usage?.cost_usd) || 0), 0);
  return (
    <div className="space-y-7">
      <p className="text-[13px] leading-relaxed text-dim">{BLURB[b.key]}</p>
      {isClaude && (
        <p className="text-[13px] text-dim tnum">
          Claude usage: ${todayCost.toFixed(2)} today · ${b.weekCostUsd.toFixed(2)} this week
          {b.weekReviewCostUsd > 0 && ` (reviews $${b.weekReviewCostUsd.toFixed(2)})`}
          {b.weekUsageMacUsd != null && ` · the Mac counts $${b.weekUsageMacUsd.toFixed(2)} for the whole account`} ·{" "}
          <LinkButton onClick={() => onSettings("Schedule & cost")}>schedule and cap</LinkButton>
        </p>
      )}
      <Block title={isClaude ? "Latest check, step by step" : "Latest run"} hint={run ? `${when(run.ran_at)} · ${run.mode}` : "not run yet"}>
        {run ? (
          <div className="rounded-xl border border-border bg-surface2/30 p-4">
            <RunDetail s={run.summary} error={run.error} mode={run.mode} />
          </div>
        ) : (
          <Empty>
            {isClaude
              ? "Claude hasn't run in this box yet."
              : "This box hasn't run yet. Rules boxes run on weekday schedules, or use Run now in Settings → Schedule & cost."}
          </Empty>
        )}
      </Block>
      <Block title={`Limits used${isClaude ? " today" : ""}`}>
        <div className="rounded-xl border border-border p-4">
          <LimitsUsed b={b} />
        </div>
      </Block>
      {isClaude && <Timeline runs={b.today} latestId={run?.id ?? null} next={isLong ? `${String(effective(LONG_LIMITS, b.settings).run_at)} NY` : null} />}
      {isClaude && <Replays days={b.replays} />}
      {!isClaude && (b.positions.length > 0 || b.pending.length > 0) && (
        <Block title="Close this box" hint={!boxEnabled(b.settings) ? "works while the box is off" : undefined}>
          <CloseBoxPanel bookKey={b.key} name={b.name} />
        </Block>
      )}
    </div>
  );
}
