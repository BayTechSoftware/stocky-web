"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAiTrader } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import type { AiBookView, AiView } from "@/lib/aitrader/view";
import type { Decision } from "@/lib/aitrader/engine";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-faint";

const BLURB: Record<AiBookView["key"], string> = {
  mylist: "Trades your watchlist. Enters on Stocky BUY / WASHOUT (score ≥ 60); exits on OVERBOUGHT or its stop / target.",
  free: "The skills' pick: breakout, bull flag, MA20 reclaim or oversold bounce across ~140 large caps in an uptrend. 21-day time stop.",
};

function col(v: number | null | undefined) {
  if (v == null || Math.abs(v) < 0.005) return "text-dim";
  return v > 0 ? "text-gain" : "text-loss";
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
    if (mode === "manual" && !confirm("Run the AI Trader now? It will place PAPER orders (simulated money).")) return;
    setMsg(null);
    start(async () => {
      const r = await runAiTrader(mode);
      setMsg("error" in r ? { text: r.error, err: true } : { text: r.message });
      router.refresh();
    });
  }

  const total = ai.books.reduce((a, b) => a + b.equity, 0);
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
              Two $5,000 books on your Alpaca paper account. Runs automatically on weekdays after the US close
              (5:30 pm ET). Entries are bracket orders that risk 1% of the book.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => go("dry")}
              disabled={busy}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text disabled:opacity-60"
            >
              Dry run
            </button>
            <button
              onClick={() => go("manual")}
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Running…" : "Run now"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-2 border-t border-border pt-4">
          <div>
            <div className={LABEL}>Total (both books)</div>
            <div className="font-display text-2xl font-semibold text-text tnum">{money(total, 2)}</div>
          </div>
          <div className={`font-mono text-sm tnum ${col(total - startTotal)}`}>
            {moneySigned(total - startTotal, 2)} ({pct((total / startTotal - 1) * 100)}) vs {money(startTotal)}
          </div>
          {ai.accountEquity != null && (
            <div className="ml-auto text-right font-mono text-xs text-faint tnum">
              paper account equity {money(ai.accountEquity, 2)}
            </div>
          )}
        </div>

        {msg && (
          <p className={`mt-3 rounded-md px-3 py-2 text-xs ${msg.err ? "bg-loss/10 text-loss" : "bg-surface2 text-dim"}`}>
            {msg.text}
          </p>
        )}
        {ai.error && <p className="mt-3 rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">{ai.error}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {ai.books.map((b) => (
          <BookCard key={b.key} b={b} />
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        Paper trading only — the server refuses non-paper keys and accounts. Rules are fixed and deterministic (no
        model in the loop), inspired by the open-source Trader skill. Not investment advice; past or simulated results
        don&apos;t predict future returns.
      </p>
    </section>
  );
}

function BookCard({ b }: { b: AiBookView }) {
  const run = b.lastRun;
  const decisions: Decision[] = run?.summary?.decisions ?? [];
  return (
    <div className="card overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-display text-lg font-semibold text-text">{b.name}</div>
            <p className="mt-0.5 text-xs text-dim">{BLURB[b.key]}</p>
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
              {b.closedTrades ? `${Math.round((b.wins / b.closedTrades) * 100)}% of ${b.closedTrades}` : "—"}
            </dd>
          </dl>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div className={`mb-1 ${LABEL}`}>Positions ({b.positions.length})</div>
          {b.positions.length === 0 ? (
            <p className="text-sm text-dim">No positions yet.</p>
          ) : (
            b.positions.map((p) => (
              <div key={p.symbol} className="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0">
                <div className="min-w-0">
                  <div className="font-display font-semibold text-text">{p.symbol}</div>
                  <div className="font-mono text-xs text-faint tnum">
                    {shares(p.qty)} @ ${fprice(p.avgCost)}
                    {p.stop != null && ` · stop ${fprice(p.stop)}`}
                    {p.target != null && ` · target ${fprice(p.target)}`}
                  </div>
                  {p.reason && <div className="truncate text-[11px] text-dim">{p.reason}</div>}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm text-text tnum">{p.price != null ? `$${fprice(p.price)}` : "—"}</div>
                  <div className={`font-mono text-xs tnum ${col(p.pnl)}`}>
                    {moneySigned(p.pnl, 2)} · {pct(p.pnlPct)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {b.pending.length > 0 && (
          <div>
            <div className={`mb-1 ${LABEL}`}>Working orders ({b.pending.length})</div>
            {b.pending.map((o, i) => (
              <div key={i} className="border-t border-border py-1.5 font-mono text-xs text-dim tnum first:border-t-0">
                <span className={o.side === "buy" ? "text-gain" : "text-loss"}>{o.side.toUpperCase()}</span>{" "}
                <span className="font-semibold text-text">{shares(o.qty)} {o.symbol}</span>
                {o.limit != null && ` limit $${fprice(o.limit)}`}
                {o.stop != null && ` · stop ${fprice(o.stop)}`}
                {o.target != null && ` · target ${fprice(o.target)}`}
                <span className="text-faint"> · {o.kind === "entry" ? "waiting to fill" : "exit queued"}</span>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-border bg-surface2/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className={LABEL}>Last run</span>
            <span className="font-mono text-xs text-dim">{run ? `${when(run.ran_at)} · ${run.mode}` : "not run yet"}</span>
          </div>
          {run?.mode === "dry" && (
            <p className="mt-1 text-[11px] text-watch">Dry run — these decisions were computed, nothing was placed.</p>
          )}
          {run?.error && <p className="mt-2 text-xs text-loss">{run.error}</p>}
          {run?.summary?.halted && <p className="mt-2 text-xs text-watch">{run.summary.halted}</p>}
          {run?.summary?.note && <p className="mt-2 text-xs text-dim">{run.summary.note}</p>}
          {decisions.length > 0 && (
            <ul className="mt-2 space-y-1">
              {decisions.slice(0, 10).map((d, i) => (
                <li key={i} className="flex gap-2 text-xs">
                  <ActionPill a={d.action} />
                  <span className="min-w-0">
                    <span className="font-semibold text-text">{d.symbol}</span>
                    {d.qty != null && d.price != null && (
                      <span className="font-mono text-dim tnum"> {shares(d.qty)} @ ${fprice(d.price)}</span>
                    )}
                    {d.stop != null && d.target != null && (
                      <span className="font-mono text-faint tnum">
                        {" "}
                        (stop {fprice(d.stop)} / target {fprice(d.target)})
                      </span>
                    )}
                    <span className="text-dim"> — {d.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionPill({ a }: { a: Decision["action"] }) {
  const cls =
    a === "buy"
      ? "bg-gain/10 text-gain"
      : a === "sell"
        ? "bg-loss/10 text-loss"
        : a === "cancel"
          ? "bg-watch/10 text-watch"
          : "bg-black/5 text-faint";
  return (
    <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {a}
    </span>
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
