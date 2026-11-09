"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { syncLive } from "../actions";

const OPEN_MS = 15_000;
const CLOSED_MS = 120_000;

/** Keeps the tab current: pulls the latest orders and fills, then re-renders. Pauses while hidden. */
export default function LiveUpdates({ marketOpen }: { marketOpen: boolean | null }) {
  const router = useRouter();
  const [at, setAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      clearTimeout(timer);
      if (document.visibilityState === "visible" && !running) {
        running = true;
        try {
          const r = await syncLive();
          if (stopped) return;
          setFailed("error" in r ? r.error : null);
          router.refresh();
          setAt(new Date());
        } catch {
          if (!stopped) setFailed("connection problem");
        } finally {
          running = false;
        }
      }
      if (!stopped) timer = setTimeout(tick, marketOpen ? OPEN_MS : CLOSED_MS);
    }

    function onVisible() {
      if (document.visibilityState === "visible") void tick();
    }

    timer = setTimeout(tick, 1000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [marketOpen, router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-dim" title={failed ?? undefined}>
      <span
        className={`h-2 w-2 rounded-full ${failed ? "bg-loss" : marketOpen ? "animate-pulse bg-gain" : "bg-faint"}`}
        aria-hidden
      />
      {failed ? "update failed, retrying" : marketOpen ? "Live" : "Market closed"}
      {at && !failed && <span className="font-mono text-faint tnum">· updated {at.toLocaleTimeString()}</span>}
    </span>
  );
}
