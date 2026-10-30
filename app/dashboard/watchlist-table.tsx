"use client";

import { useState } from "react";
import { removeSymbol } from "../actions";

export interface SigRow {
  symbol: string;
  price: number | null;
  zone_low: number | null;
  zone_high: number | null;
  rsi: number | null;
  ma50: number | null;
  ma200: number | null;
  trend_up: boolean | null;
  assessment: string | null;
  tag: string | null;
  score: number | null;
  updated_at: string | null;
}
export interface Row {
  symbol: string;
  list: string;
  sig: SigRow | null;
}

const FILTERS = ["ALL", "BUY", "WASHOUT", "WATCH", "OVERBOUGHT"] as const;

const BADGE: Record<string, string> = {
  BUY: "bg-green-100 text-green-800",
  WASHOUT: "bg-blue-100 text-blue-800",
  WATCH: "bg-amber-100 text-amber-800",
  OVERBOUGHT: "bg-red-100 text-red-800",
};

const n2 = (x: number | null) => (x == null ? "—" : x.toFixed(2));
const n0 = (x: number | null) => (x == null ? "—" : Math.round(x).toString());

export default function WatchlistTable({ rows }: { rows: Row[] }) {
  const [filter, setFilter] = useState<string>("ALL");
  const shown = rows
    .filter((r) => filter === "ALL" || r.sig?.assessment === filter)
    .sort((a, b) => (b.sig?.score ?? -1) - (a.sig?.score ?? -1));

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Symbol</th>
              <th className="px-3 py-2 text-right font-semibold">Price</th>
              <th className="px-3 py-2 text-right font-semibold">Buy zone</th>
              <th className="px-3 py-2 text-right font-semibold">RSI</th>
              <th className="px-3 py-2 text-center font-semibold">Trend</th>
              <th className="px-3 py-2 text-center font-semibold">Signal</th>
              <th className="px-3 py-2 text-right font-semibold">Score</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {shown.map(({ symbol, sig }) => (
              <tr key={symbol} className="hover:bg-zinc-50">
                <td className="px-3 py-2 font-semibold text-zinc-900">{symbol}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{n2(sig?.price ?? null)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                  {sig?.zone_low != null && sig?.zone_high != null
                    ? `${n2(sig.zone_low)} – ${n2(sig.zone_high)}`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{n0(sig?.rsi ?? null)}</td>
                <td className="px-3 py-2 text-center">
                  {sig?.trend_up == null ? "—" : sig.trend_up ? "↑" : "↓"}
                </td>
                <td className="px-3 py-2 text-center">
                  {sig?.assessment ? (
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                        BADGE[sig.assessment] ?? "bg-zinc-100 text-zinc-700"
                      }`}
                    >
                      {sig.assessment}
                      {sig.tag ? ` · ${sig.tag}` : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400">awaiting</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium text-zinc-900">
                  {sig?.score ?? "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <form action={removeSymbol}>
                    <input type="hidden" name="symbol" value={symbol} />
                    <button
                      type="submit"
                      className="text-zinc-400 hover:text-red-600"
                      title="Remove"
                      aria-label={`Remove ${symbol}`}
                    >
                      ✕
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
