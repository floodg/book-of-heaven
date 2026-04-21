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
// See docs/SPEC-source-linking.md for the full grammar.

export interface ParsedCitation {
  /** The full matched citation string as it appeared in the reply. */
  raw: string
  volume: number
  number: number
  /** Total seconds into the recording for the cited passage, or null if the
   *  LLM didn't include a timestamp. */
  timestampSec: number | null
}

// Same regex the highlighter uses to find candidate citation spans. Exported
// so CitationBadge can avoid a second, subtly-different definition drifting.
export const CITATION_PATTERN =
  /\[(?:Book of Heaven\s+Volume|Volume|Vol\.?)\s+\d+\s*[-–—][^\]\n]*?\d+[^\]\n]*?\]/gi

// Inner extraction regex — applied once we already have a citation-shaped
// span. Captures: volume digits, number digits, optional timestamp.
const CITATION_FIELDS =
  /(?:Book of Heaven\s+Volume|Volume|Vol\.?)\s+(\d+)\s*[-–—]\s*(?:Number|Num\.?|No\.?|#)?\s*(\d+)\s*(?:\(?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\)?)?/i

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
  const inner = raw.replace(/^\[|\]$/g, '')
  const match = CITATION_FIELDS.exec(inner)
  if (!match) return null
  const volume = Number.parseInt(match[1], 10)
  const number = Number.parseInt(match[2], 10)
  if (!Number.isFinite(volume) || !Number.isFinite(number)) return null
  const timestampSec = parseTimestamp(match[3])
  return { raw, volume, number, timestampSec }
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
