"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { connectAlpaca, disconnectAlpaca, resetBookLimits, saveBookLimits, saveRunnerSettings } from "../actions";
import { effective, parseSymbols, type LimitDef, type LimitValue } from "@/lib/aitrader/limits";
import { SECTIONS, isAdvanced, isShown, isWeight, sectionOf, sortDefs, type SettingsSection } from "@/lib/aitrader/layout";
import { PRESETS, matchPreset, presetValues, type PresetId } from "@/lib/aitrader/presets";
import { LABEL } from "./ai-run";

type Result = { message: string } | { error: string };

function useAction() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg("error" in r ? { text: r.error, err: true } : { text: r.message });
        if (!("error" in r)) after?.();
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : String(e), err: true });
      }
      router.refresh();
    });
  };
  return { msg, busy, run, setMsg };
}

function Msg({ msg }: { msg: { text: string; err?: boolean } | null }) {
  if (!msg) return null;
  return <p className={`text-xs ${msg.err ? "text-loss" : "text-gain"}`}>{msg.text}</p>;
}

/* ---------------- values as the form holds them (strings) ---------------- */

export type FormVals = Record<string, string>;

/** A stored value as the form shows it: bools "true"/"false", an off time "off", lists "A, B". */
export function toForm(d: LimitDef, v: LimitValue | undefined): string {
  const x = v === undefined ? d.def : v;
  if (d.kind === "bool") return x === true || x === "true" ? "true" : "false";
  if (d.kind === "time") return x === "" || x === "off" ? "off" : String(x);
  if (d.kind === "symbols" || d.kind === "tags") return String(x).split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  return String(x);
}

/** Whether a form value equals the field's default. "" (empty) means the default too. */
export function isDefault(d: LimitDef, s: string | undefined): boolean {
  if (s === undefined || s.trim() === "") return true;
  const def = toForm(d, d.def);
  if (d.kind === "number") return Number(s) === Number(d.def);
  if (d.kind === "symbols") return parseSymbols(s).join(",") === parseSymbols(def).join(",");
  if (d.kind === "tags") {
    const norm = (t: string) => Array.from(new Set(t.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))).join(",");
    return norm(s) === norm(def);
  }
  return s === def;
}

const initVals = (defs: LimitDef[], saved: Record<string, LimitValue>): FormVals => {
  const e = effective(defs, saved);
  return Object.fromEntries(defs.map((d) => [d.key, toForm(d, e[d.key])]));
};

const unitBefore = (d: LimitDef) => (d.unit === "$" ? "$" : "");
const unitAfter = (d: LimitDef) => (d.unit && d.unit !== "$" ? d.unit : "");

/** How a value reads next to a field ("default $150", "default Tell Claude"). */
function showValue(d: LimitDef, v: LimitValue): string {
  if (d.kind === "bool") return v === true || v === "true" ? "on" : "off";
  if (d.kind === "time") return v === "" || v === "off" ? "off" : String(v);
  if (d.kind === "symbols" || d.kind === "tags") {
    const list = String(v).split(",").filter(Boolean);
    if (!list.length) return "none";
    return list.length > 4 ? `${list.slice(0, 4).join(", ")}…` : list.join(", ");
  }
  if (d.kind === "select") return d.optionLabels?.[String(v)] ?? String(v);
  const n = Number(v);
  if (d.unit === "$") return `$${n.toLocaleString("en-US")}`;
  if (d.unit === "%") return `${n}%`;
  if (d.unit === "×") return `${n}×`;
  return d.unit ? `${n} ${d.unit}` : String(n);
}

/** Small "Off" badge for a box that is switched off (Settings → Box is on). */
export function OffBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="This box is switched off: it places no new trades. Open positions keep their stops and exits."
      className={`rounded-full bg-loss/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-loss ring-1 ring-inset ring-loss/30 ${className}`}
    >
      Off
    </span>
  );
}

/* ---------------- one field ---------------- */

const BOX = "mt-1 flex items-center gap-1 rounded-md border border-border bg-surface px-2 focus-within:border-accent";
const INPUT = "w-full min-w-0 bg-transparent py-1.5 font-mono text-sm text-text tnum outline-none";

function Field({ d, value, set }: { d: LimitDef; value: string; set: (v: string) => void }) {
  const id = `f-${d.key}`;
  if (d.kind === "bool") {
    const checked = value === "true";
    return (
      <label htmlFor={id} className="mt-1 inline-flex cursor-pointer items-center gap-2">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => set(e.target.checked ? "true" : "false")} className="peer sr-only" />
        <span
          aria-hidden
          className="relative h-5 w-9 shrink-0 rounded-full bg-surface2 ring-1 ring-inset ring-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-dim after:transition-transform peer-checked:bg-accent/30 peer-checked:after:translate-x-4 peer-checked:after:bg-accent peer-focus-visible:ring-accent"
        />
        <span className={`text-xs ${checked ? "text-text" : "text-dim"}`}>{checked ? "on" : "off"}</span>
      </label>
    );
  }
  if (d.kind === "time") {
    const off = value === "off";
    const time = off ? String(d.def || "") : value;
    return (
      <span className="mt-1 flex items-center gap-2">
        <span className={`${BOX} mt-0 flex-1 ${off ? "opacity-50" : ""}`}>
          <input
            id={id}
            type="time"
            disabled={off}
            value={time}
            onChange={(e) => set(e.target.value)}
            min={d.tmin ?? "09:30"}
            max={d.tmax ?? "16:00"}
            step={60}
            required={!off}
            className={INPUT}
          />
        </span>
        {d.allowOff && (
          <label className="flex items-center gap-1 text-xs text-dim">
            <input
              type="checkbox"
              checked={off}
              onChange={(e) => set(e.target.checked ? "off" : String(d.def || "09:30"))}
              className="accent-[var(--color-accent)]"
            />
            off
          </label>
        )}
      </span>
    );
  }
  if (d.kind === "select") {
    return (
      <span className={BOX}>
        <select id={id} value={value} onChange={(e) => set(e.target.value)} className={`${INPUT} cursor-pointer font-sans`}>
          {d.options?.map((o) => (
            <option key={o} value={o}>
              {d.optionLabels?.[o] ?? o}
            </option>
          ))}
        </select>
      </span>
    );
  }
  if (d.kind === "symbols" || d.kind === "tags") {
    return (
      <span className={BOX}>
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={d.kind === "symbols" ? "e.g. AAPL, MSFT" : ""}
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
        />
      </span>
    );
  }
  return (
    <span className={BOX}>
      {unitBefore(d) && <span className="font-mono text-xs text-faint">{unitBefore(d)}</span>}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        min={d.min}
        max={d.max}
        step={d.int ? 1 : "any"}
        className={INPUT}
      />
      {unitAfter(d) && <span className="font-mono text-xs text-faint">{unitAfter(d)}</span>}
    </span>
  );
}

/** One labelled setting: label, a dot + "default X" + revert when changed, the input, a readable hint. */
function Row({ d, value, set, extra }: { d: LimitDef; value: string; set: (v: string) => void; extra?: ReactNode }) {
  const changed = !isDefault(d, value);
  const wide = d.kind === "symbols" || d.kind === "tags";
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <label htmlFor={`f-${d.key}`} className="flex min-w-0 items-baseline gap-1.5 text-[13px] font-medium text-text">
          {changed && <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-accent" aria-label="changed from default" />}
          <span className="min-w-0">{d.label}</span>
        </label>
        <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] text-faint">
          default {showValue(d, d.def)}
          {changed && (
            <button
              type="button"
              onClick={() => set(toForm(d, d.def))}
              className="font-sans text-[11px] font-medium text-accent hover:underline"
              title={`Put back the default (${showValue(d, d.def)})`}
            >
              revert
            </button>
          )}
        </span>
      </div>
      <Field d={d} value={value} set={set} />
      {d.hint && <p className="mt-1 text-xs leading-snug text-dim">{d.hint}</p>}
      {extra}
    </div>
  );
}

/** A list of settings: plain fields first, then "Advanced (n)", then the scorecard weights in their own fold. */
function FieldList({
  defs,
  vals,
  set,
  claude,
  onlyChanged,
  extras,
}: {
  defs: LimitDef[];
  vals: FormVals;
  set: (key: string, v: string) => void;
  claude: boolean;
  onlyChanged: boolean;
  extras?: Record<string, ReactNode>;
}) {
  const shown = defs.filter((d) => isShown(d, vals) && (!onlyChanged || !isDefault(d, vals[d.key])));
  const row = (d: LimitDef) => <Row key={d.key} d={d} value={vals[d.key] ?? toForm(d, d.def)} set={(v) => set(d.key, v)} extra={extras?.[d.key]} />;
  const grid = (ds: LimitDef[]) => <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{ds.map(row)}</div>;
  if (onlyChanged) return shown.length ? grid(shown) : null;
  const main = shown.filter((d) => !isAdvanced(d, claude) && !isWeight(d));
  const adv = shown.filter((d) => isAdvanced(d, claude));
  const weights = shown.filter((d) => isWeight(d));
  const changedIn = (ds: LimitDef[]) => ds.filter((d) => !isDefault(d, vals[d.key])).length;
  return (
    <div className="space-y-4">
      {main.length > 0 && grid(main)}
      {adv.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-dim hover:text-text">
            Advanced ({adv.length}){changedIn(adv) ? <span className="ml-1 text-accent">· {changedIn(adv)} changed</span> : null}
          </summary>
          <div className="border-t border-border p-3">{grid(adv)}</div>
        </details>
      )}
      {weights.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-dim hover:text-text">
            Fine-tune how the score is calculated ({weights.length})
            {changedIn(weights) ? <span className="ml-1 text-accent">· {changedIn(weights)} changed</span> : null}
          </summary>
          <div className="border-t border-border p-3">
            <p className="mb-3 text-xs leading-snug text-dim">
              How much each part counts toward the 0–100 score. They are relative: doubling one counts it twice as much as
              before. 0 = ignore that part.
            </p>
            {grid(weights)}
          </div>
        </details>
      )}
    </div>
  );
}

/* ---------------- reset ---------------- */

/** Reset a box to its defaults but keep its size (budget). */
function resetKeepingSize(bookKey: string, _budget: number): Promise<Result> {
  return resetBookLimits(bookKey);
}

/* ---------------- a box's Settings section ---------------- */

const NOT_APPLICABLE: Partial<Record<SettingsSection, { rules?: string; claude?: string }>> = {
  "When to trade": { rules: "Rules boxes run on fixed weekday schedules; there is no buying window to set." },
  Checks: { rules: "Doesn't apply: Rules boxes buy on fixed signals, with no scorecard or second opinion." },
  Learning: { rules: "Doesn't apply: Rules boxes don't learn; they follow these settings exactly." },
};

const SECTION_BLURB: Partial<Record<SettingsSection, string>> = {
  "Money & risk": "How much a trade, a day and a single holding can risk.",
  "When to trade": "The buying window and when everything is sold.",
  "What to trade": "Which stocks are in or out.",
  "How it decides": "How a stock gets picked and bought.",
  Checks: "What each stock must pass before a buy. Tell Claude = Claude is told and decides; Stop the trade = the Mac refuses it.",
  Learning: "The review after each close, and the lessons Claude reads the next morning.",
  Exits: "How open trades are protected and sold.",
};

export function BoxSettings({
  bookKey,
  claude,
  defs,
  saved,
  budget,
  fieldExtras,
  sectionExtras,
  schedule,
  scheduleBadge,
  initialSection,
}: {
  bookKey: string;
  claude: boolean;
  defs: LimitDef[];
  saved: Record<string, LimitValue>;
  /** The box's size now: kept on reset. */
  budget: number;
  fieldExtras?: Record<string, ReactNode>;
  sectionExtras?: Partial<Record<SettingsSection, ReactNode>>;
  /** What the Schedule & cost section shows; gets the form's current values (e.g. for a backtest). */
  schedule: (current: () => FormVals) => ReactNode;
  scheduleBadge?: string;
  initialSection?: SettingsSection;
}) {
  const { msg, busy, run, setMsg } = useAction();
  const [vals, setVals] = useState<FormVals>(() => initVals(defs, saved));
  const [base, setBase] = useState<FormVals>(() => initVals(defs, saved));
  const [active, setActive] = useState<SettingsSection>(initialSection ?? "Money & risk");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const set = (key: string, v: string) => setVals((p) => ({ ...p, [key]: v }));

  const sorted = sortDefs(defs);
  const bySection = (s: SettingsSection) => sorted.filter((d) => sectionOf(d) === s);
  // Only fields that are shown count as changes (a hidden child keeps its value but can't be seen or reverted).
  const isChanged = (d: LimitDef) => isShown(d, vals) && !isDefault(d, vals[d.key]);
  const changed = defs.filter(isChanged);
  const changedIn = (s: SettingsSection) => bySection(s).filter(isChanged).length;
  const unsaved = defs.some((d) => (vals[d.key] ?? "") !== (base[d.key] ?? ""));
  const preset = matchPreset(defs, claude, (d, v) => {
    const s0 = vals[d.key];
    if (s0 === undefined) return false;
    // An emptied field means the field's default, not "anything".
    const s = s0.trim() === "" ? toForm(d, d.def) : s0;
    return isDefault({ ...d, def: v }, s);
  });

  function applyPreset(id: PresetId) {
    const v = presetValues(defs, id, claude);
    setVals((p) => ({ ...p, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toForm(defs.find((d) => d.key === k)!, x)])) }));
    setMsg({ text: `${PRESETS.find((p) => p.id === id)?.name} filled in. Nothing is saved until you press Save.` });
  }

  function reset() {
    const size = Number(budget) || 0;
    if (
      !confirm(
        `Reset every setting in this box to its default?\n\nThe box size stays at $${size.toLocaleString("en-US")}, and the On/Off switch stays as it is. Your current values can't be brought back.`
      )
    )
      return;
    run(
      () => resetKeepingSize(bookKey, size),
      () => {
        const fresh = initVals(defs, { budget: size, ...(vals.enabled === "false" ? { enabled: false } : {}) });
        setVals(fresh);
        setBase(fresh);
      }
    );
  }

  const showSchedule = active === "Schedule & cost" && !onlyChanged;
  const chip = (s: SettingsSection) => {
    const on = active === s && !onlyChanged;
    const n = s === "Schedule & cost" ? 0 : changedIn(s);
    return (
      <button
        key={s}
        type="button"
        onClick={() => {
          setActive(s);
          setOnlyChanged(false);
        }}
        aria-current={on ? "true" : undefined}
        className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition md:w-full ${on ? "bg-surface2 font-semibold text-text" : "text-dim hover:bg-surface2/60 hover:text-text"} max-md:border max-md:border-border`}
      >
        <span className="whitespace-nowrap">{s}</span>
        {n > 0 && <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent tnum">{n}</span>}
      </button>
    );
  };

  return (
    <div className="md:grid md:grid-cols-[176px_minmax(0,1fr)] md:gap-6">
      <nav aria-label="Settings groups" className="mb-4 flex flex-wrap gap-1.5 md:mb-0 md:block md:space-y-0.5 md:self-start">
        {SECTIONS.map(chip)}
      </nav>

      <div className="min-w-0 space-y-4">
        {/* presets + filter */}
        <div className="rounded-xl border border-border bg-surface2/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-dim">Starting point</span>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${preset === p.id ? "border-accent bg-accent/10 font-semibold text-accent" : "border-border bg-surface text-dim hover:text-text"}`}
              >
                {p.name}
              </button>
            ))}
            <span
              className={`rounded-full border px-2.5 py-1 text-xs ${preset === "custom" ? "border-accent bg-accent/10 font-semibold text-accent" : "border-dashed border-border text-faint"}`}
              title="Your own mix of values"
            >
              Custom
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-snug text-dim">
            {PRESETS.find((p) => p.id === preset)?.blurb ??
              "Your own mix. Pick a starting point to fill the form; nothing is saved until Save."}{" "}
            Presets never turn on short selling or borrowing, and never change the box size.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-xs">
            <label className="flex cursor-pointer items-center gap-1.5 text-dim">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} className="accent-[var(--color-accent)]" />
              Show only changes
            </label>
            <span className="text-faint">
              {changed.length ? `${changed.length} setting${changed.length === 1 ? "" : "s"} changed from default` : "all defaults"}
            </span>
          </div>
        </div>

        <form
          className={showSchedule ? "hidden" : "space-y-4"}
          onSubmit={(e) => {
            e.preventDefault();
            const v = { ...vals };
            run(() => saveBookLimits(bookKey, v), () => setBase(v));
          }}
        >
          {onlyChanged ? (
            changed.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
                Nothing changed: every setting is at its default.
              </p>
            ) : (
              SECTIONS.filter((s) => s !== "Schedule & cost" && changedIn(s) > 0).map((s) => (
                <section key={s}>
                  <h4 className={`mb-2 ${LABEL}`}>{s}</h4>
                  <FieldList defs={bySection(s)} vals={vals} set={set} claude={claude} onlyChanged />
                </section>
              ))
            )
          ) : (
            active !== "Schedule & cost" && (
              <section>
                <h3 className="font-display text-base font-semibold text-text">{active}</h3>
                {SECTION_BLURB[active] && <p className="mb-3 mt-0.5 text-xs text-dim">{SECTION_BLURB[active]}</p>}
                {bySection(active).length === 0 && !sectionExtras?.[active] ? (
                  <p className="rounded-lg bg-surface2/60 px-3 py-2 text-sm text-dim">
                    {NOT_APPLICABLE[active]?.[claude ? "claude" : "rules"] ?? "Nothing to set here for this box."}
                  </p>
                ) : (
                  <FieldList defs={bySection(active)} vals={vals} set={set} claude={claude} onlyChanged={false} extras={fieldExtras} />
                )}
                {sectionExtras?.[active] && <div className="mt-4">{sectionExtras[active]}</div>}
              </section>
            )
          )}

          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-surface/95 px-1 py-3 backdrop-blur">
            <button
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {unsaved && <span className="text-xs text-watch">Unsaved changes</span>}
            <button type="button" disabled={busy} onClick={reset} className="text-xs text-dim hover:text-loss">
              Reset to defaults…
            </button>
            <Msg msg={msg} />
          </div>
          <p className="text-xs leading-snug text-faint">
            {claude
              ? "The Mac copies these into this box before every Claude run, and its risk check refuses anything that breaks them."
              : "Used by the rules engine from its next run. Box size sets this box's starting cash."}
          </p>
        </form>

        {showSchedule && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-display text-base font-semibold text-text">Schedule &amp; cost</h3>
              {scheduleBadge && (
                <span className="rounded-full bg-watch/10 px-2 py-0.5 text-[11px] font-semibold text-watch ring-1 ring-inset ring-watch/30">
                  {scheduleBadge}
                </span>
              )}
            </div>
            {schedule(() => vals)}
          </section>
        )}
      </div>
    </div>
  );
}

/* ---------------- shared Claude runner (Schedule & cost) ---------------- */

/** This week's Claude usage against the cap, and whether the slow-down is on. */
export function usageState(runner: Record<string, LimitValue>, defs: LimitDef[], weekCost: number) {
  const v = effective(defs, runner);
  const cap = Number(v.weekly_cap_usd) || 0;
  const slowAt = Number(v.throttle_pct) || 0;
  const used = cap ? Math.min(100, (weekCost / cap) * 100) : 0;
  return { v, cap, slowAt, used, slowed: cap > 0 && slowAt > 0 && used >= slowAt, capped: cap > 0 && used >= 100 };
}

export function UsageMeter({ runner, defs, weekCost }: { runner: Record<string, LimitValue>; defs: LimitDef[]; weekCost: number }) {
  const { cap, slowAt, used, slowed, capped, v } = usageState(runner, defs, weekCost);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-dim">Claude usage this week</span>
        <span className="flex items-center gap-2 font-mono text-xs text-text tnum">
          ${weekCost.toFixed(2)} {cap ? <span className="text-faint">of ${cap.toFixed(0)}</span> : <span className="text-faint">· no cap</span>}
          {(slowed || capped) && (
            <span className="rounded-full bg-watch/10 px-2 py-0.5 font-sans text-[11px] font-semibold text-watch ring-1 ring-inset ring-watch/30">
              {capped ? "cap reached" : `slowed down: every ${String(v.throttle_interval_min)} min`}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface2">
        <div className={`h-full rounded-full ${slowed || capped ? "bg-watch" : "bg-accent"}`} style={{ width: `${used}%` }} />
      </div>
      {cap > 0 && slowAt > 0 && <p className="mt-1 text-[11px] text-faint">slows down at {slowAt}% of the cap</p>}
    </div>
  );
}

/** How and when the Mac runs Claude (ai_runner.settings) — shared by both Claude boxes. */
export function RunnerSettings({ defs, saved, weekCost }: { defs: LimitDef[]; saved: Record<string, LimitValue>; weekCost: number }) {
  const { msg, busy, run } = useAction();
  const [vals, setVals] = useState<FormVals>(() => initVals(defs, saved));
  const set = (key: string, v: string) => setVals((p) => ({ ...p, [key]: v }));
  const e = effective(defs, saved);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border p-3">
        <UsageMeter runner={saved} defs={defs} weekCost={weekCost} />
        <p className="mt-2 text-xs leading-relaxed text-dim">
          {String(e.model)} every {String(e.interval_min)} min in market hours
          {e.news_wake ? ", plus a free watcher that wakes Claude early on important news" : ""}. Usage is in API-equivalent
          dollars from Claude&apos;s own report; on a Max plan it comes out of your weekly limit, not your card.
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          const v = { ...vals };
          run(() => saveRunnerSettings(v));
        }}
      >
        <FieldList defs={sortDefs(defs)} vals={vals} set={set} claude onlyChanged={false} />
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <button
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save schedule & cost"}
          </button>
          <Msg msg={msg} />
        </div>
      </form>
    </div>
  );
}

/* ---------------- Alpaca connection ---------------- */

/** Connect / disconnect the user's own Alpaca PAPER account (keys go to Vault, encrypted). */
export function ConnectCard({ connection }: { connection: { hint: string | null; connected_at: string } | null }) {
  const { msg, busy, run } = useAction();
  const [open, setOpen] = useState(!connection);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className={LABEL}>Alpaca paper account</div>
        {connection ? (
          <span className="font-mono text-xs text-gain">connected {connection.hint ?? ""}</span>
        ) : (
          <span className="text-xs text-watch">not connected</span>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-dim">
        Used by the two Rules boxes (and for live prices here). Paper keys only — anything that isn&apos;t a PK… key on
        a PA… paper account is refused. Stored encrypted in the database under your account, never shown again.
      </p>
      {connection && !open && (
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => setOpen(true)} className="text-xs text-dim hover:text-text">
            Replace keys
          </button>
          <button
            disabled={busy}
            onClick={() => confirm("Disconnect and delete the stored paper keys?") && run(() => disconnectAlpaca())}
            className="text-xs text-loss hover:underline"
          >
            Disconnect
          </button>
          <Msg msg={msg} />
        </div>
      )}
      {open && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const form = e.currentTarget;
            run(
              () => connectAlpaca(fd),
              () => {
                form.reset();
                setOpen(false);
              }
            );
          }}
        >
          <input
            name="key_id"
            placeholder="API key ID (PK…)"
            autoComplete="off"
            spellCheck={false}
            required
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-accent"
          />
          <input
            name="secret"
            type="password"
            placeholder="Secret key"
            autoComplete="off"
            required
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-accent"
          />
          <div className="flex items-center gap-3">
            <button
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Checking with Alpaca…" : "Connect"}
            </button>
            {connection && (
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-dim hover:text-text">
                Cancel
              </button>
            )}
            <Msg msg={msg} />
          </div>
        </form>
      )}
    </div>
  );
}
