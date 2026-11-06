"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAiTrader } from "../actions";
import { money, moneySigned, pct } from "@/lib/portfolio";
import { RUNNER_LIMITS } from "@/lib/aitrader/limits";
import type { AiView } from "@/lib/aitrader/view";
import { LABEL } from "./ai-run";
import { BookCard, col } from "./ai-book";
import { ConnectCard, RunnerCard } from "./ai-settings";

export default function AiTrader({ ai }: { ai: AiView | null }) {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();

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

  return (
    <section className="mt-3 space-y-4">
      <div className="card rounded-2xl border border-border bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-watch/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-watch ring-1 ring-inset ring-watch/30">
                Paper · simulated money
              </span>
              {ai.marketOpen != null && (
                <span className="text-xs text-dim">market {ai.marketOpen ? "open" : "closed"}</span>
              )}
            </div>
            <h2 className="mt-1.5 font-display text-xl font-semibold text-text">AI Trader</h2>
            <p className="mt-0.5 text-xs text-dim">
              Four $5,000 paper books: <b>Rules</b> (fixed code, runs on the website after the US close) next to{" "}
              <b>Claude</b> (Claude Sonnet running the day-trader-skill repo on your Mac during market hours). Open
              any Claude run to see every step: what the repo&apos;s scanner, news, entry, exit, time-machine, budget,
              risk and broker stages said, and what Claude did with it.
            </p>
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

      <div className="grid gap-4 md:grid-cols-2">
        <ConnectCard connection={ai.connection} />
        <RunnerCard defs={RUNNER_LIMITS} saved={ai.runner} weekCost={weekCost} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {ai.books.map((b) => (
          <BookCard key={b.key} b={b} />
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        Paper trading only — both the website and the Mac refuse non-paper keys and accounts. Rules books are fixed
        code; Claude books are Claude running the open-source day-trader-skill repo (MIT) with its own risk checks. Not
        investment advice; past or simulated results don&apos;t predict future returns.
      </p>
    </section>
  );
}
