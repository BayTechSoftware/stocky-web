-- Sign-up is closed (owner decision 2026-11-11): any new auth user is refused.
-- Applied live 2026-11-11. To re-open, the owner removes this trigger by hand.
create or replace function public.block_new_signups() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Sign-up is closed';
end $$;
revoke all on function public.block_new_signups() from public, anon, authenticated;
create trigger block_new_signups before insert on auth.users for each row execute function public.block_new_signups();
