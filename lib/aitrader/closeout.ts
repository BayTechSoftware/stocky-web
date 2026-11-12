/**
 * "Close everything in this box" for a Rules box (mylist / free) — the pure plan.
 * Applied by closeOutBook() in ./engine (which syncs the ledger first and places the orders).
 *
 * All four boxes share ONE Alpaca paper account, so nothing here looks at the account's
 * position as a whole except as a sanity cap:
 *   - the quantity to close is the box's OWN ledger quantity (its own fills, lib/aitrader/ledger.ts);
 *   - the orders to cancel are the box's OWN working orders on that symbol: its client id family
 *     (stk-<key>-…) or a row in its ai_orders, plus the bracket legs of those;
 *   - a symbol is skipped (never sold twice) when a closing market order of the box is already working,
 *     or when one of its orders filled more than the ledger has recorded yet (fills still arriving).
 * Never Alpaca's DELETE /positions: that closes the whole account's position, other boxes' shares included.
 */
import type { Order, Position } from "../alpaca";
import type { BookPosition } from "./ledger";
import { ownerOf } from "./live";

/** Statuses of an order that can still fill or change (engine LIVE). */
export const CLOSE_LIVE = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding", "pending_replace"]);

/** The reason recorded on the close-out's ai_orders row. Matches ledger CLOSE_OUT_RE, so the trip reads "close-out". */
export const CLOSE_OUT_REASON = "close-out — the owner closed everything in this box";

/** The box's ai_orders rows the plan needs. */
export interface CloseOutRow {
  symbol: string;
  kind: string;
  alpaca_order_id: string | null;
  leg_ids?: string[] | null;
}

export interface CloseOutItem {
  symbol: string;
  /** sell = close a long, buy = buy to cover a short. */
  side: "sell" | "buy";
  /** The box's own quantity to close (always positive). */
  qty: number;
  /** The box's own working orders on this symbol to cancel first (stops, targets, resting entries). */
  cancel: string[];
  /** Set when nothing is placed for this symbol, and why. */
  skip?: string;
}

export interface CloseOutPlan {
  items: CloseOutItem[];
  /** The box's own resting entry orders in symbols it doesn't hold (would re-open a position): cancelled too. */
  entries: { symbol: string; id: string; side: string; qty: number }[];
}

/** Round a share quantity to Alpaca's 9 decimals (ledger sums of fractional fills carry float noise). */
export const roundQty = (q: number) => Math.round(q * 1e9) / 1e9;

/**
 * Is this Alpaca order the box's own? By client id family, or by an ai_orders row of the box (its id or a leg of it).
 */
function ownIds(key: string, remote: Order[], rows: CloseOutRow[]): Set<string> {
  const own = new Set<string>();
  for (const r of rows) {
    if (r.alpaca_order_id) own.add(r.alpaca_order_id);
    for (const l of r.leg_ids ?? []) own.add(l);
  }
  for (const o of remote) {
    if (ownerOf(o.client_order_id ?? "") === key) own.add(o.id);
  }
  // A parent we own owns its legs.
  for (const o of remote) if (own.has(o.id)) for (const l of o.legs ?? []) own.add(l.id);
  return own;
}

/** Every order and leg, flattened. */
function flatten(remote: Order[]): { o: Order; parent: Order | null }[] {
  const out: { o: Order; parent: Order | null }[] = [];
  for (const o of remote) {
    out.push({ o, parent: null });
    for (const l of o.legs ?? []) out.push({ o: l, parent: o });
  }
  return out;
}

/**
 * What closing the box means right now.
 *   key        — the box key (mylist | free)
 *   positions  — the box's own ledger positions (bookState().positions)
 *   remote     — the account's Alpaca orders (all boxes; ownership is decided here)
 *   rows       — the box's own ai_orders rows
 *   ledgerFilled — per Alpaca order id, the qty the ledger has recorded as filled (ai_fills of every box)
 *   account    — the account's positions (all boxes together), or null when they couldn't be read
 */
export function planCloseOut(opts: {
  key: string;
  positions: Iterable<BookPosition>;
  remote: Order[];
  rows: CloseOutRow[];
  ledgerFilled: Map<string, number>;
  account: Position[] | null;
}): CloseOutPlan {
  const { key, remote, rows, ledgerFilled, account } = opts;
  const own = ownIds(key, remote, rows);
  const mine = flatten(remote).filter(({ o }) => own.has(o.id));
  const live = mine.filter(({ o }) => CLOSE_LIVE.has(o.status));
  const items: CloseOutItem[] = [];
  const held = new Set<string>();

  for (const p of opts.positions) {
    const qty = roundQty(Math.abs(p.qty));
    if (qty <= 0) continue;
    held.add(p.symbol);
    const side: "sell" | "buy" = p.qty > 0 ? "sell" : "buy";
    const here = live.filter(({ o }) => o.symbol === p.symbol);
    // Cancel parents and stand-alone orders; a leg only when its parent isn't being cancelled (that takes the legs with it).
    const parents = new Set(here.filter(({ parent }) => !parent).map(({ o }) => o.id));
    const cancel = here.filter(({ parent }) => !parent || !parents.has(parent.id)).map(({ o }) => o.id);
    const item: CloseOutItem = { symbol: p.symbol, side, qty, cancel };

    const closing = here.find(({ o }) => o.side === side && o.type === "market");
    const unrecorded = mine.find(({ o }) => o.symbol === p.symbol && (Number(o.filled_qty) || 0) - (ledgerFilled.get(o.id) ?? 0) > 1e-9);
    const acct = account?.find((a) => a.symbol === p.symbol);
    const acctQty = acct ? Number(acct.qty) : 0; // Alpaca: negative for a short
    if (closing) {
      item.skip = `a closing ${side === "sell" ? "sell" : "buy-to-cover"} order is already working (${closing.o.client_order_id || closing.o.id}, ${closing.o.status}) — not placing a second one`;
    } else if (unrecorded) {
      item.skip = `an order of this box filled more than the ledger has recorded yet (${unrecorded.o.client_order_id || unrecorded.o.id}) — fills are still arriving; try again in a minute`;
    } else if (account == null) {
      item.skip = "couldn't read the account's positions to check the quantity — nothing placed";
    } else if (side === "sell" ? acctQty < qty - 1e-9 : -acctQty < qty - 1e-9) {
      item.skip = `the shared account holds ${acctQty} ${p.symbol}, less than this box's ${side === "sell" ? "" : "short "}${qty} — the ledger and the account disagree; nothing placed`;
    }
    items.push(item);
  }

  // Resting entries of the box in symbols it doesn't hold: a fill later would re-open a position.
  const entries = live
    .filter(({ o, parent }) => !parent && !held.has(o.symbol) && o.type !== "market" && rows.some((r) => r.alpaca_order_id === o.id && r.kind === "entry"))
    .map(({ o }) => ({ symbol: o.symbol, id: o.id, side: o.side, qty: roundQty((Number(o.qty) || 0) - (Number(o.filled_qty) || 0)) }));

  items.sort((a, b) => a.symbol.localeCompare(b.symbol));
  entries.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { items, entries };
}

/** What the owner confirmed (symbol + side + qty); the close acts only on items that still match it. */
export interface ConfirmedItem {
  symbol: string;
  side: "sell" | "buy";
  qty: number;
}

/** Skip items that changed since the owner saw the confirm list (a fill, a new position). */
export function matchConfirmed(plan: CloseOutPlan, confirmed: ConfirmedItem[]): CloseOutPlan {
  const items = plan.items.map((it) => {
    if (it.skip) return it;
    const c = confirmed.find((x) => x.symbol === it.symbol);
    if (!c || c.side !== it.side || Math.abs(roundQty(c.qty) - it.qty) > 1e-9) {
      return { ...it, skip: `changed since you confirmed (${c ? `${c.side} ${c.qty}` : "not in the list"} → ${it.side} ${it.qty}) — open the box and confirm again` };
    }
    return it;
  });
  return { items, entries: plan.entries };
}
