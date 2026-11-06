/**
 * Alpaca client — PAPER ONLY. SERVER ONLY.
 *
 * Every call takes the user's own credentials (stored encrypted per user in
 * Supabase Vault — never a site-wide env var). The trading base URL is a
 * constant, the key must be a paper key ("PK…") and the account a paper account
 * ("PA…"), so even a live key cannot move real money through this module.
 */

const TRADE = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

export class AlpacaError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** A user's Alpaca paper credentials. */
export interface Creds {
  keyId: string;
  secret: string;
}

function headers(c: Creds): Record<string, string> {
  if (!c?.keyId || !c?.secret) throw new AlpacaError("Alpaca paper account not connected", 0);
  if (!c.keyId.startsWith("PK")) {
    throw new AlpacaError("Refusing: not a paper key (paper keys start with PK)", 0);
  }
  return {
    "APCA-API-KEY-ID": c.keyId,
    "APCA-API-SECRET-KEY": c.secret,
    "Content-Type": "application/json",
  };
}

async function call<T>(c: Creds, base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: headers(c), cache: "no-store" });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new AlpacaError(`Alpaca ${res.status}: ${msg}`, res.status);
  }
  return body as T;
}

/* ---------------- trading ---------------- */

export interface Account {
  account_number: string;
  status: string;
  cash: string;
  equity: string;
  buying_power: string;
}

/** Fetch the account and assert it is a paper account. */
export async function getPaperAccount(c: Creds): Promise<Account> {
  const a = await call<Account>(c, TRADE, "/v2/account");
  if (!a.account_number?.startsWith("PA")) {
    throw new AlpacaError("Refusing: account is not a paper account", 0);
  }
  return a;
}

export interface Clock {
  is_open: boolean;
  timestamp: string;
  next_open: string;
  next_close: string;
}
export const getClock = (c: Creds) => call<Clock>(c, TRADE, "/v2/clock");

/** True if `date` (YYYY-MM-DD, ET) is a trading day. */
export async function isTradingDay(c: Creds, date: string): Promise<boolean> {
  const cal = await call<{ date: string }[]>(c, TRADE, `/v2/calendar?start=${date}&end=${date}`);
  return cal.some((d) => d.date === date);
}

export interface Order {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  status: string;
  type: string;
  order_class: string;
  created_at: string;
  legs?: Order[] | null;
}

export async function listOrders(c: Creds, afterIso: string): Promise<Order[]> {
  const q = new URLSearchParams({
    status: "all",
    nested: "true",
    after: afterIso,
    limit: "500",
    direction: "asc",
  });
  return call<Order[]>(c, TRADE, `/v2/orders?${q}`);
}

export const submitOrder = (c: Creds, body: Record<string, unknown>) =>
  call<Order>(c, TRADE, "/v2/orders", { method: "POST", body: JSON.stringify(body) });

export const cancelOrder = (c: Creds, id: string) =>
  call<void>(c, TRADE, `/v2/orders/${encodeURIComponent(id)}`, { method: "DELETE" });

export const getOrder = (c: Creds, id: string) =>
  call<Order>(c, TRADE, `/v2/orders/${encodeURIComponent(id)}?nested=true`);

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
}
export const getPositions = (c: Creds) => call<Position[]>(c, TRADE, "/v2/positions");

export interface FillActivity {
  id: string;
  order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  transaction_time: string;
}

/** All fill executions after `afterIso`, oldest first (paginated). */
export async function listFills(c: Creds, afterIso: string): Promise<FillActivity[]> {
  const out: FillActivity[] = [];
  let pageToken: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ after: afterIso, direction: "asc", page_size: "100" });
    if (pageToken) q.set("page_token", pageToken);
    const page = await call<FillActivity[]>(c, TRADE, `/v2/account/activities/FILL?${q}`);
    out.push(...page);
    if (page.length < 100) break;
    pageToken = page[page.length - 1].id;
  }
  return out;
}

/* ---------------- market data (free IEX feed) ---------------- */

export interface Bar {
  t: string; // ISO date of the bar
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Daily bars per symbol, oldest → newest, split-adjusted. Chunked + paginated. */
export async function getDailyBars(c: Creds, symbols: string[], startDate: string): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  const uniq = Array.from(new Set(symbols));
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    let pageToken: string | undefined;
    for (let guard = 0; guard < 30; guard++) {
      const q = new URLSearchParams({
        symbols: chunk.join(","),
        timeframe: "1Day",
        start: startDate,
        feed: "iex",
        adjustment: "split",
        limit: "10000",
      });
      if (pageToken) q.set("page_token", pageToken);
      const page = await call<{ bars: Record<string, Bar[]>; next_page_token: string | null }>(
        c,
        DATA,
        `/v2/stocks/bars?${q}`
      );
      for (const [sym, bars] of Object.entries(page.bars ?? {})) {
        (out[sym] ??= []).push(...bars);
      }
      if (!page.next_page_token) break;
      pageToken = page.next_page_token;
    }
  }
  return out;
}

/** Latest trade price per symbol (IEX). */
export async function getLatestPrices(c: Creds, symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uniq = Array.from(new Set(symbols));
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const q = new URLSearchParams({ symbols: chunk.join(","), feed: "iex" });
    const snaps = await call<Record<string, { latestTrade?: { p: number } }>>(
      c,
      DATA,
      `/v2/stocks/snapshots?${q}`
    );
    for (const [sym, s] of Object.entries(snaps ?? {})) {
      if (s?.latestTrade?.p) out[sym] = s.latestTrade.p;
    }
  }
  return out;
}
