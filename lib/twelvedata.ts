/**
 * Twelve Data client — the market-data feed for the signal engine.
 * Free tier: ~800 credits/day, 8 req/min. One symbol = 1 credit per call.
 * https://twelvedata.com/docs
 *
 * Budget note (≤80 names): fetch candles once/day (EOD) for RSI/zones, and
 * refresh quotes on a slower cadence, to stay under the daily credit cap.
 */

const BASE = "https://api.twelvedata.com";

type TDError = { status: "error"; code: number; message: string };
function isTDError(x: unknown): x is TDError {
  return typeof x === "object" && x !== null && (x as { status?: string }).status === "error";
}

/** Daily closes for a symbol, oldest → newest (ready for the signal engine). */
export async function fetchDailyCloses(
  symbol: string,
  apiKey: string,
  outputsize = 252
): Promise<number[]> {
  const url =
    `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1day&outputsize=${outputsize}&order=ASC&apikey=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  const json: unknown = await res.json();
  if (isTDError(json)) throw new Error(`TwelveData ${symbol}: ${json.message}`);
  const values = (json as { values?: Array<{ close: string }> }).values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`TwelveData ${symbol}: no time-series data`);
  }
  return values.map((v) => parseFloat(v.close)).filter((n) => Number.isFinite(n));
}

/**
 * Daily closes for several symbols in one request (1 request, N credits).
 * Returns a map symbol → closes (oldest→newest); symbols that errored are omitted.
 */
export async function fetchDailyClosesBatch(
  symbols: string[],
  apiKey: string,
  outputsize = 252
): Promise<Record<string, number[]>> {
  if (symbols.length === 0) return {};
  const url =
    `${BASE}/time_series?symbol=${symbols.map(encodeURIComponent).join(",")}` +
    `&interval=1day&outputsize=${outputsize}&order=ASC&apikey=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  const json: unknown = await res.json();
  if (isTDError(json)) throw new Error(`TwelveData batch: ${json.message}`);
  const closesOf = (entry: unknown): number[] | null => {
    const values = (entry as { values?: Array<{ close: string }> })?.values;
    if (!Array.isArray(values)) return null;
    return values.map((v) => parseFloat(v.close)).filter((n) => Number.isFinite(n));
  };
  const out: Record<string, number[]> = {};
  if (symbols.length === 1) {
    const c = closesOf(json);
    if (c) out[symbols[0]] = c;
  } else {
    const map = json as Record<string, unknown>;
    for (const sym of symbols) {
      const c = closesOf(map[sym]);
      if (c) out[sym] = c;
    }
  }
  return out;
}

export interface Quote {
  price: number;
  changePct: number | null;
}

/** Latest quote for a symbol, or null on error / bad symbol. */
export async function fetchQuote(symbol: string, apiKey: string): Promise<Quote | null> {
  const url = `${BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  const json: unknown = await res.json();
  if (isTDError(json)) return null;
  const q = json as { close?: string; price?: string; percent_change?: string };
  const price = parseFloat(q.close ?? q.price ?? "");
  const changePct = q.percent_change != null ? parseFloat(q.percent_change) : null;
  return Number.isFinite(price) ? { price, changePct } : null;
}
