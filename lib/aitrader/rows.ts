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

/** Every row of a query, page by page. `make` must build a fresh, fully ordered query each call. */
export async function loadAllRows<T>(label: string, make: () => Rangeable, pageSize = PAGE_ROWS): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await make().range(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) return out;
    if (from > 1_000_000) throw new Error(`${label}: more than a million rows — refusing`);
  }
}

/** The minimal client surface the loaders use (the admin client or a user's RLS client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** All ai_orders rows of these books, oldest first. */
export function loadOrders<T>(db: Client, bookIds: string[], columns: string): Promise<T[]> {
  if (!bookIds.length) return Promise.resolve([]);
  return loadAllRows<T>("ai_orders", () =>
    db.from("ai_orders").select(columns).in("book_id", bookIds).order("created_at", { ascending: true }).order("id", { ascending: true })
  );
}

/** All ai_fills rows of these books (optionally only those after `sinceIso`), oldest first. */
export function loadFills<T>(db: Client, bookIds: string[], columns: string, sinceIso?: string): Promise<T[]> {
  if (!bookIds.length) return Promise.resolve([]);
  return loadAllRows<T>("ai_fills", () => {
    let q = db.from("ai_fills").select(columns).in("book_id", bookIds);
    if (sinceIso) q = q.gt("transacted_at", sinceIso);
    return q.order("transacted_at", { ascending: true }).order("activity_id", { ascending: true });
  });
}

/** Throw when a write came back with an error. */
export function must(label: string, r: { error: { message: string } | null }): void {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
}
