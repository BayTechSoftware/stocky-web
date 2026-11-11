/**
 * Per-user rate limit for server actions that spend external API credits
 * (Twelve Data) — a fixed time window kept in memory.
 *
 * Why in memory: each Vercel function instance keeps its own map, so a user who
 * lands on several warm instances gets a few extra calls — acceptable for a
 * credit guard (the external API's own per-minute budget is the hard limit), and
 * it needs no table, no SQL and no extra round trip. A cold start resets it.
 */
const hits = new Map<string, number[]>();

/** True (and the hit is counted) when `key` has had fewer than `max` hits in the last `windowMs`. */
export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(k);
  }
  return true;
}

/** Tests only. */
export function resetRateLimits() {
  hits.clear();
}
