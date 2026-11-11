/**
 * Paged, fail-loud reads of the ledger tables (ai_orders, ai_fills). PostgREST
 * caps a response at 1,000 rows, so an unpaged read silently truncates the
 * ledger; these page with .range() in a stable order (time, then the primary
 * key) and THROW on any error, so a caller never trades or renders from half a
 * ledger. Shared by the engine, the tab's view and syncLive.
 */

/** What we need from a Supabase query builder: `.range()` returning { data, error }. */
export interface Rangeable {
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

export const PAGE_ROWS = 1000;

/**
 * Every row of a query, page by page. `make` must build a fresh, fully ordered query each call.
 * With `key`, a row seen twice is kept once: a concurrent insert (e.g. syncLive while the engine
 * reads) shifts the offsets and can repeat a row across pages — the ledger must never count it twice.
 */
export async function loadAllRows<T>(label: string, make: () => Rangeable, pageSize = PAGE_ROWS, key?: keyof T): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<unknown>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await make().range(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    for (const r of rows) {
      if (key) {
        const k = r[key];
        if (k != null && seen.has(k)) continue;
        if (k != null) seen.add(k);
      }
      out.push(r);
    }
    if (rows.length < pageSize) return out;
    if (from > 1_000_000) throw new Error(`${label}: more than a million rows — refusing`);
  }
}

/** The minimal client surface the loaders use (the admin client or a user's RLS client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** All ai_orders rows of these books, oldest first (deduped by id when `columns` has it). */
export async function loadOrders<T>(db: Client, bookIds: string[], columns: string): Promise<T[]> {
  if (!bookIds.length) return [];
  const cols = /(^|,)\s*id\s*(,|$)/.test(columns) ? columns : `id, ${columns}`;
  const rows = await loadAllRows<T & { id: string }>(
    "ai_orders",
    () => db.from("ai_orders").select(cols).in("book_id", bookIds).order("created_at", { ascending: true }).order("id", { ascending: true }),
    PAGE_ROWS,
    "id"
  );
  return rows;
}

/** All ai_fills rows of these books (optionally only those after `sinceIso`), oldest first, deduped by activity_id. */
export async function loadFills<T>(db: Client, bookIds: string[], columns: string, sinceIso?: string): Promise<T[]> {
  if (!bookIds.length) return [];
  const cols = columns.includes("activity_id") ? columns : `activity_id, ${columns}`;
  return loadAllRows<T & { activity_id: string }>(
    "ai_fills",
    () => {
      let q = db.from("ai_fills").select(cols).in("book_id", bookIds);
      if (sinceIso) q = q.gt("transacted_at", sinceIso);
      return q.order("transacted_at", { ascending: true }).order("activity_id", { ascending: true });
    },
    PAGE_ROWS,
    "activity_id"
  );
}

/** Throw when a write came back with an error. */
export function must(label: string, r: { error: { message: string } | null }): void {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
}
