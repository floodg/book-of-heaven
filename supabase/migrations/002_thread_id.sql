-- 2026-04-21: promote "thread" from a day-bucket to a real UUID column
--   * previously a thread was defined as (user_id, day-of-created_at), which meant
--     "New Chat" within the same day silently merged into the existing conversation
--   * this migration adds chat_messages.thread_id so each New Chat session can mint
--     its own UUID and remain visually and logically separate
--   * backfills existing rows by bucketing (user_id, day) -> one shared thread_id so
--     prior history still shows as one conversation per day
--   * tightens indexing to (user_id, thread_id, created_at) for both the history
--     sidebar (distinct thread_ids per user) and the chat window (ordered messages
--     within a single thread)

alter table chat_messages add column thread_id uuid;

update chat_messages
set thread_id = subq.backfill_thread_id
from (
  select
    user_id,
    (created_at at time zone 'utc')::date as day,
    gen_random_uuid() as backfill_thread_id
  from chat_messages
  group by user_id, (created_at at time zone 'utc')::date
) subq
where chat_messages.user_id = subq.user_id
  and (chat_messages.created_at at time zone 'utc')::date = subq.day;

alter table chat_messages alter column thread_id set not null;

create index on chat_messages (user_id, thread_id, created_at);
