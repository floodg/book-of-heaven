-- 2026-04-21: pivot to Claude-style Projects UI; drop Labels; add project
-- context fields + thread pinning.
--   * Labels feature is dropped outright (tables + policies). All per-user
--     label data is lost. The feature was introduced ~hours earlier in 004
--     and never shipped to any real user data, so a hard drop is safe.
--   * chat_projects gains optional `description` (shown on the Projects grid
--     card) and `instructions` (per-project system prompt prepended to every
--     message sent from a thread inside this project).
--   * chat_threads gains nullable `pinned_at`. When set, the thread appears
--     in the sidebar's "Pinned" section; threads are sorted by pinned_at
--     descending so the most recently pinned one floats to the top. Null =
--     not pinned, which is the default for every existing row.
--   * Index on (user_id, pinned_at desc) lets the sidebar fetch the Pinned
--     section with a partial-index-friendly query without scanning every
--     thread in the account.

drop table if exists chat_thread_labels;
drop table if exists chat_labels;

alter table chat_projects
  add column description  text,
  add column instructions text;

alter table chat_threads
  add column pinned_at timestamptz;

create index on chat_threads (user_id, pinned_at desc) where pinned_at is not null;
