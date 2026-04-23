-- 007_chat_message_source.sql
-- Adds per-message source selection so users can ask the text workspace,
-- the narrated workspace, or both at once. When "both" is chosen the edge
-- function inserts two assistant rows (one per workspace) sharing a turn_id
-- with the originating user row, and the frontend groups by turn_id to
-- render the two replies side-by-side. Legacy rows have null values in
-- both columns and keep rendering one-bubble-per-row.
--
-- User rows may carry source = 'text' | 'narrated' | 'both' (what the
-- user asked for). Assistant rows only ever carry 'text' or 'narrated'
-- (which workspace produced that reply). We don't encode that distinction
-- in a CHECK constraint because doing so would require joining to role,
-- and the application layer is the source of truth anyway.

alter table chat_messages
  add column if not exists source text
    check (source in ('text', 'narrated', 'both'));

alter table chat_messages
  add column if not exists turn_id uuid;

create index if not exists chat_messages_turn_idx
  on chat_messages (user_id, thread_id, turn_id);
