/**
 * Generate a v4-ish UUID for a new chat thread. Uses the native
 * crypto.randomUUID when available, otherwise falls back to a
 * Math.random-based implementation for older browsers and runtimes where
 * crypto may not be exposed (Safari behind older HTTPS tunnels, for example).
 */
export function generateThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
