import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchDailyClosesBatch } from "./twelvedata";
import { assess } from "./signals";

type Admin = ReturnType<typeof createAdminClient>;

let attemptedAtKnown: boolean | null = null;

/**
 * Does symbol_signals have the attempted_at column (supabase/signals_attempted_at.sql)?
 * Checked once per instance; before the SQL is applied the code still works without it.
 */
export async function hasAttemptedAt(admin: Admin): Promise<boolean> {
  if (attemptedAtKnown != null) return attemptedAtKnown;
  const { error } = await admin.from("symbol_signals").select("attempted_at").limit(1);
  // Only a missing column means "no"; any other error: assume no for this call, ask again next time.
  if (!error) return (attemptedAtKnown = true);
  if (/attempted_at/.test(error.message) || error.code === "42703") return (attemptedAtKnown = false);
  return false;
}

/** Tests only. */
export function resetAttemptedAtCache() {
  attemptedAtKnown = null;
}

/** Rotation key for the stalest-first queue: the last attempt, else the last computed signal. */
export function lastTry(row: { updated_at?: string | null; attempted_at?: string | null }): string {
  const a = row.attempted_at ?? "";
  const u = row.updated_at ?? "";
  return a > u ? a : u;
}

/**
 * Compute and upsert signals for ONE batch of symbols (a single Twelve Data
 * request = N credits). The caller keeps the batch within the per-minute credit
 * budget (free tier = 8). Shared by the daily cron (`/api/refresh`, chunked with
 * waits) and the on-demand paths (add-ticker + the dashboard Refresh button).
 *
 * Never throws: a failed fetch or a bad/short-history symbol is recorded as an
 * attempt (attempted_at only — updated_at means a signal was really computed, so
 * the Rules books' max_signal_age_days never trusts an old signal) and skipped,
 * so one bad ticker can't abort the batch. Returns how many got a fresh signal
 * and which were skipped.
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
  const stubRows: { symbol: string; attempted_at?: string }[] = [];
  const withAttempt = await hasAttemptedAt(admin);
  const histRows = [];

  for (const sym of unique) {
    const closes = closesMap[sym];
    if (!closes || closes.length < 15) {
      stubRows.push(withAttempt ? { symbol: sym, attempted_at: nowIso } : { symbol: sym });
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
      ...(withAttempt ? { attempted_at: nowIso } : {}),
    });
    histRows.push({ symbol: sym, as_of: today, assessment: s.assessment, score: s.score });
  }

  let updated = sigRows.length;
  if (sigRows.length) {
    const { error } = await admin.from("symbol_signals").upsert(sigRows);
    if (error) {
      updated = 0;
      skipped.push(...sigRows.map((r) => r.symbol));
    }
  }
  // An attempt never touches updated_at. With attempted_at: record it (new symbols get a row with no
  // assessment, which is never a candidate). Without the column: only add rows for new symbols.
  if (stubRows.length) {
    await admin.from("symbol_signals").upsert(stubRows, withAttempt ? {} : { ignoreDuplicates: true });
  }
  if (histRows.length && updated) await admin.from("signal_history").upsert(histRows);

  return { updated, skipped };
}
