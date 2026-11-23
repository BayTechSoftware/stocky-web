import { describe, expect, it } from "vitest";
import {
  CLAUDE_LIMITS,
  DAY_LIMITS,
  LONG_LIMITS,
  clampSaved,
  defsForBook,
  effective,
  overridesOnly,
  validateLimits,
} from "./limits";
import { SECTIONS, isIndicator, sectionOf } from "./layout";
import { BOOK_ORDER, hiddenBooks, onSharedAccount, showSharedAccount, sortBooks, totalsOf, visibleBooks } from "./boxes";
import { claudeOrderKind, claudeOrderRole, ownerOf, planLiveSync } from "./live";
import { sizeOf } from "./cash";
import { fakeDb } from "./fakes";
import { loadAiView } from "./view";
import type { Order } from "../alpaca";

const keys = (defs: { key: string }[]) => defs.map((d) => d.key);

describe("defsForBook routing", () => {
  it("claude-day gets the day-trading table + trade_universe; claude-long its own table", () => {
    expect(defsForBook("claude-day")).toBe(DAY_LIMITS);
    expect(defsForBook("claude-long")).toBe(LONG_LIMITS);
    expect(defsForBook("claude-free")).toBe(CLAUDE_LIMITS);
    expect(defsForBook("claude-mylist")).toBe(CLAUDE_LIMITS);
    expect(keys(DAY_LIMITS)).toEqual([...keys(CLAUDE_LIMITS), "trade_universe", "trade_style", "max_hold_days", "swing_am", "swing_pm", "swing_move_pct"]);
  });

  it("trade_universe is only on claude-day", () => {
    for (const k of ["mylist", "free", "claude-mylist", "claude-free", "claude-long"]) expect(keys(defsForBook(k)), k).not.toContain("trade_universe");
    const d = DAY_LIMITS.find((x) => x.key === "trade_universe")!;
    expect(d.def).toBe("free");
    expect(d.options).toEqual(["free", "watchlist"]);
    expect(d.optionLabels).toEqual({ free: "Free choice", watchlist: "Watchlist only" });
    expect(sectionOf(d)).toBe("What to trade");
    expect(validateLimits(DAY_LIMITS, { trade_universe: "watchlist" })).toEqual({ ok: true, settings: { trade_universe: "watchlist" } });
    expect(validateLimits(DAY_LIMITS, { trade_universe: "all" }).ok).toBe(false);
    // The old boxes drop it as an unknown key.
    expect(validateLimits(CLAUDE_LIMITS, { trade_universe: "watchlist" })).toEqual({ ok: true, settings: {} });
  });

  it("claude-long has none of the day-trading fields", () => {
    const long = keys(LONG_LIMITS);
    for (const k of ["flat_by", "no_entries_before", "no_entries_after", "board", "premarket_queue", "max_trades_per_day", "scorecard", "trade_universe"]) {
      expect(long, k).not.toContain(k);
    }
    expect(new Set(long).size).toBe(long.length);
  });
});

describe("LONG_LIMITS", () => {
  it("has the agreed keys and defaults", () => {
    expect(effective(LONG_LIMITS, {})).toEqual({
      enabled: true, budget: 10000, position_pct: 10, max_positions: 0, emergency_stop_pct: 25, allow_short: false,
      long_universe: "watchlist_large", universe_add: "", universe_remove: "", run_at: "09:00", buy_needs_signal: "off",
      stop_break_sells: true,
      intraday_watch: true, scan_min: 15, move_pct: 4, news_wakes: true, idle_cash_pct: 20, idle_review_min: 120, wake_gap_min: 20,
      ok_wt_ch_len: 9, ok_wt_avg_len: 12, ok_wt_ma_len: 3, ok_lv_lower: -45, ok_lv_ob: 53, ok_lv_os: -53, ok_stoch_hit: 95,
      ok_monthly_any: true, ok_higher_only: true, ok_confirm_only: false, ok_st_len: 14, ok_st_rsi: 14, ok_st_k: 3, ok_st_log: true,
      ok_rsi_len: 14, ok_div_ob: 45, ok_div_os: -65, ok_div_ob2: 15, ok_div_os2: -40, ok_mean_years: 4, ok_fib_len: 260,
      ok_star_buy_dd: 30, ok_star_sell_prm: 50, ok_star_sell_pos: 0.764, ok_star_weeks: 26, ok_star_repeat: 15, ok_sell_again: true,
      ok_daily_star: true, ok_stop_on: true, ok_stop_look: 13, ok_stop_buffer: 0, ok_stop_min: 20, ok_stop_weekly: true, ok_stop_weeks: 26,
    });
    const sel = (k: string) => LONG_LIMITS.find((d) => d.key === k)!;
    expect(sel("long_universe").options).toEqual(["watchlist_large", "watchlist"]);
    expect(sel("buy_needs_signal").options).toEqual(["off", "any", "star"]);
  });

  it("clamps to the bounds (negative ranges and the 0.5 step included)", () => {
    const v = validateLimits(LONG_LIMITS, {
      budget: 50, position_pct: 150, max_positions: 2.6, emergency_stop_pct: 1, ok_lv_lower: 20, ok_lv_os: -500,
      ok_mean_years: 3.3, ok_star_sell_pos: 2, ok_fib_len: 1,
    });
    expect(v).toEqual({
      ok: true,
      settings: {
        budget: 100, position_pct: 100, max_positions: 3, emergency_stop_pct: 5, ok_lv_lower: 0, ok_lv_os: -100,
        ok_mean_years: 3.5, ok_star_sell_pos: 1, ok_fib_len: 2,
      },
    });
    expect(validateLimits(LONG_LIMITS, { ok_mean_years: 0.1 })).toEqual({ ok: true, settings: { ok_mean_years: 0.5 } });
    expect(clampSaved(LONG_LIMITS, { ok_mean_years: 99, ok_stop_min: "x", universe_add: "aapl, msft" })).toEqual({ ok_mean_years: 10, universe_add: "AAPL,MSFT" });
  });

  it("run_at must be between 04:00 and 09:25 and can't be off", () => {
    expect(validateLimits(LONG_LIMITS, { run_at: "04:00" }).ok).toBe(true);
    expect(validateLimits(LONG_LIMITS, { run_at: "09:25" }).ok).toBe(true);
    expect(validateLimits(LONG_LIMITS, { run_at: "03:59" }).ok).toBe(false);
    expect(validateLimits(LONG_LIMITS, { run_at: "09:30" }).ok).toBe(false);
    expect(validateLimits(LONG_LIMITS, { run_at: "off" }).ok).toBe(false);
  });

  it("stores only overrides; a reset keeps budget + enabled", () => {
    const v = validateLimits(LONG_LIMITS, { budget: "10000", position_pct: "10", ok_stop_min: "25", allow_short: "true" });
    expect(v.ok && overridesOnly(LONG_LIMITS, v.settings)).toEqual({ ok_stop_min: 25, allow_short: true });
    const keepDefs = LONG_LIMITS.filter((d) => d.key === "budget" || d.key === "enabled");
    const keep = validateLimits(keepDefs, { budget: 20000, enabled: false });
    expect(keep.ok && overridesOnly(LONG_LIMITS, keep.settings)).toEqual({ budget: 20000, enabled: false });
  });

  it("lays every field out in a known section; the indicator inputs fold under How it decides", () => {
    for (const d of LONG_LIMITS) expect(SECTIONS, d.key).toContain(sectionOf(d));
    const ind = LONG_LIMITS.filter(isIndicator);
    expect(ind.length).toBe(34);
    for (const d of ind) expect(sectionOf(d), d.key).toBe("How it decides");
    expect(sectionOf(LONG_LIMITS.find((d) => d.key === "run_at")!)).toBe("When to trade");
    expect(sectionOf(LONG_LIMITS.find((d) => d.key === "stop_break_sells")!)).toBe("Exits");
  });

  it("whole-number fields have whole defaults and minimums", () => {
    for (const d of [...LONG_LIMITS, ...DAY_LIMITS]) {
      if (d.kind !== "number" || !d.int) continue;
      expect(Number.isInteger(d.def), d.key).toBe(true);
      expect(Number.isInteger(d.min ?? 0), d.key).toBe(true);
    }
  });
});

describe("box helpers", () => {
  const b = (key: string, hidden = false) => ({ key, hidden, equity: 100, startCash: 80 });
  const all = [b("free", true), b("claude-free"), b("mylist", true), b("claude-long"), b("claude-mylist", true), b("claude-day")];

  it("orders visible boxes first: claude-day, claude-long, claude-free, then the hidden ones", () => {
    expect(sortBooks(all).map((x) => x.key)).toEqual(["claude-day", "claude-long", "claude-free", "mylist", "claude-mylist", "free"]);
    expect(BOOK_ORDER.slice(0, 3)).toEqual(["claude-day", "claude-long", "claude-free"]);
  });

  it("splits visible and hidden; totals add up the visible ones", () => {
    expect(visibleBooks(all).map((x) => x.key).sort()).toEqual(["claude-day", "claude-free", "claude-long"]);
    expect(hiddenBooks(all).map((x) => x.key).sort()).toEqual(["claude-mylist", "free", "mylist"]);
    expect(totalsOf(visibleBooks(all))).toEqual({ equity: 300, start: 240, pnl: 60, pnlPct: 25 });
    expect(totalsOf([])).toEqual({ equity: 0, start: 0, pnl: 0, pnlPct: 0 });
  });

  it("shows the shared account only while a visible box trades on it", () => {
    expect(onSharedAccount("claude-free")).toBe(true);
    expect(onSharedAccount("mylist")).toBe(true);
    expect(onSharedAccount("claude-day")).toBe(false);
    expect(onSharedAccount("claude-long")).toBe(false);
    expect(showSharedAccount(all)).toBe(true);
    expect(showSharedAccount(all.map((x) => (x.key === "claude-free" ? { ...x, hidden: true } : x)))).toBe(false);
  });

  it("sizes the new Claude boxes from their budget", () => {
    expect(sizeOf({ id: "x", key: "claude-long", start_cash: 5000, settings: { budget: 10000 } }, [])).toBe(10000);
    expect(sizeOf({ id: "x", key: "claude-day", start_cash: 5000, settings: {} }, [])).toBe(5000);
  });
});

describe("client-order-id prefixes", () => {
  it("maps the new boxes' prefixes and keeps the old ones", () => {
    expect(ownerOf("claude-day-AAPL-1")).toBe("claude-day");
    expect(ownerOf("claude-long-MSFT-1")).toBe("claude-long");
    expect(ownerOf("claude-free-AAPL-1")).toBe("claude-free");
    expect(ownerOf("claude-mylist-AAPL-1")).toBe("claude-mylist");
    expect(ownerOf("stk-free-AAPL-1")).toBe("free");
    expect(ownerOf("stk-mylist-AAPL-1")).toBe("mylist");
    expect(ownerOf("other-AAPL")).toBeNull();
  });
  it("reads the role marker after the new prefixes", () => {
    expect(claudeOrderRole("claude-long-ms-AAPL-1")).toBe("ms");
    expect(claudeOrderRole("claude-day-s-TSLA-1")).toBe("s");
    expect(claudeOrderRole("claude-day-S-1")).toBeNull(); // ticker S, long entry
    expect(claudeOrderKind("sell", "claude-long-ms-AAPL-1")).toBe("exit");
  });
  it("syncLive's plan ignores a new box's order when that box isn't in the synced set", () => {
    const o = { id: "o9", client_order_id: "claude-day-AAPL-1", symbol: "AAPL", side: "buy", qty: "1", filled_qty: "0", status: "new", legs: [] } as unknown as Order;
    const plan = planLiveSync([], [o], [], new Map([["claude-free", "B-free"]]));
    expect(plan.inserts).toEqual([]);
  });
});

describe("loadAiView hidden boxes", () => {
  const base = { ai_orders: [], ai_fills: [], ai_equity: [], ai_runs: [] };
  it("reads hidden, keeps hidden books loadable, and sorts visible first", async () => {
    const db = fakeDb({
      ...base,
      ai_books: [
        { id: "a", key: "mylist", name: "Rules · My List", start_cash: 5000, settings: {}, hidden: true },
        { id: "b", key: "claude-free", name: "Claude · Free", start_cash: 5000, settings: {}, hidden: false },
        { id: "c", key: "claude-long", name: "Long-Term Claude", start_cash: 10000, settings: {}, hidden: false },
        { id: "d", key: "claude-day", name: "Day Trader Claude", start_cash: 5000, settings: {}, hidden: false },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (await loadAiView(db as any))!;
    expect(v.books.map((b) => [b.key, b.hidden])).toEqual([
      ["claude-day", false],
      ["claude-long", false],
      ["claude-free", false],
      ["mylist", true],
    ]);
    expect(v.books.find((b) => b.key === "mylist")!.startCash).toBe(5000);
  });

  it("still loads (nothing hidden) when the hidden column isn't there yet", async () => {
    const db = fakeDb({ ...base, ai_books: [{ id: "b", key: "claude-free", name: "Claude · Free", start_cash: 5000, settings: {} }] });
    db.fail.set("ai_books:select", { message: "column ai_books.hidden does not exist", times: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (await loadAiView(db as any))!;
    expect(v.books.map((b) => [b.key, b.hidden])).toEqual([["claude-free", false]]);
  });
});
