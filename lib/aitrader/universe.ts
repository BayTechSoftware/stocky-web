/**
 * Free Choice universe: liquid US large/mid caps across sectors — common stock
 * and ADRs only (no ETFs, leveraged or inverse products, penny stocks). Curated
 * rather than taken from Alpaca's "most active" screener, which is dominated by
 * penny stocks and leveraged ETFs. The user's own watchlist symbols are removed
 * at run time so the two books never hold the same name.
 */
export const FREE_UNIVERSE: string[] = [
  // mega-cap tech / internet
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "AVGO", "TSLA", "NFLX", "ORCL", "ADBE", "CRM",
  // semis
  "AMD", "INTC", "QCOM", "TXN", "AMAT", "MU", "LRCX", "KLAC", "ADI", "MRVL", "ARM", "TSM", "ASML", "ON", "NXPI",
  // software / cloud / security
  "NOW", "INTU", "WDAY", "SNOW", "PLTR", "CRWD", "PANW", "ZS", "NET", "DDOG", "MDB", "ANET", "DELL", "IBM", "ACN", "SHOP",
  // consumer internet
  "UBER", "ABNB", "BKNG", "DASH", "SPOT", "RBLX", "TTD", "PYPL", "COIN", "HOOD", "SOFI",
  // financials
  "JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "BLK", "AXP", "COF", "V", "MA",
  // healthcare
  "LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "DHR", "ABT", "ISRG", "SYK", "BMY", "GILD", "AMGN", "REGN", "VRTX", "CVS",
  // consumer
  "WMT", "COST", "HD", "LOW", "TGT", "MCD", "SBUX", "NKE", "PEP", "KO", "PG", "CL", "MO", "PM", "DIS", "CMCSA",
  // industrials / energy / materials
  "CAT", "DE", "GE", "HON", "BA", "LMT", "RTX", "NOC", "UNP", "UPS", "FDX", "XOM", "CVX", "COP", "SLB", "LIN", "SHW", "FCX",
  // utilities / telecom / autos
  "NEE", "DUK", "SO", "T", "VZ", "TMUS", "F", "GM",
];

/** Share classes of the same company: excluding one excludes its twin. */
const TWINS: Record<string, string> = { GOOG: "GOOGL", GOOGL: "GOOG" };

/**
 * Universe (+ the book's `universe_add`, − its `universe_remove`) minus the
 * user's list and twin share classes of anything on it — the two books never
 * hold the same name.
 */
export function freeUniverse(excludeSymbols: string[], add: string[] = [], remove: string[] = []): string[] {
  const ex = new Set(excludeSymbols.map((s) => s.toUpperCase()));
  for (const s of Array.from(ex)) if (TWINS[s]) ex.add(TWINS[s]);
  const rm = new Set(remove.map((s) => s.toUpperCase()));
  const base = Array.from(new Set([...FREE_UNIVERSE, ...add.map((s) => s.toUpperCase())]));
  return base.filter((s) => !ex.has(s) && !rm.has(s));
}
