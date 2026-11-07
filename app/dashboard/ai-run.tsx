"use client";

import type { Decision, PipelineStep, RunSummary, TraceItem } from "@/lib/aitrader/engine";
import { price as fprice, shares } from "@/lib/portfolio";

export const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-faint";

/** The repo's chain, in the order it runs. */
const STAGES: { key: string; name: string }[] = [
  { key: "scanner", name: "Scanner" },
  { key: "news", name: "News" },
  { key: "entry", name: "Entry" },
  { key: "exit", name: "Exit plan" },
  { key: "timemachine", name: "Time machine" },
  { key: "budget", name: "Budget" },
  { key: "risk", name: "Risk" },
  { key: "broker", name: "Broker" },
  { key: "order", name: "Order" },
  { key: "alerts", name: "Alerts" },
];
const stageName = (k: string) => STAGES.find((s) => s.key === k)?.name ?? k;
const stageRank = (k: string) => {
  const i = STAGES.findIndex((s) => s.key === k);
  return i < 0 ? 99 : i;
};

export function when(iso: string, withDay = true) {
  return new Date(iso).toLocaleString(undefined, {
    ...(withDay ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActionPill({ a }: { a: Decision["action"] }) {
  const cls =
    a === "buy"
      ? "bg-gain/10 text-gain"
      : a === "sell"
        ? "bg-loss/10 text-loss"
        : a === "cancel"
          ? "bg-watch/10 text-watch"
          : "bg-black/5 text-faint";
  return (
    <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {a}
    </span>
  );
}

function verdictTone(s: PipelineStep): string {
  const v = (s.verdict ?? "").toUpperCase();
  if (s.ok === true || /^(PASS|GO|OK|FILLED|PLACED|ACCEPTED|NEW|BUY)/.test(v)) return "bg-gain/10 text-gain ring-gain/25";
  if (s.ok === false || /^(BLOCK|FAIL|NO|REJECT|DENIED|SKIP|STOP)/.test(v)) return "bg-loss/10 text-loss ring-loss/25";
  return "bg-surface2 text-dim ring-border";
}

export function Decisions({ decisions, limit }: { decisions: Decision[]; limit?: number }) {
  const shown = limit ? decisions.slice(0, limit) : decisions;
  if (!shown.length) return null;
  return (
    <ul className="space-y-1">
      {shown.map((d, i) => (
        <li key={i} className="flex gap-2 text-xs">
          <ActionPill a={d.action} />
          <span className="min-w-0">
            <span className="font-semibold text-text">{d.symbol}</span>
            {d.qty != null && d.price != null && (
              <span className="font-mono text-dim tnum"> {shares(d.qty)} @ ${fprice(d.price)}</span>
            )}
            {d.stop != null && (
              <span className="font-mono text-faint tnum">
                {" "}
                (stop {fprice(d.stop)}
                {d.target != null ? ` / target ${fprice(d.target)}` : ""})
              </span>
            )}
            <span className="text-dim"> — {d.reason}</span>
          </span>
        </li>
      ))}
      {limit && decisions.length > limit && (
        <li className="text-[11px] text-faint">+{decisions.length - limit} more in the full log</li>
      )}
    </ul>
  );
}

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 120);
  return String(v);
}

/** Per-candidate view of the repo's pipeline: one row per symbol, one chip per stage. */
export function Pipeline({ steps }: { steps: PipelineStep[] }) {
  if (!steps.length) return null;
  const bySym = new Map<string, PipelineStep[]>();
  for (const s of steps) {
    const k = s.symbol || "—";
    bySym.set(k, [...(bySym.get(k) ?? []), s]);
  }
  // Market-wide steps (scanner, general news) first, then candidates in the order they appeared.
  const groups = Array.from(bySym.entries()).sort((a, b) => (a[0] === "—" ? -1 : b[0] === "—" ? 1 : 0));
  return (
    <div className="space-y-2">
      {groups.map(([sym, ss]) => (
        <div key={sym} className="rounded-lg border border-border bg-surface p-2.5">
          <div className="mb-1.5 font-display text-sm font-semibold text-text">
            {sym === "—" ? "Market scan" : sym}
          </div>
          <ol className="space-y-1.5">
            {[...ss]
              .sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || (a.t ?? 0) - (b.t ?? 0))
              .map((s, i) => (
                <li key={i}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-start gap-2 text-xs">
                      <span className="w-[86px] shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                        {stageName(s.stage)}
                      </span>
                      {s.verdict && (
                        <span
                          className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${verdictTone(s)}`}
                        >
                          {s.verdict}
                        </span>
                      )}
                      <span className="min-w-0 text-dim">{s.summary}</span>
                    </summary>
                    {s.data && Object.keys(s.data).length > 0 && (
                      <dl className="ml-[94px] mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-surface2/60 p-2 font-mono text-[11px] tnum">
                        {Object.entries(s.data).map(([k, v]) => (
                          <div key={k} className="contents">
                            <dt className="text-faint">{k}</dt>
                            <dd className="break-words text-text">{fmtVal(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </details>
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

const KIND_DOT: Record<string, string> = {
  tool: "bg-accent",
  text: "bg-text",
  blocked: "bg-loss",
  error: "bg-watch",
};

/** Step-by-step: every tool Claude called and what it said, in order. */
export function Trace({ trace }: { trace: TraceItem[] }) {
  if (!trace.length) return null;
  return (
    <ol className="relative space-y-1.5 border-l border-border pl-3">
      {trace.map((x, i) => (
        <li key={i} className="relative">
          <span className={`absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full ${KIND_DOT[x.kind] ?? "bg-faint"}`} />
          <div className="flex items-baseline gap-2 text-xs">
            <span className="w-9 shrink-0 text-right font-mono text-[10px] text-faint tnum">{Math.round(x.at ?? x.t ?? 0)}s</span>
            <span
              className={`min-w-0 ${x.kind === "text" ? "text-text" : x.kind === "blocked" ? "text-loss" : "font-mono text-[11px] text-dim"}`}
            >
              {x.kind === "blocked" && "Blocked: "}
              {x.label}
            </span>
          </div>
          {x.detail && (
            <details className="ml-11">
              <summary className="cursor-pointer text-[10px] text-faint hover:text-dim">output</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface2/60 p-2 font-mono text-[10.5px] leading-snug text-dim">
                {x.detail}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Everything about one run: header, decisions, pipeline per candidate, trace, guard blocks. */
export function RunDetail({ s, error, mode }: { s: RunSummary | null; error: string | null; mode: string }) {
  const decisions = s?.decisions ?? [];
  const steps = s?.steps ?? [];
  const trace = s?.trace ?? [];
  const blocks = s?.guard_blocks ?? [];
  const u = s?.usage;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-dim tnum">
        {s?.phase && <span className="font-semibold text-text">{s.phase}</span>}
        {s?.reason && <span>woke: {s.reason}</span>}
        {u?.secs != null && <span>{Math.round(u.secs)}s</span>}
        {u?.turns != null && <span>{u.turns} turns</span>}
        {u?.cost_usd != null && <span>≈${Number(u.cost_usd).toFixed(2)} usage</span>}
      </div>
      {(mode === "dry" || mode === "claude-dry") && (
        <p className="text-[11px] text-watch">Dry run — these decisions were made, nothing was placed.</p>
      )}
      {error && <p className="text-xs text-loss">{error}</p>}
      {s?.halted && <p className="text-xs text-watch">{s.halted}</p>}
      {s?.note && <p className="text-xs leading-relaxed text-text">{s.note}</p>}

      {decisions.length > 0 && (
        <div>
          <div className={`mb-1 ${LABEL}`}>Decisions ({decisions.length})</div>
          <Decisions decisions={decisions} />
        </div>
      )}

      {steps.length > 0 && (
        <div>
          <div className={`mb-1 ${LABEL}`}>Repo pipeline, per candidate</div>
          <Pipeline steps={steps} />
        </div>
      )}

      {blocks.length > 0 && (
        <div>
          <div className={`mb-1 ${LABEL}`}>Guard blocks ({blocks.length})</div>
          <ul className="space-y-0.5">
            {blocks.map((b, i) => (
              <li key={i} className="font-mono text-[11px] text-loss">
                {b.tool}: <span className="text-dim">{b.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {trace.length > 0 && (
        <details>
          <summary className={`cursor-pointer ${LABEL} hover:text-dim`}>What Claude did — {trace.length} steps</summary>
          <div className="mt-2">
            <Trace trace={trace} />
          </div>
        </details>
      )}
    </div>
  );
}
