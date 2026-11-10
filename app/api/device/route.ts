import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authDevice } from "@/lib/deviceauth";

export const maxDuration = 15;

/**
 * Read-only endpoint for the Stocky device.
 *
 * Auth is a per-user device token minted in the dashboard
 * (`Authorization: Bearer stk_...`); only its SHA-256 hash is stored server-side,
 * so a DB leak never exposes a usable token. Returns that user's watchlist
 * signals as compact JSON with short keys (s/p/a/t/sc) to keep on-device JSON
 * parsing cheap, sorted best-entry first, plus a `holdings` array in the exact
 * shape the device's config_json parser reads (symbol / watch_only / lots /
 * alert_above / alert_below). The web is the source of truth: the device mirrors
 * this holdings list onto its screen on each poll.
 */

type Lot = { qty: number; price: number; date?: number };

/** A watchlist row as the device wants it (matches firmware core/config_json.c). */
type DeviceHolding = {
  symbol: string;
  watch_only: boolean;
  lots: Lot[];
  alert_above?: number;
  alert_below?: number;
};

// Mirrors the DB check constraint and the dashboard's MAX_WATCHLIST cap.
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;
const MAX_WATCHLIST = 80;

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const a = await authDevice(req, admin);
  if ("error" in a) return a.error;
  const tok = a.tok;

  const { data: wl } = await admin
    .from("watchlist")
    .select("symbol, lots, watch_only, alert_above, alert_below")
    .eq("user_id", tok.user_id as string)
    .order("symbol"); // stable order so the device can detect real changes vs re-sends
  const rows = wl ?? [];
  const symbols = rows.map((r) => r.symbol as string);

  // Holdings in the firmware config shape. Lots pass through as stored
  // ({qty, price, date-epoch-seconds}); numbers are coerced defensively.
  const holdings: DeviceHolding[] = rows.map((r) => {
    const rawLots = Array.isArray(r.lots) ? (r.lots as Lot[]) : [];
    const lots: Lot[] = rawLots.map((l) => {
      const lot: Lot = { qty: Number(l?.qty) || 0, price: Number(l?.price) || 0 };
      const d = Number(l?.date);
      if (Number.isFinite(d) && d > 0) lot.date = d;
      return lot;
    });
    const h: DeviceHolding = {
      symbol: r.symbol as string,
      watch_only: Boolean(r.watch_only),
      lots,
    };
    if (r.alert_above != null) h.alert_above = Number(r.alert_above);
    if (r.alert_below != null) h.alert_below = Number(r.alert_below);
    return h;
  });

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

  return NextResponse.json({
    updated: new Date().toISOString(),
    count: signals.length,
    signals,
    holdings,
  });
}

/**
 * Device -> web push (Phase 4b). The device PUTs its current portfolio (the body
 * config_to_json produces; we read only its `holdings` array) and we make the
 * user's watchlist match it: a full replace, so symbols removed on the device are
 * removed here too — symmetric with the GET pull.
 *
 * Safety: an empty or all-invalid holdings list is rejected (never wipe the cloud
 * watchlist from a truncated push). Upsert runs first and is atomic, so a failed
 * write never deletes anything; removals happen only after the upsert succeeds.
 */
export async function PUT(req: NextRequest) {
  const admin = createAdminClient();
  const a = await authDevice(req, admin);
  if ("error" in a) return a.error;
  const tok = a.tok;

  // Write scope is opt-in per token: a read-only device can't mutate the cloud
  // watchlist even with a valid token (least privilege for a leaked token).
  if (!tok.can_write) {
    return NextResponse.json(
      { error: "this device token is read-only (enable write access when pairing)" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const rawHoldings = (body as { holdings?: unknown })?.holdings;
  if (!Array.isArray(rawHoldings)) {
    return NextResponse.json({ error: "holdings array required" }, { status: 400 });
  }

  // Validate + normalize into watchlist rows, de-duped by symbol (last wins).
  type Row = {
    user_id: string;
    symbol: string;
    watch_only: boolean;
    alert_above: number | null;
    alert_below: number | null;
    lots: Lot[];
  };
  const bySymbol = new Map<string, Row>();
  for (const h of rawHoldings as Record<string, unknown>[]) {
    const symbol = String(h?.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) continue;

    const rawLots = Array.isArray(h?.lots) ? (h.lots as Record<string, unknown>[]) : [];
    const lots: Lot[] = rawLots
      .map((l) => {
        const lot: Lot = { qty: Number(l?.qty) || 0, price: Number(l?.price) || 0 };
        const d = Number(l?.date);
        if (Number.isFinite(d) && d > 0) lot.date = d;
        return lot;
      })
      .filter((l) => l.qty !== 0 || l.price !== 0); // drop blank lots

    const above = Number(h?.alert_above);
    const below = Number(h?.alert_below);
    bySymbol.set(symbol, {
      user_id: tok.user_id,
      symbol,
      watch_only: Boolean(h?.watch_only) || lots.length === 0,
      alert_above: Number.isFinite(above) ? above : null,
      alert_below: Number.isFinite(below) ? below : null,
      lots,
    });
  }

  const rows = [...bySymbol.values()];
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "no valid holdings — refusing to clear the watchlist" },
      { status: 400 }
    );
  }
  if (rows.length > MAX_WATCHLIST) {
    return NextResponse.json({ error: `too many holdings (max ${MAX_WATCHLIST})` }, { status: 400 });
  }

  // Upsert first — one atomic statement, so a failure deletes nothing.
  const { error: upErr } = await admin
    .from("watchlist")
    .upsert(rows, { onConflict: "user_id,symbol" });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // Then drop any of the user's symbols no longer present (completes the replace).
  const keep = new Set(rows.map((r) => r.symbol));
  const { data: existing } = await admin
    .from("watchlist")
    .select("symbol")
    .eq("user_id", tok.user_id);
  const toDelete = (existing ?? []).map((r) => r.symbol as string).filter((s) => !keep.has(s));
  if (toDelete.length) {
    await admin.from("watchlist").delete().eq("user_id", tok.user_id).in("symbol", toDelete);
  }

  await admin
    .from("device_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tok.id);

  return NextResponse.json({ ok: true, count: rows.length, removed: toDelete.length });
}
