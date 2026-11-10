/**
 * Live prices from Finnhub, shared by the dashboard and the Stocky device.
 *
 * Quotes are cached in `live_quotes` (one row per symbol, shared by all users,
 * since prices aren't private). A request that wants fresh prices calls
 * `claim_quotes`, which hands each stale symbol to exactly one caller. That
 * caller fetches the symbol from Finnhub with its own user's key, taken from
 * Supabase Vault and never sent to the browser. However many tabs or devices
 * poll, each symbol is fetched at most once per TTL.
 *
 * Budget: Finnhub's free tier allows 60 calls/min per key, and the device's
 * Finnhub fallback shares the same key, so the website aims for at most
 * FETCH_PER_MIN. TTL grows with the symbol count to stay under it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type LiveQuote = {
  symbol: string;
  c: number | null;
  pc: number | null;
  dp: number | null;
  o: number | null;
  h: number | null;
  l: number | null;
  fetched_at: string | null;
};

const FETCH_PER_MIN = 45;
const MIN_TTL_SEC = 30;
const CLOSED_TTL_SEC = 15 * 60;
const MAX_PER_REQUEST = 12;
const FETCH_TIMEOUT_MS = 4000;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;

/** US regular session, Mon–Fri 9:30–16:00 New York time (holidays not modelled). */
export function marketOpenET(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Seconds a cached quote counts as fresh: at least 30 s, longer for big lists. Off-hours it's 15 min. */
export function ttlFor(symbolCount: number, open: boolean): number {
  if (!open) return CLOSED_TTL_SEC;
  return Math.max(MIN_TTL_SEC, Math.ceil((symbolCount * 60) / FETCH_PER_MIN));
}

/** Clean, dedupe and sort a list of tickers. */
export function cleanSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].sort();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Parse Finnhub /quote. Returns null when Finnhub has no price for the symbol:
 * it answers an unknown ticker with all zeros, which is not a real price.
 */
export function parseFinnhubQuote(body: unknown): Omit<LiveQuote, "symbol" | "fetched_at"> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const c = num(b.c);
  if (c == null || c <= 0) return null;
  return { c, pc: num(b.pc), dp: num(b.dp), o: num(b.o), h: num(b.h), l: num(b.l) };
}

export class FinnhubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** One Finnhub /quote call. Throws FinnhubError on HTTP errors. */
export async function fetchFinnhubQuote(symbol: string, key: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { "X-Finnhub-Token": key },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new FinnhubError(res.status, `Finnhub HTTP ${res.status}`);
  return parseFinnhubQuote(await res.json());
}

/** The user's Finnhub key from Vault, or null if they haven't added one. */
export async function loadFinnhubKey(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("get_finnhub_key", { p_user: userId });
  if (error || typeof data !== "string" || !data) return null;
  return data;
}

/**
 * Bring the cached quotes for `symbols` up to date, best effort. It never
 * throws: a missing key or a Finnhub failure just leaves the cache as it was.
 * `ttlSec` overrides the default freshness window.
 */
export async function refreshLiveQuotes(
  admin: SupabaseClient,
  userId: string,
  symbols: string[],
  opts: { ttlSec?: number; key?: string | null } = {}
): Promise<{ fetched: number; failed: number; noKey: boolean }> {
  const syms = cleanSymbols(symbols);
  if (!syms.length) return { fetched: 0, failed: 0, noKey: false };
  const key = opts.key !== undefined ? opts.key : await loadFinnhubKey(admin, userId);
  if (!key) return { fetched: 0, failed: 0, noKey: true };

  const ttl = opts.ttlSec ?? ttlFor(syms.length, marketOpenET());
  const { data: claimed, error } = await admin.rpc("claim_quotes", {
    p_symbols: syms,
    p_ttl_sec: ttl,
    p_limit: MAX_PER_REQUEST,
  });
  if (error || !Array.isArray(claimed) || !claimed.length) return { fetched: 0, failed: 0, noKey: false };

  const results = await Promise.allSettled(
    (claimed as string[]).map(async (s) => ({ s, q: await fetchFinnhubQuote(s, key) }))
  );
  const now = new Date().toISOString();
  const rows: LiveQuote[] = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.q) rows.push({ symbol: r.value.s, ...r.value.q, fetched_at: now });
    else failed++;
  }
  if (rows.length) {
    const { error: upErr } = await admin.from("live_quotes").upsert(rows, { onConflict: "symbol" });
    if (upErr) return { fetched: 0, failed: failed + rows.length, noKey: false };
  }
  return { fetched: rows.length, failed, noKey: false };
}

/** Read the cached quotes that have a price. Works with an RLS client (signed-in read) or the admin client. */
export async function readLiveQuotes(db: SupabaseClient, symbols: string[]): Promise<Map<string, LiveQuote>> {
  const out = new Map<string, LiveQuote>();
  const syms = cleanSymbols(symbols);
  if (!syms.length) return out;
  const { data } = await db
    .from("live_quotes")
    .select("symbol, c, pc, dp, o, h, l, fetched_at")
    .in("symbol", syms)
    .not("fetched_at", "is", null);
  for (const q of (data ?? []) as LiveQuote[]) if (q.c != null && q.c > 0) out.set(q.symbol, q);
  return out;
}

/** A cached quote counts as live if Finnhub answered within `maxAgeSec`. */
export function isFresh(q: LiveQuote | undefined, maxAgeSec: number, now: number = Date.now()): boolean {
  if (!q?.fetched_at) return false;
  const age = (now - Date.parse(q.fetched_at)) / 1000;
  return Number.isFinite(age) && age <= maxAgeSec;
}
