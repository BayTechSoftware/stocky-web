"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

/** Shown instead of the dashboard when something on it throws while rendering. */
export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const text = error instanceof Error ? error.message : String(error ?? "");
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <div className="card rounded-2xl border border-border bg-surface p-6">
        <h2 className="font-display text-lg font-semibold text-text">Something went wrong on this page</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-dim">
          Your boxes and settings are safe; only this view failed to draw. Try again, or reload the page.
        </p>
        {text && <p className="mt-3 rounded-md bg-surface2 px-3 py-2 font-mono text-xs text-faint">{text.slice(0, 300)}</p>}
        <button
          onClick={() => retry()}
          className="mt-4 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
