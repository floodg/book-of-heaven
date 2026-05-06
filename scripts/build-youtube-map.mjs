#!/usr/bin/env node
/*
 * build-youtube-map.mjs
 *
 * Produces frontend/public/data/youtube-map.json — a mapping from
 * "volume:number" (e.g. "3:4" for Volume 3 Number 4) to the YouTube video
 * ID. The frontend matches citation pills on the same (volume, number) pair
 * as pdf-pages.json (see docs/SPEC-source-linking.md).
 *
 * Sources we can extract a video ID from, in preference order:
 *   1. `--vtt-dir <path>` — directory of VTT files. For each file we:
 *       a) extract volume and number from the filename (same convention as
 *          build-pdf-page-index.mjs), and
 *       b) scrape any YouTube URL / ID from the first 40 lines of the file
 *          (VTT headers sometimes include the source URL).
 *   2. `--csv <path>` — a two-column CSV: first column is `volume:number`
 *       (e.g. `3:4`) or a legacy single transcript index, second column is
 *       URL or id. CSV overrides (1).
 *   3. `--playlist-json <path>` — `[{ position, videoId }]` with 1-indexed
 *       position (legacy global ordering). Prefer --vtt-dir or CSV for
 *       volume-aware keys.
 *
 * Anything still unresolved is omitted from the map (the UI hides the
 * YouTube icon when the number isn't in the map). The script logs each
 * unresolved number so you can fill gaps manually.
 *
 * Usage:
 *   node scripts/build-youtube-map.mjs \
 *     --vtt-dir ./vtt \
 *     --csv ./manual-overrides.csv \
 *     --playlist-json ./playlist.json \
 *     --out frontend/public/data/youtube-map.json
 *
 * All input flags are optional; at least one must be provided.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const YT_URL_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/

function parseArgs(argv) {
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

function extractVideoId(text) {
  if (!text) return null
  const m = YT_URL_RE.exec(text)
  if (m) return m[1]
  const trimmed = text.trim()
  if (YT_ID_RE.test(trimmed)) return trimmed
  return null
}

// Same filename convention as scripts/build-pdf-page-index.mjs
const FILENAME_PATTERN =
  /(?:book\s+of\s+heaven\s+)?vol(?:ume)?\.?\s*(\d+)\s*[-–—]\s*(?:number|num|no|n0|audio|part|#)?\s*\.?\s*(\d+)/i

function mapKeyFromFilename(name) {
  const base = name.replace(/\.vtt$/i, '')
  const m = FILENAME_PATTERN.exec(base)
  if (m) {
    const volume = Number.parseInt(m[1], 10)
    const num = Number.parseInt(m[2], 10)
    if (Number.isFinite(volume) && Number.isFinite(num)) return `${volume}:${num}`
  }
  const legacy = /(\d{1,3})/.exec(base)
  if (legacy) {
    const n = Number.parseInt(legacy[1], 10)
    if (Number.isFinite(n) && n >= 1 && n <= 612) return String(n)
  }
  return null
}

async function scanVttDir(dir) {
  const out = new Map()
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.vtt')) continue
    const key = mapKeyFromFilename(entry.name)
    if (key == null) {
      console.warn(`[skip] could not parse volume:number from filename: ${entry.name}`)
      continue
    }
    const body = await readFile(join(dir, entry.name), 'utf8')
    const head = body.split(/\r?\n/).slice(0, 40).join('\n')
    const id = extractVideoId(head) ?? extractVideoId(entry.name)
    if (id) out.set(key, id)
  }
  return out
}

async function loadCsv(path) {
  const out = new Map()
  const body = await readFile(path, 'utf8')
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (line.toLowerCase().startsWith('number,')) continue
    const [keyRaw, urlRaw] = line.split(',').map((s) => s.trim())
    const id = extractVideoId(urlRaw)
    if (!id) continue
    if (keyRaw.includes(':')) {
      const [a, b] = keyRaw.split(':').map((s) => s.trim())
      const v = Number.parseInt(a, 10)
      const n = Number.parseInt(b, 10)
      if (Number.isFinite(v) && Number.isFinite(n)) out.set(`${v}:${n}`, id)
      continue
    }
    const num = Number.parseInt(keyRaw, 10)
    if (Number.isFinite(num)) out.set(String(num), id)
  }
  return out
}

async function loadPlaylistJson(path) {
  const out = new Map()
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) {
    throw new Error(`--playlist-json ${path} must be an array`)
  }
  for (const entry of parsed) {
    const num = Number.parseInt(entry?.position ?? entry?.index ?? '', 10)
    const id = extractVideoId(entry?.videoId ?? entry?.id ?? entry?.url ?? '')
    if (Number.isFinite(num) && id) out.set(String(num), id)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  const outPath = resolve(args.out ?? 'frontend/public/data/youtube-map.json')

  const map = new Map()

  if (args['vtt-dir']) {
    const dir = resolve(args['vtt-dir'])
    if (!existsSync(dir)) throw new Error(`--vtt-dir not found: ${dir}`)
    for (const [num, id] of await scanVttDir(dir)) map.set(num, id)
  }
  if (args['playlist-json']) {
    const p = resolve(args['playlist-json'])
    for (const [num, id] of await loadPlaylistJson(p)) map.set(num, id)
  }
  if (args.csv) {
    const p = resolve(args.csv)
    for (const [num, id] of await loadCsv(p)) map.set(num, id)
  }

  if (map.size === 0) {
    console.error(
      'No inputs yielded any entries. Pass at least one of:\n' +
      '  --vtt-dir <path>\n' +
      '  --csv <path>\n' +
      '  --playlist-json <path>',
    )
    process.exit(1)
  }

  const sorted = [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { numeric: true }),
  )
  const result = Object.fromEntries(sorted)

  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${map.size} entries to ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
