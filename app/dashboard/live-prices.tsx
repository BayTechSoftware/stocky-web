"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectFinnhub, disconnectFinnhub } from "../actions";

export type PricesInfo = {
  marketOpen: boolean;
  /** Newest Finnhub answer among the shown symbols (ISO), or null. */
  liveAt: string | null;
  hasKey: boolean;
  keyHint: string | null;
};

const OPEN_MS = 15_000;
const CLOSED_MS = 5 * 60_000;

/**
 * Re-renders the dashboard every 15 s while the market is open (every 5 min when
 * closed), so prices track the device. Each re-render tops up the shared Finnhub
 * cache on the server. It pauses while the tab is hidden.
 */
export default function LivePrices({ info }: { info: PricesInfo }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!info.hasKey && !info.liveAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const every = info.marketOpen ? OPEN_MS : CLOSED_MS;
    function tick() {
      if (document.visibilityState === "visible") router.refresh();
      timer = setTimeout(tick, every);
    }
    function onVisible() {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    }
    timer = setTimeout(tick, every);
    const clock = setInterval(() => setNow(Date.now()), 5_000); // keep "Xs ago" moving
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [info.hasKey, info.liveAt, info.marketOpen, router]);

  const at = info.liveAt ? new Date(info.liveAt) : null;
  const ageSec = at ? Math.max(0, Math.round((now - at.getTime()) / 1000)) : null;
  const live = info.marketOpen && ageSec != null && ageSec <= 120;

  let text: string;
  if (live) text = `Live · ${ageSec! < 60 ? `${ageSec}s` : `${Math.round(ageSec! / 60)}m`} ago`;
  else if (at && !info.marketOpen) text = `Market closed · prices as of ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  else if (!info.hasKey) text = "Prices as of last close · add a Finnhub key for live prices";
  else text = "Prices updating…";

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-dim">
      <span
        className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-gain" : info.hasKey ? "bg-faint" : "bg-watch"}`}
        aria-hidden
      />
      <span className="tnum" suppressHydrationWarning>
        {text}
      </span>
    </span>
  );
}

/** Add / replace / remove the user's Finnhub key. It goes to Vault, encrypted, and is never shown again. */
export function PriceKeyCard({ info }: { info: PricesInfo }) {
  const [open, setOpen] = useState(!info.hasKey);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();

  function run(fn: () => Promise<{ message: string } | { error: string }>, ok?: () => void) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if ("error" in r) setMsg({ text: r.error, err: true });
      else {
        setMsg({ text: r.message });
        ok?.();
      }
    });
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">Live prices (Finnhub)</div>
        {info.hasKey ? (
          <span className="font-mono text-xs text-gain">on {info.keyHint ?? ""}</span>
        ) : (
          <span className="text-xs text-watch">off</span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
        Your free Finnhub key (finnhub.io → Dashboard). It drives the live prices on this page and on your Stocky
        device, so both show the same numbers. Stored encrypted under your account and never shown again.
      </p>
      {info.hasKey && !open && (
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => setOpen(true)} className="text-xs text-dim hover:text-text">
            Replace key
          </button>
          <button
            disabled={busy}
            onClick={() => confirm("Remove the stored Finnhub key? Prices go back to the daily close.") && run(() => disconnectFinnhub())}
            className="text-xs text-loss hover:underline"
          >
            Remove
          </button>
          {msg && <p className={`text-xs ${msg.err ? "text-loss" : "text-gain"}`}>{msg.text}</p>}
        </div>
      )}
      {open && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fd = new FormData(form);
            run(
              () => connectFinnhub(fd),
              () => {
                form.reset();
                setOpen(false);
              }
            );
          }}
        >
          <input
            name="key"
            type="password"
            placeholder="Finnhub API key"
            autoComplete="off"
            spellCheck={false}
            required
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-accent"
          />
          <button
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Checking…" : "Save"}
          </button>
          {info.hasKey && (
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-dim hover:text-text">
              Cancel
            </button>
          )}
          {msg && <p className={`w-full text-xs ${msg.err ? "text-loss" : "text-gain"}`}>{msg.text}</p>}
        </form>
      )}
    </div>
  );
}
