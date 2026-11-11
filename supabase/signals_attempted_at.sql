-- Stale signals marked fresh (engine fix #3).
--
-- symbol_signals.updated_at now means "a signal was actually computed". A refresh
-- attempt that got no data only touches attempted_at, which the rotation queue
-- (stalest first) orders by, so a failing ticker still moves to the back.
--
-- Safe to apply before or after the deploy: the code checks for the column and,
-- without it, leaves existing rows alone on a failed attempt (rotation then falls
-- back to updated_at).
alter table public.symbol_signals add column if not exists attempted_at timestamptz;
update public.symbol_signals set attempted_at = updated_at where attempted_at is null;
