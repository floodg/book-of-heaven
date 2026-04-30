import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { AssistantSource, SearchHit } from './format_hits.ts'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIM = 1536

export type { AssistantSource, SearchHit }

export async function embedQuery(text: string): Promise<number[]> {
  const key = Deno.env.get('OPENAI_API_KEY')?.trim()
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured for semantic search')
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIM,
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    console.error('OpenAI embeddings error', res.status, raw)
    throw new Error(`OpenAI embeddings failed (${res.status})`)
  }
  const parsed = JSON.parse(raw) as {
    data?: Array<{ embedding?: number[] }>
  }
  const emb = parsed.data?.[0]?.embedding
  if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
    throw new Error('Invalid embedding response from OpenAI')
  }
  return emb
}

export async function searchDocumentChunks(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  corpus: AssistantSource,
  matchCount: number,
  filterVolume: number | null,
): Promise<SearchHit[]> {
  const { data, error } = await supabase.rpc('search_document_chunks', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_corpus: corpus,
    filter_volume: filterVolume,
  })
  if (error) {
    console.error('search_document_chunks RPC error', error)
    throw new Error(error.message || 'Vector search failed')
  }
  if (!Array.isArray(data)) return []
  return data as SearchHit[]
}
