import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// `{ "<volume>": { "<number>": <pageNumber> } }`, produced offline by
// `scripts/build-pdf-page-index.mjs` and served as a static JSON at
// `/data/pdf-pages.json`. See docs/SPEC-source-linking.md.
//
// Kept as a plain object (not a Map) so it round-trips through JSON cleanly
// and can be inlined by static hosting caches without serialization tricks.
export type PdfPagesIndex = Record<string, Record<string, number>>

const PdfPagesContext = createContext<PdfPagesIndex>({})

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
            const innerCleaned: Record<string, number> = {}
            for (const [num, page] of Object.entries(inner as Record<string, unknown>)) {
              if (typeof page === 'number' && Number.isFinite(page) && page > 0) {
                innerCleaned[num] = Math.trunc(page)
              }
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
