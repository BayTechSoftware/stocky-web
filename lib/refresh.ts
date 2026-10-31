import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDailyClosesBatch } from "@/lib/twelvedata";
import { assess } from "@/lib/signals";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Compute and upsert signals for ONE batch of symbols (a single Twelve Data
 * request = N credits). The caller keeps the batch within the per-minute credit
 * budget (free tier = 8). Shared by the daily cron (`/api/refresh`, chunked with
 * waits) and the on-demand paths (add-ticker + the dashboard Refresh button).
 *
 * Never throws: a failed fetch or a bad/short-history symbol is recorded as a
 * stub (bumps last-attempt so it rotates to the back of the staleness queue) and
 * skipped, so one bad ticker can't abort the batch. Returns how many got a fresh
 * signal and which were skipped.
 */
export async function computeSignalsForSymbols(
  symbols: string[],
  apiKey: string,
  admin: Admin
): Promise<{ updated: number; skipped: string[] }> {
  const skipped: string[] = [];
  const unique = Array.from(new Set(symbols));
  if (unique.length === 0) return { updated: 0, skipped };

  let closesMap: Record<string, number[]> = {};
  try {
    closesMap = await fetchDailyClosesBatch(unique, apiKey);
  } catch {
    // Whole batch failed (network / rate limit): nothing updated.
    return { updated: 0, skipped: unique };
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const sigRows = [];
  const stubRows: { symbol: string; updated_at: string }[] = [];
  const histRows = [];

  for (const sym of unique) {
    const closes = closesMap[sym];
    if (!closes || closes.length < 15) {
      stubRows.push({ symbol: sym, updated_at: nowIso });
      skipped.push(sym);
      continue;
    }
    const s = assess({ closes });
    sigRows.push({
      symbol: sym,
      price: s.price,
      prev_close: closes.length >= 2 ? closes[closes.length - 2] : null,
      zone_low: s.zoneLow,
      zone_high: s.zoneHigh,
      rsi: s.rsi,
      ma50: s.ma50,
      ma200: s.ma200,
      trend_up: s.trendUp,
      week52_high: s.week52High,
      week52_low: s.week52Low,
      ret_1y: s.ret1y,
      assessment: s.assessment,
      tag: s.tag,
      score: s.score,
      updated_at: nowIso,
    });
    histRows.push({ symbol: sym, as_of: today, assessment: s.assessment, score: s.score });
  }

  if (sigRows.length) await admin.from("symbol_signals").upsert(sigRows);
  if (stubRows.length) await admin.from("symbol_signals").upsert(stubRows);
  if (histRows.length) await admin.from("signal_history").upsert(histRows);

  return { updated: sigRows.length, skipped };
}
