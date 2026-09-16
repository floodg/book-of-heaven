// Turn a parsed citation into concrete PDF / YouTube deep-links for the
// citation badge. All the per-Number precision lives in two offline assets:
//
//   - `/data/pdf-pages.json`  — { volume: { number: Segment[] | Entry } }
//     built by `scripts/build-pdf-page-index.mjs`. For Numbers whose VTT
//     covers multiple diary entries, the value is an array of
//     `{ t, page, anchor }` segments keyed by the VTT timestamp where
//     Francis starts reading each entry. We pick the segment whose `t`
//     is the greatest ≤ the citation's timestamp, so citations that
//     fall in the middle / end of a long Number land on the correct
//     later entry rather than the Number's opening page. The anchor
//     on each segment is a short phrase taken verbatim from the PDF
//     text layer on that entry's page, so pdf.js's phrase-search
//     reliably highlights it.
//   - `/data/youtube-map.json` — { "volume:number": videoId } for each
//     narrated recording (e.g. "3:4" for Volume 3 Number 4), built by
//     `scripts/build-youtube-map.mjs`.
//
// We intentionally no longer match the AnythingLLM retrieval chunks to
// derive the page / highlight. Those chunks are volume-wide and the best
// one in a given turn rarely corresponds to the cited Number — using them
// produced mismatched highlights where the PDF would open on a line of
// Luisa's diary that had nothing to do with the citation. The offline
// index is keyed by (volume, number, t), which is exactly what a citation
// carries, so it is always correct when present.

import type { ParsedCitation } from './citations'
import type { PdfPageEntry, PdfPagesIndex, PdfPageValue } from './PdfPagesContext'

// Resolve an index value to a single targetable entry, given the
// citation's timestamp. For an array of segments we pick the one whose
// VTT timestamp is the greatest ≤ the citation's timestamp; when the
// citation has no timestamp (or falls before the first segment), the
// first segment is used — this covers citations that land in Francis's
// introductory commentary before he reads the first date. Single-entry
// values (the fallback shape for Numbers without date headings) are
// returned as-is.
//
// Kept here rather than in PdfPagesContext so that file stays
// components-only (the `react-refresh/only-export-components` lint rule
// complains if we mix a regular function into a Provider module).
function pickEntry(
  value: PdfPageValue | undefined,
  timestampSec: number | null | undefined,
): PdfPageEntry | null {
  if (!value) return null
  if (!Array.isArray(value)) return value
  if (value.length === 0) return null
  if (timestampSec == null || !Number.isFinite(timestampSec)) return value[0]
  let chosen = value[0]
  for (const seg of value) {
    if (seg.t <= timestampSec) chosen = seg
    else break
  }
  return chosen
}

// Mirror of the backend interface (kept separate to avoid pulling a Deno-land
// module into the Vite build). See supabase/functions/chat-proxy/index.ts.
// The sources payload is still threaded through so callers can use it for
// other UI (e.g. a sources drawer); we just don't read it here anymore.
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
  /** Absolute path to the PDF viewer with a page anchor and (when known)
   *  a highlight query, or null if we couldn't even guess which volume
   *  PDF to point at. */
  pdfHref: string | null
  /** YouTube watch URL pinned to the citation's timestamp, or null if we
   *  don't have a video ID for this transcript number. */
  ytHref: string | null
  /** Short anchor phrase from the PDF used to drive the highlight. Exposed
   *  for hover/tooltip display so users get a preview of what the PDF
   *  link is about to show. Null when we don't have an anchor. */
  excerpt: string | null
  /** Page number resolved from the offline index, or null when missing. */
  pdfPage: number | null
}

export function resolveCitationLinks(
  cite: ParsedCitation,
  sources: AnythingLlmSource[] | null,
  youtubeMap: Record<string, string>,
  pdfPages: PdfPagesIndex = {},
): CitationLinks {
  // Raw-PDF citations (e.g. `[VOLUME25.pdf - January 13, 1929]`) carry
  // only a volume + optional trailing text. We skip the per-Number index
  // and YouTube map entirely, and use the trailing text (if any) as the
  // pdf.js search query. No page is set — pdf.js's find controller will
  // scroll to the first match once the text layer renders.
  if (cite.number == null) {
    const pdfParams = new URLSearchParams()
    if (cite.dateText) pdfParams.set('q', cite.dateText)
    const query = pdfParams.toString()
    const pdfHref = query ? `/pdf/${cite.volume}?${query}` : `/pdf/${cite.volume}`
    return {
      pdfHref,
      ytHref: null,
      excerpt: cite.dateText ?? null,
      pdfPage: null,
    }
  }

  const value = pdfPages[String(cite.volume)]?.[String(cite.number)]
  // `pickEntry` handles the array-of-segments case (picking the segment
  // whose VTT timestamp is the greatest ≤ the citation's timestamp) and
  // also passes single-entry values through unchanged.
  const entry = pickEntry(value, cite.timestampSec)
  const pdfPage = entry?.page ?? null
  const anchor = entry?.anchor ?? null

  // Route every PDF link through our React viewer at `/pdf/:volume`. The
  // viewer renders pdf.js with a text layer + find controller, so we can
  // pass a `q=` snippet that gets highlighted on load. Falling back to a
  // raw `/pdfs/Volume_XX.pdf` link would work too, but different browser
  // PDF engines (Chrome's native viewer in particular) ignore the `search`
  // parameter, so we'd lose highlighting for the majority of users.
  const pdfParams = new URLSearchParams()
  if (pdfPage != null) pdfParams.set('page', String(pdfPage))
  if (anchor) pdfParams.set('q', anchor)
  const query = pdfParams.toString()
  const pdfHref: string = query ? `/pdf/${cite.volume}?${query}` : `/pdf/${cite.volume}`

  let videoId = youtubeMap[`${cite.volume}:${cite.number}`]?.trim()
  if (!videoId && sources?.length) {
    for (const src of sources) {
      const meta = src.metadata ?? {}
      const vol = meta.volume
      const tn = meta.transcript_number
      const ytid =
        typeof meta.youtube_video_id === 'string' ? meta.youtube_video_id.trim() : ''
      if (
        vol === cite.volume &&
        tn === cite.number &&
        ytid.length > 0
      ) {
        videoId = ytid
        break
      }
    }
  }

  let ytHref: string | null = null
  if (videoId && cite.timestampSec != null && cite.timestampSec >= 0) {
    ytHref = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${cite.timestampSec}s`
  } else if (videoId) {
    // Timestamp unknown but we at least know the video — open from the start.
    ytHref = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  }

  return { pdfHref, ytHref, excerpt: anchor, pdfPage }
}
