import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { supabase } from '../lib/supabase'
import { generateThreadId } from '../lib/ids'
import { highlightCitations } from './CitationBadge'
import { IconFolder } from './Icons'
import './ChatWindow.css'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
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
const markdownComponents: Components = {
  p: ({ children }) => <p>{highlightCitations(children)}</p>,
  li: ({ children }) => <li>{highlightCitations(children)}</li>,
  h1: ({ children }) => <h1>{highlightCitations(children)}</h1>,
  h2: ({ children }) => <h2>{highlightCitations(children)}</h2>,
  h3: ({ children }) => <h3>{highlightCitations(children)}</h3>,
  h4: ({ children }) => <h4>{highlightCitations(children)}</h4>,
  blockquote: ({ children }) => <blockquote>{highlightCitations(children)}</blockquote>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
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
  breadcrumb,
  onAssistantResponse,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
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

  const submitMessage = async (messageText: string) => {
    if (!messageText || loading) return

    const isNewThread = !threadId
    const submitThreadId = threadId ?? generateThreadId()

    const now = new Date().toISOString()
    const userMessage: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: messageText,
      created_at: now,
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
        }
        setMessages((prev) => [...prev, errorMessage])
        return
      }

      const payload = (await res.json()) as { reply?: unknown }
      const rawReply = payload?.reply
      let replyText: string
      if (typeof rawReply === 'string') {
        replyText = rawReply
      } else if (rawReply == null) {
        replyText = '(The assistant returned an empty response.)'
      } else {
        console.warn('chat-proxy reply was not a string', rawReply)
        replyText = `(Unexpected response shape)\n\n${JSON.stringify(rawReply, null, 2)}`
      }

      const assistantMessage: Message = {
        id: `local-${Date.now()}-a`,
        role: 'assistant',
        content: replyText,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => {
        const next = [...prev, assistantMessage]
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
    void submitMessage(trimmed)
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

  return (
    <div className="chat-window">
      {breadcrumbBar}
      <div className="chat-messages">
        <div className="chat-messages-inner">
          {messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === 'user'
                  ? 'chat-bubble-row chat-bubble-row-user'
                  : 'chat-bubble-row chat-bubble-row-assistant'
              }
            >
              <div
                className={
                  message.role === 'user'
                    ? 'chat-bubble chat-bubble-user'
                    : 'chat-bubble chat-bubble-assistant'
                }
              >
                {message.role === 'assistant' ? (
                  <div className="chat-bubble-markdown">
                    <ReactMarkdown components={markdownComponents}>
                      {message.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  message.content
                )}
              </div>
            </div>
          ))}

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
