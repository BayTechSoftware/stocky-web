import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeSignalsForSymbols, hasAttemptedAt, lastTry } from "@/lib/refresh";

export const maxDuration = 300;

// Twelve Data free tier is 8 CREDITS/MINUTE (1 symbol = 1 credit), so we pace at
// one 8-symbol batch per minute. maxDuration is 300s, so ~5 batches fit per run;
// cap symbols/run accordingly. Surplus symbols rotate in via the stalest-first
// ordering on subsequent runs. (Raise both if you move to a paid tier.)
const MAX_SYMBOLS_PER_RUN = 36;

/** Constant-time string compare (avoids leaking the secret via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Scheduled refresh: for every symbol in any user's watchlist, pull daily
 * candles from Twelve Data, compute the signal, and upsert it.
 *
 * v1 keeps it simple: one time-series call per chunk (the last daily close is
 * used as the live price), so ~1 credit/symbol/run. Run hourly to stay inside
 * the free tier at ~50–80 names. (A faster intraday quote can be layered later.)
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; a manual call may
 * pass `?secret=...`.
 */
export async function GET(req: NextRequest) {
  // Fail closed: no secret configured → refuse (never run unauthenticated).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "server not configured (CRON_SECRET)" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "TWELVE_DATA_API_KEY not set" }, { status: 500 });

  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("watchlist").select("symbol");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const allSymbols = Array.from(new Set((rows ?? []).map((r) => r.symbol as string)));
  if (allSymbols.length === 0) return NextResponse.json({ updated: 0, note: "no symbols" });

  const errors: string[] = [];

  // Fairness: refresh the STALEST symbols first — ordered by last ATTEMPT (attempted_at,
  // recorded even on failure; supabase/signals_attempted_at.sql), so coverage rotates across runs and a perpetually-failing
  // ticker can't camp at the front of the queue and starve the rest.
  const { data: meta, error: metaErr } = await admin
    .from("symbol_signals")
    .select((await hasAttemptedAt(admin)) ? "symbol, updated_at, attempted_at" : "symbol, updated_at")
    .in("symbol", allSymbols);
  if (metaErr) errors.push(`meta: ${metaErr.message}`);
  const lastUpdated = new Map(
    ((meta ?? []) as unknown as { symbol: string; updated_at: string | null; attempted_at?: string | null }[]).map((m) => [m.symbol, lastTry(m)])
  );
  const symbols = allSymbols
    .slice()
    .sort((a, b) => (lastUpdated.get(a) ?? "").localeCompare(lastUpdated.get(b) ?? ""))
    .slice(0, MAX_SYMBOLS_PER_RUN);

  const CHUNK = 8; // conservative batch size for the free tier (tune with the real key)
  let updated = 0;

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const { updated: n } = await computeSignalsForSymbols(chunk, apiKey, admin);
    updated += n;

    // Free tier = 8 credits/minute, and each 8-symbol batch spends 8 credits, so
    // wait a full minute (+margin) before the next batch or Twelve Data 429s the rest.
    if (i + CHUNK < symbols.length) await new Promise((r) => setTimeout(r, 62000));
  }

  return NextResponse.json({ updated, total: symbols.length, errors: errors.slice(0, 5) });
}
