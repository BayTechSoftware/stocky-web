import { describe, expect, it } from "vitest";
import { fakeDb } from "./fakes";
import { loadAiView } from "./view";

function world() {
  const book = { id: "bk", key: "free", name: "Free Choice", start_cash: 5000, settings: {} };
  const orders: Record<string, unknown>[] = [];
  // An old working exit stop, then 300 newer filled-and-closed round trips in other symbols.
  orders.push({ id: "guard", book_id: "bk", symbol: "AAPL", side: "sell", kind: "exit", qty: 5, stop_price: 90, status: "new", filled_qty: 0, created_at: "2026-01-01T00:00:00Z", alpaca_order_id: "g1", leg_ids: [] });
  for (let i = 0; i < 300; i++) {
    orders.push({ id: `o${i}`, book_id: "bk", symbol: `S${i}`, side: "buy", kind: "entry", qty: 1, status: "filled", filled_qty: 1, created_at: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, alpaca_order_id: `a${i}`, leg_ids: [] });
  }
  // AAPL: an old closed trip's entry (stop 50), then the current position's entry (stop 95).
  orders.push({ id: "old", book_id: "bk", symbol: "AAPL", side: "buy", kind: "entry", qty: 5, stop_price: 50, status: "filled", filled_qty: 5, created_at: "2025-12-01T00:00:00Z", alpaca_order_id: "e0", leg_ids: [] });
  orders.push({ id: "cur", book_id: "bk", symbol: "AAPL", side: "buy", kind: "entry", qty: 5, stop_price: 95, status: "filled", filled_qty: 5, created_at: "2026-03-01T00:00:00Z", alpaca_order_id: "e1", leg_ids: [] });
  const fills: Record<string, unknown>[] = [];
  for (let i = 0; i < 1200; i++) {
    // 600 buy/sell pairs of 1 share of X at 10 → flat, plus AAPL held below.
    fills.push({ activity_id: `f${i}`, book_id: "bk", order_id: `x${i}`, symbol: "X", side: i % 2 ? "sell" : "buy", qty: 1, price: 10, transacted_at: `2026-02-02T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z` });
  }
  fills.push({ activity_id: "fa", book_id: "bk", order_id: "e1", symbol: "AAPL", side: "buy", qty: 5, price: 100, transacted_at: "2026-03-02T15:00:00Z" });
  return fakeDb({ ai_books: [book], ai_orders: orders, ai_fills: fills, ai_equity: [], ai_runs: [] });
}

describe("loadAiView (fixes #2, #11)", () => {
  it("reads the whole ledger: old open orders and the current entry's stop", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (await loadAiView(world() as any))!;
    const b = v.books[0];
    expect(v.ledgerError).toBeNull();
    expect(b.positions.map((p) => [p.symbol, p.qty])).toEqual([["AAPL", 5]]);
    expect(b.cash).toBe(4500); // 600 flat round trips + 5 AAPL at 100: nothing truncated
    expect(b.positions[0].stop).toBe(90); // the working guard stop, though it's older than the newest 200 orders
    expect(b.pending.map((o) => o.symbol)).toEqual(["AAPL"]);
  });

  it("shows an error instead of a flat box when the ledger can't be read", async () => {
    const db = world();
    db.fail.set("ai_fills:select", { message: "timeout" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (await loadAiView(db as any))!;
    expect(v.ledgerError).toMatch(/ai_fills: timeout/);
    expect(v.error).toMatch(/Ledger unavailable/);
  });
});
