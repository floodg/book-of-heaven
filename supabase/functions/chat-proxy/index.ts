import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
}

// Call AnythingLLM's streaming chat endpoint and aggregate all chunks into a
// single string. Returns { text, error }: `error` is the AnythingLLM-reported
// error string if the stream sent one, otherwise null. Throws only on HTTP or
// transport failure (so callers can decide whether to surface the error or
// fall back silently).
async function anythingLlmChat(message: string): Promise<{
  text: string
  error: string | null
}> {
  const anythingLlmUrl = Deno.env.get('ANYTHINGLLM_URL')!
  const anythingLlmKey = Deno.env.get('ANYTHINGLLM_KEY')!
  const anythingLlmWorkspace = Deno.env.get('ANYTHINGLLM_WORKSPACE')!

  const response = await fetch(
    `${anythingLlmUrl}/api/v1/workspace/${anythingLlmWorkspace}/stream-chat`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${anythingLlmKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ message, mode: 'chat' }),
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
          }
          if (typeof chunk.textResponse === 'string') {
            fullText += chunk.textResponse
          }
          if (typeof chunk.error === 'string' && chunk.error.trim().length > 0) {
            llmError = chunk.error
          }
        } catch (parseErr) {
          console.warn('Failed to parse SSE chunk', jsonStr, parseErr)
        }
      }
    }
  }

  return { text: fullText, error: llmError }
}

// Clean up an LLM-generated title. The workspace system prompt pushes the
// model toward long, citation-heavy answers, so even with a tight instruction
// we defensively strip quotes, trailing punctuation, any leaked
// `[Book of Heaven ...]` citations, "Title:" prefixes, and surrounding
// markdown. Returns null if what's left isn't a usable title.
function normalizeTitle(raw: string): string | null {
  let t = raw
    .replace(/\[Book of Heaven[^\]]*\]/gi, '')
    .replace(/\[Volume[^\]]*\]/gi, '')
    .replace(/^\s*title\s*[:\-]\s*/i, '')
    .replace(/[*_`]/g, '')
    .trim()

  // Take only the first line in case the model volunteered an explanation.
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (!firstLine) return null
  t = firstLine

  // Strip wrapping quotes (both straight and curly).
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  // Trailing punctuation that hurts a sidebar label.
  t = t.replace(/[.!?,;:]+$/g, '').trim()
  t = t.replace(/\s+/g, ' ')

  if (t.length < 2) return null
  // Safety cap: the UI also truncates, but we don't want to persist a 200-char
  // paragraph if the model ignored the length hint.
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').trim() + '…'
  return t
}

async function generateThreadTitle(userMessage: string): Promise<string | null> {
  const prompt =
    'Generate a 3 to 6 word title that describes the topic of the user request below. ' +
    'The title is shown in a chat history sidebar, so it must be concise and readable. ' +
    'Output ONLY the title itself — no quotes, no trailing punctuation, no citations, ' +
    'no "Title:" prefix, no explanation, no markdown.\n\n' +
    `User request: ${userMessage}`

  try {
    const { text, error } = await anythingLlmChat(prompt)
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
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

    let body: { message?: unknown; thread_id?: unknown; project_id?: unknown }
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

    // project_id is optional. When present (only on the very first message of
    // a thread started from a project page) we stamp the thread's project_id
    // at upsert time. For later messages in that same thread we never trust
    // the client — we always re-read the project from chat_threads — so the
    // client can't sneak a message into a project it doesn't own.
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

    const { error: insertUserError } = await supabase
      .from('chat_messages')
      .insert({ user_id: user.id, role: 'user', content: message, thread_id: threadId })
    if (insertUserError) {
      console.error('Failed to insert user message', insertUserError)
      throw insertUserError
    }

    // Every thread gets a chat_threads row as soon as its first message lands,
    // even if title generation later fails. Projects reference chat_threads,
    // so we can't wait for a successful title before creating the row or the
    // UI can't assign the thread anywhere. The upsert with ignoreDuplicates
    // makes this a safe no-op when the row already exists — importantly,
    // that means a client passing project_id for an already-existing thread
    // can NOT move it to a different project via this endpoint; moving
    // threads between projects is a separate UI action on chat_threads.
    const upsertPayload: Record<string, unknown> = {
      thread_id: threadId,
      user_id: user.id,
    }
    if (incomingProjectId) upsertPayload.project_id = incomingProjectId
    const { error: ensureThreadError } = await supabase
      .from('chat_threads')
      .upsert(upsertPayload, { onConflict: 'thread_id', ignoreDuplicates: true })
    if (ensureThreadError) {
      console.warn('Failed to upsert chat_threads row', ensureThreadError)
    }

    // A thread needs a title when its chat_threads row exists but has no
    // title yet. This covers brand-new threads and older threads backfilled
    // by migration 004 (which inserted rows with NULL title). We also pull
    // the thread's project_id here so we can look up per-project instructions
    // to prepend to the message — server-side, never from the request body.
    const { data: threadRow, error: threadLookupError } = await supabase
      .from('chat_threads')
      .select('title, project_id')
      .eq('thread_id', threadId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (threadLookupError) {
      console.warn('chat_threads lookup failed; skipping title gen', threadLookupError)
    }
    const needsTitle = !threadRow?.title
    const threadProjectId: string | null = threadRow?.project_id ?? null

    // Pull per-project instructions (system prompt) if this thread lives in a
    // project that has them configured. Empty / whitespace-only instructions
    // are treated as absent so users can "clear" by deleting all text without
    // needing a separate action.
    let projectInstructions: string | null = null
    if (threadProjectId) {
      const { data: projectRow, error: projectLookupError } = await supabase
        .from('chat_projects')
        .select('instructions')
        .eq('id', threadProjectId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (projectLookupError) {
        console.warn('chat_projects lookup failed; skipping instructions', projectLookupError)
      }
      const raw = projectRow?.instructions
      if (typeof raw === 'string' && raw.trim().length > 0) {
        projectInstructions = raw.trim()
      }
    }

    // For a backfill case the user's first message in the thread isn't the one
    // we just inserted — it's the oldest row in chat_messages. Pull it so the
    // title reflects the actual topic rather than whatever follow-up they
    // happen to be asking right now.
    let titleSeed = message
    if (needsTitle) {
      const { data: earliestRows } = await supabase
        .from('chat_messages')
        .select('content, created_at')
        .eq('user_id', user.id)
        .eq('thread_id', threadId)
        .eq('role', 'user')
        .order('created_at', { ascending: true })
        .limit(1)
      const earliest = earliestRows?.[0]?.content
      if (typeof earliest === 'string' && earliest.trim().length > 0) {
        titleSeed = earliest
      }
    }

    // For project threads we prepend the project's instructions as an inline
    // system-style preamble on every turn. AnythingLLM's stream-chat endpoint
    // doesn't expose a per-request system prompt slot, so we bake it into the
    // `message` payload with clear delimiters. This does grow each request by
    // the length of the instructions — fine for the text-sized prompts Claude
    // users write, not fine if somebody pastes a whole book in there. The
    // title generation call deliberately skips the instructions: titles
    // should describe *the user's question*, not the project's framing.
    const composedMessage = projectInstructions
      ? `You are acting inside a user's project. Follow these project-level instructions for the rest of this conversation:\n\n---\n${projectInstructions}\n---\n\nUser message:\n${message}`
      : message

    // Run the main chat call and the (optional) title generation in parallel.
    // The title call is much smaller than the main response so it typically
    // finishes first and doesn't extend total latency.
    const [mainResult, title] = await Promise.all([
      anythingLlmChat(composedMessage),
      needsTitle ? generateThreadTitle(titleSeed) : Promise.resolve(null),
    ])

    let reply: string
    if (mainResult.text.trim().length > 0) {
      reply = mainResult.text
    } else if (mainResult.error) {
      reply = `AnythingLLM error: ${mainResult.error}`
    } else {
      reply =
        'The assistant returned no text. Check the AnythingLLM desktop app: workspace "' +
        (Deno.env.get('ANYTHINGLLM_WORKSPACE') ?? '') +
        '" must have documents embedded and an LLM configured.'
    }

    const { error: insertAssistantError } = await supabase
      .from('chat_messages')
      .insert({ user_id: user.id, role: 'assistant', content: reply, thread_id: threadId })
    if (insertAssistantError) {
      console.error('Failed to insert assistant message', insertAssistantError)
      throw insertAssistantError
    }

    if (needsTitle && title) {
      // Row already exists (we upserted it earlier); just set the title. The
      // `.is('title', null)` guard avoids clobbering a title written by a
      // concurrent request racing on the same thread.
      const { error: updateTitleError } = await supabase
        .from('chat_threads')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('thread_id', threadId)
        .eq('user_id', user.id)
        .is('title', null)
      if (updateTitleError) {
        console.warn('Failed to update chat_threads title', updateTitleError)
      }
    }

    return new Response(
      JSON.stringify({ reply, thread_id: threadId, title: title ?? null }),
      { status: 200, headers: jsonHeaders },
    )
  } catch (err) {
    console.error('chat-proxy error', err)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: jsonHeaders },
    )
  }
})
