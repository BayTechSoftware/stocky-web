"use client";

import { useState, useTransition } from "react";
import { loadRunDetail } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import { CLAUDE_LIMITS, defsForBook, effective, rulesDefs } from "@/lib/aitrader/limits";
import type { AiBookView, AiReplayDay, AiRun, AiRunLite } from "@/lib/aitrader/view";
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
            {String(cfg.no_entries_before || "open")}–{String(cfg.no_entries_after || "any time")} · flat {String(cfg.flat_by)}
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

export function BookCard({ b }: { b: AiBookView }) {
  const isClaude = b.key.startsWith("claude-");
  const run = b.lastRun;
  const defs = defsForBook(b.key);
  // A Rules box's size is its start_cash; show the real one when no budget is saved.
  const saved = isClaude ? b.settings : { budget: b.startCash, ...b.settings };
  const decided = b.wins + b.losses;
  return (
    <div className="card overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${isClaude ? "bg-accent/10 text-accent" : "bg-surface2 text-dim"}`}
              >
                {isClaude ? "Claude" : "Rules"}
              </span>
              <span className="font-display text-lg font-semibold text-text">{b.name}</span>
            </div>
            <p className="mt-1 text-xs text-dim">{BLURB[b.key]}</p>
          </div>
          <Spark series={b.series} />
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className={LABEL}>Equity</div>
            <div className="font-display text-3xl font-semibold text-text tnum">{money(b.equity, 2)}</div>
            <div className={`font-mono text-sm tnum ${col(b.pnl)}`}>
              {moneySigned(b.pnl, 2)} ({pct(b.pnlPct)})
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-right text-xs">
            <dt className="text-faint">Cash</dt>
            <dd className="font-mono text-text tnum">{money(b.cash, 2)}</dd>
            <dt className="text-faint">Realized</dt>
            <dd className={`font-mono tnum ${col(b.realized)}`}>{moneySigned(b.realized, 2)}</dd>
            <dt className="text-faint">Win rate</dt>
            <dd className="font-mono text-text tnum">
              {decided ? `${Math.round((b.wins / decided) * 100)}% of ${decided}` : "—"}
              {b.flats > 0 && <span className="text-faint"> · {b.flats} flat</span>}
            </dd>
          </dl>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {isClaude && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className={`mb-2 ${LABEL}`}>What Claude is doing</div>
            <ClaudePlan run={run} />
          </div>
        )}

        <div>
          <div className={`mb-2 ${LABEL}`}>Limits used{isClaude ? " today" : ""}</div>
          <LimitsUsed b={b} />
        </div>

        <div>
          <div className={`mb-1 ${LABEL}`}>Positions ({b.positions.length})</div>
          {b.positions.length === 0 ? (
            <p className="text-sm text-dim">No positions.</p>
          ) : (
            b.positions.map((p) => (
              <div key={p.symbol} className="border-t border-border py-2 first:border-t-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-display font-semibold text-text">{p.symbol}</span>
                      {p.qty < 0 && (
                        <span className="rounded bg-loss/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-loss">Short</span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-faint tnum">
                      {shares(Math.abs(p.qty))} @ ${fprice(p.avgCost)} · in {when(p.openedAt)}
                    </div>
                    <div className="font-mono text-xs text-faint tnum">
                      {p.stop != null ? (
                        <span className="text-loss">
                          stop {p.qty < 0 && "above "}
                          {fprice(p.stop)}
                        </span>
                      ) : (
                        "no stop on record"
                      )}
                      {p.target != null && (
                        <span className="text-gain">
                          {" "}
                          · target {p.qty < 0 && "below "}
                          {fprice(p.target)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm text-text tnum">{p.price != null ? `$${fprice(p.price)}` : "—"}</div>
                    <div className={`font-mono text-xs tnum ${col(p.pnl)}`}>
                      {p.pnl != null && p.pnlPct != null ? `${moneySigned(p.pnl, 2)} · ${pct(p.pnlPct)}` : "—"}
                    </div>
                  </div>
                </div>
                {p.reason && (
                  <p className="mt-1 text-[11px] leading-snug text-dim">
                    <span className="text-faint">{isClaude ? "Claude's reason: " : "Why: "}</span>
                    {p.reason}
                  </p>
                )}
              </div>
            ))
          )}
        </div>

        {b.todayTrades.length > 0 && (
          <div>
            <div className={`mb-1 ${LABEL}`}>Today&apos;s trades ({b.todayTrades.length})</div>
            {b.todayTrades.map((t, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 border-t border-border py-1.5 text-xs first:border-t-0">
                <span className="min-w-0">
                  <span className={`font-semibold ${t.side === "buy" ? "text-gain" : "text-loss"}`}>
                    {t.role === "short" ? "Sold short" : t.role === "cover" ? "Bought to cover" : t.side === "buy" ? "Bought" : "Sold"}
                  </span>{" "}
                  <span className="font-mono text-text tnum">{shares(t.qty)}</span>{" "}
                  <span className="font-display font-semibold text-text">{t.symbol}</span>{" "}
                  <span className="font-mono text-dim tnum">at ${fprice(t.price)}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint tnum">{when(t.at, false)}</span>
              </div>
            ))}
          </div>
        )}

        {b.pending.length > 0 && (
          <div>
            <div className={`mb-1 ${LABEL}`}>Working orders ({b.pending.length})</div>
            {b.pending.map((o, i) => (
              <div key={i} className="border-t border-border py-1.5 font-mono text-xs text-dim tnum first:border-t-0">
                <span className={o.side === "buy" ? "text-gain" : "text-loss"}>
                  {o.side === "sell" && o.kind === "entry" ? "SELL SHORT" : o.side === "buy" && o.kind === "exit" ? "BUY TO COVER" : o.side.toUpperCase()}
                </span>{" "}
                <span className="font-semibold text-text">
                  {shares(o.qty)} {o.symbol}
                </span>
                {o.limit != null && ` limit $${fprice(o.limit)}`}
                {o.stop != null && ` · stop ${fprice(o.stop)}`}
                {o.target != null && ` · target ${fprice(o.target)}`}
                <span className="text-faint">
                  {" "}
                  · {o.kind === "entry" ? "waiting to fill" : o.stop != null ? "protective stop" : "exit queued"} ·{" "}
                  {when(o.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-border bg-surface2/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className={LABEL}>Latest run</span>
            <span className="font-mono text-xs text-dim">{run ? `${when(run.ran_at)} · ${run.mode}` : "not run yet"}</span>
          </div>
          {run ? <RunDetail s={run.summary} error={run.error} mode={run.mode} /> : null}
        </div>

        {isClaude && <Timeline runs={b.today} latestId={run?.id ?? null} />}

        {isClaude && <Replays days={b.replays} />}

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

        {!isClaude && <BacktestPanel bookKey={b.key} />}
      </div>
    </div>
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
