import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

declare const EdgeRuntime: {
  waitUntil(promise: PromiseLike<unknown>): void
}

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
type AssistantSource = 'text' | 'narrated'

function workspaceSlugFor(source: AssistantSource): string {
  if (source === 'text') return Deno.env.get('ANYTHINGLLM_WORKSPACE_TEXT')!
  return Deno.env.get('ANYTHINGLLM_WORKSPACE_NARRATED')!
}

export interface AnythingLlmSource {
  title?: string
  chunkSource?: string
  text?: string
  score?: number
  _distance?: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

async function anythingLlmChat(
  message: string,
  workspaceSlug: string,
  options?: { sessionId?: string; mode?: 'chat' | 'query' },
): Promise<{
  text: string
  error: string | null
  sources: AnythingLlmSource[] | null
}> {
  const anythingLlmUrl = Deno.env.get('ANYTHINGLLM_URL')!
  const anythingLlmKey = Deno.env.get('ANYTHINGLLM_KEY')!
  const mode = options?.mode ?? 'query'
  const body: Record<string, unknown> = { message, mode }
  if (options?.sessionId) body.sessionId = options.sessionId

  const response = await fetch(
    `${anythingLlmUrl}/api/v1/workspace/${workspaceSlug}/stream-chat`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${anythingLlmKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok || !response.body) {
    const errText = response.body ? await response.text() : '(no body)'
    console.error('AnythingLLM request failed', response.status, errText)
    throw new Error(`AnythingLLM responded with ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let llmError: string | null = null
  let sources: AnythingLlmSource[] | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sepIndex: number
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sepIndex)
      buffer = buffer.slice(sepIndex + 2)

      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const jsonStr = line.slice(5).trim()
        if (!jsonStr) continue
        try {
          const chunk = JSON.parse(jsonStr) as {
            textResponse?: unknown
            error?: unknown
            close?: boolean
            sources?: unknown
          }
          if (typeof chunk.textResponse === 'string') {
            fullText += chunk.textResponse
          }
          if (typeof chunk.error === 'string' && chunk.error.trim().length > 0) {
            llmError = chunk.error
          }
          if (Array.isArray(chunk.sources) && chunk.sources.length > 0) {
            sources = chunk.sources as AnythingLlmSource[]
          }
        } catch (parseErr) {
          console.warn('Failed to parse SSE chunk', jsonStr, parseErr)
        }
      }
    }
  }

  return { text: fullText, error: llmError, sources }
}

function normalizeTitle(raw: string): string | null {
  let t = raw
    .replace(/\[Book of Heaven[^\]]*\]/gi, '')
    .replace(/\[Volume[^\]]*\]/gi, '')
    .replace(/^\s*title\s*[:\-]\s*/i, '')
    .replace(/[*_`]/g, '')
    .trim()

  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (!firstLine) return null
  t = firstLine

  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  t = t.replace(/[.!?,;:]+$/g, '').trim()
  t = t.replace(/\s+/g, ' ')

  if (t.length < 2) return null
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').trim() + '…'
  return t
}

async function generateThreadTitle(
  userMessage: string,
  threadId: string,
): Promise<string | null> {
  const prompt =
    'Generate a 3 to 6 word title that describes the topic of the user request below. ' +
    'The title is shown in a chat history sidebar, so it must be concise and readable. ' +
    'Output ONLY the title itself — no quotes, no trailing punctuation, no citations, ' +
    'no "Title:" prefix, no explanation, no markdown.\n\n' +
    `User request: ${userMessage}`

  try {
    const { text, error } = await anythingLlmChat(
      prompt,
      workspaceSlugFor('narrated'),
      {
        sessionId: `book-of-heaven-title-${threadId}`,
        mode: 'chat',
      },
    )
    if (error || !text.trim()) {
      console.warn('Title generation returned no usable text', { error })
      return null
    }
    return normalizeTitle(text)
  } catch (err) {
    console.warn('Title generation failed (non-fatal)', err)
    return null
  }
}

function workspacesFor(source: Source): AssistantSource[] {
  if (source === 'text') return ['text']
  if (source === 'narrated') return ['narrated']
  return ['text', 'narrated']
}

function pickReplyText(
  result: { text: string; error: string | null },
  workspaceSlug: string,
): string {
  if (result.text.trim().length > 0) return result.text
  if (result.error) return `AnythingLLM error: ${result.error}`
  return (
    'The assistant returned no text. Check the AnythingLLM desktop app: workspace "' +
    workspaceSlug +
    '" must have documents embedded and an LLM configured.'
  )
}

type JobResult = {
  thread_id: string
  turn_id: string
  title: string | null
  replies: Array<{
    source: AssistantSource
    reply: string
    sources: AnythingLlmSource[] | null
  }>
}

async function runChatTurn(
  supabase: SupabaseClient,
  ctx: {
    userId: string
    jobId: string
    message: string
    threadId: string
    turnId: string
    source: Source
    incomingProjectId: string | null
  },
): Promise<void> {
  const { userId, jobId, message, threadId, turnId, source, incomingProjectId } = ctx
  const nowIso = new Date().toISOString()
  const { error: markProcErr } = await supabase
    .from('chat_turn_jobs')
    .update({ status: 'processing', updated_at: nowIso })
    .eq('id', jobId)
    .eq('user_id', userId)
  if (markProcErr) {
    console.error('Failed to mark job processing', markProcErr)
  }

  try {
    const upsertPayload: Record<string, unknown> = {
      thread_id: threadId,
      user_id: userId,
    }
    if (incomingProjectId) upsertPayload.project_id = incomingProjectId
    const { error: ensureThreadError } = await supabase
      .from('chat_threads')
      .upsert(upsertPayload, { onConflict: 'thread_id', ignoreDuplicates: true })
    if (ensureThreadError) {
      console.warn('Failed to upsert chat_threads row', ensureThreadError)
    }

    const { data: threadRow, error: threadLookupError } = await supabase
      .from('chat_threads')
      .select('title, project_id')
      .eq('thread_id', threadId)
      .eq('user_id', userId)
      .maybeSingle()
    if (threadLookupError) {
      console.warn('chat_threads lookup failed; skipping title gen', threadLookupError)
    }
    const needsTitle = !threadRow?.title
    const threadProjectId: string | null = threadRow?.project_id ?? null

    let projectInstructions: string | null = null
    if (threadProjectId) {
      const { data: projectRow, error: projectLookupError } = await supabase
        .from('chat_projects')
        .select('instructions')
        .eq('id', threadProjectId)
        .eq('user_id', userId)
        .maybeSingle()
      if (projectLookupError) {
        console.warn('chat_projects lookup failed; skipping instructions', projectLookupError)
      }
      const raw = projectRow?.instructions
      if (typeof raw === 'string' && raw.trim().length > 0) {
        projectInstructions = raw.trim()
      }
    }

    let titleSeed = message
    if (needsTitle) {
      const { data: earliestRows } = await supabase
        .from('chat_messages')
        .select('content, created_at')
        .eq('user_id', userId)
        .eq('thread_id', threadId)
        .eq('role', 'user')
        .order('created_at', { ascending: true })
        .limit(1)
      const earliest = earliestRows?.[0]?.content
      if (typeof earliest === 'string' && earliest.trim().length > 0) {
        titleSeed = earliest
      }
    }

    const composedMessage = projectInstructions
      ? `You are acting inside a user's project. Follow these project-level instructions for the rest of this conversation:\n\n---\n${projectInstructions}\n---\n\nUser message:\n${message}`
      : message

    const workspaces = workspacesFor(source)
    const mainResultsPromise = Promise.all(
      workspaces.map(async (ws) => {
        const slug = workspaceSlugFor(ws)
        const result = await anythingLlmChat(composedMessage, slug, {
          sessionId: threadId,
          mode: 'query',
        })
        return { ws, slug, result }
      }),
    )

    const [mainResults, title] = await Promise.all([
      mainResultsPromise,
      needsTitle ? generateThreadTitle(titleSeed, threadId) : Promise.resolve(null),
    ])

    const assistantRows = mainResults.map(({ ws, slug, result }) => {
      const reply = pickReplyText(result, slug)
      const sourcesForDb =
        result.sources && result.sources.length > 0 ? result.sources : null
      return {
        row: {
          user_id: userId,
          role: 'assistant' as const,
          content: reply,
          thread_id: threadId,
          turn_id: turnId,
          source: ws,
          sources: sourcesForDb,
        },
        reply,
        ws,
        sources: sourcesForDb,
      }
    })

    const { error: insertAssistantError } = await supabase
      .from('chat_messages')
      .insert(assistantRows.map((r) => r.row))
    if (insertAssistantError) {
      console.error('Failed to insert assistant messages', insertAssistantError)
      throw insertAssistantError
    }

    if (needsTitle && title) {
      const { error: updateTitleError } = await supabase
        .from('chat_threads')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('thread_id', threadId)
        .eq('user_id', userId)
        .is('title', null)
      if (updateTitleError) {
        console.warn('Failed to update chat_threads title', updateTitleError)
      }
    }

    const resultPayload: JobResult = {
      thread_id: threadId,
      turn_id: turnId,
      title: title ?? null,
      replies: assistantRows.map((r) => ({
        source: r.ws,
        reply: r.reply,
        sources: r.sources,
      })),
    }

    const { error: completeErr } = await supabase
      .from('chat_turn_jobs')
      .update({
        status: 'complete',
        result: resultPayload,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('user_id', userId)
    if (completeErr) {
      console.error('Failed to mark job complete', completeErr)
    }
  } catch (err) {
    console.error('runChatTurn failed', err)
    const msg = err instanceof Error ? err.message : 'Internal error'
    const { error: failJobErr } = await supabase
      .from('chat_turn_jobs')
      .update({
        status: 'error',
        error_message: msg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('user_id', userId)
    if (failJobErr) {
      console.error('Failed to mark job error', failJobErr)
    }
    const errSource: AssistantSource = workspacesFor(ctx.source)[0] ?? 'text'
    const { error: failBubbleErr } = await supabase
      .from('chat_messages')
      .insert({
        user_id: userId,
        role: 'assistant',
        content: 'The assistant could not finish this turn. ' + msg,
        thread_id: threadId,
        turn_id: turnId,
        source: errSource,
        sources: null,
      })
    if (failBubbleErr) {
      console.warn('Failed to insert error assistant message', failBubbleErr)
    }
  }
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

    let body: {
      message?: unknown
      thread_id?: unknown
      project_id?: unknown
      source?: unknown
      turn_id?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: jsonHeaders },
      )
    }

    const message = body?.message
    if (typeof message !== 'string' || message.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: 'Missing message field' }),
        { status: 400, headers: jsonHeaders },
      )
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
    if (
      sourceRaw !== 'text' &&
      sourceRaw !== 'narrated' &&
      sourceRaw !== 'both'
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing or invalid source (expected 'text', 'narrated', or 'both')",
        }),
        { status: 400, headers: jsonHeaders },
      )
    }
    const source: Source = sourceRaw

    const projectIdRaw = body?.project_id
    let incomingProjectId: string | null = null
    if (projectIdRaw != null) {
      if (typeof projectIdRaw !== 'string' || !uuidPattern.test(projectIdRaw)) {
        return new Response(
          JSON.stringify({ error: 'Invalid project_id (expected UUID or null)' }),
          { status: 400, headers: jsonHeaders },
        )
      }
      incomingProjectId = projectIdRaw
    }

    const { data: existingJob, error: jobLookupErr } = await supabase
      .from('chat_turn_jobs')
      .select('id, status, result, error_message')
      .eq('user_id', user.id)
      .eq('turn_id', turnId)
      .maybeSingle()
    if (jobLookupErr) {
      console.error('chat_turn_jobs lookup', jobLookupErr)
    }

    if (existingJob) {
      if (existingJob.status === 'complete' && existingJob.result) {
        return new Response(
          JSON.stringify({
            ...existingJob.result as JobResult,
            job_id: existingJob.id,
          }),
          { status: 200, headers: jsonHeaders },
        )
      }
      if (existingJob.status === 'pending' || existingJob.status === 'processing') {
        return new Response(
          JSON.stringify({
            job_id: existingJob.id,
            thread_id: threadId,
            turn_id: turnId,
            title: null,
            status: 'accepted',
          }),
          { status: 202, headers: jsonHeaders },
        )
      }
      if (existingJob.status === 'error') {
        return new Response(
          JSON.stringify({
            error: existingJob.error_message ?? 'This turn failed. Start a new message to retry.',
            job_id: existingJob.id,
          }),
          { status: 409, headers: jsonHeaders },
        )
      }
    }

    const { error: insertUserError } = await supabase
      .from('chat_messages')
      .insert({
        user_id: user.id,
        role: 'user',
        content: message,
        thread_id: threadId,
        turn_id: turnId,
        source,
      })

    if (insertUserError) {
      if (insertUserError.code === '23505') {
        const { data: afterRace } = await supabase
          .from('chat_turn_jobs')
          .select('id, status, result')
          .eq('user_id', user.id)
          .eq('turn_id', turnId)
          .maybeSingle()
        if (afterRace?.status === 'complete' && afterRace.result) {
          return new Response(
            JSON.stringify({ ...afterRace.result as JobResult, job_id: afterRace.id }),
            { status: 200, headers: jsonHeaders },
          )
        }
        if (afterRace?.id) {
          return new Response(
            JSON.stringify({
              job_id: afterRace.id,
              thread_id: threadId,
              turn_id: turnId,
              title: null,
              status: 'accepted',
            }),
            { status: 202, headers: jsonHeaders },
          )
        }
      }
      console.error('Failed to insert user message', insertUserError)
      return new Response(
        JSON.stringify({ error: 'Failed to record your message' }),
        { status: 500, headers: jsonHeaders },
      )
    }

    const upsertPayload2: Record<string, unknown> = {
      thread_id: threadId,
      user_id: user.id,
    }
    if (incomingProjectId) upsertPayload2.project_id = incomingProjectId
    const { error: ensureThreadError } = await supabase
      .from('chat_threads')
      .upsert(upsertPayload2, { onConflict: 'thread_id', ignoreDuplicates: true })
    if (ensureThreadError) {
      console.warn('Failed to upsert chat_threads row', ensureThreadError)
    }

    const { data: threadRowPj, error: threadPjErr } = await supabase
      .from('chat_threads')
      .select('project_id')
      .eq('thread_id', threadId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (threadPjErr) {
      console.warn('chat_threads project lookup for job row', threadPjErr)
    }
    const jobProjectId: string | null = threadRowPj?.project_id ?? null

    const { data: newJob, error: insertJobError } = await supabase
      .from('chat_turn_jobs')
      .insert({
        user_id: user.id,
        thread_id: threadId,
        turn_id: turnId,
        source,
        project_id: jobProjectId,
        status: 'pending',
      })
      .select('id')
      .single()

    if (insertJobError) {
      if (insertJobError.code === '23505') {
        const { data: j2 } = await supabase
          .from('chat_turn_jobs')
          .select('id, status, result, error_message')
          .eq('user_id', user.id)
          .eq('turn_id', turnId)
          .maybeSingle()
        if (j2?.status === 'complete' && j2.result) {
          return new Response(
            JSON.stringify({ ...j2.result as JobResult, job_id: j2.id }),
            { status: 200, headers: jsonHeaders },
          )
        }
        if (j2?.id) {
          return new Response(
            JSON.stringify({
              job_id: j2.id,
              thread_id: threadId,
              turn_id: turnId,
              title: null,
              status: 'accepted',
            }),
            { status: 202, headers: jsonHeaders },
          )
        }
      }
      console.error('Failed to insert job', insertJobError)
      return new Response(
        JSON.stringify({ error: 'Failed to start assistant turn' }),
        { status: 500, headers: jsonHeaders },
      )
    }

    const jobId = newJob.id
    EdgeRuntime.waitUntil(
      runChatTurn(supabase, {
        userId: user.id,
        jobId,
        message,
        threadId,
        turnId,
        source,
        incomingProjectId,
      }),
    )

    return new Response(
      JSON.stringify({
        job_id: jobId,
        thread_id: threadId,
        turn_id: turnId,
        title: null,
        status: 'accepted',
      }),
      { status: 202, headers: jsonHeaders },
    )
  } catch (err) {
    console.error('chat-proxy error', err)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: jsonHeaders },
    )
  }
})
