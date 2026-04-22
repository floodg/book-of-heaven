import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// Transcript-number (as a string like "7") → YouTube video ID. The map is
// served as a static JSON under /data/youtube-map.json (see
// frontend/public/data/youtube-map.json, built by scripts/build-youtube-map.mjs).
//
// We fetch it once at app boot and share it through context. It's a small
// JSON (~612 entries at most, ~15 KB), so keeping it in memory for the
// session is cheap and avoids a round-trip every time we render a citation.
export type YoutubeMap = Record<string, string>

const YoutubeMapContext = createContext<YoutubeMap>({})

export function YoutubeMapProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<YoutubeMap>({})

  useEffect(() => {
    let cancelled = false
    fetch('/data/youtube-map.json', { cache: 'force-cache' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        const body = (await res.json()) as unknown
        if (cancelled) return
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          // Defensive: only keep string → string entries, drop anything else.
          const cleaned: YoutubeMap = {}
          for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            if (typeof v === 'string' && v.length > 0) cleaned[k] = v
          }
          setMap(cleaned)
        }
      })
      .catch((err) => {
        // Non-fatal: the UI just hides the YouTube icon when a number isn't
        // in the map. We log so an operator notices if the file is missing
        // or served with the wrong content-type.
        console.warn('Failed to load /data/youtube-map.json (citation YouTube links will be hidden):', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <YoutubeMapContext.Provider value={map}>{children}</YoutubeMapContext.Provider>
}

export function useYoutubeMap(): YoutubeMap {
  return useContext(YoutubeMapContext)
}
