/**
 * Claude replay days — groups "claude-replay" ai_runs rows (one per pinned step,
 * SETTINGS_CONTRACT.md → Replay runs) by summary.replay.id. Pure.
 */
import type { ReplayInfo, ReplaySimTrade } from "./engine";

/** One step (ai_runs row) of a Claude replay day. */
export interface AiReplayStep {
  id: string;
  ran_at: string;
  at: string | null; // pinned NY time
  step: number | null;
  phase: string | null;
  reason: string | null;
  cost: number | null;
  error: string | null;
}

/** A replayed day of a Claude box: its steps grouped by summary.replay.id. */
export interface AiReplayDay {
  id: string;
  date: string;
  done: number; // steps recorded
  steps: number | null; // planned
  final: boolean;
  startCash: number | null;
  simEquity: number | null;
  simPnl: number | null;
  trades: ReplaySimTrade[];
  positions: NonNullable<ReplayInfo["sim_positions"]>;
  costUsd: number;
  list: AiReplayStep[]; // in step order
}

/** Group replay rows (newest first or any order) into days, newest day first. */
export function groupReplays(rows: { id: string; ran_at: string; error: string | null; phase?: string | null; reason?: string | null; cost?: unknown; replay?: ReplayInfo | null }[]): AiReplayDay[] {
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.replay?.id || `run-${r.id}`;
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  const days: AiReplayDay[] = [];
  for (const [id, rs] of by) {
    const steps = rs
      .map((r) => ({
        id: r.id,
        ran_at: r.ran_at,
        at: r.replay?.at ?? null,
        step: typeof r.replay?.step === "number" ? r.replay.step : null,
        phase: r.phase ?? null,
        reason: r.reason ?? null,
        cost: r.cost != null && Number.isFinite(Number(r.cost)) ? Number(r.cost) : null,
        error: r.error,
      }))
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || a.ran_at.localeCompare(b.ran_at));
    // The latest step carries the day's cumulative simulation.
    const last = rs.slice().sort((a, b) => (a.replay?.step ?? 0) - (b.replay?.step ?? 0) || a.ran_at.localeCompare(b.ran_at))[rs.length - 1];
    const R = last.replay ?? null;
    const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
    const planned = rs.map((r) => num(r.replay?.steps)).filter((v): v is number => v != null);
    days.push({
      id,
      date: R?.date ?? last.ran_at.slice(0, 10),
      done: steps.length,
      steps: planned.length ? Math.max(...planned) : null,
      final: rs.some((r) => r.replay?.final === true),
      startCash: num(R?.start_cash),
      simEquity: num(R?.sim_equity),
      simPnl: num(R?.sim_pnl),
      trades: Array.isArray(R?.sim_trades) ? R!.sim_trades! : [],
      positions: Array.isArray(R?.sim_positions) ? R!.sim_positions! : [],
      costUsd: num(R?.cost_usd_total) ?? steps.reduce((a, s) => a + (s.cost ?? 0), 0),
      list: steps,
    });
  }
  return days.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
