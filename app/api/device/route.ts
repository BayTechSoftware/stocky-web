import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 15;

/**
 * Read-only endpoint for the Stocky device.
 *
 * Auth is a per-user device token minted in the dashboard
 * (`Authorization: Bearer stk_...`); only its SHA-256 hash is stored server-side,
 * so a DB leak never exposes a usable token. Returns that user's watchlist
 * signals as compact JSON with short keys (s/p/a/t/sc) to keep on-device JSON
 * parsing cheap, sorted best-entry first.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const raw = m?.[1]?.trim();
  if (!raw) return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const hash = createHash("sha256").update(raw).digest("hex");
  const admin = createAdminClient();

  const { data: tok, error: tokErr } = await admin
    .from("device_tokens")
    .select("id, user_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (tokErr) return NextResponse.json({ error: tokErr.message }, { status: 500 });
  if (!tok) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  const { data: wl } = await admin
    .from("watchlist")
    .select("symbol")
    .eq("user_id", tok.user_id as string);
  const symbols = (wl ?? []).map((r) => r.symbol as string);

  let signals: { s: string; p: number | null; a: string | null; t: string | null; sc: number | null }[] = [];
  if (symbols.length) {
    const { data } = await admin
      .from("symbol_signals")
      .select("symbol, price, assessment, tag, score")
      .in("symbol", symbols);
    signals = (data ?? [])
      .sort((a, b) => ((b.score as number) ?? -1) - ((a.score as number) ?? -1))
      .map((r) => ({
        s: r.symbol as string,
        p: r.price as number | null,
        a: r.assessment as string | null,
        t: r.tag as string | null,
        sc: r.score as number | null,
      }));
  }

  // Record the poll (best-effort; never fail the response on this).
  await admin
    .from("device_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tok.id as string);

  return NextResponse.json({ updated: new Date().toISOString(), count: signals.length, signals });
}
