import { createClient } from "@/lib/supabase/server";
import PortfolioView, { type Row, type Sig } from "./portfolio-view";
import { type DeviceToken } from "./device-pairing";
import { loadAiView } from "@/lib/aitrader/view";
import { createAdminClient } from "@/lib/supabase/admin";

// Room for the AI Trader "Run now" server action (Alpaca calls + order placement).
export const maxDuration = 120;

export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: wl } = await supabase
    .from("watchlist")
    .select("symbol, lots, watch_only, alert_above, alert_below")
    .order("symbol");
  const base = (wl ?? []) as Omit<Row, "sig">[];
  const symbols = base.map((r) => r.symbol);

  const sigBy = new Map<string, Sig>();
  if (symbols.length) {
    const { data } = await supabase
      .from("symbol_signals")
      .select(
        "symbol, price, prev_close, rsi, ma50, ma200, trend_up, zone_low, zone_high, week52_high, week52_low, ret_1y, assessment, tag, score, updated_at"
      )
      .in("symbol", symbols);
    for (const s of data ?? []) sigBy.set(s.symbol as string, s as Sig);
  }

  const rows: Row[] = base.map((r) => ({ ...r, sig: sigBy.get(r.symbol) ?? null }));

  const { data: dev } = await supabase
    .from("device_tokens")
    .select("id, label, created_at, last_used_at")
    .order("created_at", { ascending: false });

  const ai = user ? await loadAiView(supabase, { admin: createAdminClient(), userId: user.id }) : null;

  return (
    <PortfolioView
      rows={rows}
      email={user?.email ?? ""}
      devices={(dev ?? []) as DeviceToken[]}
      ai={ai}
    />
  );
}
