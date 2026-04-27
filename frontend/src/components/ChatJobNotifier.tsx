import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, matchPath, useLocation } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useWorkspace } from '../lib/WorkspaceContext'

export interface ChatJobNotifierProps {
  user: User
  /** Kept for future (e.g. re-auth) — not used; EventSource uses access_token in URL. */
  session: Session
}

/**
 * Global Realtime listener for assistant messages and turn jobs so we can show
 * a toast when a reply lands on a thread that is not currently open, and
 * refresh the workspace list when titles or threads change.
 */
export function ChatJobNotifier({ user, session: _session }: ChatJobNotifierProps) {
  const location = useLocation()
  const routeThreadId =
    matchPath({ path: '/c/:threadId', end: true }, location.pathname)
      ?.params.threadId ?? null
  const workspace = useWorkspace()
  const activeVisibleThreadId = workspace.activeThreadId ?? routeThreadId
  const [toast, setToast] = useState<{
    threadId: string
    label: string
  } | null>(null)
  const processedAssistantKeys = useRef(new Set<string>())
  const processedJobErrors = useRef(new Set<string>())
  const activeVisibleThreadIdRef = useRef<string | null>(activeVisibleThreadId)
  const threadsRef = useRef(workspace.threads)

  const dismiss = useCallback(() => setToast(null), [])

  const refresh = workspace.refresh

  useEffect(() => {
    activeVisibleThreadIdRef.current = activeVisibleThreadId
  }, [activeVisibleThreadId])

  useEffect(() => {
    threadsRef.current = workspace.threads
  }, [workspace.threads])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => {
      setToast((prev) => (prev?.threadId === toast.threadId ? null : prev))
    }, 2500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const channel = supabase
      .channel(`chat-global-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as {
            role?: string
            thread_id?: string
            id?: string
          }
          if (row.role !== 'assistant' || !row.thread_id || !row.id) return
          const key = `a:${row.id}`
          if (processedAssistantKeys.current.has(key)) return
          processedAssistantKeys.current.add(key)
          if (row.thread_id === activeVisibleThreadIdRef.current) return

          const th = threadsRef.current.find(
            (t) => t.threadId === row.thread_id,
          )
          const label =
            th?.title?.trim() ||
            th?.firstMessage?.slice(0, 60).trim() ||
            'A chat'
          setToast({ threadId: row.thread_id, label })
          void refresh()
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_turn_jobs',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as {
            status?: string
            id?: string
            thread_id?: string
            error_message?: string | null
          }
          if (row.status === 'error' && row.id && row.thread_id) {
            const key = `e:${row.id}`
            if (processedJobErrors.current.has(key)) return
            processedJobErrors.current.add(key)
            if (row.thread_id === activeVisibleThreadIdRef.current) return
            const th = threadsRef.current.find(
              (t) => t.threadId === row.thread_id,
            )
            const label =
              th?.title?.trim() ||
              th?.firstMessage?.slice(0, 60).trim() ||
              'A chat'
            setToast({ threadId: row.thread_id, label: `${label} (error)` })
            void refresh()
          }
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && import.meta.env.DEV) {
          console.debug('ChatJobNotifier subscribed')
        }
      })

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user.id, refresh])

  if (!toast) return null

  return (
    <div className="workspace-toast" role="status">
      <div className="workspace-toast-body">
        <span className="workspace-toast-dot" aria-hidden />
        <div className="workspace-toast-text">
          <strong>Response ready</strong> in <strong>{toast.label}</strong>
        </div>
      </div>
      <div className="workspace-toast-actions">
        <Link
          to={`/c/${toast.threadId}`}
          state={{ allowPendingThread: true }}
          className="workspace-toast-btn-view"
          onClick={dismiss}
        >
          View
        </Link>
        <button type="button" className="workspace-toast-btn-close" onClick={dismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  )
}
