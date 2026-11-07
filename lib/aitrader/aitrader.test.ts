import { describe, expect, it } from "vitest";
import { findSetups, scoreCandidate, atr, rankCandidates } from "./setups";
import { bracket, sizeQty, RULES, tick } from "./plan";
import { bookState } from "./ledger";
import { freeUniverse } from "./universe";
import { pageByCreatedAt, pageByToken } from "../alpaca";

const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

describe("setups (ported Trader-skill rules)", () => {
  it("breakout_20d fires when the last close clears the prior 20-day high", () => {
    const c = [...flat(40, 100), 101, 102, 103, 104, 108];
    expect(findSetups(c)).toContain("breakout_20d");
  });

  it("bull_flag: >10% run then a tight <5% 5-day range", () => {
    const run = Array.from({ length: 11 }, (_, i) => 100 + i * 2); // 100 → 120 (+20%)
    const c = [...flat(20, 100), ...run, 119, 120, 121, 120, 120.5];
    expect(findSetups(c)).toContain("bull_flag");
  });

  it("oversold_bounce: RSI < 30 yesterday, up close today", () => {
    const down = Array.from({ length: 30 }, (_, i) => 200 - i * 3); // relentless selloff
    const c = [...down, down[down.length - 1] + 2];
    expect(findSetups(c)).toContain("oversold_bounce");
  });

  it("needs ≥ 30 closes", () => {
    expect(findSetups(flat(29))).toEqual([]);
  });

  it("trend filter rejects a momentum setup below its 50-day average", () => {
    // long decline then a pop above the 20-day high but still under the 50-day MA
    const c = [...Array.from({ length: 60 }, (_, i) => 200 - i * 2), 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 110];
    const cand = scoreCandidate("X", c);
    expect(cand === null || !cand.setups.includes("breakout_20d")).toBe(true);
  });

  it("ranks by setup score, then 20-day strength", () => {
    const r = rankCandidates([
      { symbol: "A", setups: [], score: 2, ret20: 9, rsi: 50, reason: "" },
      { symbol: "B", setups: [], score: 3, ret20: 1, rsi: 50, reason: "" },
      { symbol: "C", setups: [], score: 3, ret20: 5, rsi: 50, reason: "" },
    ]);
    expect(r.map((x) => x.symbol)).toEqual(["C", "B", "A"]);
  });

  it("atr averages true ranges incl. gaps", () => {
    const bars = Array.from({ length: 15 }, (_, i) => ({ t: String(i), o: 10, h: 11, l: 9, c: 10, v: 0 }));
    expect(atr(bars, 14)).toBeCloseTo(2);
  });
});

describe("plan (risk + sizing)", () => {
  it("bracket: limit ≤ 1% above ref, 2R target, stop clamped to 3–12%", () => {
    const b = bracket(100, 2); // 2×ATR = 4 → 4%
    expect(b.limit).toBe(101);
    expect(b.stop).toBe(96);
    expect(b.target).toBe(tick(101 + 2 * (101 - 96)));
    expect(bracket(100, 0.1).stop).toBe(97); // min 3%
    expect(bracket(100, 50).stop).toBe(88); // max 12%
  });

  it("sizes by 1% risk, capped by 20% position and the cash buffer", () => {
    // $5K book, risk $50, $5/share risk → 10 shares; 20% cap at $101 → 9 shares
    expect(sizeQty({ equity: 5000, available: 5000, price: 101, riskPerShare: 5 }).qty).toBe(9);
    // not enough cash after the 10% buffer
    expect(sizeQty({ equity: 5000, available: 400, price: 101, riskPerShare: 5 })).toEqual({
      qty: 0,
      why: "not enough cash",
    });
    // one share bigger than 20% of the book
    expect(sizeQty({ equity: 5000, available: 5000, price: 1200, riskPerShare: 60 }).why).toMatch(/20%/);
  });

  it("rules match the skill-style defaults on a $5K book", () => {
    expect(5000 * RULES.riskPct).toBe(50);
    expect(5000 * RULES.dailyLossHaltPct).toBe(150);
    expect(RULES.maxNewPerRun).toBe(3);
  });
});

describe("ledger", () => {
  it("rebuilds cash, avg cost, realized P&L and win rate from fills", () => {
    const st = bookState(5000, [
      { symbol: "XOM", side: "buy", qty: 10, price: 100, transacted_at: "2026-11-09T15:00:00Z" },
      { symbol: "XOM", side: "buy", qty: 10, price: 110, transacted_at: "2026-11-10T15:00:00Z" },
      { symbol: "XOM", side: "sell", qty: 20, price: 120, transacted_at: "2026-11-12T15:00:00Z" },
      { symbol: "GE", side: "buy", qty: 5, price: 200, transacted_at: "2026-11-12T16:00:00Z" },
    ]);
    expect(st.cash).toBe(5000 - 1000 - 1100 + 2400 - 1000);
    expect(st.realized).toBe(20 * (120 - 105));
    expect(st.closedTrades).toBe(1);
    expect(st.wins).toBe(1);
    expect(st.positions.get("GE")).toMatchObject({ qty: 5, avgCost: 200 });
    expect(st.positions.has("XOM")).toBe(false);
  });

  it("partial exits keep the position open with the same average cost", () => {
    const st = bookState(5000, [
      { symbol: "F", side: "buy", qty: 100, price: 12, transacted_at: "2026-11-09T15:00:00Z" },
      { symbol: "F", side: "sell", qty: 40, price: 11, transacted_at: "2026-11-10T15:00:00Z" },
    ]);
    expect(st.positions.get("F")).toMatchObject({ qty: 60, avgCost: 12 });
    expect(st.realized).toBe(-40);
    expect(st.closedTrades).toBe(0);
  });
});

describe("universe", () => {
  it("excludes the user's list and the twin share class", () => {
    const u = freeUniverse(["NVDA", "goog"]);
    expect(u).not.toContain("NVDA");
    expect(u).not.toContain("GOOG");
    expect(u).not.toContain("GOOGL");
    expect(u).toContain("XOM");
  });
});

describe("ledger outcomes", () => {
  it("a breakeven close is neither a win nor a loss", () => {
    const st = bookState(5000, [
      { symbol: "A", side: "buy", qty: 10, price: 50, transacted_at: "2026-11-09T15:00:00Z" },
      { symbol: "A", side: "sell", qty: 10, price: 50, transacted_at: "2026-11-10T15:00:00Z" },
      { symbol: "B", side: "buy", qty: 10, price: 50, transacted_at: "2026-11-09T15:00:00Z" },
      { symbol: "B", side: "sell", qty: 10, price: 45, transacted_at: "2026-11-10T15:00:00Z" },
      { symbol: "C", side: "buy", qty: 10, price: 50, transacted_at: "2026-11-09T15:00:00Z" },
      { symbol: "C", side: "sell", qty: 10, price: 55, transacted_at: "2026-11-10T15:00:00Z" },
    ]);
    expect(st).toMatchObject({ closedTrades: 3, wins: 1, losses: 1, flats: 1 });
  });
});

describe("universe settings", () => {
  it("adds and removes symbols, still excluding the user's list", () => {
    const u = freeUniverse(["PLTR"], ["SMCI", "PLTR", "xyz"], ["TSLA"]);
    expect(u).toContain("SMCI");
    expect(u).toContain("XYZ");
    expect(u).not.toContain("PLTR");
    expect(u).not.toContain("TSLA");
  });
});

describe("free-book filters", () => {
  // a 20-day breakout well below the 50-day average, with a hot RSI
  const c = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 20 }, (_, i) => 80 + i), 101];
  it("uptrend_only off keeps setups the trend filter would drop", () => {
    expect(scoreCandidate("X", c, { maxRsi: 100, uptrendOnly: true })).toBeNull();
    expect(scoreCandidate("X", c, { maxRsi: 100, uptrendOnly: false })?.setups).toContain("breakout_20d");
  });
  it("max_rsi skips extended names", () => {
    expect(scoreCandidate("X", c, { maxRsi: 40, uptrendOnly: false })).toBeNull();
  });
});

describe("alpaca paging", () => {
  type O = { id: string; created_at: string };
  const mk = (n: number): O[] =>
    Array.from({ length: n }, (_, i) => ({ id: `o${i}`, created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }));

  it("pageByCreatedAt walks every page from the last created_at", async () => {
    const all = mk(1234);
    const afters: string[] = [];
    const got = await pageByCreatedAt<O>(async (after) => {
      afters.push(after);
      return all.filter((o) => o.created_at > after).slice(0, 500);
    }, "2025-12-31T00:00:00Z");
    expect(got.map((o) => o.id)).toEqual(all.map((o) => o.id));
    expect(afters.length).toBe(3);
  });

  it("pageByCreatedAt stops when a page adds nothing new", async () => {
    const same = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, created_at: "2026-01-01T00:00:00.000Z" }));
    let calls = 0;
    const got = await pageByCreatedAt<O>(async () => {
      calls++;
      return same;
    }, "2025-12-31T00:00:00Z");
    expect(got.length).toBe(500);
    expect(calls).toBe(2);
  });

  it("pageByToken follows tokens past the old 20-page cap", async () => {
    const all = Array.from({ length: 2550 }, (_, i) => ({ id: String(i).padStart(5, "0") }));
    const got = await pageByToken(async (tok) => {
      const from = tok ? all.findIndex((x) => x.id === tok) + 1 : 0;
      return all.slice(from, from + 100);
    }, 100);
    expect(got.length).toBe(2550);
  });
});
