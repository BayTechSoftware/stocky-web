"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";

const MAX_WATCHLIST = 80; // per-user cap (also enforced by a DB trigger)
const MAX_DEVICE_TOKENS = 5; // per-user cap on paired devices

function cleanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
}

export async function addSymbol(formData: FormData) {
  const symbol = cleanSymbol(String(formData.get("symbol") ?? ""));
  if (!symbol) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  // Cap the watchlist so one account can't exhaust the shared data-feed budget.
  const { count } = await supabase
    .from("watchlist")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_WATCHLIST) return;
  await supabase.from("watchlist").insert({ user_id: user.id, symbol });
  revalidatePath("/dashboard");
}

export async function removeSymbol(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "");
  if (!symbol) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("watchlist").delete().eq("user_id", user.id).eq("symbol", symbol);
  revalidatePath("/dashboard");
}

/**
 * Mint a device token so the Stocky hardware can read this user's signals.
 * Only the SHA-256 hash is stored; the raw token is returned once for display.
 */
export async function createDeviceToken(): Promise<{ token: string } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not signed in" };
  const { count } = await supabase
    .from("device_tokens")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_DEVICE_TOKENS) return { error: `device limit reached (${MAX_DEVICE_TOKENS})` };
  const raw = "stk_" + randomBytes(24).toString("hex"); // stk_ + 48 hex chars
  const token_hash = createHash("sha256").update(raw).digest("hex");
  const { error } = await supabase.from("device_tokens").insert({ user_id: user.id, token_hash });
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { token: raw };
}

export async function revokeDeviceToken(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("device_tokens").delete().eq("user_id", user.id).eq("id", id);
  revalidatePath("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
