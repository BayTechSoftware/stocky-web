/**
 * Starting points for a box's settings. Applying one only fills the form; nothing is saved until Save.
 * Balanced = today's defaults exactly (read from the tables, never copied). Presets never turn on
 * shorting or borrowing (margin) and never touch the box's size.
 */
import type { LimitDef, LimitValue } from "./limits";

export type PresetId = "cautious" | "balanced" | "roomier";

export interface Preset {
  id: PresetId;
  name: string;
  blurb: string;
  /** Values for Claude boxes; keys a preset leaves out use the default. */
  claude: Record<string, LimitValue>;
  /** Values for Rules boxes. */
  rules: Record<string, LimitValue>;
}

export const PRESETS: Preset[] = [
  {
    id: "cautious",
    name: "Cautious",
    blurb: "Smaller risk, fewer trades, a shorter buying window, no re-buying the same stock.",
    claude: {
      max_loss_per_trade_usd: 25,
      max_daily_loss_usd: 75,
      max_trades_per_day: 2,
      no_entries_before: "10:00",
      no_entries_after: "15:00",
      allow_reentry: false,
    },
    rules: { risk_pct: 0.5, max_position_pct: 15, max_positions: 4 },
  },
  {
    id: "balanced",
    name: "Balanced",
    blurb: "The defaults.",
    claude: {},
    rules: {},
  },
  {
    id: "roomier",
    name: "Roomier",
    blurb: "More trades and daily risk, a longer buying window, re-buying allowed, the stop moves to the entry later.",
    claude: {
      max_trades_per_day: 6,
      max_daily_loss_usd: 250,
      max_orders_per_day: 30,
      no_entries_before: "09:35",
      no_entries_after: "15:45",
      allow_reentry: true,
      breakeven_at_r: 1.5,
    },
    rules: { max_position_pct: 30, max_positions: 8 },
  },
];

/** Never part of a preset, whatever a preset table says. */
const NEVER = new Set(["allow_short", "allow_margin", "margin_multiplier", "budget"]);

/** Every key any preset sets, for this box type, that exists in its table. */
export function presetKeys(defs: LimitDef[], claude: boolean): string[] {
  const keys = new Set(PRESETS.flatMap((p) => Object.keys(claude ? p.claude : p.rules)));
  return defs.filter((d) => keys.has(d.key) && !NEVER.has(d.key)).map((d) => d.key);
}

/** The values a preset sets: its own value, else the default, for every preset key. */
export function presetValues(defs: LimitDef[], id: PresetId, claude: boolean): Record<string, LimitValue> {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return {};
  const table = claude ? p.claude : p.rules;
  const out: Record<string, LimitValue> = {};
  for (const k of presetKeys(defs, claude)) {
    const d = defs.find((x) => x.key === k)!;
    out[k] = k in table ? table[k] : d.def;
  }
  return out;
}

/** Which preset the current values match on the preset keys, or "custom". `same` compares one field. */
export function matchPreset(
  defs: LimitDef[],
  claude: boolean,
  same: (d: LimitDef, v: LimitValue) => boolean
): PresetId | "custom" {
  for (const p of PRESETS) {
    const vals = presetValues(defs, p.id, claude);
    if (Object.entries(vals).every(([k, v]) => same(defs.find((d) => d.key === k)!, v))) return p.id;
  }
  return "custom";
}
