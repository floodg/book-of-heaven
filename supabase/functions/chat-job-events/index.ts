import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const POLL_MS = 500
const MAX_MS = 10 * 60 * 1000

function encEvent(data: string): string {
  return `data: ${data.replaceAll('\n', '\ndata: ')}\n\n`
}

serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  const run = async () => {
    const url = new URL(req.url)
    const jobId = url.searchParams.get('job_id')
    const accessToken = url.searchParams.get('access_token')?.trim() ?? null

    if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
      return new Response(
        encEvent(JSON.stringify({ event: 'error', error: 'Missing or invalid job_id' })),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }

    if (!accessToken) {
      return new Response(
        encEvent(JSON.stringify({ event: 'error', error: 'Missing access_token' })),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken)
    if (userError || !userData?.user) {
      return new Response(
        encEvent(JSON.stringify({ event: 'error', error: 'Invalid or expired token' })),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }
    const user = userData.user

    const { data: job, error: jobErr } = await supabase
      .from('chat_turn_jobs')
      .select('id, user_id, status, result, error_message')
      .eq('id', jobId)
      .maybeSingle()

    if (jobErr || !job) {
      return new Response(
        encEvent(
          JSON.stringify({ event: 'error', error: jobErr?.message ?? 'Job not found' }),
        ),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }

    if (job.user_id !== user.id) {
      return new Response(
        encEvent(JSON.stringify({ event: 'error', error: 'Not authorized for this job' })),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }

    const start = Date.now()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder()
        const write = (obj: unknown) => {
          controller.enqueue(enc.encode(encEvent(JSON.stringify(obj))))
        }
        while (true) {
          if (Date.now() - start > MAX_MS) {
            write({ event: 'timeout', error: 'Job poll timed out; Realtime can still complete.' })
            controller.close()
            return
          }

          const { data: row, error } = await supabase
            .from('chat_turn_jobs')
            .select('status, result, error_message')
            .eq('id', jobId)
            .eq('user_id', user.id)
            .maybeSingle()

          if (error) {
            write({ event: 'error', error: error.message })
            controller.close()
            return
          }
          if (!row) {
            write({ event: 'error', error: 'Job disappeared' })
            controller.close()
            return
          }

          if (row.status === 'complete') {
            if (row.result) {
              write({ event: 'complete', payload: row.result })
            } else {
              write({ event: 'error', error: 'Job complete but missing result payload' })
            }
            controller.close()
            return
          }
          if (row.status === 'error') {
            write({
              event: 'error',
              error: row.error_message ?? 'Turn failed',
            })
            controller.close()
            return
          }

          if (row.status === 'pending' || row.status === 'processing') {
            write({ event: 'status', status: row.status })
          }

          await new Promise((r) => setTimeout(r, POLL_MS))
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  return run()
})
