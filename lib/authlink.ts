/**
 * Pure helpers for the invite / password-recovery landing page (/set-password).
 *
 * Supabase can hand the session back in two shapes:
 *   - implicit flow (admin invite):   #access_token=…&refresh_token=…&type=invite
 *   - PKCE flow (resetPasswordForEmail from our browser client): ?code=…[&sb_flow_id=…]
 * Errors (expired / already-used link) arrive as error / error_code / error_description
 * in either the hash or the query.
 */

export type AuthCallback =
  | { kind: "tokens"; accessToken: string; refreshToken: string; type: string | null }
  | { kind: "code"; code: string; flowId: string | null }
  | { kind: "error"; message: string }
  | { kind: "none" };

export const EXPIRED_LINK_MESSAGE = "This link has expired; ask the owner for a new invite.";
export const MIN_PASSWORD_LENGTH = 8;

export function parseAuthCallback(href: string): AuthCallback {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "none" };
  }
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const get = (k: string) => hash.get(k) ?? query.get(k);

  const errCode = get("error_code");
  const errDesc = get("error_description");
  const err = get("error");
  if (errCode || errDesc || err) {
    const text = `${errCode ?? ""} ${errDesc ?? ""}`.toLowerCase();
    if (errCode === "otp_expired" || text.includes("expired") || text.includes("invalid")) {
      return { kind: "error", message: EXPIRED_LINK_MESSAGE };
    }
    return { kind: "error", message: errDesc ?? err ?? "This link could not be used." };
  }

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (accessToken && refreshToken) {
    return { kind: "tokens", accessToken, refreshToken, type: hash.get("type") };
  }

  const code = query.get("code");
  if (code) return { kind: "code", code, flowId: query.get("sb_flow_id") };

  return { kind: "none" };
}

/** URL with every auth-callback parameter (query and hash) removed, for history.replaceState. */
export function stripAuthParams(href: string): string {
  const url = new URL(href);
  for (const k of ["code", "sb_flow_id", "error", "error_code", "error_description", "type"]) {
    url.searchParams.delete(k);
  }
  url.hash = "";
  return url.pathname + url.search;
}

/** Returns an error message, or null if the new password is acceptable. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return "Passwords don't match.";
  return null;
}
