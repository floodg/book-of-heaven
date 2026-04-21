-- 2026-04-21: add Projects (folders) + Labels (tags) for organizing threads
--   * chat_projects holds per-user folders a thread can live inside
--   * chat_threads.project_id lets each thread belong to at most one project
--     (we use ON DELETE SET NULL here; the app performs the full cascade
--     delete — messages + thread_labels + threads — inside one user action
--     so we can also wipe chat_messages, which isn't reachable from
--     chat_projects via FK alone)
--   * chat_labels holds per-user tags; a thread can carry many labels
--   * chat_thread_labels is the many-to-many join between threads and labels
--   * backfill: every distinct thread_id already in chat_messages gets a
--     chat_threads row (with NULL title, NULL project_id) so that every
--     existing thread becomes addressable for project assignment and
--     labeling without waiting for the next message to pass through the
--     edge function
--   * RLS mirrors chat_messages / chat_threads: a user can only see + manage
--     their own rows on every new table
--   * chat_thread_labels carries its own user_id column so RLS is enforceable
--     without joining across tables (and matches the shape of chat_threads)

create table chat_projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  name        text not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table chat_projects enable row level security;

create policy "Users see own projects"
  on chat_projects for all
  using (auth.uid() = user_id);

create index on chat_projects (user_id, created_at);

alter table chat_threads
  add column project_id uuid references chat_projects(id) on delete set null;

create index on chat_threads (user_id, project_id);

insert into chat_threads (thread_id, user_id, title)
select distinct m.thread_id, m.user_id, null
from chat_messages m
where not exists (
  select 1 from chat_threads t where t.thread_id = m.thread_id
);

create table chat_labels (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  name        text not null,
  color       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table chat_labels enable row level security;

create policy "Users see own labels"
  on chat_labels for all
  using (auth.uid() = user_id);

create index on chat_labels (user_id, created_at);

create table chat_thread_labels (
  thread_id   uuid not null references chat_threads(thread_id) on delete cascade,
  label_id    uuid not null references chat_labels(id) on delete cascade,
  user_id     uuid references auth.users not null,
  created_at  timestamptz default now(),
  primary key (thread_id, label_id)
);

alter table chat_thread_labels enable row level security;

create policy "Users see own thread labels"
  on chat_thread_labels for all
  using (auth.uid() = user_id);

create index on chat_thread_labels (user_id, label_id);
create index on chat_thread_labels (user_id, thread_id);
