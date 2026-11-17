import { describe, expect, it } from "vitest";
import {
  EXPIRED_LINK_MESSAGE,
  GENERIC_LINK_MESSAGE,
  parseAuthCallback,
  stripAuthParams,
  validateNewPassword,
} from "./authlink";

const base = "https://stocky.example/set-password";

describe("parseAuthCallback", () => {
  it("reads implicit-flow tokens from the hash", () => {
    expect(
      parseAuthCallback(`${base}#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=invite`)
    ).toEqual({ kind: "tokens", accessToken: "AT", refreshToken: "RT", type: "invite" });
  });

  it("reads recovery type", () => {
    const r = parseAuthCallback(`${base}#access_token=A&refresh_token=R&type=recovery`);
    expect(r).toMatchObject({ kind: "tokens", type: "recovery" });
  });

  it("requires both tokens", () => {
    expect(parseAuthCallback(`${base}#access_token=A`)).toEqual({ kind: "none" });
  });

  it("reads a PKCE code (+ flow id) from the query", () => {
    expect(parseAuthCallback(`${base}?code=abc`)).toEqual({ kind: "code", code: "abc", flowId: null });
    expect(parseAuthCallback(`${base}?code=abc&sb_flow_id=f1`)).toEqual({
      kind: "code",
      code: "abc",
      flowId: "f1",
    });
  });

  it("maps an expired link (hash) to the friendly message", () => {
    expect(
      parseAuthCallback(
        `${base}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`
      )
    ).toEqual({ kind: "error", message: EXPIRED_LINK_MESSAGE });
  });

  it("detects errors in the query too, and never shows text from the URL", () => {
    expect(parseAuthCallback(`${base}?error=server_error&error_description=Call+this+number`)).toEqual({
      kind: "error",
      message: GENERIC_LINK_MESSAGE,
    });
  });

  it("accepts only invite and recovery sessions", () => {
    expect(parseAuthCallback(`${base}#access_token=A&refresh_token=R&type=magiclink`)).toEqual({
      kind: "error",
      message: GENERIC_LINK_MESSAGE,
    });
    expect(parseAuthCallback(`${base}#access_token=A&refresh_token=R`)).toMatchObject({ kind: "error" });
  });

  it("errors win over tokens", () => {
    expect(parseAuthCallback(`${base}#access_token=A&refresh_token=R&error_description=expired`).kind).toBe(
      "error"
    );
  });

  it("returns none for a bare URL or garbage", () => {
    expect(parseAuthCallback(base)).toEqual({ kind: "none" });
    expect(parseAuthCallback("not a url")).toEqual({ kind: "none" });
  });
});

describe("stripAuthParams", () => {
  it("removes hash tokens and auth query params, keeps others", () => {
    expect(stripAuthParams(`${base}?code=abc&sb_flow_id=f&keep=1#access_token=A`)).toBe("/set-password?keep=1");
    expect(stripAuthParams(`${base}#access_token=A&refresh_token=R`)).toBe("/set-password");
  });
});

describe("validateNewPassword", () => {
  it("enforces min length and match", () => {
    expect(validateNewPassword("short", "short")).toMatch(/at least 8/);
    expect(validateNewPassword("longenough", "different1")).toMatch(/match/);
    expect(validateNewPassword("longenough", "longenough")).toBeNull();
  });
});
