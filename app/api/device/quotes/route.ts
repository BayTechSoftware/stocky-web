import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authDevice } from "@/lib/deviceauth";
import { cleanSymbols, marketOpenET, readLiveQuotes, refreshLiveQuotes, ttlFor } from "@/lib/livequotes";

export const maxDuration = 15;

/**
 * Live prices for the Stocky device: the same Finnhub cache the dashboard shows,
 * so both screens agree. Same auth as /api/device (Bearer device token).
 *
 *   { ok, market_open, now, quotes: [{ s, c, pc, dp, o, h, l, t }] }
 *
 * `t` is when Finnhub answered (epoch seconds). The device judges freshness
 * against `now` and fetches anything missing or stale from Finnhub itself.
 * Symbols with no cached price are left out.
 */
export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const a = await authDevice(req, admin);
  if ("error" in a) return a.error;
  const tok = a.tok;

  const { data: wl, error } = await admin.from("watchlist").select("symbol").eq("user_id", tok.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const symbols = cleanSymbols((wl ?? []).map((r) => r.symbol as string));

  const open = marketOpenET();
  // Off-hours the device only asks at boot or after an edit. Use a short TTL
  // then, so what it gets is within its 90 s freshness window.
  await refreshLiveQuotes(admin, tok.user_id, symbols, { ttlSec: open ? ttlFor(symbols.length, true) : 60 });
  const cached = await readLiveQuotes(admin, symbols);

  const quotes = [...cached.values()].map((q) => ({
    s: q.symbol,
    c: q.c,
    pc: q.pc,
    dp: q.dp,
    o: q.o,
    h: q.h,
    l: q.l,
    t: Math.floor(Date.parse(q.fetched_at as string) / 1000),
  }));

  return NextResponse.json(
    { ok: true, market_open: open, now: Math.floor(Date.now() / 1000), quotes },
    { headers: { "Cache-Control": "no-store" } }
  );
}
