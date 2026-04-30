import { useCallback, useState } from 'react'

export type RetrievalMode = 'anythingllm' | 'pgvector' | 'hybrid'

const STORAGE_KEY = 'boh.retrievalMode'
const VALID_MODES: readonly RetrievalMode[] = ['anythingllm', 'pgvector', 'hybrid']
const ENV_DEFAULT = import.meta.env.VITE_DEFAULT_RETRIEVAL_MODE as string | undefined

function defaultMode(): RetrievalMode {
  if (ENV_DEFAULT && (VALID_MODES as readonly string[]).includes(ENV_DEFAULT)) {
    return ENV_DEFAULT as RetrievalMode
  }
  return 'hybrid'
}

export function loadPreferredRetrievalMode(): RetrievalMode {
  if (typeof window === 'undefined') return defaultMode()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
      return raw as RetrievalMode
    }
  } catch {
    // Ignore localStorage read failures.
  }
  return defaultMode()
}

export function savePreferredRetrievalMode(mode: RetrievalMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Ignore localStorage write failures.
  }
}

export function usePreferredRetrievalMode(): [RetrievalMode, (next: RetrievalMode) => void] {
  const [mode, setMode] = useState<RetrievalMode>(loadPreferredRetrievalMode())
  const update = useCallback((next: RetrievalMode) => {
    savePreferredRetrievalMode(next)
    setMode(next)
  }, [])
  return [mode, update]
}
