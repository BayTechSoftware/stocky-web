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

const MYLIST = { id: "book-my", user_id: U, key: "mylist", name: "My List", start_cash: 5000, created_at: "2026-10-01T00:00:00Z", settings: {} };
/** A My List book with one fresh BUY signal on AAPL (and bars), so a run wants to enter it. */
function entryWorld(settings: Record<string, unknown> = {}): FakeDb {
  alp.bars.AAPL = dailyBars(80, 100);
  return fakeDb({
    ai_books: [{ ...MYLIST, settings }],
    ai_orders: [], ai_fills: [], ai_equity: [], ai_runs: [],
    watchlist: [{ user_id: U, symbol: "AAPL" }],
    symbol_signals: [{ symbol: "AAPL", assessment: "BUY", tag: "SWEET", score: 80, updated_at: "2026-11-11T22:05:00Z" }],
  });
}

describe("engine harness: concurrent runs (fix #6)", () => {
  it("entry client ids are deterministic per book + kind + symbol + NY date", async () => {
    const db = entryWorld();
    const [r] = await run(db);
    expect(r.error).toBeUndefined();
    expect(alp.submitted.map((b) => b.client_order_id)).toEqual(["stk-mylist-e-AAPL-2026-11-11"]);
    expect(r.note).toMatch(/run lock not installed/);
  });

  it("a second run the same day can't place the same entry twice", async () => {
    const db = entryWorld();
    await run(db);
    db.tables.ai_orders = []; // as if the first run's insert was lost
    alp.orders = [];
    const [r2] = await run(db);
    expect(alp.submitted.length).toBe(1);
    expect(r2.decisions.some((d) => /already placed today/.test(d.reason))).toBe(true);
  });

  it("skips the user while another run holds the lock", async () => {
    const db = entryWorld();
    db.rpcs.try_lock_ai_run = () => ({ data: false, error: null });
    const [r] = await run(db);
    expect(r.note).toMatch(/another run .* in progress/);
    expect(alp.submitted).toEqual([]);
  });

  it("takes and releases the lock around the run", async () => {
    const db = entryWorld();
    const calls: string[] = [];
    db.rpcs.try_lock_ai_run = () => (calls.push("lock"), { data: true, error: null });
    db.rpcs.release_ai_run = () => (calls.push("release"), { data: null, error: null });
    await run(db);
    expect(calls).toEqual(["lock", "release"]);
  });
});

describe("engine harness: midday entries + re-entry cooldown (fix #8)", () => {
  it("defaults keep today's behaviour: a run during market hours may enter", async () => {
    alp.clock = { ...alp.clock, is_open: true, timestamp: "2026-11-11T15:00:00Z" };
    alp.latest = { AAPL: 100 };
    const db = entryWorld();
    db.tables.symbol_signals[0].updated_at = "2026-11-10T22:05:00Z";
    await run(db);
    expect(alp.submitted.length).toBe(1);
  });

  it("midday_entries off: no new trades while the market is open", async () => {
    alp.clock = { ...alp.clock, is_open: true, timestamp: "2026-11-11T15:00:00Z" };
    alp.latest = { AAPL: 100 };
    const db = entryWorld({ midday_entries: false });
    db.tables.symbol_signals[0].updated_at = "2026-11-10T22:05:00Z";
    const [r] = await run(db);
    expect(alp.submitted).toEqual([]);
    expect(r.decisions[0].reason).toMatch(/during market hours/);
  });

  it("reentry_cooldown_days 1: no same-day re-entry after a stop", async () => {
    const db = entryWorld({ reentry_cooldown_days: 1 });
    // Bought and stopped out today.
    db.tables.ai_orders.push({ id: "e", book_id: "book-my", symbol: "AAPL", side: "buy", kind: "entry", qty: 1, alpaca_order_id: "pe", leg_ids: ["ps"], status: "filled", filled_qty: 1, filled_avg: 100, created_at: "2026-11-10T22:30:00Z" });
    db.tables.ai_fills.push(
      { activity_id: "a1", book_id: "book-my", order_id: "pe", symbol: "AAPL", side: "buy", qty: 1, price: 100, transacted_at: "2026-11-11T14:31:00Z" },
      { activity_id: "a2", book_id: "book-my", order_id: "ps", symbol: "AAPL", side: "sell", qty: 1, price: 94, transacted_at: "2026-11-11T18:00:00Z" }
    );
    const [r] = await run(db);
    expect(alp.submitted).toEqual([]);
    expect(r.decisions.some((d) => /waiting 1 day before re-entering/.test(d.reason))).toBe(true);
  });
});

describe("engine harness: box size changes (fix #9)", () => {
  it("a size cut since the last snapshot doesn't trip the daily-loss halt, and cash follows the new size", async () => {
    const db = entryWorld();
    db.tables.ai_books[0].start_cash = 10000;
    db.tables.ai_equity.push({ book_id: "book-my", as_of: "2026-11-10", equity: 10000, cash: 10000 });
    db.tables.ai_cash_adjustments = [{ book_id: "book-my", at: "2026-11-11T16:00:00Z", amount: -5000 }];
    const [r] = await run(db);
    expect(r.halted).toBeUndefined();
    expect(r.cash).toBe(5000);
    expect(alp.submitted.length).toBe(1);
  });

  it("without the adjustment a real 50% drop still halts", async () => {
    const db = entryWorld();
    db.tables.ai_equity.push({ book_id: "book-my", as_of: "2026-11-10", equity: 10000, cash: 10000 });
    const [r] = await run(db);
    expect(r.halted).toMatch(/daily-loss halt/);
  });

  it("works before the table exists", async () => {
    const db = entryWorld();
    db.fail.set("ai_cash_adjustments:select", { message: 'relation "public.ai_cash_adjustments" does not exist' });
    const [r] = await run(db);
    expect(r.error).toBeUndefined();
    expect(r.cash).toBe(5000);
  });
});

describe("engine harness: gap down (fix #13)", () => {
  it("cancels a resting entry during the session when the stock gapped down too far", async () => {
    alp.clock = { ...alp.clock, is_open: true, timestamp: "2026-11-11T15:00:00Z" };
    const db = entryWorld({ max_gap_down_pct: 5, max_new_per_run: 0 });
    alp.bars.AAPL = dailyBars(80, 100, "2026-11-12"); // last bar = today (forming)
    const todayBar = alp.bars.AAPL[alp.bars.AAPL.length - 1];
    todayBar.t = "2026-11-11T05:00:00Z";
    todayBar.o = 80;
    alp.orders.push(fakeOrder({ id: "w1", symbol: "AAPL", client_order_id: "stk-mylist-e-AAPL-2026-11-10", status: "new" }));
    db.tables.ai_orders.push({ id: "w", book_id: "book-my", symbol: "AAPL", side: "buy", kind: "entry", qty: 3, limit_price: 101, alpaca_order_id: "w1", leg_ids: [], status: "new", filled_qty: 0, created_at: "2026-11-10T22:30:00Z" });
    const [r] = await run(db);
    expect(alp.cancelled).toEqual(["w1"]);
    expect(r.decisions.some((d) => d.action === "cancel" && /gapped down/.test(d.reason))).toBe(true);
  });
});

describe("engine harness: a second protective stop the same day (fix #6 follow-up)", () => {
  it("re-places a needed stop under <id>-2 when today's stop id is used", async () => {
    const db = world();
    alp.orders.push(fakeOrder({
      id: "p1", symbol: "AAPL", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", status: "filled",
      client_order_id: "stk-free-e-AAPL-2026-11-09", order_class: "oto", created_at: "2026-11-09T22:30:00Z",
      legs: [fakeOrder({ id: "ls", symbol: "AAPL", side: "sell", type: "stop", stop_price: "94", status: "canceled" })],
    }));
    db.tables.ai_orders.push({
      id: "o1", book_id: "book-free", symbol: "AAPL", side: "buy", kind: "entry", qty: 10, stop_price: 94, leg_ids: ["ls"],
      alpaca_order_id: "p1", client_order_id: "stk-free-e-AAPL-2026-11-09", status: "filled", filled_qty: 10, filled_avg: 100, created_at: "2026-11-09T22:30:00Z",
    });
    alp.fills.push({ id: "f1", order_id: "p1", symbol: "AAPL", side: "buy", qty: "10", price: "100", transaction_time: "2026-11-10T14:31:00Z" });
    alp.bars.AAPL = dailyBars(80, 100);
    alp.usedClientIds.add("stk-free-s-AAPL-2026-11-11"); // an earlier stop today, since cancelled
    const [r] = await run(db);
    expect(alp.submitted.map((b) => b.client_order_id)).toEqual(["stk-free-s-AAPL-2026-11-11-2"]);
    expect(r.decisions.some((d) => /placed a GTC stop/.test(d.reason))).toBe(true);
  });
});
