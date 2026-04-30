-- 2026-04-30: persist retrieval mode used per thread, message, and job
--   * keeps retrieval strategy (`anythingllm|pgvector|hybrid`) orthogonal to
--     source corpus selection (`text|narrated|both`)
--   * enables analytics/debugging of answer provenance by mode

alter table chat_threads
  add column if not exists retrieval_mode text not null default 'hybrid'
  check (retrieval_mode in ('anythingllm', 'pgvector', 'hybrid'));

alter table chat_messages
  add column if not exists retrieval_mode text
  check (retrieval_mode in ('anythingllm', 'pgvector', 'hybrid'));

alter table chat_turn_jobs
  add column if not exists retrieval_mode text not null default 'hybrid'
  check (retrieval_mode in ('anythingllm', 'pgvector', 'hybrid'));

create index if not exists chat_messages_retrieval_mode_idx
  on chat_messages (user_id, thread_id, retrieval_mode);

create index if not exists chat_turn_jobs_retrieval_mode_idx
  on chat_turn_jobs (user_id, thread_id, retrieval_mode, created_at desc);
