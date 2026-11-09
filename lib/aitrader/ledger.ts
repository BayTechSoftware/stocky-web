/**
 * Book ledger — rebuilds a book's cash and positions from its own fills.
 *
 * Both books live inside ONE Alpaca paper account; fills are attributed to a
 * book by order id (entry parent, bracket legs, or exit order). Fills are the
 * ground truth, so cash and cost basis can't drift from what actually executed.
 */

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

export function bookState(startCash: number, fills: Fill[]): BookState {
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

  const close = (symbol: string) => {
    closedTrades++;
    const pnlT = tradePnl.get(symbol) ?? 0;
    if (Math.abs(pnlT) < 0.005) flats++;
    else if (pnlT > 0) wins++;
    else losses++;
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
        if (p.qty >= -1e-9) close(f.symbol);
      } else if (p) {
        p.avgCost = (p.qty * p.avgCost + f.qty * f.price) / (p.qty + f.qty);
        p.qty += f.qty;
      } else {
        positions.set(f.symbol, { symbol: f.symbol, qty: f.qty, avgCost: f.price, openedAt: f.transacted_at });
        tradePnl.set(f.symbol, 0);
      }
    } else {
      cash += f.qty * f.price;
      if (f.opensShort && (!p || p.qty < 0)) {
        if (p) {
          const held = -p.qty;
          p.avgCost = (held * p.avgCost + f.qty * f.price) / (held + f.qty);
          p.qty -= f.qty;
        } else {
          positions.set(f.symbol, { symbol: f.symbol, qty: -f.qty, avgCost: f.price, openedAt: f.transacted_at });
          tradePnl.set(f.symbol, 0);
        }
        continue;
      }
      if (!p || p.qty < 0) continue; // sell with no tracked long: cash still counts, no P&L basis
      const q = Math.min(f.qty, p.qty);
      const pnl = q * (f.price - p.avgCost);
      realized += pnl;
      tradePnl.set(f.symbol, (tradePnl.get(f.symbol) ?? 0) + pnl);
      p.qty -= q;
      if (p.qty <= 1e-9) close(f.symbol);
    }
  }
  return { cash, realized, closedTrades, wins, losses, flats, positions, coverOrderIds };
}
