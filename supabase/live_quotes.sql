-- ---------------------------------------------------------------------------
-- Live prices (Finnhub). The website fetches /quote for the symbols people hold
-- and caches them here; the dashboard and the Stocky device both read this
-- cache, so they always show the same numbers.
--
-- The Finnhub key lives encrypted in Supabase Vault (one per user), readable
-- only by the service role through the functions below. Never an env var, never
-- sent to the browser. price_connections only holds a hint ("…a1b2").
--
-- Prices are not private, so the cache is shared across users: each symbol is
-- fetched at most once per TTL however many people or devices ask
-- (claim_quotes hands each stale symbol to exactly one request).
-- ---------------------------------------------------------------------------
create table if not exists public.live_quotes (
  symbol     text primary key,
  c          double precision,  -- current
  pc         double precision,  -- previous close
  dp         double precision,  -- day %
  o          double precision,
  h          double precision,
  l          double precision,
  fetched_at timestamptz,       -- when Finnhub answered (null = never)
  claimed_at timestamptz        -- when a request last took the job of fetching it
);
alter table public.live_quotes enable row level security;
drop policy if exists "live_quotes signed-in read" on public.live_quotes;
create policy "live_quotes signed-in read" on public.live_quotes for select to authenticated using (true);

create table if not exists public.price_connections (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  key_hint     text,
  connected_at timestamptz not null default now()
);
alter table public.price_connections enable row level security;
drop policy if exists "price_connections owner read" on public.price_connections;
create policy "price_connections owner read" on public.price_connections for select using (auth.uid() = user_id);

create or replace function public.set_finnhub_key(p_user uuid, p_key text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare
  v_name text := 'finnhub:' || p_user::text;
  v_id   uuid;
begin
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(p_key, v_name, 'Finnhub API key (live prices)');
  else
    perform vault.update_secret(v_id, p_key);
  end if;
end $$;

create or replace function public.get_finnhub_key(p_user uuid)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'finnhub:' || p_user::text limit 1;
$$;

create or replace function public.remove_finnhub_key(p_user uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where name = 'finnhub:' || p_user::text;
$$;

-- Hand out up to p_limit symbols whose last claim is older than p_ttl_sec,
-- stalest first, marking them claimed now. Concurrent callers never get the
-- same symbol (skip locked), so the Finnhub rate is bounded by the TTL.
create or replace function public.claim_quotes(p_symbols text[], p_ttl_sec integer, p_limit integer)
returns setof text language plpgsql security definer set search_path = public as $$
begin
  insert into live_quotes (symbol) select distinct unnest(p_symbols) on conflict (symbol) do nothing;
  return query
  with c as (
    select q.symbol from live_quotes q
    where q.symbol = any (p_symbols)
      and (q.claimed_at is null or q.claimed_at < now() - make_interval(secs => p_ttl_sec))
    order by q.fetched_at nulls first
    limit p_limit
    for update skip locked
  ), u as (
    update live_quotes l set claimed_at = now() from c where l.symbol = c.symbol
    returning l.symbol
  )
  select u.symbol from u;
end $$;

revoke all on function public.set_finnhub_key(uuid, text) from public, anon, authenticated;
revoke all on function public.get_finnhub_key(uuid) from public, anon, authenticated;
revoke all on function public.remove_finnhub_key(uuid) from public, anon, authenticated;
revoke all on function public.claim_quotes(text[], integer, integer) from public, anon, authenticated;
grant execute on function public.set_finnhub_key(uuid, text) to service_role;
grant execute on function public.get_finnhub_key(uuid) to service_role;
grant execute on function public.remove_finnhub_key(uuid) to service_role;
grant execute on function public.claim_quotes(text[], integer, integer) to service_role;
