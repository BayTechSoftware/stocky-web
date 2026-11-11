import { describe, expect, it } from "vitest";
import { loadAllRows, loadOrders } from "./rows";

/** A fake query: `total` rows, served by .range(); optional error on one page. */
function fakeTable(total: number, failAt?: number) {
  const calls: [number, number][] = [];
  const make = () => ({
    range(from: number, to: number) {
      calls.push([from, to]);
      if (failAt != null && from >= failAt) return Promise.resolve({ data: null, error: { message: "boom" } });
      const rows = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => ({ n: from + i }));
      return Promise.resolve({ data: rows, error: null });
    },
  });
  return { make, calls };
}

describe("loadAllRows", () => {
  it("pages past 1,000 rows", async () => {
    const t = fakeTable(2500);
    const rows = await loadAllRows<{ n: number }>("t", t.make);
    expect(rows.length).toBe(2500);
    expect(rows[2499].n).toBe(2499);
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("stops on an exact multiple with one empty page", async () => {
    const t = fakeTable(1000);
    expect((await loadAllRows("t", t.make)).length).toBe(1000);
    expect(t.calls.length).toBe(2);
  });
  it("throws on any page error (never half a ledger)", async () => {
    await expect(loadAllRows("ai_fills", fakeTable(2500, 1000).make)).rejects.toThrow("ai_fills: boom");
  });
  it("loadOrders orders by created_at then id", async () => {
    const seen: string[] = [];
    const q = {
      select: () => q,
      in: () => q,
      order: (c: string) => (seen.push(c), q),
      range: () => Promise.resolve({ data: [], error: null }),
    };
    await loadOrders({ from: () => q }, ["b"], "id");
    expect(seen).toEqual(["created_at", "id"]);
  });
});

describe("loadAllRows dedupe", () => {
  it("keeps a row repeated across pages once (a concurrent insert shifted the offsets)", async () => {
    const pages = [[{ k: "a" }, { k: "b" }], [{ k: "b" }, { k: "c" }], []];
    let i = 0;
    const make = () => ({ range: () => Promise.resolve({ data: pages[i++], error: null }) });
    const rows = await loadAllRows<{ k: string }>("t", make, 2, "k");
    expect(rows.map((r) => r.k)).toEqual(["a", "b", "c"]);
  });
});
