-- 2026-04-25: add optional volume filter to match_document_chunks
--   * raises default match_count from 8 to 20 for better recall on
--     broad questions (theme of a volume, general topic searches)
--   * adds volume_num int parameter; when non-null, restricts results to
--     documents whose title contains that volume number regardless of
--     zero-padding (e.g. volume_num=8 matches both "Volume 08" PDFs and
--     "Book of Heaven Volume 8 - Number N" VTT titles)
--   * uses regexp_replace to extract the integer volume number from any
--     title format so the filter works across both workspaces without
--     needing normalised title values

create or replace function match_document_chunks(
  query_embedding     vector(1536),
  workspace_id_filter uuid,
  match_count         int  default 20,
  volume_num          int  default null
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
    and (
      volume_num is null
      or cast(
           nullif(
             regexp_replace(d.title, '.*[Vv]olume\s+0*(\d+).*', '\1'),
             d.title
           ) as int
         ) = volume_num
    )
  order by de.embedding <=> query_embedding
  limit match_count;
$$;
