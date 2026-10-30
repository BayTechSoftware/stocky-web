"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
