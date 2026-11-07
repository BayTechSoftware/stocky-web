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
}

export interface BookPosition {
  symbol: string;
  qty: number;
  avgCost: number;
  openedAt: string; // first buy of the currently-open position
}

export interface BookState {
  cash: number;
  realized: number; // realized P&L from closed shares
  closedTrades: number; // sells that fully closed a position
  wins: number; // of those, closed with a profit (> 0)
  losses: number; // closed with a loss (< 0)
  flats: number; // closed at breakeven (|P&L| < 1 cent) — neither a win nor a loss
  positions: Map<string, BookPosition>;
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

  for (const f of sorted) {
    const p = positions.get(f.symbol);
    if (f.side === "buy") {
      cash -= f.qty * f.price;
      if (p) {
        p.avgCost = (p.qty * p.avgCost + f.qty * f.price) / (p.qty + f.qty);
        p.qty += f.qty;
      } else {
        positions.set(f.symbol, { symbol: f.symbol, qty: f.qty, avgCost: f.price, openedAt: f.transacted_at });
        tradePnl.set(f.symbol, 0);
      }
    } else {
      cash += f.qty * f.price;
      if (!p) continue; // sell with no tracked position: cash still counts, no P&L basis
      const q = Math.min(f.qty, p.qty);
      const pnl = q * (f.price - p.avgCost);
      realized += pnl;
      tradePnl.set(f.symbol, (tradePnl.get(f.symbol) ?? 0) + pnl);
      p.qty -= q;
      if (p.qty <= 1e-9) {
        closedTrades++;
        const pnlT = tradePnl.get(f.symbol) ?? 0;
        if (Math.abs(pnlT) < 0.005) flats++;
        else if (pnlT > 0) wins++;
        else losses++;
        positions.delete(f.symbol);
        tradePnl.delete(f.symbol);
      }
    }
  }
  return { cash, realized, closedTrades, wins, losses, flats, positions };
}
