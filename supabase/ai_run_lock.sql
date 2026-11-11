-- One Rules run per user at a time (engine fix #6): "Run rules now" and the cron
-- can't overlap. A lock row per user with an expiry, so a crashed run (function
-- timeout) frees itself. Service role only (the engine runs with the admin key).
--
-- Safe to apply before or after the deploy: without these functions the engine
-- runs unlocked (today's behaviour) and says so in the run note. Deterministic
-- client order ids still make Alpaca reject a duplicate entry in the meantime.
create table if not exists public.ai_run_locks (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  run_id       text not null,
  locked_until timestamptz not null
);
alter table public.ai_run_locks enable row level security;
-- No policies: only the service role (which bypasses RLS) reads or writes it.

-- Take the lock for p_ttl_sec seconds; true when taken (free, expired, or already ours).
create or replace function public.try_lock_ai_run(p_user uuid, p_run text, p_ttl_sec integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  got text;
begin
  insert into public.ai_run_locks as l (user_id, run_id, locked_until)
  values (p_user, p_run, now() + make_interval(secs => p_ttl_sec))
  on conflict (user_id) do update
    set run_id = excluded.run_id, locked_until = excluded.locked_until
    where l.locked_until < now() or l.run_id = excluded.run_id
  returning run_id into got;
  return got = p_run;
end;
$$;

-- Release it (only if it is still ours).
create or replace function public.release_ai_run(p_user uuid, p_run text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_run_locks set locked_until = now() where user_id = p_user and run_id = p_run;
$$;

revoke all on function public.try_lock_ai_run(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_ai_run(uuid, text) from public, anon, authenticated;
