import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { supabase } from '../lib/supabase'
import { generateThreadId } from '../lib/ids'
import { highlightCitations } from './CitationBadge'
import { StructuredCitations } from './StructuredCitations'
import type { Citation } from './StructuredCitations'
import { IconCopy, IconFolder } from './Icons'
import type { AnythingLlmSource } from '../lib/sources'
import { useYoutubeMap } from '../lib/YoutubeMapContext'
import { usePdfPages, type PdfPagesIndex } from '../lib/PdfPagesContext'
import { SourceToggle } from './SourceToggle'
import {
  CHAT_MODELS,
  LEGACY_CHAT_MODELS,
  DEFAULT_MODEL_SENTINEL,
  ModelSelector,
} from './ModelSelector'
import {
  useBothReplyLayout,
  type BothReplyLayout,
} from '../lib/bothReplyLayout'
import { usePreferredSource, type Source } from '../lib/source'
import { useWorkspace } from '../lib/WorkspaceContext'
import './ChatWindow.css'

// What the user asked for on a user row, vs. which workspace produced an
// assistant row. The user value can be 'both'; assistant rows are always
// single-source. Legacy rows (pre-migration 007) carry null.
type UserSource = Source
type AssistantSource = 'text' | 'narrated'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  // Retrieval sources AnythingLLM returned for this (assistant) turn.
  // Null / undefined for user messages and for assistant messages written
  // before migration 006 added the column.
  sources?: AnythingLlmSource[] | null
  // Structured citations from the pgvector RAG path (research_messages).
  citations?: Citation[] | null
  // Workspace this row came from (assistant) / was targeted at (user).
  // Null for rows inserted before migration 007.
  source?: UserSource | AssistantSource | null
  // Groups a user row with its 1-2 assistant replies. Null for pre-007 rows;
  // those keep rendering one-bubble-per-row as they did before.
  turn_id?: string | null
}

// When VITE_USE_PGVECTOR_RAG=true the ChatWindow uses the research-chat edge
// function and reads/writes research_messages instead of chat_messages.
const RAG_ENABLED = import.meta.env.VITE_USE_PGVECTOR_RAG === 'true'
const CHAT_ENDPOINT = RAG_ENABLED ? 'research-chat' : 'chat-proxy'
const MESSAGES_TABLE = RAG_ENABLED ? 'research_messages' : 'chat_messages'
const THREADS_TABLE = RAG_ENABLED ? 'research_threads' : 'chat_threads'
const THREAD_ID_COL = RAG_ENABLED ? 'id' : 'thread_id'
const THREAD_MODEL_COL = RAG_ENABLED ? 'selected_model' : 'model'

// Module-level cache of "messages I just rendered locally for thread X".
// The chat flow is: user submits a message on "/" or /projects/:id, we mint a
// thread UUID, render both bubbles client-side, then navigate to `/c/:id` so
// the URL reflects the real thread. React Router unmounts the current
// ChatWindow during that navigation and remounts a new one for the new route,
// which kicks off a Supabase fetch for the thread's messages. Without this
// cache, the chat area briefly goes blank (fresh component, empty state)
// until the DB round-trip lands — visible ~50-200ms flicker right after the
// assistant finishes speaking.
//
// We stash the just-rendered messages here keyed by thread id. The remounted
// ChatWindow finds them and seeds state from the cache instead of from the
// DB, then deletes the entry. Cache entries also auto-expire so a stale
// navigation (e.g. back button hours later) still goes through the normal
// fetch path.
interface FreshThreadCacheEntry {
  messages: Message[]
  ts: number
}
const freshThreadCache = new Map<string, FreshThreadCacheEntry>()
const FRESH_THREAD_CACHE_TTL_MS = 10_000
const MODEL_STORAGE_KEY = 'boh.model'
const ACTIVE_MODELS = RAG_ENABLED ? CHAT_MODELS : LEGACY_CHAT_MODELS
const CHAT_MODEL_VALUES = new Set(ACTIVE_MODELS.map((m) => m.value))

/** Optimistic new-chat state while a job is in flight, so "/ → other thread → /" can restore. */
const newChatPendingCache = new Map<string, FreshThreadCacheEntry>()
const NEW_CHAT_PENDING_TTL_MS = 15 * 60 * 1000

// highlightCitations recursively descends into nested children, so we only
// need to apply it at block level. Applying it at both block and inline
// levels (e.g. strong, em) causes double-wrapping and nested pills.
//
// The factory here closes over the active message's retrieval sources and
// the session's YouTube map, so each citation pill can resolve its own PDF
// page + video timestamp links without threading those arguments through
// react-markdown. A fresh `Components` object per message keeps the
// highlighter pure (input → output) instead of pulling from module state.
function makeMarkdownComponents(ctx: {
  sources: AnythingLlmSource[] | null
  youtubeMap: Record<string, string>
  pdfPages: PdfPagesIndex
}): Components {
  const h = (node: ReactNode) => highlightCitations(node, 'n', ctx)
  return {
    p: ({ children }) => <p>{h(children)}</p>,
    li: ({ children }) => <li>{h(children)}</li>,
    h1: ({ children }) => <h1>{h(children)}</h1>,
    h2: ({ children }) => <h2>{h(children)}</h2>,
    h3: ({ children }) => <h3>{h(children)}</h3>,
    h4: ({ children }) => <h4>{h(children)}</h4>,
    blockquote: ({ children }) => <blockquote>{h(children)}</blockquote>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),
  }
}

// Small helper so the per-message Components factory is memoized on the three
// inputs that actually affect the output — avoids rebuilding it (and every
// react-markdown node) on unrelated parent re-renders.
function AssistantMarkdown({
  content,
  sources,
  youtubeMap,
  pdfPages,
}: {
  content: string
  sources: AnythingLlmSource[] | null
  youtubeMap: Record<string, string>
  pdfPages: PdfPagesIndex
}) {
  const components = useMemo(
    () => makeMarkdownComponents({ sources, youtubeMap, pdfPages }),
    [sources, youtubeMap, pdfPages],
  )
  return (
    <div className="chat-bubble-markdown">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  )
}

function sourceSectionTitle(s: AssistantSource): string {
  return s === 'text'
    ? 'Book of Heaven text only'
    : 'Francis Hogan Book of Heaven Narration'
}

const BOTH_LAYOUT_OPTIONS: {
  value: BothReplyLayout
  label: string
  title: string
}[] = [
  {
    value: 'split',
    label: 'Side by side',
    title: 'Show text and narration in two columns',
  },
  {
    value: 'tab',
    label: 'Tab view',
    title: 'Switch between sources using a sticky side tab',
  },
]

function BothLayoutToggle({
  value,
  onChange,
  disabled,
}: {
  value: BothReplyLayout
  onChange: (next: BothReplyLayout) => void
  disabled?: boolean
}) {
  return (
    <div
      className="both-layout-toggle"
      role="radiogroup"
      aria-label="Layout for text and narration replies"
    >
      {BOTH_LAYOUT_OPTIONS.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={opt.title}
            disabled={disabled}
            className={
              selected
                ? 'both-layout-toggle-option both-layout-toggle-option-selected'
                : 'both-layout-toggle-option'
            }
            onClick={() => {
              if (disabled || selected) return
              onChange(opt.value)
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function SplitTurnTabs({
  assistants,
  youtubeMap,
  pdfPages,
}: {
  assistants: Message[]
  youtubeMap: Record<string, string>
  pdfPages: PdfPagesIndex
}) {
  const [activeIdx, setActiveIdx] = useState(0)
  const safeIdx = activeIdx < assistants.length ? activeIdx : 0
  const active = assistants[safeIdx]
  return (
    <div className="chat-turn-tabs">
      <div className="chat-tab-strip">
        {assistants.map((m, i) => {
          const title =
            m.source === 'text' || m.source === 'narrated'
              ? sourceSectionTitle(m.source)
              : 'Reply'
          const accentKey = m.source === 'text' ? 'text' : 'narrated'
          return (
            <button
              key={m.id}
              type="button"
              className={[
                'chat-tab-btn',
                `chat-tab-btn-${accentKey}`,
                i === safeIdx ? 'chat-tab-btn-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setActiveIdx(i)}
              aria-selected={i === safeIdx}
              role="tab"
            >
              {title}
            </button>
          )
        })}
      </div>
      <div className="chat-tab-content" role="tabpanel">
        <AssistantBubble
          message={active}
          youtubeMap={youtubeMap}
          pdfPages={pdfPages}
          showChip={false}
        />
      </div>
    </div>
  )
}

function CopyQuestionButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="chat-copy-question"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
          } catch {
            /* clipboard unavailable */
          }
        })()
      }}
      aria-label={copied ? 'Copied' : 'Copy question'}
    >
      <IconCopy size={13} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function AssistantBubble({
  message,
  youtubeMap,
  pdfPages,
  showChip,
}: {
  message: Message
  youtubeMap: Record<string, string>
  pdfPages: PdfPagesIndex
  showChip: boolean
}) {
  // Only label rows whose source is a concrete workspace; the chip is pure
  // noise on legacy rows and would also mislabel the rare case where an
  // assistant row accidentally carries the user's 'both' selector.
  const chipSource: AssistantSource | null =
    message.source === 'text' || message.source === 'narrated'
      ? message.source
      : null
  return (
    <div className="chat-bubble chat-bubble-assistant">
      {showChip && chipSource ? (
        <div
          className={`chat-bubble-source-chip chat-bubble-source-chip-${chipSource}`}
        >
          {sourceSectionTitle(chipSource)}
        </div>
      ) : null}
      <AssistantMarkdown
        content={message.content}
        sources={message.sources ?? null}
        youtubeMap={youtubeMap}
        pdfPages={pdfPages}
      />
      {message.citations && message.citations.length > 0 && (
        <StructuredCitations citations={message.citations} />
      )}
    </div>
  )
}

// A "turn" groups messages sharing a turn_id: typically the user's question
// plus 1 or 2 assistant replies (one reply per workspace when source='both').
// Legacy rows without a turn_id fall back to one turn per row so they keep
// rendering exactly like they did pre-migration 007.
interface Turn {
  key: string
  user: Message | null
  assistants: Message[]
}

function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  const byTurnId = new Map<string, Turn>()
  for (const m of messages) {
    const tid = m.turn_id ?? null
    if (!tid) {
      turns.push({
        key: `msg-${m.id}`,
        user: m.role === 'user' ? m : null,
        assistants: m.role === 'assistant' ? [m] : [],
      })
      continue
    }
    let turn = byTurnId.get(tid)
    if (!turn) {
      turn = { key: `turn-${tid}`, user: null, assistants: [] }
      byTurnId.set(tid, turn)
      turns.push(turn)
    }
    if (m.role === 'user') {
      turn.user = m
    } else {
      turn.assistants.push(m)
    }
  }
  // Within a split turn, keep "Text" on the left and "Narrated" on the right
  // regardless of which AnythingLLM call landed in the DB first. This also
  // stabilizes the layout between the in-memory submit path and the refetch
  // path where ordering depends on Supabase's created_at resolution.
  for (const t of turns) {
    if (t.assistants.length > 1) {
      t.assistants.sort((a, b) => {
        const rank = (s: Message['source']) =>
          s === 'text' ? 0 : s === 'narrated' ? 1 : 2
        return rank(a.source) - rank(b.source)
      })
    }
  }
  return turns
}

interface ChatWindowProps {
  user: User
  session: Session
  threadId: string | null
  /** When set, and this is the very first message in the thread, the edge
   *  function stamps the new thread with this project_id. Ignored once the
   *  thread already exists on the server. */
  projectId?: string | null
  /** If present, auto-submit this as the thread's first user message on
   *  mount. Used by the project detail page, which generates the thread
   *  UUID then hands control off to ChatWindow. */
  initialMessage?: string | null
  /** Optional source to use for the auto-submitted initial message. Defaults
   *  to the user's persisted preference when omitted. */
  initialSource?: Source | null
  /** Small breadcrumb shown above the messages when the active thread
   *  belongs to a project. Purely presentational; ChatPage looks these
   *  up from WorkspaceContext + route state and passes them in. */
  breadcrumb?: {
    projectId: string
    projectName: string
    threadTitle?: string | null
  } | null
  onAssistantResponse?: (threadId: string) => void
  /** After HTTP 202 on `/`, refresh workspace and navigate to `/c/:id` with optional SSE resume state. */
  onThreadAccepted?: (
    threadId: string,
    resume: { jobId: string; turnId: string } | null,
  ) => void | Promise<void>
  /** When set, reconnect to `chat-job-events` for an in-flight turn after early navigation from `/`. */
  resumeChatJob?: {
    jobId: string
    turnId: string
    threadId: string
  } | null
  /** Strip `resumeChatJob` from route state after terminal SSE or error. */
  onClearResumeChatJob?: () => void
}

export function ChatWindow({
  user,
  session,
  threadId,
  projectId,
  initialMessage,
  initialSource,
  breadcrumb,
  onAssistantResponse,
  onThreadAccepted,
  resumeChatJob,
  onClearResumeChatJob,
}: ChatWindowProps) {
  const { threads } = useWorkspace()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null)
  const [pendingNewChatThreadId, setPendingNewChatThreadId] = useState<
    string | null
  >(null)
  const [source, setSource] = usePreferredSource()
  const [volumeFilter, setVolumeFilter] = useState<number | null>(null)
  const [bothReplyLayout, setBothReplyLayout] = useBothReplyLayout()
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(MODEL_STORAGE_KEY)
      if (stored && CHAT_MODEL_VALUES.has(stored)) return stored
    } catch {
      // localStorage may be unavailable in hardened browsers.
    }
    return DEFAULT_MODEL_SENTINEL
  })
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const youtubeMap = useYoutubeMap()
  const pdfPages = usePdfPages()
  // When this component itself creates a new thread (fresh chat + first message),
  // the parent will echo that thread_id back as a prop change. We skip the one
  // refetch that would otherwise replace our just-added local messages with
  // identical DB rows (and briefly flicker).
  const skipNextFetchForRef = useRef<string | null>(null)
  // initialMessage auto-submit fires exactly once per "initial message payload".
  // Without this guard, StrictMode double-mounts would submit twice, and any
  // re-render after the first submit would also re-fire. We key the ref by the
  // message string so navigating to a fresh project detail → submit cycle with
  // a different draft still works.
  const autoSubmittedRef = useRef<string | null>(null)
  const processedTurnIdsRef = useRef<Set<string>>(new Set())
  const pendingTurnIdRef = useRef<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const onAssistantResponseRef = useRef(onAssistantResponse)
  onAssistantResponseRef.current = onAssistantResponse
  const activeThreadModel =
    threadId == null
      ? null
      : (threads.find((t) => t.threadId === threadId)?.model ?? null)

  const closeJobEventSource = () => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }

  useEffect(() => {
    const fallback = (() => {
      try {
        const stored = localStorage.getItem(MODEL_STORAGE_KEY)
        if (stored && CHAT_MODEL_VALUES.has(stored)) return stored
      } catch {
        // Ignore localStorage failures and use default.
      }
      return DEFAULT_MODEL_SENTINEL
    })()
    if (threadId == null) {
      setSelectedModel(fallback)
      return
    }
    const threadModel =
      activeThreadModel && CHAT_MODEL_VALUES.has(activeThreadModel)
        ? activeThreadModel
        : fallback
    setSelectedModel(threadModel)
  }, [threadId, activeThreadModel])

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel)
    } catch {
      // Ignore write failures in private mode.
    }
  }, [selectedModel])

  const handleModelChange = useCallback(
    (model: string) => {
      if (!CHAT_MODEL_VALUES.has(model)) return
      setSelectedModel(model)
      if (!threadId) return
      void supabase
        .from(THREADS_TABLE)
        .update({
          [THREAD_MODEL_COL]: model,
          updated_at: new Date().toISOString(),
        })
        .eq(THREAD_ID_COL, threadId)
        .eq('user_id', user.id)
    },
    [threadId, user.id],
  )

  useEffect(() => {
    return () => {
      closeJobEventSource()
    }
  }, [])

  const endInFlightUi = useCallback(() => {
    setLoading(false)
    setLoadingThreadId(null)
    setPendingNewChatThreadId(null)
  }, [])

  const applyJobPayload = useCallback(
    (
      submitTurnId: string,
      submitThreadId: string,
      isNewThread: boolean,
      payload: { replies?: unknown },
    ) => {
      if (processedTurnIdsRef.current.has(submitTurnId)) return
      const rawReplies = Array.isArray(payload?.replies) ? payload.replies : []
      const parsedReplies: Array<{
        source: AssistantSource
        reply: string
        sources: AnythingLlmSource[] | null
        citations: Citation[] | null
      }> = []
      for (const r of rawReplies) {
        if (!r || typeof r !== 'object') continue
        const rec = r as Record<string, unknown>
        const s = rec.source
        if (s !== 'text' && s !== 'narrated') continue
        const replyRaw = rec.reply
        const replyText =
          typeof replyRaw === 'string'
            ? replyRaw
            : replyRaw == null
              ? '(The assistant returned an empty response.)'
              : `(Unexpected response shape)\n\n${JSON.stringify(replyRaw, null, 2)}`
        const sourcesVal = Array.isArray(rec.sources) && rec.sources.length > 0
          ? (rec.sources as AnythingLlmSource[])
          : null
        const citationsVal = Array.isArray(rec.citations) && rec.citations.length > 0
          ? (rec.citations as Citation[])
          : null
        parsedReplies.push({ source: s, reply: replyText, sources: sourcesVal, citations: citationsVal })
      }

      let assistantMessages: Message[]
      if (parsedReplies.length > 0) {
        const tsBase = Date.now()
        assistantMessages = parsedReplies.map((r, i) => ({
          id: `local-${tsBase}-a-${i}`,
          role: 'assistant' as const,
          content: r.reply,
          created_at: new Date(tsBase + i).toISOString(),
          sources: r.sources,
          citations: r.citations,
          source: r.source,
          turn_id: submitTurnId,
        }))
      } else {
        assistantMessages = [
          {
            id: `local-${Date.now()}-a-empty`,
            role: 'assistant',
            content: '(The assistant returned an empty response.)',
            created_at: new Date().toISOString(),
            turn_id: submitTurnId,
          },
        ]
      }

      processedTurnIdsRef.current.add(submitTurnId)
      pendingTurnIdRef.current = null
      newChatPendingCache.delete(submitThreadId)
      setMessages((prev) => {
        const next = [...prev, ...assistantMessages]
        if (isNewThread) {
          freshThreadCache.set(submitThreadId, {
            messages: next,
            ts: Date.now(),
          })
        }
        return next
      })
      if (isNewThread) {
        skipNextFetchForRef.current = submitThreadId
      }
      onAssistantResponseRef.current?.(submitThreadId)
    },
    [],
  )

  useEffect(() => {
    if (!resumeChatJob || !threadId) return
    if (resumeChatJob.threadId !== threadId) return

    pendingTurnIdRef.current = resumeChatJob.turnId
    setLoading(true)
    setLoadingThreadId(threadId)

    const submitTurnId = resumeChatJob.turnId
    const submitThreadId = resumeChatJob.threadId
    const isNewThread = true

    const esUrl = new URL(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-job-events`,
    )
    esUrl.searchParams.set('job_id', resumeChatJob.jobId)
    esUrl.searchParams.set('access_token', session.access_token)
    const es = new EventSource(esUrl.toString())
    eventSourceRef.current = es

    es.onmessage = (ev) => {
      let data: { event?: string; payload?: { replies?: unknown }; error?: string }
      try {
        data = JSON.parse(ev.data) as typeof data
      } catch {
        return
      }
      if (data.event === 'status') return
      if (data.event === 'timeout') {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        onClearResumeChatJob?.()
        endInFlightUi()
        return
      }
      if (data.event === 'error') {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        if (processedTurnIdsRef.current.has(submitTurnId)) return
        const msg =
          data.error ?? 'The assistant could not complete this turn.'
        processedTurnIdsRef.current.add(submitTurnId)
        pendingTurnIdRef.current = null
        newChatPendingCache.delete(submitThreadId)
        endInFlightUi()
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}-sse-err-resume`,
            role: 'assistant' as const,
            content: msg,
            created_at: new Date().toISOString(),
            turn_id: submitTurnId,
          },
        ])
        onClearResumeChatJob?.()
        return
      }
      if (data.event === 'complete' && data.payload) {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        if (processedTurnIdsRef.current.has(submitTurnId)) return
        applyJobPayload(submitTurnId, submitThreadId, isNewThread, data.payload)
        endInFlightUi()
      }
    }
    es.onerror = () => {
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null
    }

    return () => {
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null
    }
  }, [
    resumeChatJob,
    threadId,
    session.access_token,
    applyJobPayload,
    endInFlightUi,
    onClearResumeChatJob,
  ])

  const replyInProgressHere = useMemo(
    () =>
      Boolean(
        loading &&
          loadingThreadId != null &&
          (threadId === loadingThreadId ||
            (threadId === null &&
              pendingNewChatThreadId != null &&
              pendingNewChatThreadId === loadingThreadId)),
      ),
    [loading, loadingThreadId, threadId, pendingNewChatThreadId],
  )

  useEffect(() => {
    let cancelled = false

    if (!threadId) {
      if (loadingThreadId) {
        const cached = newChatPendingCache.get(loadingThreadId)
        if (
          cached &&
          Date.now() - cached.ts < NEW_CHAT_PENDING_TTL_MS
        ) {
          if (!cancelled) {
            setMessages(cached.messages)
          }
          return
        }
      }
      if (!cancelled) setMessages([])
      return
    }

    if (skipNextFetchForRef.current === threadId) {
      skipNextFetchForRef.current = null
      return
    }

    // Consume a fresh-thread cache entry if one exists for this thread. This
    // covers the "just submitted the first message on / or /projects/:id,
    // routed to /c/:id, remounted" path — we skip the DB fetch and seed
    // state from what the previous ChatWindow instance just rendered.
    const cached = freshThreadCache.get(threadId)
    if (cached && Date.now() - cached.ts < FRESH_THREAD_CACHE_TTL_MS) {
      freshThreadCache.delete(threadId)
      setMessages(cached.messages)
      return
    }
    if (cached) freshThreadCache.delete(threadId)

    supabase
      .from(MESSAGES_TABLE)
      .select('*')
      .eq('user_id', user.id)
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error('Failed to load thread messages', error)
          return
        }
        setMessages((data ?? []) as Message[])
      })

    return () => {
      cancelled = true
    }
  }, [threadId, user.id, loadingThreadId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, replyInProgressHere])

  useEffect(() => {
    if (!threadId) return

    const channel = supabase
      .channel(`thread-realtime-${user.id}-${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: MESSAGES_TABLE,
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as {
            role?: string
            thread_id?: string
            turn_id?: string | null
          }
          if (row.role !== 'assistant' || row.thread_id !== threadId) return
          const tid = row.turn_id
          if (!tid) return
          if (tid !== pendingTurnIdRef.current) return
          if (processedTurnIdsRef.current.has(tid)) return

          void (async () => {
            if (processedTurnIdsRef.current.has(tid)) return
            const { data: urow } = await supabase
              .from(MESSAGES_TABLE)
              .select('source')
              .eq('user_id', user.id)
              .eq('thread_id', threadId)
              .eq('turn_id', tid)
              .eq('role', 'user')
              .limit(1)
              .maybeSingle()
            const userSource = urow?.source as
              | UserSource
              | undefined
            const expectAssistants =
              userSource === 'both' ? 2 : userSource ? 1 : 1
            const { data, error } = await supabase
              .from(MESSAGES_TABLE)
              .select('*')
              .eq('user_id', user.id)
              .eq('thread_id', threadId)
              .eq('turn_id', tid)
              .order('created_at', { ascending: true })
            if (error) {
              console.error('Failed to load turn after realtime', error)
              return
            }
            const assistants = (data ?? []).filter(
              (m) => m.role === 'assistant',
            ) as Message[]
            if (assistants.length < expectAssistants) return
            if (processedTurnIdsRef.current.has(tid)) return
            processedTurnIdsRef.current.add(tid)
            pendingTurnIdRef.current = null
            closeJobEventSource()
            endInFlightUi()
            setMessages((prev) => {
              const rest = prev.filter(
                (m) => !(m.turn_id === tid && m.role === 'assistant'),
              )
              return [...rest, ...assistants]
            })
            onAssistantResponseRef.current?.(threadId)
          })()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [threadId, user.id, endInFlightUi])

  const submitMessage = async (
    messageText: string,
    overrideSource?: Source,
  ) => {
    // One in-flight request at a time (shared refs) — block until it finishes.
    if (!messageText || loading) return

    const effectiveSource: Source = overrideSource ?? source
    const isNewThread = !threadId
    const submitThreadId = threadId ?? generateThreadId()
    const submitTurnId = generateThreadId()

    closeJobEventSource()
    processedTurnIdsRef.current.delete(submitTurnId)
    pendingTurnIdRef.current = submitTurnId

    setLoadingThreadId(submitThreadId)
    if (isNewThread) {
      setPendingNewChatThreadId(submitThreadId)
    } else {
      setPendingNewChatThreadId(null)
    }

    const now = new Date().toISOString()
    const userMessage: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: messageText,
      created_at: now,
      source: effectiveSource,
      turn_id: submitTurnId,
    }

    setMessages((prev) => {
      const next = [...prev, userMessage]
      if (isNewThread) {
        newChatPendingCache.set(submitThreadId, {
          messages: next,
          ts: Date.now(),
        })
      }
      return next
    })
    setInput('')
    setLoading(true)

    const body: Record<string, unknown> = {
      message: messageText,
      thread_id: submitThreadId,
      turn_id: submitTurnId,
      source: effectiveSource,
      model: selectedModel,
    }
    if (projectId) body.project_id = projectId
    if (RAG_ENABLED && volumeFilter !== null) body.volume_filter = volumeFilter

    let deferLoadingInFinally = false

    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${CHAT_ENDPOINT}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      )

      if (res.status === 409) {
        pendingTurnIdRef.current = null
        let errText = 'This turn failed. Send a new message to retry.'
        try {
          const b = (await res.json()) as { error?: unknown }
          if (typeof b?.error === 'string' && b.error.trim()) errText = b.error
        } catch {
          // ignore
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}-err`,
            role: 'assistant' as const,
            content: errText,
            created_at: new Date().toISOString(),
            turn_id: submitTurnId,
          },
        ])
        return
      }

      if (!res.ok) {
        let serverError: string | null = null
        try {
          const errBody = (await res.clone().json()) as { error?: unknown }
          if (typeof errBody?.error === 'string' && errBody.error.trim().length > 0) {
            serverError = errBody.error
          }
        } catch {
          // Non-JSON body or parse failure.
        }

        if (res.status === 401) {
          const errorMessage: Message = {
            id: `local-${Date.now()}-err`,
            role: 'assistant',
            content:
              'Your session has expired or is no longer valid. Signing you out — please log in again.',
            created_at: new Date().toISOString(),
            turn_id: submitTurnId,
          }
          setMessages((prev) => [...prev, errorMessage])
          pendingTurnIdRef.current = null
          void supabase.auth.signOut().catch((signOutErr) => {
            console.warn('Sign-out after 401 failed (ignored):', signOutErr)
          })
          return
        }

        const friendly =
          serverError ??
          (res.status >= 500
            ? 'The server hit an unexpected error. Please try again in a moment.'
            : res.status === 400
              ? 'The request was rejected. Please refresh the page and try again.'
              : `Request failed with status ${res.status}.`)
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}-err`,
            role: 'assistant' as const,
            content: friendly,
            created_at: new Date().toISOString(),
            turn_id: submitTurnId,
          },
        ])
        pendingTurnIdRef.current = null
        return
      }

      if (res.status === 202) {
        const jobMeta = (await res.json()) as { job_id?: string }
        const jobId = jobMeta?.job_id
        if (!jobId) {
          console.error('202 without job_id')
          pendingTurnIdRef.current = null
          return
        }
        if (isNewThread && onThreadAccepted) {
          deferLoadingInFinally = true
          await onThreadAccepted(submitThreadId, { jobId, turnId: submitTurnId })
          return
        }
        deferLoadingInFinally = true
        const esUrl = new URL(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-job-events`,
        )
        esUrl.searchParams.set('job_id', jobId)
        esUrl.searchParams.set('access_token', session.access_token)
        const es = new EventSource(esUrl.toString())
        eventSourceRef.current = es
        es.onmessage = (ev) => {
          let data: { event?: string; payload?: { replies?: unknown }; error?: string }
          try {
            data = JSON.parse(ev.data) as typeof data
          } catch {
            return
          }
          if (data.event === 'status') return
          if (data.event === 'timeout') {
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            return
          }
          if (data.event === 'error') {
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            if (processedTurnIdsRef.current.has(submitTurnId)) return
            const msg =
              data.error ?? 'The assistant could not complete this turn.'
            processedTurnIdsRef.current.add(submitTurnId)
            pendingTurnIdRef.current = null
            newChatPendingCache.delete(submitThreadId)
            endInFlightUi()
            setMessages((prev) => [
              ...prev,
              {
                id: `local-${Date.now()}-sse-err`,
                role: 'assistant' as const,
                content: msg,
                created_at: new Date().toISOString(),
                turn_id: submitTurnId,
              },
            ])
            return
          }
          if (data.event === 'complete' && data.payload) {
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            if (processedTurnIdsRef.current.has(submitTurnId)) return
            applyJobPayload(
              submitTurnId,
              submitThreadId,
              isNewThread,
              data.payload,
            )
            endInFlightUi()
          }
        }
        es.onerror = () => {
          es.close()
          if (eventSourceRef.current === es) eventSourceRef.current = null
          // Realtime on this thread will still deliver assistant rows; keep
          // loading true until that fires or the user navigates.
        }
        return
      }

      const payload = (await res.json()) as { replies?: unknown }
      if (processedTurnIdsRef.current.has(submitTurnId)) {
        pendingTurnIdRef.current = null
        return
      }
      if (isNewThread && onThreadAccepted) {
        await onThreadAccepted(submitThreadId, null)
        return
      }
      applyJobPayload(submitTurnId, submitThreadId, isNewThread, payload)
    } catch (err) {
      console.error('Chat request failed (network)', err)
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}-err`,
          role: 'assistant' as const,
          content:
            'Could not reach the assistant. Check that the Supabase functions server is running and try again.',
          created_at: new Date().toISOString(),
          turn_id: submitTurnId,
        },
      ])
      pendingTurnIdRef.current = null
    } finally {
      if (!deferLoadingInFinally) {
        endInFlightUi()
      }
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) return
    void submitMessage(trimmed)
  }

  // Auto-submit the initial message handed down from a project detail page.
  // Runs exactly once per distinct initialMessage value — see autoSubmittedRef.
  useEffect(() => {
    if (!initialMessage) return
    const trimmed = initialMessage.trim()
    if (!trimmed) return
    if (autoSubmittedRef.current === trimmed) return
    autoSubmittedRef.current = trimmed
    void submitMessage(trimmed, initialSource ?? undefined)
    // submitMessage is stable-enough in practice (closes over current state)
    // but listing it in deps would fire infinite submits; the ref guard is
    // what actually enforces once-per-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage])

  // "Empty landing" layout: no messages yet, not currently loading a reply
  // for *this* view, and not mid-auto-submit from ProjectDetailPage. In that
  // state the input lives centered under a greeting; the moment the first
  // exchange starts we fall through to the normal layout with the bar pinned
  // at the bottom.
  const isEmpty =
    messages.length === 0 &&
    !replyInProgressHere &&
    !initialMessage &&
    !threadId

  const hasSplitTurns = useMemo(
    () => groupIntoTurns(messages).some((t) => t.assistants.length > 1),
    [messages],
  )
  const showBothLayoutToggle = source === 'both' || hasSplitTurns

  const inputBar = (
    <form className="chat-input-bar" onSubmit={handleSubmit}>
      <div className="chat-input-bar-inner">
        <div className="chat-input-bar-row">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask about the Book of Heaven..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            autoFocus
          />
          <button
            type="submit"
            className="chat-send"
            disabled={loading || input.trim().length === 0}
          >
            Send
          </button>
        </div>
        <div className="chat-input-bar-toggles">
          <SourceToggle value={source} onChange={setSource} disabled={loading} />
          {RAG_ENABLED && (
            <select
              className="volume-filter-select"
              value={volumeFilter ?? ''}
              onChange={(e) => setVolumeFilter(e.target.value === '' ? null : Number(e.target.value))}
              disabled={loading}
              title="Filter by volume"
            >
              <option value="">All volumes</option>
              {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Volume {n}</option>
              ))}
            </select>
          )}
          <ModelSelector
            value={selectedModel}
            onChange={handleModelChange}
            disabled={loading}
            models={RAG_ENABLED ? CHAT_MODELS : LEGACY_CHAT_MODELS}
          />
          {showBothLayoutToggle ? (
            <BothLayoutToggle
              value={bothReplyLayout}
              onChange={setBothReplyLayout}
              disabled={loading}
            />
          ) : null}
        </div>
      </div>
    </form>
  )

  const breadcrumbBar = breadcrumb ? (
    <div className="chat-breadcrumb">
      <div className="chat-breadcrumb-inner">
        <Link
          to={`/projects/${breadcrumb.projectId}`}
          className="chat-breadcrumb-project"
          title={`Back to ${breadcrumb.projectName}`}
        >
          <IconFolder size={13} />
          <span>{breadcrumb.projectName}</span>
        </Link>
        {breadcrumb.threadTitle ? (
          <>
            <span className="chat-breadcrumb-separator">/</span>
            <span className="chat-breadcrumb-thread">{breadcrumb.threadTitle}</span>
          </>
        ) : null}
      </div>
    </div>
  ) : null

  if (isEmpty) {
    return (
      <div className="chat-window chat-window-empty">
        {breadcrumbBar}
        <div className="chat-empty-center">
          <div className="chat-empty-inner">
            <h1 className="chat-empty-greeting">How can I help you today?</h1>
            {inputBar}
          </div>
        </div>
      </div>
    )
  }

  const turns = groupIntoTurns(messages)

  return (
    <div className="chat-window">
      {breadcrumbBar}
      <div className="chat-messages">
        <div className="chat-messages-inner">
          {turns.map((turn) => {
            const userBubble = turn.user ? (
              <div
                key={`${turn.key}-user`}
                className="chat-bubble-row chat-bubble-row-user"
              >
                <div className="chat-user-question-wrap">
                  <div className="chat-bubble chat-bubble-user">
                    {turn.user.content}
                  </div>
                  <CopyQuestionButton text={turn.user.content} />
                </div>
              </div>
            ) : null

            // Split layout: user asked for "both" and we have more than one
            // assistant reply to display side-by-side. A single-reply turn
            // (even if the user picked "both" but only one workspace came
            // back) falls through to the stacked path so the lone reply
            // takes full width instead of a lonely column.
            const split = turn.assistants.length > 1

            if (split) {
              if (bothReplyLayout === 'tab') {
                return (
                  <div
                    key={turn.key}
                    className="chat-turn chat-turn-split-wrap"
                  >
                    {userBubble}
                    <SplitTurnTabs
                      assistants={turn.assistants}
                      youtubeMap={youtubeMap}
                      pdfPages={pdfPages}
                    />
                  </div>
                )
              }
              return (
                <div key={turn.key} className="chat-turn chat-turn-split-wrap">
                  {userBubble}
                  <div className="chat-turn-split">
                    {turn.assistants.map((m) => (
                      <div
                        key={m.id}
                        className="chat-bubble-row chat-bubble-row-assistant chat-bubble-row-split"
                      >
                        <AssistantBubble
                          message={m}
                          youtubeMap={youtubeMap}
                          pdfPages={pdfPages}
                          showChip
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            }

            // When tab layout is active and this is a single-source reply,
            // wrap it in the same chat-turn-tabs shell so the content column
            // stays aligned with split-source tab turns above/below it.
            if (bothReplyLayout === 'tab' && turn.assistants.length === 1) {
              const m = turn.assistants[0]
              const src =
                m.source === 'text' || m.source === 'narrated'
                  ? m.source
                  : null
              if (src) {
                return (
                  <div key={turn.key} className="chat-turn">
                    {userBubble}
                    <div className="chat-turn-tabs">
                      <div className="chat-tab-strip">
                        <span
                          className={`chat-tab-btn chat-tab-btn-${src} chat-tab-btn-active chat-tab-btn-solo`}
                          aria-label={sourceSectionTitle(src)}
                        >
                          {sourceSectionTitle(src)}
                        </span>
                      </div>
                      <div className="chat-tab-content">
                        <AssistantBubble
                          message={m}
                          youtubeMap={youtubeMap}
                          pdfPages={pdfPages}
                          showChip={false}
                        />
                      </div>
                    </div>
                  </div>
                )
              }
            }

            return (
              <div key={turn.key} className="chat-turn">
                {userBubble}
                {turn.assistants.map((m) => (
                  <div
                    key={m.id}
                    className="chat-bubble-row chat-bubble-row-assistant"
                  >
                    <AssistantBubble
                      message={m}
                      youtubeMap={youtubeMap}
                      pdfPages={pdfPages}
                      showChip={
                        m.source === 'text' || m.source === 'narrated'
                      }
                    />
                  </div>
                ))}
              </div>
            )
          })}

          {replyInProgressHere && (
            <div className="chat-bubble-row chat-bubble-row-assistant">
              <div className="chat-bubble chat-bubble-assistant">
                <span className="chat-typing" aria-label="Assistant is typing">
                  <span className="chat-typing-dot" />
                  <span className="chat-typing-dot" />
                  <span className="chat-typing-dot" />
                </span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {inputBar}
    </div>
  )
}
