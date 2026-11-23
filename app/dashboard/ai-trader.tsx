"use client";

import { useEffect, useState } from "react";
import { money, moneySigned, pct } from "@/lib/portfolio";
import { RUNNER_LIMITS, boxEnabled, effective } from "@/lib/aitrader/limits";
import type { SettingsSection } from "@/lib/aitrader/layout";
import type { AiBookView, AiView } from "@/lib/aitrader/view";
import { hiddenBooks, isClaudeKey, showSharedAccount, totalsOf, visibleBooks } from "@/lib/aitrader/boxes";
import { LABEL, claudeNowLine, when } from "./ai-run";
import { BookCard, col } from "./ai-book";
import { ConnectCard, OffBadge, UsageMeter } from "./ai-settings";
import LiveUpdates from "./ai-live";

type Open = { tab: string; section?: "settings"; group?: SettingsSection; n: number };

/** Profit/loss of the trades closed today (NY day); null when nothing closed. */
function closedToday(b: AiBookView): number | null {
  const closed = b.todayTrades.filter((t) => t.pnl != null);
  return closed.length ? closed.reduce((a, t) => a + (t.pnl ?? 0), 0) : null;
}

/** One box in the side-by-side comparison: value, return since its start, open positions, today. */
function CompareCell({ b, onOpen }: { b: AiBookView; onOpen: (key: string) => void }) {
  const today = closedToday(b);
  const claude = isClaudeKey(b.key);
  return (
    <button
      onClick={() => onOpen(b.key)}
      className="w-full rounded-xl border border-border bg-surface p-3 text-left transition hover:border-accent/50 hover:bg-surface2/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${claude ? "bg-accent" : "bg-faint"}`} aria-hidden />
          <span className="truncate text-xs font-semibold text-dim">{b.name}</span>
        </span>
        {!boxEnabled(b.settings) && <OffBadge />}
      </div>
      <div className="mt-1 font-display text-lg font-semibold text-text tnum">{money(b.equity, 2)}</div>
      <div className={`font-mono text-xs tnum ${col(b.pnl)}`}>
        {pct(b.pnlPct)} since start <span className="text-faint">({moneySigned(b.pnl, 2)})</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-dim tnum">
        {b.positions.length} open · today (closed){" "}
        <span className={today != null ? col(today) : ""}>{today != null ? moneySigned(today, 2) : "—"}</span>
      </div>
    </button>
  );
}

export default function AiTrader({ ai }: { ai: AiView | null }) {
  const [open, setOpen] = useState<Open>({ tab: "overview", n: 0 });

  // Remember the open tab per browser (a convenience only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ai-tab");
      // Read after hydration so the server and first client render match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setOpen((o) => ({ ...o, tab: saved }));
    } catch {
      /* storage blocked */
    }
  }, []);
  function pick(tab: string, section?: "settings", group?: SettingsSection) {
    setOpen((o) => ({ tab, section, group, n: o.n + 1 }));
    try {
      localStorage.setItem("ai-tab", tab);
    } catch {
      /* storage blocked */
    }
  }

  if (!ai) {
    return (
      <section className="card mt-3 rounded-2xl border border-border bg-surface p-6 text-sm text-dim">
        AI Trader isn&apos;t enabled for this account.
      </section>
    );
  }

  // Hidden boxes (ai_books.hidden) stay loaded but are left out of the tabs, totals and comparisons.
  const books = visibleBooks(ai.books);
  const hidden = hiddenBooks(ai.books);
  const { equity: total, start: startTotal, pnl: allTime, pnlPct: allTimePct } = totalsOf(books);
  const todays = books.map(closedToday).filter((x): x is number => x != null);
  const today = todays.length ? todays.reduce((a, x) => a + x, 0) : null;
  const claudeBooks = books.filter((b) => isClaudeKey(b.key));
  const rulesCount = books.length - claudeBooks.length;
  // weekCostUsd is the runner's weekly usage; add up the visible Claude boxes only (Rules boxes carry none).
  const weekCost = claudeBooks.reduce((a, b) => a + b.weekCostUsd, 0);
  const sizes = Array.from(new Set(books.map((b) => b.startCash)));
  const model = String(effective(RUNNER_LIMITS, ai.runner).model);
  const current = books.find((b) => b.key === open.tab) ?? null;

  return (
    <section className="mt-3 space-y-4">
      <div className="card rounded-2xl border border-border bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-watch/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-watch ring-1 ring-inset ring-watch/30">
            Paper · simulated money
          </span>
          <LiveUpdates marketOpen={ai.marketOpen} />
        </div>
        <h2 className="mt-1.5 font-display text-xl font-semibold text-text">AI Trader</h2>
        <p className="mt-0.5 text-sm text-dim">
          {books.length} paper box{books.length === 1 ? "" : "es"}
          {sizes.length === 1 ? ` of ${money(sizes[0])}${books.length === 1 ? "" : " each"}` : ` (${money(startTotal)} in all)`}:{" "}
          {rulesCount ? `${rulesCount} run by fixed rules, ${claudeBooks.length} by Claude ${model}` : `run by Claude ${model}`}. Open a
          box for its details and settings.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:flex sm:flex-wrap sm:items-end sm:gap-x-10">
          <div className="col-span-2">
            <div className={LABEL}>Total ({books.length === 1 ? "1 box" : `${books.length} boxes`})</div>
            <div className="font-display text-2xl font-semibold text-text tnum">{money(total, 2)}</div>
          </div>
          <div>
            <div className={LABEL}>All time</div>
            <div className={`font-mono text-sm font-semibold tnum ${col(allTime)}`}>
              {moneySigned(allTime, 2)} <span className="font-normal">({pct(allTimePct)})</span>
            </div>
            <div className="text-[11px] text-faint">vs {money(startTotal)} to start</div>
          </div>
          <div>
            <div className={LABEL}>Today</div>
            <div className={`font-mono text-sm font-semibold tnum ${today != null ? col(today) : "text-dim"}`}>
              {today != null ? moneySigned(today, 2) : "—"}
            </div>
            <div className="text-[11px] text-faint">closed trades only</div>
          </div>
          {/* TODO(data): "Market (SPY) today" needs today's SPY move in AiView; only past reviews carry it. */}
          <div className="col-span-2 text-xs text-faint sm:ml-auto sm:text-right">
            {ai.accountEquity != null && showSharedAccount(books) && (
              <div className="font-mono tnum">Old shared Alpaca paper account {money(ai.accountEquity, 2)}</div>
            )}
            <div>{ai.prices === "live" ? "live prices" : "prices as of the Mac's last Claude run"}</div>
          </div>
        </div>
        {ai.error && <p className="mt-3 rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">{ai.error}</p>}
      </div>

      <nav className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="AI Trader boxes">
        <div className="flex min-w-max gap-1 rounded-xl border border-border bg-surface p-1">
          {[{ key: "overview", name: "Overview", isClaude: null as boolean | null, pnl: null as number | null, off: false }, ...books.map((b) => ({ key: b.key as string, name: b.name, isClaude: isClaudeKey(b.key), pnl: b.pnl, off: !boxEnabled(b.settings) }))].map((t) => {
            const on = (current?.key ?? "overview") === t.key;
            return (
              <button
                key={t.key}
                onClick={() => pick(t.key)}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${on ? "bg-surface2 text-text shadow-sm" : "text-dim hover:text-text"}`}
              >
                {t.isClaude != null && (
                  <span className={`h-1.5 w-1.5 rounded-full ${t.isClaude ? "bg-accent" : "bg-faint"}`} aria-hidden />
                )}
                <span className="whitespace-nowrap font-medium">{t.name}</span>
                {t.off && <OffBadge />}
                {t.pnl != null && <span className={`font-mono text-xs tnum ${col(t.pnl)}`}>{moneySigned(t.pnl, 0)}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      {current ? (
        <BookCard
          key={`${current.key}-${open.n}`}
          b={current}
          runner={ai.runner}
          weekCost={weekCost}
          initialSection={open.section}
          initialGroup={open.group}
          marketOpen={ai.marketOpen}
        />
      ) : (
        <>
          {/* The visible boxes side by side (Day Trader Claude vs Long-Term Claude first) */}
          {books.length > 0 && (
            <div className="card rounded-2xl border border-border bg-surface p-4 md:p-5">
              <h3 className="font-display text-sm font-semibold text-text">Side by side</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {books.map((b) => (
                  <CompareCell key={b.key} b={b} onOpen={pick} />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-faint">SPY comparison: coming</p>
            </div>
          )}

          {/* What each Claude box is doing, and this week's usage */}
          {claudeBooks.length > 0 && (
            <div className="card space-y-4 rounded-2xl border border-border bg-surface p-4 md:p-5">
              <div>
                <h3 className="font-display text-sm font-semibold text-text">What Claude is doing now</h3>
                <ul className="mt-2 divide-y divide-border">
                  {claudeBooks.map((b) => (
                    <li key={b.key} className="py-2">
                      <button onClick={() => pick(b.key)} className="w-full text-left">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="flex items-center gap-2 font-display text-sm font-semibold text-text">
                            {b.name}
                            {!boxEnabled(b.settings) && <OffBadge />}
                          </span>
                          <span className="font-mono text-[11px] text-faint">{b.lastRun ? `checked ${when(b.lastRun.ran_at)}` : "not run yet"}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-dim">
                          {claudeNowLine(b.lastRun) ?? "Claude hasn't run in this box yet."}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="border-t border-border pt-3">
                <UsageMeter runner={ai.runner} defs={RUNNER_LIMITS} weekCost={weekCost} />
                <button
                  onClick={() => pick(claudeBooks[0].key, "settings", "Schedule & cost")}
                  className="mt-2 text-xs font-medium text-accent hover:underline"
                >
                  Change the schedule and usage cap →
                </button>
              </div>
            </div>
          )}

          <details open={!ai.connection} className="card rounded-2xl border border-border bg-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-dim hover:text-text">
              <span aria-hidden>⚙</span> Setup
              <span className={`ml-auto text-xs ${ai.connection ? "text-gain" : "text-watch"}`}>
                Alpaca {ai.connection ? "connected" : "not connected"}
              </span>
            </summary>
            <div className="border-t border-border p-4">
              <ConnectCard connection={ai.connection} />
            </div>
          </details>

          <details className="text-xs text-dim">
            <summary className="cursor-pointer select-none text-faint hover:text-text">How it works</summary>
            <p className="mt-1.5 max-w-prose leading-relaxed">
              <b>Claude</b> boxes run on your Mac. Day Trader Claude day-trades during market hours on its own paper
              account: it scans, reads the news, times each buy and manages each sell. Long-Term Claude, on its own paper
              account too, looks once a day before the open and holds for weeks or months, guided by your Overkill
              indicator. <b>Rules</b> boxes are fixed code that runs on the website on weekday schedules. Every limit is
              yours to set in each box&apos;s Settings. Open any Claude run to see every step.
            </p>
          </details>
        </>
      )}

      {hidden.length > 0 && (
        <details className="text-xs text-dim">
          <summary className="cursor-pointer select-none text-faint hover:text-text">Hidden boxes ({hidden.length})</summary>
          <ul className="mt-1.5 space-y-0.5">
            {hidden.map((b) => (
              <li key={b.key}>{b.name}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[11px] leading-relaxed text-faint">
        Paper trading only — both the website and the Mac refuse non-paper keys and accounts. Rules boxes are fixed code
        driven by your settings; Claude boxes are Claude trading with its own risk checks on top of yours. Not investment
        advice; past or simulated results don&apos;t predict future returns.
      </p>
    </section>
  );
}
