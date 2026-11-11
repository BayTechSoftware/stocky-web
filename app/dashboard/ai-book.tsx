"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { loadRunDetail, removeNote, runAiTrader } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import { CLAUDE_LIMITS, RUNNER_LIMITS, SCORECARD_GATE_LABEL, boxEnabled, defsForBook, effective, rulesDefs, type LimitValue } from "@/lib/aitrader/limits";
import type { SettingsSection } from "@/lib/aitrader/layout";
import { gateVerdict, marketLine, signedPct, type AiReviewShadow, type AiReviewTrade, type AiShadowItem } from "@/lib/aitrader/reviews";
import type { AiBookView, AiNote, AiReplayDay, AiReview, AiRun, AiRunLite, ClosedTrade, ExitReason } from "@/lib/aitrader/view";
import { ClaudePlan, LABEL, RunDetail, col, phaseName, when } from "./ai-run";
import { BacktestPanel } from "./ai-backtest";
import { BoxSettings, OffBadge, RunnerSettings } from "./ai-settings";

const BLURB: Record<AiBookView["key"], string> = {
  mylist: "Fixed rules, no AI. Trades your watchlist on Stocky's signals, within your settings. Runs on the website on weekday schedules.",
  free: "Fixed rules, no AI. Buys daily chart setups across a hand-picked list of large US companies (minus your list), within your settings. Runs on the website on weekday schedules.",
  "claude-mylist":
    "Claude day-trades your watchlist: it scans, reads the news and times each buy and sell, within your settings. Runs on your Mac during market hours.",
  "claude-free":
    "Claude day-trades any US stock it picks. It reads the news and times each buy and sell, within your settings. Runs on your Mac during market hours.",
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
          {p >= 100 && <span className="ml-1.5 rounded bg-surface2 px-1.5 py-px font-sans text-[10px] font-semibold text-dim">limit reached</span>}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface2">
        <div className={`h-full rounded-full ${p >= 100 ? "bg-dim" : p >= 66 ? "bg-watch" : "bg-accent"}`} style={{ width: `${p}%` }} />
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
          label="Daily risk used (worst case at the stops)"
          used={used?.loss_at_risk_usd ?? null}
          max={Number(cfg.max_daily_loss_usd)}
          fmt={(n) => `$${n.toFixed(0)}`}
        />
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Profit/loss from closed trades today</span>
          <span className={`font-mono tnum ${col(used?.realized_pnl_today_usd)}`}>
            {used?.realized_pnl_today_usd != null ? moneySigned(used.realized_pnl_today_usd, 2) : "—"}
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Could still lose if every stop hits</span>
          <span className="font-mono text-text tnum">{used?.open_risk_usd != null ? money(used.open_risk_usd, 2) : "—"}</span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-dim">Buying window (NY)</span>
          <span className="font-mono text-text tnum">
            {!cfg.no_entries_before && !cfg.no_entries_after
              ? "all day"
              : `${String(cfg.no_entries_before || "open")}–${String(cfg.no_entries_after || "close")}`}{" "}
            · {cfg.flat_by ? `sell all by ${String(cfg.flat_by)}` : "may hold overnight"}
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
        label="Stocks held + buy orders waiting"
        used={b.positions.length + b.pending.filter((o) => o.kind === "entry").length}
        max={Number(cfg.max_positions)}
        fmt={(n) => String(n)}
      />
      <div className="space-y-1 text-[11px]">
        <div className="flex justify-between">
          <span className="text-dim">Most I can lose on one trade</span>
          <span className="font-mono text-text tnum">{cfg.risk_pct}% · ≈{money((b.equity * Number(cfg.risk_pct)) / 100)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Stop buying after a bad day</span>
          <span className="font-mono text-text tnum">{halt > 0 ? `${halt}%` : "off"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Take profit at · sell after</span>
          <span className="font-mono text-text tnum">
            {rr > 0 ? `${rr}× the risk` : "no target"} · {hold > 0 ? `${hold} days` : "no time limit"}
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
function Timeline({ runs, latestId, next }: { runs: AiRunLite[]; latestId: string | null; next: string | null }) {
  const { openId, detail, loading, toggle } = useRunDetails();
  if (!runs.length) {
    return (
      <div>
        <div className={`mb-1 ${LABEL}`}>Today&apos;s runs</div>
        <Empty>No runs yet today{next ? `; next check about ${next}` : ""}.</Empty>
      </div>
    );
  }
  return (
    <div>
      <div className={`mb-1 ${LABEL}`}>Today&apos;s runs ({runs.length})</div>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {runs.map((r) => {
          return (
            <li key={r.id}>
              <button
                onClick={() => toggle(r.id)}
                className="flex w-full flex-wrap items-start gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-left text-xs hover:bg-surface2/60"
              >
                <span className="shrink-0 font-mono text-[11px] text-text tnum sm:w-14">{when(r.ran_at, false)}</span>
                <span className="shrink-0 text-[11px] text-faint sm:w-36">{phaseName(r.phase)}</span>
                <span className="order-last min-w-0 basis-full text-dim sm:order-none sm:basis-0 sm:flex-1 sm:truncate">
                  {r.error ? <span className="text-loss">{r.error}</span> : r.reason ?? ""}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-faint tnum">
                  {r.buys > 0 && <span className="text-gain">{r.buys} buy{r.buys === 1 ? "" : "s"} </span>}
                  {r.sells > 0 && <span className="text-loss">{r.sells} sell{r.sells === 1 ? "" : "s"} </span>}
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
      <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-xs hover:bg-surface2/60">
        <span className="shrink-0 sm:w-20 font-mono text-[11px] text-text tnum">
          {d.date}
          {n && n !== "1" ? <span className="text-faint"> #{n}</span> : null}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint tnum sm:w-16">
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
                  className="flex w-full flex-wrap items-start gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-left text-xs hover:bg-surface2/60"
                >
                  <span className="shrink-0 font-mono text-[11px] text-text tnum sm:w-10">{st.at ?? "—"}</span>
                  <span className="shrink-0 text-[11px] text-faint sm:w-36">{phaseName(st.phase)}</span>
                  <span className="order-last min-w-0 basis-full text-dim sm:order-none sm:basis-0 sm:flex-1 sm:truncate">
                    {st.error ? <span className="text-loss">{st.error}</span> : st.reason ?? ""}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint tnum">
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

/** One active lesson or suggestion, with its Remove button. */
function NoteItem({ n, over, onRemoved }: { n: AiNote; over: boolean; onRemoved: (id: string) => void }) {
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  function remove() {
    if (!confirm(`Remove this ${n.kind}? Claude stops reading it from its next run.`)) return;
    setErr(null);
    start(async () => {
      const r = await removeNote(n.id);
      if ("error" in r) setErr(r.error);
      else {
        onRemoved(n.id);
        router.refresh();
      }
    });
  }
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-snug ${over ? "text-faint" : "text-text"}`}>{n.text}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-faint tnum">
          <span>{shortDay(n.day)}</span>
          {n.kind === "suggestion" && (
            <span className="rounded bg-watch/10 px-1.5 py-px font-sans text-[10px] font-semibold uppercase tracking-wider text-watch">
              suggestion
            </span>
          )}
          {over && <span className="font-sans">not read (over the limit)</span>}
        </div>
        {err && <p className="mt-1 text-xs text-loss">{err}</p>}
      </div>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-dim hover:border-loss/40 hover:text-loss disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
    </li>
  );
}

/** The active notes (ai_notes) the Mac writes into the book's lessons file before Claude's next run. */
export function ReadsNext({ notes, use, count }: { notes: AiNote[]; use: boolean; count: number }) {
  // Hide a removed note at once; the refreshed page data drops it for good.
  const [gone, setGone] = useState<string[]>([]);
  const active = notes.filter((n) => !gone.includes(n.id));
  const onRemoved = (id: string) => setGone((g) => [...g, id]);
  const lessons = active.filter((n) => n.kind === "lesson");
  const suggestions = active.filter((n) => n.kind === "suggestion");
  const list = (items: AiNote[]) => (
    <ul className="divide-y divide-border">
      {items.map((n, i) => (
        <NoteItem key={n.id} n={n} over={use && i >= count} onRemoved={onRemoved} />
      ))}
    </ul>
  );
  return (
    <div className="mb-3 rounded-xl border border-border bg-surface p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-sm font-semibold text-text">What Claude reads next</span>
        {use && active.length > 0 && <span className="text-[11px] text-faint">the newest {count} of each kind</span>}
      </div>
      {!use && <p className="mb-1 text-xs text-watch">&quot;Claude reads its lessons &amp; suggestions&quot; is off above — Claude reads none of these.</p>}
      {!active.length ? (
        <p className="py-2 text-sm text-dim">No lessons yet.</p>
      ) : (
        <>
          {lessons.length > 0 && (
            <div className="mt-2">
              <div className={LABEL}>Lessons ({lessons.length})</div>
              {list(lessons)}
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="mt-3">
              <div className={LABEL}>Suggestions for you ({suggestions.length})</div>
              <p className="mt-0.5 text-[11px] leading-snug text-faint">
                Setting changes the review proposes; the decision is yours. Change the setting in this box&apos;s Settings if
                you agree — Claude never acts against a setting.
              </p>
              {list(suggestions)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The Mac's after-close reviews (bin/reviewer.py → ai_reviews), newest day first, under the notes Claude reads next. */
/** Whether Claude reads lessons, and how many of each kind (the box's saved settings). */
function lessonUse(settings: AiBookView["settings"]) {
  const cfg = effective(CLAUDE_LIMITS, settings);
  const use = cfg.use_lessons !== false && cfg.use_lessons !== "false";
  const want = Number(cfg.lessons_count);
  return { use, count: Number.isFinite(want) && want >= 0 ? Math.floor(want) : 8 };
}

function DailyReviews({ reviews, notes, onLessons }: { reviews: AiReview[]; notes: AiNote[]; onLessons: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? reviews : reviews.slice(0, 1);
  return (
    <Block title="Daily review" hint="written after the close">
      <p className="mb-3 text-xs text-dim">
        {notes.length} lesson{notes.length === 1 ? "" : "s"} and suggestion{notes.length === 1 ? "" : "s"} Claude reads next —{" "}
        <button type="button" onClick={onLessons} className="font-medium text-accent hover:underline">
          see or remove them in Settings → Learning
        </button>
      </p>
      {!reviews.length ? (
        <Empty>No review yet. After each trading day&apos;s close the Mac writes one here.</Empty>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((r) => {
            const s = r.stats;
            const reasons = Object.entries(s.exit_reasons ?? {})
              .map(([k, n]) => `${REASON_LABEL[k as ExitReason] ?? k} ${n}`)
              .join(" · ");
            const written = r.lessons.length + r.suggestions.length;
            return (
              <li key={r.day} className="rounded-xl border border-border bg-surface2/30 p-4">
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-display text-sm font-semibold text-text">{reviewDay(r.day)}</span>
                  <span className="font-mono text-[11px] text-dim tnum">
                    {s.trades != null && `${s.trades} trade${s.trades === 1 ? "" : "s"}`}
                    {s.wins != null && s.trades ? ` · ${s.wins} won` : ""}
                    {s.pnl != null && <span className={col(s.pnl)}> · {moneySigned(s.pnl, 2)}</span>}
                    {s.avg_r != null && ` · avg ${s.avg_r.toFixed(2)}× the risk`}
                  </span>
                </div>
                {r.summary && <p className="text-sm leading-relaxed text-text">{r.summary}</p>}
                {marketLine(s) && <p className="mt-1.5 font-mono text-[11px] leading-snug text-dim tnum">{marketLine(s)}</p>}
                {s.closed && s.closed.length > 0 && <DayTrades trades={s.closed} />}
                {s.shadow && <TradesNotTaken sh={s.shadow} />}
                {written > 0 && (
                  <details className="mt-2 text-[12px] text-dim">
                    <summary className="cursor-pointer select-none text-faint hover:text-dim">
                      As written that day ({r.lessons.length} lesson{r.lessons.length === 1 ? "" : "s"}
                      {r.suggestions.length > 0 && `, ${r.suggestions.length} suggestion${r.suggestions.length === 1 ? "" : "s"}`})
                    </summary>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 leading-snug">
                      {r.lessons.map((l, i) => (
                        <li key={`l${i}`}>{l}</li>
                      ))}
                      {r.suggestions.map((l, i) => (
                        <li key={`s${i}`}>
                          <span className="text-watch">suggestion:</span> {l}
                        </li>
                      ))}
                    </ul>
                  </details>
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
      )}
      {reviews.length > 1 && (
        <button onClick={() => setAll(!all)} className="mt-2 text-xs font-medium text-accent hover:underline">
          {all ? "Show the latest only" : `Show the last ${reviews.length} days`}
        </button>
      )}
    </Block>
  );
}

const signedR = (r: number) => `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)}× the risk`;
const DIR_WORD = { long: "bought", short: "sold short" } as const;

/** One closed trade of the day: symbol, direction, result $, and how it did against the market. */
function DayTradeRow({ t }: { t: AiReviewTrade }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
      <span className="font-display font-semibold text-text">{t.symbol}</span>
      {t.direction && <span className="text-[11px] text-faint">{DIR_WORD[t.direction]}</span>}
      {t.pnl != null && <span className={`font-mono tnum ${col(t.pnl)}`}>{moneySigned(t.pnl, 2)}</span>}
      {t.alpha_pct != null && (
        <span className={`font-mono text-[11px] tnum ${col(t.alpha_pct)}`}>vs market {signedPct(t.alpha_pct)}</span>
      )}
      {t.sector && t.sector_pct != null && (
        <span className="font-mono text-[10.5px] text-faint tnum">
          · {t.sector} {signedPct(t.sector_pct)}
        </span>
      )}
    </li>
  );
}

/** The day's closed trades; folded away when there are more than a few. */
function DayTrades({ trades }: { trades: AiReviewTrade[] }) {
  const list = (
    <ul className="mt-1 space-y-0.5">
      {trades.map((t, i) => (
        <DayTradeRow key={`${t.symbol}${i}`} t={t} />
      ))}
    </ul>
  );
  if (trades.length <= 3) {
    return (
      <div className="mt-2">
        <div className={LABEL}>The day&apos;s trades</div>
        {list}
      </div>
    );
  }
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer select-none ${LABEL} hover:text-dim`}>The day&apos;s trades ({trades.length})</summary>
      {list}
    </details>
  );
}

const WHY_WORD: Record<string, string> = { skip: "skipped", blocked: "blocked", "not chosen": "not chosen" };
const RESULT_WORD: Record<string, { word: string; cls: string }> = {
  target: { word: "would have hit the target", cls: "text-gain" },
  stop: { word: "would have hit the stop", cls: "text-loss" },
  open: { word: "still open at the close", cls: "text-dim" },
};
const VERDICT_CLS = { helped: "text-gain", "cost you": "text-loss", even: "text-dim" } as const;
const gateName = (g: string) => SCORECARD_GATE_LABEL[g] ?? g.replace(/_/g, " ");

function ShadowRow({ it }: { it: AiShadowItem }) {
  const res = it.result ? RESULT_WORD[it.result] : null;
  return (
    <li className="text-[12px] leading-snug">
      <span className="font-display font-semibold text-text">{it.symbol}</span>
      {it.dir && <span className="text-[11px] text-faint"> {it.dir === "short" ? "short" : "buy"}</span>}
      {it.why && <span className="text-[11px] text-faint"> · {WHY_WORD[it.why]}</span>}
      {it.score != null && <span className="font-mono text-[11px] text-faint tnum"> · score {it.score}</span>}
      {it.at && <span className="font-mono text-[11px] text-faint tnum"> · {it.at}</span>}
      {res && <span className={`text-[11px] ${res.cls}`}> — {res.word}</span>}
      {(it.r != null || it.pct != null) && (
        <span className="font-mono text-[11px] text-dim tnum">
          {" "}
          ({[it.r != null ? signedR(it.r) : "", it.pct != null ? signedPct(it.pct) : ""].filter(Boolean).join(", ")})
        </span>
      )}
      {it.failed.length > 0 && <div className="text-[10.5px] text-faint">failed: {it.failed.map(gateName).join(", ")}</div>}
    </li>
  );
}

/** Per check, the newest review's verdict on the stocks it kept out (for Settings → Checks). */
export function latestGateVerdicts(reviews: AiReview[]): { day: string; byGate: Record<string, AiReviewShadow["by_gate"][number]> } | null {
  for (const r of reviews) {
    const by = r.stats?.shadow?.by_gate;
    if (Array.isArray(by) && by.length) return { day: r.day, byGate: Object.fromEntries(by.map((g) => [g.gate, g])) };
  }
  return null;
}

/** What the stocks Claude passed on did after it passed (stats.shadow), overall and per scorecard check. */
function TradesNotTaken({ sh }: { sh: AiReviewShadow }) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
      <div className={LABEL}>Trades not taken</div>
      <p className="mt-1 text-[13px] leading-snug text-text">
        Claude passed on {sh.n} stock{sh.n === 1 ? "" : "s"}: <span className="text-gain">{sh.would_win} would have won</span>,{" "}
        <span className="text-loss">{sh.would_lose} would have lost</span>.
      </p>
      {sh.by_gate.length > 0 && (
        <>
          <p className="mt-2 text-[11px] leading-snug text-faint">
            Per scorecard check: the stocks it kept out, and what they did. A check helped when it kept out more losers than
            winners. −1× the risk = the stop would have been hit.
          </p>
          <ul className="mt-1 divide-y divide-border">
            {sh.by_gate.map((g) => {
              const v = gateVerdict(g);
              return (
                <li key={g.gate} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1 text-[12px]">
                  <span className="min-w-0 text-dim">{gateName(g.gate)}</span>
                  <span className="font-mono text-[11px] text-dim tnum">
                    kept out {g.n}: {g.would_win} winner{g.would_win === 1 ? "" : "s"}, {g.would_lose} loser{g.would_lose === 1 ? "" : "s"}
                    {g.avg_r != null && `, avg ${signedR(g.avg_r)}`}{" "}
                    <span className={`font-sans font-semibold ${VERDICT_CLS[v]}`}>{v}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {sh.items.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-[11px] text-faint hover:text-dim">
            The {sh.items.length} stock{sh.items.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-1">
            {sh.items.map((it, i) => (
              <ShadowRow key={`${it.symbol}${i}`} it={it} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** "Nov 10" from "2026-11-10" (a calendar day: no time zone shift). */
function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Tue, Nov 10" from "2026-11-10" (a calendar day: no time zone shift). */
function reviewDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Claude replays of past days (simulated on the Mac; never in this box's ledger). */
function Replays({ days }: { days: AiReplayDay[] }) {
  if (!days.length) {
    return (
      <div>
        <div className={`mb-1 ${LABEL}`}>Replays</div>
        <Empty>No replays yet. A replay re-runs Claude on a past day with simulated fills; start one on the Mac.</Empty>
      </div>
    );
  }
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

/** Run both Rules boxes now, or a dry run (decisions only). */
function RulesRunButtons() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  function go(mode: "manual" | "dry") {
    if (mode === "manual" && !confirm("Run both Rules boxes now? They will place PAPER orders (simulated money).")) return;
    setMsg(null);
    start(async () => {
      try {
        const r = await runAiTrader(mode);
        setMsg("error" in r ? { text: r.error, err: true } : { text: r.message });
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : String(e), err: true });
      }
      router.refresh();
    });
  }
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs leading-snug text-dim">
        Rules boxes run by themselves on weekday schedules. Run them now, or do a dry run that only shows what they would do.
        Both buttons run both Rules boxes.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => go("dry")}
          disabled={busy}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text disabled:opacity-60"
        >
          Dry run
        </button>
        <button
          type="button"
          onClick={() => go("manual")}
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "Running…" : "Run now"}
        </button>
      </div>
      {msg && <p className={`mt-2 text-xs ${msg.err ? "text-loss" : "text-dim"}`}>{msg.text}</p>}
    </div>
  );
}

const VERDICT_WORD = { helped: "helped", "cost you": "cost you", even: "about even" } as const;

/** A check's verdict from the newest daily review, shown under it in Settings → Checks. */
function GateVerdict({ day, g }: { day: string; g: AiReviewShadow["by_gate"][number] }) {
  const v = gateVerdict(g);
  return (
    <p className="mt-1 rounded-md bg-surface2/60 px-2 py-1 text-xs leading-snug text-dim">
      Review of {shortDay(day)}: kept out {g.n} — {g.would_win} would have won, {g.would_lose} would have lost.{" "}
      <span className={`font-semibold ${VERDICT_CLS[v]}`}>It {VERDICT_WORD[v]}.</span>
    </p>
  );
}

/** "2:30 PM": about when the next check runs (latest run + the runner's interval), if still ahead. */
function nextCheck(lastRunAt: string | null | undefined, runner: Record<string, LimitValue>, now: number): string | null {
  if (!lastRunAt) return null;
  const every = Number(effective(RUNNER_LIMITS, runner).interval_min) || 0;
  const t = new Date(lastRunAt).getTime() + every * 60_000;
  if (!every || !Number.isFinite(t) || t <= now) return null;
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

type Section = "now" | "trades" | "why" | "history" | "settings";

export function BookCard({
  b,
  runner,
  weekCost,
  initialSection,
  initialGroup,
}: {
  b: AiBookView;
  runner: Record<string, LimitValue>;
  /** This week's Claude usage, both Claude boxes together. */
  weekCost: number;
  initialSection?: Section;
  initialGroup?: SettingsSection;
}) {
  const isClaude = b.key.startsWith("claude-");
  const off = !boxEnabled(b.settings);
  const run = b.lastRun;
  const defs = defsForBook(b.key);
  const [section, setSection] = useState<Section>(initialSection ?? "now");
  const [group, setGroup] = useState<SettingsSection | undefined>(initialGroup);
  const [now] = useState(() => Date.now());
  // A Rules box's size is its start_cash; show the real one when no budget is saved.
  const saved = isClaude ? b.settings : { budget: b.startCash, ...b.settings };
  const budget = Number(effective(defs, saved).budget) || b.startCash;
  const decided = b.wins + b.losses;
  const closedToday = b.todayTrades.filter((t) => t.pnl != null);
  const todayPnl = closedToday.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const openPnl = b.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const entriesWaiting = b.pending.filter((o) => o.kind === "entry").length;
  const next = isClaude ? nextCheck(run?.ran_at, runner, now) : null;

  const status = [
    b.positions.length ? `Holding ${b.positions.length} stock${b.positions.length === 1 ? "" : "s"}` : "Nothing open",
    closedToday.length ? `${closedToday.length} closed today, ${moneySigned(todayPnl, 2)}` : null,
    entriesWaiting ? `${entriesWaiting} order${entriesWaiting === 1 ? "" : "s"} waiting to fill` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: { key: Section; label: string; count?: number }[] = [
    { key: "now", label: "Now", count: b.positions.length + b.pending.length || undefined },
    { key: "trades", label: "Trades", count: b.closed.length || undefined },
    { key: "why", label: isClaude ? "Why & review" : "Latest run" },
    ...(isClaude ? [{ key: "history" as Section, label: "History", count: b.today.length || undefined }] : []),
    { key: "settings", label: "Settings" },
  ];

  const openSettings = (g: SettingsSection) => {
    setGroup(g);
    setSection("settings");
  };

  const verdicts = isClaude ? latestGateVerdicts(b.reviews) : null;
  const fieldExtras: Record<string, ReactNode> = {};
  if (verdicts) {
    for (const [gate, g] of Object.entries(verdicts.byGate)) fieldExtras[`gate_${gate}`] = <GateVerdict day={verdicts.day} g={g} />;
  }
  const lessons = lessonUse(b.settings);

  return (
    <div className="card rounded-2xl border border-border bg-surface">
      {/* ---------- what Claude is doing now (first thing on a Claude box) ---------- */}
      {isClaude && (
        <div className="border-b border-border p-5 md:p-6">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-display text-sm font-semibold text-text">What Claude is doing now</h3>
            {next && <span className="text-[11px] text-faint">next check about {next}</span>}
          </div>
          <div className="rounded-xl border border-border bg-surface2/40 p-4">
            <ClaudePlan run={run} />
          </div>
        </div>
      )}

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
              {off && <OffBadge />}
            </div>
            {off && (
              <p className="mt-1.5 max-w-prose rounded-md bg-loss/10 px-3 py-2 text-xs leading-snug text-loss">
                This box is switched off: it places no new trades. Open positions keep their stops and exits. Turn it back on in Settings → Money &amp; risk.
              </p>
            )}
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
          <Stat
            label="Today (closed)"
            value={closedToday.length ? moneySigned(todayPnl, 2) : "—"}
            tone={closedToday.length ? todayPnl : null}
            sub="closed trades only; open trades not included"
          />
          <Stat
            label="Open trades (unrealised)"
            value={b.positions.length ? moneySigned(openPnl, 2) : "—"}
            tone={b.positions.length ? openPnl : null}
            sub={`${money(b.cash, 2)} cash`}
          />
          <Stat
            label="Win rate"
            value={decided ? `${Math.round((b.wins / decided) * 100)}%` : "—"}
            sub={decided ? `${b.wins} won · ${b.losses} lost` : "no closed trades yet"}
          />
        </div>

        <p className="mt-4 rounded-lg bg-surface2/70 px-3 py-2 text-xs text-dim">{status}</p>
      </header>

      {/* ---------- section switcher (not sticky: the page's own tab bar already sticks at the top) ---------- */}
      <nav className="border-y border-border bg-surface px-3 md:px-5" aria-label={`${b.name} sections`}>
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
                          {o.stop != null && `stop $${fprice(o.stop)} · `}
                          {o.target != null && `target $${fprice(o.target)} · `}
                          {o.kind === "entry" ? "waiting to fill" : o.stop != null ? "protective stop" : "sell queued"}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-faint tnum">{when(o.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            <Block title={`Limits used${isClaude ? " today" : ""}`}>
              <div className="rounded-xl border border-border p-4">
                <LimitsUsed b={b} />
              </div>
            </Block>
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

        {section === "why" && (
          <>
            <Block title={isClaude ? "Latest check, step by step" : "Latest run"} hint={run ? `${when(run.ran_at)} · ${run.mode}` : "not run yet"}>
              {run ? (
                <div className="rounded-xl border border-border bg-surface2/30 p-4">
                  <RunDetail s={run.summary} error={run.error} mode={run.mode} />
                </div>
              ) : (
                <Empty>
                  {isClaude
                    ? `Claude hasn't run in this box yet${next ? `; next check about ${next}` : ""}.`
                    : "This box hasn't run yet. Rules boxes run on weekday schedules, or use Run now in Settings → Schedule & cost."}
                </Empty>
              )}
            </Block>
            {isClaude && <DailyReviews reviews={b.reviews} notes={b.notes} onLessons={() => openSettings("Learning")} />}
          </>
        )}

        {section === "history" && isClaude && (
          <>
            <Timeline runs={b.today} latestId={run?.id ?? null} next={next} />
            <Replays days={b.replays} />
          </>
        )}

        {section === "settings" && (
          <BoxSettings
            key={b.key}
            bookKey={b.key}
            claude={isClaude}
            defs={defs}
            saved={saved}
            budget={budget}
            initialSection={group}
            fieldExtras={fieldExtras}
            sectionExtras={isClaude ? { Learning: <ReadsNext notes={b.notes} use={lessons.use} count={lessons.count} /> } : undefined}
            scheduleBadge={isClaude ? "shared by both Claude boxes" : undefined}
            schedule={(current) =>
              isClaude ? (
                <RunnerSettings defs={RUNNER_LIMITS} saved={runner} weekCost={weekCost} />
              ) : (
                <div className="space-y-3">
                  <RulesRunButtons />
                  <BacktestPanel bookKey={b.key} getValues={current} />
                </div>
              )
            }
          />
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
