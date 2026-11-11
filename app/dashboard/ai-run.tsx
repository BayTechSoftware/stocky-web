"use client";

import type { Decision, DecisionScorecard, PipelineStep, RunSummary, TraceItem } from "@/lib/aitrader/engine";
import { SCORECARD_GATE_LABEL, SCORECARD_PART_LABEL } from "@/lib/aitrader/limits";
import { bearOf, gateCounts, gateTone, scoreBand, scoreOf, scorecardOf, type GateTone } from "@/lib/aitrader/scorecard";
import { price as fprice, shares } from "@/lib/portfolio";

export const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-faint";

/** Gain / loss / flat text colour for a signed number. */
export function col(v: number | null | undefined) {
  if (v == null || Math.abs(v) < 0.005) return "text-dim";
  return v > 0 ? "text-gain" : "text-loss";
}

/** The steps of one Claude check, in the order they run. */
const STAGES: { key: string; name: string }[] = [
  { key: "scanner", name: "Scanner" },
  { key: "news", name: "News" },
  { key: "scorecard", name: "Scorecard" },
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
    a === "buy" || a === "cover"
      ? "bg-gain/10 text-gain"
      : a === "sell" || a === "short"
        ? "bg-loss/10 text-loss"
        : a === "cancel"
          ? "bg-watch/10 text-watch"
          : "bg-black/5 text-faint";
  return (
    <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {a === "short" ? "sell short" : a === "cover" ? "buy to cover" : a}
    </span>
  );
}

const BAND_CLS: Record<string, string> = {
  high: "bg-gain/10 text-gain ring-gain/25",
  mid: "bg-watch/10 text-watch ring-watch/25",
  low: "bg-loss/10 text-loss ring-loss/25",
  none: "bg-surface2 text-faint ring-border",
};

/** A decision's 0–100 scorecard score as a small chip. */
export function ScoreChip({ score }: { score: number | null }) {
  return (
    <span
      title="Scorecard score (0–100)"
      className={`h-fit shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tnum ring-1 ring-inset ${BAND_CLS[scoreBand(score)]}`}
    >
      {score == null ? "n/a" : score}
    </span>
  );
}

type Bear = NonNullable<ReturnType<typeof bearOf>>;

const BEAR_CLS: Record<Bear["verdict"], string> = {
  against: "bg-loss/10 text-loss ring-loss/25",
  mixed: "bg-watch/10 text-watch ring-watch/25",
  weak: "bg-gain/10 text-gain/80 ring-gain/20",
  unavailable: "bg-surface2 text-faint ring-border",
};

const BEAR_TITLE: Record<Bear["verdict"], string> = {
  against: "Second opinion: a separate Claude call made a strong case against this trade",
  mixed: "Second opinion: the case against this trade is so-so",
  weak: "Second opinion: the case against this trade is weak",
  unavailable: "Second opinion: it couldn't run this time",
};

/** The bear check's verdict as a small chip: "Bear: against 80%". */
export function BearChip({ bear }: { bear: Bear }) {
  const conf = bear.verdict !== "unavailable" && bear.confidence != null ? ` ${bear.confidence}%` : "";
  return (
    <span
      title={BEAR_TITLE[bear.verdict]}
      className={`h-fit shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tnum ring-1 ring-inset ${BEAR_CLS[bear.verdict]}`}
    >
      Second opinion: {bear.verdict}
      {conf}
    </span>
  );
}

/** The bear check's argument, for a decision's expanded detail. */
function BearCase({ bear }: { bear: Bear }) {
  if (!bear.case) return null;
  return (
    <p className="text-[11px] leading-snug text-dim">
      <span className="font-semibold text-text">Case against</span>{" "}
      <span className="text-faint">(a separate Claude call argued against the trade)</span>: {bear.case}
    </p>
  );
}

/** A decision's bear case on its own, when it has no scorecard to expand. */
function BearDetail({ bear }: { bear: Bear }) {
  if (!bear.case) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer list-none text-[11px] text-dim hover:text-text">the case against ›</summary>
      <div className="mt-1 rounded-md bg-surface2/60 p-2">
        <BearCase bear={bear} />
      </div>
    </details>
  );
}

const GATE_ICON: Record<GateTone, { icon: string; cls: string; word: string }> = {
  pass: { icon: "✓", cls: "text-gain", word: "pass" },
  warn: { icon: "!", cls: "text-watch", word: "warn" },
  block: { icon: "✕", cls: "text-loss", word: "blocks" },
  "fail-off": { icon: "·", cls: "text-faint", word: "off" },
  na: { icon: "–", cls: "text-faint", word: "n/a" },
};

/** A decision's scorecard: gates with pass / warn / fail icons and their numbers, then the component scores. */
export function ScorecardView({ card, bear }: { card: DecisionScorecard; bear?: Bear | null }) {
  const gates = card.gates ?? [];
  const parts = (card.parts ?? []).filter((p) => (p.w ?? 0) > 0);
  return (
    <details className="mt-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-dim hover:text-text">
        <ScoreChip score={card.score ?? null} />
        <span>
          scorecard{card.dir ? ` (${card.dir})` : ""}
          {gateCounts(card) ? ` — ${gateCounts(card)}` : ""}
          {card.at ? <span className="text-faint"> · {card.at.slice(11) || card.at} NY</span> : null}
        </span>
      </summary>
      <div className="mt-1 space-y-2 rounded-md bg-surface2/60 p-2">
        {card.blocked && card.blocked.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-loss">
            {card.blocked.map((b, i) => (
              <li key={i}>Blocked: {b}</li>
            ))}
          </ul>
        )}
        {card.penalty?.extension ? (
          <p className="text-[11px] text-watch">
            Chasing — it already ran: −{card.penalty.extension} points. Waiting for a dip back to today&apos;s average price is the better buy.
          </p>
        ) : null}
        {card.why && <p className="text-[11px] text-text">Claude: {card.why}</p>}
        {bear && <BearCase bear={bear} />}
        {gates.length > 0 ? (
          <ul className="space-y-0.5">
            {gates.map((g) => {
              const tone = GATE_ICON[gateTone(g)];
              return (
                <li key={g.k} className={`flex flex-wrap gap-x-2 text-[11px] ${g.m === "off" ? "opacity-50" : ""}`}>
                  <span className={`w-3 shrink-0 text-center font-bold ${tone.cls}`} aria-label={tone.word}>
                    {tone.icon}
                  </span>
                  <span className="min-w-0 text-dim sm:w-[150px] sm:shrink-0">
                    {SCORECARD_GATE_LABEL[g.k] ?? g.k}
                    {g.m === "block" && <span className="ml-1 text-[9px] uppercase tracking-wide text-faint">stops trade</span>}
                  </span>
                  <span className="min-w-0 basis-full pl-5 font-mono text-[10.5px] text-text tnum sm:basis-auto sm:pl-0">{g.v || "—"}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[11px] text-dim">
            {card.support?.length ? `Supports: ${card.support.join(", ")}. ` : ""}
            {card.warned?.length ? `Warns: ${card.warned.join(", ")}.` : ""}
          </p>
        )}
        {parts.length > 0 && (
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5 text-[10.5px]">
            {parts.map((p) => (
              <div key={p.k} className="contents">
                <span className="text-faint">{SCORECARD_PART_LABEL[p.k] ?? p.k}</span>
                <span className="h-1 overflow-hidden rounded-full bg-surface">
                  {p.s != null && <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(p.s * 100)}%` }} />}
                </span>
                <span className="font-mono text-faint tnum">
                  {p.s == null ? "n/a" : Math.round(p.s * 100)} · w{p.w}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function verdictTone(s: PipelineStep): string {
  const v = (s.verdict ?? "").toUpperCase();
  if (s.ok === true || /^(PASS|GO|OK|FILLED|PLACED|ACCEPTED|NEW|BUY)/.test(v)) return "bg-gain/10 text-gain ring-gain/25";
  if (s.ok === false || /^(BLOCK|FAIL|NO|REJECT|DENIED|SKIP|STOP)/.test(v)) return "bg-loss/10 text-loss ring-loss/25";
  return "bg-surface2 text-dim ring-border";
}

/** Claude records 0 for "not decided yet": never show those as numbers. */
const pos = (v: number | null | undefined) => typeof v === "number" && v > 0;

export const PHASE: Record<string, string> = {
  PRE: "Before the open",
  OPEN: "Market just opened",
  ENTRY: "Looking for trades",
  MANAGE: "Managing open trades",
  FLATTEN: "Closing everything for the day",
  CLOSED: "Market closed",
};

/** A run's phase code (PRE, ENTRY, …) in plain words. */
export const phaseName = (code: string | null | undefined) => (code ? PHASE[code.toUpperCase()] ?? code.toLowerCase() : "—");

/** One line for "what Claude is doing now": phase + Claude's own note, or null when it hasn't run. */
export function claudeNowLine(run: { summary: RunSummary | null; error: string | null } | null): string | null {
  if (!run) return null;
  if (run.error) return `Last check failed: ${run.error}`;
  const s = run.summary;
  const phase = PHASE[s?.phase ?? ""] ?? "Latest check";
  return s?.note ? `${phase}: ${s.note}` : phase;
}

const GROUPS: { title: string; actions: Decision["action"][]; tone: string }[] = [
  { title: "Buying", actions: ["buy"], tone: "text-gain" },
  { title: "Selling", actions: ["sell"], tone: "text-loss" },
  { title: "Selling short: betting it falls", actions: ["short"], tone: "text-loss" },
  { title: "Buying back a short", actions: ["cover"], tone: "text-gain" },
  { title: "Holding", actions: ["hold"], tone: "text-text" },
  { title: "Watching: may buy", actions: ["watch"], tone: "text-accent" },
  { title: "Passed on", actions: ["skip", "cancel"], tone: "text-faint" },
];

function dealLine(d: Decision): string | null {
  if (!pos(d.price)) return null;
  if (d.action === "watch") return `last price about $${fprice(d.price!)}`;
  if (d.action !== "buy" && d.action !== "sell" && d.action !== "short" && d.action !== "cover") return null;
  const verb = { buy: "Buy", sell: "Sell", short: "Sell short", cover: "Buy back" }[d.action];
  let t = pos(d.qty) ? `${verb} ${shares(d.qty!)} at about $${fprice(d.price!)}` : `${verb} at about $${fprice(d.price!)}`;
  if (d.action === "buy" && pos(d.stop)) {
    t += `. Sells automatically at $${fprice(d.stop!)} if it falls`;
    if (pos(d.target)) t += `, or at $${fprice(d.target!)} if it rises`;
    if (pos(d.qty)) {
      t += `. Risking about $${(d.qty! * (d.price! - d.stop!)).toFixed(0)}`;
      if (pos(d.target)) t += ` to make about $${(d.qty! * (d.target! - d.price!)).toFixed(0)}`;
    }
  }
  if (d.action === "short" && pos(d.stop)) {
    t += `. Buys back automatically at $${fprice(d.stop!)} if it rises`;
    if (pos(d.target)) t += `, or at $${fprice(d.target!)} if it falls`;
    if (pos(d.qty)) {
      t += `. Risking about $${(d.qty! * (d.stop! - d.price!)).toFixed(0)}`;
      if (pos(d.target)) t += ` to make about $${(d.qty! * (d.price! - d.target!)).toFixed(0)}`;
    }
  }
  return t;
}

/** The plain-English answer to "what is it doing and why": the top of a Claude box. */
export function ClaudePlan({
  run,
}: {
  run: { ran_at: string; mode: string; summary: RunSummary | null; error: string | null } | null;
}) {
  if (!run) return <p className="text-sm text-dim">Claude hasn&apos;t run yet.</p>;
  const s = run.summary;
  const ds: Decision[] = Array.isArray(s?.decisions) ? s.decisions : [];
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-sm font-semibold text-text">{PHASE[s?.phase ?? ""] ?? "Latest check"}</span>
        <span className="font-mono text-[11px] text-faint">checked {when(run.ran_at)}</span>
      </div>
      {run.error && <p className="mt-1 text-xs text-loss">{run.error}</p>}
      {s?.note && <p className="mt-1 text-[13px] leading-relaxed text-text">{s.note}</p>}
      {ds.length === 0 && !s?.note && <p className="mt-1 text-sm text-dim">No decisions in this check.</p>}
      {GROUPS.map((g) => {
        const items = ds.filter((d) => g.actions.includes(d.action));
        if (!items.length) return null;
        return (
          <div key={g.title} className="mt-3">
            <div className={`text-[11px] font-semibold uppercase tracking-wider ${g.tone}`}>
              {g.title} ({items.length})
            </div>
            <ul className="mt-1 space-y-1.5">
              {items.map((d, i) => {
                const deal = dealLine(d);
                const card = scorecardOf(d);
                const score = scoreOf(d);
                const bear = bearOf(d);
                return (
                  <li key={i} className="text-[13px] leading-snug">
                    {score != null && !card && (
                      <span className="mr-1.5 align-middle">
                        <ScoreChip score={score} />
                      </span>
                    )}
                    {bear && (
                      <span className="mr-1.5 align-middle">
                        <BearChip bear={bear} />
                      </span>
                    )}
                    <span className="font-display font-semibold text-text">{d.symbol || "All"}</span>
                    {d.reason && <span className="text-dim"> — {d.reason}</span>}
                    {d.trigger && <div className="text-xs text-accent">Would buy if: {d.trigger}</div>}
                    {deal && <div className="font-mono text-xs text-faint tnum">{deal}</div>}
                    {card ? <ScorecardView card={card} bear={bear} /> : bear && <BearDetail bear={bear} />}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function Decisions({ decisions, limit }: { decisions: Decision[]; limit?: number }) {
  const shown = limit ? decisions.slice(0, limit) : decisions;
  if (!shown.length) return null;
  return (
    <ul className="space-y-1">
      {shown.map((d, i) => {
        const card = scorecardOf(d);
        const bear = bearOf(d);
        return (
          <li key={i} className="flex gap-2 text-xs">
            <ActionPill a={d.action} />
            {scoreOf(d) != null && <ScoreChip score={scoreOf(d)} />}
            {bear && <BearChip bear={bear} />}
            <span className="min-w-0">
              <span className="font-semibold text-text">{d.symbol}</span>
              {pos(d.qty) && pos(d.price) && (
                <span className="font-mono text-dim tnum"> {shares(d.qty!)} @ ${fprice(d.price!)}</span>
              )}
              {pos(d.stop) && (
                <span className="font-mono text-faint tnum">
                  {" "}
                  (stop ${fprice(d.stop!)}
                  {pos(d.target) ? ` / target $${fprice(d.target!)}` : ""})
                </span>
              )}
              <span className="text-dim"> — {d.reason}</span>
              {card ? <ScorecardView card={card} bear={bear} /> : bear && <BearDetail bear={bear} />}
            </span>
          </li>
        );
      })}
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
                    <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-2 gap-y-0.5 text-xs">
                      <span className="shrink-0 sm:w-[86px] pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                        {stageName(s.stage)}
                      </span>
                      {s.verdict && (
                        <span
                          className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${verdictTone(s)}`}
                        >
                          {s.verdict}
                        </span>
                      )}
                      <span className="min-w-0 basis-full text-dim sm:basis-0 sm:flex-1">{s.summary}</span>
                    </summary>
                    {s.data && Object.keys(s.data).length > 0 && (
                      <dl className="mt-1 grid sm:ml-[94px] grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-surface2/60 p-2 font-mono text-[11px] tnum">
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
  const decisions: Decision[] = Array.isArray(s?.decisions) ? s.decisions : [];
  const steps: PipelineStep[] = Array.isArray(s?.steps) ? s.steps : [];
  const trace: TraceItem[] = Array.isArray(s?.trace) ? s.trace : [];
  const blocks = Array.isArray(s?.guard_blocks) ? s.guard_blocks : [];
  const u = s?.usage;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-dim tnum">
        {s?.phase && <span className="font-sans font-semibold text-text">{phaseName(s.phase)}</span>}
        {s?.reason && <span>woke: {s.reason}</span>}
        {u?.secs != null && <span>{Math.round(u.secs)}s</span>}
        {u?.turns != null && <span>{u.turns} turns</span>}
        {u?.cost_usd != null && <span>≈${Number(u.cost_usd).toFixed(2)} usage</span>}
      </div>
      {(mode === "dry" || mode === "claude-dry") && (
        <p className="text-[11px] text-watch">Dry run — these decisions were made, nothing was placed.</p>
      )}
      {mode === "claude-replay" && (
        <p className="text-[11px] text-watch">
          Replay{s?.replay ? ` of ${s.replay.date}${s.replay.at ? ` at ${s.replay.at} NY` : ""}` : ""}
          {s?.replay?.step != null ? ` · step ${s.replay.step}/${s.replay.steps ?? "?"}` : ""} — fills simulated,
          nothing was placed.
        </p>
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
          <div className={`mb-1 ${LABEL}`}>Step by step, per stock</div>
          <Pipeline steps={steps} />
        </div>
      )}

      {blocks.length > 0 && (
        <div>
          <div className={`mb-1 ${LABEL}`}>Stopped by the safety check ({blocks.length})</div>
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
