"use client";

import { useMemo, useState, useTransition } from "react";
import { runBacktest } from "../actions";
import { money, moneySigned, pct, price as fprice, shares } from "@/lib/portfolio";
import { DEFAULT_PERIOD, PERIODS, type BacktestResult, type BacktestTrade, type Period } from "@/lib/aitrader/backtest";
import { LABEL, col } from "./ai-run";

type Outcome = { result: BacktestResult; period: Period; source: "saved" | "form" } | { error: string };

const PERIOD_LABEL: Record<Period, string> = { "1M": "1 month", "3M": "3 months", "6M": "6 months", "1Y": "1 year", "2Y": "2 years" };

const day = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className={`font-mono text-sm font-semibold tnum ${tone ?? "text-text"}`}>{value}</div>
      {sub && <div className="font-mono text-[10px] text-faint tnum">{sub}</div>}
    </div>
  );
}

/** Equity curve with the SPY buy-and-hold line (same starting cash); hover for a day's values. */
function EquityChart({ r }: { r: BacktestResult }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = r.equity;
  if (pts.length < 2) return null;
  const W = 600;
  const H = 160;
  const ys = pts.flatMap((p) => (p.spy != null ? [p.equity, p.spy] : [p.equity]));
  const lo = Math.min(...ys, r.startCash);
  const hi = Math.max(...ys, r.startCash);
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => (hi === lo ? H / 2 : H - ((v - lo) / (hi - lo)) * (H - 8) - 4);
  const line = (vals: (number | null)[]) =>
    vals.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const h = hover != null ? pts[hover] : null;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-dim">
          <span className="h-0.5 w-4 bg-accent" /> this box
        </span>
        <span className="flex items-center gap-1.5 text-dim">
          <span className="h-0 w-4 border-t border-dashed border-washout" /> SPY buy &amp; hold
        </span>
        <span className="ml-auto font-mono text-faint tnum">
          {h ? (
            <>
              {day(h.date)} · <span className="text-text">{money(h.equity, 2)}</span>
              {h.spy != null && <> · SPY {money(h.spy, 2)}</>}
            </>
          ) : (
            "hover for a day"
          )}
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-40 w-full"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - b.left) / b.width) * (pts.length - 1));
            setHover(Math.max(0, Math.min(pts.length - 1, i)));
          }}
          role="img"
          aria-label={`Equity from ${money(r.startCash)} to ${money(r.endEquity, 2)}`}
        >
          <line x1={0} x2={W} y1={y(r.startCash)} y2={y(r.startCash)} className="text-border" stroke="currentColor" vectorEffect="non-scaling-stroke" />
          <polyline
            points={line(pts.map((p) => p.spy))}
            fill="none"
            stroke="currentColor"
            strokeDasharray="4 3"
            strokeWidth={1.25}
            className="text-washout"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line(pts.map((p) => p.equity))}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinejoin="round"
            className="text-accent"
            vectorEffect="non-scaling-stroke"
          />
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="currentColor" className="text-faint" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <span className="pointer-events-none absolute left-1 top-0 font-mono text-[10px] text-faint tnum">{money(hi)}</span>
        <span className="pointer-events-none absolute bottom-0 left-1 font-mono text-[10px] text-faint tnum">{money(lo)}</span>
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-faint tnum">
        <span>{day(r.start)}</span>
        <span>{day(r.end)}</span>
      </div>
    </div>
  );
}

type SortKey = "symbol" | "entryDate" | "exitDate" | "pnl" | "pnlPct" | "qty";

function SortTh({
  k,
  label,
  right,
  sort,
  onSort,
}: {
  k: SortKey;
  label: string;
  right?: boolean;
  sort: { k: SortKey; desc: boolean };
  onSort: (k: SortKey) => void;
}) {
  return (
    <th className={`px-2 py-1.5 font-semibold ${right ? "text-right" : "text-left"}`} aria-sort={sort.k === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button onClick={() => onSort(k)} className={`uppercase tracking-wider hover:text-text ${sort.k === k ? "text-text" : ""}`}>
        {label}
        {sort.k === k ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "exitDate", desc: true });
  const rows = useMemo(() => {
    const out = trades.slice();
    out.sort((a, b) => {
      const va = a[sort.k];
      const vb = b[sort.k];
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.desc ? -c : c;
    });
    return out;
  }, [trades, sort]);
  if (!trades.length) return <p className="text-xs text-dim">No trades in this period.</p>;
  const th = (k: SortKey, label: string, right?: boolean) => (
    <SortTh k={k} label={label} right={right} sort={sort} onSort={(k) => setSort((s) => ({ k, desc: s.k === k ? !s.desc : true }))} />
  );
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-xs">
        <thead className="sticky top-0 bg-surface2 text-[10px] text-faint">
          <tr>
            {th("symbol", "Symbol")}
            {th("entryDate", "In")}
            {th("exitDate", "Out")}
            {th("qty", "Qty", true)}
            {th("pnl", "P&L", true)}
            {th("pnlPct", "%", true)}
            <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wider">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((t, i) => (
            <tr key={i} className={t.open ? "bg-surface2/40" : ""}>
              <td className="px-2 py-1.5 font-semibold text-text">{t.symbol}</td>
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-dim tnum">
                {day(t.entryDate)} <span className="text-faint">${fprice(t.entry)}</span>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-dim tnum">
                {t.open ? "open" : day(t.exitDate)} <span className="text-faint">${fprice(t.exit)}</span>
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-dim tnum">{shares(t.qty)}</td>
              <td className={`px-2 py-1.5 text-right font-mono tnum ${col(t.pnl)}`}>{moneySigned(t.pnl, 2)}</td>
              <td className={`px-2 py-1.5 text-right font-mono tnum ${col(t.pnlPct)}`}>{pct(t.pnlPct, 1)}</td>
              <td className="px-2 py-1.5 text-dim">
                <span className="text-text">{t.why}</span>
                <span className="block text-[10px] text-faint">{t.setup}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Results({ out }: { out: Exclude<Outcome, { error: string }> }) {
  const r = out.result;
  const vsSpy = r.buyHoldSpyPct != null ? r.returnPct - r.buyHoldSpyPct : null;
  const open = r.tradesList.filter((t) => t.open).length;
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] text-dim tnum">
        {day(r.start)} – {day(r.end)} · {r.days} trading days · {out.source === "form" ? "current form values" : "saved settings"} ·{" "}
        {money(r.startCash)} start
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Return" value={pct(r.returnPct)} sub={money(r.endEquity, 2)} tone={col(r.returnPct)} />
        <Tile
          label="SPY buy & hold"
          value={pct(r.buyHoldSpyPct)}
          sub={vsSpy != null ? `${vsSpy >= 0 ? "beat" : "lagged"} by ${Math.abs(vsSpy).toFixed(2)} pts` : undefined}
        />
        <Tile label="Max drawdown" value={r.maxDrawdownPct > 0 ? `−${r.maxDrawdownPct.toFixed(2)}%` : "0%"} tone={r.maxDrawdownPct > 0 ? "text-loss" : undefined} />
        <Tile
          label="Trades"
          value={String(r.trades)}
          sub={`${r.winRatePct != null ? `${Math.round(r.winRatePct)}% won · ` : ""}${r.wins}W ${r.losses}L${open ? ` · ${open} open` : ""}`}
        />
        <Tile label="Avg win" value={pct(r.avgWinPct)} tone="text-gain" />
        <Tile label="Avg loss" value={pct(r.avgLossPct)} tone="text-loss" />
        <Tile label="Profit factor" value={r.profitFactor != null ? r.profitFactor.toFixed(2) : r.wins ? "no losses" : "—"} />
        <Tile label="Exposure" value={`${r.exposurePct.toFixed(0)}%`} sub="avg of equity invested" />
      </div>
      {(r.haltedDays > 0 || r.expiredEntries > 0 || r.missing.length > 0) && (
        <p className="text-[11px] text-dim">
          {r.haltedDays > 0 && `Stopped buying after a bad day on ${r.haltedDays} day${r.haltedDays > 1 ? "s" : ""}. `}
          {r.expiredEntries > 0 && `${r.expiredEntries} entr${r.expiredEntries > 1 ? "ies" : "y"} expired unfilled. `}
          {r.missing.length > 0 && `No data for ${r.missing.slice(0, 8).join(", ")}${r.missing.length > 8 ? "…" : ""}.`}
        </p>
      )}
      <EquityChart r={r} />
      <div>
        <div className={`mb-1 ${LABEL}`}>Trades ({r.tradesList.length})</div>
        <TradesTable trades={r.tradesList} />
      </div>
    </div>
  );
}

/** Backtest of a Rules box over daily bars. `getValues` = the settings form's current (unsaved) values. */
export function BacktestPanel({ bookKey, getValues }: { bookKey: string; getValues?: () => Record<string, string> }) {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [out, setOut] = useState<Outcome | null>(null);
  const [busy, start] = useTransition();
  function go(useForm: boolean) {
    const values = useForm && getValues ? { ...getValues() } : undefined;
    start(async () => {
      try {
        setOut(await runBacktest(bookKey, period, values));
      } catch (e) {
        setOut({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  }
  return (
    <details open className="rounded-lg border border-border">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2">
        <span className={LABEL}>Backtest</span>
        <span className="text-[11px] text-faint">replay these rules on past daily bars · free</span>
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-dim">
            Period
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              disabled={busy}
              className="cursor-pointer bg-transparent font-mono text-text outline-none"
            >
              {(Object.keys(PERIODS) as Period[]).map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => go(false)}
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Running…" : "Run backtest"}
          </button>
          {getValues && (
          <button
            onClick={() => go(true)}
            disabled={busy}
            title="Uses the values currently in this box's settings, saved or not"
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text disabled:opacity-60"
          >
            Try current form values
          </button>
          )}
        </div>
        {out && "error" in out && <p className="rounded-md bg-loss/10 px-3 py-2 text-xs text-loss">{out.error}</p>}
        {out && "result" in out && <Results out={out} />}
        <p className="text-[10.5px] leading-relaxed text-faint">
          Simulated on daily bars (Alpaca IEX feed, split-adjusted) with the live engine&apos;s own rules — not real
          fills. One decision run per day after the close (the live box also runs mid-morning); entries fill next
          day at the open or the limit; when a bar touches both stop and target the stop is assumed first; a gap
          through a stop fills at the open; legs don&apos;t trigger on the fill day itself. My List signals are
          recomputed from these bars for your current list (so names you added later are in the past too). Whole
          shares, no commissions, no slippage beyond the limit. Past results — simulated ones especially — don&apos;t
          predict future returns.
        </p>
      </div>
    </details>
  );
}
