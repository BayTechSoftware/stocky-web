import { describe, expect, it } from "vitest";
import {
  FALLBACK_PALETTE,
  asOfLabel,
  barIndexAt,
  chartHeight,
  chooseFrame,
  cleanChartSymbol,
  defaultChartSymbol,
  fmtBarTime,
  fmtTick,
  groupCharts,
  initialBars,
  isIntraday,
  legendOf,
  normalizeCandles,
  normalizeChart,
  oscPanesOf,
  paletteFrom,
  samePalette,
  snapPoints,
  sortCharts,
  toChartListItem,
  withAlpha,
  type ChartListItem,
} from "./charts";

const DAY = 86_400;
const T0 = 1_763_000_000; // a Unix-seconds time in Nov 2025
const candle = (i: number, c = 100 + i) => ({ t: T0 + i * DAY, o: c - 1, h: c + 2, l: c - 2, c });

function longRow() {
  return {
    symbol: "aapl",
    kind: "long",
    as_of: "2026-11-23T17:31:00Z",
    title: "Apple — holding",
    trade: { side: "long", qty: 10, entry: 101.5, stop: 95, target: 130, entered_at: "2026-11-01T14:30:00Z", status: "held", why: "BUY ★ on the daily" },
    frames: {
      W: { label: "Weekly", candles: [candle(0), candle(7)], lines: [], markers: [], levels: [] },
      D: {
        label: "Daily",
        candles: [candle(2), candle(0), candle(1), { t: "bad" }, candle(3)],
        lines: [
          { id: "ema", label: "9-day average", pane: "price", color: "accent", points: [{ t: T0, v: 100 }, { t: T0 + DAY + 3600, v: 101 }] },
          { id: "wt1", label: "WaveTrend", pane: "osc", color: "info", style: "dashed", points: [{ t: T0, v: -20 }, { t: T0 + 2 * DAY, v: 30 }] },
          { id: "empty", label: "nothing", pane: "osc2", color: "warn", points: [] },
        ],
        markers: [
          { t: T0 + DAY + 600, position: "below", shape: "arrowUp", color: "gain", text: "BUY ★" },
          { t: T0 - 5 * DAY, position: "above", shape: "arrowDown", color: "loss", text: "too early" },
        ],
        levels: [
          { label: "Entry", price: 101.5, color: "price", style: "dashed" },
          { label: "Stop", price: "95", color: "loss" },
          { label: "Broken", price: "x", color: "gain" },
        ],
        osc_levels: [{ pane: "osc", label: "+53", value: 53, color: "loss" }, { pane: "osc2", label: "95", value: 95, color: "warn" }],
        panes: { osc: "WaveTrend (momentum)" },
      },
      M: { label: "Monthly", candles: [] },
    },
    default_frame: "D",
    notes: ["Indicator stop after BUY ★: 101.11", 42, ""],
    extra: { ignored: true },
  };
}

describe("normalizeChart", () => {
  it("normalises a long row: frames ordered, bad items dropped, symbol cleaned", () => {
    const c = normalizeChart(longRow());
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.symbol).toBe("AAPL");
    expect(c.kind).toBe("long");
    expect(c.frames.map((f) => f.id)).toEqual(["D", "W"]); // M had no candles
    expect(c.defaultFrame).toBe("D");
    expect(c.notes).toEqual(["Indicator stop after BUY ★: 101.11"]);
    expect(c.trade).toMatchObject({ side: "long", qty: 10, entry: 101.5, stop: 95, target: 130, status: "held", enteredAt: "2026-11-01T14:30:00Z" });

    const d = c.frames[0];
    expect(d.candles.map((k) => k.t)).toEqual([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
    expect(d.lines.map((l) => l.id)).toEqual(["ema", "wt1"]); // the empty line is gone
    expect(d.lines[0].points).toEqual([{ t: T0, v: 100 }, { t: T0 + DAY, v: 101 }]); // snapped onto the bar
    expect(d.lines[0].width).toBe(2);
    expect(d.lines[1]).toMatchObject({ pane: "osc", style: "dashed", width: 1 });
    expect(d.markers).toEqual([{ t: T0 + DAY, position: "below", shape: "arrowUp", color: "gain", text: "BUY ★", size: null }]);
    expect(d.levels).toEqual([
      { label: "Entry", price: 101.5, color: "price", style: "dashed" },
      { label: "Stop", price: 95, color: "loss", style: "solid" },
    ]);
    expect(d.oscLevels).toHaveLength(2);
    expect(d.panes).toEqual({ osc: "WaveTrend (momentum)", osc2: null });
  });

  it("never crashes on junk and returns null when nothing can be drawn", () => {
    for (const junk of [null, undefined, 1, "x", [], {}, { frames: [] }, { frames: { D: { candles: "no" } } }, { symbol: "", frames: { D: { candles: [candle(0)] } } }]) {
      expect(normalizeChart(junk)).toBeNull();
    }
  });

  it("uses the fallback symbol, unknown colours become muted, unknown panes become price", () => {
    const c = normalizeChart(
      {
        frames: {
          "5m": {
            candles: [candle(0), candle(1)],
            lines: [{ id: "v", label: "VWAP", pane: "weird", color: "purple", points: [{ t: T0, v: 1 }] }],
            markers: [{ t: T0, shape: "arrowDown", color: "nope" }],
          },
        },
      },
      "spy",
    );
    expect(c?.symbol).toBe("SPY");
    expect(c?.kind).toBe("day");
    expect(c?.defaultFrame).toBe("5m");
    expect(c?.frames[0].lines[0]).toMatchObject({ pane: "price", color: "muted", style: "solid" });
    expect(c?.frames[0].markers[0]).toMatchObject({ position: "above", color: "accent", text: null });
  });

  it("converts millisecond times and widens high/low", () => {
    const k = normalizeCandles([{ t: T0 * 1000, o: 10, h: 9, l: 11, c: 12, v: -3 }]);
    expect(k).toEqual([{ t: T0, o: 10, h: 12, l: 9, c: 12, v: null }]);
  });

  it("de-duplicates line ids", () => {
    const c = normalizeChart({
      symbol: "X",
      frames: { D: { candles: [candle(0)], lines: [{ id: "a", points: [{ t: T0, v: 1 }] }, { id: "a", points: [{ t: T0, v: 2 }] }] } },
    });
    expect(c?.frames[0].lines.map((l) => l.id)).toEqual(["a", "a_1"]);
  });
});

describe("frames", () => {
  const c = normalizeChart(longRow());
  it("chooses the picked frame, else the default, else the kind's usual, else the first", () => {
    if (!c) throw new Error("no chart");
    expect(chooseFrame(c, "W").id).toBe("W");
    expect(chooseFrame(c, "M").id).toBe("D");
    expect(chooseFrame({ ...c, defaultFrame: "zz" }, null).id).toBe("D");
    expect(chooseFrame({ ...c, defaultFrame: "zz", frames: [c.frames[1]] }, null).id).toBe("W");
  });

  it("lists only the lower panes that have lines", () => {
    if (!c) throw new Error("no chart");
    expect(oscPanesOf(c.frames[0])).toEqual(["osc"]);
    expect(oscPanesOf(c.frames[1])).toEqual([]);
  });

  it("tells intraday from daily bars and picks the first view", () => {
    expect(isIntraday([{ t: 0 }, { t: 300 }, { t: 600 }])).toBe(true);
    expect(isIntraday([{ t: 0 }, { t: DAY }, { t: 4 * DAY }])).toBe(false);
    expect(isIntraday([{ t: 0 }])).toBe(false);
    expect(initialBars("D", false)).toBe(130);
    expect(initialBars("5m", true)).toBeNull();
    expect(initialBars("M", false)).toBeNull();
    expect([chartHeight(0), chartHeight(1), chartHeight(2)]).toEqual([340, 400, 420]);
  });

  it("finds bars and snaps points", () => {
    const k = [{ t: 10 }, { t: 20 }, { t: 30 }];
    expect(barIndexAt(k, 5)).toBe(-1);
    expect(barIndexAt(k, 20)).toBe(1);
    expect(barIndexAt(k, 99)).toBe(2);
    expect(snapPoints(k, [{ t: 25, v: 2 }, { t: 21, v: 1 }, { t: 1, v: 9 }, { t: 30, v: 3 }])).toEqual([{ t: 20, v: 2 }, { t: 30, v: 3 }]);
  });
});

describe("the symbol list", () => {
  const item = (symbol: string, role: "held" | "watch"): ChartListItem => ({ symbol, role, updatedAt: null, kind: null, title: null, status: null, side: null, asOf: null });

  it("reads list rows defensively", () => {
    expect(toChartListItem({ symbol: " msft ", role: "held", updated_at: "2026-11-23T15:00:00Z", kind: "long", status: "armed", side: "short" })).toEqual({
      symbol: "MSFT",
      role: "held",
      updatedAt: "2026-11-23T15:00:00Z",
      kind: "long",
      title: null,
      status: "armed",
      side: "short",
      asOf: null,
    });
    expect(toChartListItem({ symbol: "x", role: "other" })?.role).toBe("watch");
    expect(toChartListItem({ symbol: "" })).toBeNull();
    expect(toChartListItem(null)).toBeNull();
  });

  it("sorts held first, A to Z, one per symbol, and groups", () => {
    const list = [item("ZZ", "watch"), item("BB", "held"), item("AA", "watch"), item("CC", "held"), item("BB", "watch")];
    expect(sortCharts(list).map((i) => i.symbol)).toEqual(["BB", "CC", "AA", "ZZ"]);
    const g = groupCharts(list);
    expect(g.holding.map((i) => i.symbol)).toEqual(["BB", "CC"]);
    expect(g.watching.map((i) => i.symbol)).toEqual(["AA", "ZZ"]);
  });

  it("defaults to the first held symbol, keeping a still-listed pick", () => {
    const list = [item("AA", "watch"), item("CC", "held")];
    expect(defaultChartSymbol(list, null)).toBe("CC");
    expect(defaultChartSymbol(list, "AA")).toBe("AA");
    expect(defaultChartSymbol(list, "GONE")).toBe("CC");
    expect(defaultChartSymbol([item("AA", "watch")], null)).toBe("AA");
    expect(defaultChartSymbol([], null)).toBeNull();
  });

  it("cleans symbols", () => {
    expect(cleanChartSymbol(" brk.b ")).toBe("BRK.B");
    expect(cleanChartSymbol("a;drop")).toBe("ADROP");
    expect(cleanChartSymbol(5)).toBe("");
  });
});

describe("colours", () => {
  it("reads theme variables, falling back per colour", () => {
    const p = paletteFrom((v) => ({ "--color-gain": " #00ff00 ", "--color-washout": "oklch(0.6 0.2 250)" })[v] ?? "");
    expect(p.gain).toBe("#00ff00");
    expect(p.info).toBe("oklch(0.6 0.2 250)");
    expect(p.loss).toBe(FALLBACK_PALETTE.loss);
    expect(samePalette(p, FALLBACK_PALETTE)).toBe(false);
    expect(samePalette(paletteFrom(() => null), FALLBACK_PALETTE)).toBe(true);
  });

  it("adds transparency", () => {
    expect(withAlpha("#0a7c42", 0.5)).toBe("rgba(10, 124, 66, 0.5)");
    expect(withAlpha("#fff", 2)).toBe("rgba(255, 255, 255, 1)");
    expect(withAlpha("rgb(1, 2, 3)", 0.2)).toBe("rgba(1, 2, 3, 0.2)");
    expect(withAlpha("red", 0.2)).toBe("red");
  });
});

describe("legend", () => {
  it("lists lines, levels and the oscillator levels of panes that are shown", () => {
    const c = normalizeChart(longRow());
    if (!c) throw new Error("no chart");
    const l = legendOf(c.frames[0]);
    expect(l.map((i) => `${i.kind}:${i.label}:${i.where}`)).toEqual([
      "line:9-day average:price",
      "line:WaveTrend:WaveTrend (momentum)",
      "level:Entry:price",
      "level:Stop:price",
      "oscLevel:+53:WaveTrend (momentum)", // the osc2 level has no pane, so it's left out
    ]);
    expect(l[0].value).toBe(101);
  });
});

describe("New York times", () => {
  const at = Date.parse("2026-11-23T17:31:00Z") / 1000; // 12:31 pm EST
  it("formats as-of", () => {
    expect(asOfLabel("2026-11-23T17:31:00Z", Date.parse("2026-11-23T20:00:00Z"))).toBe("12:31 PM ET");
    expect(asOfLabel("2026-11-21T17:31:00Z", Date.parse("2026-11-23T20:00:00Z"))).toBe("Nov 21, 12:31 PM ET");
    expect(asOfLabel(null)).toBe("");
    expect(asOfLabel("nope")).toBe("");
  });

  it("formats bar times and ticks", () => {
    expect(fmtBarTime(at, true)).toBe("Nov 23, 12:31 PM");
    // A daily bar stamped at midnight UTC is still that date in New York.
    expect(fmtBarTime(Date.parse("2026-11-23T00:00:00Z") / 1000, false)).toBe("Mon, Nov 23, 2026");
    expect(fmtBarTime(Date.parse("2026-11-23T05:00:00Z") / 1000, false)).toBe("Mon, Nov 23, 2026");
    expect(fmtTick(at, 3, true)).toBe("12:31 PM");
    expect(fmtTick(at, 2, true)).toBe("Nov 23");
    expect(fmtTick(Date.parse("2026-11-23T00:00:00Z") / 1000, 2, false)).toBe("Nov 23");
    expect(fmtTick(at, 1, false)).toBe("Nov");
    expect(fmtTick(at, 0, false)).toBe("2026");
  });
});
