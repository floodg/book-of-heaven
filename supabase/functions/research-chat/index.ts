import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Source = 'text' | 'narrated' | 'both'

type ResearchModel =
  | 'workspace-default'
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'gpt-4o-mini'
  | 'gemini-2.0-flash'
  | 'llama-3-3-70b'

const ALLOWED_RESEARCH_MODELS = new Set<ResearchModel>([
  'workspace-default',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'llama-3-3-70b',
])

function isResearchModel(v: unknown): v is ResearchModel {
  return typeof v === 'string' && ALLOWED_RESEARCH_MODELS.has(v as ResearchModel)
}

function modelProvider(model: string): 'anthropic' | 'openai' | 'google' | 'groq' {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-')) return 'openai'
  if (model.startsWith('gemini-')) return 'google'
  return 'groq'
}

export interface Citation {
  documentId: string
  chunkId: string
  title: string
  sourceType: string
  fileName?: string | null
  sourceUrl?: string | null
  pageNumber?: number | null
  timestampStart?: string | null
  timestampEnd?: string | null
  heading?: string | null
  excerpt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS / JSON headers
// ─────────────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI embeddings
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMS = 1536
const RETRIEVAL_TOP_K = 20

async function embedQuery(text: string): Promise<number[]> {
  const openaiKey = Deno.env.get('OPENAI_API_KEY')!
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMS,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI embed failed (${res.status}): ${body}`)
  }
  const json = await res.json()
  return json.data[0].embedding as number[]
}

// ─────────────────────────────────────────────────────────────────────────────
// pgvector retrieval
// ─────────────────────────────────────────────────────────────────────────────

interface RetrievedChunk {
  chunkId: string
  documentId: string
  content: string
  heading: string | null
  pageNumber: number | null
  timestampStart: string | null
  timestampEnd: string | null
  documentTitle: string
  sourceType: string
  fileName: string | null
  sourceUrl: string | null
  similarity: number
}

async function retrieveChunks(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string,
  queryEmbedding: number[],
  topK: number = RETRIEVAL_TOP_K,
  volumeNum: number | null = null,
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase.rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    workspace_id_filter: workspaceId,
    match_count: topK,
    volume_num: volumeNum,
  })

  if (error) throw new Error(`pgvector search failed: ${error.message}`)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    chunkId: row.chunk_id as string,
    documentId: row.document_id as string,
    content: row.content as string,
    heading: (row.heading as string | null) ?? null,
    pageNumber: (row.page_number as number | null) ?? null,
    timestampStart: (row.timestamp_start as string | null) ?? null,
    timestampEnd: (row.timestamp_end as string | null) ?? null,
    documentTitle: row.document_title as string,
    sourceType: row.source_type as string,
    fileName: (row.file_name as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    similarity: row.similarity as number,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Context + citation assembly
// ─────────────────────────────────────────────────────────────────────────────

function buildContextBlock(chunks: RetrievedChunk[]): {
  context: string
  citations: Citation[]
} {
  const citations: Citation[] = []
  const contextParts: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    const ref = `[${i + 1}]`
    let location = ''
    if (c.timestampStart) location = ` (${c.timestampStart}–${c.timestampEnd ?? c.timestampStart})`
    else if (c.pageNumber) location = ` (p. ${c.pageNumber})`
    contextParts.push(
      `${ref} "${c.documentTitle}"${location}:\n${c.content}`,
    )
    citations.push({
      documentId: c.documentId,
      chunkId: c.chunkId,
      title: c.documentTitle,
      sourceType: c.sourceType,
      fileName: c.fileName,
      sourceUrl: c.sourceUrl,
      pageNumber: c.pageNumber,
      timestampStart: c.timestampStart,
      timestampEnd: c.timestampEnd,
      heading: c.heading,
      excerpt: c.content.slice(0, 300),
    })
  }

  const context = contextParts.join('\n\n---\n\n')
  return { context, citations }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM provider calls
// ─────────────────────────────────────────────────────────────────────────────

interface LlmResult {
  text: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  provider: string
}

async function callLlm(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<LlmResult> {
  const provider = modelProvider(model)

  if (provider === 'anthropic') {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')!
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Anthropic API failed (${res.status}): ${body}`)
    }
    const json = await res.json()
    const text = json.content?.[0]?.text ?? ''
    const inp = json.usage?.input_tokens ?? 0
    const out = json.usage?.output_tokens ?? 0
    // Approximate cost: haiku=$0.80/$4 per M tokens; sonnet=$3/$15 per M tokens
    const inRate = model.includes('haiku') ? 0.0000008 : 0.000003
    const outRate = model.includes('haiku') ? 0.000004 : 0.000015
    return {
      text,
      inputTokens: inp,
      outputTokens: out,
      estimatedCost: inp * inRate + out * outRate,
      provider: 'anthropic',
    }
  }

  if (provider === 'openai') {
    const apiKey = Deno.env.get('OPENAI_API_KEY')!
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI API failed (${res.status}): ${body}`)
    }
    const json = await res.json()
    const text = json.choices?.[0]?.message?.content ?? ''
    const inp = json.usage?.prompt_tokens ?? 0
    const out = json.usage?.completion_tokens ?? 0
    // gpt-4o-mini: $0.15/$0.60 per M tokens
    return {
      text,
      inputTokens: inp,
      outputTokens: out,
      estimatedCost: inp * 0.00000015 + out * 0.0000006,
      provider: 'openai',
    }
  }

  if (provider === 'google') {
    const apiKey = Deno.env.get('GEMINI_API_KEY')!
    const geminiModel = model // e.g. 'gemini-2.0-flash'
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 2048 },
        }),
      },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Gemini API failed (${res.status}): ${body}`)
    }
    const json = await res.json()
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const inp = json.usageMetadata?.promptTokenCount ?? 0
    const out = json.usageMetadata?.candidatesTokenCount ?? 0
    // gemini-2.0-flash: $0.075/$0.30 per M tokens
    return {
      text,
      inputTokens: inp,
      outputTokens: out,
      estimatedCost: inp * 0.000000075 + out * 0.0000003,
      provider: 'google',
    }
  }

  // Groq (Llama)
  const apiKey = Deno.env.get('GROQ_API_KEY')!
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Groq API failed (${res.status}): ${body}`)
  }
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  const inp = json.usage?.prompt_tokens ?? 0
  const out = json.usage?.completion_tokens ?? 0
  // Groq is free-tier/low cost; approximate at $0
  return { text, inputTokens: inp, outputTokens: out, estimatedCost: 0, provider: 'groq' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Title generation
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTitle(raw: string): string | null {
  let t = raw.trim()
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (!firstLine) return null
  t = firstLine
  t = t.replace(/^["'""'']+|["'""'']+$/g, '').trim()
  t = t.replace(/[.!?,;:]+$/g, '').trim()
  t = t.replace(/\s+/g, ' ')
  if (t.length < 2) return null
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').trim() + '…'
  return t
}

async function generateTitle(userMessage: string, model: string): Promise<string | null> {
  const prompt =
    'Generate a 3 to 6 word title that describes the topic of the user request below. ' +
    'The title is shown in a chat history sidebar so it must be concise and readable. ' +
    'Output ONLY the title — no quotes, no punctuation, no explanation, no markdown.\n\n' +
    `User request: ${userMessage}`
  try {
    const result = await callLlm(
      model.startsWith('claude-') ? 'claude-haiku-4-5'
        : model.startsWith('gpt-') ? 'gpt-4o-mini'
        : model.startsWith('gemini-') ? 'gemini-2.0-flash'
        : 'llama-3-3-70b',
      'You are a concise title generator.',
      prompt,
    )
    return normalizeTitle(result.text)
  } catch (err) {
    console.warn('Title generation failed (non-fatal)', err)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

const FREE_DAILY_LIMIT = 20

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ allowed: boolean; count: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabase
    .from('research_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('role', 'user')
    .gte('created_at', since)

  if (error) {
    // On error, allow the request to avoid false-blocking users
    console.warn('Rate limit check failed (allowing):', error.message)
    return { allowed: true, count: 0 }
  }

  const currentCount = count ?? 0
  return { allowed: currentCount < FREE_DAILY_LIMIT, count: currentCount }
}

// ─────────────────────────────────────────────────────────────────────────────
// One RAG turn for a single workspace
// ─────────────────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string
  slug: string
  system_prompt: string | null
  default_model: string
}

async function runRagTurn(
  supabase: ReturnType<typeof createClient>,
  workspace: WorkspaceRow,
  userMessage: string,
  queryEmbedding: number[],
  effectiveModel: string,
  volumeNum: number | null = null,
): Promise<{
  reply: string
  citations: Citation[]
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  provider: string
}> {
  // 1. Retrieve relevant chunks
  const chunks = await retrieveChunks(supabase, workspace.id, queryEmbedding, RETRIEVAL_TOP_K, volumeNum)

  if (chunks.length === 0) {
    return {
      reply: 'I could not find relevant passages in the corpus for your question. Try rephrasing or broadening your search.',
      citations: [],
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      provider: modelProvider(effectiveModel),
    }
  }

  // 2. Build context block
  const { context, citations } = buildContextBlock(chunks)

  // 3. Compose prompt
  const baseSystemPrompt = workspace.system_prompt ??
    'You are a knowledgeable research assistant helping users study the Book of Heaven, the spiritual diary of Luisa Piccarreta. ' +
    'Synthesize the provided passages into a clear, thoughtful, well-organized response. ' +
    'Write in natural flowing prose. You may note specific sources where helpful, but do not mechanically cite every sentence. ' +
    'If the passages do not contain enough information to answer fully, say so honestly.'

  const fullUserMessage =
    `Here are the most relevant passages for the question below:\n\n${context}\n\n---\n\nQuestion: ${userMessage}\n\nWrite a clear, thoughtful answer that synthesizes the passages above. Cite specific passages naturally where they add value, but focus on giving a coherent, readable response rather than a mechanical list of citations.`

  // 4. Call LLM
  const llmResult = await callLlm(effectiveModel, baseSystemPrompt, fullUserMessage)

  return {
    reply: llmResult.text,
    citations,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    estimatedCost: llmResult.estimatedCost,
    provider: llmResult.provider,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

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
    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: jsonHeaders },
      )
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { data: userData, error: userError } = await supabase.auth.getUser(token)
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: jsonHeaders },
      )
    }
    const user = userData.user

    // ── Parse request body ────────────────────────────────────────────────────
    let body: {
      message?: unknown
      thread_id?: unknown
      turn_id?: unknown
      source?: unknown
      model?: unknown
      volume_filter?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: jsonHeaders,
      })
    }

    const message = body?.message
    if (typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Missing message field' }), {
        status: 400,
        headers: jsonHeaders,
      })
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    const threadIdRaw = body?.thread_id
    if (typeof threadIdRaw !== 'string' || !uuidPattern.test(threadIdRaw)) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid thread_id (expected UUID)' }),
        { status: 400, headers: jsonHeaders },
      )
    }
    const threadId = threadIdRaw

    const turnIdRaw = body?.turn_id
    if (typeof turnIdRaw !== 'string' || !uuidPattern.test(turnIdRaw)) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid turn_id (expected UUID)' }),
        { status: 400, headers: jsonHeaders },
      )
    }
    const turnId = turnIdRaw

    const sourceRaw = body?.source
    if (sourceRaw !== 'text' && sourceRaw !== 'narrated' && sourceRaw !== 'both') {
      return new Response(
        JSON.stringify({ error: "Missing or invalid source (expected 'text', 'narrated', or 'both')" }),
        { status: 400, headers: jsonHeaders },
      )
    }
    const source: Source = sourceRaw

    const modelRaw = body?.model
    const requestedModel: ResearchModel = isResearchModel(modelRaw) ? modelRaw : 'workspace-default'

    // Optional volume filter — integer 1-99 or null for "all volumes"
    const volumeFilterRaw = body?.volume_filter
    const volumeNum: number | null =
      typeof volumeFilterRaw === 'number' && Number.isInteger(volumeFilterRaw) && volumeFilterRaw >= 1
        ? volumeFilterRaw
        : null

    // ── Rate limit ────────────────────────────────────────────────────────────
    // Check if user has admin app_metadata to bypass limits
    const isAdmin =
      typeof user.app_metadata?.role === 'string' &&
      user.app_metadata.role === 'admin'

    if (!isAdmin) {
      const { allowed, count } = await checkRateLimit(supabase, user.id)
      if (!allowed) {
        return new Response(
          JSON.stringify({
            error: `Daily research limit reached (${FREE_DAILY_LIMIT} questions per 24 hours). Come back tomorrow or contact us for a higher limit.`,
            count,
            limit: FREE_DAILY_LIMIT,
          }),
          { status: 429, headers: jsonHeaders },
        )
      }
    }

    // ── Resolve workspaces ────────────────────────────────────────────────────
    const workspaceSlugs: string[] =
      source === 'both' ? ['narrated', 'text'] : [source]

    const { data: workspaces, error: wsErr } = await supabase
      .from('research_workspaces')
      .select('id, slug, system_prompt, default_model')
      .in('slug', workspaceSlugs)

    if (wsErr || !workspaces || workspaces.length === 0) {
      console.error('Workspace lookup failed', wsErr)
      return new Response(
        JSON.stringify({ error: 'Research workspace configuration error' }),
        { status: 500, headers: jsonHeaders },
      )
    }

    // ── Upsert research thread ────────────────────────────────────────────────
    const primaryWorkspace = workspaces.find((w) => w.slug === (source === 'both' ? 'narrated' : source))
      ?? workspaces[0]

    const effectiveModel =
      requestedModel === 'workspace-default'
        ? (primaryWorkspace.default_model === 'workspace-default'
            ? (Deno.env.get('DEFAULT_RESEARCH_MODEL') ?? 'claude-haiku-4-5')
            : primaryWorkspace.default_model)
        : requestedModel

    const { error: threadErr } = await supabase
      .from('research_threads')
      .upsert(
        { id: threadId, user_id: user.id, workspace_id: primaryWorkspace.id, selected_model: effectiveModel },
        { onConflict: 'id', ignoreDuplicates: true },
      )
    if (threadErr) {
      console.warn('Failed to upsert research_threads', threadErr)
    }

    // ── Check for title ────────────────────────────────────────────────────────
    const { data: threadRow } = await supabase
      .from('research_threads')
      .select('title')
      .eq('id', threadId)
      .eq('user_id', user.id)
      .maybeSingle()
    const needsTitle = !threadRow?.title

    // ── Insert user message ────────────────────────────────────────────────────
    const { error: userMsgErr } = await supabase
      .from('research_messages')
      .insert({
        thread_id: threadId,
        user_id: user.id,
        role: 'user',
        content: message,
        turn_id: turnId,
        source,
      })
    if (userMsgErr) {
      // Idempotency: duplicate turn_id for a user row means this was already processed
      if (userMsgErr.code === '23505') {
        console.warn('Duplicate turn, returning early')
        return new Response(
          JSON.stringify({ error: 'This turn was already submitted.' }),
          { status: 409, headers: jsonHeaders },
        )
      }
      console.error('Failed to insert user message', userMsgErr)
      return new Response(
        JSON.stringify({ error: 'Failed to record your message' }),
        { status: 500, headers: jsonHeaders },
      )
    }

    // ── Embed query ────────────────────────────────────────────────────────────
    const queryEmbedding = await embedQuery(message)

    // ── RAG turns (parallel for 'both') ───────────────────────────────────────
    const turnPromises = workspaces.map((ws) =>
      runRagTurn(supabase, ws, message, queryEmbedding, effectiveModel, volumeNum)
        .then((result) => ({ ws, result }))
        .catch((err) => ({
          ws,
          result: {
            reply: `Research assistant error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            citations: [] as Citation[],
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
            provider: modelProvider(effectiveModel),
          },
        })),
    )

    const titlePromise = needsTitle
      ? generateTitle(message, effectiveModel)
      : Promise.resolve(null)

    const [turnResults, title] = await Promise.all([
      Promise.all(turnPromises),
      titlePromise,
    ])

    // ── Persist assistant messages ─────────────────────────────────────────────
    const assistantRows = turnResults.map(({ ws, result }) => ({
      thread_id: threadId,
      user_id: user.id,
      role: 'assistant' as const,
      content: result.reply,
      turn_id: turnId,
      source: ws.slug as 'text' | 'narrated',
      model: effectiveModel,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      estimated_cost: result.estimatedCost,
      citations: result.citations,
    }))

    const { error: assistantErr } = await supabase
      .from('research_messages')
      .insert(assistantRows)
    if (assistantErr) {
      console.error('Failed to insert assistant messages', assistantErr)
    }

    // ── Persist usage ──────────────────────────────────────────────────────────
    const usageRows = turnResults
      .map(({ result }) => ({
        user_id: user.id,
        thread_id: threadId,
        provider: result.provider,
        model: effectiveModel,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        estimated_cost: result.estimatedCost,
      }))
      .filter((r) => r.input_tokens > 0 || r.output_tokens > 0)

    if (usageRows.length > 0) {
      const { error: usageErr } = await supabase.from('model_usage').insert(usageRows)
      if (usageErr) console.warn('Failed to insert model_usage', usageErr)
    }

    // ── Update thread title ────────────────────────────────────────────────────
    if (needsTitle && title) {
      const { error: titleErr } = await supabase
        .from('research_threads')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', threadId)
        .eq('user_id', user.id)
        .is('title', null)
      if (titleErr) console.warn('Failed to update research thread title', titleErr)
    }

    // ── Response ───────────────────────────────────────────────────────────────
    const replies = turnResults.map(({ ws, result }) => ({
      source: ws.slug as 'text' | 'narrated',
      reply: result.reply,
      citations: result.citations,
      // Include sources as null for backwards compat with ChatWindow's applyJobPayload
      sources: null,
    }))

    return new Response(
      JSON.stringify({
        thread_id: threadId,
        turn_id: turnId,
        title: title ?? null,
        replies,
        model: effectiveModel,
      }),
      { status: 200, headers: jsonHeaders },
    )
  } catch (err) {
    console.error('research-chat unhandled error', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: jsonHeaders },
    )
  }
})
