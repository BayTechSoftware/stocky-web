import { describe, expect, it } from "vitest";
import { bookState, inferExitReason, type Fill, type OrderMeta } from "./ledger";

// 2026-11-09 is EST (UTC-5): 15:00Z = 10:00 NY, 20:45Z = 15:45 NY.
const T = (h: number, m = 0, day = 9) => `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const buy = (symbol: string, qty: number, price: number, at: string, order_id: string): Fill => ({ symbol, side: "buy", qty, price, transacted_at: at, order_id });
const sell = (symbol: string, qty: number, price: number, at: string, order_id: string, opensShort = false): Fill => ({
  symbol, side: "sell", qty, price, transacted_at: at, order_id, opensShort,
});

describe("closed round trips", () => {
  it("long win: P&L, %, hold time, R from the entry's stop", () => {
    const orders: OrderMeta[] = [
      { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["l1", "l2"], client_order_id: "claude-free-AMD-1" },
      { alpaca_order_id: "x1", kind: "exit", client_order_id: "claude-free-x-AMD-1" },
    ];
    const st = bookState(10_000, [buy("AMD", 10, 100, T(15), "e1"), sell("AMD", 10, 110, T(17, 30), "x1")], orders);
    expect(st.closed).toHaveLength(1);
    const c = st.closed[0];
    expect(c).toMatchObject({ symbol: "AMD", direction: "long", qty: 10, avgEntry: 100, avgExit: 110, pnl: 100, entryOrderId: "e1", exitReason: "claude" });
    expect(c.pnlPct).toBeCloseTo(10);
    expect(c.holdMinutes).toBe(150);
    expect(c.r).toBeCloseTo(2); // 100 / (5 * 10)
    expect(st.exitPnl.get("x1")).toBe(100);
    expect(st.realized).toBe(100);
    expect(st.wins).toBe(1);
  });

  it("long stop-out through a bracket leg: negative, -1R, reason stop", () => {
    const orders: OrderMeta[] = [{ alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["l1", "l2"] }];
    const st = bookState(10_000, [buy("AMD", 10, 100, T(15), "e1"), sell("AMD", 10, 95, T(16), "l2")], orders);
    expect(st.closed[0]).toMatchObject({ pnl: -50, exitReason: "stop" });
    expect(st.closed[0].pnlPct).toBeCloseTo(-5);
    expect(st.closed[0].r).toBeCloseTo(-1);
    expect(st.losses).toBe(1);
  });

  it("short cover win", () => {
    const orders: OrderMeta[] = [{ alpaca_order_id: "s1", kind: "entry", stop_price: 55, target_price: 40, leg_ids: ["l1"] }];
    const st = bookState(10_000, [sell("IBM", 10, 50, T(15), "s1", true), buy("IBM", 10, 45, T(16), "l1")], orders);
    const c = st.closed[0];
    expect(c).toMatchObject({ direction: "short", qty: 10, avgEntry: 50, avgExit: 45, pnl: 50, exitReason: "target" });
    expect(c.pnlPct).toBeCloseTo(10);
    expect(c.r).toBeCloseTo(1); // 50 / (5 * 10)
    expect(st.exitPnl.get("l1")).toBe(50);
  });

  it("partial exit then final exit is one trip; realized = closed + open partial", () => {
    const fills = [buy("NVDA", 10, 100, T(15), "e1"), sell("NVDA", 4, 110, T(16), "x1")];
    const mid = bookState(1000, fills);
    expect(mid.closed).toHaveLength(0);
    expect(mid.exitPnl.get("x1")).toBe(40);
    expect(mid.realized).toBe(40); // open position's partial

    const st = bookState(1000, [...fills, sell("NVDA", 6, 105, T(17), "x2")]);
    expect(st.closed).toHaveLength(1);
    const c = st.closed[0];
    expect(c.qty).toBe(10);
    expect(c.avgExit).toBeCloseTo(107);
    expect(c.pnl).toBeCloseTo(70);
    expect(c.pnlPct).toBeCloseTo(7);
    expect(st.realized).toBeCloseTo(st.closed.reduce((a, t) => a + t.pnl, 0));
    expect(st.exitPnl.get("x1")! + st.exitPnl.get("x2")!).toBeCloseTo(70);
  });

  it("two round trips in one symbol on one day stay separate", () => {
    const st = bookState(5000, [
      buy("SNOW", 5, 100, T(15), "e1"), sell("SNOW", 5, 104, T(15, 30), "x1"),
      buy("SNOW", 8, 105, T(16), "e2"), sell("SNOW", 8, 100, T(17), "x2"),
    ]);
    expect(st.closed.map((t) => [t.entryOrderId, t.pnl])).toEqual([["e1", 20], ["e2", -40]]);
    expect(st.closedTrades).toBe(2);
    expect(st.realized).toBe(-20);
    expect(st.realized).toBe(st.closed.reduce((a, t) => a + t.pnl, 0));
  });

  it("scale-in uses the blended entry and the peak size; R is null without a stop", () => {
    const st = bookState(5000, [buy("A", 2, 10, T(15), "e1"), buy("A", 2, 12, T(15, 5), "e2"), sell("A", 4, 13, T(16), "x1")]);
    expect(st.closed[0]).toMatchObject({ qty: 4, avgEntry: 11, pnl: 8, r: null });
  });
});

describe("inferExitReason", () => {
  const entry: OrderMeta = { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["a", "b"] };
  const f = (order_id: string, price: number, at = T(16)) => ({ order_id, price, transacted_at: at });

  it("bracket legs are told apart by the price they filled at, not by leg order", () => {
    expect(inferExitReason(f("a", 119.9), [entry])).toBe("target");
    expect(inferExitReason(f("b", 119.9), [entry])).toBe("target");
    expect(inferExitReason(f("a", 95.1), [entry])).toBe("stop");
    expect(inferExitReason(f("b", 94.5), [entry])).toBe("stop");
  });

  it("Mac fraction orders: -fs- is a stop; -fx- is target midday and close-out late", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "fs", client_order_id: "claude-mylist-fs-AMD-202611091031" },
      { alpaca_order_id: "fx", client_order_id: "claude-mylist-fx-AMD-202611091031" },
    ];
    expect(inferExitReason(f("fs", 100), o)).toBe("stop");
    expect(inferExitReason(f("fx", 100, T(19, 40)), o)).toBe("target"); // 14:40 NY
    expect(inferExitReason(f("fx", 100, T(20, 51)), o)).toBe("close-out"); // 15:51 NY
  });

  it("Claude -x- exits: deliberate before the close-out window, close-out after", () => {
    const o: OrderMeta[] = [{ alpaca_order_id: "x", client_order_id: "claude-free-x-FERG-202611091556" }];
    expect(inferExitReason(f("x", 100, T(16, 45)), o)).toBe("claude"); // 11:45 NY
    expect(inferExitReason(f("x", 100, T(20, 57)), o)).toBe("close-out"); // 15:57 NY
  });

  it("rules engine: -s- stand-alone stop, -x- rule exit; a close-out reason wins; unknown falls back", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "s", client_order_id: "stk-mylist-s-QYLD-1" },
      { alpaca_order_id: "x", client_order_id: "stk-mylist-x-QYLD-1", reason: "signal turned OVERBOUGHT" },
      { alpaca_order_id: "c", client_order_id: "stk-free-x-QYLD-1", reason: "flatten at the close-out" },
    ];
    expect(inferExitReason(f("s", 10), o)).toBe("stop");
    expect(inferExitReason(f("x", 10), o)).toBe("exit");
    expect(inferExitReason(f("c", 10), o)).toBe("close-out");
    expect(inferExitReason(f("nope", 10), o)).toBe("exit");
    expect(inferExitReason({ price: 10, transacted_at: T(16) }, o)).toBe("exit");
  });

  it("the largest exit slice names the trip's reason (a fraction follows its bracket)", () => {
    const orders: OrderMeta[] = [
      { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["a"] },
      { alpaca_order_id: "fx", client_order_id: "claude-mylist-fx-AMD-1" },
    ];
    const st = bookState(5000, [buy("AMD", 2.5, 100, T(15), "e1"), sell("AMD", 2, 120, T(18), "a"), sell("AMD", 0.5, 120, T(18, 1), "fx")], orders);
    expect(st.closed[0].exitReason).toBe("target");
  });
});

describe("tradesFromFills pnl", () => {
  it("attaches the exit order's realized P&L; entries get null", async () => {
    const { tradesFromFills } = await import("./live");
    const t = tradesFromFills(
      [
        { order_id: "e1", symbol: "AMD", side: "buy", qty: 1, price: 10, transacted_at: T(15) },
        { order_id: "x1", symbol: "AMD", side: "sell", qty: 1, price: 12, transacted_at: T(16) },
      ],
      new Map([["x1", 2]])
    );
    expect(t.find((x) => x.symbol === "AMD" && x.side === "sell")?.pnl).toBe(2);
    expect(t.find((x) => x.side === "buy")?.pnl).toBeNull();
  });
});

describe("recorded exit reasons (the Mac's exit manager)", () => {
  const f = (order_id: string, price: number, at = T(16)) => ({ order_id, price, transacted_at: at });

  it("a recorded reason on the fill's own exit row wins over inference", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["leg-sl", "leg-tp"], reason: "breakout" },
      { alpaca_order_id: "leg-sl", kind: "exit", reason: "trail", stop_price: 108 },
      { alpaca_order_id: "x", kind: "exit", client_order_id: "claude-free-x-AMD-1", reason: "claude" },
      { alpaca_order_id: "mx", kind: "exit", client_order_id: "claude-free-mx-AMD-1", reason: "time" },
      { alpaca_order_id: "be", kind: "exit", client_order_id: "uuid", reason: "breakeven" },
    ];
    expect(inferExitReason(f("leg-sl", 108), o)).toBe("trail"); // the leg alone would read as "stop"
    expect(inferExitReason(f("x", 100, T(20, 57)), o)).toBe("claude"); // late, but Claude said why
    expect(inferExitReason(f("mx", 100), o)).toBe("time");
    expect(inferExitReason(f("be", 100), o)).toBe("breakeven");
  });

  it("only known codes count: a free-text reason or an entry's reason is ignored", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: ["a"], reason: "target" },
      { alpaca_order_id: "x", kind: "exit", client_order_id: "stk-mylist-x-QYLD-1", reason: "signal turned OVERBOUGHT" },
    ];
    expect(inferExitReason(f("a", 95.2), o)).toBe("stop");
    expect(inferExitReason(f("x", 10), o)).toBe("exit");
  });

  it("the manager's own ids without a recorded reason", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "ms", client_order_id: "claude-free-ms-AMD-1" },
      { alpaca_order_id: "mo", client_order_id: "claude-free-mo-AMD-1" },
      { alpaca_order_id: "mx", client_order_id: "claude-free-mx-AMD-1" },
    ];
    expect(inferExitReason(f("ms", 100), o)).toBe("stop");
    expect(inferExitReason(f("mo", 100), o)).toBe("target");
    expect(inferExitReason(f("mx", 100), o)).toBe("exit");
  });

  it("a partial then a trail: the bigger slice names the trip", () => {
    const o: OrderMeta[] = [
      { alpaca_order_id: "e1", kind: "entry", stop_price: 95, target_price: 120, leg_ids: [] },
      { alpaca_order_id: "p", kind: "exit", reason: "partial" },
      { alpaca_order_id: "t", kind: "exit", reason: "trail" },
    ];
    const st = bookState(5000, [buy("AMD", 10, 100, T(15), "e1"), sell("AMD", 4, 105, T(16), "p"), sell("AMD", 6, 107, T(17), "t")], o);
    expect(st.closed[0]).toMatchObject({ exitReason: "trail", pnl: 62 });
  });
});
