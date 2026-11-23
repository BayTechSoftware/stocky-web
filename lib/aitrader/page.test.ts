import { describe, expect, it } from "vitest";
import {
  boxDaily,
  compareSentence,
  compareSeries,
  dayMs,
  decisionCounts,
  intradayEquity,
  marketLine,
  priceInText,
  riskLevel,
  rightNowSteps,
  runSentence,
  sinceYesterday,
  statusSentence,
  stopLine,
  stopPlan,
  tooEarly,
  tradeLine,
  todayStats,
  watchRows,
  windowed,
  winLoss,
} from "./page";

describe("market comparison", () => {
  const box = [
    { t: dayMs("2026-11-16"), v: 10000 },
    { t: dayMs("2026-11-17"), v: 9900 },
    { t: dayMs("2026-11-20"), v: 9510 },
  ];
  const spy = [
    { t: dayMs("2026-11-13"), v: 600 },
    { t: dayMs("2026-11-16"), v: 500 },
    { t: dayMs("2026-11-17"), v: 495 },
    { t: dayMs("2026-11-20"), v: 489 },
  ];

  it("uses the last value before the period as its base", () => {
    expect(windowed(spy, dayMs("2026-11-17"))?.base).toBe(500);
    // Nothing before: the first value in the period is the base (and not a point of its own).
    expect(windowed(box, dayMs("2026-11-16"))).toMatchObject({ base: 10000, baseT: dayMs("2026-11-16") });
    expect(windowed(box, dayMs("2026-11-16"))?.points).toHaveLength(2);
    expect(windowed(box, dayMs("2026-12-01"))).toBeNull();
  });

  it("puts both lines on % from the same start", () => {
    const c = compareSeries(box, spy, dayMs("2026-11-17"))!;
    // Both start at 0 from the earlier base (the box's Nov 16, the S&P's Nov 16 close).
    expect(c.box[0]).toEqual({ t: dayMs("2026-11-16"), v: 0 });
    expect(c.spy[0]).toEqual({ t: dayMs("2026-11-16"), v: 0 });
    expect(c.box).toHaveLength(3);
    expect(c.spy[0].v).toBe(0);
    expect(c.boxPct).toBeCloseTo(-4.9, 5);
    expect(c.spyPct).toBeCloseTo(-2.2, 5);
    expect(c.diffPts).toBeCloseTo(-2.7, 5);
  });

  it("says ahead / behind in points, and what the S&P did", () => {
    expect(compareSentence({ boxPct: -4.9, spyPct: -2.2, diffPts: -2.7 }, "week")).toEqual({
      tone: "loss",
      text: "Behind the market by 2.7 points. The S&P 500 fell 2.2% over the same days.",
    });
    expect(compareSentence({ boxPct: 1.6, spyPct: 0.6, diffPts: 1.0 }, "today").text).toBe(
      "Ahead of the market by 1.0 point. The S&P 500 rose 0.6% today."
    );
    expect(compareSentence({ boxPct: 0.01, spyPct: 0.02, diffPts: -0.01 }, "all").tone).toBe("flat");
  });

  it("builds the box's daily line: start cash the day before, snapshots, the live value as today", () => {
    const pts = boxDaily({
      series: [
        { as_of: "2026-11-10", equity: 1 },
        { as_of: "2026-11-17", equity: 9900 },
        { as_of: "2026-11-20", equity: 9000 },
      ],
      startCash: 10000,
      firstDay: "2026-11-17",
      equityNow: 9510,
      today: "2026-11-20",
    });
    expect(pts.map((p) => p.v)).toEqual([10000, 9900, 9510]);
    expect(pts[0].t).toBe(dayMs("2026-11-16"));
  });
});

describe("intradayEquity", () => {
  const t0 = Date.parse("2026-11-20T14:30:00Z");
  const bars = {
    AAA: [
      { t: "2026-11-20T14:30:00Z", o: 10, c: 10 },
      { t: "2026-11-20T14:35:00Z", o: 10, c: 11 },
      { t: "2026-11-20T14:40:00Z", o: 11, c: 12 },
    ],
  };

  it("undoes later fills and marks the shares held at each bar's close", () => {
    // Bought 10 AAA at 10 at 14:36; now worth 12. Cash now 900, equity 1020.
    const pts = intradayEquity({
      equityNow: 1020,
      positions: [{ symbol: "AAA", qty: 10, value: 120, price: 12 }],
      fills: [{ at: "2026-11-20T14:36:00Z", symbol: "AAA", side: "buy", qty: 10, price: 10 }],
      bars,
      times: [t0 + 5 * 60_000, t0 + 10 * 60_000, t0 + 15 * 60_000],
      nowMs: t0 + 20 * 60_000,
    });
    // 14:35: before the buy, all cash 1000. 14:40: 10 sh at 11 + 900. 14:45: at 12.
    expect(pts.map((p) => p.v)).toEqual([1000, 1010, 1020, 1020]);
  });

  it("handles a sell (cash in) and a position with no bars (its price now)", () => {
    const pts = intradayEquity({
      equityNow: 1100,
      positions: [{ symbol: "BBB", qty: 5, value: 100, price: 20 }],
      fills: [{ at: "2026-11-20T14:36:00Z", symbol: "AAA", side: "sell", qty: 10, price: 11 }],
      bars,
      times: [t0 + 5 * 60_000],
      nowMs: t0 + 20 * 60_000,
    });
    // Before the sell: 10 AAA at 10 (14:35 close), cash 1000 - 110 = 890, BBB 5 × 20.
    expect(pts[0].v).toBe(890 + 100 + 100);
  });
});

describe("performance numbers", () => {
  it("risk level from the share of the daily limit", () => {
    expect(riskLevel(10, 150)?.level).toBe("Low");
    expect(riskLevel(46.5, 150)).toEqual({ level: "Medium", pct: 31 });
    expect(riskLevel(120, 150)?.level).toBe("High");
    expect(riskLevel(null, 150)).toBeNull();
    expect(riskLevel(10, 0)).toBeNull();
  });

  it("average win and loss", () => {
    expect(winLoss([{ pnl: 10 }, { pnl: 20 }, { pnl: -5 }, { pnl: 0 }])).toEqual({ avgWin: 15, avgLoss: 5, winPct: (2 / 3) * 100 });
    expect(winLoss([])).toEqual({ avgWin: null, avgLoss: null, winPct: null });
  });

  it("since yesterday: the last snapshot before today", () => {
    const s = [
      { as_of: "2026-11-18", equity: 9000 },
      { as_of: "2026-11-19", equity: 9400 },
      { as_of: "2026-11-20", equity: 9999 },
    ];
    expect(sinceYesterday(s, 9500, "2026-11-20")).toBe(100);
    expect(sinceYesterday([], 9500, "2026-11-20")).toBeNull();
  });

  it("too early to judge under 8 weeks", () => {
    expect(tooEarly("2026-11-18", "2026-11-20")).toBe("Too early to judge: less than a week of results.");
    expect(tooEarly("2026-11-10", "2026-11-20")).toBe("Too early to judge: 1 week of results.");
    expect(tooEarly("2026-09-01", "2026-11-20")).toBeNull();
    expect(tooEarly(null, "2026-11-20")).toBeNull();
  });
});

describe("holdings", () => {
  it("long: % above the stop and to the target; close under 1.5%", () => {
    const p = stopPlan({ qty: 27, price: 100, stop: 98.8, target: 103.6 });
    expect(p.stopPct).toBeCloseTo(1.2);
    expect(p.targetPct).toBeCloseTo(3.6);
    expect(p.close).toBe(true);
    expect(stopLine(p, false)).toBe("Close to its stop: 1.2% above · 3.6% to target");
    expect(stopLine(stopPlan({ qty: 1, price: 100, stop: 90, target: null }), false)).toBe("10.0% above its stop");
  });

  it("short: the stop is above, the target below", () => {
    const p = stopPlan({ qty: -80, price: 100, stop: 105, target: 90 });
    expect(p.stopPct).toBeCloseTo(5);
    expect(p.targetPct).toBeCloseTo(10);
    expect(stopLine(p, true)).toBe("5.0% from its stop · 10.0% to target");
  });

  it("no price: nothing to say", () => {
    expect(stopLine(stopPlan({ qty: 1, price: null, stop: 1, target: 2 }), false)).toBeNull();
  });
});

describe("watchRows", () => {
  it("orders first per stock, sorted by distance, then rows without a distance", () => {
    const rows = watchRows({
      orders: [
        { symbol: "SCCO", side: "buy", kind: "entry", limit: 145.45, stop: null, reason: null },
        { symbol: "XX", side: "sell", kind: "exit", limit: null, stop: 5, reason: null },
      ],
      watches: [
        { symbol: "AZZ", trigger: "breaks above $123.95 on volume" },
        { symbol: "SCCO", trigger: "$1" },
        { symbol: "QQQ", trigger: "a pullback" },
        { symbol: "HELD", trigger: "$5" },
      ],
      signals: [{ symbol: "TMUS", note: "weekly BUY ★" }],
      prices: { SCCO: 145, AZZ: 121.76, QQQ: 400 },
      held: ["HELD"],
    });
    expect(rows.map((r) => r.symbol)).toEqual(["SCCO", "AZZ", "QQQ", "TMUS"]);
    expect(rows[0].kind).toBe("order");
    expect(rows[0].away).toBeCloseTo(0.31, 2);
    expect(rows[1].away).toBeCloseTo(1.8, 1);
    expect(rows[2].away).toBeNull();
  });

  it("reads the first dollar price in a trigger", () => {
    expect(priceInText("over $1,234.50 then")).toBe(1234.5);
    expect(priceInText("no price")).toBeNull();
  });
});

describe("statusSentence", () => {
  const base = { off: false, runner: { interval_min: 15 }, nowMs: Date.parse("2026-11-20T18:00:00Z"), marketOpen: true };
  it("day: every minute, the next look, the close-out time", () => {
    expect(statusSentence({ ...base, key: "claude-day", cfg: { flat_by: "15:50" }, lastRunAt: "2026-11-20T17:50:00Z" })).toBe(
      "Checks the market every minute · next Claude look about 13:05 · closes everything by 15:50"
    );
    expect(statusSentence({ ...base, key: "claude-day", cfg: { flat_by: "" }, lastRunAt: null })).toBe(
      "Checks the market every minute · may hold overnight"
    );
  });
  it("long and off", () => {
    expect(statusSentence({ ...base, key: "claude-long", cfg: { intraday_watch: true, scan_min: 15, move_pct: 4, news_wakes: true }, lastRunAt: null })).toBe(
      "Holds for weeks · re-checks its signals every 15 min · wakes Claude on big moves and news"
    );
    expect(statusSentence({ ...base, key: "claude-long", cfg: { intraday_watch: false, run_at: "09:00" }, lastRunAt: null })).toBe(
      "Holds for weeks · looks once a day at 09:00"
    );
    expect(statusSentence({ ...base, off: true, key: "claude-day", cfg: {}, lastRunAt: null })).toMatch(/^Switched off/);
  });
});

describe("today and right now", () => {
  it("trade lines", () => {
    expect(tradeLine({ at: "", symbol: "PDD", side: "buy", qty: 27, price: 86.49, role: null, pnl: null, reason: "analyst upgrade" })).toEqual({
      title: "Bought PDD",
      why: "analyst upgrade",
      right: "27 @ $86.49",
      tone: "flat",
    });
    expect(tradeLine({ at: "", symbol: "BSP", side: "sell", qty: 5, price: 10, role: null, pnl: -53.65, exit: "stop" })).toMatchObject({
      title: "Stopped out of BSP",
      why: "fell to its stop",
      right: "−$53.65",
      tone: "loss",
    });
    expect(tradeLine({ at: "", symbol: "IP", side: "buy", qty: 5, price: 10, role: "cover", pnl: 4, exit: "target" }).title).toBe("Bought back IP");
  });

  it("today's stats", () => {
    expect(
      todayStats([
        { at: "", symbol: "A", side: "buy", qty: 1, price: 1, role: null, pnl: null },
        { at: "", symbol: "A", side: "sell", qty: 1, price: 1, role: null, pnl: 5 },
        { at: "", symbol: "B", side: "sell", qty: 1, price: 1, role: null, pnl: -2 },
      ])
    ).toEqual({ count: 3, won: 1, closed: 2, locked: 3 });
  });

  it("decision counts", () => {
    expect(decisionCounts([{ action: "skip" }, { action: "buy" }, { action: "skip" }, { action: "cancel" }])).toBe("1 buy · 3 skips");
    expect(decisionCounts([])).toBe("no decisions");
  });

  it("the five steps: the latest event's step is now", () => {
    const run = { ran_at: "2026-11-20T16:46:00Z", error: null, summary: { phase: "ENTRY", decisions: [{ symbol: "PDD", action: "buy" }] } };
    const fill = { at: "2026-11-20T16:48:00Z", symbol: "PDD", side: "buy", qty: 27, price: 86.49, role: null, pnl: null };
    const steps = rightNowSteps({ watchSub: "every minute", watchSeen: true, run, today: "2026-11-20", latestFill: fill, openCount: 3, current: null });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "now"]);
    expect(steps[1].sub).toBe("11:46 · looking for trades");
    expect(steps[3]).toMatchObject({ label: "Bought", sub: "PDD at $86.49" });
    const look = rightNowSteps({ watchSub: "", watchSeen: true, run, today: "2026-11-20", latestFill: null, openCount: 0, current: "look" });
    expect(look.map((s) => s.state)).toEqual(["done", "now", "idle", "idle", "idle"]);
  });

  it("run sentence: the note, else the main decision", () => {
    expect(runSentence({ ran_at: "", error: null, summary: { note: "Quiet market." } })).toBe("Quiet market.");
    expect(runSentence({ ran_at: "", error: null, summary: { decisions: [{ symbol: "PDD", action: "buy", qty: 27, price: 86.49, reason: "upgrade" }] } })).toBe(
      "Claude bought 27 PDD at about $86.49: upgrade"
    );
    expect(runSentence({ ran_at: "", error: null, summary: { decisions: [{ symbol: "A", action: "skip" }] } })).toBe(
      "Claude passed on 1 stock and opened nothing new."
    );
    expect(runSentence(null)).toBeNull();
  });
});

describe("marketLine", () => {
  const now = Date.parse("2026-11-20T18:45:00Z"); // 13:45 NY
  it("open: time to the close", () => {
    expect(marketLine({ isOpen: true, nextOpen: null, nextClose: "2026-11-20T21:00:00Z" }, now)).toBe("Market open · closes in 2h 15m");
  });
  it("closed: when it opens", () => {
    expect(marketLine({ isOpen: false, nextOpen: "2026-11-23T14:30:00Z", nextClose: null }, now)).toBe(
      "Market closed · opens Mon 09:30 New York time"
    );
    expect(marketLine(null, now)).toBeNull();
  });
});

describe("basic settings", () => {
  it("every basic key exists in its box's table, in order", async () => {
    const { BASIC_KEYS, basicDefs } = await import("./layout");
    const { defsForBook } = await import("./limits");
    for (const key of ["claude-day", "claude-long"]) {
      const defs = basicDefs(key, defsForBook(key));
      expect(defs.map((d) => d.key)).toEqual(BASIC_KEYS[key]);
    }
    expect(basicDefs("mylist", defsForBook("mylist"))).toEqual([]);
  });
});
