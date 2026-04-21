// Source-matching logic: given a parsed citation and the retrieval sources
// AnythingLLM returned for that assistant turn, figure out which PDF page
// and YouTube timestamp to link to.
//
// Because we ship the raw AnythingLLM chunks through verbatim (jsonb in the
// DB), the shape is defensive: any field may be missing and we code for it.

import type { ParsedCitation } from './citations'
import { padVolume } from './citations'
import type { PdfPagesIndex } from './PdfPagesContext'

// Mirror of the backend interface (kept separate to avoid pulling a Deno-land
// module into the Vite build). See supabase/functions/chat-proxy/index.ts.
export interface AnythingLlmSource {
  title?: string
  chunkSource?: string
  text?: string
  score?: number
  _distance?: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface CitationLinks {
  /** Absolute path to the PDF with a page anchor, or null if we couldn't
   *  even guess which volume PDF to point at. */
  pdfHref: string | null
  /** YouTube watch URL pinned to the citation's timestamp, or null if we
   *  don't have a video ID for this transcript number or no timestamp. */
  ytHref: string | null
  /** Human-readable excerpt from the matched source chunk, for hover/tooltip
   *  display. Null when no chunk matched. */
  excerpt: string | null
  /** Page number resolved from the matched PDF chunk (if any). Exposed so
   *  the UI can label the PDF link with the page. */
  pdfPage: number | null
}

function isPdfSource(s: AnythingLlmSource): boolean {
  const title = (s.title ?? '').toLowerCase()
  const chunk = (s.chunkSource ?? '').toLowerCase()
  return title.endsWith('.pdf') || chunk.includes('.pdf')
}

// Extracts the first integer following "page" / "pageNumber" in a string, in
// either the AnythingLLM metadata prefix (`<document_metadata> pageNumber: 23
// </document_metadata>`) or the chunkSource path (`.../file.pdf#page=23`).
function extractPageFromText(raw: string | undefined): number | null {
  if (!raw) return null
  const patterns = [
    /pageNumber\s*[:=]\s*(\d+)/i,
    /page\s*[:=]\s*(\d+)/i,
    /[?&#]page=(\d+)/i,
    /\bpage[_\s-]+(\d+)/i,
  ]
  for (const re of patterns) {
    const m = re.exec(raw)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

function readPageField(s: AnythingLlmSource): number | null {
  const directCandidates = [s.metadata?.page, s.metadata?.pageNumber, (s as Record<string, unknown>).page]
  for (const c of directCandidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c
    if (typeof c === 'string') {
      const n = Number.parseInt(c, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

function resolvePdfPage(s: AnythingLlmSource): number | null {
  return (
    readPageField(s) ??
    extractPageFromText(s.chunkSource) ??
    extractPageFromText(s.text) ??
    extractPageFromText(s.title)
  )
}

// Matches a source whose document title refers to this volume. Accepts both
// padded ("Volume_04") and unpadded ("Volume 4") forms, plus common
// separators. We deliberately use word-boundary anchors so "Volume 4" doesn't
// match "Volume 40".
function sourceMatchesVolume(s: AnythingLlmSource, volume: number): boolean {
  const haystack = `${s.title ?? ''}\n${s.chunkSource ?? ''}`.toLowerCase()
  const padded = padVolume(volume)
  const v = String(volume)
  const patterns = [
    new RegExp(`volume[_\\s-]*0*${v}\\b`, 'i'),
    new RegExp(`vol[_\\s.-]*0*${v}\\b`, 'i'),
    new RegExp(`volume[_\\s-]*${padded}\\b`, 'i'),
  ]
  return patterns.some((re) => re.test(haystack))
}

// Rank sources by retrieval quality. AnythingLLM may give us either `score`
// (higher is better) or `_distance` (lower is better, cosine distance) — we
// handle whichever is present.
function chunkRank(s: AnythingLlmSource): number {
  if (typeof s.score === 'number') return -s.score
  if (typeof s._distance === 'number') return s._distance
  return Number.POSITIVE_INFINITY
}

// Strips AnythingLLM's `<document_metadata>...</document_metadata>` prefix
// so the excerpt we show in a tooltip is just the prose.
function cleanExcerpt(raw: string | undefined): string | null {
  if (!raw) return null
  const stripped = raw.replace(/<document_metadata>[\s\S]*?<\/document_metadata>/i, '').trim()
  if (!stripped) return null
  const compact = stripped.replace(/\s+/g, ' ')
  return compact.length > 400 ? `${compact.slice(0, 400).trimEnd()}…` : compact
}

// Picks a short, distinctive phrase from the start of a PDF chunk's text,
// suitable to feed to pdf.js's find controller as a phrase-search query.
//
// We want 4-7 consecutive words that appear verbatim in the PDF's text
// layer. Long snippets are brittle — pdf.js extracts text with occasional
// extra spaces or hyphenation artefacts, and `phraseSearch: true` requires
// an exact substring match. Short snippets maximise match probability
// while still being specific enough to highlight only the right passage.
function extractSearchSnippet(raw: string | undefined): string | null {
  if (!raw) return null
  const stripped = raw.replace(/<document_metadata>[\s\S]*?<\/document_metadata>/i, '').trim()
  if (!stripped) return null
  // Strip leading punctuation — quote marks, em-dashes, open-paren etc.
  // We don't want a snippet starting with `"` because that's often
  // re-encoded as curly quotes in the PDF.
  const body = stripped.replace(/\s+/g, ' ').replace(/^[\p{P}\p{Pi}\p{Pf}\s]+/u, '')
  const words = body.split(/\s+/)
  // Skip over a trailing comma/period on the last word; it'd make the
  // phrase match fail at word boundaries in some viewers.
  const take = words.slice(0, 6).map((w, i, arr) =>
    i === arr.length - 1 ? w.replace(/[,.;:!?]+$/, '') : w,
  )
  if (take.length < 3) return null
  return take.join(' ')
}

export function resolveCitationLinks(
  cite: ParsedCitation,
  sources: AnythingLlmSource[] | null,
  youtubeMap: Record<string, string>,
  pdfPages: PdfPagesIndex = {},
): CitationLinks {
  let pdfPage: number | null = null
  let excerpt: string | null = null
  let searchSnippet: string | null = null

  if (sources && sources.length > 0) {
    const candidates = sources
      .filter((s) => sourceMatchesVolume(s, cite.volume) && isPdfSource(s))
      .sort((a, b) => chunkRank(a) - chunkRank(b))

    if (candidates.length > 0) {
      const best = candidates[0]
      // The AnythingLLM PDF collector we use doesn't include page metadata,
      // so this is usually null — but we still try in case a future re-embed
      // surfaces it. The pre-built offline index below is the main path.
      pdfPage = resolvePdfPage(best)
      excerpt = cleanExcerpt(best.text)
      searchSnippet = extractSearchSnippet(best.text)
    }
  }

  // Fall back to the offline (volume, number) → page index produced by
  // scripts/build-pdf-page-index.mjs. The index gives Number-level
  // granularity (first page of the diary entry), which is usually tight
  // enough — a reader can scroll a page or two to find the timestamped
  // passage. See docs/SPEC-source-linking.md.
  if (pdfPage == null) {
    const volKey = String(cite.volume)
    const fromIndex = pdfPages[volKey]?.[String(cite.number)]
    if (typeof fromIndex === 'number' && Number.isFinite(fromIndex) && fromIndex > 0) {
      pdfPage = fromIndex
    }
  }

  // Route every PDF link through our React viewer at `/pdf/:volume`. The
  // viewer renders pdf.js with a text layer + find controller, so we can
  // pass a `q=` snippet that gets highlighted on load. Falling back to a
  // raw `/pdfs/Volume_XX.pdf` link would work too, but different browser
  // PDF engines (Chrome's native viewer in particular) ignore the `search`
  // parameter, so we'd lose highlighting for the majority of users.
  const pdfParams = new URLSearchParams()
  if (pdfPage != null) pdfParams.set('page', String(pdfPage))
  if (searchSnippet) pdfParams.set('q', searchSnippet)
  const query = pdfParams.toString()
  const pdfHref: string = query ? `/pdf/${cite.volume}?${query}` : `/pdf/${cite.volume}`

  let ytHref: string | null = null
  const videoId = youtubeMap[String(cite.number)]
  if (videoId && cite.timestampSec != null && cite.timestampSec >= 0) {
    ytHref = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${cite.timestampSec}s`
  } else if (videoId) {
    // Timestamp unknown but we at least know the video — open from the start.
    ytHref = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  }

  return { pdfHref, ytHref, excerpt, pdfPage }
}
