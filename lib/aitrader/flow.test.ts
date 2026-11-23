import { describe, expect, it } from "vitest";
import {
  FLOW_STEPS,
  addDays,
  dayLabel,
  fillLine,
  inRecent,
  newestFirst,
  nowStep,
  nyDate,
  nyDayBounds,
  nyOffset,
  nyTime,
  pathSteps,
  recentDays,
  summarize,
  symbolEvents,
  toEvent,
  toEvents,
  toneOf,
  totalCount,
  type AiEvent,
} from "./flow";

let nextId = 1;
const ev = (p: Partial<AiEvent> & Pick<AiEvent, "step" | "at">): AiEvent => ({
  id: nextId++,
  symbol: null,
  title: `${p.step} at ${p.at}`,
  ok: null,
  run_ref: null,
  detail: null,
  ...p,
});

describe("toEvent", () => {
  it("accepts a well-formed row and upper-cases the symbol", () => {
    const e = toEvent({ id: "42", at: "2026-11-23T15:00:00Z", step: "decide", symbol: "gap", title: "Buy GAP", ok: null, run_ref: "r1", detail: { action: "buy" } });
    expect(e).toEqual({ id: 42, at: "2026-11-23T15:00:00Z", step: "decide", symbol: "GAP", title: "Buy GAP", ok: null, run_ref: "r1", detail: { action: "buy" } });
  });

  it("drops rows with an unknown step or missing fields", () => {
    expect(toEvent({ id: 1, at: "2026-11-23T15:00:00Z", step: "dance", title: "x" })).toBeNull();
    expect(toEvent({ id: 1, step: "wake", title: "x" })).toBeNull();
    expect(toEvent(null)).toBeNull();
    expect(toEvents([{ id: 1, at: "2026-11-23T15:00:00Z", step: "wake", title: "x" }, { nope: true }])).toHaveLength(1);
  });

  it("normalises ok, symbol and detail", () => {
    const e = toEvent({ id: 3, at: "2026-11-23T15:00:00Z", step: "check", symbol: "", title: "t", ok: "yes", detail: [1, 2] });
    expect(e?.ok).toBeNull();
    expect(e?.symbol).toBeNull();
    expect(e?.detail).toBeNull();
  });
});

describe("New York dates", () => {
  it("nyDate uses the New York calendar day, not UTC", () => {
    // 03:30 UTC on the 24th is still the evening of the 23rd in New York.
    expect(nyDate(new Date("2026-11-24T03:30:00Z"))).toBe("2026-11-23");
    expect(nyDate(new Date("2026-11-24T05:30:00Z"))).toBe("2026-11-24");
  });

  it("nyOffset follows daylight saving, including the switch days", () => {
    expect(nyOffset("2026-07-01")).toBe("-04:00");
    expect(nyOffset("2026-12-01")).toBe("-05:00");
    // Spring forward 2026-03-08 at 2 am: midnight is still EST. Fall back 2026-11-01: midnight is still EDT.
    expect(nyOffset("2026-03-08")).toBe("-05:00");
    expect(nyOffset("2026-11-01")).toBe("-04:00");
  });

  it("nyDayBounds spans the New York day (23 or 25 hours on switch days)", () => {
    expect(nyDayBounds("2026-11-23")).toEqual({ start: "2026-11-23T05:00:00.000Z", end: "2026-11-24T05:00:00.000Z" });
    expect(nyDayBounds("2026-07-01")).toEqual({ start: "2026-07-01T04:00:00.000Z", end: "2026-07-02T04:00:00.000Z" });
    const spring = nyDayBounds("2026-03-08");
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3_600_000);
    const fall = nyDayBounds("2026-11-01");
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3_600_000);
  });

  it("addDays crosses months and years", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("recentDays keeps today plus the weekdays of the last week", () => {
    // Monday 2026-11-23: back to Tuesday the 17th, skipping the weekend.
    expect(recentDays("2026-11-23")).toEqual(["2026-11-23", "2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17"]);
    // A Saturday is still offered as "today".
    expect(recentDays("2026-11-21")[0]).toBe("2026-11-21");
  });

  it("inRecent accepts only the last 7 calendar days", () => {
    expect(inRecent("2026-11-23", "2026-11-23")).toBe(true);
    expect(inRecent("2026-11-17", "2026-11-23")).toBe(true);
    expect(inRecent("2026-11-16", "2026-11-23")).toBe(false);
    expect(inRecent("2026-11-24", "2026-11-23")).toBe(false);
    expect(inRecent("nope", "2026-11-23")).toBe(false);
  });

  it("labels and times are New York's", () => {
    expect(dayLabel("2026-11-23", "2026-11-23")).toBe("Today");
    expect(dayLabel("2026-11-22", "2026-11-23")).toBe("Yesterday");
    expect(dayLabel("2026-11-20", "2026-11-23")).toBe("Fri, Nov 20");
    expect(nyTime("2026-11-23T14:41:00Z")).toBe("9:41 AM");
    expect(nyTime("2026-11-23T14:41:00Z", true)).toBe("Mon 9:41 AM");
  });
});

describe("summarize", () => {
  const day = [
    ev({ step: "wake", at: "2026-11-23T14:31:00Z", title: "news on GAP" }),
    ev({ step: "decide", at: "2026-11-23T14:32:00Z", symbol: "GAP" }),
    ev({ step: "decide", at: "2026-11-23T14:32:00Z", symbol: "AAPL" }),
    ev({ step: "check", at: "2026-11-23T14:32:10Z", symbol: "GAP", ok: true }),
    ev({ step: "check", at: "2026-11-23T14:32:11Z", symbol: "AAPL", ok: false }),
    ev({ step: "error", at: "2026-11-23T14:33:00Z", title: "Alpaca timed out" }),
    ev({ step: "decide", at: "2026-11-23T14:40:00Z", symbol: "GAP" }),
  ];

  it("counts, failures, latest and symbols per step", () => {
    const s = summarize(day);
    expect(Object.keys(s).sort()).toEqual([...FLOW_STEPS, "error"].sort());
    expect(s.decide.count).toBe(3);
    expect(s.decide.latest?.at).toBe("2026-11-23T14:40:00Z");
    expect(s.decide.symbols).toEqual(["GAP", "AAPL"]);
    expect(s.check).toMatchObject({ count: 2, failed: 1 });
    expect(s.error).toMatchObject({ count: 1, failed: 1 });
    expect(s.fill).toEqual({ count: 0, failed: 0, latest: null, symbols: [] });
    expect(totalCount(s)).toBe(7);
  });

  it("a tie on time picks the later-recorded event (higher id)", () => {
    const a = ev({ step: "order", at: "2026-11-23T15:00:00Z", title: "first" });
    const b = ev({ step: "order", at: "2026-11-23T15:00:00Z", title: "second" });
    expect(summarize([b, a]).order.latest?.title).toBe("second");
  });

  it("the minute checks can be counted separately", () => {
    const latest = ev({ step: "watch", at: "2026-11-23T15:10:00Z", title: "flat and the entry window is over" });
    const s = summarize(day, { count: 380, failed: 0, latest });
    expect(s.watch).toEqual({ count: 380, failed: 0, latest, symbols: [] });
    expect(totalCount(s)).toBe(387);
  });

  it("toneOf: errors and blocks red, allowed green, else neutral", () => {
    expect(toneOf({ step: "error", ok: null })).toBe("bad");
    expect(toneOf({ step: "check", ok: false })).toBe("bad");
    expect(toneOf({ step: "check", ok: true })).toBe("ok");
    expect(toneOf({ step: "look", ok: null })).toBe("neutral");
  });
});

describe("nowStep", () => {
  const s = summarize([
    ev({ step: "decide", at: "2026-11-23T15:00:00Z" }),
    ev({ step: "fill", at: "2026-11-23T15:02:00Z" }),
  ]);
  const at = (iso: string) => Date.parse(iso);

  it("is the latest event's step within 3 minutes", () => {
    expect(nowStep(s, at("2026-11-23T15:04:30Z"))).toBe("fill");
  });
  it("is null once the latest event is older than 3 minutes", () => {
    expect(nowStep(s, at("2026-11-23T15:05:30Z"))).toBeNull();
  });
  it("tolerates the Mac's clock running slightly ahead", () => {
    expect(nowStep(s, at("2026-11-23T15:01:30Z"))).toBe("fill");
  });
  it("is null with no events", () => {
    expect(nowStep(summarize([]), Date.now())).toBeNull();
  });
  it("counts a separately counted minute check", () => {
    const w = ev({ step: "watch", at: "2026-11-23T15:04:00Z" });
    expect(nowStep(summarize([], { count: 1, failed: 0, latest: w }), at("2026-11-23T15:05:00Z"))).toBe("watch");
  });
});

describe("a stock's path", () => {
  const evs = [
    ev({ step: "exit", at: "2026-11-23T16:00:00Z", symbol: "GAP" }),
    ev({ step: "wake", at: "2026-11-23T14:30:00Z", symbol: "GAP" }),
    ev({ step: "decide", at: "2026-11-23T14:31:00Z", symbol: "GAP" }),
    ev({ step: "decide", at: "2026-11-23T14:31:00Z", symbol: "AAPL" }),
    ev({ step: "check", at: "2026-11-23T14:31:05Z", symbol: "GAP", ok: true }),
    ev({ step: "order", at: "2026-11-23T14:31:06Z", symbol: "GAP" }),
    ev({ step: "fill", at: "2026-11-23T14:31:30Z", symbol: "GAP" }),
    ev({ step: "exit", at: "2026-11-23T15:00:00Z", symbol: "GAP" }),
    ev({ step: "watch", at: "2026-11-23T15:30:00Z" }),
  ];

  it("symbolEvents keeps that stock only, newest first, case-insensitive", () => {
    const g = symbolEvents(evs, " gap ");
    expect(g).toHaveLength(7);
    expect(g.every((e) => e.symbol === "GAP")).toBe(true);
    expect(g[0].at).toBe("2026-11-23T16:00:00Z");
  });

  it("pathSteps reads oldest first with repeats folded", () => {
    expect(pathSteps(symbolEvents(evs, "GAP"))).toEqual(["wake", "decide", "check", "order", "fill", "exit"]);
  });

  it("newestFirst doesn't mutate", () => {
    const copy = evs.slice();
    newestFirst(evs);
    expect(evs).toEqual(copy);
  });
});

describe("fillLine", () => {
  it("describes a fill in words", () => {
    expect(fillLine(ev({ step: "fill", at: "x", detail: { side: "buy", qty: 10, price: 12.345 } }))).toBe("Bought 10 at $12.35");
    expect(fillLine(ev({ step: "fill", at: "x", detail: { side: "sell", qty: "5", price: "20" } }))).toBe("Sold 5 at $20.00");
  });
  it("is null for other steps or missing numbers", () => {
    expect(fillLine(ev({ step: "order", at: "x", detail: { side: "buy", qty: 1, price: 1 } }))).toBeNull();
    expect(fillLine(ev({ step: "fill", at: "x", detail: { side: "buy" } }))).toBeNull();
  });
});
