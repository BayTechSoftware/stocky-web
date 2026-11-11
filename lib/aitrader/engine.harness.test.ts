import { beforeEach, describe, expect, it, vi } from "vitest";
import { alpacaModule, dailyBars, fakeAlpaca, fakeDb, fakeOrder, type FakeAlpaca, type FakeDb } from "./fakes";

let alp: FakeAlpaca;
vi.mock("@/lib/alpaca", () => alpacaModule(() => alp));
const { runAiTrader } = await import("./engine");

const U = "user-1";
const BOOK = { id: "book-free", user_id: U, key: "free", name: "Free Choice", start_cash: 5000, created_at: "2026-10-01T00:00:00Z", settings: { max_new_per_run: 0 } };

function world(): FakeDb {
  return fakeDb({ ai_books: [{ ...BOOK }], ai_orders: [], ai_fills: [], watchlist: [], symbol_signals: [], ai_equity: [], ai_runs: [] });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (db: FakeDb, mode: "cron" | "manual" | "dry" = "manual") => runAiTrader({ admin: db as any, mode, userId: U });

beforeEach(() => {
  alp = fakeAlpaca();
});

describe("engine harness: ledger reads (fix #2)", () => {
  it("a failed ai_fills read fails the run before anything is placed", async () => {
    const db = world();
    db.fail.set("ai_fills:select", { message: "timeout" });
    const [r] = await run(db);
    expect(r.error).toMatch(/ai_fills: timeout/);
    expect(alp.submitted).toEqual([]);
    // …and leaves a trace per book (fix #12)
    expect(db.tables.ai_runs.length).toBe(1);
    expect(db.tables.ai_runs[0].error).toMatch(/ai_fills/);
  });
});

describe("engine harness: unrecorded orders (fix #4)", () => {
  it("attributes fills by the stk-<book> client id and records the missing order", async () => {
    const db = world();
    const o = fakeOrder({
      id: "alp-1", symbol: "AAPL", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", status: "filled",
      client_order_id: "stk-free-e-AAPL-2026-11-10", order_class: "bracket", created_at: "2026-11-10T22:30:00Z",
      legs: [fakeOrder({ id: "leg-stop", symbol: "AAPL", side: "sell", type: "stop", stop_price: "94", status: "new" })],
    });
    alp.orders.push(o);
    alp.fills.push({ id: "f1", order_id: "alp-1", symbol: "AAPL", side: "buy", qty: "10", price: "100", transaction_time: "2026-11-11T14:31:00Z" });
    alp.bars.AAPL = dailyBars(80, 100);
    const [r] = await run(db);
    expect(r.error).toBeUndefined();
    expect(db.tables.ai_fills.map((f) => f.book_id)).toEqual(["book-free"]);
    const rec = db.tables.ai_orders.find((x) => x.alpaca_order_id === "alp-1")!;
    expect(rec.kind).toBe("entry");
    expect(rec.stop_price).not.toBeNull(); // recorded from the leg (then re-anchored to the fill)
    expect(r.note).toMatch(/placed but missing from the ledger/);
    // The live leg counts as the stop: no second stop placed.
    expect(alp.submitted).toEqual([]);
  });

  it("ignores another book's orders (claude- prefix)", async () => {
    const db = world();
    alp.orders.push(fakeOrder({ id: "c1", symbol: "MSFT", client_order_id: "claude-free-MSFT-1", status: "filled", filled_qty: "1" }));
    alp.fills.push({ id: "f2", order_id: "c1", symbol: "MSFT", side: "buy", qty: "1", price: "1", transaction_time: "2026-11-11T14:31:00Z" });
    await run(db);
    expect(db.tables.ai_fills).toEqual([]);
    expect(db.tables.ai_orders).toEqual([]);
  });
});

describe("engine harness: failed exit keeps a stop (fix #5)", () => {
  it("re-checks the cancelled legs and places a stop when the sell is rejected", async () => {
    const db = world();
    db.tables.ai_books[0].settings = { max_new_per_run: 0, max_hold_days: 5 };
    const parent = fakeOrder({
      id: "p1", symbol: "AAPL", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", status: "filled",
      client_order_id: "stk-free-e-AAPL-2026-10-20", order_class: "bracket", created_at: "2026-10-20T22:30:00Z",
      legs: [
        fakeOrder({ id: "ls", symbol: "AAPL", side: "sell", type: "stop", stop_price: "94", status: "new" }),
        fakeOrder({ id: "lt", symbol: "AAPL", side: "sell", type: "limit", limit_price: "112", status: "new" }),
      ],
    });
    alp.orders.push(parent);
    db.tables.ai_orders.push({
      id: "o1", book_id: "book-free", symbol: "AAPL", side: "buy", kind: "entry", qty: 10, limit_price: 101, stop_price: null,
      target_price: null, leg_ids: ["ls", "lt"], alpaca_order_id: "p1", client_order_id: parent.client_order_id, status: "filled",
      filled_qty: 10, filled_avg: 100, created_at: "2026-10-20T22:30:00Z",
    });
    alp.fills.push({ id: "f1", order_id: "p1", symbol: "AAPL", side: "buy", qty: "10", price: "100", transaction_time: "2026-10-21T14:31:00Z" });
    alp.bars.AAPL = dailyBars(80, 100);
    alp.rejectSubmit = (b) => (b.type === "market" ? "Alpaca 403: market closed" : null);

    const [r] = await run(db);
    expect(alp.cancelled.sort()).toEqual(["ls", "lt"]);
    const stops = alp.submitted.filter((b) => b.type === "stop");
    expect(stops.length).toBe(1);
    expect(stops[0].qty).toBe("10");
    expect(r.decisions.some((d) => /rejected by Alpaca: Alpaca 403/.test(d.reason))).toBe(true);
    expect(r.decisions.some((d) => /placed a GTC stop/.test(d.reason))).toBe(true);
  });
});
