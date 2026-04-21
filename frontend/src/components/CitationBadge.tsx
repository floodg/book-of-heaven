import { Children, Fragment, cloneElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import './CitationBadge.css'

const CITATION_PATTERN =
  /\[(?:Book of Heaven Volume|Volume|Vol\.?)\s+\d+\s*[-–—][^\]\n]*?\d+[^\]\n]*?\]/gi

function splitStringIntoCitations(text: string, keyPrefix: string): ReactNode[] {
  const segments: ReactNode[] = []
  let lastIndex = 0
  let hitIndex = 0

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      segments.push(text.slice(lastIndex, start))
    }
    segments.push(
      <span key={`${keyPrefix}-cite-${hitIndex++}`} className="citation-badge">
        {match[0]}
      </span>,
    )
    lastIndex = start + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex))
  }

  return segments.length > 0 ? segments : [text]
}

export function highlightCitations(node: ReactNode, keyPrefix = 'n'): ReactNode {
  if (node == null || typeof node === 'boolean') return node

  if (typeof node === 'string') {
    const parts = splitStringIntoCitations(node, keyPrefix)
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  if (typeof node === 'number') return node

  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={`${keyPrefix}-${i}`}>
        {highlightCitations(child, `${keyPrefix}-${i}`)}
      </Fragment>
    ))
  }

  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>
    const childProp = element.props?.children
    if (childProp === undefined) return element
    return cloneElement(element, {
      children: Children.map(childProp, (child, i) =>
        highlightCitations(child, `${keyPrefix}-${i}`),
      ),
    })
  }

  return node
}

interface CitationBadgeProps {
  content: string
}

export function CitationBadge({ content }: CitationBadgeProps) {
  return <>{highlightCitations(content)}</>
}
