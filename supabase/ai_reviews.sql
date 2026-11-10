-- ---------------------------------------------------------------------------
-- After-close reviews of the Claude books (stocky-trader bin/reviewer.py).
-- Once per trading day per Claude book the Mac writes a short plain-English
-- review and 3-5 lessons; the box's "Runs" section shows the latest ones.
--
-- Written by the Mac with the service role (which bypasses RLS); read by the
-- owner of the book. Safe to run more than once. No DROP statements.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reviews (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.ai_books (id) on delete cascade,
  day         date not null,
  summary     text not null default '',
  lessons     jsonb not null default '[]'::jsonb,
  stats       jsonb not null default '{}'::jsonb,
  cost_usd    double precision,
  created_at  timestamptz not null default now(),
  unique (book_id, day)
);
create index if not exists ai_reviews_book_day_idx on public.ai_reviews (book_id, day desc);

alter table public.ai_reviews enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_reviews' and policyname = 'ai_reviews owner read'
  ) then
    create policy "ai_reviews owner read" on public.ai_reviews for select
      using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
  end if;
end $$;

-- Only the service role writes (no insert / update / delete policy for signed-in users).
revoke insert, update, delete on public.ai_reviews from anon, authenticated;
grant select on public.ai_reviews to authenticated;
