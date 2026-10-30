"use client";

import { useMemo, useState } from "react";
import {
  addTicker,
  addLot,
  removeLot,
  setAlerts,
  removeSymbol,
  signOut,
} from "../actions";
import {
  holdingStats,
  aggregate,
  money,
  moneySigned,
  pct,
  shares,
  price as fprice,
  type Lot,
} from "@/lib/portfolio";
import DevicePairing, { type DeviceToken } from "./device-pairing";

export interface Sig {
  price: number | null;
  prev_close: number | null;
  rsi: number | null;
  ma50: number | null;
  ma200: number | null;
  trend_up: boolean | null;
  zone_low: number | null;
  zone_high: number | null;
  assessment: string | null;
  tag: string | null;
  score: number | null;
  updated_at: string | null;
}
export interface Row {
  symbol: string;
  lots: Lot[] | null;
  watch_only: boolean;
  alert_above: number | null;
  alert_below: number | null;
  sig: Sig | null;
}

/* ---- signal styling ---- */
const SIGMETA: Record<string, { fg: string; chip: string }> = {
  BUY: { fg: "text-buy", chip: "bg-buy/10 text-buy ring-buy/30" },
  WASHOUT: { fg: "text-washout", chip: "bg-washout/10 text-washout ring-washout/30" },
  WATCH: { fg: "text-watch", chip: "bg-watch/10 text-watch ring-watch/30" },
  OVERBOUGHT: { fg: "text-overbought", chip: "bg-overbought/10 text-overbought ring-overbought/30" },
};
const FILTERS = ["ALL", "BUY", "WASHOUT", "WATCH", "OVERBOUGHT"] as const;

function col(v: number | null | undefined) {
  if (v == null) return "text-dim";
  return v > 0 ? "text-gain" : v < 0 ? "text-loss" : "text-dim";
}

function SignalChip({ sig, withScore = true }: { sig: Sig | null; withScore?: boolean }) {
  if (!sig?.assessment)
    return <span className="text-xs text-faint">awaiting</span>;
  const m = SIGMETA[sig.assessment] ?? { fg: "text-dim", chip: "bg-white/5 text-dim ring-white/10" };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${m.chip}`}
      >
        {sig.assessment}
        {sig.tag ? <span className="ml-1 opacity-70">· {sig.tag}</span> : null}
      </span>
      {withScore && sig.score != null && (
        <span className="font-mono text-xs text-dim tnum">{sig.score}</span>
      )}
    </span>
  );
}

/* ---- the expandable detail (shared by both tabs) ---- */
function Detail({ r }: { r: Row }) {
  const lots = (r.lots ?? []) as Lot[];
  const sig = r.sig;
  return (
    <div className="grid gap-5 border-t border-border bg-bg/40 px-4 py-4 md:grid-cols-3 md:px-6">
      {/* lots / buys */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          Buys
        </div>
        {lots.length === 0 && <div className="text-sm text-dim">Watch-only — no position.</div>}
        <ul className="space-y-1">
          {lots.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-mono tnum text-text">
                {shares(l.qty)} <span className="text-faint">@</span> ${fprice(l.price)}
              </span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs text-dim tnum">
                  {l.date ? new Date(l.date * 1000).toLocaleDateString() : "—"}
                </span>
                <form action={removeLot}>
                  <input type="hidden" name="symbol" value={r.symbol} />
                  <input type="hidden" name="index" value={i} />
                  <button className="text-faint hover:text-loss" title="Remove buy" aria-label="Remove buy">
                    ✕
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ul>
        {/* add a buy */}
        <form action={addLot} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="symbol" value={r.symbol} />
          <label className="flex flex-col text-[10px] uppercase tracking-wide text-faint">
            Qty
            <input
              name="qty"
              type="number"
              step="any"
              required
              placeholder="0"
              className="mt-0.5 w-20 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text tnum outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col text-[10px] uppercase tracking-wide text-faint">
            Price
            <input
              name="price"
              type="number"
              step="any"
              required
              placeholder="0.00"
              className="mt-0.5 w-24 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text tnum outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col text-[10px] uppercase tracking-wide text-faint">
            Date
            <input
              name="date"
              type="date"
              className="mt-0.5 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110">
            + Add buy
          </button>
        </form>
      </div>

      {/* alerts */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          Price alerts
        </div>
        <form action={setAlerts} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="symbol" value={r.symbol} />
          <label className="flex flex-col text-[10px] uppercase tracking-wide text-faint">
            Below
            <input
              name="below"
              type="number"
              step="any"
              defaultValue={r.alert_below ?? ""}
              placeholder="—"
              className="mt-0.5 w-24 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text tnum outline-none focus:border-washout"
            />
          </label>
          <label className="flex flex-col text-[10px] uppercase tracking-wide text-faint">
            Above
            <input
              name="above"
              type="number"
              step="any"
              defaultValue={r.alert_above ?? ""}
              placeholder="—"
              className="mt-0.5 w-24 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text tnum outline-none focus:border-overbought"
            />
          </label>
          <button className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface2">
            Save
          </button>
        </form>
      </div>

      {/* signal detail */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          Signal
        </div>
        {sig?.assessment ? (
          <dl className="space-y-1 text-sm">
            <Stat k="Buy zone">
              {sig.zone_low != null && sig.zone_high != null
                ? `$${fprice(sig.zone_low)} – $${fprice(sig.zone_high)}`
                : "—"}
            </Stat>
            <Stat k="RSI (14)">{sig.rsi != null ? Math.round(sig.rsi) : "—"}</Stat>
            <Stat k="Trend">
              {sig.trend_up == null ? "—" : sig.trend_up ? "↑ above 200-day" : "↓ below 200-day"}
            </Stat>
            <Stat k="MA 50 / 200">
              {sig.ma50 != null && sig.ma200 != null
                ? `$${fprice(sig.ma50)} / $${fprice(sig.ma200)}`
                : "—"}
            </Stat>
          </dl>
        ) : (
          <div className="text-sm text-dim">No signal yet — refreshes daily.</div>
        )}
        <form action={removeSymbol} className="mt-4">
          <input type="hidden" name="symbol" value={r.symbol} />
          <button className="text-xs text-faint hover:text-loss">Remove {r.symbol} ✕</button>
        </form>
      </div>
    </div>
  );
}
function Stat({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-dim">{k}</dt>
      <dd className="font-mono tnum text-text">{children}</dd>
    </div>
  );
}

export default function PortfolioView({
  rows,
  email,
  devices,
}: {
  rows: Row[];
  email: string;
  devices: DeviceToken[];
}) {
  const [tab, setTab] = useState<"holdings" | "watchlist">("holdings");
  const [filter, setFilter] = useState<string>("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [showDevice, setShowDevice] = useState(false);

  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const st = holdingStats(r.lots, r.sig?.price ?? null, r.sig?.prev_close ?? null);
        const held = (r.lots?.length ?? 0) > 0;
        return { r, st, held };
      }),
    [rows]
  );

  const holdings = useMemo(
    () => enriched.filter((e) => e.held).sort((a, b) => (b.st.value ?? 0) - (a.st.value ?? 0)),
    [enriched]
  );

  const watchRows = useMemo(() => {
    const f = enriched
      .filter((e) => filter === "ALL" || e.r.sig?.assessment === filter)
      .sort((a, b) => (b.r.sig?.score ?? -1) - (a.r.sig?.score ?? -1));
    return f;
  }, [enriched, filter]);

  const totals = useMemo(() => {
    let value = 0,
      cost = 0,
      day = 0,
      priced = 0;
    for (const e of holdings) {
      if (e.st.value == null) continue;
      priced++;
      value += e.st.value;
      cost += e.st.costBasis;
      if (e.st.dayChange != null) day += e.st.dayChange;
    }
    const pnl = value - cost;
    return {
      value,
      cost,
      pnl,
      pnlPct: cost > 0 ? (pnl / cost) * 100 : null,
      day,
      dayPct: value - day > 0 ? (day / (value - day)) * 100 : null,
      priced,
      count: holdings.length,
    };
  }, [holdings]);

  const toggle = (s: string) => setOpen((o) => (o === s ? null : s));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 md:px-6">
      {/* ---------- hero ---------- */}
      <header className="pt-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="mt-0.5 h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px_2px_rgba(217,181,107,0.5)]" />
            <div>
              <h1 className="font-display text-3xl leading-none tracking-tight text-text">Stocky</h1>
              <p className="mt-1 text-xs text-dim">{email}</p>
            </div>
          </div>
          <form action={signOut}>
            <button className="rounded-lg border border-border px-3 py-1.5 text-sm text-dim hover:bg-surface hover:text-text">
              Sign out
            </button>
          </form>
        </div>

        <div className="mt-7 flex flex-wrap items-end gap-x-10 gap-y-5 border-b border-border pb-7">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
              Portfolio value
            </div>
            <div className="mt-1 font-display text-5xl tracking-tight text-text tnum md:text-6xl">
              {money(totals.value)}
            </div>
          </div>
          <HeroStat
            label="Unrealized P&amp;L"
            main={moneySigned(totals.pnl)}
            sub={pct(totals.pnlPct)}
            tone={totals.pnl}
          />
          <HeroStat
            label="Today"
            main={moneySigned(totals.day)}
            sub={pct(totals.dayPct)}
            tone={totals.day}
          />
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
              Holdings
            </div>
            <div className="mt-1 font-display text-2xl text-text tnum">{totals.count}</div>
          </div>
        </div>
      </header>

      {/* ---------- tabs ---------- */}
      <div className="sticky top-0 z-10 -mx-4 mt-6 bg-bg/80 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <div className="inline-flex rounded-xl border border-border bg-surface p-1 text-sm">
          <TabBtn active={tab === "holdings"} onClick={() => setTab("holdings")}>
            Holdings <span className="ml-1 text-faint tnum">{holdings.length}</span>
          </TabBtn>
          <TabBtn active={tab === "watchlist"} onClick={() => setTab("watchlist")}>
            Watchlist <span className="ml-1 text-faint tnum">{rows.length}</span>
          </TabBtn>
        </div>
      </div>

      {/* ---------- HOLDINGS ---------- */}
      {tab === "holdings" && (
        <section className="mt-3 overflow-hidden rounded-2xl border border-border bg-surface/60">
          <RowHead
            tmpl="md:grid-cols-[1.1fr_1.3fr_1fr_1fr_1.1fr_1.4fr]"
            cols={["Symbol", "Shares · Cost", "Price", "Mkt value", "P&L", "Signal"]}
          />
          {holdings.length === 0 && (
            <Empty>No positions yet. Add a buy from the Watchlist tab.</Empty>
          )}
          {holdings.map(({ r, st }) => (
            <div key={r.symbol} className="border-t border-border first:border-t-0">
              <button
                onClick={() => toggle(r.symbol)}
                className="grid w-full grid-cols-2 items-center gap-2 px-4 py-3.5 text-left hover:bg-surface2/40 md:grid-cols-[1.1fr_1.3fr_1fr_1fr_1.1fr_1.4fr] md:px-6"
              >
                <Sym symbol={r.symbol} open={open === r.symbol} />
                <Cell className="hidden md:block">
                  <span className="font-mono text-sm text-text tnum">{shares(st.qty)}</span>
                  <span className="ml-1 font-mono text-xs text-faint tnum">@ ${fprice(st.avgCost)}</span>
                </Cell>
                <Cell>
                  <div className="font-mono text-sm text-text tnum">
                    {r.sig?.price != null ? `$${fprice(r.sig.price)}` : "—"}
                  </div>
                  <div className={`font-mono text-xs tnum ${col(st.dayPct)}`}>{pct(st.dayPct)}</div>
                </Cell>
                <Cell className="hidden md:block">
                  <span className="font-mono text-sm text-text tnum">{money(st.value)}</span>
                </Cell>
                <Cell className="text-right md:text-left">
                  <div className={`font-mono text-sm tnum ${col(st.pnl)}`}>{moneySigned(st.pnl)}</div>
                  <div className={`font-mono text-xs tnum ${col(st.pnlPct)}`}>{pct(st.pnlPct)}</div>
                </Cell>
                <Cell className="col-span-2 mt-1 md:col-span-1 md:mt-0">
                  <SignalChip sig={r.sig} />
                </Cell>
              </button>
              {open === r.symbol && <Detail r={r} />}
            </div>
          ))}
        </section>
      )}

      {/* ---------- WATCHLIST ---------- */}
      {tab === "watchlist" && (
        <section className="mt-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  filter === f
                    ? "bg-text text-bg"
                    : "bg-surface text-dim ring-1 ring-inset ring-border hover:text-text"
                }`}
              >
                {f}
              </button>
            ))}
            <form action={addTicker} className="ml-auto flex gap-2">
              <input
                name="symbol"
                placeholder="Add ticker"
                className="w-36 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm uppercase tracking-wide text-text outline-none focus:border-accent"
              />
              <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110">
                Add
              </button>
            </form>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60">
            <RowHead
              tmpl="md:grid-cols-[1.1fr_1fr_1.5fr_0.7fr_1.3fr_1fr]"
              cols={["Symbol", "Price", "Signal", "RSI", "Buy zone", "Position"]}
            />
            {watchRows.length === 0 && <Empty>Nothing here yet.</Empty>}
            {watchRows.map(({ r, st, held }) => (
              <div key={r.symbol} className="border-t border-border first:border-t-0">
                <button
                  onClick={() => toggle(r.symbol)}
                  className="grid w-full grid-cols-2 items-center gap-2 px-4 py-3.5 text-left hover:bg-surface2/40 md:grid-cols-[1.1fr_1fr_1.5fr_0.7fr_1.3fr_1fr] md:px-6"
                >
                  <Sym symbol={r.symbol} open={open === r.symbol} />
                  <Cell>
                    <span className="font-mono text-sm text-text tnum">
                      {r.sig?.price != null ? `$${fprice(r.sig.price)}` : "—"}
                    </span>
                  </Cell>
                  <Cell className="col-span-2 md:col-span-1">
                    <SignalChip sig={r.sig} />
                  </Cell>
                  <Cell className="hidden md:block">
                    <span className="font-mono text-sm text-dim tnum">
                      {r.sig?.rsi != null ? Math.round(r.sig.rsi) : "—"}
                    </span>
                  </Cell>
                  <Cell className="hidden md:block">
                    <span className="font-mono text-xs text-dim tnum">
                      {r.sig?.zone_low != null && r.sig?.zone_high != null
                        ? `$${fprice(r.sig.zone_low)}–$${fprice(r.sig.zone_high)}`
                        : "—"}
                    </span>
                  </Cell>
                  <Cell className="text-right md:text-left">
                    {held ? (
                      <span className="font-mono text-sm text-text tnum">{shares(st.qty)} sh</span>
                    ) : (
                      <span className="text-xs text-faint">watch</span>
                    )}
                  </Cell>
                </button>
                {open === r.symbol && <Detail r={r} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------- device ---------- */}
      <div className="mt-8">
        <button
          onClick={() => setShowDevice((s) => !s)}
          className="flex items-center gap-2 text-sm text-dim hover:text-text"
        >
          <span className={`transition ${showDevice ? "rotate-90" : ""}`}>▸</span> Stocky device
        </button>
        {showDevice && <DevicePairing tokens={devices} />}
      </div>
    </div>
  );
}

/* ---- small presentational bits ---- */
function HeroStat({
  label,
  main,
  sub,
  tone,
}: {
  label: string;
  main: string;
  sub: string;
  tone: number | null;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-1 font-display text-2xl tnum ${col(tone)}`}>{main}</div>
      <div className={`font-mono text-xs tnum ${col(tone)}`}>{sub}</div>
    </div>
  );
}
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-1.5 font-medium transition ${
        active ? "bg-surface2 text-text shadow-sm" : "text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
function RowHead({ cols, tmpl }: { cols: string[]; tmpl: string }) {
  return (
    <div
      className={`hidden gap-2 border-b border-border px-6 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint md:grid ${tmpl}`}
    >
      {cols.map((c) => (
        <div key={c}>{c}</div>
      ))}
    </div>
  );
}
function Sym({ symbol, open }: { symbol: string; open: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-faint transition ${open ? "rotate-90" : ""}`}>▸</span>
      <span className="font-display text-lg text-text">{symbol}</span>
    </div>
  );
}
function Cell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-10 text-center text-sm text-dim">{children}</div>;
}
