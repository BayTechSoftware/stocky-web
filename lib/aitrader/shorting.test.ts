import { describe, expect, it } from "vitest";
import { bookState, fillRole, ledgerFills, shortOrderIds, type Fill } from "./ledger";
import { claudeOrderKind, claudeOrderRole, ownerOf, planLiveSync, tradesFromFills } from "./live";
import { shortBlockedSymbols, shortConflict, shortLookupSkip, type ShortCheck } from "./decide";
import { CLAUDE_LIMITS, RULES_LIMITS, defsForBook, effective, validateLimits } from "./limits";
import type { Order } from "../alpaca";

const T = (n: number) => `2026-11-10T15:${String(n).padStart(2, "0")}:00Z`;
const short = (qty: number, price: number, n = 0, order_id = "e1"): Fill => ({
  symbol: "AMD", side: "sell", qty, price, transacted_at: T(n), opensShort: true, order_id,
});
const buy = (qty: number, price: number, n = 1, order_id = "c1"): Fill => ({
  symbol: "AMD", side: "buy", qty, price, transacted_at: T(n), order_id,
});

describe("ledger shorts", () => {
  it("opens a short: negative qty, positive average price, proceeds in cash", () => {
    const st = bookState(5000, [short(10, 100)]);
    expect(st.positions.get("AMD")).toEqual({ symbol: "AMD", qty: -10, avgCost: 100, openedAt: T(0) });
    expect(st.cash).toBe(6000);
    expect(st.closedTrades).toBe(0);
  });

  it("adds to a short at a weighted average and keeps openedAt", () => {
    const p = bookState(5000, [short(10, 100, 0), short(30, 120, 5, "e2")]).positions.get("AMD")!;
    expect(p).toMatchObject({ qty: -40, avgCost: 115, openedAt: T(0) });
  });

  it("a partial cover realizes P&L and leaves the rest short at the same average", () => {
    const st = bookState(5000, [short(10, 100), buy(4, 90)]);
    expect(st.positions.get("AMD")).toMatchObject({ qty: -6, avgCost: 100, openedAt: T(0) });
    expect(st.realized).toBe(40);
    expect(st.cash).toBe(5000 + 1000 - 360);
    expect(st.closedTrades).toBe(0);
  });

  it("a full cover below the short price is a win", () => {
    const st = bookState(5000, [short(10, 100), buy(10, 90)]);
    expect(st.positions.has("AMD")).toBe(false);
    expect(st).toMatchObject({ realized: 100, closedTrades: 1, wins: 1, losses: 0, flats: 0, cash: 5100 });
  });

  it("a full cover above the short price is a loss", () => {
    const st = bookState(5000, [short(10, 100), buy(10, 112)]);
    expect(st).toMatchObject({ realized: -120, closedTrades: 1, wins: 0, losses: 1, cash: 4880 });
  });

  it("a breakeven cover is flat, and partial covers add up to one closed trade", () => {
    expect(bookState(5000, [short(10, 100), buy(10, 100)])).toMatchObject({ flats: 1, wins: 0, losses: 0 });
    expect(bookState(5000, [short(10, 100), buy(5, 90), buy(5, 95, 2)])).toMatchObject({ realized: 75, closedTrades: 1, wins: 1 });
  });

  it("covers no more than the short: the excess pays cash but opens no long", () => {
    const st = bookState(5000, [short(10, 100), buy(12, 90)]);
    expect(st.realized).toBe(100);
    expect(st.positions.has("AMD")).toBe(false);
    expect(st.cash).toBe(5000 + 1000 - 1080);
  });

  it("equity is right with negative qty: cash + qty * mark", () => {
    const st = bookState(5000, [short(10, 100)]);
    const p = st.positions.get("AMD")!;
    expect(st.cash + p.qty * 90).toBe(5100);
    expect(st.cash + p.qty * 110).toBe(4900);
  });

  it("a stray sell with no position and no flag only moves cash", () => {
    const st = bookState(5000, [{ symbol: "AMD", side: "sell", qty: 10, price: 100, transacted_at: T(0) }]);
    expect(st).toMatchObject({ cash: 6000, realized: 0, closedTrades: 0 });
    expect(st.positions.size).toBe(0);
  });

  it("an unflagged sell while short changes cash only, never the short", () => {
    const st = bookState(5000, [short(10, 100), { symbol: "AMD", side: "sell", qty: 3, price: 90, transacted_at: T(2) }]);
    expect(st.positions.get("AMD")).toMatchObject({ qty: -10, avgCost: 100 });
    expect(st.realized).toBe(0);
    expect(st.cash).toBe(6270);
  });

  it("a flagged sell against an open long closes the long and opens no short", () => {
    const st = bookState(5000, [buy(10, 90, 0), short(10, 100, 1)]);
    expect(st.positions.has("AMD")).toBe(false);
    expect(st).toMatchObject({ realized: 100, wins: 1 });
  });

  it("names every order that reduced a short, whichever kind it was", () => {
    expect([...bookState(5000, [short(10, 100), buy(4, 90, 1, "leg-stop"), buy(6, 90, 2, "x9")]).coverOrderIds]).toEqual(["leg-stop", "x9"]);
    expect(bookState(5000, [buy(4, 90, 1, "long")]).coverOrderIds.size).toBe(0);
  });
});

describe("linking fills to orders", () => {
  const orders = [
    { alpaca_order_id: "short-parent", side: "sell", kind: "entry", leg_ids: ["leg-stop", "leg-target"] },
    { alpaca_order_id: "long-parent", side: "buy", kind: "entry" },
    { alpaca_order_id: "long-exit", side: "sell", kind: "exit" },
    { alpaca_order_id: "cover", side: "buy", kind: "exit" },
    { alpaca_order_id: null, side: "sell", kind: "entry" },
  ];
  const row = (order_id: string, side: string) => ({ order_id, symbol: "AMD", side, qty: 1, price: 10, transacted_at: T(0) });

  it("flags only fills of a short entry's parent order", () => {
    const { shortEntries, covers } = shortOrderIds(orders);
    expect([...shortEntries]).toEqual(["short-parent"]);
    expect([...covers]).toEqual(["cover"]);
    const flags = ledgerFills(
      [row("short-parent", "sell"), row("leg-stop", "buy"), row("leg-target", "buy"), row("long-parent", "buy"), row("long-exit", "sell"), row("unknown", "sell")],
      shortEntries
    ).map((f) => f.opensShort);
    expect(flags).toEqual([true, false, false, false, false, false]);
  });

  it("copes with no recorded orders", () => {
    const { shortEntries } = shortOrderIds([]);
    expect(ledgerFills([row("x", "sell")], shortEntries)[0].opensShort).toBe(false);
  });

  it("labels a trade from its order, and merges partial fills keeping the label", () => {
    const shorts = new Set(["s"]);
    const covers = new Set(["c"]);
    expect(fillRole("sell", "s", shorts, covers)).toBe("short");
    expect(fillRole("buy", "c", shorts, covers)).toBe("cover");
    expect(fillRole("sell", "other", shorts, covers)).toBeNull();
    expect(fillRole("buy", "other", shorts, covers)).toBeNull();
    const t = tradesFromFills([
      { order_id: "s", symbol: "AMD", side: "sell", qty: 1, price: 10, transacted_at: T(0), role: "short" },
      { order_id: "s", symbol: "AMD", side: "sell", qty: 3, price: 12, transacted_at: T(1), role: "short" },
      { order_id: "b", symbol: "IBM", side: "buy", qty: 1, price: 5, transacted_at: T(2) },
    ]);
    expect(t.find((x) => x.symbol === "AMD")).toMatchObject({ qty: 4, price: 11.5, role: "short" });
    expect(t.find((x) => x.symbol === "IBM")?.role).toBeNull();
  });
});

describe("Claude order kinds", () => {
  it.each([
    ["buy", "claude-mylist-AMD-202611101015", null, "entry"],
    ["buy", "claude-free-f-AMD-202611101015", "f", "entry"],
    ["sell", "claude-mylist-s-AMD-202611101015", "s", "entry"],
    ["buy", "claude-mylist-x-AMD-202611101015", "x", "exit"],
    ["sell", "claude-free-x-AMD-202611101015", "x", "exit"],
    ["sell", "claude-mylist-fs-AMD-202611101015", "fs", "exit"],
    ["sell", "claude-mylist-fx-AMD-202611101015", "fx", "exit"],
    ["buy", "claude-mylist-S-202611101015", null, "entry"], // ticker S, long
    ["buy", "claude-mylist-X-202611101015", null, "entry"], // ticker X, long
    ["sell", "", null, "exit"],
  ])("%s %s", (side, id, role, kind) => {
    expect(claudeOrderRole(id)).toBe(role);
    expect(claudeOrderKind(side, id)).toBe(kind);
  });

  it("owners still resolve for short ids", () => {
    expect(ownerOf("claude-mylist-s-AMD-202611101015")).toBe("claude-mylist");
    expect(ownerOf("claude-free-s-AMD-202611101015")).toBe("claude-free");
  });

  it("records a new short entry as sell/entry with its stop above and target below", () => {
    const o = {
      id: "p1", client_order_id: "claude-mylist-s-AMD-202611101015", symbol: "AMD", side: "sell", qty: "5", filled_qty: "5",
      filled_avg_price: "100", status: "filled", type: "market", order_class: "bracket", created_at: T(0),
      legs: [
        { id: "l1", side: "buy", type: "limit", limit_price: "90", status: "new" },
        { id: "l2", side: "buy", type: "stop", stop_price: "105", status: "held" },
      ],
    } as unknown as Order;
    const stopFill = { id: "f1", order_id: "l2", symbol: "AMD", side: "buy" as const, qty: "5", price: "105", transaction_time: T(9) };
    const p = planLiveSync([], [o], [stopFill], new Map([["claude-mylist", "B"]]));
    expect(p.inserts[0]).toMatchObject({ side: "sell", kind: "entry", stop_price: 105, target_price: 90 });
    expect(p.fillRows[0]).toMatchObject({ book_id: "B", order_id: "l2", side: "buy" });
  });
});

describe("Rules books never buy into a short", () => {
  const ord = (o: Partial<{ symbol: string; side: string; status: string; client_order_id: string }>) => ({
    symbol: "AMD", side: "sell", status: "new", client_order_id: "claude-mylist-s-AMD-202611101015", ...o,
  });

  it("blocks symbols short on the account, by negative qty or by side", () => {
    expect([...shortBlockedSymbols([{ symbol: "AMD", qty: "-5" }, { symbol: "IBM", qty: "5" }], [])]).toEqual(["AMD"]);
    expect([...shortBlockedSymbols([{ symbol: "AMD", qty: "5", side: "short" }], [])]).toEqual(["AMD"]);
  });

  it("blocks a working Claude short entry from either Claude book", () => {
    expect(shortBlockedSymbols([], [ord({})]).has("AMD")).toBe(true);
    expect(shortBlockedSymbols([], [ord({ client_order_id: "claude-free-s-AMD-1", status: "partially_filled" })]).has("AMD")).toBe(true);
  });

  it("ignores finished shorts, Rules protective stops and look-alike ids", () => {
    const none = [
      ord({ status: "filled" }),
      ord({ status: "canceled" }),
      ord({ client_order_id: "stk-mylist-s-AMD-1731" }), // a Rules book's own stop
      ord({ client_order_id: "claude-mylist-x-AMD-1" }),
      ord({ client_order_id: "claude-mylist-S-1", symbol: "S", side: "buy" }), // long in ticker S
      ord({ side: "buy" }),
    ];
    expect(shortBlockedSymbols([], none).size).toBe(0);
  });

  it("empty account: nothing blocked", () => {
    expect(shortBlockedSymbols([], []).size).toBe(0);
  });

  it("gives a reason only for a conflicting symbol", () => {
    const check: ShortCheck = { ok: true, symbols: new Set(["AMD"]) };
    expect(shortConflict("AMD", check)).toMatch(/would cover/);
    expect(shortConflict("IBM", check)).toBeNull();
    expect(shortLookupSkip(check)).toBeNull();
  });

  it("a failed lookup stops every entry and says why", () => {
    const check: ShortCheck = { ok: false, error: "Alpaca 500: down" };
    expect(shortLookupSkip(check)).toMatch(/no new entries.*Alpaca 500: down/);
    expect(shortConflict("IBM", check)).not.toBeNull();
  });
});

describe("allow_short setting", () => {
  const def = CLAUDE_LIMITS.find((d) => d.key === "allow_short")!;

  it("is a Claude-only bool, off by default, in Risk & size", () => {
    expect(def).toMatchObject({ kind: "bool", def: false, group: "Risk & size", label: "Allow short selling" });
    expect(RULES_LIMITS.some((d) => d.key === "allow_short")).toBe(false);
    expect(defsForBook("mylist").some((d) => d.key === "allow_short")).toBe(false);
    expect(defsForBook("claude-free").some((d) => d.key === "allow_short")).toBe(true);
    expect(effective(CLAUDE_LIMITS, {}).allow_short).toBe(false);
  });

  it("validates like the form sends it", () => {
    expect(validateLimits(CLAUDE_LIMITS, { allow_short: "true" })).toEqual({ ok: true, settings: { allow_short: true } });
    expect(validateLimits(CLAUDE_LIMITS, { allow_short: "false" })).toEqual({ ok: true, settings: { allow_short: false } });
    expect(validateLimits(CLAUDE_LIMITS, { allow_short: "maybe" }).ok).toBe(false);
  });
});
