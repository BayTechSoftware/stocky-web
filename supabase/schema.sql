-- Stocky Watcher — Supabase schema (run in the SQL editor, or via `supabase db push`).
-- Auth is handled by Supabase Auth (auth.users). These are the app tables.

-- 1) Per-user watchlist + holdings --------------------------------------------
-- One row per tracked symbol. With non-empty `lots` it's a held position
-- (watch_only=false); otherwise it's watch-only. Mirrors the Stocky device model.
create table if not exists public.watchlist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  symbol      text not null check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,15}$'),
  list        text not null default 'Watchlist',
  watch_only  boolean not null default true,
  alert_above double precision,
  alert_below double precision,
  lots        jsonb not null default '[]'::jsonb,   -- [{qty, price, date?(epoch s)}]
  created_at  timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists watchlist_user_idx on public.watchlist (user_id);

alter table public.watchlist enable row level security;
-- Each user sees and edits only their own rows.
create policy "watchlist owner read"   on public.watchlist for select using (auth.uid() = user_id);
create policy "watchlist owner insert" on public.watchlist for insert with check (auth.uid() = user_id);
create policy "watchlist owner delete" on public.watchlist for delete using (auth.uid() = user_id);
create policy "watchlist owner update" on public.watchlist for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

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
  prev_close  double precision,   -- previous daily close (for day %)
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

-- 4) AI Trader — virtual $5K books inside ONE Alpaca PAPER account -------------
-- Each book's cash/positions are rebuilt from its own fills (ai_fills), attributed
-- by Alpaca order id. Rows are written only by the server (service role).
create table if not exists public.ai_books (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  key         text not null check (key in ('mylist','free')),
  name        text not null,
  start_cash  double precision not null check (start_cash > 0),
  created_at  timestamptz not null default now(),
  unique (user_id, key)
);
create table if not exists public.ai_orders (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid not null references public.ai_books (id) on delete cascade,
  symbol          text not null,
  side            text not null check (side in ('buy','sell')),
  kind            text not null check (kind in ('entry','exit')),
  qty             double precision not null,
  ref_price       double precision,
  limit_price     double precision,
  stop_price      double precision,
  target_price    double precision,
  reason          text,
  alpaca_order_id text unique,
  leg_ids         text[] not null default '{}',
  client_order_id text,
  status          text not null default 'submitted',
  filled_qty      double precision not null default 0,
  filled_avg      double precision,
  created_at      timestamptz not null default now()
);
create index if not exists ai_orders_book_idx on public.ai_orders (book_id, created_at desc);
create table if not exists public.ai_fills (
  activity_id     text primary key,
  book_id         uuid not null references public.ai_books (id) on delete cascade,
  order_id        text not null,
  symbol          text not null,
  side            text not null check (side in ('buy','sell')),
  qty             double precision not null,
  price           double precision not null,
  transacted_at   timestamptz not null
);
create index if not exists ai_fills_book_idx on public.ai_fills (book_id, transacted_at);
create table if not exists public.ai_runs (
  id       uuid primary key default gen_random_uuid(),
  book_id  uuid not null references public.ai_books (id) on delete cascade,
  ran_at   timestamptz not null default now(),
  mode     text not null check (mode in ('cron','manual','dry')),
  summary  jsonb not null default '{}'::jsonb,
  error    text
);
create index if not exists ai_runs_book_idx on public.ai_runs (book_id, ran_at desc);
create table if not exists public.ai_equity (
  book_id  uuid not null references public.ai_books (id) on delete cascade,
  as_of    date not null,
  equity   double precision not null,
  cash     double precision not null,
  primary key (book_id, as_of)
);
alter table public.ai_books  enable row level security;
alter table public.ai_orders enable row level security;
alter table public.ai_fills  enable row level security;
alter table public.ai_runs   enable row level security;
alter table public.ai_equity enable row level security;
create policy "ai_books owner read" on public.ai_books for select using (auth.uid() = user_id);
create policy "ai_orders owner read" on public.ai_orders for select
  using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
create policy "ai_fills owner read" on public.ai_fills for select
  using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
create policy "ai_runs owner read" on public.ai_runs for select
  using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
create policy "ai_equity owner read" on public.ai_equity for select
  using (exists (select 1 from public.ai_books b where b.id = book_id and b.user_id = auth.uid()));
-- Books are seeded per owner, e.g.:
--   insert into public.ai_books (user_id, key, name, start_cash) values
--     ('<uid>','mylist','My List',5000), ('<uid>','free','Free Choice',5000);

-- ---------------------------------------------------------------------------
-- AI Trader: per-box limits, runner settings, per-user Alpaca PAPER keys.
-- Keys live encrypted in Supabase Vault (one secret per user), readable only by
-- the service role through the functions below — never an env var, never sent
-- to the browser. broker_connections only holds a hint ("PA…1234").
-- ---------------------------------------------------------------------------
alter table public.ai_books add column if not exists settings jsonb not null default '{}'::jsonb;

create table if not exists public.ai_runner (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb, -- interval_min, weekly_cap_usd (read by the Mac's watcher)
  updated_at timestamptz not null default now()
);
alter table public.ai_runner enable row level security;
create policy "ai_runner owner read" on public.ai_runner for select using (auth.uid() = user_id);

create table if not exists public.broker_connections (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  account_hint text,
  connected_at timestamptz not null default now()
);
alter table public.broker_connections enable row level security;
create policy "broker_connections owner read" on public.broker_connections for select using (auth.uid() = user_id);

create or replace function public.set_alpaca_credentials(p_user uuid, p_key_id text, p_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare
  v_name text := 'alpaca_paper:' || p_user::text;
  v_id   uuid;
  v_val  text := json_build_object('key_id', p_key_id, 'secret', p_secret)::text;
begin
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(v_val, v_name, 'Alpaca paper keys');
  else
    perform vault.update_secret(v_id, v_val);
  end if;
end $$;

create or replace function public.get_alpaca_credentials(p_user uuid)
returns jsonb language sql security definer set search_path = public, vault as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets
  where name = 'alpaca_paper:' || p_user::text limit 1;
$$;

create or replace function public.remove_alpaca_credentials(p_user uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where name = 'alpaca_paper:' || p_user::text;
$$;

revoke all on function public.set_alpaca_credentials(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_alpaca_credentials(uuid) from public, anon, authenticated;
revoke all on function public.remove_alpaca_credentials(uuid) from public, anon, authenticated;
grant execute on function public.set_alpaca_credentials(uuid, text, text) to service_role;
grant execute on function public.get_alpaca_credentials(uuid) to service_role;
grant execute on function public.remove_alpaca_credentials(uuid) to service_role;
