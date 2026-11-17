-- Day Trader Claude (claude-day) + Long-Term Claude (claude-long), and hidden boxes.
-- Run by hand in the Supabase SQL editor, in this order. Nothing is deleted.
alter table ai_books add column if not exists hidden boolean not null default false;
-- run by hand first: alter table ai_books drop constraint ai_books_key_check;
alter table ai_books add constraint ai_books_key_check check (key in ('mylist','free','claude-mylist','claude-free','claude-day','claude-long'));
