-- Stocky Watcher — Supabase schema (run in the SQL editor, or via `supabase db push`).
-- Auth is handled by Supabase Auth (auth.users). These are the app tables.

-- 1) Per-user watchlist -------------------------------------------------------
create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,15}$'),
  list       text not null default 'Watchlist',
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists watchlist_user_idx on public.watchlist (user_id);

alter table public.watchlist enable row level security;
-- Each user sees and edits only their own rows.
create policy "watchlist owner read"   on public.watchlist for select using (auth.uid() = user_id);
create policy "watchlist owner insert" on public.watchlist for insert with check (auth.uid() = user_id);
create policy "watchlist owner delete" on public.watchlist for delete using (auth.uid() = user_id);

-- Cap watchlist size per user (defense-in-depth; the server action also checks).
-- Protects the shared market-data budget from one account adding thousands of names.
create or replace function public.enforce_watchlist_cap()
returns trigger language plpgsql
set search_path = public
as $$
begin
  -- Serialize per user so two concurrent inserts can't both pass the count check.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if (select count(*) from public.watchlist where user_id = new.user_id) >= 80 then
    raise exception 'watchlist limit reached (80)';
  end if;
  return new;
end;
$$;
drop trigger if exists watchlist_cap on public.watchlist;
create trigger watchlist_cap before insert on public.watchlist
  for each row execute function public.enforce_watchlist_cap();

-- 2) Latest computed signal per symbol (global; written by the cron job) ------
create table if not exists public.symbol_signals (
  symbol      text primary key,
  price       double precision,
  zone_low    double precision,
  zone_high   double precision,
  rsi         double precision,
  ma50        double precision,
  ma200       double precision,
  trend_up    boolean,
  assessment  text,          -- BUY | WASHOUT | WATCH | OVERBOUGHT
  tag         text,          -- SWEET | OK | OVERSOLD | EXPENSIVE | FALLING | NEAR
  score       integer,
  updated_at  timestamptz not null default now()
);

alter table public.symbol_signals enable row level security;
-- Any signed-in user may read signals (the app only queries their own symbols).
create policy "signals read authenticated" on public.symbol_signals
  for select using (auth.role() = 'authenticated');
-- Writes happen only via the service-role key in the cron route (bypasses RLS).

-- 3) Daily history, for the "since yesterday" change-log ----------------------
create table if not exists public.signal_history (
  symbol     text not null,
  as_of      date not null,
  assessment text,
  score      integer,
  primary key (symbol, as_of)
);

alter table public.signal_history enable row level security;
create policy "history read authenticated" on public.signal_history
  for select using (auth.role() = 'authenticated');
