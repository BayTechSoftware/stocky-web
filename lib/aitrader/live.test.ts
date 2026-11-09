import { describe, expect, it } from "vitest";
import type { FillActivity, Order } from "../alpaca";
import { ownerOf, planLiveSync, tradesFromFills, type KnownOrder } from "./live";

const books = new Map([
  ["mylist", "B-rules"],
  ["claude-mylist", "B-claude"],
]);

const order = (o: Partial<Order>): Order =>
  ({
    id: "o1",
    client_order_id: "claude-mylist-CRWV-1",
    symbol: "CRWV",
    side: "buy",
    qty: "16",
    filled_qty: "16",
    filled_avg_price: "49.41",
    status: "filled",
    type: "market",
    order_class: "bracket",
    created_at: "2026-11-09T15:31:09Z",
    legs: [
      { id: "l1", type: "limit", limit_price: "53.75", status: "new" } as Order,
      { id: "l2", type: "stop", stop_price: "46.4", status: "held" } as Order,
    ],
    ...o,
  }) as Order;

const fill = (order_id: string, id = "f1"): FillActivity => ({
  id,
  order_id,
  symbol: "CRWV",
  side: "sell",
  qty: "16",
  price: "46.4",
  transaction_time: "2026-11-09T16:00:00Z",
});

const known = (o: Partial<KnownOrder>): KnownOrder => ({
  id: "row1",
  book_id: "B-rules",
  alpaca_order_id: "r1",
  leg_ids: ["rl1"],
  status: "new",
  filled_qty: 0,
  filled_avg: null,
  ...o,
});

describe("ownerOf", () => {
  it("maps each book's prefix and nothing else", () => {
    expect(ownerOf("claude-mylist-f-CRWV-1")).toBe("claude-mylist");
    expect(ownerOf("stk-free-e-IBM-1")).toBe("free");
    expect(ownerOf("21574f19-a325")).toBeNull();
  });
});

describe("planLiveSync", () => {
  it("records a new Claude order with its stop and target, and credits a leg's fill to the book", () => {
    const p = planLiveSync([], [order({})], [fill("l2")], books);
    expect(p.inserts).toHaveLength(1);
    expect(p.inserts[0]).toMatchObject({ book_id: "B-claude", kind: "entry", stop_price: 46.4, target_price: 53.75, leg_ids: ["l1", "l2"] });
    expect(p.fillRows).toEqual([expect.objectContaining({ book_id: "B-claude", order_id: "l2", qty: 16 })]);
  });

  it("does not insert Rules orders: the engine records its own", () => {
    const p = planLiveSync([], [order({ id: "r9", client_order_id: "stk-mylist-e-X-1", legs: [] })], [], books);
    expect(p.inserts).toHaveLength(0);
  });

  it("updates only what changed on a known order and never touches its prices or reason", () => {
    const k = known({});
    const r = order({ id: "r1", client_order_id: "stk-mylist-e-QYLD-1", status: "filled", filled_qty: "57", filled_avg_price: "17.1", legs: [] });
    expect(planLiveSync([k], [r], [], books).updates).toEqual([{ id: "row1", patch: { status: "filled", filled_qty: 57, filled_avg: 17.1 } }]);
    const same = known({ status: "filled", filled_qty: 57, filled_avg: 17.1 });
    expect(planLiveSync([same], [r], [], books).updates).toEqual([]);
  });

  it("ignores another account's orders and their fills", () => {
    const p = planLiveSync([], [order({ id: "x", client_order_id: "mine-by-hand" })], [fill("x")], books);
    expect(p.inserts).toHaveLength(0);
    expect(p.fillRows).toHaveLength(0);
  });
});

describe("tradesFromFills", () => {
  it("merges partial fills at their average price, newest first", () => {
    const t = tradesFromFills([
      { order_id: "a", symbol: "HIMS", side: "buy", qty: 1, price: 10, transacted_at: "2026-11-09T15:00:01Z" },
      { order_id: "a", symbol: "HIMS", side: "buy", qty: 3, price: 12, transacted_at: "2026-11-09T15:00:00Z" },
      { order_id: "b", symbol: "AMD", side: "sell", qty: 2, price: 5, transacted_at: "2026-11-09T16:00:00Z" },
    ]);
    expect(t.map((x) => x.symbol)).toEqual(["AMD", "HIMS"]);
    expect(t[1]).toMatchObject({ qty: 4, price: 11.5, at: "2026-11-09T15:00:00Z" });
  });
});
