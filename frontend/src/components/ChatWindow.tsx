import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { supabase } from '../lib/supabase'
import { generateThreadId } from '../lib/ids'
import { highlightCitations } from './CitationBadge'
import { IconCopy, IconFolder } from './Icons'
import type { AnythingLlmSource } from '../lib/sources'
import { useYoutubeMap } from '../lib/YoutubeMapContext'
import { usePdfPages, type PdfPagesIndex } from '../lib/PdfPagesContext'
import { SourceToggle } from './SourceToggle'
import {
  useBothReplyLayout,
  type BothReplyLayout,
} from '../lib/bothReplyLayout'
import { usePreferredSource, type Source } from '../lib/source'
import './ChatWindow.css'
import './BothLayout.css'

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
  // Workspace this row came from (assistant) / was targeted at (user).
  // Null for rows inserted before migration 007.
  source?: UserSource | AssistantSource | null
  // Groups a user row with its 1-2 assistant replies. Null for pre-007 rows;
  // those keep rendering one-bubble-per-row as they did before.
  turn_id?: string | null
}

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
    value: 'accordion',
    label: 'Accordion',
    title: 'Stack the two replies in expandable sections',
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
}: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [source, setSource] = usePreferredSource()
  const [bothReplyLayout, setBothReplyLayout] = useBothReplyLayout()
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

  useEffect(() => {
    let cancelled = false

    if (!threadId) {
      setMessages([])
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
      .from('chat_messages')
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
  }, [threadId, user.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const submitMessage = async (
    messageText: string,
    overrideSource?: Source,
  ) => {
    if (!messageText || loading) return

    const effectiveSource: Source = overrideSource ?? source
    const isNewThread = !threadId
    const submitThreadId = threadId ?? generateThreadId()
    const submitTurnId = generateThreadId()

    const now = new Date().toISOString()
    const userMessage: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: messageText,
      created_at: now,
      source: effectiveSource,
      turn_id: submitTurnId,
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setLoading(true)

    // Always forward project_id when the caller handed us one. We can't use
    // `isNewThread` as a gate because ProjectDetailPage mints the UUID in
    // advance (and puts it in the URL) before ChatWindow mounts — so by the
    // time we get here, threadId is already set and isNewThread is false
    // even though the chat_threads row doesn't exist server-side yet. The
    // edge function's upsert uses ignoreDuplicates, so sending project_id
    // for an already-existing thread is a safe no-op.
    const body: Record<string, unknown> = {
      message: messageText,
      thread_id: submitThreadId,
      turn_id: submitTurnId,
      source: effectiveSource,
    }
    if (projectId) body.project_id = projectId

    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-proxy`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      )

      if (!res.ok) {
        // Try to pull the server-provided error message so we can surface
        // something actionable instead of a generic "something went wrong".
        let serverError: string | null = null
        try {
          const errBody = (await res.clone().json()) as { error?: unknown }
          if (typeof errBody?.error === 'string' && errBody.error.trim().length > 0) {
            serverError = errBody.error
          }
        } catch {
          // Non-JSON body or parse failure — fall through to status-based copy.
        }

        // 401 almost always means the stored JWT is stale (e.g. after a
        // `supabase db reset` which wipes auth.users). Sign the user out so
        // onAuthStateChange routes them back to the login screen with a clean
        // session, instead of letting them spam retries with a dead token.
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
          // Best-effort sign out; ignore errors because the session may already
          // be invalid server-side.
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
        const errorMessage: Message = {
          id: `local-${Date.now()}-err`,
          role: 'assistant',
          content: friendly,
          created_at: new Date().toISOString(),
          turn_id: submitTurnId,
        }
        setMessages((prev) => [...prev, errorMessage])
        return
      }

      const payload = (await res.json()) as {
        replies?: unknown
      }

      // The edge function returns `replies: [{source, reply, sources}]` — one
      // entry for single-source turns and two entries (text + narrated) for
      // 'both'. Be defensive about the shape so a server regression surfaces
      // as a visible error instead of a silent empty bubble.
      const rawReplies = Array.isArray(payload?.replies) ? payload.replies : []
      const parsedReplies: Array<{
        source: AssistantSource
        reply: string
        sources: AnythingLlmSource[] | null
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
        parsedReplies.push({ source: s, reply: replyText, sources: sourcesVal })
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

      setMessages((prev) => {
        const next = [...prev, ...assistantMessages]
        // For fresh threads, stash the full rendered conversation so the
        // remounted ChatWindow (after navigating to /c/:id) can seed state
        // from this snapshot instead of showing an empty pane during the
        // DB round-trip.
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
      onAssistantResponse?.(submitThreadId)
    } catch (err) {
      // Network-level failure (CORS, DNS, offline, edge-runtime crash, etc.) —
      // res.ok handling above covers HTTP-level errors.
      console.error('Chat request failed (network)', err)
      const errorMessage: Message = {
        id: `local-${Date.now()}-err`,
        role: 'assistant',
        content:
          'Could not reach the assistant. Check that the Supabase functions server is running and try again.',
        created_at: new Date().toISOString(),
        turn_id: submitTurnId,
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setLoading(false)
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

  // "Empty landing" layout: no messages yet, not currently loading a reply,
  // and not mid-auto-submit from ProjectDetailPage. In that state the input
  // lives centered under a greeting; the moment the first exchange starts
  // we fall through to the normal layout with the bar pinned at the bottom.
  const isEmpty =
    messages.length === 0 && !loading && !initialMessage && !threadId

  const hasSplitTurns = useMemo(
    () => groupIntoTurns(messages).some((t) => t.assistants.length > 1),
    [messages],
  )
  const showBothLayoutToggle = source === 'both' || hasSplitTurns

  const inputBar = (
    <form className="chat-input-bar" onSubmit={handleSubmit}>
      <div className="chat-input-bar-inner">
        <input
          type="text"
          className="chat-input"
          placeholder="Ask about the Book of Heaven..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <SourceToggle value={source} onChange={setSource} disabled={loading} />
        {showBothLayoutToggle ? (
          <BothLayoutToggle
            value={bothReplyLayout}
            onChange={setBothReplyLayout}
            disabled={loading}
          />
        ) : null}
        <button
          type="submit"
          className="chat-send"
          disabled={loading || input.trim().length === 0}
        >
          Send
        </button>
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
              if (bothReplyLayout === 'accordion') {
                return (
                  <div
                    key={turn.key}
                    className="chat-turn chat-turn-split-wrap"
                  >
                    {userBubble}
                    <div className="chat-turn-accordion">
                      {turn.assistants.map((m, index) => {
                        const title =
                          m.source === 'text' || m.source === 'narrated'
                            ? sourceSectionTitle(m.source)
                            : 'Reply'
                        const accentClass =
                          m.source === 'text'
                            ? 'text'
                            : m.source === 'narrated'
                              ? 'narrated'
                              : 'default'
                        return (
                          <details
                            key={m.id}
                            className="chat-accordion-item"
                            open={index === 0}
                          >
                            <summary
                              className={`chat-accordion-summary chat-accordion-summary-${accentClass}`}
                            >
                              <span className="chat-accordion-summary-text">
                                {title}
                              </span>
                              <span
                                className="chat-accordion-chevron"
                                aria-hidden
                              />
                            </summary>
                            <div className="chat-accordion-body">
                              <div className="chat-bubble-row chat-bubble-row-assistant">
                                <AssistantBubble
                                  message={m}
                                  youtubeMap={youtubeMap}
                                  pdfPages={pdfPages}
                                  showChip={false}
                                />
                              </div>
                            </div>
                          </details>
                        )
                      })}
                    </div>
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

          {loading && (
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
