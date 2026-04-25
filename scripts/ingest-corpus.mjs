#!/usr/bin/env node
/**
 * ingest-corpus.mjs
 *
 * Idempotent ingestion of VTT transcripts and PDF diary volumes into the
 * Supabase pgvector tables (documents, document_chunks, document_embeddings).
 *
 * Usage:
 *   node scripts/ingest-corpus.mjs \
 *     --workspace narrated \
 *     --dir ./vtt \
 *     [--re-embed]
 *
 *   node scripts/ingest-corpus.mjs \
 *     --workspace text \
 *     --dir ./pdfs \
 *     [--re-embed]
 *
 * Options:
 *   --workspace   Workspace slug ('narrated' or 'text') — required
 *   --dir         Directory containing VTT or PDF files — required
 *   --re-embed    Re-generate embeddings even for chunks that already have them
 *   --batch-size  Number of texts to embed per OpenAI API call (default: 100)
 *   --top-k       Number of source tokens per chunk (default: 500)
 *   --overlap     Overlap tokens between consecutive chunks (default: 100)
 *   --dry-run     Parse + chunk without writing to Supabase
 *
 * Config (reads from supabase/functions/.env, can be overridden via env vars):
 *   SUPABASE_URL       (or SERVICE_SUPABASE_URL)
 *   SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Record<string, string>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

async function loadEnv() {
  const envPath = resolve(__dirname, '../supabase/functions/.env')
  if (!existsSync(envPath)) return {}
  const text = await readFile(envPath, 'utf8')
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// VTT parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} ts  Cue timestamp like "00:01:23.456"
 * @returns {number}   Seconds
 */
function parseCueTime(ts) {
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] * 60 + parts[1]
}

/**
 * @param {string} raw  Full VTT file content
 * @returns {{ start: string; end: string; text: string }[]}
 */
function parseVtt(raw) {
  const cues = []
  const blocks = raw.split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const m = /^([\d:.]+)\s+-->\s+([\d:.]+)/.exec(timeLine)
    if (!m) continue
    const textLines = lines.slice(lines.indexOf(timeLine) + 1)
    const text = textLines.join(' ').replace(/<[^>]*>/g, '').trim()
    if (!text) continue
    cues.push({ start: m[1], end: m[2], text })
  }
  return cues
}

/**
 * Group cues into overlapping chunks of ~targetWords words.
 * Each chunk records the start/end timestamp of the cues it covers.
 *
 * @param {{ start: string; end: string; text: string }[]} cues
 * @param {number} targetWords
 * @param {number} overlapWords
 * @returns {{ content: string; timestamp_start: string; timestamp_end: string }[]}
 */
function chunkCues(cues, targetWords = 500, overlapWords = 100) {
  /** @type {{ content: string; timestamp_start: string; timestamp_end: string }[]} */
  const chunks = []
  let i = 0
  while (i < cues.length) {
    const chunkCues = []
    let wordCount = 0
    let j = i
    while (j < cues.length) {
      const words = cues[j].text.split(/\s+/).length
      chunkCues.push(cues[j])
      wordCount += words
      j++
      if (wordCount >= targetWords) break
    }
    if (chunkCues.length === 0) break
    chunks.push({
      content: chunkCues.map((c) => c.text).join(' '),
      timestamp_start: chunkCues[0].start,
      timestamp_end: chunkCues[chunkCues.length - 1].end,
    })
    // Advance by (target - overlap) worth of words
    let stepWords = 0
    let step = 0
    while (step < chunkCues.length && stepWords < targetWords - overlapWords) {
      stepWords += chunkCues[step].text.split(/\s+/).length
      step++
    }
    i += Math.max(1, step)
  }
  return chunks
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF parsing (via pdfjs-dist)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @returns {Promise<{ pageNumber: number; text: string }[]>}
 */
async function parsePdf(filePath) {
  // Lazy import — pdfjs-dist is a devDependency in the root package.json
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(filePath))
  const loadingTask = pdfjsLib.getDocument({ data })
  const pdf = await loadingTask.promise
  const pages = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) pages.push({ pageNumber: p, text })
  }
  return pages
}

/**
 * Group pages into overlapping chunks of ~targetWords words.
 *
 * @param {{ pageNumber: number; text: string }[]} pages
 * @param {number} targetWords
 * @param {number} overlapWords
 * @returns {{ content: string; page_number: number; page_end: number }[]}
 */
function chunkPages(pages, targetWords = 500, overlapWords = 100) {
  /** @type {{ content: string; page_number: number; page_end: number }[]} */
  const chunks = []
  let i = 0
  while (i < pages.length) {
    const chunkPages = []
    let wordCount = 0
    let j = i
    while (j < pages.length) {
      chunkPages.push(pages[j])
      wordCount += pages[j].text.split(/\s+/).length
      j++
      if (wordCount >= targetWords) break
    }
    if (chunkPages.length === 0) break
    chunks.push({
      content: chunkPages.map((p) => p.text).join(' '),
      page_number: chunkPages[0].pageNumber,
      page_end: chunkPages[chunkPages.length - 1].pageNumber,
    })
    // Advance by (target - overlap) worth of words
    let stepWords = 0
    let step = 0
    while (step < chunkPages.length && stepWords < targetWords - overlapWords) {
      stepWords += chunkPages[step].text.split(/\s+/).length
      step++
    }
    i += Math.max(1, step)
  }
  return chunks
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI embeddings
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMS = 1536

/**
 * @param {string[]} texts
 * @param {string} apiKey
 * @param {number} [attempt]
 * @returns {Promise<number[][]>}  one embedding vector per text
 */
async function embedBatch(texts, apiKey, attempt = 0) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  })

  if (res.status === 429 && attempt < 6) {
    const body = await res.text()
    // Parse "Please try again in 27.136s" from the error message
    const secondsMatch = /"Please try again in ([\d.]+)s"/.exec(body)
      ?? /try again in ([\d.]+)s/i.exec(body)
    const waitSecs = secondsMatch ? Math.ceil(parseFloat(secondsMatch[1])) + 2 : 30 * (attempt + 1)
    process.stdout.write(`\n  Rate limited — waiting ${waitSecs}s before retry...\n`)
    await new Promise((r) => setTimeout(r, waitSecs * 1000))
    return embedBatch(texts, apiKey, attempt + 1)
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI embeddings failed (${res.status}): ${body}`)
  }
  const json = await res.json()
  // Sort by index to guarantee order matches input
  const sorted = json.data.sort((a, b) => a.index - b.index)
  return sorted.map((d) => d.embedding)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)

  const workspaceSlug = args.workspace
  if (!workspaceSlug || typeof workspaceSlug !== 'string') {
    console.error('Error: --workspace <slug> is required (narrated|text)')
    process.exit(1)
  }

  const inputDir = args.dir
  if (!inputDir || typeof inputDir !== 'string') {
    console.error('Error: --dir <path> is required')
    process.exit(1)
  }
  const resolvedDir = resolve(inputDir)
  if (!existsSync(resolvedDir)) {
    console.error(`Error: directory not found: ${resolvedDir}`)
    process.exit(1)
  }

  const reEmbed = args['re-embed'] === true
  const dryRun = args['dry-run'] === true
  const batchSize = Number(args['batch-size'] ?? 100)
  const targetWords = Number(args['top-k'] ?? 500)
  const overlapWords = Number(args.overlap ?? 100)

  // Load config
  const env = await loadEnv()
  const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? env.SERVICE_SUPABASE_URL
  const serviceRoleKey = process.env.SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY
  const openaiKey = process.env.OPENAI_API_KEY ?? env.OPENAI_API_KEY

  if (!supabaseUrl) { console.error('Error: SUPABASE_URL not found'); process.exit(1) }
  if (!serviceRoleKey) { console.error('Error: SERVICE_ROLE_KEY not found'); process.exit(1) }
  if (!openaiKey && !dryRun) { console.error('Error: OPENAI_API_KEY not found'); process.exit(1) }

  // Supabase client (service role — bypasses RLS for ingestion)
  // Replace host.docker.internal with 127.0.0.1 for local scripts
  const localUrl = supabaseUrl.replace('host.docker.internal', '127.0.0.1')
  const db = createClient(localUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })

  // Resolve workspace row
  const { data: workspace, error: wsErr } = await db
    .from('research_workspaces')
    .select('id, slug, name, source_type_hint')
    .eq('slug', workspaceSlug)
    .single()
  if (wsErr || !workspace) {
    console.error(`Workspace '${workspaceSlug}' not found in research_workspaces. Run the 011 migration first.`)
    console.error(wsErr)
    process.exit(1)
  }
  console.log(`Workspace: ${workspace.name} (${workspace.id})`)

  // Discover files
  const entries = await readdir(resolvedDir, { withFileTypes: true })
  const files = entries
    .filter((e) => {
      if (!e.isFile()) return false
      const ext = extname(e.name).toLowerCase()
      return ext === '.vtt' || ext === '.pdf'
    })
    .map((e) => join(resolvedDir, e.name))

  if (files.length === 0) {
    console.error(`No .vtt or .pdf files found in ${resolvedDir}`)
    process.exit(1)
  }
  console.log(`Found ${files.length} file(s) to process`)

  let totalChunks = 0
  let totalEmbedded = 0
  let totalSkipped = 0
  let totalFailed = 0

  for (const filePath of files) {
    const fileName = basename(filePath)
    const ext = extname(fileName).toLowerCase()

    console.log(`\n--- ${fileName} ---`)

    try {
      // ── Parse ──────────────────────────────────────────────────────────────

      /** @type {{ content: string; timestamp_start?: string; timestamp_end?: string; page_number?: number }[]} */
      let rawChunks
      let sourceType
      let title

      if (ext === '.vtt') {
        sourceType = 'vtt'
        const raw = await readFile(filePath, 'utf8')
        const cues = parseVtt(raw)
        if (cues.length === 0) {
          console.warn(`  No cues found, skipping`)
          continue
        }
        rawChunks = chunkCues(cues, targetWords, overlapWords)
        // Derive title from filename: "Book_of_Heaven_Num_007.vtt" → "Book of Heaven Number 007"
        title = fileName
          .replace(/\.[^.]+$/, '')
          .replace(/_/g, ' ')
          .replace(/\bNum\b/i, 'Number')
        console.log(`  Parsed ${cues.length} cues → ${rawChunks.length} chunks`)
      } else {
        sourceType = 'pdf'
        const pages = await parsePdf(filePath)
        rawChunks = chunkPages(pages, targetWords, overlapWords).map((c) => ({
          content: c.content,
          page_number: c.page_number,
        }))
        // Derive title: "Volume_01.pdf" → "Volume 01"
        title = fileName
          .replace(/\.[^.]+$/, '')
          .replace(/_/g, ' ')
        console.log(`  Parsed ${pages.length} pages → ${rawChunks.length} chunks`)
      }

      if (dryRun) {
        console.log(`  [dry-run] would upsert ${rawChunks.length} chunks`)
        totalChunks += rawChunks.length
        continue
      }

      // ── Insert/find document ───────────────────────────────────────────────
      // Use select-first rather than upsert onConflict to avoid dependency on
      // constraint names (partial unique indexes are not usable by PostgREST).

      let doc
      const { data: existingDoc } = await db
        .from('documents')
        .select('id')
        .eq('workspace_id', workspace.id)
        .eq('file_name', fileName)
        .maybeSingle()

      if (existingDoc) {
        doc = existingDoc
        // Update title/source_type in case they changed
        await db
          .from('documents')
          .update({ title, source_type: sourceType, updated_at: new Date().toISOString() })
          .eq('id', doc.id)
      } else {
        const { data: newDoc, error: insertErr } = await db
          .from('documents')
          .insert({ workspace_id: workspace.id, title, source_type: sourceType, file_name: fileName })
          .select('id')
          .single()
        if (insertErr || !newDoc) {
          console.error(`  Document insert failed:`, insertErr)
          totalFailed++
          continue
        }
        doc = newDoc
      }

      // ── Insert/update chunks ───────────────────────────────────────────────

      const chunkRows = rawChunks.map((c, idx) => ({
        document_id: doc.id,
        chunk_index: idx,
        content: c.content,
        timestamp_start: c.timestamp_start ?? null,
        timestamp_end: c.timestamp_end ?? null,
        page_number: c.page_number ?? null,
      }))

      // Load existing chunk ids for this document so we can skip re-insertion
      const { data: existingChunks } = await db
        .from('document_chunks')
        .select('id, chunk_index')
        .eq('document_id', doc.id)

      const existingByIndex = new Map((existingChunks ?? []).map((c) => [c.chunk_index, c.id]))

      // Insert only chunks that don't exist yet
      const newChunkRows = chunkRows.filter((r) => !existingByIndex.has(r.chunk_index))
      if (newChunkRows.length > 0) {
        const { error: chunkErr } = await db.from('document_chunks').insert(newChunkRows)
        if (chunkErr) {
          console.error(`  Chunk insert failed:`, chunkErr)
          totalFailed++
          continue
        }
      }

      // Re-fetch all chunk ids for this document (existing + newly inserted)
      const { data: allChunks, error: fetchErr } = await db
        .from('document_chunks')
        .select('id, chunk_index')
        .eq('document_id', doc.id)

      if (fetchErr || !allChunks) {
        console.error(`  Chunk fetch failed:`, fetchErr)
        totalFailed++
        continue
      }

      const upsertedChunks = allChunks

      // Sort by chunk_index to align with rawChunks array
      upsertedChunks.sort((a, b) => a.chunk_index - b.chunk_index)
      totalChunks += upsertedChunks.length

      // ── Embeddings ─────────────────────────────────────────────────────────

      // Determine which chunks need (re-)embedding
      let chunkIdsToEmbed = upsertedChunks.map((c) => c.id)

      if (!reEmbed) {
        const { data: existing } = await db
          .from('document_embeddings')
          .select('chunk_id')
          .in('chunk_id', chunkIdsToEmbed)
          .eq('embedding_model', EMBEDDING_MODEL)
        const existingSet = new Set((existing ?? []).map((e) => e.chunk_id))
        chunkIdsToEmbed = chunkIdsToEmbed.filter((id) => !existingSet.has(id))
        totalSkipped += upsertedChunks.length - chunkIdsToEmbed.length
      }

      if (chunkIdsToEmbed.length === 0) {
        console.log(`  All ${upsertedChunks.length} chunks already embedded, skipping`)
        continue
      }

      console.log(`  Embedding ${chunkIdsToEmbed.length} chunk(s) in batches of ${batchSize}...`)

      // Map chunk id → content for embedding (align by chunk_index)
      const chunkContentMap = new Map(
        upsertedChunks.map((c) => [c.id, rawChunks[c.chunk_index]?.content ?? '']),
      )

      for (let start = 0; start < chunkIdsToEmbed.length; start += batchSize) {
        const batch = chunkIdsToEmbed.slice(start, start + batchSize)
        const texts = batch.map((id) => chunkContentMap.get(id) ?? '')

        const vectors = await embedBatch(texts, openaiKey)

        const embeddingRows = batch.map((chunkId, i) => ({
          chunk_id: chunkId,
          embedding: JSON.stringify(vectors[i]),
          embedding_model: EMBEDDING_MODEL,
        }))

        const { error: embErr } = await db
          .from('document_embeddings')
          .insert(embeddingRows)

        if (embErr) {
          console.error(`  Embedding upsert failed (batch ${start}–${start + batch.length}):`, embErr)
          totalFailed++
        } else {
          totalEmbedded += batch.length
          process.stdout.write(
            `  ${Math.min(start + batchSize, chunkIdsToEmbed.length)} / ${chunkIdsToEmbed.length} embedded\r`,
          )
        }
      }
      console.log(`  Done: ${chunkIdsToEmbed.length} embedded`)
    } catch (err) {
      console.error(`  Error processing ${fileName}:`, err.message)
      totalFailed++
    }
  }

  console.log(`\n════════════════════════════════`)
  console.log(`  Total chunks : ${totalChunks}`)
  console.log(`  Embedded     : ${totalEmbedded}`)
  console.log(`  Skipped      : ${totalSkipped}`)
  console.log(`  Failed files : ${totalFailed}`)
  if (dryRun) console.log(`  (dry-run — nothing was written)`)
  console.log(`════════════════════════════════`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
