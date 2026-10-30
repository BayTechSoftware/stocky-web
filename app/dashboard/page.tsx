import { createClient } from "@/lib/supabase/server";
import { addSymbol, signOut } from "../actions";
import WatchlistTable, { type Row, type SigRow } from "./watchlist-table";

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = {
    green: "text-green-700",
    blue: "text-blue-700",
    red: "text-red-700",
  };
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className={`text-2xl font-bold tabular-nums ${tones[tone] ?? "text-zinc-800"}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: watchData } = await supabase
    .from("watchlist")
    .select("symbol, list")
    .order("symbol");
  const watch = (watchData ?? []) as { symbol: string; list: string }[];
  const symbols = watch.map((w) => w.symbol);

  let signals: SigRow[] = [];
  if (symbols.length) {
    const { data } = await supabase.from("symbol_signals").select("*").in("symbol", symbols);
    signals = (data ?? []) as SigRow[];
  }
  const bySym = new Map(signals.map((s) => [s.symbol, s]));

  const rows: Row[] = watch.map((w) => ({
    symbol: w.symbol,
    list: w.list ?? "Watchlist",
    sig: bySym.get(w.symbol) ?? null,
  }));

  const counts = {
    buy: rows.filter((r) => r.sig?.assessment === "BUY").length,
    washout: rows.filter((r) => r.sig?.assessment === "WASHOUT").length,
    overbought: rows.filter((r) => r.sig?.assessment === "OVERBOUGHT").length,
  };
  const haveSignals = signals.length > 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Stocky Watcher</h1>
          <p className="text-sm text-zinc-500">{user?.email}</p>
        </div>
        <form action={signOut}>
          <button className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
            Sign out
          </button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Buy zone" value={counts.buy} tone="green" />
        <Stat label="Washout" value={counts.washout} tone="blue" />
        <Stat label="Overbought" value={counts.overbought} tone="red" />
      </div>

      <form action={addSymbol} className="mt-6 flex gap-2">
        <input
          name="symbol"
          placeholder="Add ticker (e.g. NVDA)"
          className="w-56 rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900"
        />
        <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">
          Add
        </button>
      </form>

      <div className="mt-4">
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
            Your watchlist is empty — add a ticker above.
          </p>
        ) : (
          <WatchlistTable rows={rows} />
        )}
      </div>

      {rows.length > 0 && !haveSignals && (
        <p className="mt-3 text-sm text-zinc-500">
          Signals populate after the first refresh (runs daily; see SETUP.md to trigger one now).
        </p>
      )}
    </div>
  );
}
