import type { Thread } from './WorkspaceContext'
import { normalizeSearchText } from './searchText'
import { labelForThread } from './threadTitle'

/** True when the query is empty or matches title, first message, or any stored message/source text. */
export function threadMatchesQuery(thread: Thread, query: string): boolean {
  const q = normalizeSearchText(query)
  if (!q) return true
  if (thread.searchText.includes(q)) return true
  // Fallback for optimistic / partially-loaded rows that have no search blob yet.
  const haystacks = [
    thread.title ?? '',
    thread.firstMessage,
    labelForThread(thread),
  ]
  return haystacks.some((h) => normalizeSearchText(h).includes(q))
}

export function filterThreadsByQuery(threads: Thread[], query: string): Thread[] {
  const q = normalizeSearchText(query)
  if (!q) return threads
  return threads.filter((t) => threadMatchesQuery(t, query))
}
