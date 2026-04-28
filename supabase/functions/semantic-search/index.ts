import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { embedQuery, searchDocumentChunks } from '../_shared/pgvector_search.ts'
import {
  type AssistantSource,
  hitsToReplyMarkdown,
  hitsToSources,
  type AnythingLlmSource,
} from '../_shared/format_hits.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
}

type Source = 'text' | 'narrated' | 'both'

function workspacesFor(source: Source): AssistantSource[] {
  if (source === 'text') return ['text']
  if (source === 'narrated') return ['narrated']
  return ['text', 'narrated']
}

async function runSearch(
  supabase: SupabaseClient,
  query: string,
  source: Source,
  matchCount: number,
  filterVolume: number | null,
): Promise<
  Array<{ source: AssistantSource; reply: string; sources: AnythingLlmSource[] | null }>
> {
  const queryEmbedding = await embedQuery(query)
  const workspaces = workspacesFor(source)
  const out: Array<{
    source: AssistantSource
    reply: string
    sources: AnythingLlmSource[] | null
  }> = []
  for (const ws of workspaces) {
    const hits = await searchDocumentChunks(
      supabase,
      queryEmbedding,
      ws,
      matchCount,
      filterVolume,
    )
    out.push({
      source: ws,
      reply: hitsToReplyMarkdown(hits, ws, query.trim()),
      sources: hitsToSources(hits),
    })
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: jsonHeaders,
    })
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: jsonHeaders,
      })
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { data: userData, error: userError } = await supabase.auth.getUser(token)
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: jsonHeaders,
      })
    }

    let body: {
      query?: unknown
      source?: unknown
      match_count?: unknown
      filter_volume?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: jsonHeaders,
      })
    }

    const q = body.query
    if (typeof q !== 'string' || !q.trim()) {
      return new Response(JSON.stringify({ error: 'Missing query field' }), {
        status: 400,
        headers: jsonHeaders,
      })
    }

    const s = body.source
    if (s !== 'text' && s !== 'narrated' && s !== 'both') {
      return new Response(
        JSON.stringify({ error: "Invalid source (expected 'text', 'narrated', or 'both')" }),
        { status: 400, headers: jsonHeaders },
      )
    }

    let matchCount = 12
    if (typeof body.match_count === 'number' && Number.isFinite(body.match_count)) {
      matchCount = Math.max(1, Math.min(50, Math.floor(body.match_count)))
    }

    let filterVolume: number | null = null
    if (typeof body.filter_volume === 'number' && Number.isFinite(body.filter_volume)) {
      filterVolume = Math.floor(body.filter_volume)
    }

    const replies = await runSearch(supabase, q.trim(), s, matchCount, filterVolume)
    return new Response(JSON.stringify({ replies }), { status: 200, headers: jsonHeaders })
  } catch (err) {
    console.error('semantic-search error', err)
    const msg = err instanceof Error ? err.message : 'Internal error'
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: jsonHeaders })
  }
})
