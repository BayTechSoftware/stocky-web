/**
 * Test doubles for the engine (tests only): an in-memory Supabase client that
 * understands the query-builder calls the engine makes, and a fake Alpaca paper
 * account. Not imported by app code.
 */
import type { Bar, Clock, FillActivity, Order, Position } from "../alpaca";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** "table:op" → error message (op = select | insert | upsert | update | delete); `times` how often (default always). */
  fail: Map<string, { message: string; times?: number }>;
  rpcs: Record<string, (args: Row) => { data: unknown; error: { message: string; code?: string } | null }>;
  from(table: string): FakeQuery;
  rpc(name: string, args: Row): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  /** Every write: [table, op, payload]. */
  writes: [string, string, unknown][];
}

const KEYS: Record<string, string[]> = {
  ai_orders: ["alpaca_order_id"],
  ai_fills: ["activity_id"],
  ai_equity: ["book_id", "as_of"],
  symbol_signals: ["symbol"],
  ai_run_locks: ["user_id"],
};

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null; count?: number }> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private orders: [string, boolean][] = [];
  private lim?: number;
  private rng?: [number, number];
  private single = false;
  private returning = false;
  private payload: Row[] = [];
  private patch: Row = {};
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  constructor(private db: FakeDb, private table: string) {}

  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[c]));
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  lt(c: string, v: string) {
    this.filters.push((r) => String(r[c]) < v);
    return this;
  }
  gt(c: string, v: string) {
    this.filters.push((r) => String(r[c]) > v);
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c]) >= v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  like() {
    return this;
  }
  or() {
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.orders.push([c, o?.ascending !== false]);
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(a: number, b: number) {
    this.rng = [a, b];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOpts = opts ?? {};
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  private exec(): { data: unknown; error: { message: string } | null } {
    const f = this.db.fail.get(`${this.table}:${this.op}`);
    if (f && (f.times == null || f.times > 0)) {
      if (f.times != null) f.times--;
      return { data: null, error: { message: f.message } };
    }
    const t = (this.db.tables[this.table] ??= []);
    const match = (r: Row) => this.filters.every((fn) => fn(r));
    if (this.op === "select") {
      let rows = t.filter(match);
      for (const [c, asc] of this.orders.slice().reverse()) {
        rows = rows.slice().sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : String(x[c]) > String(y[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) rows = rows.slice(0, this.lim);
      return { data: this.single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })), error: null };
    }
    this.db.writes.push([this.table, this.op, this.op === "update" ? this.patch : this.payload]);
    if (this.op === "update") {
      for (const r of t.filter(match)) Object.assign(r, this.patch);
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = t.filter((r) => !match(r));
      return { data: null, error: null };
    }
    const keys = this.upsertOpts.onConflict?.split(",") ?? KEYS[this.table] ?? ["id"];
    const out: Row[] = [];
    for (const p of this.payload) {
      const row: Row = { id: uuid(), created_at: new Date().toISOString(), leg_ids: [], filled_qty: 0, ...p };
      const hit = this.op === "upsert" ? t.find((r) => keys.every((k) => r[k] != null && r[k] === row[k])) : undefined;
      if (hit) {
        if (!this.upsertOpts.ignoreDuplicates) Object.assign(hit, p);
        continue;
      }
      t.push(row);
      out.push({ ...row });
    }
    return { data: this.returning ? out : null, error: null };
  }

  then<A = { data: unknown; error: { message: string } | null }, B = never>(
    ok?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.exec())
      .then(ok, bad);
  }
}

export function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables,
    fail: new Map(),
    writes: [],
    rpcs: {
      get_alpaca_credentials: () => ({ data: { key_id: "PKTEST", secret: "s" }, error: null }),
    },
    from: (table) => new FakeQuery(db, table),
    rpc: async (name, args) =>
      db.rpcs[name]?.(args) ?? { data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: "PGRST202" } },
  };
  return db;
}

/* ---------------- fake Alpaca ---------------- */

export interface FakeAlpaca {
  clock: Clock;
  orders: Order[];
  fills: FillActivity[];
  positions: Position[];
  bars: Record<string, Bar[]>;
  latest: Record<string, number>;
  submitted: Record<string, unknown>[];
  cancelled: string[];
  /** Make the next submit with this client id prefix fail. */
  rejectSubmit?: (body: Record<string, unknown>) => string | null;
  /** Status getOrder reports for an id (overrides the stored order). */
  statusOf: Map<string, string>;
  /** Client ids already used (Alpaca rejects a duplicate). */
  usedClientIds: Set<string>;
}

let oid = 0;
export function fakeOrder(p: Partial<Order> & { symbol: string }): Order {
  return {
    id: p.id ?? `ord-${++oid}`,
    client_order_id: p.client_order_id ?? `x-${oid}`,
    side: "buy",
    qty: "1",
    filled_qty: "0",
    filled_avg_price: null,
    status: "new",
    type: "limit",
    order_class: "simple",
    created_at: new Date().toISOString(),
    legs: null,
    ...p,
  };
}

export function fakeAlpaca(now = "2026-11-11T22:30:00Z"): FakeAlpaca {
  return {
    clock: { is_open: false, timestamp: now, next_open: "", next_close: "" },
    orders: [],
    fills: [],
    positions: [],
    bars: {},
    latest: {},
    submitted: [],
    cancelled: [],
    statusOf: new Map(),
    usedClientIds: new Set(),
  };
}

/** The lib/alpaca module surface, backed by a FakeAlpaca (use with vi.mock). */
export function alpacaModule(f: () => FakeAlpaca) {
  const find = (id: string) => {
    for (const o of f().orders) {
      if (o.id === id) return o;
      for (const l of o.legs ?? []) if (l.id === id) return l;
    }
    return undefined;
  };
  return {
    AlpacaError: class extends Error {},
    getPaperAccount: async () => ({ account_number: "PA123", status: "ACTIVE", cash: "0", equity: "0", buying_power: "0" }),
    getClock: async () => f().clock,
    isTradingDay: async () => true,
    getCalendar: async (_c: unknown, from: string, to: string) => {
      const out: { date: string; open: string; close: string }[] = [];
      for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
        const d = new Date(t);
        if (d.getUTCDay() % 6 !== 0) out.push({ date: d.toISOString().slice(0, 10), open: "09:30", close: "16:00" });
      }
      return out;
    },
    listOrders: async () => f().orders,
    listFills: async () => f().fills,
    getPositions: async () => f().positions,
    getDailyBars: async (_c: unknown, symbols: string[]) => Object.fromEntries(symbols.filter((s) => f().bars[s]).map((s) => [s, f().bars[s].slice()])),
    getLatestPrices: async () => f().latest,
    submitOrder: async (_c: unknown, body: Record<string, unknown>) => {
      const why = f().rejectSubmit?.(body);
      if (why) throw new Error(why);
      const cid = String(body.client_order_id);
      if (f().usedClientIds.has(cid)) throw new Error("Alpaca 422: client_order_id must be unique");
      f().usedClientIds.add(cid);
      f().submitted.push(body);
      const o = fakeOrder({
        symbol: String(body.symbol),
        side: body.side as "buy" | "sell",
        qty: String(body.qty),
        type: String(body.type),
        client_order_id: cid,
        status: "accepted",
        order_class: String(body.order_class ?? "simple"),
        stop_price: (body.stop_price as string) ?? null,
        limit_price: (body.limit_price as string) ?? null,
      });
      f().orders.push(o);
      return o;
    },
    cancelOrder: async (_c: unknown, id: string) => {
      f().cancelled.push(id);
      const o = find(id);
      if (o) o.status = "canceled";
    },
    getOrder: async (_c: unknown, id: string) => {
      const o = find(id);
      if (!o) throw new Error("Alpaca 404");
      const st = f().statusOf.get(id);
      return st ? { ...o, status: st } : o;
    },
    replaceOrder: async (_c: unknown, id: string, body: Record<string, string>) => {
      const o = find(id);
      if (!o) throw new Error("Alpaca 404");
      o.status = "replaced";
      const nu = { ...o, id: `${id}-r`, status: "new", ...body };
      f().orders.push(nu);
      return nu;
    },
  };
}

/** `n` daily bars ending the day before `lastDate`, a gentle uptrend around `px`. */
export function dailyBars(n: number, px: number, lastDate = "2026-11-11"): Bar[] {
  const end = Date.parse(`${lastDate}T05:00:00Z`);
  const out: Bar[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const c = px * (1 - i * 0.001);
    out.push({ t: new Date(end - i * 86_400_000).toISOString(), o: c, h: c * 1.01, l: c * 0.99, c, v: 1e6 } as Bar);
  }
  return out;
}
