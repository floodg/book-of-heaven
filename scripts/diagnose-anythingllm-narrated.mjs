#!/usr/bin/env node
/**
 * Diagnostic: AnythingLLM narrated workspace RAG.
 * Usage: from repo root, node scripts/diagnose-anythingllm-narrated.mjs
 * Reads supabase/functions/.env for ANYTHINGLLM_URL, ANYTHINGLLM_KEY
 */
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envText = await readFile(resolve(__dirname, '../supabase/functions/.env'), 'utf8')
const base = (envText.match(/ANYTHINGLLM_URL=(.+)/) || [])[1]
  .trim()
  .replace('host.docker.internal', '127.0.0.1')
const key = (envText.match(/ANYTHINGLLM_KEY=(.+)/) || [])[1].trim()
const slug = 'book-of-heaven-narrated'
const message = 'How did Luisa battle the devil and demons?'

async function streamChat(body) {
  const r = await fetch(
    `${base}/api/v1/workspace/${encodeURIComponent(slug)}/stream-chat`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    },
  )
  const text = await r.text()
  const frames = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const s = line.slice(5).trim()
      if (!s) continue
      try {
        frames.push(JSON.parse(s))
      } catch {
        /* ignore */
      }
    }
  }
  let full = ''
  let finalize = null
  for (const f of frames) {
    if (typeof f.textResponse === 'string') full += f.textResponse
    if (f.type === 'finalizeResponseStream') finalize = f
  }
  return { full, finalize, rawLen: text.length, http: r.status }
}

function shortTitles(sources) {
  if (!Array.isArray(sources)) return []
  return sources.map((s) => s.title || s.chunkSource || '?').filter(Boolean)
}

async function test(label, body) {
  const { full, finalize, http } = await streamChat(body)
  const src = finalize?.sources
  const titles = shortTitles(src)
  console.log(`\n=== ${label} (HTTP ${http}) ===`)
  console.log(
    'finalize sources:',
    Array.isArray(src) ? src.length : 'none',
    titles.slice(0, 6).join(' | '),
  )
  if (finalize?.metrics) {
    const m = finalize.metrics
    console.log('tokens', m.prompt_tokens, '→', m.completion_tokens, 'model', m.model)
  }
  console.log('reply (first 400 chars):')
  console.log(full.slice(0, 400).replace(/\n/g, ' '))
}

// 1) Doc count (already known = 221; confirm)
const wsRes = await fetch(`${base}/api/v1/workspace/${encodeURIComponent(slug)}`, {
  headers: { Authorization: `Bearer ${key}` },
})
const wsJson = await wsRes.json()
const ws = Array.isArray(wsJson.workspace) ? wsJson.workspace[0] : wsJson.workspace
const nDocs = (ws.documents || []).length
console.log('Workspace documents in API:', nDocs)
console.log('Live settings: topN=%s threshold=%s vectorSearchMode=%s chatModel=%s',
  ws.topN, ws.similarityThreshold, ws.vectorSearchMode, ws.chatModel,
)

const sid = `diag-${Date.now()}`

await test('A: mode=query, fresh sessionId', { message, mode: 'query', sessionId: sid })
await test('B: mode=chat, fresh sessionId', { message, mode: 'chat', sessionId: `${sid}-b` })
await test('C: mode=query, no sessionId', { message, mode: 'query' })
await test('D: mode=chat, no sessionId (current proxy behavior)', { message, mode: 'chat' })
