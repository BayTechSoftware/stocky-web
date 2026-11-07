"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectAlpaca, disconnectAlpaca, saveBookLimits, saveRunnerSettings } from "../actions";
import { effective, type LimitDef, type LimitValue, type Settings } from "@/lib/aitrader/limits";
import { LABEL } from "./ai-run";

type Result = { message: string } | { error: string };

function useAction() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg("error" in r ? { text: r.error, err: true } : { text: r.message });
      if (!("error" in r)) after?.();
      router.refresh();
    });
  };
  return { msg, busy, run };
}

function Msg({ msg }: { msg: { text: string; err?: boolean } | null }) {
  if (!msg) return null;
  return <p className={`text-xs ${msg.err ? "text-loss" : "text-gain"}`}>{msg.text}</p>;
}

const unitBefore = (d: LimitDef) => (d.unit === "$" ? "$" : "");
const unitAfter = (d: LimitDef) => (d.unit && d.unit !== "$" ? d.unit : "");

/** How a field's default reads next to its label. */
function showDefault(d: LimitDef): string {
  const v = d.def;
  if (d.kind === "bool") return v ? "on" : "off";
  if (d.kind === "time") return v === "" ? "off" : String(v);
  if (d.kind === "symbols" || d.kind === "tags") return v === "" ? "none" : String(v).split(",").length > 4 ? `${String(v).split(",").slice(0, 4).join(", ")}…` : String(v).split(",").join(", ");
  if (d.kind === "select") return String(v);
  const n = Number(v);
  const txt = d.unit === "$" ? `$${n.toLocaleString("en-US")}` : `${n}${d.unit ? (d.unit === "×" ? "×" : ` ${d.unit}`.replace(" %", "%")) : ""}`;
  return txt;
}

const BOX = "mt-0.5 flex items-center gap-1 rounded-md border border-border bg-surface px-2 focus-within:border-accent";
const INPUT = "w-full min-w-0 bg-transparent py-1 font-mono text-sm text-text tnum outline-none";

/** A time that can be switched off: when off, the form sends "off". */
function TimeField({ d, value }: { d: LimitDef; value: string }) {
  const [off, setOff] = useState(value === "");
  return (
    <span className="mt-0.5 flex items-center gap-2">
      <span className={`${BOX} mt-0 flex-1 ${off ? "opacity-50" : ""}`}>
        <input
          name={off ? undefined : d.key}
          type="time"
          disabled={off}
          defaultValue={value || String(d.def || "")}
          min={d.tmin ?? "09:30"}
          max={d.tmax ?? "16:00"}
          step={60}
          required={!off}
          className={INPUT}
        />
      </span>
      {off && <input type="hidden" name={d.key} value="off" />}
      <label className="flex items-center gap-1 text-[11px] text-dim">
        <input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} className="accent-[var(--color-accent)]" />
        off
      </label>
    </span>
  );
}

function Field({ d, value }: { d: LimitDef; value: LimitValue }) {
  if (d.kind === "bool") {
    return (
      <span className="mt-1 flex items-center gap-2">
        {/* Unchecked boxes send nothing: the hidden "false" goes first, a checked box overrides it. */}
        <input type="hidden" name={d.key} value="false" />
        <input
          type="checkbox"
          name={d.key}
          value="true"
          defaultChecked={value === true}
          className="peer sr-only"
          id={`f-${d.key}`}
        />
        <span
          aria-hidden
          className="relative h-4 w-7 shrink-0 rounded-full bg-surface2 ring-1 ring-inset ring-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-dim after:transition-transform peer-checked:bg-accent/30 peer-checked:after:translate-x-3 peer-checked:after:bg-accent peer-focus-visible:ring-accent"
        />
        <span className="text-[11px] text-dim peer-checked:hidden">off</span>
        <span className="hidden text-[11px] text-text peer-checked:inline">on</span>
      </span>
    );
  }
  if (d.kind === "time") {
    if (d.allowOff) return <TimeField d={d} value={String(value)} />;
    return (
      <span className={BOX}>
        <input name={d.key} type="time" defaultValue={String(value)} min={d.tmin ?? "09:30"} max={d.tmax ?? "16:00"} step={60} required className={INPUT} />
      </span>
    );
  }
  if (d.kind === "select") {
    return (
      <span className={BOX}>
        <select name={d.key} defaultValue={String(value)} className={`${INPUT} cursor-pointer`}>
          {d.options?.map((o) => (
            <option key={o} value={o}>
              {o}
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
          name={d.key}
          type="text"
          defaultValue={String(value).split(",").filter(Boolean).join(", ")}
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
      <input name={d.key} type="number" defaultValue={String(value)} min={d.min} max={d.max} step={d.step ?? "any"} required className={INPUT} />
      {unitAfter(d) && <span className="font-mono text-xs text-faint">{unitAfter(d)}</span>}
    </span>
  );
}

/** Settings inputs built from the shared definitions (same bounds the server enforces), grouped. */
function Fields({ defs, values }: { defs: LimitDef[]; values: Settings }) {
  const groups = Array.from(new Set(defs.map((d) => d.group)));
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <fieldset key={g}>
          <legend className={`mb-1.5 ${LABEL}`}>{g}</legend>
          <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {defs
              .filter((d) => d.group === g)
              .map((d) => {
                const wide = d.kind === "symbols" || d.kind === "tags";
                const Tag = d.kind === "bool" ? "label" : "div";
                return (
                  <Tag key={d.key} className={`block ${wide ? "sm:col-span-2" : ""}`} htmlFor={d.kind === "bool" ? `f-${d.key}` : undefined}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-dim">{d.label}</span>
                      <span className="shrink-0 font-mono text-[10px] text-faint">default {showDefault(d)}</span>
                    </span>
                    {d.kind === "bool" || d.kind === "time" ? (
                      <Field d={d} value={values[d.key]} />
                    ) : (
                      <label className="block">
                        <Field d={d} value={values[d.key]} />
                      </label>
                    )}
                    {d.hint && <span className="mt-0.5 block text-[10px] leading-tight text-faint">{d.hint}</span>}
                  </Tag>
                );
              })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(Array.from(new FormData(form).entries()).map(([k, v]) => [k, String(v)]));
}

/** Collapsible editor for one box's limits. */
export function LimitsEditor({
  bookKey,
  defs,
  saved,
  note,
}: {
  bookKey: string;
  defs: LimitDef[];
  saved: Record<string, LimitValue>;
  note: string;
}) {
  const { msg, busy, run } = useAction();
  const values = effective(defs, saved);
  const custom = defs.filter((d) => saved[d.key] !== undefined && saved[d.key] !== d.def).length;
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2">
        <span className={LABEL}>Limits</span>
        <span className="text-[11px] text-faint">{custom ? `${custom} changed from default` : "defaults"} · edit</span>
      </summary>
      <form
        className="space-y-3 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          run(() => saveBookLimits(bookKey, v));
        }}
      >
        <p className="text-[11px] leading-relaxed text-faint">{note}</p>
        <Fields defs={defs} values={values} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save limits"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => saveBookLimits(bookKey, {}))}
            className="text-xs text-dim hover:text-text"
          >
            Reset to defaults
          </button>
          <Msg msg={msg} />
        </div>
      </form>
    </details>
  );
}

/** How often Claude runs + weekly usage cap, with this week's usage so far. */
export function RunnerCard({
  defs,
  saved,
  weekCost,
}: {
  defs: LimitDef[];
  saved: Record<string, LimitValue>;
  weekCost: number;
}) {
  const { msg, busy, run } = useAction();
  const values = effective(defs, saved);
  const cap = Number(values.weekly_cap_usd) || 0;
  const used = cap ? Math.min(100, (weekCost / cap) * 100) : 0;
  const slowAt = Number(values.throttle_pct) || 0;
  return (
    <div className="card rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className={LABEL}>Claude runner (your Mac)</div>
        <div className="font-mono text-xs text-dim tnum">
          ${weekCost.toFixed(2)} {cap ? `of $${cap.toFixed(0)} ` : "· no cap "}this week
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full rounded-full ${used >= 100 ? "bg-loss" : slowAt && used >= slowAt ? "bg-watch" : "bg-accent"}`}
          style={{ width: `${used}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
        {String(values.model)} every {String(values.interval_min)} min in market hours
        {cap && slowAt ? `, every ${String(values.throttle_interval_min)} min past ${slowAt}% of the cap` : ""}
        {values.news_wake ? ", plus a free watcher that wakes Claude early on alerts or important news" : ""}. Usage is
        API-equivalent dollars from Claude&apos;s own report — on Max it comes out of your weekly limit, not your card.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-dim hover:text-text">Edit schedule, usage &amp; news</summary>
        <form
          className="mt-2 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            run(() => saveRunnerSettings(v));
          }}
        >
          <Fields defs={defs} values={values} />
          <div className="flex items-center gap-3">
            <button
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <Msg msg={msg} />
          </div>
        </form>
      </details>
    </div>
  );
}

/** Connect / disconnect the user's own Alpaca PAPER account (keys go to Vault, encrypted). */
export function ConnectCard({ connection }: { connection: { hint: string | null; connected_at: string } | null }) {
  const { msg, busy, run } = useAction();
  const [open, setOpen] = useState(!connection);
  return (
    <div className="card rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className={LABEL}>Alpaca paper account</div>
        {connection ? (
          <span className="font-mono text-xs text-gain">
            connected {connection.hint ?? ""}
          </span>
        ) : (
          <span className="text-xs text-watch">not connected</span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
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
