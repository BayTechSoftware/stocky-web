"use client";

import { useState, useTransition } from "react";
import { createDeviceToken, revokeDeviceToken } from "../actions";

export interface DeviceToken {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export default function DevicePairing({ tokens }: { tokens: DeviceToken[] }) {
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const endpoint =
    typeof window !== "undefined" ? `${window.location.origin}/api/device` : "/api/device";

  function generate() {
    setErr(null);
    setFresh(null);
    start(async () => {
      const res = await createDeviceToken();
      if ("token" in res) setFresh(res.token);
      else setErr(res.error);
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the user can select the text manually */
    }
  }

  return (
    <div className="mt-10 rounded-xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Stocky device</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Pair your Stocky hardware to show these signals on its screen.
          </p>
        </div>
        <button
          onClick={generate}
          disabled={pending}
          className="shrink-0 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {pending ? "…" : "Generate token"}
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

      {fresh && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-800">
            Copy this token now — it won’t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs text-zinc-800">
              {fresh}
            </code>
            <button
              onClick={() => copy(fresh)}
              className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-700">
            On the device’s Wi-Fi config page, set the API URL to{" "}
            <code className="rounded bg-white px-1 py-0.5">{endpoint}</code> and paste this token.
          </p>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100 text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2">
              <div>
                <div className="text-zinc-800">{t.label}</div>
                <div className="text-xs text-zinc-400">
                  added {new Date(t.created_at).toLocaleDateString()} ·{" "}
                  {t.last_used_at
                    ? `last seen ${new Date(t.last_used_at).toLocaleString()}`
                    : "never connected"}
                </div>
              </div>
              <form action={revokeDeviceToken}>
                <input type="hidden" name="id" value={t.id} />
                <button
                  type="submit"
                  className="text-xs text-zinc-400 hover:text-red-600"
                  title="Revoke this device token"
                >
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {tokens.length === 0 && !fresh && (
        <p className="mt-4 text-xs text-zinc-400">No devices paired yet.</p>
      )}
    </div>
  );
}
