import { Children, Fragment, cloneElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  CITATION_PATTERN,
  formatTimestamp,
  parseCitation,
  type ParsedCitation,
} from '../lib/citations'
import {
  resolveCitationLinks,
  type AnythingLlmSource,
  type CitationLinks,
} from '../lib/sources'
import type { PdfPagesIndex } from '../lib/PdfPagesContext'
import { IconPdf, IconYoutube } from './Icons'
import './CitationBadge.css'

// Context threaded down from ChatWindow per-message. When absent (empty
// object used as a sentinel), the badge still renders the text but without
// working PDF/YouTube action links — this keeps the component safe to use
// in places that don't have source data, e.g. future standalone previews.
export interface CitationContext {
  sources: AnythingLlmSource[] | null
  youtubeMap: Record<string, string>
  pdfPages: PdfPagesIndex
}

const EMPTY_CONTEXT: CitationContext = {
  sources: null,
  youtubeMap: {},
  pdfPages: {},
}

function splitStringIntoCitations(
  text: string,
  keyPrefix: string,
  ctx: CitationContext,
): ReactNode[] {
  const segments: ReactNode[] = []
  let lastIndex = 0
  let hitIndex = 0

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      segments.push(text.slice(lastIndex, start))
    }
    const raw = match[0]
    const parsed = parseCitation(raw)
    if (parsed) {
      const links = resolveCitationLinks(parsed, ctx.sources, ctx.youtubeMap, ctx.pdfPages)
      segments.push(
        <CitationPill
          key={`${keyPrefix}-cite-${hitIndex++}`}
          parsed={parsed}
          links={links}
        />,
      )
    } else {
      // Unparseable but citation-shaped — fall back to the old plain pill so
      // we never swallow the author's citation into raw text.
      segments.push(
        <span key={`${keyPrefix}-cite-${hitIndex++}`} className="citation-badge">
          {raw}
        </span>,
      )
    }
    lastIndex = start + raw.length
  }

  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex))
  }

  return segments.length > 0 ? segments : [text]
}

export function highlightCitations(
  node: ReactNode,
  keyPrefix = 'n',
  ctx: CitationContext = EMPTY_CONTEXT,
): ReactNode {
  if (node == null || typeof node === 'boolean') return node

  if (typeof node === 'string') {
    const parts = splitStringIntoCitations(node, keyPrefix, ctx)
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  if (typeof node === 'number') return node

  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={`${keyPrefix}-${i}`}>
        {highlightCitations(child, `${keyPrefix}-${i}`, ctx)}
      </Fragment>
    ))
  }

  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>
    const childProp = element.props?.children
    if (childProp === undefined) return element
    return cloneElement(element, {
      children: Children.map(childProp, (child, i) =>
        highlightCitations(child, `${keyPrefix}-${i}`, ctx),
      ),
    })
  }

  return node
}

// Renders the citation as a single clickable chip.
// Narrated citations link to the YouTube video (fallback: PDF when no video
// exists). Book/PDF citations link directly to the PDF viewer.
function CitationPill({
  parsed,
  links,
}: {
  parsed: ParsedCitation
  links: CitationLinks
}) {
  const ts = formatTimestamp(parsed.timestampSec)

  // Two kinds of citations:
  //   - "narrated" — from VTT transcript; has a Number + timestamp.
  //   - "book"     — from the PDF text layer; has volume + date only.
  const sourceType: 'narrated' | 'book' = parsed.number != null ? 'narrated' : 'book'
  const sourceLabel = sourceType === 'narrated' ? 'Narrated' : 'Book'

  const labelParts: string[] = [`Vol ${parsed.volume}`]
  if (parsed.number != null) labelParts.push(`No ${parsed.number}`)
  if (ts) labelParts.push(ts)
  if (parsed.number == null && parsed.dateText) labelParts.push(parsed.dateText)
  const label = labelParts.join(' · ')

  // Narrated → YouTube when mapped; otherwise PDF. Book → PDF only.
  const href =
    sourceType === 'narrated'
      ? (links.ytHref ?? links.pdfHref)
      : links.pdfHref

  const opensYoutube = sourceType === 'narrated' && Boolean(links.ytHref)

  const ariaLabel = opensYoutube
    ? (ts
        ? `Open YouTube video for ${label}`
        : `Open YouTube video for Number ${parsed.number}`)
    : (links.pdfPage != null
        ? `Open Volume ${parsed.volume} PDF at page ${links.pdfPage}`
        : `Open Volume ${parsed.volume} PDF`)

  // Tooltip surfaces the retrieved passage; falls back to the raw citation.
  const hoverTitle = links.excerpt ?? parsed.raw

  const icon = opensYoutube
    ? <IconYoutube size={11} />
    : <IconPdf size={10} />

  const badgeClass = `citation-badge citation-badge--${sourceType}`

  if (href) {
    return (
      <a
        className={badgeClass}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={hoverTitle}
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="citation-source">{sourceLabel}</span>
        <span className="citation-label">{label}</span>
        <span className="citation-badge-icon" aria-hidden="true">{icon}</span>
      </a>
    )
  }

  return (
    <span className={badgeClass} title={hoverTitle}>
      <span className="citation-source">{sourceLabel}</span>
      <span className="citation-label">{label}</span>
    </span>
  )
}

interface CitationBadgeProps {
  content: string
  context?: CitationContext
}

export function CitationBadge({ content, context }: CitationBadgeProps) {
  return <>{highlightCitations(content, 'n', context ?? EMPTY_CONTEXT)}</>
}
