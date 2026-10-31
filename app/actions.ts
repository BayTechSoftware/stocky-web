"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import type { Lot } from "@/lib/portfolio";

const MAX_WATCHLIST = 80; // per-user cap (also enforced by a DB trigger)
const MAX_DEVICE_TOKENS = 5; // per-user cap on paired devices

function cleanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
}

async function uid() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Add a watch-only ticker (no position yet). */
export async function addTicker(formData: FormData) {
  const symbol = cleanSymbol(String(formData.get("symbol") ?? ""));
  if (!symbol) return;
  const { supabase, user } = await uid();
  if (!user) return;
  const { count } = await supabase
    .from("watchlist")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_WATCHLIST) return;
  await supabase
    .from("watchlist")
    .insert({ user_id: user.id, symbol, watch_only: true, lots: [] });
  revalidatePath("/dashboard");
}

export async function removeSymbol(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  if (!symbol) return;
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase.from("watchlist").delete().eq("user_id", user.id).eq("symbol", symbol);
  revalidatePath("/dashboard");
}

/** Record a buy (a lot): qty at price on an optional date. Promotes a watch-only
 *  ticker into a held position; creates the row if the symbol is new. */
export async function addLot(formData: FormData) {
  const symbol = cleanSymbol(String(formData.get("symbol") ?? ""));
  const qty = parseFloat(String(formData.get("qty") ?? ""));
  const priceV = parseFloat(String(formData.get("price") ?? ""));
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(priceV) || priceV < 0) return;

  const { supabase, user } = await uid();
  if (!user) return;

  const lot: Lot = { qty, price: priceV };
  if (dateStr) {
    const t = Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000);
    if (Number.isFinite(t)) lot.date = t;
  }

  const { data: row } = await supabase
    .from("watchlist")
    .select("id, lots")
    .eq("user_id", user.id)
    .eq("symbol", symbol)
    .maybeSingle();

  if (row) {
    const lots = (Array.isArray(row.lots) ? row.lots : []) as Lot[];
    lots.push(lot);
    await supabase.from("watchlist").update({ lots, watch_only: false }).eq("id", row.id);
  } else {
    const { count } = await supabase
      .from("watchlist")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);
    if ((count ?? 0) >= MAX_WATCHLIST) return;
    await supabase
      .from("watchlist")
      .insert({ user_id: user.id, symbol, lots: [lot], watch_only: false });
  }
  revalidatePath("/dashboard");
}

/** Remove one lot by index. If none remain, the row reverts to watch-only. */
export async function removeLot(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  const idx = parseInt(String(formData.get("index") ?? ""), 10);
  if (!symbol || !Number.isInteger(idx)) return;
  const { supabase, user } = await uid();
  if (!user) return;
  const { data: row } = await supabase
    .from("watchlist")
    .select("id, lots")
    .eq("user_id", user.id)
    .eq("symbol", symbol)
    .maybeSingle();
  if (!row) return;
  const lots = ((Array.isArray(row.lots) ? row.lots : []) as Lot[]).filter((_, i) => i !== idx);
  await supabase
    .from("watchlist")
    .update({ lots, watch_only: lots.length === 0 })
    .eq("id", row.id);
  revalidatePath("/dashboard");
}

/** Set / clear price alerts for a symbol. Empty string clears. */
export async function setAlerts(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  if (!symbol) return;
  const aStr = String(formData.get("above") ?? "").trim();
  const bStr = String(formData.get("below") ?? "").trim();
  const above = aStr === "" ? null : parseFloat(aStr);
  const below = bStr === "" ? null : parseFloat(bStr);
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase
    .from("watchlist")
    .update({
      alert_above: above != null && Number.isFinite(above) ? above : null,
      alert_below: below != null && Number.isFinite(below) ? below : null,
    })
    .eq("user_id", user.id)
    .eq("symbol", symbol);
  revalidatePath("/dashboard");
}

/**
 * Mint a device token so the Stocky hardware can read this user's signals.
 * Only the SHA-256 hash is stored; the raw token is returned once for display.
 */
export async function createDeviceToken(
  canWrite = false
): Promise<{ token: string } | { error: string }> {
  const { supabase, user } = await uid();
  if (!user) return { error: "not signed in" };
  const { count } = await supabase
    .from("device_tokens")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_DEVICE_TOKENS) return { error: `device limit reached (${MAX_DEVICE_TOKENS})` };
  const raw = "stk_" + randomBytes(24).toString("hex");
  const token_hash = createHash("sha256").update(raw).digest("hex");
  // Write scope is opt-in: a read-only token can display signals/holdings but
  // cannot push edits back to the watchlist.
  const { error } = await supabase
    .from("device_tokens")
    .insert({ user_id: user.id, token_hash, can_write: canWrite });
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { token: raw };
}

export async function revokeDeviceToken(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { supabase, user } = await uid();
  if (!user) return;
  await supabase.from("device_tokens").delete().eq("user_id", user.id).eq("id", id);
  revalidatePath("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
