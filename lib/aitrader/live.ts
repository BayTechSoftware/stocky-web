/**
 * Live ledger sync — brings all four books up to date from Alpaca between their
 * runs, so positions and trades show as they happen. Pure planning here (tested);
 * applied by the syncLive server action. Read-only towards Alpaca: nothing is
 * ever placed, cancelled or replaced from this path.
 */
import type { FillActivity, Order } from "../alpaca";

export interface KnownOrder {
  id: string;
  book_id: string;
  alpaca_order_id: string | null;
  leg_ids: string[] | null;
  status: string;
  filled_qty: number;
  filled_avg: number | null;
}

/** client_order_id prefix -> book key. Longest match isn't needed: the prefixes are disjoint. */
const OWNERS: [string, string][] = [
  ["claude-mylist-", "claude-mylist"],
  ["claude-free-", "claude-free"],
  ["stk-mylist-", "mylist"],
  ["stk-free-", "free"],
];

export function ownerOf(clientOrderId: string): string | null {
  for (const [prefix, key] of OWNERS) if (clientOrderId.startsWith(prefix)) return key;
  return null;
}

const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

export function planLiveSync(
  known: KnownOrder[],
  remote: Order[],
  fills: FillActivity[],
  bookIdByKey: Map<string, string>
) {
  const bookOf = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const k of known) {
    if (k.alpaca_order_id) {
      bookOf.set(k.alpaca_order_id, k.book_id);
      knownIds.add(k.alpaca_order_id);
    }
    for (const l of k.leg_ids ?? []) bookOf.set(l, k.book_id);
  }

  const byId = new Map<string, Order>();
  const inserts: Record<string, unknown>[] = [];
  for (const o of remote) {
    byId.set(o.id, o);
    for (const l of o.legs ?? []) byId.set(l.id, l);
    const key = ownerOf(o.client_order_id ?? "");
    const owner = key ? bookIdByKey.get(key) : undefined;
    if (owner) {
      bookOf.set(o.id, owner);
      for (const l of o.legs ?? []) bookOf.set(l.id, owner);
    }
    // The Mac records Claude's orders when a run ends; show them as soon as they exist.
    // Rules orders are always recorded by the engine that placed them.
    if (owner && key!.startsWith("claude-") && !knownIds.has(o.id)) {
      const legs = o.legs ?? [];
      inserts.push({
        book_id: owner,
        symbol: o.symbol,
        side: o.side,
        kind: o.side === "buy" ? "entry" : "exit",
        qty: num(o.qty) ?? 0,
        limit_price: num(o.limit_price),
        stop_price: num(legs.find((l) => l.type === "stop" || l.type === "stop_limit")?.stop_price),
        target_price: num(legs.find((l) => l.type === "limit")?.limit_price),
        alpaca_order_id: o.id,
        leg_ids: legs.map((l) => l.id),
        client_order_id: o.client_order_id,
        status: o.status,
        filled_qty: num(o.filled_qty) ?? 0,
        filled_avg: num(o.filled_avg_price),
        created_at: o.created_at,
      });
    }
  }

  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  for (const k of known) {
    const r = k.alpaca_order_id ? byId.get(k.alpaca_order_id) : undefined;
    if (!r) continue;
    const patch: Record<string, unknown> = {};
    if (r.status !== k.status) patch.status = r.status;
    const fq = num(r.filled_qty) ?? 0;
    if (fq !== k.filled_qty) patch.filled_qty = fq;
    const fa = num(r.filled_avg_price);
    if (fa !== k.filled_avg) patch.filled_avg = fa;
    const legIds = (r.legs ?? []).map((l) => l.id);
    if (legIds.length && (k.leg_ids?.length ?? 0) === 0) patch.leg_ids = legIds;
    if (Object.keys(patch).length) updates.push({ id: k.id, patch });
  }

  const fillRows = fills
    .filter((f) => bookOf.has(f.order_id))
    .map((f) => ({
      activity_id: f.id,
      book_id: bookOf.get(f.order_id)!,
      order_id: f.order_id,
      symbol: f.symbol,
      side: f.side,
      qty: Number(f.qty),
      price: Number(f.price),
      transacted_at: f.transaction_time,
    }));

  return { updates, inserts, fillRows };
}

/** One line per order for a box's "Today's trades": partial fills merged, newest first. */
export function tradesFromFills(
  fills: { order_id: string; symbol: string; side: string; qty: number; price: number; transacted_at: string }[]
): { at: string; symbol: string; side: string; qty: number; price: number }[] {
  const by = new Map<string, { at: string; symbol: string; side: string; qty: number; cost: number }>();
  for (const f of fills) {
    const t = by.get(f.order_id) ?? { at: f.transacted_at, symbol: f.symbol, side: f.side, qty: 0, cost: 0 };
    t.qty += f.qty;
    t.cost += f.qty * f.price;
    if (f.transacted_at < t.at) t.at = f.transacted_at;
    by.set(f.order_id, t);
  }
  return Array.from(by.values())
    .map((t) => ({ at: t.at, symbol: t.symbol, side: t.side, qty: t.qty, price: t.qty > 0 ? t.cost / t.qty : 0 }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
