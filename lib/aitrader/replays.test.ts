import { describe, expect, it } from "vitest";
import { groupReplays } from "./replays";

const row = (id: string, rid: string, step: number, extra: Record<string, unknown> = {}, cost = 0.1) => ({
  id,
  ran_at: `2026-11-07T15:${String(step).padStart(2, "0")}:00Z`,
  error: null,
  phase: "OPEN",
  reason: "scheduled",
  cost,
  replay: { id: rid, date: rid.slice(-12, -2), at: `10:${String(step).padStart(2, "0")}`, step, steps: 3, ...extra },
});

describe("replay grouping", () => {
  it("groups steps by replay id, takes the latest step's simulation, sums cost when no total", () => {
    const days = groupReplays([
      row("c", "claude-free-2026-11-05-1", 2, { sim_equity: 5010, sim_pnl: 10, sim_trades: [{ symbol: "A", side: "buy", qty: 1, price: 10 }] }),
      row("a", "claude-free-2026-11-05-1", 1, { sim_equity: 5000, sim_pnl: 0, sim_trades: [] }),
      row("d", "claude-free-2026-11-06-1", 1, { final: true, steps: 1, cost_usd_total: 0.42, sim_pnl: -5 }),
    ]);
    expect(days.map((d) => d.id)).toEqual(["claude-free-2026-11-06-1", "claude-free-2026-11-05-1"]);
    const d = days[1];
    expect(d).toMatchObject({ date: "2026-11-05", done: 2, steps: 3, final: false, simEquity: 5010, simPnl: 10 });
    expect(d.trades).toHaveLength(1);
    expect(d.list.map((s) => s.id)).toEqual(["a", "c"]);
    expect(d.costUsd).toBeCloseTo(0.2);
    expect(days[0]).toMatchObject({ final: true, costUsd: 0.42, simPnl: -5 });
  });
});
