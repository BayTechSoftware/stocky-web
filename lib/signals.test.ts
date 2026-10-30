import { describe, it, expect } from "vitest";
import { sma, rsi, buyZone, assess } from "./signals";

/** Build a linear ramp of `n` points from `a` to `b` (inclusive). */
function ramp(a: number, b: number, n: number): number[] {
  if (n === 1) return [a];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

describe("sma", () => {
  it("averages the last period values", () => {
    expect(sma([2, 4, 6, 8], 2)).toBe(7);
    expect(sma([2, 4, 6, 8], 4)).toBe(5);
  });
  it("returns null when too few values", () => {
    expect(sma([1, 2], 5)).toBeNull();
  });
});

describe("rsi", () => {
  it("is 100 for a strictly rising series", () => {
    expect(rsi(ramp(1, 30, 30))).toBe(100);
  });
  it("is 0 for a strictly falling series", () => {
    expect(rsi(ramp(30, 1, 30))).toBe(0);
  });
  it("is 50 for a flat series", () => {
    expect(rsi(new Array(30).fill(42))).toBe(50);
  });
  it("is null with too few closes", () => {
    expect(rsi([1, 2, 3])).toBeNull();
  });
  it("stays within [0,100] on a choppy series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 50 + 10 * Math.sin(i / 3));
    const r = rsi(closes)!;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });
});

describe("buyZone (Fibonacci retracement)", () => {
  it("spans 0.618→0.382 retracement of the trailing swing", () => {
    // hi=100, lo=50, range=50 → low=100-30.9=69.1, high=100-19.1=80.9
    const closes = [...ramp(50, 100, 100)];
    const z = buyZone(closes);
    expect(z.low).toBeCloseTo(69.1, 1);
    expect(z.high).toBeCloseTo(80.9, 1);
  });
});

describe("assess", () => {
  it("BUY when price pulls back into the zone", () => {
    // ramp up to 100 then pull back to 75 (inside [69.1, 80.9])
    const closes = [...ramp(50, 100, 100), ...ramp(100, 75, 20)];
    const s = assess({ closes });
    expect(s.zoneLow).toBeCloseTo(69.1, 0);
    expect(s.zoneHigh).toBeCloseTo(80.9, 0);
    expect(s.zonePos).toBe("in");
    expect(s.assessment).toBe("BUY");
  });

  it("WASHOUT when below the zone and oversold", () => {
    const closes = [...ramp(50, 100, 100), ...ramp(100, 60, 20)]; // sharp decline below 69.1
    const s = assess({ closes });
    expect(s.zonePos).toBe("below");
    expect(s.rsi!).toBeLessThanOrEqual(38);
    expect(s.assessment).toBe("WASHOUT");
    expect(s.tag).toBe("OVERSOLD");
  });

  it("OVERBOUGHT when running above the zone at new highs", () => {
    const closes = [...ramp(50, 100, 120)]; // still rising at the high
    const s = assess({ closes });
    expect(s.zonePos).toBe("above");
    expect(s.assessment).toBe("OVERBOUGHT");
  });

  it("WATCH when price gaps below the zone but RSI is not oversold", () => {
    const closes = new Array(60).fill(85); // flat → RSI ~50, zone degenerate at 85
    const s = assess({ closes, price: 60 }); // intraday gap below the zone
    expect(s.zonePos).toBe("below");
    expect(s.assessment).toBe("WATCH");
  });

  it("scores an in-zone pullback higher than an expensive name", () => {
    const inZone = assess({ closes: [...ramp(50, 100, 100), ...ramp(100, 75, 20)] });
    const expensive = assess({ closes: [...ramp(50, 100, 120)] });
    expect(inZone.score).toBeGreaterThan(expensive.score);
  });
});
