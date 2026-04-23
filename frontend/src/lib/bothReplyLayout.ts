import { useCallback, useEffect, useState } from 'react'

/** How to show Text + Narrated replies for the same turn. */
export type BothReplyLayout = 'split' | 'tab'

const STORAGE_KEY = 'boh.bothReplyLayout'
const VALID: readonly BothReplyLayout[] = ['split', 'tab']

export function loadBothReplyLayout(): BothReplyLayout {
  if (typeof window === 'undefined') return 'split'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && (VALID as readonly string[]).includes(raw)) {
      return raw as BothReplyLayout
    }
  } catch {
    /* ignore */
  }
  return 'split'
}

export function saveBothReplyLayout(layout: BothReplyLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, layout)
  } catch {
    /* ignore */
  }
}

export function useBothReplyLayout(): [
  BothReplyLayout,
  (next: BothReplyLayout) => void,
] {
  const [layout, setLayout] = useState<BothReplyLayout>('split')
  useEffect(() => {
    setLayout(loadBothReplyLayout())
  }, [])
  const update = useCallback((next: BothReplyLayout) => {
    saveBothReplyLayout(next)
    setLayout(next)
  }, [])
  return [layout, update]
}
