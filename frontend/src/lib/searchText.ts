/** Collapse case/whitespace so sidebar search can share one haystack. */
export function normalizeSearchText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Pull readable strings out of the loosely-shaped `sources` jsonb payload. */
export function sourcesToSearchText(sources: unknown): string {
  if (sources == null) return ''
  if (typeof sources === 'string') return sources
  if (typeof sources === 'number' || typeof sources === 'boolean') {
    return String(sources)
  }
  if (Array.isArray(sources)) {
    return sources.map(sourcesToSearchText).filter(Boolean).join('\n')
  }
  if (typeof sources === 'object') {
    const rec = sources as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['text', 'title', 'chunkSource', 'content']) {
      const v = rec[key]
      if (typeof v === 'string' && v.trim()) parts.push(v)
    }
    if (rec.metadata != null) {
      const nested = sourcesToSearchText(rec.metadata)
      if (nested) parts.push(nested)
    }
    return parts.join('\n')
  }
  return ''
}
