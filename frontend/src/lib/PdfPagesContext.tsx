import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// A single targetable point inside a Number's PDF content: the page the
// diary entry starts on, plus an optional anchor phrase taken verbatim
// from the PDF text layer on that page so pdf.js's phrase-search
// produces a correct highlight. The anchor is optional because the
// builder sometimes resolves a page but can't extract a reliable
// phrase — in that case the citation still opens to the right page.
export interface PdfPageEntry {
  page: number
  anchor?: string
}

// A timestamped segment. `t` is the VTT cue start (in seconds) where
// Francis began discussing the diary entry that begins at `page`. The
// frontend selects the segment with the greatest `t` ≤ citation
// timestamp. A Number whose VTT covers multiple diary entries will
// produce one segment per entry.
export interface PdfPageSegment extends PdfPageEntry {
  t: number
}

// What a single Number can resolve to in the index. We support three
// shapes so the loader tolerates old cached JSON (see the schema notes
// at the top of scripts/build-pdf-page-index.mjs):
//
//   - PdfPageSegment[] — current preferred form; multi-entry VTTs.
//   - PdfPageEntry    — legacy single-segment object.
//   - (handled in parser: bare number → legacy page-only entry.)
export type PdfPageValue = PdfPageSegment[] | PdfPageEntry

// `{ "<volume>": { "<number>": PdfPageValue } }`, produced offline by
// `scripts/build-pdf-page-index.mjs` and served as a static JSON at
// `/data/pdf-pages.json`. See docs/SPEC-source-linking.md.
//
// Kept as a plain object (not a Map) so it round-trips through JSON cleanly
// and can be inlined by static hosting caches without serialization tricks.
export type PdfPagesIndex = Record<string, Record<string, PdfPageValue>>

const PdfPagesContext = createContext<PdfPagesIndex>({})

function parseSingleEntry(raw: unknown): PdfPageEntry | null {
  // Legacy form: a bare page number.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { page: Math.trunc(raw) }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const pageRaw = obj.page
    const page =
      typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw > 0
        ? Math.trunc(pageRaw)
        : null
    if (page == null) return null
    const anchorRaw = obj.anchor
    const anchor =
      typeof anchorRaw === 'string' && anchorRaw.trim().length > 0
        ? anchorRaw.trim()
        : undefined
    return anchor ? { page, anchor } : { page }
  }
  return null
}

function parseSegment(raw: unknown): PdfPageSegment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const tRaw = obj.t
  const t =
    typeof tRaw === 'number' && Number.isFinite(tRaw) && tRaw >= 0 ? tRaw : null
  if (t == null) return null
  const base = parseSingleEntry(obj)
  if (!base) return null
  return { t, page: base.page, anchor: base.anchor }
}

// Top-level parser: decides between array-of-segments and single-entry
// forms, then validates each piece. Returns null for anything unparseable
// so the caller can skip the Number entirely.
function parseValue(raw: unknown): PdfPageValue | null {
  if (Array.isArray(raw)) {
    const segs: PdfPageSegment[] = []
    for (const item of raw) {
      const seg = parseSegment(item)
      if (seg) segs.push(seg)
    }
    if (segs.length === 0) return null
    // Belt-and-braces sort: the builder already sorts, but keep the UI
    // code's "pick latest t ≤ citation" lookup robust even if someone
    // hand-edits the JSON out of order.
    segs.sort((a, b) => a.t - b.t)
    return segs
  }
  return parseSingleEntry(raw)
}

export function PdfPagesProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<PdfPagesIndex>({})

  useEffect(() => {
    let cancelled = false
    fetch('/data/pdf-pages.json', { cache: 'force-cache' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        const body = (await res.json()) as unknown
        if (cancelled) return
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const cleaned: PdfPagesIndex = {}
          for (const [vol, inner] of Object.entries(body as Record<string, unknown>)) {
            if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue
            const innerCleaned: Record<string, PdfPageValue> = {}
            for (const [num, raw] of Object.entries(inner as Record<string, unknown>)) {
              const value = parseValue(raw)
              if (value) innerCleaned[num] = value
            }
            if (Object.keys(innerCleaned).length > 0) cleaned[vol] = innerCleaned
          }
          setIndex(cleaned)
        }
      })
      .catch((err) => {
        // Non-fatal: the UI just falls back to opening the volume at page 1
        // when an entry isn't in the index. We log so an operator notices if
        // the file is missing or served with the wrong content-type.
        console.warn(
          'Failed to load /data/pdf-pages.json (citation PDFs will open at page 1):',
          err,
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <PdfPagesContext.Provider value={index}>{children}</PdfPagesContext.Provider>
}

export function usePdfPages(): PdfPagesIndex {
  return useContext(PdfPagesContext)
}
