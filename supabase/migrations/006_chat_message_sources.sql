-- 006_chat_message_sources.sql
-- Adds per-message retrieval sources payload so citation → PDF/YouTube links
-- survive a page reload (see docs/SPEC-source-linking.md). The jsonb shape
-- is intentionally loose: we store whatever the AnythingLLM stream emitted,
-- and the frontend is defensive about which fields are present.

alter table chat_messages
  add column if not exists sources jsonb;
