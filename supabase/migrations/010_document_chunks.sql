-- document_chunks: unified semantic-search rows for diary text (source_type text)
-- and VTT narration (source_type narrated). Embeddings use cosine distance (<=>).

create extension if not exists vector;

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('text', 'narrated')),
  ingest_key text not null,
  volume integer not null,
  chunk_index integer not null,
  chunk_count integer,
  citation_label text,
  chunk_text text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  entry_date date,
  entry_index_in_volume integer,
  entry_title text,
  transcript_number integer,
  time_start_sec double precision,
  time_end_sec double precision,
  youtube_video_id text,
  word_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_chunks_ingest_key_unique unique (ingest_key)
);

create index document_chunks_source_volume_idx
  on public.document_chunks (source_type, volume);

create index document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.document_chunks enable row level security;

-- No policies: reads/writes go through service_role (edge + ingestion scripts) only.
grant select, insert, update, delete on public.document_chunks to service_role;

create or replace function public.search_document_chunks(
  query_embedding vector(1536),
  match_count integer,
  filter_corpus text,
  filter_volume integer default null
)
returns table (
  id uuid,
  source_type text,
  volume integer,
  chunk_index integer,
  chunk_count integer,
  citation_label text,
  chunk_text text,
  entry_date date,
  entry_index_in_volume integer,
  entry_title text,
  transcript_number integer,
  time_start_sec double precision,
  time_end_sec double precision,
  youtube_video_id text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
as $$
  select
    dc.id,
    dc.source_type,
    dc.volume,
    dc.chunk_index,
    dc.chunk_count,
    dc.citation_label,
    dc.chunk_text,
    dc.entry_date,
    dc.entry_index_in_volume,
    dc.entry_title,
    dc.transcript_number,
    dc.time_start_sec,
    dc.time_end_sec,
    dc.youtube_video_id,
    dc.metadata,
    (1 - (dc.embedding <=> query_embedding))::double precision as similarity
  from public.document_chunks dc
  where dc.embedding is not null
    and dc.source_type = filter_corpus
    and (filter_volume is null or dc.volume = filter_volume)
  order by dc.embedding <=> query_embedding
  limit greatest(1, least(match_count, 100));
$$;

grant execute on function public.search_document_chunks(vector(1536), integer, text, integer) to service_role;
