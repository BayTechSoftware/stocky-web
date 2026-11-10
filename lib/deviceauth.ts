import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";

export type DeviceToken = { id: string; user_id: string; can_write: boolean };
type Admin = ReturnType<typeof createAdminClient>;

/**
 * Resolve the `Authorization: Bearer stk_...` header to a device token row.
 * Returns either the token (id + user_id + can_write) or a ready-to-send error.
 */
export async function authDevice(
  req: NextRequest,
  admin: Admin
): Promise<{ tok: DeviceToken } | { error: NextResponse }> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const raw = m?.[1]?.trim();
  if (!raw) return { error: NextResponse.json({ error: "missing bearer token" }, { status: 401 }) };

  const hash = createHash("sha256").update(raw).digest("hex");
  const { data: tok, error } = await admin
    .from("device_tokens")
    .select("id, user_id, can_write")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!tok) return { error: NextResponse.json({ error: "invalid token" }, { status: 401 }) };
  return { tok: tok as DeviceToken };
}
