import { useState } from 'react'
import { IconPdf, IconYoutube } from './Icons'
import './StructuredCitations.css'

export interface Citation {
  documentId: string
  chunkId: string
  title: string
  sourceType: string
  fileName?: string | null
  sourceUrl?: string | null
  pageNumber?: number | null
  timestampStart?: string | null
  timestampEnd?: string | null
  heading?: string | null
  excerpt: string
}

interface StructuredCitationsProps {
  citations: Citation[]
}

function formatTimestampDisplay(ts: string | null | undefined): string | null {
  if (!ts) return null
  // e.g. "00:01:23.000" → "1:23"
  const m = /^(?:(\d+):)?(\d+):(\d+)/.exec(ts)
  if (!m) return ts
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${min}:${String(sec).padStart(2, '0')}`
}

function timestampToSeconds(ts: string | null | undefined): number | null {
  if (!ts) return null
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(ts)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = parseFloat(m[3])
  return h * 3600 + min * 60 + sec
}

function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const [expanded, setExpanded] = useState(false)

  const tsStart = formatTimestampDisplay(citation.timestampStart)
  const tsSeconds = timestampToSeconds(citation.timestampStart)

  const isVtt = citation.sourceType === 'vtt'
  const isPdf = citation.sourceType === 'pdf'

  // Build YouTube URL from sourceUrl if it's a YouTube URL and we have a timestamp
  const ytUrl =
    isVtt && citation.sourceUrl && tsSeconds != null
      ? (() => {
          try {
            const u = new URL(citation.sourceUrl)
            if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
              u.searchParams.set('t', String(Math.floor(tsSeconds)))
              return u.toString()
            }
          } catch {
            // not a URL
          }
          return null
        })()
      : null

  // Build PDF URL for text sources
  const pdfUrl =
    isPdf && citation.sourceUrl
      ? citation.pageNumber
        ? `${citation.sourceUrl}#page=${citation.pageNumber}`
        : citation.sourceUrl
      : null

  return (
    <div className="sc-card">
      <div className="sc-card-header">
        <span className="sc-card-num">[{index + 1}]</span>
        <div className="sc-card-meta">
          <span className="sc-card-title" title={citation.title}>
            {citation.title}
          </span>
          {citation.heading && (
            <span className="sc-card-heading">{citation.heading}</span>
          )}
          {tsStart && (
            <span className="sc-card-loc">
              {tsStart}
              {citation.timestampEnd && citation.timestampEnd !== citation.timestampStart
                ? `–${formatTimestampDisplay(citation.timestampEnd)}`
                : ''}
            </span>
          )}
          {citation.pageNumber && !tsStart && (
            <span className="sc-card-loc">p. {citation.pageNumber}</span>
          )}
        </div>
        <div className="sc-card-actions">
          {pdfUrl && (
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="sc-action-link"
              title={`Open PDF${citation.pageNumber ? ` at page ${citation.pageNumber}` : ''}`}
              aria-label="Open PDF"
            >
              <IconPdf size={13} />
            </a>
          )}
          {ytUrl && (
            <a
              href={ytUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="sc-action-link"
              title={`Open on YouTube${tsStart ? ` at ${tsStart}` : ''}`}
              aria-label="Open on YouTube"
            >
              <IconYoutube size={13} />
            </a>
          )}
          <button
            type="button"
            className="sc-expand-btn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse excerpt' : 'Expand excerpt'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>
      {expanded && (
        <p className="sc-excerpt">{citation.excerpt}</p>
      )}
    </div>
  )
}

export function StructuredCitations({ citations }: StructuredCitationsProps) {
  const [open, setOpen] = useState(false)

  if (!citations || citations.length === 0) return null

  return (
    <div className="sc-root">
      <button
        type="button"
        className={`sc-toggle${open ? ' sc-toggle--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sc-toggle-icon">{open ? '▼' : '▶'}</span>
        Sources
        <span className="sc-badge">{citations.length}</span>
      </button>
      {open && (
        <div className="sc-list">
          {citations.map((c, i) => (
            <CitationCard key={c.chunkId} citation={c} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}
