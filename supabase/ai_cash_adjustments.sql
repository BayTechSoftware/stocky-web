-- Box size changes as dated cash adjustments (engine fix #9).
--
-- Changing a box's size no longer rewrites ai_books.start_cash (which rewrote
-- history and could trip the daily-loss halt). Each change is a row here:
-- amount = new size − old size, at the time of the change. The ledger's cash
-- and the P&L baseline are start_cash + the sum of the adjustments; the
-- daily-loss halt adds the adjustments made since the previous snapshot to its
-- baseline. Applies to Rules and Claude boxes.
--
-- APPLY BEFORE THE DEPLOY if you want size changes to save: until this table
-- exists, saving a different "Book size" is refused with a message (every
-- other setting still saves), and the readers treat it as "no adjustments".
create table if not exists public.ai_cash_adjustments (
  id       uuid primary key default gen_random_uuid(),
  book_id  uuid not null references public.ai_books (id) on delete cascade,
  at       timestamptz not null default now(),
  amount   double precision not null,
  reason   text
);
create index if not exists ai_cash_adjustments_book_idx on public.ai_cash_adjustments (book_id, at);
alter table public.ai_cash_adjustments enable row level security;
create policy "ai_cash_adjustments owner read" on public.ai_cash_adjustments for select
  using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
-- Writes: service role only (the saveBookLimits server action).
