-- 2026-07-01: add thread archiving so users can hide past chats without deleting them.
--   * chat_threads gains nullable `archived_at`. When set, the thread is hidden
--     from the sidebar Recents/Pinned sections and project thread lists, but
--     remains accessible from the Archive page and via direct URL.
--   * Partial index on (user_id, archived_at desc) for the Archive page query.

alter table chat_threads
  add column if not exists archived_at timestamptz;

create index if not exists chat_threads_user_id_archived_at_idx
  on chat_threads (user_id, archived_at desc) where archived_at is not null;
