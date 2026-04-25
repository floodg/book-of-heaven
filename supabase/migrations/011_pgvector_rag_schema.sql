-- 2026-04-25: pgvector RAG schema — replaces AnythingLLM as the public backend
--   * enables the pgvector extension for similarity search
--   * research_workspaces: admin-curated document collections (not user-created),
--     each with its own system_prompt, default_model, and is_public flag; seeds
--     the two existing AnythingLLM workspaces (narrated, text) so the SourceToggle
--     ('Text', 'Narrated', 'Both') continues to work identically for end users
--   * documents: one row per source file (PDF, VTT, etc.) scoped to a workspace;
--     natural key on (workspace_id, file_name) for idempotent ingestion
--   * document_chunks: searchable passages from a document; unique on
--     (document_id, chunk_index) for idempotent re-ingestion
--   * document_embeddings: one embedding row per (chunk, embedding_model) pair
--     so the corpus can be re-embedded with a different model without dropping
--     the old vectors first; unique on (chunk_id, embedding_model)
--   * research_threads: per-user research conversations scoped to a workspace;
--     separate from chat_threads (personal chat) to keep concerns cleanly split
--   * research_messages: user/assistant messages with structured citations,
--     model identity, and token/cost metadata for rate-limiting and reporting
--   * model_usage: optional aggregated cost reporting per (user, thread, message)
--   * all user-owned tables mirror the RLS pattern from chat_messages / chat_threads
--     (auth.uid() = user_id for all operations)
--   * authenticated read on document corpus tables; service-role-only write
--     (ingestion script runs outside normal user auth)

create extension if not exists vector;

-- ─────────────────────────────────────────────────────────────────────────────
-- research_workspaces
-- ─────────────────────────────────────────────────────────────────────────────

create table research_workspaces (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  name             text not null,
  description      text,
  source_type_hint text,          -- informational hint for ingestion tooling ('vtt', 'pdf', etc.)
  system_prompt    text,
  default_model    text not null default 'workspace-default',
  is_public        boolean not null default true,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Anyone can read public workspaces; only service role can write.
alter table research_workspaces enable row level security;

create policy "Public read for public workspaces"
  on research_workspaces for select
  using (is_public = true);

-- ─────────────────────────────────────────────────────────────────────────────
-- documents
-- ─────────────────────────────────────────────────────────────────────────────

create table documents (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references research_workspaces(id) on delete cascade,
  title        text not null,
  source_type  text not null check (source_type in ('vtt', 'pdf', 'doc', 'manual')),
  source_url   text,
  file_name    text,
  metadata     jsonb default '{}'::jsonb,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Natural key for idempotent ingestion: one row per file per workspace.
create unique index documents_workspace_file_idx
  on documents (workspace_id, file_name)
  where file_name is not null;

alter table documents enable row level security;

create policy "Authenticated read for documents"
  on documents for select
  to authenticated
  using (
    exists (
      select 1 from research_workspaces rw
      where rw.id = documents.workspace_id
        and rw.is_public = true
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- document_chunks
-- ─────────────────────────────────────────────────────────────────────────────

create table document_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid references documents(id) on delete cascade,
  chunk_index     int not null,
  content         text not null,
  heading         text,
  page_number     int,
  timestamp_start text,
  timestamp_end   text,
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now()
);

create unique index document_chunks_doc_idx_idx
  on document_chunks (document_id, chunk_index);

create index document_chunks_document_id_idx
  on document_chunks (document_id);

alter table document_chunks enable row level security;

create policy "Authenticated read for document_chunks"
  on document_chunks for select
  to authenticated
  using (
    exists (
      select 1
      from documents d
      join research_workspaces rw on rw.id = d.workspace_id
      where d.id = document_chunks.document_id
        and rw.is_public = true
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- document_embeddings
-- ─────────────────────────────────────────────────────────────────────────────

create table document_embeddings (
  id              uuid primary key default gen_random_uuid(),
  chunk_id        uuid references document_chunks(id) on delete cascade,
  embedding       vector(1536),
  embedding_model text not null,
  created_at      timestamptz default now()
);

-- Idempotent re-embedding: one vector per (chunk, model).
create unique index document_embeddings_chunk_model_idx
  on document_embeddings (chunk_id, embedding_model);

-- HNSW cosine similarity index — builds incrementally so it works on an empty
-- table at migration time and stays valid as rows are ingested. Offers better
-- recall than IVFFlat for datasets up to ~10M rows. If the corpus grows very
-- large and recall vs. throughput tradeoffs need tuning, replace with an
-- IVFFlat index (requires rows to build) in a separate migration.
create index document_embeddings_embedding_idx
  on document_embeddings
  using hnsw (embedding vector_cosine_ops);

alter table document_embeddings enable row level security;

create policy "Authenticated read for document_embeddings"
  on document_embeddings for select
  to authenticated
  using (
    exists (
      select 1
      from document_chunks dc
      join documents d on d.id = dc.document_id
      join research_workspaces rw on rw.id = d.workspace_id
      where dc.id = document_embeddings.chunk_id
        and rw.is_public = true
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- research_threads
-- ─────────────────────────────────────────────────────────────────────────────

create table research_threads (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  workspace_id   uuid references research_workspaces(id) on delete set null,
  title          text,
  selected_model text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table research_threads enable row level security;

create policy "Users see own research threads"
  on research_threads for all
  using (auth.uid() = user_id);

create index research_threads_user_created_idx
  on research_threads (user_id, created_at desc);

create index research_threads_user_workspace_idx
  on research_threads (user_id, workspace_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- research_messages
-- ─────────────────────────────────────────────────────────────────────────────

create table research_messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid references research_threads(id) on delete cascade not null,
  user_id         uuid references auth.users(id) on delete cascade not null,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         text not null,
  turn_id         uuid,
  model           text,
  input_tokens    int,
  output_tokens   int,
  estimated_cost  numeric(10, 6),
  citations       jsonb default '[]'::jsonb,
  source          text check (source in ('text', 'narrated', 'both', null)),
  created_at      timestamptz default now()
);

alter table research_messages enable row level security;

create policy "Users see own research messages"
  on research_messages for all
  using (auth.uid() = user_id);

create index research_messages_thread_created_idx
  on research_messages (thread_id, created_at asc);

create index research_messages_user_created_idx
  on research_messages (user_id, created_at desc);

create index research_messages_turn_idx
  on research_messages (user_id, thread_id, turn_id)
  where turn_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- model_usage
-- ─────────────────────────────────────────────────────────────────────────────

create table model_usage (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade not null,
  thread_id       uuid references research_threads(id) on delete set null,
  message_id      uuid references research_messages(id) on delete set null,
  provider        text not null,
  model           text not null,
  input_tokens    int default 0,
  output_tokens   int default 0,
  estimated_cost  numeric(10, 6),
  created_at      timestamptz default now()
);

alter table model_usage enable row level security;

create policy "Users see own model usage"
  on model_usage for all
  using (auth.uid() = user_id);

create index model_usage_user_created_idx
  on model_usage (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: publish research_messages so the frontend can stream new replies
-- ─────────────────────────────────────────────────────────────────────────────

alter publication supabase_realtime add table research_messages;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: initial workspaces matching existing AnythingLLM workspace slugs
-- ─────────────────────────────────────────────────────────────────────────────

insert into research_workspaces (slug, name, description, source_type_hint, system_prompt, default_model, is_public)
values
  (
    'narrated',
    'Book of Heaven — Narrated',
    'Audio transcripts of Francis Hogan reading the Book of Heaven by Luisa Piccarreta',
    'vtt',
    'You are a research assistant helping users study the Book of Heaven by Luisa Piccarreta. '
    'The context below is drawn from audio transcripts of Francis Hogan''s narration. '
    'Answer the user''s question using only the provided context. '
    'When citing sources, reference the volume and number (e.g. "Volume 4, Number 7"). '
    'If the context does not contain enough information, say so honestly.',
    'workspace-default',
    true
  ),
  (
    'text',
    'Book of Heaven — Text / PDFs',
    'PDF text of the Book of Heaven diary volumes by Luisa Piccarreta',
    'pdf',
    'You are a research assistant helping users study the Book of Heaven by Luisa Piccarreta. '
    'The context below is drawn from the PDF diary texts. '
    'Answer the user''s question using only the provided context. '
    'When citing sources, reference the volume and date (e.g. "Volume 25, January 13, 1929"). '
    'If the context does not contain enough information, say so honestly.',
    'workspace-default',
    true
  );
