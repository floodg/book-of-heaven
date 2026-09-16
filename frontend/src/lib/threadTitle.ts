import type { Thread } from './WorkspaceContext'

/**
 * Fallback title derived from the first user message when the LLM-generated
 * title isn't available yet (fresh thread waiting on the backend, or the
 * title-generation call failed).
 */
export function humanizeFirstMessage(msg: string): string {
  const cleaned = msg.trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'New conversation'
  // Strip a few noisy conversational lead-ins that made earlier sidebars ugly.
  const stripped = cleaned.replace(
    /^(?:hi[,!.\s]+|hello[,!.\s]+|hey[,!.\s]+|please[,!.\s]+)/i,
    '',
  )
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1)
  return capitalized || cleaned
}

export function labelForThread(thread: Thread): string {
  if (thread.title && thread.title.trim().length > 0) return thread.title
  if (thread.firstMessage) return humanizeFirstMessage(thread.firstMessage)
  return 'New conversation'
}
