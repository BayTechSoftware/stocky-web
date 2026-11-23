"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { money, moneySigned, pct } from "@/lib/portfolio";
import { RUNNER_LIMITS, boxEnabled, effective } from "@/lib/aitrader/limits";
import type { SettingsSection } from "@/lib/aitrader/layout";
import type { AiBookView, AiView } from "@/lib/aitrader/view";
import { OWN_ACCOUNT_KEYS, hiddenBooks, isClaudeKey, showSharedAccount, totalsOf, visibleBooks } from "@/lib/aitrader/boxes";
import { nyDate } from "@/lib/aitrader/flow";
import { marketLine, runSentence, shortDate, sinceYesterday, todayStats, tooEarly } from "@/lib/aitrader/page";
import { BLURB, BoxSettingsPanel } from "./ai-book";
import { Badge, BoxPage, LinkButton, PaperBadge, arrow, toneText } from "./ai-box";
import { CompareChart, CompareStrip, firstDayOf, sinceFor, useCompare, useSpyDaily } from "./ai-compare";
import { ConnectCard, UsageMeter } from "./ai-settings";
import LiveUpdates from "./ai-live";

type Open = { tab: string; section?: "settings"; group?: SettingsSection; n: number };

/** "Day Trader Claude" → "Day Trader" for the "Open … →" link. */
const shortName = (name: string) => name.replace(/\s+Claude$/, "");

/** One Claude box on the overview: value, the market comparison, three small numbers and what it is doing. */
function BoxCard({ b, spy, today, onOpen }: { b: AiBookView; spy: ReturnType<typeof useSpyDaily>; today: string; onOpen: () => void }) {
  const cmp = useCompare(b, "all", spy);
  const first = firstDayOf(b);
  const isLong = b.key === "claude-long";
  const st = todayStats(b.todayTrades);
  const openPnl = b.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const anyToday = st.closed > 0 || b.positions.length > 0;
  const todayPnl = sinceYesterday(b.series, b.equity, today) ?? (anyToday ? st.locked + openPnl : null);
  const cashPct = b.equity > 0 ? Math.max(0, (b.cash / b.equity) * 100) : null;
  const early = isLong ? tooEarly(first, today) : null;
  const off = !boxEnabled(b.settings);
  const mini = (label: string, value: ReactNode, cls = "text-text") => (
    <div className="min-w-0">
      <div className="text-[12px] text-dim">{label}</div>
      <div className={`text-[16px] font-semibold tnum ${cls}`}>{value}</div>
    </div>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className="ai-card flex w-full flex-col gap-[18px] text-left transition hover:border-faint focus-visible:outline-2 focus-visible:outline-link"
    >
      <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2">
          <span className="font-display text-[18px] font-semibold text-text md:text-[20px]">{b.name}</span>
          {off && <Badge tone="off">Off</Badge>}
        </span>
        <span className="text-[13px] text-sub">{first ? `since ${shortDate(first)}` : ""}</span>
      </span>
      <span className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="font-display text-[40px] font-bold leading-none text-text md:text-[44px]">{money(b.equity, 0)}</span>
        <span className={`text-[16px] font-semibold tnum ${toneText(b.pnl)}`}>
          {arrow(b.pnl)}
          {moneySigned(b.pnl, 0)} · {pct(b.pnlPct, 1)}
        </span>
      </span>
      {cmp && <CompareStrip sentence={cmp.sentence} />}
      {cmp && <CompareChart c={cmp.c} range="all" mini />}
      <span className="grid w-full grid-cols-3 gap-3 border-t border-surface2 pt-4">
        {mini("Today", todayPnl != null ? moneySigned(todayPnl, 0) : "—", toneText(todayPnl))}
        {mini("Holding", `${b.positions.length} stock${b.positions.length === 1 ? "" : "s"}`)}
        {isLong
          ? mini("Cash", cashPct != null ? `${Math.round(cashPct)}%` : "—")
          : mini("Won today", st.closed ? `${st.won} of ${st.closed}` : "—")}
      </span>
      <span className="text-[14px] leading-relaxed text-sub">
        <b className="font-semibold text-text">Right now:</b> {runSentence(b.lastRun) ?? "Claude hasn't looked at this box yet."}
        {early && <span className="text-dim"> {early}</span>}
      </span>
      <span className="text-[14px] font-semibold text-link">Open {shortName(b.name)} →</span>
    </button>
  );
}

/** Any other visible box (Rules, the old Claude boxes): one compact row. */
function BoxRow({ b, onOpen }: { b: AiBookView; onOpen: () => void }) {
  return (
    <li className="border-t border-surface2 first:border-t-0">
      <button type="button" onClick={onOpen} className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 py-3 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-display text-[16px] font-semibold text-text">{b.name}</span>
          {!boxEnabled(b.settings) && <Badge tone="off">Off</Badge>}
        </span>
        <span className="text-[13px] text-dim">{isClaudeKey(b.key) ? "Claude" : "fixed rules"}</span>
        <span className="ml-auto text-[15px] font-semibold text-text tnum">{money(b.equity, 0)}</span>
        <span className={`text-right text-[14px] tnum sm:w-28 ${toneText(b.pnl)}`}>
          {arrow(b.pnl)}
          {pct(b.pnlPct, 1)}
        </span>
        <span className="text-[14px] text-link" aria-hidden>
          →
        </span>
      </button>
    </li>
  );
}

type Foot = "hidden" | "how" | "alpaca" | "usage";

export default function AiTrader({ ai }: { ai: AiView | null }) {
  const [open, setOpen] = useState<Open>({ tab: "overview", n: 0 });
  const [foot, setFoot] = useState<Foot | null>(null);
  const [nowMs, setNowMs] = useState(0);

  // Remember the open view per browser (a convenience only); read the clock after hydration.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ai-tab");
      // Read after hydration so the server and first client render match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setOpen((o) => ({ ...o, tab: saved }));
    } catch {
      /* storage blocked */
    }
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  function pick(tab: string, section?: "settings", group?: SettingsSection) {
    setOpen((o) => ({ tab, section, group, n: o.n + 1 }));
    try {
      localStorage.setItem("ai-tab", tab);
    } catch {
      /* storage blocked */
    }
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  const books = useMemo(() => (ai ? visibleBooks(ai.books) : []), [ai]);
  const spy = useSpyDaily(useMemo(() => (books.length ? sinceFor(books) : null), [books]));

  if (!ai) {
    return (
      <section className="ai-card mt-3 text-[15px] text-dim">AI Trader isn&apos;t enabled for this account.</section>
    );
  }

  // Hidden boxes (ai_books.hidden) stay loaded but are left out of the cards, totals and comparisons.
  const hidden = hiddenBooks(ai.books);
  const claudeBooks = books.filter((b) => isClaudeKey(b.key));
  const main = books.filter((b) => OWN_ACCOUNT_KEYS.includes(b.key));
  const rest = books.filter((b) => !OWN_ACCOUNT_KEYS.includes(b.key));
  // weekCostUsd is the runner's weekly usage; add up the visible Claude boxes only (Rules boxes carry none).
  const weekCost = claudeBooks.reduce((a, b) => a + b.weekCostUsd, 0);
  const model = String(effective(RUNNER_LIMITS, ai.runner).model);
  const current = books.find((b) => b.key === open.tab) ?? null;
  const today = nyDate();

  if (current && open.section === "settings") {
    return (
      <section className="ai-page mt-3 flex flex-col gap-4 md:gap-6">
        <nav className="text-[14px]">
          <LinkButton onClick={() => pick(current.key)} className="min-h-11">
            ← Back to {current.name}
          </LinkButton>
        </nav>
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-text md:text-[30px]">Settings · {current.name}</h1>
            <PaperBadge />
          </div>
          <p className="max-w-prose text-[15px] leading-snug text-sub">{BLURB[current.key]}</p>
          {books.length > 1 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px]">
              <span className="text-dim">Settings for</span>
              {books.map((x) =>
                x.key === current.key ? (
                  <span key={x.key} className="min-h-11 content-center font-semibold text-text">
                    {x.name}
                  </span>
                ) : (
                  <LinkButton key={x.key} onClick={() => pick(x.key, "settings")} className="min-h-11">
                    {x.name}
                  </LinkButton>
                )
              )}
            </div>
          )}
        </header>
        <div className="ai-card">
          <BoxSettingsPanel key={`${current.key}-${open.n}`} b={current} runner={ai.runner} weekCost={weekCost} initialGroup={open.group} />
        </div>
      </section>
    );
  }
  if (current) {
    return (
      <section className="ai-page mt-3">
        <BoxPage
          key={current.key}
          b={current}
          runner={ai.runner}
          marketOpen={ai.marketOpen}
          clock={ai.clock}
          error={ai.error}
          onBack={() => pick("overview")}
          onSettings={(g) => pick(current.key, "settings", g)}
        />
        <div className="mt-6">
          <LiveUpdates marketOpen={ai.marketOpen} />
        </div>
      </section>
    );
  }

  const market = marketLine(ai.marketOpen == null ? null : { isOpen: ai.marketOpen, nextOpen: ai.clock?.nextOpen ?? null, nextClose: ai.clock?.nextClose ?? null }, nowMs);
  const totals = totalsOf(books);
  const settingsBox = claudeBooks[0] ?? books[0] ?? null;
  const footLink = (k: Foot, label: string) => (
    <button
      type="button"
      onClick={() => setFoot((f) => (f === k ? null : k))}
      aria-expanded={foot === k}
      className={`min-h-11 text-left font-medium hover:underline ${foot === k ? "text-text" : "text-link"}`}
    >
      {label}
    </button>
  );

  return (
    <section className="ai-page mt-3 flex flex-col gap-4 md:gap-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-text md:text-[28px]">AI Trader</h1>
        <PaperBadge />
        {market && (
          <span className="inline-flex items-center gap-2 text-[14px] text-sub">
            <span className={`h-2 w-2 rounded-full ${ai.marketOpen ? "bg-gain" : "bg-faint"}`} aria-hidden />
            {market}
          </span>
        )}
        {settingsBox && (
          <LinkButton onClick={() => pick(settingsBox.key, "settings")} className="ml-auto min-h-11 text-[14px]">
            Settings
          </LinkButton>
        )}
      </header>

      {ai.error && <p className="rounded-[10px] bg-loss-tint px-3.5 py-2 text-[13px] text-loss-ink">{ai.error}</p>}

      {!ai.connection && (
        <div className="ai-card">
          <ConnectCard connection={ai.connection} />
        </div>
      )}

      {main.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 md:gap-6">
          {main.map((b) => (
            <BoxCard key={b.key} b={b} spy={spy} today={today} onOpen={() => pick(b.key)} />
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <section className="ai-card" aria-label="Other boxes">
          <h2 className="mb-1 font-display text-[18px] font-semibold text-text md:text-[20px]">{main.length ? "Other boxes" : "Boxes"}</h2>
          <ul>
            {rest.map((b) => (
              <BoxRow key={b.key} b={b} onOpen={() => pick(b.key)} />
            ))}
          </ul>
        </section>
      )}

      {books.length === 0 && <p className="ai-card text-[15px] text-dim">No boxes to show: every box is hidden.</p>}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[14px]">
          {hidden.length > 0 && footLink("hidden", `Old boxes (${hidden.length}, hidden)`)}
          {footLink("how", "How the AI Trader works")}
          {footLink("alpaca", ai.connection ? "Alpaca connection" : "Alpaca connection (not connected)")}
          {claudeBooks.length > 0 && footLink("usage", `Claude usage: $${weekCost.toFixed(2)} this week`)}
          <span className="text-dim sm:ml-auto">Practice account · no real money is used</span>
        </div>

        {foot === "hidden" && (
          <div className="ai-card text-[14px] text-sub">
            <p className="mb-2">Hidden boxes stay in your account but are left out of the page, totals and comparisons.</p>
            <ul className="space-y-1">
              {hidden.map((b) => (
                <li key={b.key} className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold text-text">{b.name}</span>
                  <span className="tnum">
                    {money(b.equity, 0)} · {pct(b.pnlPct, 1)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {foot === "how" && (
          <div className="ai-card max-w-prose text-[15px] leading-relaxed text-sub">
            <p>
              <b className="text-text">Claude</b> boxes run on your Mac. Day Trader Claude day-trades during market hours on its own paper
              account: it scans, reads the news, times each buy and manages each sell. Long-Term Claude, on its own paper account too, holds
              for weeks or months, guided by your Overkill indicator. <b className="text-text">Rules</b> boxes are fixed code that runs on
              the website on weekday schedules. Every limit is yours to set in each box&apos;s Settings. Open a box and its details to see
              every step. The Claude boxes use {model}.
            </p>
            <p className="mt-2 text-[13px] text-dim">
              Paper trading only — both the website and the Mac refuse non-paper keys and accounts. Not investment advice; past or simulated
              results don&apos;t predict future returns.
            </p>
          </div>
        )}
        {foot === "alpaca" && (
          <div className="ai-card space-y-3">
            <ConnectCard connection={ai.connection} />
            <div className="border-t border-surface2 pt-3 text-[13px] text-dim tnum">
              <div>
                All {books.length} visible box{books.length === 1 ? "" : "es"} together: {money(totals.equity, 0)} ({moneySigned(totals.pnl, 0)},{" "}
                {pct(totals.pnlPct, 1)} on {money(totals.start, 0)})
              </div>
              {ai.accountEquity != null && showSharedAccount(books) && <div>Old shared Alpaca paper account: {money(ai.accountEquity, 2)}</div>}
              <div>{ai.prices === "live" ? "Prices are live." : "Prices are as of the Mac's last Claude run."}</div>
            </div>
          </div>
        )}
        {foot === "usage" && claudeBooks.length > 0 && (
          <div className="ai-card space-y-2">
            <UsageMeter runner={ai.runner} defs={RUNNER_LIMITS} weekCost={weekCost} />
            <LinkButton onClick={() => pick(claudeBooks[0].key, "settings", "Schedule & cost")} className="text-[13px]">
              Change the schedule and usage cap →
            </LinkButton>
          </div>
        )}
        <LiveUpdates marketOpen={ai.marketOpen} />
      </div>
    </section>
  );
}
