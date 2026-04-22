#!/usr/bin/env node
/*
 * build-pdf-page-index.mjs
 *
 * Produces frontend/public/data/pdf-pages.json — a two-level map
 *   { "<volume>": { "<number>": <Entry> } }
 * where <Entry> is one of:
 *
 *   1. An ARRAY of timestamped segments (preferred; emitted whenever we
 *      can recover date headings from the VTT):
 *
 *        [
 *          { "t": 0,    "page": 60, "anchor": "November 21, 1902" },
 *          { "t": 1365, "page": 62, "anchor": "December 4, 1902" },
 *          { "t": 2443, "page": 63, "anchor": "December 8, 1902" }
 *        ]
 *
 *      Each segment says "from VTT time `t` onward, Francis is discussing
 *      the diary entry that begins at PDF `page` under heading `anchor`".
 *      The frontend picks the latest segment whose `t` ≤ citation
 *      timestamp, so a citation at 1:04:06 into Vol 4 No 13 resolves to
 *      page 63 / "December 8, 1902" rather than the single averaged
 *      page-per-Number we used to emit.
 *
 *   2. A legacy single-segment object `{ "page": 14, "anchor": "phrase" }`
 *      — emitted for Numbers whose VTT has no detectable date headings
 *      (short summaries, poetry, Francis-only commentary). We fall back
 *      to the older shingle-matching heuristic and point at a single page.
 *
 *   3. A legacy bare number `14` — older index files the frontend still
 *      accepts for backward compatibility. This builder never writes this
 *      shape but the loader tolerates it so a stale cached JSON keeps
 *      working.
 *
 * The frontend (frontend/src/lib/sources.ts) turns these entries into
 *   /pdf/<volume>?page=<page>&q=<anchor>
 * deep-links. The anchor is always a string taken verbatim from the PDF
 * text layer on `page`, so pdf.js's phrase-search reliably highlights it.
 *
 * -----------------------------------------------------------------------
 * Why date-driven segments
 * -----------------------------------------------------------------------
 * A single VTT "Number" from Francis's commentary routinely covers
 * multiple distinct diary entries, each with its own date, spread across
 * several PDF pages. Pointing the whole Number at one page guarantees a
 * mismatch for citations that fall on the later entries. The VTT reliably
 * reads each date aloud ("November 21st, 1902", "December 8, 1902", etc.)
 * and the PDFs use a canonical date-header format ("December 8, 1902")
 * on the first line of each entry — so cross-matching the two is
 * deterministic.
 *
 * -----------------------------------------------------------------------
 * Inputs
 * -----------------------------------------------------------------------
 *   --vtt-dir <path>     Folder containing VTT transcripts, one per
 *                        Number. Filename conventions tolerated by
 *                        FILENAME_PATTERN below. Defaults to the path
 *                        used in local dev.
 *   --pdf-dir <path>     Folder with zero-padded volume PDFs. Defaults
 *                        to frontend/public/pdfs/.
 *   --out <path>         Output JSON. Defaults to
 *                        frontend/public/data/pdf-pages.json.
 *   --verbose            Log every Number's matched segments / fallback.
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

// Months + ordinal-day suffix tolerated. We match dates like
//   "November 21st, 1902", "December 4, 1902.", "December 8 1902"
//   "December the 17th, 1902"  (Francis often inserts a "the")
//   "December the 15th"        (year omitted; inherited from earlier in
//                                the same VTT — see buildSegmentsFromCues)
//
// The year is captured as an OPTIONAL group. Bare "December 15th" would
// otherwise be ambiguous across volumes spanning 30+ years of diary
// entries, but within a single Number's VTT Francis almost always reads
// the year aloud on the first date, so inheriting that year for
// subsequent bare dates is safe and dramatically improves coverage.
// (For Vol 4 No 13 alone this fills in Dec 9 / 15 / 17 / 18 / 24 between
// his "December 8, 1902" and his next explicit year.)
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DATE_RE = new RegExp(
  `\\b(${MONTHS.join('|')})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:[,.]?\\s+((?:18|19|20)\\d{2}))?\\b`,
  'gi',
)

// Cue timestamp: "00:01:23.456 --> 00:01:45.678". Accept both dot and
// comma as the millisecond separator (VTT uses '.', SRT uses ',').
const TIMESTAMP_RE = /(\d+):(\d+):(\d+)[.,](\d+)\s+-->\s+(\d+):(\d+):(\d+)[.,](\d+)/

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

// Parse a VTT/SRT into an array of { startSec, endSec, text } cues. Used
// for the primary date-driven segmentation path.
function parseVttCues(vtt) {
  const lines = vtt.split(/\r?\n/)
  const cues = []
  let i = 0
  while (i < lines.length) {
    const m = TIMESTAMP_RE.exec(lines[i])
    if (m) {
      const startSec =
        Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
      const endSec =
        Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
      i++
      const parts = []
      while (i < lines.length && lines[i].trim() !== '') {
        parts.push(lines[i].trim())
        i++
      }
      cues.push({ startSec, endSec, text: parts.join(' ') })
    }
    i++
  }
  return cues
}

// Flatten cues into a single plain-text blob for the fallback shingle
// path. Same as the historical vttToPlainText but we reuse the cue parse
// so we don't have to walk the file twice.
function cuesToPlainText(cues) {
  return cues.map((c) => c.text).join(' ')
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

// Normalize a date match into a canonical lookup key ("december 8 1902")
// and its display form ("December 8, 1902") that appears verbatim in the
// PDF headers. `yearRaw` may be undefined for partial matches like
// "December the 9th" — the caller is responsible for supplying an
// inherited year in that case.
function canonicalizeDate(monthRaw, dayRaw, yearRaw) {
  // MONTHS is title-case so we re-capitalize the user-typed month.
  const monthIdx = MONTHS.findIndex((m) => m.toLowerCase() === monthRaw.toLowerCase())
  if (monthIdx < 0) return null
  const month = MONTHS[monthIdx]
  const day = Number.parseInt(dayRaw, 10)
  const year = Number.parseInt(yearRaw, 10)
  if (!Number.isFinite(day) || day < 1 || day > 31) return null
  if (!Number.isFinite(year)) return null
  return {
    key: `${month.toLowerCase()} ${day} ${year}`,
    display: `${month} ${day}, ${year}`,
  }
}

// Pick up to N distinctive anchor phrases from the VTT body — fallback
// path only, used when a VTT has no date headings we can pin to.
function chooseAnchors(plain, count) {
  const sentences = plain
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40)
  sentences.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)
  const anchors = []
  for (const s of sentences) {
    if (anchors.length >= count) break
    if (/^(okay|so|and|but|now|yeah|well|right)\b/i.test(s)) continue
    anchors.push(s)
  }
  return anchors
}

// Load a volume PDF and return both per-page data (for shingle matching +
// date-header lookups) and a date-header → page map for fast segment
// resolution.
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
  // dateKey → first page number it appears on. The PDFs always place the
  // date in a centered header at the start of each entry, so "first
  // occurrence" is the correct page for the entry that opens on that date.
  const dateIndex = new Map()
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    pages.push({ page: i, text, shingles: toShingles(text, DEFAULTS.shingleSize) })
    for (const m of text.matchAll(DATE_RE)) {
      const canon = canonicalizeDate(m[1], m[2], m[3])
      if (!canon) continue
      if (!dateIndex.has(canon.key)) {
        dateIndex.set(canon.key, { page: i, display: canon.display })
      }
    }
  }
  await doc.destroy()
  return { pages, dateIndex }
}

// Walk the VTT cues in order, find every date mention, and produce a
// deduplicated list of { t, page, anchor } segments. Two rules keep the
// output compact and correct:
//
//   1. Two consecutive cues often restate the same date ("December 4,
//      1902.", "So this is December 4, 1902."). We keep only the FIRST
//      occurrence of each (page, anchor) pair so the timestamp points at
//      when Francis introduced the entry, not when he re-referenced it.
//   2. If a date appears in the VTT but NOT in the PDF date index, we
//      silently drop that segment. This handles OCR / dictation errors
//      in Francis's reading (e.g. he says "November 22" but the PDF only
//      has "November 22nd" rendered without a year nearby). Missing a
//      segment just means the previous segment's page stays in effect
//      until the next confirmed date.
function buildSegmentsFromCues(cues, dateIndex, verbose) {
  const segments = []
  const seenKeys = new Set()
  // Last full year observed in this VTT. Used to fill in bare "December
  // 15th"-style mentions that come after an explicit "December 8, 1902".
  // Scoped to the current Number so a year from an earlier VTT can't
  // leak in. Reset on each call.
  let inheritedYear = null

  for (const cue of cues) {
    for (const m of cue.text.matchAll(DATE_RE)) {
      const monthRaw = m[1]
      const dayRaw = m[2]
      const yearRaw = m[3] // may be undefined for partial matches
      const year = yearRaw ?? (inheritedYear != null ? String(inheritedYear) : undefined)
      if (year == null) {
        if (verbose)
          console.log(`    skip partial date "${m[0]}" (no year anchor yet)`)
        continue
      }
      const canon = canonicalizeDate(monthRaw, dayRaw, year)
      if (!canon) continue
      // Remember the explicit year for subsequent partial matches. We
      // only update from explicit matches (not from our own inherited
      // guess) so one bad guess can't propagate.
      if (yearRaw != null) inheritedYear = Number.parseInt(yearRaw, 10)

      const hit = dateIndex.get(canon.key)
      if (!hit) {
        if (verbose) console.log(`    skip date "${canon.display}" — not in PDF`)
        continue
      }
      // Dedupe on (page, display) so the same entry doesn't get restated.
      // We keep the earliest VTT timestamp for the segment because that's
      // when Francis first arrives at this entry.
      const dedupeKey = `${hit.page}|${hit.display}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      segments.push({
        t: Math.max(0, Math.round(cue.startSec)),
        page: hit.page,
        anchor: hit.display,
      })
    }
  }
  // Sort by timestamp ascending. We expect the VTT already reads dates in
  // chronological PDF order, but nothing in the file format enforces it
  // — explicit sort keeps the frontend's "latest t ≤ citation" lookup
  // correct even if Francis happens to jump around.
  segments.sort((a, b) => a.t - b.t)
  return segments
}

// Given the original PDF page text and the set of normalized 5-word shingles
// seen across this Number's VTT anchors, find the earliest 5-word window in
// the PDF text whose normalized form is one of those anchor shingles.
//
// Fallback-only: this is the historical behavior, used when a Number has
// no date segments. Produces a single phrase verbatim from the PDF so
// pdf.js's phrase search always highlights at least one occurrence.
function findAnchorPhraseOnPage(pageText, anchorShingles, shingleSize) {
  if (!pageText || anchorShingles.size === 0) return null
  const originalTokens = pageText.split(' ').filter((w) => w.length > 0)
  const normalized = originalTokens.map((w) => normalize(w))
  const contentIndices = []
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].length > 0) contentIndices.push(i)
  }
  if (contentIndices.length < shingleSize) return null

  for (let k = 0; k + shingleSize <= contentIndices.length; k++) {
    const shingle = contentIndices
      .slice(k, k + shingleSize)
      .map((idx) => normalized[idx])
      .join(' ')
    if (anchorShingles.has(shingle)) {
      const startIdx = contentIndices[k]
      const lastMatchedContentIdx = contentIndices[k + shingleSize - 1]
      const extraContentIdx = contentIndices[k + shingleSize]
      const extraWord = extraContentIdx != null ? normalized[extraContentIdx] : ''
      const includeExtra = extraContentIdx != null && extraWord.length >= 3
      const endContentIdx = includeExtra ? extraContentIdx : lastMatchedContentIdx
      const endIdx = Math.min(originalTokens.length - 1, endContentIdx)
      const slice = originalTokens
        .slice(startIdx, endIdx + 1)
        .join(' ')
        .replace(/[,.;:!?]+$/, '')
      return slice.trim() || null
    }
  }
  return null
}

function scoreAnchorAgainstPage(anchorShingles, pageShingles) {
  if (anchorShingles.size === 0) return 0
  let hits = 0
  for (const sh of anchorShingles) {
    if (pageShingles.has(sh)) hits++
  }
  return hits / anchorShingles.size
}

// Fallback resolver: pick the single best page for a Number via 5-word
// shingle overlap against the VTT's candidate anchor sentences. Returns
// `{ page, anchor } | null`. Used when date-driven segmentation yielded
// nothing.
function resolveSinglePage(anchors, pages, minScore, verbose) {
  let bestPage = null
  let bestScore = 0
  const perPageBest = new Array(pages.length).fill(0)
  const combinedAnchorShingles = new Set()

  for (const anchor of anchors) {
    const anchorShingles = toShingles(anchor, DEFAULTS.shingleSize)
    if (anchorShingles.size === 0) continue
    for (const sh of anchorShingles) combinedAnchorShingles.add(sh)
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

  if (bestScore >= minScore && bestPage != null) {
    // Prefer the earliest page whose best score is within 90% of the
    // peak — that's usually where the entry actually begins.
    const ceiling = bestScore * 0.9
    let earliest = bestPage
    let earliestIdx = pages.findIndex((p) => p.page === bestPage)
    for (let i = 0; i < perPageBest.length; i++) {
      if (perPageBest[i] >= ceiling) {
        earliest = pages[i].page
        earliestIdx = i
        break
      }
    }
    const anchorPhrase =
      earliestIdx >= 0
        ? findAnchorPhraseOnPage(
            pages[earliestIdx].text,
            combinedAnchorShingles,
            DEFAULTS.shingleSize,
          )
        : null
    if (verbose) {
      console.log(
        `    fallback shingle match: page ${earliest} (score ${bestScore.toFixed(2)})` +
          (anchorPhrase ? ` — anchor "${anchorPhrase}"` : ' — no anchor'),
      )
    }
    return { page: earliest, anchor: anchorPhrase }
  }

  if (verbose) {
    console.log(`    fallback below threshold (best ${bestScore.toFixed(2)} < ${minScore})`)
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv)
  const vttDir = resolve(args['vtt-dir'] ?? DEFAULTS.vttDir)
  const pdfDir = resolve(args['pdf-dir'] ?? DEFAULTS.pdfDir)
  const outPath = resolve(args.out ?? DEFAULTS.out)
  const verbose = Boolean(args.verbose)
  const minScore = args['min-score']
    ? Number.parseFloat(args['min-score'])
    : DEFAULTS.minScore

  if (!existsSync(vttDir)) throw new Error(`VTT dir not found: ${vttDir}`)
  if (!existsSync(pdfDir)) throw new Error(`PDF dir not found: ${pdfDir}`)

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

  /** @type {Record<string, Record<string, unknown>>} */
  const result = {}
  const unresolved = []
  let segmentsMode = 0
  let singleMode = 0

  const volumes = [...byVolume.keys()].sort((a, b) => a - b)
  for (const volume of volumes) {
    const pdfPath = join(pdfDir, `Volume_${String(volume).padStart(2, '0')}.pdf`)
    if (!existsSync(pdfPath)) {
      console.warn(`[skip volume ${volume}] PDF not found: ${pdfPath}`)
      continue
    }
    const pdfStat = await stat(pdfPath)
    console.log(
      `\nVolume ${volume} — ${basename(pdfPath)} (${(pdfStat.size / (1024 * 1024)).toFixed(1)} MB)`,
    )

    let pages
    let dateIndex
    try {
      const extracted = await extractPdfPages(pdfPath)
      pages = extracted.pages
      dateIndex = extracted.dateIndex
      console.log(`  extracted ${pages.length} pages, ${dateIndex.size} unique date headers`)
    } catch (err) {
      console.warn(`  PDF parse failed: ${err?.message ?? err}`)
      continue
    }

    const numbers = (byVolume.get(volume) ?? []).sort((a, b) => a.number - b.number)
    /** @type {Record<string, unknown>} */
    const volumeMap = {}
    for (const { number, file } of numbers) {
      const vtt = await readFile(join(vttDir, file), 'utf8')
      const cues = parseVttCues(vtt)
      if (verbose) console.log(`  Number ${number}: ${cues.length} cues`)

      // Primary path: date-driven segments.
      const segments = buildSegmentsFromCues(cues, dateIndex, verbose)
      if (segments.length > 0) {
        volumeMap[String(number)] = segments
        segmentsMode++
        if (verbose) {
          console.log(`    ${segments.length} segment(s):`)
          for (const s of segments) {
            console.log(`      t=${s.t}s → page ${s.page} — "${s.anchor}"`)
          }
        }
        continue
      }

      // Fallback: single-page shingle match against the whole VTT.
      const plain = cuesToPlainText(cues)
      const anchors = chooseAnchors(plain, DEFAULTS.anchorsPerNumber)
      if (anchors.length === 0) {
        if (verbose) console.log(`    no date segments, no anchor candidates — skip`)
        unresolved.push({ volume, number, reason: 'no-anchors' })
        continue
      }
      const resolved = resolveSinglePage(anchors, pages, minScore, verbose)
      if (resolved) {
        volumeMap[String(number)] = resolved.anchor
          ? { page: resolved.page, anchor: resolved.anchor }
          : { page: resolved.page }
        singleMode++
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
  console.log(
    `\nWrote ${totalResolved} Number entries to ${outPath} ` +
      `(${segmentsMode} segmented, ${singleMode} single-page fallback)`,
  )
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
