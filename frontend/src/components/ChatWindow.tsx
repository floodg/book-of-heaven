import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { supabase } from '../lib/supabase'
import { highlightCitations } from './CitationBadge'
import './ChatWindow.css'

function generateThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for older runtimes: RFC4122-ish v4 UUID built from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

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
  onAssistantResponse?: (threadId: string) => void
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export function ChatWindow({
  user,
  session,
  threadId,
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || loading) return

    const isNewThread = !threadId
    const submitThreadId = threadId ?? generateThreadId()

    const now = new Date().toISOString()
    const userMessage: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: trimmed,
      created_at: now,
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-proxy`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: trimmed, thread_id: submitThreadId }),
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
      setMessages((prev) => [...prev, assistantMessage])
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

  return (
    <div className="chat-window">
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
    </div>
  )
}
