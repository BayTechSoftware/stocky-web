import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, Position } from "../alpaca";
import { CLOSE_OUT_REASON, matchConfirmed, planCloseOut, roundQty, type CloseOutRow } from "./closeout";
import { bookState, inferExitReason, type BookPosition } from "./ledger";
import { ownerOf } from "./live";
import { alpacaModule, fakeAlpaca, fakeDb, fakeOrder, type FakeAlpaca, type FakeDb } from "./fakes";

let alp: FakeAlpaca;
vi.mock("@/lib/alpaca", () => alpacaModule(() => alp));
const { clientOrderId, closeOutBook } = await import("./engine");

const pos = (symbol: string, qty: number): BookPosition => ({ symbol, qty, avgCost: 100, openedAt: "2026-11-10T14:31:00Z" });
const acct = (symbol: string, qty: number): Position => ({ symbol, qty: String(qty), avg_entry_price: "100", current_price: "101", market_value: "0" });

/** A filled bracket entry of the free box on `symbol` with a live stop and target leg. */
function bracket(symbol: string, qty: number, id = `p-${symbol}`): Order {
  return fakeOrder({
    id, symbol, side: "buy", qty: String(qty), filled_qty: String(qty), filled_avg_price: "100", status: "filled",
    client_order_id: `stk-free-e-${symbol}-2026-11-10`, order_class: "bracket",
    legs: [
      fakeOrder({ id: `${id}-s`, symbol, side: "sell", type: "stop", stop_price: "94", status: "new", client_order_id: `leg-s-${id}` }),
      fakeOrder({ id: `${id}-t`, symbol, side: "sell", type: "limit", limit_price: "112", status: "new", client_order_id: `leg-t-${id}` }),
    ],
  });
}
const row = (o: Order, kind = "entry"): CloseOutRow => ({ symbol: o.symbol, kind, alpaca_order_id: o.id, leg_ids: (o.legs ?? []).map((l) => l.id) });
const filled = (...os: Order[]) => new Map(os.map((o) => [o.id, Number(o.filled_qty)]));

describe("planCloseOut", () => {
  it("cancels the box's own stop and target legs and sells only its own ledger quantity", () => {
    const p = bracket("AAPL", 10);
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10)], remote: [p], rows: [row(p)], ledgerFilled: filled(p), account: [acct("AAPL", 10)] });
    expect(plan.items).toEqual([{ symbol: "AAPL", side: "sell", qty: 10, cancel: ["p-AAPL-s", "p-AAPL-t"] }]);
    expect(plan.entries).toEqual([]);
  });

  it("shared symbol: sells only this box's 10 of the account's 25, never touches another box's orders", () => {
    const p = bracket("AAPL", 10);
    const claudeStop = fakeOrder({ id: "c-stop", symbol: "AAPL", side: "sell", type: "stop", status: "new", qty: "15", client_order_id: "claude-free-ms-AAPL-1" });
    const mylistStop = fakeOrder({ id: "m-stop", symbol: "AAPL", side: "sell", type: "stop", status: "new", qty: "5", client_order_id: "stk-mylist-s-AAPL-2026-11-10" });
    const plan = planCloseOut({
      key: "free", positions: [pos("AAPL", 10)], remote: [p, claudeStop, mylistStop], rows: [row(p)], ledgerFilled: filled(p), account: [acct("AAPL", 25)],
    });
    expect(plan.items[0].qty).toBe(10);
    expect(plan.items[0].cancel).not.toContain("c-stop");
    expect(plan.items[0].cancel).not.toContain("m-stop");
    expect(plan.items[0].skip).toBeUndefined();
  });

  it("owns an order by its stk-<key>- client id even without an ai_orders row (and its own stand-alone stop)", () => {
    const p = bracket("AAPL", 10);
    const stop = fakeOrder({ id: "own-stop", symbol: "AAPL", side: "sell", type: "stop", status: "new", client_order_id: "stk-free-s-AAPL-2026-11-11" });
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10)], remote: [p, stop], rows: [], ledgerFilled: filled(p), account: [acct("AAPL", 10)] });
    expect(plan.items[0].cancel.sort()).toEqual(["own-stop", "p-AAPL-s", "p-AAPL-t"]);
  });

  it("cancels a working (partly filled) entry parent itself, not its held legs", () => {
    const p = fakeOrder({
      id: "pp", symbol: "MSFT", side: "buy", qty: "10", filled_qty: "4", status: "partially_filled", client_order_id: "stk-free-e-MSFT-2026-11-11", order_class: "bracket",
      legs: [fakeOrder({ id: "pp-s", symbol: "MSFT", side: "sell", type: "stop", status: "held" })],
    });
    const plan = planCloseOut({ key: "free", positions: [pos("MSFT", 4)], remote: [p], rows: [row(p)], ledgerFilled: filled(p), account: [acct("MSFT", 4)] });
    expect(plan.items[0]).toMatchObject({ qty: 4, cancel: ["pp"] });
  });

  it("skips a symbol whose closing market order is already working (a second click never double-sells)", () => {
    const p = bracket("AAPL", 10);
    const x = fakeOrder({ id: "x1", symbol: "AAPL", side: "sell", type: "market", status: "accepted", qty: "10", client_order_id: "stk-free-x-AAPL-2026-11-11" });
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10)], remote: [p, x], rows: [row(p), row(x, "exit")], ledgerFilled: filled(p), account: [acct("AAPL", 10)] });
    expect(plan.items[0].skip).toMatch(/already working \(stk-free-x-AAPL-2026-11-11, accepted\)/);
  });

  it("another box's working market sell on the same symbol doesn't block this box", () => {
    const p = bracket("AAPL", 10);
    const other = fakeOrder({ id: "cx", symbol: "AAPL", side: "sell", type: "market", status: "accepted", client_order_id: "claude-free-x-AAPL-1" });
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10)], remote: [p, other], rows: [row(p)], ledgerFilled: filled(p), account: [acct("AAPL", 20)] });
    expect(plan.items[0].skip).toBeUndefined();
  });

  it("skips while an own order's fill isn't in the ledger yet (a close that just filled)", () => {
    const p = bracket("AAPL", 10);
    const x = fakeOrder({ id: "x1", symbol: "AAPL", side: "sell", type: "market", status: "filled", qty: "10", filled_qty: "10", client_order_id: "stk-free-x-AAPL-2026-11-11" });
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10)], remote: [p, x], rows: [row(p)], ledgerFilled: filled(p), account: [acct("AAPL", 0)] });
    expect(plan.items[0].skip).toMatch(/fills are still arriving/);
  });

  it("skips when the account holds fewer shares than the box's ledger, or the positions can't be read", () => {
    const p = bracket("AAPL", 10);
    const base = { key: "free", positions: [pos("AAPL", 10)], remote: [p], rows: [row(p)], ledgerFilled: filled(p) };
    expect(planCloseOut({ ...base, account: [acct("AAPL", 6)] }).items[0].skip).toMatch(/ledger and the account disagree/);
    expect(planCloseOut({ ...base, account: [] }).items[0].skip).toMatch(/ledger and the account disagree/);
    expect(planCloseOut({ ...base, account: null }).items[0].skip).toMatch(/couldn't read the account's positions/);
  });

  it("a short is bought to cover, for the box's own quantity", () => {
    const plan = planCloseOut({ key: "free", positions: [pos("AMD", -7)], remote: [], rows: [], ledgerFilled: new Map(), account: [acct("AMD", -7)] });
    expect(plan.items[0]).toMatchObject({ symbol: "AMD", side: "buy", qty: 7 });
    // the account's short is smaller than the box's → skip
    expect(planCloseOut({ key: "free", positions: [pos("AMD", -7)], remote: [], rows: [], ledgerFilled: new Map(), account: [acct("AMD", -3)] }).items[0].skip).toBeDefined();
  });

  it("fractional quantities lose the float noise of summed fills", () => {
    const st = bookState(1000, [
      { symbol: "NVDA", side: "buy", qty: 0.1, price: 100, transacted_at: "2026-11-10T15:00:00Z", order_id: "a" },
      { symbol: "NVDA", side: "buy", qty: 0.2, price: 100, transacted_at: "2026-11-10T15:01:00Z", order_id: "b" },
    ]);
    expect(st.positions.get("NVDA")!.qty).not.toBe(0.3); // 0.30000000000000004
    const plan = planCloseOut({ key: "free", positions: st.positions.values(), remote: [], rows: [], ledgerFilled: new Map(), account: [acct("NVDA", 0.3)] });
    expect(plan.items[0]).toMatchObject({ qty: 0.3, side: "sell" });
    expect(String(plan.items[0].qty)).toBe("0.3");
    expect(roundQty(1.0000000004)).toBe(1);
  });

  it("lists the box's own resting entries in symbols it doesn't hold, not another box's", () => {
    const mine = fakeOrder({ id: "e1", symbol: "TSLA", side: "buy", qty: "3", status: "new", client_order_id: "stk-free-e-TSLA-2026-11-11", order_class: "bracket" });
    const theirs = fakeOrder({ id: "e2", symbol: "META", side: "buy", qty: "3", status: "new", client_order_id: "stk-mylist-e-META-2026-11-11" });
    const plan = planCloseOut({ key: "free", positions: [], remote: [mine, theirs], rows: [row(mine)], ledgerFilled: new Map(), account: [] });
    expect(plan.items).toEqual([]);
    expect(plan.entries).toEqual([{ symbol: "TSLA", id: "e1", side: "buy", qty: 3 }]);
  });

  it("matchConfirmed skips what changed since the confirm list", () => {
    const p = bracket("AAPL", 10);
    const q = bracket("MSFT", 5);
    const plan = planCloseOut({ key: "free", positions: [pos("AAPL", 10), pos("MSFT", 5)], remote: [p, q], rows: [row(p), row(q)], ledgerFilled: filled(p, q), account: [acct("AAPL", 10), acct("MSFT", 5)] });
    const m = matchConfirmed(plan, [{ symbol: "AAPL", side: "sell", qty: 10 }, { symbol: "MSFT", side: "sell", qty: 3 }]);
    expect(m.items.find((i) => i.symbol === "AAPL")!.skip).toBeUndefined();
    expect(m.items.find((i) => i.symbol === "MSFT")!.skip).toMatch(/changed since you confirmed/);
    expect(matchConfirmed(plan, []).items.every((i) => i.skip)).toBe(true);
  });
});

describe("close-out client id + ledger reason", () => {
  it("uses the box's own exit id family, which the ledger reads as a close-out", () => {
    const cid = clientOrderId("free", "x", "AAPL", "2026-11-12");
    expect(cid).toBe("stk-free-x-AAPL-2026-11-12");
    expect(ownerOf(cid)).toBe("free");
    const orders = [{ alpaca_order_id: "x1", kind: "exit", client_order_id: cid, reason: CLOSE_OUT_REASON }];
    expect(inferExitReason({ order_id: "x1", price: 101, transacted_at: "2026-11-12T14:31:00Z" }, orders)).toBe("close-out");
  });
});

/* ---------------- closeOutBook against the fakes (nothing real is called) ---------------- */

const U = "user-1";
const FREE = { id: "book-free", user_id: U, key: "free", name: "Free Choice", start_cash: 5000, created_at: "2026-10-01T00:00:00Z", settings: { enabled: false } };
const MYLIST = { id: "book-my", user_id: U, key: "mylist", name: "My List", start_cash: 5000, created_at: "2026-10-01T00:00:00Z", settings: {} };

function world(): FakeDb {
  return fakeDb({ ai_books: [{ ...FREE }, { ...MYLIST }], ai_orders: [], ai_fills: [], ai_runs: [], ai_equity: [] });
}
/** Free box holds 10 AAPL (bracket with live legs); My List holds 4 AAPL with its own stop; the account holds 14. */
function sharedAapl() {
  alp.orders.push(bracket("AAPL", 10, "p1"));
  alp.fills.push({ id: "f1", order_id: "p1", symbol: "AAPL", side: "buy", qty: "10", price: "100", transaction_time: "2026-11-10T14:31:00Z" });
  alp.orders.push(fakeOrder({ id: "m1", symbol: "AAPL", side: "buy", qty: "4", filled_qty: "4", filled_avg_price: "99", status: "filled", client_order_id: "stk-mylist-e-AAPL-2026-11-10" }));
  alp.orders.push(fakeOrder({ id: "m1-stop", symbol: "AAPL", side: "sell", type: "stop", qty: "4", status: "new", client_order_id: "stk-mylist-s-AAPL-2026-11-10" }));
  alp.fills.push({ id: "f2", order_id: "m1", symbol: "AAPL", side: "buy", qty: "4", price: "99", transaction_time: "2026-11-10T14:32:00Z" });
  alp.positions.push(acct("AAPL", 14));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const close = (db: FakeDb, dry: boolean, confirmed?: { symbol: string; side: "sell" | "buy"; qty: number }[]) => closeOutBook({ admin: db as any, userId: U, bookKey: "free", dry, confirmed });

beforeEach(() => {
  alp = fakeAlpaca(); // 2026-11-11 22:30Z: market closed
});

describe("closeOutBook (fakes)", () => {
  it("preview places, cancels and logs nothing", async () => {
    const db = world();
    sharedAapl();
    const r = await close(db, true);
    expect(r.items).toMatchObject([{ symbol: "AAPL", side: "sell", qty: 10, status: "preview" }]);
    expect(alp.submitted).toEqual([]);
    expect(alp.cancelled).toEqual([]);
    expect(db.tables.ai_runs).toEqual([]);
  });

  it("cancels only the box's own legs, sells only its 10, records a close-out and logs the run; queued when closed", async () => {
    const db = world();
    sharedAapl();
    const r = await close(db, false, [{ symbol: "AAPL", side: "sell", qty: 10 }]);
    expect(alp.cancelled.sort()).toEqual(["p1-s", "p1-t"]);
    expect(alp.submitted).toEqual([{ symbol: "AAPL", qty: "10", side: "sell", type: "market", time_in_force: "day", client_order_id: "stk-free-x-AAPL-2026-11-11" }]);
    expect(r.items[0]).toMatchObject({ status: "queued", clientId: "stk-free-x-AAPL-2026-11-11" });
    expect(r.items[0].detail).toMatch(/queued for the open/);
    const rec = db.tables.ai_orders.find((o) => o.client_order_id === "stk-free-x-AAPL-2026-11-11")!;
    expect(rec).toMatchObject({ book_id: "book-free", kind: "exit", side: "sell", qty: 10, reason: CLOSE_OUT_REASON });
    expect(db.tables.ai_runs).toHaveLength(1);
    expect(db.tables.ai_runs[0]).toMatchObject({ book_id: "book-free", mode: "manual", error: null });
    const s = db.tables.ai_runs[0].summary as { phase: string; decisions: { action: string; symbol: string }[] };
    expect(s.phase).toBe("CLOSE");
    expect(s.decisions).toMatchObject([{ symbol: "AAPL", action: "sell" }]);
    expect(alp.orders.find((o) => o.id === "m1-stop")!.status).toBe("new"); // My List's stop untouched
  });

  it("a second click while the sell is queued places nothing more", async () => {
    const db = world();
    sharedAapl();
    await close(db, false, [{ symbol: "AAPL", side: "sell", qty: 10 }]);
    const r2 = await close(db, false, [{ symbol: "AAPL", side: "sell", qty: 10 }]);
    expect(alp.submitted).toHaveLength(1);
    expect(r2.items[0].status).toBe("skipped");
    expect(r2.items[0].skip).toMatch(/already working/);
  });

  it("acts only on what was confirmed", async () => {
    const db = world();
    sharedAapl();
    const r = await close(db, false, [{ symbol: "AAPL", side: "sell", qty: 8 }]);
    expect(alp.submitted).toEqual([]);
    expect(alp.cancelled).toEqual([]);
    expect(r.items[0].skip).toMatch(/changed since you confirmed/);
  });

  it("reports a filled sell during the session", async () => {
    const db = world();
    sharedAapl();
    alp.clock = { ...alp.clock, is_open: true, timestamp: "2026-11-12T15:00:00Z" };
    const r = await (async () => {
      const p = close(db, false, [{ symbol: "AAPL", side: "sell", qty: 10 }]);
      // Fill the sell as soon as it's placed.
      const t = setInterval(() => {
        const o = alp.orders.find((x) => x.client_order_id === "stk-free-x-AAPL-2026-11-12");
        if (o) Object.assign(o, { status: "filled", filled_qty: "10", filled_avg_price: "101.5" });
      }, 50);
      try {
        return await p;
      } finally {
        clearInterval(t);
      }
    })();
    expect(r.items[0].status).toBe("filled");
    expect(r.items[0].detail).toMatch(/filled at \$101\.50/);
  });

  it("refuses while another run holds the lock", async () => {
    const db = world();
    sharedAapl();
    db.rpcs.try_lock_ai_run = () => ({ data: false, error: null });
    await expect(close(db, false, [{ symbol: "AAPL", side: "sell", qty: 10 }])).rejects.toThrow(/in progress/);
    expect(alp.submitted).toEqual([]);
  });
});
