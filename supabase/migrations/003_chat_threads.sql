-- 2026-04-21: add chat_threads table to hold per-thread titles
--   * previously the history sidebar labeled each thread with the first 40 chars of
--     the user's earliest message, which produced noisy titles like
--     "What does Francis and Luisa say about..." that truncated before the topic
--   * this migration introduces chat_threads keyed by thread_id (which is already
--     the cross-table handle for a conversation, see 002_thread_id.sql)
--   * the Edge Function writes a short LLM-generated title on first exchange; if
--     an older thread has no row yet, the next message in that thread will
--     retroactively title it, so the backfill is lazy and opt-in
--   * RLS mirrors chat_messages: a user can only see + manage their own threads
--   * index on (user_id, created_at desc) matches the sidebar's newest-first query

create table chat_threads (
  thread_id   uuid primary key,
  user_id     uuid references auth.users not null,
  title       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table chat_threads enable row level security;

create policy "Users see own threads"
  on chat_threads for all
  using (auth.uid() = user_id);

create index on chat_threads (user_id, created_at desc);
