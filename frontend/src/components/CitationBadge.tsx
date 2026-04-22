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

// The inner pill. Renders the compact label ("Vol 4 · No 7 · 1:23:45") and up
// to two action icons — PDF and YouTube. Each action is a real anchor, not a
// button, so middle-click / cmd-click opens in a new tab the native way.
function CitationPill({
  parsed,
  links,
}: {
  parsed: ParsedCitation
  links: CitationLinks
}) {
  const ts = formatTimestamp(parsed.timestampSec)

  // Two kinds of citations, treated as two visually distinct sources:
  //   - "narrated"  — VTT transcript of Francis reading a Number aloud.
  //                   Carries a Number + (usually) a timestamp, links to
  //                   both the PDF page and the YouTube video.
  //   - "book"      — raw text from the Book of Heaven PDF itself, emitted
  //                   by the assistant when its retrieval hit the PDF
  //                   rather than a VTT. Carries only a volume (+ often a
  //                   date) and links to the PDF viewer.
  // The source type is encoded as a CSS modifier class so we can tint the
  // pill, and also rendered as a small leading text label so the type is
  // legible without relying on color alone (accessibility + colorblind
  // users).
  const sourceType: 'narrated' | 'book' = parsed.number != null ? 'narrated' : 'book'
  const sourceLabel = sourceType === 'narrated' ? 'Narrated' : 'Book'

  const labelParts: string[] = [`Vol ${parsed.volume}`]
  if (parsed.number != null) labelParts.push(`No ${parsed.number}`)
  if (ts) labelParts.push(ts)
  if (parsed.number == null && parsed.dateText) labelParts.push(parsed.dateText)
  const label = labelParts.join(' · ')

  const pdfTitle =
    links.pdfPage != null
      ? `Open Volume ${parsed.volume} PDF at page ${links.pdfPage}`
      : `Open Volume ${parsed.volume} PDF`
  const ytTitle =
    parsed.number != null
      ? ts
        ? `Open YouTube video for Number ${parsed.number} at ${ts}`
        : `Open YouTube video for Number ${parsed.number}`
      : ''

  // The excerpt tooltip goes on the outer span so hovering anywhere on the
  // pill surfaces the retrieved passage. Falls back to the original citation
  // text when no excerpt is available, which still lets the user see the
  // unabbreviated LLM citation.
  const hoverTitle = links.excerpt ?? parsed.raw

  return (
    <span
      className={`citation-badge citation-badge--${sourceType}`}
      title={hoverTitle}
    >
      <span className="citation-source">{sourceLabel}</span>
      <span className="citation-label">{label}</span>
      {links.pdfHref && (
        <a
          className="citation-action"
          href={links.pdfHref}
          target="_blank"
          rel="noreferrer noopener"
          title={pdfTitle}
          aria-label={pdfTitle}
          onClick={(e) => e.stopPropagation()}
        >
          <IconPdf size={12} />
        </a>
      )}
      {links.ytHref && (
        <a
          className="citation-action"
          href={links.ytHref}
          target="_blank"
          rel="noreferrer noopener"
          title={ytTitle}
          aria-label={ytTitle}
          onClick={(e) => e.stopPropagation()}
        >
          <IconYoutube size={12} />
        </a>
      )}
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
