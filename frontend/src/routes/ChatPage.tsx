import { useCallback, useEffect } from 'react'
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom'
import { ChatWindow } from '../components/ChatWindow'
import type { Source } from '../lib/source'
import type { RetrievalMode } from '../lib/retrievalMode'
import { useWorkspace } from '../lib/WorkspaceContext'
import type { ProtectedOutletContext } from './ProtectedLayout'

/**
 * Route state optionally passed via `navigate('/c/:threadId', { state: ... })`.
 * ProjectDetailPage uses this to hand off a drafted first message + the
 * project id that should own the freshly-created thread.
 */
export interface ChatPageRouteState {
  initialMessage?: string
  /** Source selection the user made on ProjectDetailPage's compose box.
   *  When omitted, ChatWindow falls back to the user's persisted preference. */
  initialSource?: Source
  /** Retrieval mode from ProjectDetailPage — forwarded to the first request. */
  initialRetrievalMode?: RetrievalMode
  projectId?: string
  /**
   * Set when opening a thread from the "Response ready" toast. Skips the
   * "thread not in sidebar list" redirect so we do not immediately bounce
   * home while `workspace.threads` is still catching up to Realtime.
   */
  allowPendingThread?: boolean
}

export function ChatPage() {
  const { user, session } = useOutletContext<ProtectedOutletContext>()
  const { threadId } = useParams<{ threadId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const workspace = useWorkspace()
  const handleVisibleThreadChange = useCallback(
    (activeId: string | null) => {
      workspace.setActiveThreadId(activeId)
    },
    [workspace.setActiveThreadId],
  )

  const state = (location.state ?? null) as ChatPageRouteState | null

  // Resolve the project context for the breadcrumb. Source of truth for an
  // existing thread is the Thread row in workspace; for a brand-new thread
  // (auto-submitting from the project page, not yet in the DB) we fall back
  // to the project id that ProjectDetailPage handed us via route state.
  const thread = threadId
    ? workspace.threads.find((t) => t.threadId === threadId) ?? null
    : null
  const activeProjectId = thread?.projectId ?? state?.projectId ?? null
  const activeProject = activeProjectId
    ? workspace.projects.find((p) => p.id === activeProjectId) ?? null
    : null
  const breadcrumb = activeProject
    ? {
        projectId: activeProject.id,
        projectName: activeProject.name,
        threadTitle: thread?.title ?? null,
      }
    : null

  // Once the first assistant response comes back we:
  //   1. refresh the workspace so the new thread (and its fresh title) show
  //      up in the sidebar + project detail page
  //   2. if we were on `/` (fresh new chat without a URL thread id), push
  //      the real thread id into the URL so back/forward + refresh work
  //   3. drop the location state so a subsequent navigation here doesn't
  //      auto-submit the same initial message twice
  //
  // We **await** the refresh before clearing state / changing the URL. If we
  // don't, the not-found guard effect below can race us: it sees the new
  // thread id in the URL, state already nulled out, and the workspace array
  // still missing the thread, so it redirects home before the refresh lands.
  const handleAssistantResponse = async (newThreadId: string) => {
    await workspace.refresh()
    if (!threadId) {
      navigate(`/c/${newThreadId}`, { replace: true, state: null })
    } else if (state) {
      navigate(location.pathname, { replace: true, state: null })
    }
  }

  // If the URL points to a thread id that doesn't exist in the workspace
  // (deleted from another tab, bad bookmark, etc.) send the user home rather
  // than leave them staring at a blank pane forever.
  //
  // `allowPendingThread` (e.g. from the response-ready toast) skips this check
  // so we don't race: the sidebar list may not include the thread until the
  // next `refresh` even though `chat_messages` already has the new reply.
  useEffect(() => {
    if (!threadId) return
    if (workspace.loading) return
    if (state?.allowPendingThread) return
    if (state?.initialMessage) return
    const exists = workspace.threads.some((t) => t.threadId === threadId)
    if (!exists) {
      navigate('/', { replace: true })
    }
  }, [threadId, workspace.loading, workspace.threads, navigate, state])

  return (
    // Remount per thread so message list / in-flight job state never leaks across
    // /c/A → /c/B navigations (same route element, previously reused one instance).
    <ChatWindow
      key={threadId ?? 'home'}
      user={user}
      session={session}
      threadId={threadId ?? null}
      projectId={state?.projectId ?? null}
      initialMessage={state?.initialMessage ?? null}
      initialSource={state?.initialSource ?? null}
      initialRetrievalMode={state?.initialRetrievalMode ?? null}
      breadcrumb={breadcrumb}
      onAssistantResponse={handleAssistantResponse}
      onVisibleThreadChange={handleVisibleThreadChange}
    />
  )
}
