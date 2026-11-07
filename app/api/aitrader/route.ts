import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAiTrader } from "@/lib/aitrader/engine";

export const maxDuration = 120;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Scheduled AI Trader runs (vercel.json), weekdays:
 *   22:30 UTC — after the US close, once the daily signal refresh has finished.
 *   15:00 UTC — after the open: re-anchors legs to the morning's fills, cancels
 *               stale entries and checks stops the same day. Hobby crons fire
 *               anywhere in the scheduled hour (15:00–15:59 UTC = 11:00–11:59 ET
 *               in summer, 10:00–10:59 ET in winter — after the 09:30 open either way).
 * Paper account only — enforced in lib/alpaca.ts.
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "server not configured (CRON_SECRET)" }, { status: 500 });
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const runs = await runAiTrader({ admin: createAdminClient(), mode: "cron" });
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
