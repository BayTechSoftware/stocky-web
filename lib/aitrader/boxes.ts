/**
 * Which AI Trader boxes exist, how they are ordered, which are hidden and which run on the old shared
 * Alpaca paper account. Pure (no server imports), so the client components can use it too.
 */

export type AiBookKey = "mylist" | "free" | "claude-mylist" | "claude-free" | "claude-day" | "claude-long";

/** Display order: the new Claude boxes first, the old shared-account box, then the rest (hidden ones last). */
export const BOOK_ORDER: AiBookKey[] = ["claude-day", "claude-long", "claude-free", "mylist", "claude-mylist", "free"];

/** Boxes on their own Alpaca paper account, whose keys live only on the Mac (the website never reads them). */
export const OWN_ACCOUNT_KEYS: readonly string[] = ["claude-day", "claude-long"];

export const isClaudeKey = (key: string) => key.startsWith("claude-");

/** Whether a box trades on the shared paper account (the one connected on the website, Vault keys). */
export const onSharedAccount = (key: string) => !OWN_ACCOUNT_KEYS.includes(key);

type Box = { key: string; hidden?: boolean };

/** Visible boxes first, each group in BOOK_ORDER (unknown keys after the known ones). Doesn't mutate. */
export function sortBooks<T extends Box>(books: T[]): T[] {
  const rank = (k: string) => {
    const i = BOOK_ORDER.indexOf(k as AiBookKey);
    return i >= 0 ? i : BOOK_ORDER.length;
  };
  return books.slice().sort((a, b) => Number(!!a.hidden) - Number(!!b.hidden) || rank(a.key) - rank(b.key));
}

export const visibleBooks = <T extends Box>(books: T[]): T[] => books.filter((b) => !b.hidden);
export const hiddenBooks = <T extends Box>(books: T[]): T[] => books.filter((b) => !!b.hidden);

/** Whether the shared account's equity belongs on the page: only while a visible box trades on it. */
export const showSharedAccount = (books: Box[]) => visibleBooks(books).some((b) => onSharedAccount(b.key));

/** Totals over a set of boxes (the AI tab adds up the visible ones only). */
export function totalsOf(books: { equity: number; startCash: number }[]) {
  const equity = books.reduce((a, b) => a + b.equity, 0);
  const start = books.reduce((a, b) => a + b.startCash, 0);
  return { equity, start, pnl: equity - start, pnlPct: start ? (equity / start - 1) * 100 : 0 };
}
