-- 2026-04-24: enable Supabase Realtime for chat_messages
--   * adds chat_messages to the supabase_realtime publication so the frontend
--     can subscribe to new INSERT events via a Postgres Changes channel
--   * this lets ChatWindow detect when the edge function finishes writing the
--     assistant reply without polling, even when the user navigated away or
--     refreshed the page while the query was running

alter publication supabase_realtime add table chat_messages;
