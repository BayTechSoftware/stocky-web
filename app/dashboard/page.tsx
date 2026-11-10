import { createClient } from "@/lib/supabase/server";
import PortfolioView, { type Row, type Sig } from "./portfolio-view";
import { type DeviceToken } from "./device-pairing";
import { loadAiView } from "@/lib/aitrader/view";
import { createAdminClient } from "@/lib/supabase/admin";
import { marketOpenET, readLiveQuotes, refreshLiveQuotes } from "@/lib/livequotes";

// Room for the AI Trader "Run now" server action (Alpaca calls + order placement).
export const maxDuration = 120;

const EMPTY_SIG: Sig = {
  price: null,
  prev_close: null,
  rsi: null,
  ma50: null,
  ma200: null,
  trend_up: null,
  zone_low: null,
  zone_high: null,
  week52_high: null,
  week52_low: null,
  ret_1y: null,
  assessment: null,
  tag: null,
  score: null,
  updated_at: null,
};

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

  // Live prices: top up the shared Finnhub cache (best effort, uses the user's
  // own key from Vault), then lay those prices over the daily signal's
  // price/prev_close. These are the same numbers the device shows.
  const admin = createAdminClient();
  const marketOpen = marketOpenET();
  let hasPriceKey = false;
  let priceKeyHint: string | null = null;
  if (user) {
    const { data: pc } = await supabase.from("price_connections").select("key_hint").maybeSingle();
    hasPriceKey = !!pc;
    priceKeyHint = (pc?.key_hint as string | null) ?? null;
    if (hasPriceKey && symbols.length) await refreshLiveQuotes(admin, user.id, symbols);
  }
  const live = await readLiveQuotes(supabase, symbols);
  let liveAt: string | null = null;
  for (const [sym, q] of live) {
    const s = sigBy.get(sym);
    // Never let an old cached quote hide a newer daily close.
    if (s?.updated_at && q.fetched_at && q.fetched_at < s.updated_at) continue;
    sigBy.set(sym, {
      ...(s ?? EMPTY_SIG),
      price: q.c,
      prev_close: q.pc ?? s?.prev_close ?? null,
      live_at: q.fetched_at,
    });
    if (q.fetched_at && (!liveAt || q.fetched_at > liveAt)) liveAt = q.fetched_at;
  }

  const rows: Row[] = base.map((r) => ({ ...r, sig: sigBy.get(r.symbol) ?? null }));

  const { data: dev } = await supabase
    .from("device_tokens")
    .select("id, label, created_at, last_used_at")
    .order("created_at", { ascending: false });

  const ai = user ? await loadAiView(supabase, { admin, userId: user.id }) : null;

  return (
    <PortfolioView
      rows={rows}
      email={user?.email ?? ""}
      devices={(dev ?? []) as DeviceToken[]}
      ai={ai}
      prices={{ marketOpen, liveAt, hasKey: hasPriceKey, keyHint: priceKeyHint }}
    />
  );
}
