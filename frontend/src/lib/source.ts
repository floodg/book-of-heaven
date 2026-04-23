import { useCallback, useEffect, useState } from 'react'

// Which AnythingLLM workspace(s) a user wants to query with their next
// message. "text" searches only the diary PDFs, "narrated" only the audio
// transcripts, "both" fans out to both in parallel and the UI renders the
// two replies side-by-side under the same user turn. See SPEC.md.
export type Source = 'text' | 'narrated' | 'both'

const STORAGE_KEY = 'boh.source'
const VALID_SOURCES: readonly Source[] = ['text', 'narrated', 'both']

// Read the user's last-used source from localStorage. Returns the plan's
// default ("both") when the key is missing or corrupt so a brand-new user
// always gets the widest results on their first message.
export function loadPreferredSource(): Source {
  if (typeof window === 'undefined') return 'both'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && (VALID_SOURCES as readonly string[]).includes(raw)) {
      return raw as Source
    }
  } catch {
    // localStorage can throw in private browsing / disabled storage modes;
    // fall through to the default.
  }
  return 'both'
}

export function savePreferredSource(source: Source): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, source)
  } catch {
    // Same reason as above; best-effort persistence.
  }
}

// Convenience hook: wire up a local state variable to the preferred source,
// hydrating from localStorage on mount (after first render so SSR / StrictMode
// double-invocation stays harmless).
export function usePreferredSource(): [Source, (next: Source) => void] {
  const [source, setSource] = useState<Source>('both')
  useEffect(() => {
    setSource(loadPreferredSource())
  }, [])
  const update = useCallback((next: Source) => {
    savePreferredSource(next)
    setSource(next)
  }, [])
  return [source, update]
}
