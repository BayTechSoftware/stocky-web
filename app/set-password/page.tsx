"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import {
  EXPIRED_LINK_MESSAGE,
  MIN_PASSWORD_LENGTH,
  parseAuthCallback,
  stripAuthParams,
  validateNewPassword,
} from "@/lib/authlink";

type Phase = { s: "loading" } | { s: "error"; message: string } | { s: "ready" };

/**
 * Landing page for Supabase invite + password-recovery links (redirect_to = /set-password).
 * Public in middleware (only /dashboard is guarded). Reads the session from the URL itself,
 * so the client is created with detectSessionInUrl off to avoid a double code exchange.
 */
function createPageClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    auth: { detectSessionInUrl: false },
  });
}

export default function SetPasswordPage() {
  const router = useRouter();
  const clientRef = useRef<ReturnType<typeof createPageClient> | null>(null);
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>({ s: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; a code can only be exchanged once.
    started.current = true;

    const cb = parseAuthCallback(window.location.href);
    // Get the tokens out of the address bar / history before doing anything else.
    if (cb.kind !== "none") {
      window.history.replaceState(window.history.state, "", stripAuthParams(window.location.href));
    }

    const supabase = createPageClient();
    clientRef.current = supabase;

    (async () => {
      if (cb.kind === "error") {
        setPhase({ s: "error", message: cb.message });
        return;
      }
      if (cb.kind === "tokens") {
        const { error } = await supabase.auth.setSession({
          access_token: cb.accessToken,
          refresh_token: cb.refreshToken,
        });
        setPhase(error ? { s: "error", message: linkError(error.message) } : { s: "ready" });
        return;
      }
      if (cb.kind === "code") {
        const { error } = await supabase.auth.exchangeCodeForSession(
          cb.code,
          cb.flowId ? { flowId: cb.flowId } : undefined
        );
        setPhase(error ? { s: "error", message: linkError(error.message) } : { s: "ready" });
        return;
      }
      // No link params: fine if already signed in (e.g. page reload after the link was consumed).
      const { data } = await supabase.auth.getUser();
      setPhase(
        data.user
          ? { s: "ready" }
          : { s: "error", message: "Open this page from the link in your invite or reset e-mail." }
      );
    })();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateNewPassword(password, confirm);
    if (invalid) {
      setMsg(invalid);
      return;
    }
    const supabase = clientRef.current;
    if (!supabase) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Stocky Watcher</h1>
        <p className="mt-1 text-sm text-zinc-500">Choose a password for your account.</p>

        {phase.s === "loading" && <p className="mt-6 text-sm text-zinc-500">Checking your link…</p>}

        {phase.s === "error" && (
          <>
            <p className="mt-6 text-sm text-amber-700">{phase.message}</p>
            <a href="/login" className="mt-4 inline-block text-sm text-zinc-500 underline hover:text-zinc-900">
              Back to sign in
            </a>
          </>
        )}

        {phase.s === "ready" && (
          <>
            <form onSubmit={onSubmit} className="mt-6 space-y-3">
              <input
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-zinc-900"
              />
              <input
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-zinc-900"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
              >
                {busy ? "…" : "Set password"}
              </button>
            </form>
            {msg && <p className="mt-3 text-sm text-amber-700">{msg}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function linkError(message: string): string {
  return /expired|invalid|not found|already/i.test(message)
    ? EXPIRED_LINK_MESSAGE
    : message;
}
