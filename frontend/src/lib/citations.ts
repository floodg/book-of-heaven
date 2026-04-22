// Parsing utilities for the assistant's inline citations.
//
// The workspace system prompt instructs the LLM to emit citations shaped like
//   [Book of Heaven Volume 4 - Number 7 (01:23:45)]
// with these permitted variants:
//   - "Book of Heaven Volume X", "Volume X", or "Vol. X" / "Vol X"
//   - dash between volume and number can be -, –, or —
//   - number can be prefixed "Number", "Num.", "No.", "#", or plain
//   - timestamp can be (hh:mm:ss), (mm:ss), or absent
//
// When AnythingLLM retrieval surfaces a raw PDF chunk instead of a VTT
// transcript, the assistant sometimes emits the source filename directly:
//   [VOLUME25.pdf - January 13, 1929]
//   [VOLUME12.pdf]
// We treat those as volume-only citations — no Number, no YouTube — and
// use the trailing text (when it looks like a date) as the PDF viewer's
// search query so pdf.js highlights the entry on load.
//
// See docs/SPEC-source-linking.md for the full grammar.

export interface ParsedCitation {
  /** The full matched citation string as it appeared in the reply. */
  raw: string
  volume: number
  /** Transcript Number for VTT-style citations. `null` for raw-PDF
   *  citations like `[VOLUME25.pdf - January 13, 1929]` where the
   *  assistant only named the volume. */
  number: number | null
  /** Total seconds into the recording for the cited passage, or null if the
   *  LLM didn't include a timestamp (or the citation has no Number). */
  timestampSec: number | null
  /** Trailing free-text after the volume filename on raw-PDF citations
   *  (typically a date like "January 13, 1929"). Used as the PDF
   *  viewer's `q=` search query. Null for VTT-style citations. */
  dateText: string | null
}

// Same regex the highlighter uses to find candidate citation spans. Exported
// so CitationBadge can avoid a second, subtly-different definition drifting.
//
// Two alternatives:
//   1. The VTT-style form: `[(Book of Heaven Volume|Volume|Vol.) N - ... M ...]`
//   2. The raw-PDF form:   `[VOLUMENN.pdf( - <trailing text>)?]`
// Both end at `]` or a newline so a stray `]` later in a paragraph can't
// pull extra content into the match.
export const CITATION_PATTERN = new RegExp(
  [
    // VTT-style (preserves the original behavior for all existing citations).
    /\[(?:Book of Heaven\s+Volume|Volume|Vol\.?)\s+\d+\s*[-–—][^\]\n]*?\d+[^\]\n]*?\]/.source,
    // Raw-PDF form. `.pdf` is the giveaway; we allow optional whitespace
    // between VOLUME and the digits so "Volume 25.pdf" also matches.
    /\[VOLUME\s*\d+\.pdf(?:[^\]\n]*)?\]/.source,
  ].join('|'),
  'gi',
)

// Inner extraction regex for VTT-style citations. Captures volume digits,
// number digits, optional timestamp.
const VTT_CITATION_FIELDS =
  /(?:Book of Heaven\s+Volume|Volume|Vol\.?)\s+(\d+)\s*[-–—]\s*(?:Number|Num\.?|No\.?|#)?\s*(\d+)\s*(?:\(?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\)?)?/i

// Inner extraction regex for raw-PDF citations. Captures volume digits
// and the trailing text (date, passage reference, whatever the model
// emitted after the dash).
const PDF_FILENAME_FIELDS =
  /VOLUME\s*(\d+)\.pdf(?:\s*[-–—]\s*([^\]\n]+?))?\s*$/i

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null
  const parts = raw.split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 2) {
    const [mm, ss] = parts
    return mm * 60 + ss
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts
    return hh * 3600 + mm * 60 + ss
  }
  return null
}

export function parseCitation(raw: string): ParsedCitation | null {
  const inner = raw.replace(/^\[|\]$/g, '').trim()

  // Try the raw-PDF form first — its `.pdf` marker is unambiguous, so we
  // don't have to worry about it being accidentally swallowed by the
  // VTT-style regex below.
  const pdfMatch = PDF_FILENAME_FIELDS.exec(inner)
  if (pdfMatch) {
    const volume = Number.parseInt(pdfMatch[1], 10)
    if (!Number.isFinite(volume)) return null
    const dateText = pdfMatch[2]?.trim() || null
    return { raw, volume, number: null, timestampSec: null, dateText }
  }

  const match = VTT_CITATION_FIELDS.exec(inner)
  if (!match) return null
  const volume = Number.parseInt(match[1], 10)
  const number = Number.parseInt(match[2], 10)
  if (!Number.isFinite(volume) || !Number.isFinite(number)) return null
  const timestampSec = parseTimestamp(match[3])
  return { raw, volume, number, timestampSec, dateText: null }
}

// Zero-pads a volume number to two digits so `Volume_04.pdf` is deterministic.
export function padVolume(volume: number): string {
  return String(volume).padStart(2, '0')
}

// Formats seconds as "h:mm:ss" (or "m:ss" when under an hour) for display in
// the citation pill label. Returns null for null input so the caller can
// conditionally render.
export function formatTimestamp(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) {
    const mm = String(m).padStart(2, '0')
    return `${h}:${mm}:${ss}`
  }
  return `${m}:${ss}`
}
