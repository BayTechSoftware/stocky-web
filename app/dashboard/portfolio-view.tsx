"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addTicker,
  addLot,
  removeLot,
  setAlerts,
  removeSymbol,
  refreshSignals,
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
  week52_high: number | null;
  week52_low: number | null;
  ret_1y: number | null;
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
  const m = SIGMETA[sig.assessment] ?? { fg: "text-dim", chip: "bg-black/5 text-dim ring-black/10" };
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

/* ---- detail helpers ---- */
const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-faint";

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** A labeled stat tile. `tone` (a signed number) colors the value gain/loss; omit for neutral. */
function Tile({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className={LABEL}>{label}</div>
      <div className={`mt-0.5 font-mono text-sm tnum ${tone === undefined ? "text-text" : col(tone)}`}>
        {children}
      </div>
    </div>
  );
}

/** Horizontal range track with a marker at `cur` between `low` and `high`. */
function RangeBar({ low, cur, high }: { low: number; cur: number; high: number }) {
  const p = high > low ? Math.max(0, Math.min(100, ((cur - low) / (high - low)) * 100)) : 50;
  return (
    <div className="relative mt-1.5 h-1.5 rounded-full bg-black/10">
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text ring-2 ring-surface"
        style={{ left: `${p}%` }}
      />
    </div>
  );
}

type ZonePos = "below" | "in" | "above" | null;
function signalRead(sig: Sig, zonePos: ZonePos, rsiLabel: string): string {
  const base: Record<string, string> = {
    BUY: "Trading inside its value zone — a reasonable entry here.",
    WASHOUT: "Sold off below the zone and oversold — deep-value, but possibly a falling knife.",
    WATCH: "Not in the buy zone yet — wait for a better level.",
    OVERBOUGHT: "Extended above the zone / overbought — expensive at this price.",
  };
  const z = zonePos ? ` It's ${zonePos === "in" ? "in" : zonePos} the buy zone.` : "";
  return (base[sig.assessment ?? ""] ?? "") + (rsiLabel ? ` RSI reads ${rsiLabel}.` : "") + z;
}

/* ---- the expandable detail (shared by both tabs) ---- */
function Detail({ r }: { r: Row }) {
  const lots = (r.lots ?? []) as Lot[];
  const sig = r.sig;
  const st = holdingStats(r.lots, sig?.price ?? null, sig?.prev_close ?? null);
  const held = lots.length > 0;

  const price = sig?.price ?? null;
  const pc = sig?.prev_close ?? null;
  const hi = sig?.week52_high ?? null;
  const lo = sig?.week52_low ?? null;
  const zl = sig?.zone_low ?? null;
  const zh = sig?.zone_high ?? null;
  const rsiVal = sig?.rsi ?? null;

  const pctFromHigh = price != null && hi ? ((price - hi) / hi) * 100 : null;
  const maD50 = price != null && sig?.ma50 ? (price / sig.ma50 - 1) * 100 : null;
  const maD200 = price != null && sig?.ma200 ? (price / sig.ma200 - 1) * 100 : null;
  const zonePos: ZonePos =
    price != null && zl != null && zh != null ? (price < zl ? "below" : price > zh ? "above" : "in") : null;
  const rsiLabel = rsiVal == null ? "" : rsiVal <= 38 ? "oversold" : rsiVal >= 70 ? "overbought" : "neutral";
  const rsiTone = rsiVal == null ? null : rsiVal <= 38 ? 1 : rsiVal >= 70 ? -1 : 0;

  return (
    <div className="border-t border-border bg-surface2/40 px-4 py-5 md:px-6">
      {/* ---- price + today + freshness ---- */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className={LABEL}>Current price</div>
          <div className="mt-0.5 font-display text-3xl font-semibold text-text tnum">
            {price != null ? `$${fprice(price)}` : "—"}
          </div>
          {price != null && pc != null && (
            <div className={`font-mono text-sm tnum ${col(st.dayPct)}`}>
              {held ? `${moneySigned(st.dayChange)} ` : ""}
              {held ? "(" : ""}
              {pct(st.dayPct)}
              {held ? ")" : ""} today
            </div>
          )}
        </div>
        <div className="text-right font-mono text-xs text-dim tnum">
          {pc != null && <div>prev close ${fprice(pc)}</div>}
          <div>updated {fmtAgo(sig?.updated_at ?? null)}</div>
        </div>
      </div>

      {/* ---- 52-week range ---- */}
      {price != null && lo != null && hi != null && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <span className={LABEL}>52-week range</span>
            {pctFromHigh != null && (
              <span className="font-mono text-xs text-dim tnum">{pct(pctFromHigh)} from high</span>
            )}
          </div>
          <RangeBar low={lo} cur={price} high={hi} />
          <div className="mt-1 flex justify-between font-mono text-xs text-dim tnum">
            <span>${fprice(lo)}</span>
            <span>${fprice(hi)}</span>
          </div>
        </div>
      )}

      {/* ---- signal read + score ---- */}
      {sig?.assessment ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SignalChip sig={sig} withScore={false} />
            {sig.score != null && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-black/10">
                  <div className="h-full rounded-full bg-text" style={{ width: `${sig.score}%` }} />
                </div>
                <span className="font-mono text-xs text-dim tnum">{sig.score}/100</span>
              </div>
            )}
          </div>
          <p className="mt-2 text-sm text-dim">{signalRead(sig, zonePos, rsiLabel)}</p>
        </div>
      ) : (
        <p className="mt-5 text-sm text-dim">No signal yet — hit ↻ Refresh or wait for the daily update.</p>
      )}

      {/* ---- technicals ---- */}
      <div className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tile label="RSI (14)" tone={rsiTone}>
          {rsiVal != null ? `${Math.round(rsiVal)} · ${rsiLabel}` : "—"}
        </Tile>
        <Tile label="vs 50-day" tone={maD50}>{maD50 != null ? pct(maD50) : "—"}</Tile>
        <Tile label="vs 200-day" tone={maD200}>{maD200 != null ? pct(maD200) : "—"}</Tile>
        <Tile label="1-yr return" tone={sig?.ret_1y ?? null}>
          {sig?.ret_1y != null ? pct(sig.ret_1y) : "—"}
        </Tile>
      </div>

      {/* ---- buy zone ---- */}
      {zl != null && zh != null && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
          <div>
            <div className={LABEL}>Buy zone</div>
            <div className="mt-0.5 font-mono text-sm text-text tnum">
              ${fprice(zl)} – ${fprice(zh)}
            </div>
          </div>
          <span className="font-mono text-xs text-dim">
            {zonePos === "in" ? "✓ in zone" : zonePos === "below" ? "below zone" : zonePos === "above" ? "above zone" : "—"}
          </span>
        </div>
      )}

      {/* ---- position (held only) ---- */}
      {held && (
        <div className="mt-5 border-t border-border pt-4">
          <div className={`mb-2 ${LABEL}`}>Your position</div>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label="Shares">{shares(st.qty)}</Tile>
            <Tile label="Avg cost">${fprice(st.avgCost)}</Tile>
            <Tile label="Cost basis">{money(st.costBasis)}</Tile>
            <Tile label="Market value">{money(st.value)}</Tile>
            <Tile label="Unrealized P&amp;L" tone={st.pnl}>{moneySigned(st.pnl)}</Tile>
            <Tile label="Return" tone={st.pnlPct}>{pct(st.pnlPct)}</Tile>
            <Tile label="Day change" tone={st.dayChange}>{moneySigned(st.dayChange)}</Tile>
          </div>
        </div>
      )}

      {/* ---- buys + alerts editors ---- */}
      <div className="mt-5 grid gap-5 border-t border-border pt-4 md:grid-cols-2">
        <div>
          <div className={`mb-2 ${LABEL}`}>Buys</div>
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

        <div>
          <div className={`mb-2 ${LABEL}`}>Price alerts</div>
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
          <form action={removeSymbol} className="mt-4">
            <input type="hidden" name="symbol" value={r.symbol} />
            <button className="text-xs text-faint hover:text-loss">Remove {r.symbol} ✕</button>
          </form>
        </div>
      </div>
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
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();

  function doRefresh() {
    setRefreshMsg(null);
    startRefresh(async () => {
      const r = await refreshSignals();
      if ("error" in r) {
        setRefreshMsg(r.error);
      } else if (r.total === 0) {
        setRefreshMsg("Nothing to refresh yet.");
      } else {
        const more = r.total > r.refreshed ? ` · ${r.total - r.refreshed} more — click again` : "";
        setRefreshMsg(`Refreshed ${r.updated}/${r.refreshed}${more}`);
      }
      router.refresh(); // pull the recomputed signals into the view
      setTimeout(() => setRefreshMsg(null), 6000);
    });
  }

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
            <span className="relative mt-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gain/50" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-gain" />
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold leading-none tracking-tight text-text sm:text-3xl">Stocky</h1>
              <p className="mt-1 truncate text-xs text-dim">{email}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={doRefresh}
              disabled={refreshing}
              title="Recompute signals for your watchlist (stalest first)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text disabled:opacity-60"
            >
              <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <form action={signOut}>
              <button className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-dim hover:bg-surface2 hover:text-text">
                Sign out
              </button>
            </form>
          </div>
        </div>
        {refreshMsg && <p className="mt-2 text-right text-xs text-dim">{refreshMsg}</p>}

        <div className="mt-6 border-b border-border pb-6 md:mt-7 md:pb-7">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
            Portfolio value
          </div>
          <div className="mt-1 font-display text-4xl font-semibold tracking-tight text-text tnum sm:text-5xl md:text-6xl">
            {money(totals.value)}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 md:flex md:flex-wrap md:items-end md:gap-x-10">
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
              <div className="mt-1 font-display text-xl font-semibold text-text tnum md:text-2xl">{totals.count}</div>
            </div>
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
        <section className="card mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
          <RowHead
            tmpl="md:grid-cols-[1.1fr_1.3fr_1fr_1fr_1.1fr_1.4fr]"
            cols={["Symbol", "Shares · Cost", "Price", "Mkt value", "P&L", "Signal"]}
          />
          {holdings.length === 0 && (
            <Empty>No positions yet. Add a buy from the Watchlist tab.</Empty>
          )}
          {holdings.map(({ r, st }) => (
            <div key={r.symbol} className="border-t border-border first:border-t-0">
              {/* mobile card */}
              <button
                onClick={() => toggle(r.symbol)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface2/40 md:hidden"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-faint transition ${open === r.symbol ? "rotate-90" : ""}`}>▸</span>
                    <span className="font-display text-base font-semibold text-text">{r.symbol}</span>
                  </div>
                  <div className="mt-1.5">
                    <SignalChip sig={r.sig} />
                  </div>
                  <div className="mt-1.5 font-mono text-xs text-faint tnum">
                    {shares(st.qty)} @ ${fprice(st.avgCost)}
                  </div>
                </div>
                <div className="shrink-0 space-y-0.5 text-right">
                  <div className="font-mono text-sm font-medium text-text tnum">
                    ${r.sig?.price != null ? fprice(r.sig.price) : "—"}
                  </div>
                  <div className={`font-mono text-xs tnum ${col(st.dayPct)}`}>{pct(st.dayPct)} today</div>
                  <div className={`font-mono text-xs tnum ${col(st.pnl)}`}>
                    {money(st.value)} · {pct(st.pnlPct)}
                  </div>
                </div>
              </button>
              {/* desktop grid */}
              <button
                onClick={() => toggle(r.symbol)}
                className="hidden w-full grid-cols-[1.1fr_1.3fr_1fr_1fr_1.1fr_1.4fr] items-center gap-2 px-6 py-3.5 text-left hover:bg-surface2/40 md:grid"
              >
                <Sym symbol={r.symbol} open={open === r.symbol} />
                <Cell>
                  <span className="font-mono text-sm text-text tnum">{shares(st.qty)}</span>
                  <span className="ml-1 font-mono text-xs text-faint tnum">@ ${fprice(st.avgCost)}</span>
                </Cell>
                <Cell>
                  <div className="font-mono text-sm text-text tnum">
                    {r.sig?.price != null ? `$${fprice(r.sig.price)}` : "—"}
                  </div>
                  <div className={`font-mono text-xs tnum ${col(st.dayPct)}`}>{pct(st.dayPct)}</div>
                </Cell>
                <Cell>
                  <span className="font-mono text-sm text-text tnum">{money(st.value)}</span>
                </Cell>
                <Cell>
                  <div className={`font-mono text-sm tnum ${col(st.pnl)}`}>{moneySigned(st.pnl)}</div>
                  <div className={`font-mono text-xs tnum ${col(st.pnlPct)}`}>{pct(st.pnlPct)}</div>
                </Cell>
                <Cell>
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

          <div className="card overflow-hidden rounded-2xl border border-border bg-surface">
            <RowHead
              tmpl="md:grid-cols-[1.1fr_1fr_1.5fr_0.7fr_1.3fr_1fr]"
              cols={["Symbol", "Price", "Signal", "RSI", "Buy zone", "Position"]}
            />
            {watchRows.length === 0 && <Empty>Nothing here yet.</Empty>}
            {watchRows.map(({ r, st, held }) => (
              <div key={r.symbol} className="border-t border-border first:border-t-0">
                {/* mobile card */}
                <button
                  onClick={() => toggle(r.symbol)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface2/40 md:hidden"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-faint transition ${open === r.symbol ? "rotate-90" : ""}`}>▸</span>
                      <span className="font-display text-base font-semibold text-text">{r.symbol}</span>
                    </div>
                    <div className="mt-1.5">
                      <SignalChip sig={r.sig} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm text-text tnum">
                      {r.sig?.price != null ? `$${fprice(r.sig.price)}` : "—"}
                    </div>
                    <div className={`font-mono text-xs tnum ${col(st.dayPct)}`}>{pct(st.dayPct)}</div>
                    <div className="mt-0.5 font-mono text-xs text-dim tnum">
                      {held ? `${shares(st.qty)} sh` : "watch"}
                      {r.sig?.rsi != null ? ` · RSI ${Math.round(r.sig.rsi)}` : ""}
                    </div>
                  </div>
                </button>
                {/* desktop grid */}
                <button
                  onClick={() => toggle(r.symbol)}
                  className="hidden w-full grid-cols-[1.1fr_1fr_1.5fr_0.7fr_1.3fr_1fr] items-center gap-2 px-6 py-3.5 text-left hover:bg-surface2/40 md:grid"
                >
                  <Sym symbol={r.symbol} open={open === r.symbol} />
                  <Cell>
                    <div className="font-mono text-sm text-text tnum">
                      {r.sig?.price != null ? `$${fprice(r.sig.price)}` : "—"}
                    </div>
                    <div className={`font-mono text-xs tnum ${col(st.dayPct)}`}>{pct(st.dayPct)}</div>
                  </Cell>
                  <Cell>
                    <SignalChip sig={r.sig} />
                  </Cell>
                  <Cell>
                    <span className="font-mono text-sm text-dim tnum">
                      {r.sig?.rsi != null ? Math.round(r.sig.rsi) : "—"}
                    </span>
                  </Cell>
                  <Cell>
                    <span className="font-mono text-xs text-dim tnum">
                      {r.sig?.zone_low != null && r.sig?.zone_high != null
                        ? `$${fprice(r.sig.zone_low)}–$${fprice(r.sig.zone_high)}`
                        : "—"}
                    </span>
                  </Cell>
                  <Cell>
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
      <div className={`mt-1 font-display text-xl font-semibold tnum md:text-2xl ${col(tone)}`}>{main}</div>
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
