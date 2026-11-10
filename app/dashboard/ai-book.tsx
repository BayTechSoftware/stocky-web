"use client";

import { useState, useTransition } from "react";
import { loadRunDetail } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import { CLAUDE_LIMITS, defsForBook, effective, rulesDefs } from "@/lib/aitrader/limits";
import type { AiBookView, AiReplayDay, AiReview, AiRun, AiRunLite, ClosedTrade, ExitReason } from "@/lib/aitrader/view";
import { ClaudePlan, LABEL, RunDetail, col, when } from "./ai-run";
import { BacktestPanel } from "./ai-backtest";
import { LimitsEditor } from "./ai-settings";

const BLURB: Record<AiBookView["key"], string> = {
  mylist: "Rules only, no AI. Trades your watchlist on Stocky's signals, within the limits below. Runs on the website on weekday schedules.",
  free: "Rules only, no AI. The Trader skill's daily chart setups across a curated large-cap universe (minus your list), within the limits below. Runs on the website on weekday schedules.",
  "claude-mylist":
    "Claude runs the day-trader-skill repo on your watchlist: scans, reads the news, times entries, within the limits below. On your Mac during market hours.",
  "claude-free":
    "Claude runs the day-trader-skill repo across the US market — free choice. Reads the news, times entries, within the limits below. On your Mac during market hours.",
};

export { col };

/** "x of y" meter for one limit. */
function Meter({ label, used, max, fmt }: { label: string; used: number | null; max: number; fmt: (n: number) => string }) {
  const p = used != null && max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-dim">{label}</span>
        <span className="font-mono text-[11px] text-text tnum">
          {used == null ? "—" : fmt(used)} <span className="text-faint">/ {max > 0 ? fmt(max) : "no limit"}</span>
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface2">
        <div className={`h-full rounded-full ${p >= 100 ? "bg-loss" : p >= 66 ? "bg-watch" : "bg-accent"}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function LimitsUsed({ b }: { b: AiBookView }) {
  const isClaude = b.key.startsWith("claude-");
  if (isClaude) {
    const cfg = { ...effective(CLAUDE_LIMITS, b.settings), ...(b.lastRun?.summary?.limits?.config ?? {}) };
    const used = b.lastRun?.summary?.limits?.used;
    const todayCost = b.today.reduce((a, r) => a + (Number(r.usage?.cost_usd) || 0), 0);
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Meter label="Trades today" used={used?.trades_today ?? null} max={Number(cfg.max_trades_per_day)} fmt={(n) => String(n)} />
        <Meter
          label="Daily-loss budget used (loss at stops)"
          used={used?.loss_at_risk_usd ?? null}
          max={Number(cfg.max_daily_loss_usd)}
          fmt={(n) => `$${n.toFixed(0)}`}
        />
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Realized P&amp;L today</span>
          <span className={`font-mono tnum ${col(used?.realized_pnl_today_usd)}`}>
            {used?.realized_pnl_today_usd != null ? moneySigned(used.realized_pnl_today_usd, 2) : "—"}
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Open risk to stops</span>
          <span className="font-mono text-text tnum">{used?.open_risk_usd != null ? money(used.open_risk_usd, 2) : "—"}</span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Entries allowed (NY)</span>
          <span className="font-mono text-text tnum">
            {String(cfg.no_entries_before || "open")}–{String(cfg.no_entries_after || "any time")} · {cfg.flat_by ? `flat ${String(cfg.flat_by)}` : "may hold overnight"}
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Claude usage</span>
          <span className="font-mono text-text tnum">
            ${todayCost.toFixed(2)} today · ${b.weekCostUsd.toFixed(2)} week
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Runs today</span>
          <span className="font-mono text-text tnum">{b.today.length}</span>
        </div>
      </div>
    );
  }
  const cfg = effective(rulesDefs(b.key === "mylist" ? "mylist" : "free"), b.settings);
  const halt = Number(cfg.daily_loss_halt_pct);
  const rr = Number(cfg.reward_risk);
  const hold = Number(cfg.max_hold_days);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Meter
        label="Positions + working entries"
        used={b.positions.length + b.pending.filter((o) => o.kind === "entry").length}
        max={Number(cfg.max_positions)}
        fmt={(n) => String(n)}
      />
      <div className="space-y-1 text-[11px]">
        <div className="flex justify-between">
          <span className="text-dim">Risk per trade</span>
          <span className="font-mono text-text tnum">{cfg.risk_pct}% · ≈{money((b.equity * Number(cfg.risk_pct)) / 100)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Daily-loss halt</span>
          <span className="font-mono text-text tnum">{halt > 0 ? `${halt}%` : "off"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Target · time stop</span>
          <span className="font-mono text-text tnum">
            {rr > 0 ? `${rr}R` : "stop only"} · {hold > 0 ? `${hold}d` : "no time stop"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Open one run at a time; its full summary (trace + pipeline) is loaded on first open. */
function useRunDetails() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { run: AiRun } | { error: string }>>({});
  const [loading, start] = useTransition();
  function toggle(id: string) {
    if (openId === id) return setOpenId(null);
    setOpenId(id);
    if (!detail[id]) {
      start(async () => {
        const r = await loadRunDetail(id);
        setDetail((d) => ({ ...d, [id]: r }));
      });
    }
  }
  return { openId, detail, loading, toggle };
}

function LoadedRun({ d, loading }: { d: { run: AiRun } | { error: string } | undefined; loading: boolean }) {
  if (!d || loading) return <p className="text-xs text-faint">Loading…</p>;
  if (!("run" in d)) return <p className="text-xs text-loss">{d.error}</p>;
  return <RunDetail s={d.run.summary} error={d.run.error} mode={d.run.mode} />;
}

/** Today's runs, newest first; open one to load its full trace + pipeline. */
function Timeline({ runs, latestId }: { runs: AiRunLite[]; latestId: string | null }) {
  const { openId, detail, loading, toggle } = useRunDetails();
  if (!runs.length) return null;
  return (
    <div>
      <div className={`mb-1 ${LABEL}`}>Today&apos;s runs ({runs.length})</div>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {runs.map((r) => {
          return (
            <li key={r.id}>
              <button
                onClick={() => toggle(r.id)}
                className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface2/60"
              >
                <span className="w-14 shrink-0 font-mono text-[11px] text-text tnum">{when(r.ran_at, false)}</span>
                <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-faint">{r.phase ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate text-dim">
                  {r.error ? <span className="text-loss">{r.error}</span> : r.reason ?? ""}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-faint tnum">
                  {r.buys > 0 && <span className="text-gain">{r.buys}B </span>}
                  {r.sells > 0 && <span className="text-loss">{r.sells}S </span>}
                  {r.usage?.secs != null && `${Math.round(r.usage.secs)}s `}
                  {r.usage?.cost_usd != null && `$${Number(r.usage.cost_usd).toFixed(2)}`}
                  {r.id === latestId && " · latest"}
                </span>
              </button>
              {openId === r.id && (
                <div className="border-t border-border bg-surface2/30 p-3">
                  <LoadedRun d={detail[r.id]} loading={loading} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One replayed day: simulated trades + positions, and its steps (each opens the full run). */
function ReplayDay({ d }: { d: AiReplayDay }) {
  const { openId, detail, loading, toggle } = useRunDetails();
  const n = d.id.match(/-(\d+)$/)?.[1];
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-2.5 py-1.5 text-xs hover:bg-surface2/60">
        <span className="w-20 shrink-0 font-mono text-[11px] text-text tnum">
          {d.date}
          {n && n !== "1" ? <span className="text-faint"> #{n}</span> : null}
        </span>
        <span className="w-16 shrink-0 font-mono text-[10px] text-faint tnum">
          {d.done}/{d.steps ?? "?"} {d.final ? "" : "· running"}
        </span>
        <span className={`min-w-0 flex-1 font-mono tnum ${col(d.simPnl)}`}>
          {d.simPnl != null ? moneySigned(d.simPnl, 2) : "—"}
          {d.simEquity != null && <span className="text-faint"> · {money(d.simEquity, 2)}</span>}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint tnum">
          {d.trades.length} fill{d.trades.length === 1 ? "" : "s"} · ${d.costUsd.toFixed(2)}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border bg-surface2/30 p-3">
        <div>
          <div className={`mb-1 ${LABEL}`}>Simulated fills ({d.trades.length})</div>
          {d.trades.length === 0 ? (
            <p className="text-xs text-dim">No fills.</p>
          ) : (
            <ul className="space-y-0.5">
              {d.trades.map((t, i) => (
                <li key={i} className="font-mono text-[11px] text-dim tnum">
                  <span className="text-faint">{t.at ?? "—"}</span>{" "}
                  <span className={t.side === "buy" ? "text-gain" : "text-loss"}>{String(t.side).toUpperCase()}</span>{" "}
                  <span className="font-semibold text-text">
                    {shares(t.qty)} {t.symbol}
                  </span>{" "}
                  @ ${fprice(t.price)}
                  {t.why && <span className="font-sans text-faint"> — {t.why}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {d.positions.length > 0 && (
          <div>
            <div className={`mb-1 ${LABEL}`}>Simulated positions at the last step</div>
            <ul className="space-y-0.5">
              {d.positions.map((p) => (
                <li key={p.symbol} className="font-mono text-[11px] text-dim tnum">
                  <span className="font-semibold text-text">{p.symbol}</span> {shares(p.qty)} @ ${fprice(p.avg)} · mark ${fprice(p.mark)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className={`mb-1 ${LABEL}`}>Steps ({d.list.length})</div>
          <ol className="divide-y divide-border rounded-lg border border-border bg-surface">
            {d.list.map((st) => (
              <li key={st.id}>
                <button
                  onClick={() => toggle(st.id)}
                  className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface2/60"
                >
                  <span className="w-10 shrink-0 font-mono text-[11px] text-text tnum">{st.at ?? "—"}</span>
                  <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-faint">{st.phase ?? "—"}</span>
                  <span className="min-w-0 flex-1 truncate text-dim">
                    {st.error ? <span className="text-loss">{st.error}</span> : st.reason ?? ""}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-faint tnum">
                    {st.step != null && `#${st.step} `}
                    {st.cost != null && `$${st.cost.toFixed(2)}`}
                  </span>
                </button>
                {openId === st.id && (
                  <div className="border-t border-border bg-surface2/30 p-3">
                    <LoadedRun d={detail[st.id]} loading={loading} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </details>
  );
}

/** The Mac's after-close reviews (bin/reviewer.py → ai_reviews), newest day first. */
function DailyReviews({ reviews }: { reviews: AiReview[] }) {
  const [all, setAll] = useState(false);
  if (!reviews.length) {
    return (
      <Block title="Daily review">
        <Empty>No review yet. After each trading day&apos;s close the Mac writes one here.</Empty>
      </Block>
    );
  }
  const shown = all ? reviews : reviews.slice(0, 1);
  return (
    <Block title="Daily review" hint="written after the close; its lessons are what Claude reads the next morning">
      <ul className="space-y-2.5">
        {shown.map((r) => {
          const s = r.stats;
          const reasons = Object.entries(s.exit_reasons ?? {})
            .map(([k, n]) => `${REASON_LABEL[k as ExitReason] ?? k} ${n}`)
            .join(" · ");
          return (
            <li key={r.day} className="rounded-xl border border-border bg-surface2/30 p-4">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-sm font-semibold text-text">{reviewDay(r.day)}</span>
                <span className="font-mono text-[11px] text-dim tnum">
                  {s.trades != null && `${s.trades} trade${s.trades === 1 ? "" : "s"}`}
                  {s.wins != null && s.trades ? ` · ${s.wins} won` : ""}
                  {s.pnl != null && <span className={col(s.pnl)}> · {moneySigned(s.pnl, 2)}</span>}
                  {s.avg_r != null && ` · avg ${s.avg_r.toFixed(2)}R`}
                </span>
              </div>
              {r.summary && <p className="text-sm leading-relaxed text-text">{r.summary}</p>}
              {r.lessons.length > 0 && (
                <div className="mt-2.5">
                  <div className={`mb-1 ${LABEL}`}>Lessons for tomorrow</div>
                  <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-snug text-dim">
                    {r.lessons.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="mt-2 font-mono text-[10.5px] text-faint tnum">
                {reasons && `exits: ${reasons}`}
                {s.model && `${reasons ? " · " : ""}${s.model}`}
                {r.costUsd != null && ` · $${r.costUsd.toFixed(3)}`}
              </div>
            </li>
          );
        })}
      </ul>
      {reviews.length > 1 && (
        <button onClick={() => setAll(!all)} className="mt-2 text-xs font-medium text-accent hover:underline">
          {all ? "Show the latest only" : `Show the last ${reviews.length} days`}
        </button>
      )}
    </Block>
  );
}

/** "Tue, Nov 10" from "2026-11-10" (a calendar day: no time zone shift). */
function reviewDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Claude replays of past days (simulated on the Mac; never in this box's ledger). */
function Replays({ days }: { days: AiReplayDay[] }) {
  if (!days.length) return null;
  return (
    <div>
      <div className={`mb-1 ${LABEL}`}>Replays ({days.length})</div>
      <p className="mb-1.5 text-[10.5px] leading-snug text-faint">
        Claude re-running past days at pinned times, fills simulated against 1-minute bars. Nothing was placed;
        these never touch the positions or P&amp;L above. Their usage counts toward this week&apos;s total.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border">
        {days.map((d) => (
          <ReplayDay key={d.id} d={d} />
        ))}
      </div>
    </div>
  );
}

const REASON_LABEL: Record<ExitReason, string> = {
  stop: "Stop",
  target: "Target",
  trail: "Trailing stop",
  breakeven: "Breakeven",
  partial: "Partial",
  time: "Time stop",
  market: "Market turned",
  "close-out": "Close-out",
  claude: "Claude",
  exit: "Exit",
};
const REASON_CLS: Record<ExitReason, string> = {
  stop: "bg-loss/10 text-loss",
  target: "bg-gain/10 text-gain",
  trail: "bg-gain/10 text-gain",
  breakeven: "bg-surface2 text-dim",
  partial: "bg-gain/10 text-gain",
  time: "bg-surface2 text-dim",
  market: "bg-accent/10 text-accent",
  "close-out": "bg-surface2 text-dim",
  claude: "bg-accent/10 text-accent",
  exit: "bg-surface2 text-dim",
};

/** "2h 05m" / "45m" / "3d 4h" */
function held(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

/** Entry cost of the shares an exit closed: proceeds less profit for a sell, cover cost plus profit for a cover. */
function exitBasis(t: AiBookView["todayTrades"][number]): number {
  return t.pnl == null ? 0 : t.qty * t.price - (t.side === "sell" ? t.pnl : -t.pnl);
}

/** Every completed round trip, newest first: what each close made or lost. */
function ClosedTrades({ trades }: { trades: ClosedTrade[] }) {
  const [all, setAll] = useState(false);
  if (!trades.length) return <Block title="Closed trades"><Empty>No closed trades yet.</Empty></Block>;
  const shown = all ? trades : trades.slice(0, 10);
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const won = trades.filter((t) => t.pnl > 0.005).length;
  return (
    <Block title={`Closed trades (${trades.length})`} hint={`${won} won · ${moneySigned(total, 2)} in all`}>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {shown.map((t, i) => (
          <li key={`${t.symbol}-${t.closedAt}-${i}`} className="px-3.5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-display font-semibold text-text">{t.symbol}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.direction === "long" ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss"}`}
                  >
                    {t.direction}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${REASON_CLS[t.exitReason]}`}>
                    {REASON_LABEL[t.exitReason]}
                  </span>
                </div>
                <div className="mt-1 font-mono text-xs text-dim tnum">
                  {shares(t.qty)} sh · ${fprice(t.avgEntry)} → ${fprice(t.avgExit)} · held {held(t.holdMinutes)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={`font-mono text-sm font-semibold tnum ${col(t.pnl)}`}>{moneySigned(t.pnl, 2)}</div>
                <div className={`font-mono text-[11px] tnum ${col(t.pnl)}`}>
                  {pct(t.pnlPct)}
                  {t.r != null && (
                    <span className="text-faint" title="Result as a multiple of the risk taken at entry (entry to stop)">
                      {" "}
                      · {t.r < 0 ? "−" : "+"}
                      {Math.abs(t.r).toFixed(1)}× risk
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-faint tnum">{when(t.closedAt)}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {trades.length > 10 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-xs font-medium text-text underline-offset-4 hover:underline">
          {all ? "Show fewer" : `Show all ${trades.length}`}
        </button>
      )}
    </Block>
  );
}

type Section = "now" | "trades" | "runs" | "settings";

/** Where the price sits between the stop and the target (0 = at the stop, 1 = at the target). */
function stopTargetPos(p: AiBookView["positions"][number]): number | null {
  if (p.stop == null || p.target == null || p.price == null || p.target === p.stop) return null;
  return Math.max(0, Math.min(1, (p.price - p.stop) / (p.target - p.stop)));
}

function PositionRow({ p, isClaude }: { p: AiBookView["positions"][number]; isClaude: boolean }) {
  const short = p.qty < 0;
  const pos = stopTargetPos(p);
  const entryPos =
    p.stop != null && p.target != null && p.target !== p.stop
      ? Math.max(0, Math.min(1, (p.avgCost - p.stop) / (p.target - p.stop)))
      : null;
  return (
    <li className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-semibold text-text">{p.symbol}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${short ? "bg-loss/10 text-loss" : "bg-gain/10 text-gain"}`}
            >
              {short ? "Short" : "Long"}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-dim tnum">
            {shares(Math.abs(p.qty))} sh · in at ${fprice(p.avgCost)} · {when(p.openedAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-mono text-base font-semibold tnum ${col(p.pnl)}`}>
            {p.pnl != null ? moneySigned(p.pnl, 2) : "—"}
          </div>
          <div className="font-mono text-xs text-dim tnum">
            {p.price != null ? `$${fprice(p.price)}` : "—"}
            {p.pnlPct != null && <span className={col(p.pnl)}> · {pct(p.pnlPct)}</span>}
          </div>
        </div>
      </div>

      {pos != null ? (
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-gradient-to-r from-loss/25 via-surface2 to-gain/25">
            {entryPos != null && (
              <span
                className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-faint"
                style={{ left: `${entryPos * 100}%` }}
                title="your entry"
              />
            )}
            <span
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-text shadow"
              style={{ left: `${pos * 100}%` }}
              title="price now"
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[11px] tnum">
            <span className="text-loss">stop ${fprice(p.stop as number)}</span>
            <span className="text-gain">target ${fprice(p.target as number)}</span>
          </div>
        </div>
      ) : (
        <div className="mt-2 font-mono text-[11px] text-faint tnum">
          {p.stop != null ? <span className="text-loss">stop ${fprice(p.stop)}</span> : "no stop on record"}
          {p.target != null && <span className="text-gain"> · target ${fprice(p.target)}</span>}
        </div>
      )}

      {p.reason && (
        <p className="mt-2.5 border-t border-border pt-2 text-xs leading-relaxed text-dim">
          <span className="text-faint">{isClaude ? (short ? "Why Claude shorted: " : "Why Claude bought: ") : "Why: "}</span>
          {p.reason}
        </p>
      )}
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-dim">{children}</p>;
}

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-text">{title}</h3>
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function BookCard({ b }: { b: AiBookView }) {
  const isClaude = b.key.startsWith("claude-");
  const run = b.lastRun;
  const defs = defsForBook(b.key);
  const [section, setSection] = useState<Section>("now");
  // A Rules box's size is its start_cash; show the real one when no budget is saved.
  const saved = isClaude ? b.settings : { budget: b.startCash, ...b.settings };
  const decided = b.wins + b.losses;
  const closedToday = b.todayTrades.filter((t) => t.pnl != null);
  const todayPnl = closedToday.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const openPnl = b.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const entriesWaiting = b.pending.filter((o) => o.kind === "entry").length;

  const status = [
    b.positions.length ? `Holding ${b.positions.length} stock${b.positions.length === 1 ? "" : "s"}` : "No open positions",
    closedToday.length ? `${closedToday.length} closed today, ${moneySigned(todayPnl, 2)}` : null,
    entriesWaiting ? `${entriesWaiting} order${entriesWaiting === 1 ? "" : "s"} waiting to fill` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: { key: Section; label: string; count?: number }[] = [
    { key: "now", label: "Now", count: b.positions.length + b.pending.length || undefined },
    { key: "trades", label: "Trades", count: b.closed.length || undefined },
    { key: "runs", label: isClaude ? "Claude's runs" : "Runs", count: isClaude ? b.today.length || undefined : undefined },
    { key: "settings", label: "Limits & settings" },
  ];

  return (
    <div className="card rounded-2xl border border-border bg-surface">
      {/* ---------- statement header ---------- */}
      <header className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${isClaude ? "bg-accent text-surface" : "bg-surface2 text-dim"}`}
              >
                {isClaude ? "Claude" : "Rules"}
              </span>
              <h2 className="font-display text-xl font-semibold tracking-tight text-text">{b.name}</h2>
            </div>
            <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-dim">{BLURB[b.key]}</p>
          </div>
          <div className="hidden sm:block">
            <Spark series={b.series} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-5 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <div className={LABEL}>Value now</div>
            <div className="font-display text-3xl font-semibold tracking-tight text-text tnum">{money(b.equity, 2)}</div>
            <div className={`font-mono text-sm tnum ${col(b.pnl)}`}>
              {moneySigned(b.pnl, 2)} ({pct(b.pnlPct)}) all time
            </div>
          </div>
          <Stat label="Today (closed)" value={closedToday.length ? moneySigned(todayPnl, 2) : "—"} tone={closedToday.length ? todayPnl : null} />
          <Stat label="Open positions" value={b.positions.length ? moneySigned(openPnl, 2) : "—"} tone={b.positions.length ? openPnl : null} sub={`${money(b.cash, 2)} cash`} />
          <Stat
            label="Win rate"
            value={decided ? `${Math.round((b.wins / decided) * 100)}%` : "—"}
            sub={decided ? `${b.wins} won · ${b.losses} lost` : "no closed trades yet"}
          />
        </div>

        <p className="mt-4 rounded-lg bg-surface2/70 px-3 py-2 text-xs text-dim">{status}</p>
      </header>

      {/* ---------- section switcher (sticks while scrolling) ---------- */}
      <nav className="sticky top-0 z-10 border-y border-border bg-surface/90 px-3 backdrop-blur md:px-5" aria-label={`${b.name} sections`}>
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const on = section === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setSection(t.key)}
                aria-current={on ? "true" : undefined}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm transition ${on ? "border-text font-semibold text-text" : "border-transparent text-dim hover:text-text"}`}
              >
                {t.label}
                {t.count != null && (
                  <span className={`rounded-full px-1.5 font-mono text-[10px] tnum ${on ? "bg-text text-surface" : "bg-surface2 text-dim"}`}>{t.count}</span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="space-y-7 p-5 md:p-6">
        {section === "now" && (
          <>
            {isClaude && (
              <Block title="What Claude is doing">
                <div className="rounded-xl border border-border bg-surface2/40 p-4">
                  <ClaudePlan run={run} />
                </div>
              </Block>
            )}

            <Block title="Open positions" hint={b.positions.length ? "dot = price now · line = your entry" : undefined}>
              {b.positions.length === 0 ? (
                <Empty>Nothing open right now.</Empty>
              ) : (
                <ul className="grid gap-3 md:grid-cols-2">
                  {b.positions.map((p) => (
                    <PositionRow key={p.symbol} p={p} isClaude={isClaude} />
                  ))}
                </ul>
              )}
            </Block>

            {b.pending.length > 0 && (
              <Block title="Orders waiting">
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {b.pending.map((o, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 text-sm">
                      <span className="min-w-0">
                        <span className={`font-semibold ${o.side === "buy" ? "text-gain" : "text-loss"}`}>
                          {o.side === "sell" && o.kind === "entry" ? "Sell short" : o.side === "buy" && o.kind === "exit" ? "Buy to cover" : o.side === "buy" ? "Buy" : "Sell"}
                        </span>{" "}
                        <span className="font-mono tnum text-text">{shares(o.qty)}</span>{" "}
                        <span className="font-display font-semibold text-text">{o.symbol}</span>
                        <span className="block font-mono text-[11px] text-faint tnum">
                          {o.limit != null && `limit $${fprice(o.limit)} · `}
                          {o.stop != null && `stop ${fprice(o.stop)} · `}
                          {o.target != null && `target ${fprice(o.target)} · `}
                          {o.kind === "entry" ? "waiting to fill" : o.stop != null ? "protective stop" : "exit queued"}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-faint tnum">{when(o.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}
          </>
        )}

        {section === "trades" && (
          <>
            <Block title="Today" hint={closedToday.length ? `${moneySigned(todayPnl, 2)} closed` : undefined}>
              {b.todayTrades.length === 0 ? (
                <Empty>No trades today.</Empty>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {b.todayTrades.map((t, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
                      <span className="min-w-0">
                        <span className={`font-semibold ${t.side === "buy" ? "text-gain" : "text-loss"}`}>
                          {t.role === "short" ? "Sold short" : t.role === "cover" ? "Bought to cover" : t.side === "buy" ? "Bought" : "Sold"}
                        </span>{" "}
                        <span className="font-mono text-text tnum">{shares(t.qty)}</span>{" "}
                        <span className="font-display font-semibold text-text">{t.symbol}</span>
                        <span className="block font-mono text-[11px] text-faint tnum">
                          at ${fprice(t.price)} · {when(t.at, false)}
                        </span>
                      </span>
                      {t.pnl != null ? (
                        <span className={`shrink-0 text-right font-mono font-semibold tnum ${col(t.pnl)}`}>
                          {moneySigned(t.pnl, 2)}
                          {exitBasis(t) > 0 && <span className="block text-[11px] font-normal">{pct((t.pnl / exitBasis(t)) * 100)}</span>}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-faint">opened</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Block>
            <ClosedTrades trades={b.closed} />
          </>
        )}

        {section === "runs" && (
          <>
            <Block title="Latest run" hint={run ? `${when(run.ran_at)} · ${run.mode}` : "not run yet"}>
              {run ? (
                <div className="rounded-xl border border-border bg-surface2/30 p-4">
                  <RunDetail s={run.summary} error={run.error} mode={run.mode} />
                </div>
              ) : (
                <Empty>This box hasn&apos;t run yet.</Empty>
              )}
            </Block>
            {isClaude && <DailyReviews reviews={b.reviews} />}
            {isClaude && <Timeline runs={b.today} latestId={run?.id ?? null} />}
            {isClaude && <Replays days={b.replays} />}
            {!isClaude && <BacktestPanel bookKey={b.key} />}
          </>
        )}

        {section === "settings" && (
          <>
            <Block title={`Limits used${isClaude ? " today" : ""}`}>
              <div className="rounded-xl border border-border p-4">
                <LimitsUsed b={b} />
              </div>
            </Block>
            <LimitsEditor
              bookKey={b.key}
              defs={defs}
              saved={saved}
              note={
                isClaude
                  ? "These are the repo's own trader/config.json limits. The Mac writes them into this book before every Claude run, and the repo's risk check blocks anything that breaks them."
                  : "Used by the rules engine from its next run. Book size sets this box's starting cash."
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number | null }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className={`font-mono text-lg font-semibold tnum ${tone != null ? col(tone) : "text-text"}`}>{value}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

/** One box as a compact tile for the Overview tab. Clicking it opens the box's own tab. */
export function BookTile({ b, onOpen }: { b: AiBookView; onOpen: () => void }) {
  const isClaude = b.key.startsWith("claude-");
  const decided = b.wins + b.losses;
  const todayPnl = b.todayTrades.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const hasToday = b.todayTrades.some((t) => t.pnl != null);
  return (
    <button
      onClick={onOpen}
      className="card group flex w-full flex-col rounded-2xl border border-border bg-surface p-4 text-left transition hover:border-accent/50 hover:bg-surface2/40"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${isClaude ? "bg-accent/10 text-accent" : "bg-surface2 text-dim"}`}
          >
            {isClaude ? "Claude" : "Rules"}
          </span>
          <span className="truncate font-display font-semibold text-text">{b.name}</span>
        </div>
        <Spark series={b.series} />
      </div>
      <div className="mt-3 font-display text-2xl font-semibold text-text tnum">{money(b.equity, 2)}</div>
      <div className={`font-mono text-sm tnum ${col(b.pnl)}`}>
        {moneySigned(b.pnl, 2)} ({pct(b.pnlPct)})
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
        <dt className="text-faint">Positions</dt>
        <dd className="text-right font-mono text-text tnum">{b.positions.length}</dd>
        <dt className="text-faint">Closed today</dt>
        <dd className={`text-right font-mono tnum ${hasToday ? col(todayPnl) : "text-dim"}`}>
          {hasToday ? moneySigned(todayPnl, 2) : "—"}
        </dd>
        <dt className="text-faint">Win rate</dt>
        <dd className="text-right font-mono text-text tnum">{decided ? `${Math.round((b.wins / decided) * 100)}% of ${decided}` : "—"}</dd>
        <dt className="text-faint">Last run</dt>
        <dd className="truncate text-right font-mono text-dim tnum">{b.lastRun ? when(b.lastRun.ran_at) : "not yet"}</dd>
      </dl>
      <span className="mt-3 text-xs text-dim group-hover:text-accent">Open details →</span>
    </button>
  );
}

/** Tiny equity sparkline (needs ≥ 2 daily snapshots). */
function Spark({ series }: { series: { as_of: string; equity: number }[] }) {
  if (series.length < 2) return null;
  const w = 96;
  const h = 32;
  const ys = series.map((s) => s.equity);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pts = ys
    .map((y, i) => {
      const x = (i / (ys.length - 1)) * w;
      const yy = hi === lo ? h / 2 : h - ((y - lo) / (hi - lo)) * h;
      return `${x.toFixed(1)},${yy.toFixed(1)}`;
    })
    .join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`shrink-0 ${up ? "text-gain" : "text-loss"}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
