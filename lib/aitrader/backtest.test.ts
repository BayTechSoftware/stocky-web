import { describe, expect, it } from "vitest";
import type { Bar } from "../alpaca";
import { assess } from "../signals";
import { bracket, rulesFor, sizeQty } from "./plan";
import { atr, type Candidate } from "./setups";
import { maxDrawdownPct, periodStart, runBacktest, tradeStats, type BacktestInput, type Picker } from "./backtest";
import { entrySlots, exitReason, haltReason, planEntry } from "./decide";

/** Weekdays from a Monday. */
function weekdays(n: number, from = "2024-01-01"): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const bar = (date: string, o: number, h: number, l: number, c: number): Bar => ({ t: `${date}T05:00:00Z`, o, h, l, c, v: 1000 });

/** 40 flat warm-up bars (ATR 2) then the given sim bars; returns dates + bars. */
function setup(sim: [number, number, number, number][]) {
  const dates = weekdays(40 + sim.length);
  const bars = dates.map((d, i) => (i < 40 ? bar(d, 100, 101, 99, 100) : bar(d, ...sim[i - 40])));
  return { dates, bars, start: dates[40], end: dates[dates.length - 1] };
}

const cand = (symbol: string): Candidate => ({ symbol, setups: [], score: 1, ret20: 0, rsi: null, reason: "test setup" });
/** Pick `symbol` only on `date`. */
const pickOn = (date: string, symbol = "X"): Picker => (ctx) => ({ list: ctx.date === date ? [cand(symbol)] : [], stale: [] });

const R0 = rulesFor({ max_hold_days: 0 }, "free"); // $5K, 1% risk, 2×ATR stop, 2R target, 1% slip, 1-day entries

function run(sim: [number, number, number, number][], over: Partial<BacktestInput> = {}) {
  const s = setup(sim);
  return runBacktest({
    box: "free",
    rules: R0,
    bars: { X: s.bars },
    symbols: ["X"],
    start: s.start,
    end: s.end,
    pick: pickOn(s.start),
    ...over,
  });
}

describe("backtest fills", () => {
  // Day 0 close 100, ATR 2 → limit 101, stop 96, target 111; 9 shares (20% cap).
  it("fills at the open when open ≤ limit, sized exactly like the engine", () => {
    const r = run([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100],
      [100, 101, 99.5, 100],
    ]);
    const t = r.tradesList[0];
    expect(t).toMatchObject({ symbol: "X", entry: 100, qty: 9, open: true });
    expect(r.trades).toBe(0);
  });

  it("when a bar hits both stop and target, the STOP fills first", () => {
    const r = run([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100], // fill at 100; legs re-anchored: stop 96, target 108
      [100, 112, 95, 105], // both legs in range
    ]);
    expect(r.trades).toBe(1);
    const t = r.tradesList[0];
    expect(t.exit).toBe(96);
    expect(t.why).toMatch(/stop assumed first/);
    expect(t.pnl).toBe(9 * (96 - 100));
  });

  it("a target alone fills at the re-anchored target", () => {
    const r = run([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100],
      [101, 109, 100, 108],
    ]);
    expect(r.tradesList[0]).toMatchObject({ exit: 108, why: "target" });
  });

  it("a gap through the stop fills at the open, not the stop", () => {
    const r = run([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100],
      [90, 92, 88, 91],
    ]);
    expect(r.tradesList[0]).toMatchObject({ exit: 90 });
    expect(r.tradesList[0].why).toMatch(/gapped through/);
    expect(r.endEquity).toBe(5000 + 9 * (90 - 100));
  });

  it("legs don't trigger on the fill bar itself", () => {
    const r = run([
      [100, 101, 99, 100],
      [100, 101, 95, 100], // fills at 100, low under the stop on the same bar
      [100, 101, 99.5, 100],
    ]);
    expect(r.trades).toBe(0);
    expect(r.tradesList[0].open).toBe(true);
  });

  it("open above the limit but low ≤ limit fills at the limit", () => {
    const sim: [number, number, number, number][] = [
      [100, 101, 99, 100],
      [102, 103, 100.5, 102],
      [102, 103, 101, 102],
    ];
    const r = run(sim);
    expect(r.tradesList[0]).toMatchObject({ entry: 101, entryDate: setup(sim).dates[41] });
  });
});

describe("backtest entry expiry", () => {
  const sim: [number, number, number, number][] = [
    [100, 101, 99, 100], // Mon: entry placed (limit 101)
    [103, 104, 102, 103], // Tue: no touch
    [103, 104, 102, 103], // Wed: no touch
    [102, 103, 100, 101], // Thu: touches the limit
    [101, 102, 100, 101],
  ];
  it("a 1-day entry is cancelled after one session", () => {
    const r = run(sim);
    expect(r.tradesList).toHaveLength(0);
    expect(r.expiredEntries).toBe(1);
  });
  it("a 3-day entry is still working on the 3rd session and fills there", () => {
    const r = run(sim, { rules: rulesFor({ max_hold_days: 0, entry_valid_days: 3 }, "free") });
    expect(r.tradesList[0]).toMatchObject({ entry: 101, entryDate: setup(sim).dates[43] });
    expect(r.expiredEntries).toBe(0);
  });
  it("a 2-day entry expires before that session", () => {
    const r = run(sim, { rules: rulesFor({ max_hold_days: 0, entry_valid_days: 2 }, "free") });
    expect(r.tradesList).toHaveLength(0);
    expect(r.expiredEntries).toBe(1);
  });
});

describe("backtest exits + halt", () => {
  it("a time stop queues a market sell that fills at the next open", () => {
    const s = setup([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100], // Tue: fills at the open (09:30)
      [100, 101, 99.5, 100], // Wed evening run: held 1.3 days > 1 → market sell queued
      [103, 104, 102, 103], // Thu: sold at the open
      [100, 101, 99.5, 100],
    ]);
    const r = runBacktest({
      box: "free", rules: rulesFor({ max_hold_days: 1 }, "free"), bars: { X: s.bars }, symbols: ["X"],
      start: s.start, end: s.end, pick: pickOn(s.start),
    });
    expect(r.trades).toBe(1);
    expect(r.tradesList[0]).toMatchObject({ exit: 103, exitDate: s.dates[43] });
    expect(r.tradesList[0].why).toMatch(/time stop/);
  });

  it("daily-loss halt blocks new entries that day", () => {
    const s = setup([
      [100, 101, 99, 100],
      [100, 101, 99.5, 100],
      [100, 101, 99.5, 50], // close crashes → equity −9×50 ≈ −9% > 3% halt (no stop hit: low 99.5)
      [50, 51, 49, 50],
    ]);
    const Y = setup([
      [100, 101, 99, 100], [100, 101, 99.5, 100], [100, 101, 99.5, 100], [100, 101, 99.5, 100],
    ]).bars;
    const r = runBacktest({
      box: "free", rules: R0, bars: { X: s.bars, Y }, symbols: ["X", "Y"], start: s.start, end: s.end,
      pick: (ctx) => ({ list: ctx.date === s.start ? [cand("X")] : ctx.date === s.dates[42] ? [cand("Y")] : [], stale: [] }),
    });
    expect(r.haltedDays).toBe(1);
    expect(r.tradesList.map((t) => t.symbol)).not.toContain("Y");
  });
});

describe("backtest has no lookahead", () => {
  // Seeded random walks; the real Free Choice picker (setups.ts) decides.
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  }
  const n = 420;
  const dates = weekdays(n);
  const bars: Record<string, Bar[]> = {};
  for (const [k, sym] of ["AAA", "BBB", "CCC", "DDD", "EEE", "SPY"].entries()) {
    const r = rng(k + 7);
    let c = 50 + k * 20;
    bars[sym] = dates.map((d) => {
      const o = c * (1 + (r() - 0.5) * 0.02);
      c = o * (1 + (r() - 0.48) * 0.04);
      const h = Math.max(o, c) * (1 + r() * 0.015);
      const l = Math.min(o, c) * (1 - r() * 0.015);
      return bar(d, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2));
    });
  }
  const R = rulesFor({ uptrend_only: false, max_rsi: 100, max_hold_days: 10, reward_risk: 1.5 }, "free");
  const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
  const start = dates[300];
  const full = runBacktest({ box: "free", rules: R, bars, symbols, start, end: dates[n - 1] });

  it("trades at all (sanity)", () => {
    expect(full.trades).toBeGreaterThan(3);
  });

  it("truncating the future never changes the past", () => {
    for (const k of [310, 340, 371, 400]) {
      const cut = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.slice(0, k + 1)]));
      const part = runBacktest({ box: "free", rules: R, bars: cut, symbols, start, end: dates[k] });
      expect(part.equity).toEqual(full.equity.slice(0, part.equity.length));
      expect(part.tradesList.filter((t) => !t.open)).toEqual(full.tradesList.filter((t) => !t.open && t.exitDate <= dates[k]));
    }
  });

  it("equity math: end equity = start cash + realized + open P&L; drawdown from the curve", () => {
    const realized = full.tradesList.reduce((a, t) => a + t.pnl, 0);
    expect(full.endEquity).toBeCloseTo(full.startCash + realized, 0);
    expect(full.maxDrawdownPct).toBeCloseTo(maxDrawdownPct(full.equity.map((e) => e.equity)), 10);
    expect(full.equity[0].spy).toBe(full.startCash);
    const spy = bars.SPY;
    const i0 = dates.indexOf(start);
    expect(full.buyHoldSpyPct).toBeCloseTo((spy[n - 1].c / spy[i0].c - 1) * 100, 8);
  });
});

describe("backtest parity with the engine's planning", () => {
  it("entry size = plan.ts sizeQty on bracket(close, ATR) of the day's window", () => {
    const s = setup([[100, 101, 99, 100], [100, 101, 99.5, 100]]);
    const r = runBacktest({ box: "free", rules: R0, bars: { X: s.bars }, symbols: ["X"], start: s.start, end: s.end, pick: pickOn(s.start) });
    const window = s.bars.slice(0, 41);
    const br = bracket(100, atr(window), R0);
    const sz = sizeQty({ equity: 5000, available: 5000, price: br.limit, riskPerShare: br.riskPerShare }, R0);
    expect(r.tradesList[0].qty).toBe(sz.qty);
    const p = planEntry(cand("X"), window, 100, R0, 5000, 5000);
    expect(p.ok && p.qty).toBe(sz.qty);
  });

  it("My List enters on the first day the recomputed signal is BUY/WASHOUT ≥ min score", () => {
    // 200-day rise 50 → 150, then a slide into the Fibonacci buy zone.
    const n = 300;
    const dates = weekdays(n);
    const closes = dates.map((_, i) => (i < 200 ? 50 + i * 0.5 : 150 - (i - 200) * 0.6));
    const X = dates.map((d, i) => bar(d, closes[i], closes[i] + 0.5, closes[i] - 0.5, closes[i]));
    const R = rulesFor({}, "mylist");
    const start = dates[201];
    const r = runBacktest({ box: "mylist", rules: R, bars: { X }, symbols: ["X"], start, end: dates[n - 1] });
    const first = dates.findIndex((_, i) => {
      if (i < 201) return false;
      const a = assess({ closes: closes.slice(Math.max(0, i + 1 - 252), i + 1) });
      return (a.assessment === "BUY" || a.assessment === "WASHOUT") && a.score >= R.minScore;
    });
    expect(first).toBeGreaterThan(0);
    expect(r.tradesList[0].setup).toMatch(/^Stocky (BUY|WASHOUT)/);
    expect(r.tradesList[0].entryDate >= dates[first + 1]).toBe(true);
    // the order placed after `first`'s close is a limit 1% over that close
    const placed = dates[first + 1];
    if (r.tradesList[0].entryDate === placed) expect(r.tradesList[0].entry).toBeLessThanOrEqual(+(closes[first] * 1.01).toFixed(2));
  });

  it("shared decision helpers keep the engine's wording", () => {
    expect(entrySlots(rulesFor({ max_new_per_run: 0 }, "free"), 0)).toEqual({ wantN: 0, skip: "new trades per run set to 0" });
    expect(entrySlots(R0, 5).skip).toBe("book full (5 positions/orders)");
    expect(entrySlots(R0, 3).wantN).toBe(2);
    expect(haltReason(4800, 5000, R0)).toMatch(/3% daily-loss halt/);
    expect(haltReason(4900, 5000, R0)).toBeUndefined();
    const R = rulesFor({}, "mylist");
    expect(exitReason({ mylist: true, R, sig: { assessment: "OVERBOUGHT", tag: "EXPENSIVE" }, openedAt: "2026-01-01", now: new Date() })).toBe(
      "signal turned OVERBOUGHT · EXPENSIVE"
    );
    expect(
      exitReason({ mylist: false, R: rulesFor({ max_hold_days: 5 }, "free"), sig: undefined, openedAt: "2026-01-01T00:00:00Z", now: new Date("2026-01-08T00:00:00Z") })
    ).toBe("time stop — held 7 days (max 5)");
  });
});

describe("backtest math helpers", () => {
  it("max drawdown is the worst peak-to-trough %", () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(25);
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });
  it("trade stats", () => {
    const s = tradeStats([
      { pnl: 100, pnlPct: 10 },
      { pnl: -50, pnlPct: -5 },
      { pnl: 50, pnlPct: 4 },
      { pnl: 0, pnlPct: 0 },
    ]);
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 1, profitFactor: 3, avgWinPct: 7, avgLossPct: -5 });
    expect(s.winRatePct).toBeCloseTo(66.667, 2);
    expect(tradeStats([{ pnl: 10, pnlPct: 1 }]).profitFactor).toBeNull();
  });
  it("period start clamps to the month end", () => {
    expect(periodStart("2026-03-31", "1M")).toBe("2026-02-28");
    expect(periodStart("2026-11-07", "1Y")).toBe("2025-11-07");
    expect(periodStart("2026-01-15", "2Y")).toBe("2024-01-15");
  });
});

describe("backtest: new Rules settings (fixes #8, #13)", () => {
  it("max_gap_down_pct: a resting entry doesn't fill after a gap down", () => {
    const sim: [number, number, number, number][] = [[100, 101, 99, 100], [90, 92, 89, 91], [91, 92, 90, 91]];
    expect(run(sim).tradesList.length).toBe(1); // default: fills at the 90 open
    const r = run(sim, { rules: rulesFor({ max_hold_days: 0, max_gap_down_pct: 5 }, "free") });
    expect(r.tradesList.length).toBe(0);
    expect(r.expiredEntries).toBe(1);
  });

  it("min_atr_pct: skips a stock whose ATR is under N% of the price", () => {
    const sim: [number, number, number, number][] = [[100, 101, 99, 100], [100, 101, 99.5, 100]];
    expect(run(sim, { rules: rulesFor({ max_hold_days: 0, min_atr_pct: 5 }, "free") }).tradesList.length).toBe(0); // ATR 2%
    expect(run(sim, { rules: rulesFor({ max_hold_days: 0, min_atr_pct: 1 }, "free") }).tradesList.length).toBe(1);
  });

  it("reentry_cooldown_days: no re-entry the day a trade closed", () => {
    // Fill day 1 at 100, stopped day 2 (low 95 < 96); picked again every day.
    const s = setup([[100, 101, 99, 100], [100, 101, 99.5, 100], [97, 98, 95, 96], [96, 97, 95.5, 96], [96, 97, 95.5, 96]]);
    const every: Picker = () => ({ list: [cand("X")], stale: [] });
    const base = { box: "free" as const, bars: { X: s.bars }, symbols: ["X"], start: s.start, end: s.end, pick: every };
    const off = runBacktest({ ...base, rules: rulesFor({ max_hold_days: 0 }, "free") });
    const on = runBacktest({ ...base, rules: rulesFor({ max_hold_days: 0, reentry_cooldown_days: 2 }, "free") });
    const entries = (r: typeof off) => r.tradesList.map((t) => t.entryDate);
    expect(entries(on).length).toBeLessThan(entries(off).length);
  });
});
