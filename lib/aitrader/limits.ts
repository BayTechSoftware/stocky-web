/**
 * Editable limits for the AI Trader boxes — one definition shared by the
 * settings form, the server actions and the rules engine, so the bounds can't
 * drift. (The Mac mirrors the Claude/runner bounds in stocky-trader/bin/limits.py.)
 *
 *   rules  — the Rules boxes' engine (lib/aitrader/plan.ts RULES).
 *   claude — the day-trader-skill repo's own trader/config.json limits; the Mac
 *            writes them into each Claude book before every run, and the repo's
 *            trader-risk check enforces them.
 *   runner — how often Claude runs, and the weekly usage cap.
 */

export type LimitKind = "number" | "time";

export interface LimitDef {
  key: string;
  label: string;
  hint?: string;
  kind: LimitKind;
  unit?: "%" | "$" | "×" | "min" | "days" | "";
  min?: number;
  max?: number;
  step?: number;
  def: number | string;
  only?: "mylist" | "free"; // rules-only fields that apply to one box
}

export const RULES_LIMITS: LimitDef[] = [
  { key: "risk_pct", label: "Risk per trade", unit: "%", kind: "number", min: 0.1, max: 5, step: 0.1, def: 1, hint: "of the book's equity, measured to the stop" },
  { key: "max_position_pct", label: "Max position size", unit: "%", kind: "number", min: 5, max: 100, step: 1, def: 20 },
  { key: "cash_buffer_pct", label: "Cash buffer", unit: "%", kind: "number", min: 0, max: 50, step: 1, def: 10 },
  { key: "max_positions", label: "Max positions", unit: "", kind: "number", min: 1, max: 20, step: 1, def: 5 },
  { key: "max_new_per_run", label: "New trades per run", unit: "", kind: "number", min: 0, max: 10, step: 1, def: 3 },
  { key: "daily_loss_halt_pct", label: "Daily-loss halt", unit: "%", kind: "number", min: 0.5, max: 20, step: 0.5, def: 3, hint: "no new trades after a day this bad" },
  { key: "reward_risk", label: "Target (reward : risk)", unit: "×", kind: "number", min: 0.5, max: 5, step: 0.5, def: 2 },
  { key: "min_score", label: "Min Stocky signal score", unit: "", kind: "number", min: 0, max: 100, step: 1, def: 60, only: "mylist" },
  { key: "max_hold_days", label: "Max holding period", unit: "days", kind: "number", min: 1, max: 120, step: 1, def: 21, only: "free" },
];

export const CLAUDE_LIMITS: LimitDef[] = [
  { key: "max_loss_per_trade_usd", label: "Max loss per trade", unit: "$", kind: "number", min: 5, max: 1000, step: 5, def: 50 },
  { key: "max_daily_loss_usd", label: "Daily loss limit", unit: "$", kind: "number", min: 10, max: 5000, step: 10, def: 150 },
  { key: "max_trades_per_day", label: "Trades per day", unit: "", kind: "number", min: 0, max: 20, step: 1, def: 3 },
  { key: "max_order_usd", label: "Max order size", unit: "$", kind: "number", min: 100, max: 5000, step: 100, def: 4000 },
  { key: "max_position_pct", label: "Max position size", unit: "%", kind: "number", min: 5, max: 100, step: 1, def: 75 },
  { key: "cash_buffer_pct", label: "Cash buffer", unit: "%", kind: "number", min: 0, max: 50, step: 1, def: 10 },
  { key: "min_reward_risk", label: "Min reward : risk", unit: "×", kind: "number", min: 0.5, max: 5, step: 0.1, def: 1 },
  { key: "no_entries_before", label: "No entries before (NY)", kind: "time", def: "09:45" },
  { key: "no_entries_after", label: "No entries after (NY)", kind: "time", def: "15:30" },
  { key: "flat_by", label: "Flat by (NY)", kind: "time", def: "15:55" },
];

export const RUNNER_LIMITS: LimitDef[] = [
  { key: "interval_min", label: "Claude runs every", unit: "min", kind: "number", min: 5, max: 120, step: 5, def: 15 },
  { key: "weekly_cap_usd", label: "Weekly usage cap", unit: "$", kind: "number", min: 1, max: 1000, step: 1, def: 30, hint: "API-equivalent; slows to hourly at 80%, stops new trades at 100%" },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/**
 * Validate a submitted form into a clean settings object: unknown keys dropped,
 * numbers clamped to their bounds, times checked (and kept inside 09:30–16:00 NY).
 * Returns the settings or a list of human-readable errors.
 */
export function validateLimits(
  defs: LimitDef[],
  raw: Record<string, unknown>
): { ok: true; settings: Record<string, number | string> } | { ok: false; errors: string[] } {
  const out: Record<string, number | string> = {};
  const errors: string[] = [];
  for (const d of defs) {
    const v = raw[d.key];
    if (v === undefined || v === null || v === "") continue;
    if (d.kind === "time") {
      const s = String(v).trim();
      if (!TIME_RE.test(s) || toMin(s) < 570 || toMin(s) > 960) {
        errors.push(`${d.label}: use HH:MM between 09:30 and 16:00`);
        continue;
      }
      out[d.key] = s;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.push(`${d.label}: not a number`);
        continue;
      }
      out[d.key] = Math.min(d.max ?? n, Math.max(d.min ?? n, n));
    }
  }
  const before = out.no_entries_before ?? defs.find((d) => d.key === "no_entries_before")?.def;
  const after = out.no_entries_after ?? defs.find((d) => d.key === "no_entries_after")?.def;
  const flat = out.flat_by ?? defs.find((d) => d.key === "flat_by")?.def;
  if (typeof before === "string" && typeof after === "string" && toMin(before) >= toMin(after)) {
    errors.push("No entries before must be earlier than No entries after");
  }
  if (typeof after === "string" && typeof flat === "string" && toMin(after) >= toMin(flat)) {
    errors.push("No entries after must be earlier than Flat by");
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}

/** Defaults overlaid with a book's saved settings (for display and engines). */
export function effective(defs: LimitDef[], saved: Record<string, unknown> | null | undefined) {
  const out: Record<string, number | string> = {};
  for (const d of defs) {
    const v = saved?.[d.key];
    out[d.key] = v === undefined || v === null ? d.def : (v as number | string);
  }
  return out;
}
