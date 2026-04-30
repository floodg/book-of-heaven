export type AssistantSource = 'text' | 'narrated'

export type SearchHit = {
  id: string
  source_type: string
  volume: number
  chunk_index: number
  chunk_count: number | null
  citation_label: string | null
  chunk_text: string
  entry_date: string | null
  entry_index_in_volume: number | null
  entry_title: string | null
  transcript_number: number | null
  time_start_sec: number | null
  time_end_sec: number | null
  youtube_video_id: string | null
  metadata: Record<string, unknown> | null
  similarity: number
}

export type AnythingLlmSource = {
  title?: string
  chunkSource?: string
  text?: string
  score?: number
  _distance?: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

function padVolume2(v: number): string {
  return String(v).padStart(2, '0')
}

function formatTimestampCitation(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad2 = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

function formatSimilarityMatch(similarity: number | null | undefined): string {
  if (similarity == null || !Number.isFinite(similarity)) return '? match'
  const clamped = Math.max(0, Math.min(1, similarity))
  const pct = clamped * 100
  const rounded = Math.round(pct * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text}% match`
}

function extractDateDisplay(hit: SearchHit): string | null {
  const meta = hit.metadata ?? {}
  const display =
    typeof meta.entry_date_display === 'string' ? meta.entry_date_display.trim() : ''
  if (display) return display
  if (hit.entry_date) return String(hit.entry_date)
  return null
}

function buildPdfHref(hit: SearchHit): string {
  const params = new URLSearchParams()
  const dateText = extractDateDisplay(hit)
  if (dateText) params.set('q', dateText)
  const query = params.toString()
  return query ? `/pdf/${hit.volume}?${query}` : `/pdf/${hit.volume}`
}

function buildYoutubeHref(hit: SearchHit): string | null {
  const videoId = hit.youtube_video_id?.trim()
  if (!videoId) return null
  if (hit.time_start_sec != null && Number.isFinite(hit.time_start_sec) && hit.time_start_sec >= 0) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(hit.time_start_sec)}s`
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

export function excerptForSearchHit(
  chunkText: string,
  queryHint: string | undefined,
  maxLen: number,
): string {
  const single = chunkText.trim().replace(/\s+/g, ' ')
  if (!single) return ''
  if (!queryHint?.trim()) {
    return single.length > maxLen ? single.slice(0, maxLen) + '…' : single
  }
  let q = queryHint
    .trim()
    .replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!q) {
    return single.length > maxLen ? single.slice(0, maxLen) + '…' : single
  }

  const lower = single.toLowerCase()
  const qLower = q.toLowerCase()
  let matchStart = lower.indexOf(qLower)
  let matchLen = qLower.length

  if (matchStart < 0) {
    const tokens = qLower
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)
    tokens.sort((a, b) => b.length - a.length)
    for (const t of tokens) {
      const i = lower.indexOf(t)
      if (i >= 0) {
        matchStart = i
        matchLen = t.length
        break
      }
    }
  }

  if (matchStart < 0) {
    return single.length > maxLen ? single.slice(0, maxLen) + '…' : single
  }

  const matchEnd = matchStart + matchLen
  const innerBudget = Math.max(80, maxLen - 2)
  const len = single.length
  let start: number
  let end: number
  if (len <= innerBudget) {
    start = 0
    end = len
  } else {
    const span = matchEnd - matchStart
    if (span >= innerBudget) {
      start = Math.max(0, Math.min(matchStart, len - innerBudget))
      end = start + innerBudget
    } else {
      start = matchStart - Math.floor((innerBudget - span) / 2)
      start = Math.max(0, Math.min(start, len - innerBudget))
      end = start + innerBudget
    }
  }

  const leftEll = start > 0 ? '…' : ''
  const rightEll = end < len ? '…' : ''
  return (leftEll + single.slice(start, end).trim() + rightEll).replace(/\s+/g, ' ')
}

const MARKDOWN_HIT_EXCERPT_MAX = 720

export function citationForHit(hit: SearchHit): string {
  if (hit.source_type === 'narrated') {
    const tn = hit.transcript_number ?? 0
    const ts = formatTimestampCitation(hit.time_start_sec)
    return `[Book of Heaven Volume ${hit.volume} - Number ${tn} (${ts})]`
  }
  const display = extractDateDisplay(hit)
  if (display) {
    return `[VOLUME${padVolume2(hit.volume)}.pdf - ${display}]`
  }
  return `[VOLUME${padVolume2(hit.volume)}.pdf]`
}

export function hitsToReplyMarkdown(
  hits: SearchHit[],
  corpus: AssistantSource,
  queryHint?: string | null,
): string {
  if (hits.length === 0) {
    return (
      '### No matching passages\n\n' +
      'There are no indexed chunks close to this query for **' +
      (corpus === 'text' ? 'Book of Heaven text' : 'narration transcripts') +
      '**. Run the ingestion scripts (`index_supabase.py` in the splitters) ' +
      'and ensure `OPENAI_API_KEY` is set on the Edge Function.'
    )
  }
  const lines: string[] = ['### Semantic search results', '', 'Top matches (most relevant first):', '']
  hits.forEach((hit, i) => {
    const cite = citationForHit(hit)
    const sim = formatSimilarityMatch(hit.similarity)
    const clipped = excerptForSearchHit(hit.chunk_text, queryHint ?? undefined, MARKDOWN_HIT_EXCERPT_MAX)
    const isNarrated = hit.source_type === 'narrated'
    const sourceIcon = isNarrated ? '🎥' : '📄'
    const sourceLabel = isNarrated ? 'Narrated video' : 'Book PDF'
    const pdfHref = buildPdfHref(hit)
    const ytHref = buildYoutubeHref(hit)
    lines.push(`${i + 1}. ${sourceIcon} **${sourceLabel}** ${cite} _(${sim})_`)
    lines.push('')
    lines.push(ytHref ? `[Go to video →](${ytHref}) · [Open PDF →](${pdfHref})` : `[Open PDF →](${pdfHref})`)
    lines.push('')
    lines.push(`> ${clipped}`)
    lines.push('')
  })
  return lines.join('\n')
}

export function hitsToSources(hits: SearchHit[]): AnythingLlmSource[] | null {
  if (hits.length === 0) return null
  return hits.map((hit) => ({
    title: hit.citation_label ?? citationForHit(hit),
    chunkSource: hit.id,
    text: hit.chunk_text,
    score: hit.similarity,
    metadata: {
      ...(hit.metadata ?? {}),
      chunk_id: hit.id,
      source_type: hit.source_type,
      volume: hit.volume,
      transcript_number: hit.transcript_number,
      time_start_sec: hit.time_start_sec,
      youtube_video_id: hit.youtube_video_id,
      similarity: hit.similarity,
    },
  }))
}
