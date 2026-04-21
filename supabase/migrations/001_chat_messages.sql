-- 2026-04-21: initial schema for per-user chat history
--   * creates chat_messages table (user/assistant messages keyed by auth.users)
--   * enables RLS with a per-user policy so users can only see their own rows
--   * adds index on (user_id, created_at desc) for history sidebar queries

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz default now()
);

alter table chat_messages enable row level security;

create policy "Users see own messages"
  on chat_messages for all
  using (auth.uid() = user_id);

create index on chat_messages (user_id, created_at desc);
