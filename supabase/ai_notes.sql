-- ---------------------------------------------------------------------------
-- Lessons and suggestions from the after-close review (stocky-trader
-- bin/reviewer.py). Each one is its own row so the owner can see and remove it
-- on the website (Runs → Daily review → "What Claude reads next").
--
-- kind 'lesson'     : a note Claude reads the next morning.
-- kind 'suggestion' : a setting change the review proposes to the owner. The
--                     owner decides; Claude reads it but never acts against a
--                     setting.
--
-- Before every Claude run the Mac rewrites the book's lessons file from the
-- active rows (removed_at is null): the newest `lessons_count` of each kind, or
-- none when `use_lessons` is off (both in the book's settings, group "Exits").
-- Removing a note sets removed_at (soft delete), so the unique key keeps the
-- same text from coming back for that day.
--
-- Written by the Mac with the service role (which bypasses RLS) and, for
-- removed_at only, by the website's server action after an ownership check
-- (admin client). Read by the owner of the book. Safe to run more than once.
-- No DROP statements.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_notes (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.ai_books (id) on delete cascade,
  day         date not null,
  kind        text not null check (kind in ('lesson', 'suggestion')),
  text        text not null,
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  unique (book_id, day, kind, text)
);
create index if not exists ai_notes_book_day_idx on public.ai_notes (book_id, day desc);

alter table public.ai_notes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_notes' and policyname = 'ai_notes owner read'
  ) then
    create policy "ai_notes owner read" on public.ai_notes for select
      using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
  end if;
end $$;

-- Only the service role writes (no insert / update / delete policy for signed-in users).
revoke insert, update, delete on public.ai_notes from anon, authenticated;
grant select on public.ai_notes to authenticated;

-- The review's suggestions are also kept on the day's review row.
alter table public.ai_reviews add column if not exists suggestions jsonb default '[]'::jsonb;
