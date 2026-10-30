import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDailyClosesBatch } from "@/lib/twelvedata";
import { assess } from "@/lib/signals";

export const maxDuration = 300;

const MAX_SYMBOLS_PER_RUN = 150; // bound credits/time even if the DB grows

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

  const symbols = Array.from(new Set((rows ?? []).map((r) => r.symbol as string)))
    .sort()
    .slice(0, MAX_SYMBOLS_PER_RUN);
  if (symbols.length === 0) return NextResponse.json({ updated: 0, note: "no symbols" });

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const CHUNK = 8; // conservative batch size for the free tier (tune with the real key)
  let updated = 0;
  const errors: string[] = [];

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    let closesMap: Record<string, number[]> = {};
    try {
      closesMap = await fetchDailyClosesBatch(chunk, apiKey);
    } catch (e) {
      errors.push(String(e));
    }

    const sigRows = [];
    const histRows = [];
    for (const sym of chunk) {
      const closes = closesMap[sym];
      if (!closes || closes.length < 15) continue;
      const s = assess({ closes });
      sigRows.push({
        symbol: sym,
        price: s.price,
        zone_low: s.zoneLow,
        zone_high: s.zoneHigh,
        rsi: s.rsi,
        ma50: s.ma50,
        ma200: s.ma200,
        trend_up: s.trendUp,
        assessment: s.assessment,
        tag: s.tag,
        score: s.score,
        updated_at: nowIso,
      });
      histRows.push({ symbol: sym, as_of: today, assessment: s.assessment, score: s.score });
      updated++;
    }
    if (sigRows.length) await admin.from("symbol_signals").upsert(sigRows);
    if (histRows.length) await admin.from("signal_history").upsert(histRows);

    // Respect the free tier's 8 requests/min between chunks.
    if (i + CHUNK < symbols.length) await new Promise((r) => setTimeout(r, 8000));
  }

  return NextResponse.json({ updated, total: symbols.length, errors: errors.slice(0, 5) });
}
