import { beforeEach, describe, expect, it } from "vitest";
import { allow, resetRateLimits } from "./ratelimit";

describe("allow (per-user window)", () => {
  beforeEach(() => resetRateLimits());
  it("lets `max` hits through per window, per key", () => {
    expect(allow("a", 2, 1000, 0)).toBe(true);
    expect(allow("a", 2, 1000, 10)).toBe(true);
    expect(allow("a", 2, 1000, 20)).toBe(false);
    expect(allow("b", 2, 1000, 20)).toBe(true);
    expect(allow("a", 2, 1000, 1001)).toBe(true); // the first hit left the window
  });
});
