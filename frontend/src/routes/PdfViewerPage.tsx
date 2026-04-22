import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
// pdfjs-dist ships two surfaces:
//   - `pdfjs-dist` (the low-level doc API: getDocument, PDFDocumentProxy, …)
//   - `pdfjs-dist/web/pdf_viewer.mjs` (EventBus, PDFViewer, PDFFindController,
//     PDFLinkService — the component library pdf.js's own viewer.html is
//     built from). We use the latter to get a proper virtualised pager with
//     a text layer, search highlighting, and zoom for free.
// The worker is pulled in as a Vite asset URL so the browser can spawn it
// without us hand-hosting copies of the file under /public. pdfjs-dist
// doesn't declare an `exports` map so these subpath imports resolve
// directly against the package's file tree.
import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import { IconArrowLeft, IconArrowRight, IconClose, IconSearch } from '../components/Icons'
import './PdfViewerPage.css'

// One-time worker wiring. pdfjs complains if this isn't set before the first
// getDocument call.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

// Minimal shape of the pdfjs find dispatch. pdfjs-dist@4 exports richer types
// but they're not part of the public .d.ts; this covers what we actually use.
interface FindEventPayload {
  source: unknown
  type: string
  query: string
  caseSensitive: boolean
  entireWord: boolean
  phraseSearch: boolean
  highlightAll: boolean
  findPrevious: boolean
}

function padVolumeSegment(raw: string | undefined): string {
  if (!raw) return '01'
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return '01'
  return String(n).padStart(2, '0')
}

export function PdfViewerPage() {
  const { volume } = useParams<{ volume: string }>()
  const [params, setParams] = useSearchParams()

  const volumePadded = useMemo(() => padVolumeSegment(volume), [volume])
  const pdfUrl = `/pdfs/Volume_${volumePadded}.pdf`

  const initialPage = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const initialQuery = params.get('q') ?? ''

  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerElRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const findControllerRef = useRef<PDFFindController | null>(null)

  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(initialPage)
  const [pageInput, setPageInput] = useState(String(initialPage))
  const [scale, setScale] = useState<number | 'page-width'>('page-width')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState(initialQuery)

  // One-shot init: construct the viewer, load the document, wire events.
  // This effect depends on `pdfUrl` so it tears down + rebuilds if the
  // volume in the URL changes (rare, but e.g. navigating between
  // /pdf/1?page=… and /pdf/4?page=… without a full page reload).
  useEffect(() => {
    const container = containerRef.current
    const viewerEl = viewerElRef.current
    if (!container || !viewerEl) return

    let cancelled = false
    setLoadError(null)
    setPageCount(0)

    let eventBus: EventBus
    let linkService: PDFLinkService
    let findController: PDFFindController
    let viewer: PDFViewer
    try {
      eventBus = new EventBus()
      linkService = new PDFLinkService({ eventBus })
      findController = new PDFFindController({ eventBus, linkService })
      // pdfjs-dist@4 only accepts TextLayerMode.DISABLE (0) or ENABLE (1);
      // the old ENABLE_ENHANCE=2 was removed. Omit so it takes the default.
      viewer = new PDFViewer({
        container,
        viewer: viewerEl,
        eventBus,
        linkService,
        findController,
      })
      linkService.setViewer(viewer)
    } catch (err: unknown) {
      // Any failure here means the viewer component library itself couldn't
      // be wired up — most commonly a pdfjs-dist version / API mismatch.
      // Surface it rather than dying into a blank tab.
      console.error('PDF viewer init failed:', err)
      setLoadError(
        err instanceof Error ? err.message : 'PDF viewer failed to initialize.',
      )
      return
    }

    eventBusRef.current = eventBus
    findControllerRef.current = findController
    viewerRef.current = viewer

    const onPagesInit = () => {
      if (cancelled) return
      setPageCount(viewer.pagesCount)
      viewer.currentScaleValue = 'page-width'
      // Jump to the requested page before the find runs so the highlight
      // lands near the viewport, not way above it.
      viewer.currentPageNumber = Math.min(initialPage, viewer.pagesCount)
    }
    const onPageChanging = (evt: { pageNumber: number }) => {
      if (cancelled) return
      setCurrentPage(evt.pageNumber)
      setPageInput(String(evt.pageNumber))
    }

    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('pagechanging', onPageChanging)

    const loading = pdfjsLib.getDocument({
      url: pdfUrl,
      // These CDN paths are where Mozilla hosts cmaps / fonts for their
      // viewer. Without them, some glyphs in the volumes render as blank
      // boxes. unpkg mirrors pdfjs-dist verbatim so this stays pinned to
      // whatever version we installed.
      cMapUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/standard_fonts/',
    })
    loading.promise
      .then((doc) => {
        if (cancelled) {
          doc.destroy().catch(() => {})
          return
        }
        viewer.setDocument(doc)
        linkService.setDocument(doc, null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('Failed to load PDF:', err)
        setLoadError(
          err instanceof Error ? err.message : 'Failed to load PDF. See console for details.',
        )
      })

    return () => {
      cancelled = true
      eventBus.off('pagesinit', onPagesInit)
      eventBus.off('pagechanging', onPageChanging)
      try {
        viewer.cleanup()
      } catch {
        // cleanup() may throw if the document never loaded; swallow it.
      }
      viewerRef.current = null
      eventBusRef.current = null
      findControllerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl])

  // After the viewer is alive and the initial query is present, kick off a
  // highlight-all find. This runs once per viewer init; subsequent searches
  // come through the search form below.
  useEffect(() => {
    if (!initialQuery) return
    const eventBus = eventBusRef.current
    if (!eventBus) return
    if (pageCount === 0) return

    // Defer so the text layer has a chance to render the initial page —
    // otherwise PDFFindController scores 0 matches and gives up silently.
    const timer = window.setTimeout(() => {
      dispatchFind(eventBus, initialQuery)
    }, 200)
    return () => window.clearTimeout(timer)
    // We only want this to fire once per pdf load + once the pager is ready;
    // further user-driven searches go through handleSearchSubmit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, initialQuery, pdfUrl])

  function dispatchFind(eventBus: EventBus, query: string) {
    const payload: FindEventPayload = {
      source: eventBus,
      type: '',
      query,
      caseSensitive: false,
      entireWord: false,
      phraseSearch: true,
      highlightAll: true,
      findPrevious: false,
    }
    eventBus.dispatch('find', payload)
  }

  function goToPage(n: number) {
    const viewer = viewerRef.current
    if (!viewer || viewer.pagesCount === 0) return
    const clamped = Math.min(Math.max(1, n), viewer.pagesCount)
    viewer.currentPageNumber = clamped
  }

  function handlePageInputSubmit(e: FormEvent) {
    e.preventDefault()
    const n = Number.parseInt(pageInput, 10)
    if (Number.isFinite(n) && n > 0) goToPage(n)
  }

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault()
    const eventBus = eventBusRef.current
    if (!eventBus) return
    dispatchFind(eventBus, searchInput)
    // Keep the URL in sync so a refresh / share re-highlights.
    const next = new URLSearchParams(params)
    if (searchInput) next.set('q', searchInput)
    else next.delete('q')
    next.set('page', String(currentPage))
    setParams(next, { replace: true })
  }

  function handleZoom(direction: 1 | -1) {
    const viewer = viewerRef.current
    if (!viewer) return
    const current = typeof viewer.currentScale === 'number' ? viewer.currentScale : 1
    const nextScale = Math.min(4, Math.max(0.25, current * (direction === 1 ? 1.2 : 1 / 1.2)))
    viewer.currentScaleValue = String(nextScale)
    setScale(nextScale)
  }

  function handleFitWidth() {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.currentScaleValue = 'page-width'
    setScale('page-width')
  }

  return (
    <div className="pdf-viewer-page">
      <header className="pdf-viewer-toolbar">
        <div className="pdf-viewer-toolbar-left">
          <Link to="/" className="pdf-viewer-close" title="Close viewer">
            <IconClose size={16} />
          </Link>
          <h1 className="pdf-viewer-title">Volume {Number.parseInt(volumePadded, 10)}</h1>
        </div>
        <div className="pdf-viewer-toolbar-center">
          <button
            type="button"
            className="pdf-viewer-icon-btn"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            <IconArrowLeft size={16} />
          </button>
          <form onSubmit={handlePageInputSubmit} className="pdf-viewer-page-input">
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
              onBlur={handlePageInputSubmit}
              aria-label="Current page"
            />
            <span className="pdf-viewer-page-total">/ {pageCount || '—'}</span>
          </form>
          <button
            type="button"
            className="pdf-viewer-icon-btn"
            onClick={() => goToPage(currentPage + 1)}
            disabled={pageCount > 0 && currentPage >= pageCount}
            title="Next page"
          >
            <IconArrowRight size={16} />
          </button>
        </div>
        <div className="pdf-viewer-toolbar-right">
          <form onSubmit={handleSearchSubmit} className="pdf-viewer-search">
            <IconSearch size={14} />
            <input
              type="search"
              placeholder="Search in this volume"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search in PDF"
            />
          </form>
          <div className="pdf-viewer-zoom">
            <button
              type="button"
              className="pdf-viewer-icon-btn"
              onClick={() => handleZoom(-1)}
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="pdf-viewer-icon-btn pdf-viewer-fit"
              onClick={handleFitWidth}
              title="Fit width"
            >
              {scale === 'page-width' ? 'Fit' : `${Math.round((scale as number) * 100)}%`}
            </button>
            <button
              type="button"
              className="pdf-viewer-icon-btn"
              onClick={() => handleZoom(1)}
              title="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </header>

      {loadError ? (
        <div className="pdf-viewer-error">
          <p>Could not display {pdfUrl}.</p>
          <p className="pdf-viewer-error-detail">{loadError}</p>
          <p>
            If this mentions a missing file, check that the PDF exists in{' '}
            <code>frontend/public/pdfs/</code>. Otherwise, open DevTools &rarr; Console for the
            underlying stack.
          </p>
        </div>
      ) : (
        // pdfjs-dist@4 enforces `getComputedStyle(container).position === "absolute"`
        // and throws otherwise. We therefore need a positioned parent (.pdf-viewer-
        // scroll-wrap) that the viewport scroller can latch onto via inset:0.
        <div className="pdf-viewer-scroll-wrap">
          <div ref={containerRef} className="pdf-viewer-container">
            <div ref={viewerElRef} className="pdfViewer" />
          </div>
        </div>
      )}
    </div>
  )
}
