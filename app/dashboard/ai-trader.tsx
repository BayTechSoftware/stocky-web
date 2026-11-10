"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAiTrader } from "../actions";
import { money, moneySigned, pct } from "@/lib/portfolio";
import { RUNNER_LIMITS, effective } from "@/lib/aitrader/limits";
import type { AiView } from "@/lib/aitrader/view";
import { LABEL } from "./ai-run";
import { BookCard, BookTile, col } from "./ai-book";
import { ConnectCard, RunnerCard } from "./ai-settings";
import LiveUpdates from "./ai-live";

export default function AiTrader({ ai }: { ai: AiView | null }) {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const [tab, setTab] = useState<string>("overview");

  // Remember the open tab per browser (a convenience only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ai-tab");
      // Read after hydration so the server and first client render match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setTab(saved);
    } catch {
      /* storage blocked */
    }
  }, []);
  function pick(t: string) {
    setTab(t);
    try {
      localStorage.setItem("ai-tab", t);
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

  function go(mode: "manual" | "dry") {
    if (mode === "manual" && !confirm("Run the two Rules books now? They will place PAPER orders (simulated money).")) return;
    setMsg(null);
    start(async () => {
      const r = await runAiTrader(mode);
      setMsg("error" in r ? { text: r.error, err: true } : { text: r.message });
      router.refresh();
    });
  }

  const total = ai.books.reduce((a, b) => a + b.equity, 0);
  const weekCost = ai.books.reduce((a, b) => a + b.weekCostUsd, 0);
  const startTotal = ai.books.reduce((a, b) => a + b.startCash, 0);
  const sizes = Array.from(new Set(ai.books.map((b) => b.startCash)));
  const model = String(effective(RUNNER_LIMITS, ai.runner).model);
  const current = ai.books.find((b) => b.key === tab) ?? null;

  return (
    <section className="mt-3 space-y-4">
      <div className="card rounded-2xl border border-border bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-watch/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-watch ring-1 ring-inset ring-watch/30">
                Paper · simulated money
              </span>
              <LiveUpdates marketOpen={ai.marketOpen} />
            </div>
            <h2 className="mt-1.5 font-display text-xl font-semibold text-text">AI Trader</h2>
            <p className="mt-0.5 text-sm text-dim">
              {ai.books.length} paper boxes{sizes.length === 1 ? ` of ${money(sizes[0])} each` : ` (${money(startTotal)} in all)`}:
              two run by fixed rules, two by Claude {model}. Open a box&apos;s tab for its details.
            </p>
            <details className="mt-1.5 text-xs text-dim">
              <summary className="cursor-pointer select-none text-faint hover:text-text">How it works</summary>
              <p className="mt-1.5 max-w-prose leading-relaxed">
                <b>Rules</b> boxes are fixed code that runs on the website on weekday schedules. <b>Claude</b> boxes are
                Claude running the day-trader-skill repo on your Mac during market hours: it scans, reads the news,
                times entries and manages exits. Every limit is yours to set in each box&apos;s Limits &amp; settings.
                Open any Claude run to see every step and what Claude did with it.
              </p>
            </details>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => go("dry")}
              disabled={busy}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text disabled:opacity-60"
            >
              Dry run (rules)
            </button>
            <button
              onClick={() => go("manual")}
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Running…" : "Run rules now"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-2 border-t border-border pt-4">
          <div>
            <div className={LABEL}>Total (all books)</div>
            <div className="font-display text-2xl font-semibold text-text tnum">{money(total, 2)}</div>
          </div>
          <div className={`font-mono text-sm tnum ${col(total - startTotal)}`}>
            {moneySigned(total - startTotal, 2)} ({pct((total / startTotal - 1) * 100)}) vs {money(startTotal)}
          </div>
          <div className="ml-auto text-right font-mono text-xs text-faint tnum">
            {ai.accountEquity != null && <div>paper account equity {money(ai.accountEquity, 2)}</div>}
            <div>{ai.prices === "live" ? "live prices" : "prices as of the Mac's last Claude run"}</div>
          </div>
        </div>

        {msg && (
          <p className={`mt-3 rounded-md px-3 py-2 text-xs ${msg.err ? "bg-loss/10 text-loss" : "bg-surface2 text-dim"}`}>
            {msg.text}
          </p>
        )}
        {ai.error && <p className="mt-3 rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">{ai.error}</p>}
      </div>

      <nav className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="AI Trader boxes">
        <div className="flex min-w-max gap-1 rounded-xl border border-border bg-surface p-1">
          {[{ key: "overview", name: "Overview", isClaude: null as boolean | null, pnl: null as number | null }, ...ai.books.map((b) => ({ key: b.key as string, name: b.name, isClaude: b.key.startsWith("claude-"), pnl: b.pnl }))].map((t) => {
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
                {t.pnl != null && <span className={`font-mono text-xs tnum ${col(t.pnl)}`}>{moneySigned(t.pnl, 0)}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      {current ? (
        <BookCard key={current.key} b={current} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {ai.books.map((b) => (
              <BookTile key={b.key} b={b} onOpen={() => pick(b.key)} />
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ConnectCard connection={ai.connection} />
            <RunnerCard defs={RUNNER_LIMITS} saved={ai.runner} weekCost={weekCost} />
          </div>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-faint">
        Paper trading only — both the website and the Mac refuse non-paper keys and accounts. Rules books are fixed
        code driven by your settings; Claude books are Claude running the open-source day-trader-skill repo (MIT) with its own risk checks. Not
        investment advice; past or simulated results don&apos;t predict future returns.
      </p>
    </section>
  );
}
