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

    let body: { message?: unknown; thread_id?: unknown }
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

    const threadIdRaw = body?.thread_id
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (typeof threadIdRaw !== 'string' || !uuidPattern.test(threadIdRaw)) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid thread_id (expected UUID)' }),
        { status: 400, headers: jsonHeaders },
      )
    }
    const threadId = threadIdRaw

    const { error: insertUserError } = await supabase
      .from('chat_messages')
      .insert({ user_id: user.id, role: 'user', content: message, thread_id: threadId })
    if (insertUserError) {
      console.error('Failed to insert user message', insertUserError)
      throw insertUserError
    }

    const anythingLlmUrl = Deno.env.get('ANYTHINGLLM_URL')!
    const anythingLlmKey = Deno.env.get('ANYTHINGLLM_KEY')!
    const anythingLlmWorkspace = Deno.env.get('ANYTHINGLLM_WORKSPACE')!

    // AnythingLLM's non-streaming /chat endpoint returns an empty textResponse
    // for this workspace configuration, while /stream-chat works. We call the
    // streaming endpoint, aggregate the SSE chunks server-side, and return a
    // single JSON payload so the public contract stays non-streaming (per SPEC).
    const llmResponse = await fetch(
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

    if (!llmResponse.ok || !llmResponse.body) {
      const errText = llmResponse.body ? await llmResponse.text() : '(no body)'
      console.error('AnythingLLM request failed', llmResponse.status, errText)
      throw new Error(`AnythingLLM responded with ${llmResponse.status}`)
    }

    const reader = llmResponse.body.getReader()
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

    let reply: string
    if (fullText.trim().length > 0) {
      reply = fullText
    } else if (llmError) {
      reply = `AnythingLLM error: ${llmError}`
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

    return new Response(
      JSON.stringify({ reply, thread_id: threadId }),
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
