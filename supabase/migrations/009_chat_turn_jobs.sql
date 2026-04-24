-- 2026-04-24: async chat turn jobs
--   * chat_turn_jobs tracks each LLM turn (pending → processing → complete | error)
--   * enables 202+background processing, Realtime, and idempotent replays
--   * partial unique index prevents duplicate user rows per (user, turn) for idempotency

create table chat_turn_jobs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  thread_id  uuid not null,
  turn_id    uuid not null,
  source     text not null
    check (source in ('text', 'narrated', 'both')),
  project_id uuid null references chat_projects (id) on delete set null,
  status     text not null default 'pending'
    check (status in ('pending', 'processing', 'complete', 'error')),
  error_message text null,
  result     jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chat_turn_jobs_user_turn unique (user_id, turn_id)
);

create index chat_turn_jobs_user_thread_idx
  on chat_turn_jobs (user_id, thread_id, created_at desc);

alter table chat_turn_jobs enable row level security;

create policy "Users see own turn jobs"
  on chat_turn_jobs for all
  using (auth.uid() = user_id);

-- One user message per logical turn (idempotent client retries)
create unique index if not exists chat_messages_user_turn_user_unique
  on chat_messages (user_id, turn_id)
  where role = 'user' and turn_id is not null;

alter publication supabase_realtime add table chat_turn_jobs;
