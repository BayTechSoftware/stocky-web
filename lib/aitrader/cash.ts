/**
 * Box size changes as dated cash adjustments (supabase/ai_cash_adjustments.sql).
 * A box's baseline (its P&L is measured from it) = ai_books.start_cash + the sum
 * of its adjustments; the ledger's cash starts from the same baseline.
 */
import { etDate } from "./decide";

export interface CashAdjustment {
  book_id: string;
  at: string;
  amount: number;
}

/** True when an error means the table isn't there yet (SQL not applied). */
export const isMissingTable = (e: { message: string; code?: string } | null | undefined, table: string) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || new RegExp(`${table}|schema cache|does not exist`, "i").test(e.message));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** Every adjustment of these books (oldest first); { missing: true } before the table exists. Throws on other errors. */
export async function loadAdjustments(db: Client, bookIds: string[]): Promise<{ list: CashAdjustment[]; missing: boolean }> {
  if (!bookIds.length) return { list: [], missing: false };
  const { data, error } = await db
    .from("ai_cash_adjustments")
    .select("book_id, at, amount")
    .in("book_id", bookIds)
    .order("at", { ascending: true })
    .limit(10_000);
  if (error) {
    if (isMissingTable(error, "ai_cash_adjustments")) return { list: [], missing: true };
    throw new Error(`ai_cash_adjustments: ${error.message}`);
  }
  return { list: ((data ?? []) as CashAdjustment[]).map((a) => ({ ...a, amount: Number(a.amount) || 0 })), missing: false };
}

/** start_cash + every adjustment of the book. */
export function baselineOf(startCash: number, adj: CashAdjustment[], bookId: string): number {
  return startCash + adj.filter((a) => a.book_id === bookId).reduce((s, a) => s + a.amount, 0);
}

/** Adjustments made after the NY date `asOf` (a snapshot's day): added to the daily-loss halt's baseline. */
export function adjustedSince(adj: CashAdjustment[], bookId: string, asOf: string): number {
  return adj.filter((a) => a.book_id === bookId && etDate(new Date(a.at)) > asOf).reduce((s, a) => s + a.amount, 0);
}

/**
 * A box's current size (its P&L baseline). With adjustments: start_cash + their sum. Before any: a Claude
 * box's saved budget (its start_cash was never updated, the Mac sizes from the budget), else start_cash.
 */
export function sizeOf(
  book: { id: string; key: string; start_cash: number; settings?: Record<string, unknown> | null },
  adj: CashAdjustment[]
): number {
  if (adj.some((a) => a.book_id === book.id)) return baselineOf(book.start_cash, adj, book.id);
  const saved = Number(book.settings?.budget);
  if (book.key.startsWith("claude-") && Number.isFinite(saved) && saved > 0) return saved;
  return book.start_cash;
}
