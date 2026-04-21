#!/usr/bin/env node
/*
 * build-pdf-page-index.mjs
 *
 * Produces frontend/public/data/pdf-pages.json — a two-level map
 *   { "<volume>": { "<number>": <pageNumber> } }
 * that the frontend consults to turn a citation like
 *   [Book of Heaven Volume 1 - Number 5 (00:17:34)]
 * into a deep link like `/pdfs/Volume_01.pdf#page=14`, opening the PDF at
 * the page where that Number's diary entry begins.
 *
 * We need this because AnythingLLM's PDF collector strips page metadata
 * during embedding (the source chunks it streams back carry no page info),
 * so we pre-compute the page once offline by text-matching VTT transcript
 * content against the PDF page text.
 *
 * Inputs:
 *   --vtt-dir <path>     Folder containing the 612 VTT transcripts, one per
 *                        transcript number. Filename convention:
 *                        "Book of Heaven Volume X - Number Y.vtt"
 *                        Defaults to the location seen in the payload:
 *                        C:\Code\mp3-to-mp4-slides-app\output\transcripts
 *   --pdf-dir <path>     Folder with the zero-padded volume PDFs.
 *                        Defaults to frontend/public/pdfs/
 *   --out <path>         Output JSON path.
 *                        Defaults to frontend/public/data/pdf-pages.json
 *   --verbose            Log every number's match + confidence.
 *
 * Strategy:
 *   1. Parse volume/number from the VTT filename.
 *   2. Extract plain text from the VTT (strip cue headers, timestamps, WEBVTT
 *      metadata). Split into sentences and keep long, content-rich ones as
 *      candidate "anchors" — the rationale being that Francis's short
 *      commentary is less likely to appear verbatim in the PDF, while
 *      Luisa's quoted diary text is.
 *   3. For each volume, load Volume_XX.pdf with pdfjs-dist, extract per-page
 *      text, normalize (lowercase, collapse whitespace, strip non-alnum).
 *   4. For each anchor, count how many 5-word shingles overlap with each
 *      page. Score = overlap count / anchor shingle count.
 *   5. Take the earliest page whose best-anchor score passes a threshold
 *      (default 0.5) and call it the start page for that Number.
 *
 * Caveats — not every transcript will resolve cleanly:
 *   - Some VTTs are almost entirely Francis's spoken English (auto-captioned)
 *     which won't match the PDF's written Italian-translated text. Those
 *     get skipped and are listed at the end.
 *   - Numbers with very short diary entries may resolve to a later page
 *     than their strict start if the anchor happened to come from the
 *     middle. Almost always still within 1-2 pages.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// pdfjs-dist's Node-friendly build. The non-legacy ESM bundle tries to use
// DOM APIs that aren't available under Node.
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
// pdfjs still asks the ESM loader to resolve workerSrc even when we pass
// `disableWorker: true` on the document. On Windows `require.resolve` hands
// back a bare absolute path (`C:\...`) which Node's ESM loader refuses
// ("Only URLs with a scheme in: file, data, and node are supported"). Wrap
// it in a file:// URL so the platform-agnostic loader is happy.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href

const DEFAULTS = {
  vttDir: 'C:\\Code\\mp3-to-mp4-slides-app\\output\\transcripts',
  pdfDir: 'frontend/public/pdfs',
  out: 'frontend/public/data/pdf-pages.json',
  minScore: 0.5,
  shingleSize: 5,
  anchorsPerNumber: 8,
}

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

// Accept the various naming conventions actually present in the transcripts
// folder: "Book of Heaven Volume 1 - Number 5", "Vol 18 - audio 3",
// "Vol 17 - N0 9" (typo for No), "Vol 20 - audio No 2", plain "Vol 4 - 7", …
// The pattern is: "volume" or "vol" + volume digits, a dash, then optionally
// a number marker word (number | num | no | n0 | audio | # | part), then the
// number digits. Both halves tolerate surrounding whitespace and punctuation.
const FILENAME_PATTERN = /(?:book\s+of\s+heaven\s+)?vol(?:ume)?\.?\s*(\d+)\s*[-–—]\s*(?:number|num|no|n0|audio|part|#)?\s*\.?\s*(\d+)/i

function parseVolumeNumberFromFilename(name) {
  const base = basename(name).replace(/\.vtt$/i, '')
  const m = FILENAME_PATTERN.exec(base)
  if (!m) return null
  const volume = Number.parseInt(m[1], 10)
  const number = Number.parseInt(m[2], 10)
  if (!Number.isFinite(volume) || !Number.isFinite(number)) return null
  return { volume, number }
}

function vttToPlainText(vtt) {
  const lines = vtt.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Skip VTT headers, cue indices, and timestamp lines.
    if (trimmed === 'WEBVTT' || trimmed.startsWith('NOTE ')) continue
    if (/^\d+$/.test(trimmed)) continue
    if (/-->/.test(trimmed)) continue
    out.push(trimmed)
  }
  return out.join(' ')
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toShingles(text, size) {
  const words = normalize(text).split(' ').filter(Boolean)
  const shingles = new Set()
  for (let i = 0; i + size <= words.length; i++) {
    shingles.add(words.slice(i, i + size).join(' '))
  }
  return shingles
}

// Pick up to N distinctive anchor phrases from the VTT body. We split on
// sentence-ish punctuation and keep the longest ones, skipping obvious
// Francis-only connective tissue ("Okay so...", "And then...").
function chooseAnchors(plain, count) {
  const sentences = plain
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40)
  // Rank by word count (longer sentences carry more signal).
  sentences.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)
  const anchors = []
  for (const s of sentences) {
    if (anchors.length >= count) break
    // Reject pure-filler openers.
    if (/^(okay|so|and|but|now|yeah|well|right)\b/i.test(s)) continue
    anchors.push(s)
  }
  return anchors
}

async function extractPdfPages(pdfPath) {
  const data = new Uint8Array(await readFile(pdfPath))
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  })
  const doc = await loadingTask.promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
    pages.push({ page: i, text, shingles: toShingles(text, DEFAULTS.shingleSize) })
  }
  await doc.destroy()
  return pages
}

function scoreAnchorAgainstPage(anchorShingles, pageShingles) {
  if (anchorShingles.size === 0) return 0
  let hits = 0
  for (const sh of anchorShingles) {
    if (pageShingles.has(sh)) hits++
  }
  return hits / anchorShingles.size
}

// For a single Number (one VTT) + its volume's page data, return the page
// whose best anchor score is highest, or null if nothing crosses the
// threshold. When multiple pages tie, we prefer the earliest — that's most
// often the page where the entry begins.
function resolveNumberPage(anchors, pages, minScore, verbose) {
  let bestPage = null
  let bestScore = 0
  const perPageBest = new Array(pages.length).fill(0)

  for (const anchor of anchors) {
    const anchorShingles = toShingles(anchor, DEFAULTS.shingleSize)
    if (anchorShingles.size === 0) continue
    let localBestIdx = -1
    let localBestScore = 0
    for (let i = 0; i < pages.length; i++) {
      const s = scoreAnchorAgainstPage(anchorShingles, pages[i].shingles)
      if (s > perPageBest[i]) perPageBest[i] = s
      if (s > localBestScore) {
        localBestScore = s
        localBestIdx = i
      }
    }
    if (localBestScore > bestScore) {
      bestScore = localBestScore
      bestPage = localBestIdx >= 0 ? pages[localBestIdx].page : null
    }
  }

  // If our single best anchor crossed the threshold, take the earliest page
  // whose best score is within 90% of the peak — that's usually the entry's
  // first page rather than a later page that happens to repeat a phrase.
  if (bestScore >= minScore && bestPage != null) {
    const ceiling = bestScore * 0.9
    let earliest = bestPage
    for (let i = 0; i < perPageBest.length; i++) {
      if (perPageBest[i] >= ceiling) {
        earliest = pages[i].page
        break
      }
    }
    if (verbose) {
      console.log(`    best score ${bestScore.toFixed(2)} @ page ${bestPage}; earliest ≥ 90% → page ${earliest}`)
    }
    return { page: earliest, score: bestScore }
  }

  if (verbose) {
    console.log(`    below threshold (best ${bestScore.toFixed(2)} < ${minScore})`)
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv)
  const vttDir = resolve(args['vtt-dir'] ?? DEFAULTS.vttDir)
  const pdfDir = resolve(args['pdf-dir'] ?? DEFAULTS.pdfDir)
  const outPath = resolve(args.out ?? DEFAULTS.out)
  const verbose = Boolean(args.verbose)
  const minScore = args['min-score'] ? Number.parseFloat(args['min-score']) : DEFAULTS.minScore

  if (!existsSync(vttDir)) throw new Error(`VTT dir not found: ${vttDir}`)
  if (!existsSync(pdfDir)) throw new Error(`PDF dir not found: ${pdfDir}`)

  // Group VTTs by volume so we only load each PDF once. When multiple files
  // resolve to the same (volume, number) — e.g. both `Book of Heaven
  // Volume 18 - Number 1.vtt` and `Vol 18 - audio 1.vtt` exist — we keep
  // the first one seen. readdir returns entries in platform order (Windows
  // sorts alphabetically by default), which is lucky: `Book of Heaven…`
  // sorts before `Vol …`, so canonical names win over the short aliases.
  const vttEntries = (await readdir(vttDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.vtt'))
    .sort((a, b) => a.name.localeCompare(b.name))
  /** @type {Map<number, Array<{ number: number, file: string }>>} */
  const byVolume = new Map()
  const seenKey = new Set()
  for (const entry of vttEntries) {
    const parsed = parseVolumeNumberFromFilename(entry.name)
    if (!parsed) {
      if (verbose) console.log(`[skip filename] ${entry.name}`)
      continue
    }
    const key = `${parsed.volume}-${parsed.number}`
    if (seenKey.has(key)) {
      if (verbose) console.log(`[skip duplicate ${key}] ${entry.name}`)
      continue
    }
    seenKey.add(key)
    const list = byVolume.get(parsed.volume) ?? []
    list.push({ number: parsed.number, file: entry.name })
    byVolume.set(parsed.volume, list)
  }

  /** @type {Record<string, Record<string, number>>} */
  const result = {}
  const unresolved = []

  const volumes = [...byVolume.keys()].sort((a, b) => a - b)
  for (const volume of volumes) {
    const pdfPath = join(pdfDir, `Volume_${String(volume).padStart(2, '0')}.pdf`)
    if (!existsSync(pdfPath)) {
      console.warn(`[skip volume ${volume}] PDF not found: ${pdfPath}`)
      continue
    }
    const pdfStat = await stat(pdfPath)
    console.log(`\nVolume ${volume} — ${basename(pdfPath)} (${(pdfStat.size / (1024 * 1024)).toFixed(1)} MB)`)

    let pages
    try {
      pages = await extractPdfPages(pdfPath)
      console.log(`  extracted ${pages.length} pages`)
    } catch (err) {
      console.warn(`  PDF parse failed: ${err?.message ?? err}`)
      continue
    }

    const numbers = (byVolume.get(volume) ?? []).sort((a, b) => a.number - b.number)
    const volumeMap = {}
    for (const { number, file } of numbers) {
      const vtt = await readFile(join(vttDir, file), 'utf8')
      const plain = vttToPlainText(vtt)
      const anchors = chooseAnchors(plain, DEFAULTS.anchorsPerNumber)
      if (anchors.length === 0) {
        if (verbose) console.log(`  Number ${number}: no anchors extracted from VTT, skipping`)
        unresolved.push({ volume, number, reason: 'no-anchors' })
        continue
      }
      if (verbose) console.log(`  Number ${number}: trying ${anchors.length} anchors`)
      const resolved = resolveNumberPage(anchors, pages, minScore, verbose)
      if (resolved) {
        volumeMap[String(number)] = resolved.page
      } else {
        unresolved.push({ volume, number, reason: 'below-threshold' })
      }
    }

    if (Object.keys(volumeMap).length > 0) {
      result[String(volume)] = volumeMap
      console.log(`  resolved ${Object.keys(volumeMap).length} / ${numbers.length} numbers`)
    }
  }

  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

  const totalResolved = Object.values(result).reduce(
    (acc, vol) => acc + Object.keys(vol).length,
    0,
  )
  console.log(`\nWrote ${totalResolved} (volume, number) → page entries to ${outPath}`)
  if (unresolved.length > 0) {
    console.log(`Unresolved: ${unresolved.length}`)
    const sample = unresolved.slice(0, 20).map((u) => `V${u.volume}-N${u.number} (${u.reason})`)
    console.log('  ' + sample.join(', ') + (unresolved.length > 20 ? ', …' : ''))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
