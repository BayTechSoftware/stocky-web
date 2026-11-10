/**
 * Book ledger — rebuilds a book's cash and positions from its own fills.
 *
 * Both books live inside ONE Alpaca paper account; fills are attributed to a
 * book by order id (entry parent, bracket legs, or exit order). Fills are the
 * ground truth, so cash and cost basis can't drift from what actually executed.
 */

import { claudeOrderRole } from "./live";

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  transacted_at: string;
  order_id?: string; // the Alpaca order that executed (parent or bracket leg)
  opensShort?: boolean; // this sell is a short entry (see shortOrderIds)
}

export interface BookPosition {
  symbol: string;
  qty: number; // negative = short
  avgCost: number; // average short price (positive) when short
  openedAt: string; // first fill of the currently-open position
}

export interface BookState {
  cash: number;
  realized: number; // realized P&L from closed shares
  closedTrades: number; // sells that fully closed a position
  wins: number; // of those, closed with a profit (> 0)
  losses: number; // closed with a loss (< 0)
  flats: number; // closed at breakeven (|P&L| < 1 cent) — neither a win nor a loss
  positions: Map<string, BookPosition>;
  /** Orders with a buy fill that reduced a short (exit orders and bracket legs alike). */
  coverOrderIds: Set<string>;
  /** Every completed round trip (flat -> position -> flat), oldest first. */
  closed: ClosedTrade[];
  /** Realized P&L of each exit order (sell of a long / cover of a short), including partial exits of a still-open position. */
  exitPnl: Map<string, number>;
}

export type ExitReason = "stop" | "target" | "close-out" | "claude" | "exit";

/** One completed round trip in a single symbol: position goes 0 -> non-zero -> 0. */
export interface ClosedTrade {
  symbol: string;
  direction: "long" | "short";
  qty: number; // largest position size held during the trip
  avgEntry: number;
  avgExit: number;
  pnl: number; // $
  pnlPct: number; // pnl / entry cost of the shares closed * 100
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  entryOrderId: string | null; // the first entry order of the trip
  exitReason: ExitReason;
  r: number | null; // pnl / (|avgEntry - initial stop| * qty); null without a usable stop
}

/** The slice of an ai_orders row the ledger needs to explain a trip (initial stop, why it ended). */
export interface OrderMeta {
  alpaca_order_id?: string | null;
  leg_ids?: string[] | null;
  kind?: string | null;
  client_order_id?: string | null;
  reason?: string | null;
  stop_price?: number | null;
  target_price?: number | null;
}

const CLOSE_OUT_RE = /close-?out|flatten|flat-?by|end of day|\beod\b/i;
/** New York wall-clock minutes since midnight (DST-safe). */
function nyMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}
/** Claude's FLATTEN phase and the Mac's fraction close-out start by 15:50 NY; before that a sell is a deliberate exit. */
const CLOSE_OUT_FROM_MIN = 15 * 60 + 30;

/**
 * Why an exit fill happened. Exit reasons aren't stored, so this infers it:
 * bracket legs by which price they hit (the leg order in leg_ids isn't reliable), the Mac's
 * fraction orders (-fs- stop / -fx- target or close-out) and Claude's -x- exits by client id and time.
 */
export function inferExitReason(
  fill: { order_id?: string; price: number; transacted_at: string },
  orders: OrderMeta[]
): ExitReason {
  const id = fill.order_id;
  if (!id) return "exit";
  const parent = orders.find((o) => o.leg_ids?.includes(id));
  if (parent) {
    const s = parent.stop_price ?? null;
    const t = parent.target_price ?? null;
    if (s != null && t != null) return Math.abs(fill.price - s) <= Math.abs(fill.price - t) ? "stop" : "target";
    if (s != null) return "stop";
    if (t != null) return "target";
    return "exit";
  }
  const o = orders.find((x) => x.alpaca_order_id === id);
  if (!o) return "exit";
  if (o.reason && CLOSE_OUT_RE.test(o.reason)) return "close-out";
  const cid = o.client_order_id ?? "";
  const role = claudeOrderRole(cid);
  if (role === "fs") return "stop";
  if (role === "x" || role === "fx") {
    if (nyMinutes(fill.transacted_at) >= CLOSE_OUT_FROM_MIN) return "close-out";
    return role === "fx" ? "target" : "claude";
  }
  // Rules engine: -s- is its stand-alone protective stop, -x- a rule exit (signal / time stop).
  if (/^stk-[a-z]+-s-/.test(cid)) return "stop";
  return "exit";
}

interface Trip {
  direction: "long" | "short";
  openedAt: string;
  maxQty: number;
  entryQty: number;
  entryCost: number;
  exitQty: number;
  exitValue: number;
  pnl: number;
  entryOrderId: string | null;
  exits: { qty: number; reason: ExitReason; at: string }[];
}

type OrderRef = { alpaca_order_id?: string | null; side: unknown; kind: unknown };

/** Which Alpaca order ids are short entries, and which are recorded buy-to-cover exits. Legs are never short entries. */
export function shortOrderIds(orders: OrderRef[]): { shortEntries: Set<string>; covers: Set<string> } {
  const shortEntries = new Set<string>();
  const covers = new Set<string>();
  for (const o of orders) {
    if (!o.alpaca_order_id) continue;
    if (o.kind === "entry" && o.side === "sell") shortEntries.add(o.alpaca_order_id);
    if (o.kind === "exit" && o.side === "buy") covers.add(o.alpaca_order_id);
  }
  return { shortEntries, covers };
}

/** ai_fills rows as ledger fills, flagging the ones that execute a short entry. */
export function ledgerFills(
  rows: { order_id?: unknown; symbol: unknown; side: unknown; qty: unknown; price: unknown; transacted_at: unknown }[],
  shortEntries: Set<string>
): Fill[] {
  return rows.map((f) => ({
    symbol: f.symbol as string,
    side: f.side as "buy" | "sell",
    qty: f.qty as number,
    price: f.price as number,
    transacted_at: f.transacted_at as string,
    order_id: f.order_id as string | undefined,
    opensShort: shortEntries.has(f.order_id as string),
  }));
}

export type FillRole = "short" | "cover" | null;

/** What a fill did, beyond plain buy / sell. */
export function fillRole(side: string, orderId: string, shortEntries: Set<string>, covers: Set<string>): FillRole {
  if (side === "sell" && shortEntries.has(orderId)) return "short";
  if (side === "buy" && covers.has(orderId)) return "cover";
  return null;
}

export function bookState(startCash: number, fills: Fill[], orders: OrderMeta[] = []): BookState {
  const sorted = fills.slice().sort((a, b) => a.transacted_at.localeCompare(b.transacted_at));
  const positions = new Map<string, BookPosition>();
  // Realized P&L per open position, to judge a win when it fully closes.
  const tradePnl = new Map<string, number>();
  let cash = startCash;
  let realized = 0;
  let closedTrades = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  const coverOrderIds = new Set<string>();
  const closed: ClosedTrade[] = [];
  const exitPnl = new Map<string, number>();
  const trips = new Map<string, Trip>();

  const openTrip = (f: Fill, direction: "long" | "short") =>
    trips.set(f.symbol, {
      direction, openedAt: f.transacted_at, maxQty: f.qty, entryQty: f.qty, entryCost: f.qty * f.price,
      exitQty: 0, exitValue: 0, pnl: 0, entryOrderId: f.order_id ?? null, exits: [],
    });
  const addEntry = (f: Fill, held: number) => {
    const t = trips.get(f.symbol);
    if (!t) return;
    t.entryQty += f.qty;
    t.entryCost += f.qty * f.price;
    t.maxQty = Math.max(t.maxQty, held);
  };
  const addExit = (f: Fill, q: number, pnl: number) => {
    if (f.order_id) exitPnl.set(f.order_id, (exitPnl.get(f.order_id) ?? 0) + pnl);
    const t = trips.get(f.symbol);
    if (!t) return;
    t.exitQty += q;
    t.exitValue += q * f.price;
    t.pnl += pnl;
    t.exits.push({ qty: q, reason: inferExitReason(f, orders), at: f.transacted_at });
  };

  const close = (symbol: string, at: string) => {
    closedTrades++;
    const pnlT = tradePnl.get(symbol) ?? 0;
    if (Math.abs(pnlT) < 0.005) flats++;
    else if (pnlT > 0) wins++;
    else losses++;
    const t = trips.get(symbol);
    if (t && t.exitQty > 0 && t.entryQty > 0) {
      const avgEntry = t.entryCost / t.entryQty;
      const avgExit = t.exitValue / t.exitQty;
      const stop = orders.find((o) => o.alpaca_order_id && o.alpaca_order_id === t.entryOrderId)?.stop_price ?? null;
      const risk = stop != null ? (t.direction === "long" ? avgEntry - stop : stop - avgEntry) : 0;
      // The biggest exit slice names the reason (a fraction sold alongside the bracket follows it).
      const lead = t.exits.reduce((a, b) => (b.qty >= a.qty ? b : a));
      closed.push({
        symbol,
        direction: t.direction,
        qty: t.maxQty,
        avgEntry,
        avgExit,
        pnl: t.pnl,
        pnlPct: avgEntry > 0 ? (t.pnl / (avgEntry * t.exitQty)) * 100 : 0,
        openedAt: t.openedAt,
        closedAt: at,
        holdMinutes: Math.max(0, Math.round((new Date(at).getTime() - new Date(t.openedAt).getTime()) / 60_000)),
        entryOrderId: t.entryOrderId,
        exitReason: lead.reason,
        r: risk > 0 && t.maxQty > 0 ? t.pnl / (risk * t.maxQty) : null,
      });
    }
    trips.delete(symbol);
    positions.delete(symbol);
    tradePnl.delete(symbol);
  };

  for (const f of sorted) {
    const p = positions.get(f.symbol);
    if (f.side === "buy") {
      cash -= f.qty * f.price;
      if (p && p.qty < 0) {
        // Buy to cover: anything beyond the short has no basis, like an oversized sell.
        const q = Math.min(f.qty, -p.qty);
        const pnl = q * (p.avgCost - f.price);
        realized += pnl;
        tradePnl.set(f.symbol, (tradePnl.get(f.symbol) ?? 0) + pnl);
        p.qty += q;
        if (f.order_id) coverOrderIds.add(f.order_id);
        addExit(f, q, pnl);
        if (p.qty >= -1e-9) close(f.symbol, f.transacted_at);
      } else if (p) {
        p.avgCost = (p.qty * p.avgCost + f.qty * f.price) / (p.qty + f.qty);
        p.qty += f.qty;
        addEntry(f, p.qty);
      } else {
        positions.set(f.symbol, { symbol: f.symbol, qty: f.qty, avgCost: f.price, openedAt: f.transacted_at });
        tradePnl.set(f.symbol, 0);
        openTrip(f, "long");
      }
    } else {
      cash += f.qty * f.price;
      if (f.opensShort && (!p || p.qty < 0)) {
        if (p) {
          const held = -p.qty;
          p.avgCost = (held * p.avgCost + f.qty * f.price) / (held + f.qty);
          p.qty -= f.qty;
          addEntry(f, -p.qty);
        } else {
          positions.set(f.symbol, { symbol: f.symbol, qty: -f.qty, avgCost: f.price, openedAt: f.transacted_at });
          tradePnl.set(f.symbol, 0);
          openTrip(f, "short");
        }
        continue;
      }
      if (!p || p.qty < 0) continue; // sell with no tracked long: cash still counts, no P&L basis
      const q = Math.min(f.qty, p.qty);
      const pnl = q * (f.price - p.avgCost);
      realized += pnl;
      tradePnl.set(f.symbol, (tradePnl.get(f.symbol) ?? 0) + pnl);
      p.qty -= q;
      addExit(f, q, pnl);
      if (p.qty <= 1e-9) close(f.symbol, f.transacted_at);
    }
  }
  return { cash, realized, closedTrades, wins, losses, flats, positions, coverOrderIds, closed, exitPnl };
}
