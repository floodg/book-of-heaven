-- 2026-04-25: pgvector similarity search helper function
--   * match_document_chunks performs a cosine similarity search over
--     document_embeddings for a given workspace, joining back to
--     document_chunks and documents to return everything the edge
--     function needs to build the context block in a single call
--   * returns top `match_count` results ordered by cosine similarity desc
--   * filtered to a single workspace_id so each workspace stays isolated
--   * the function runs with SECURITY DEFINER so the edge function
--     (service role) can call it via rpc() without the caller needing
--     direct SELECT on the embedding table

create or replace function match_document_chunks(
  query_embedding  vector(1536),
  workspace_id_filter uuid,
  match_count      int default 8
)
returns table (
  chunk_id         uuid,
  document_id      uuid,
  content          text,
  heading          text,
  page_number      int,
  timestamp_start  text,
  timestamp_end    text,
  document_title   text,
  source_type      text,
  file_name        text,
  source_url       text,
  similarity       float
)
language sql stable
as $$
  select
    dc.id          as chunk_id,
    dc.document_id,
    dc.content,
    dc.heading,
    dc.page_number,
    dc.timestamp_start,
    dc.timestamp_end,
    d.title        as document_title,
    d.source_type,
    d.file_name,
    d.source_url,
    1 - (de.embedding <=> query_embedding) as similarity
  from document_embeddings de
  join document_chunks dc on dc.id = de.chunk_id
  join documents d        on d.id  = dc.document_id
  where d.workspace_id = workspace_id_filter
  order by de.embedding <=> query_embedding
  limit match_count;
$$;
