import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  description: string | null
  instructions: string | null
  createdAt: string
  updatedAt: string
}

export interface Thread {
  threadId: string
  title: string | null
  /** Oldest user message in this thread — used as the fallback title. */
  firstMessage: string
  /** Timestamp of the oldest message (used as the thread's "created" date). */
  firstMessageAt: string
  /** Timestamp of the newest message (used to bucket Recents). */
  lastMessageAt: string
  projectId: string | null
  pinnedAt: string | null
}

export interface WorkspaceApi {
  loading: boolean
  error: string | null
  projects: Project[]
  threads: Thread[]

  refresh: () => Promise<void>

  // Projects
  createProject: (input: {
    name: string
    description?: string | null
  }) => Promise<Project | null>
  renameProject: (id: string, name: string) => Promise<boolean>
  updateProjectDescription: (
    id: string,
    description: string | null,
  ) => Promise<boolean>
  updateProjectInstructions: (
    id: string,
    instructions: string | null,
  ) => Promise<boolean>
  deleteProject: (id: string) => Promise<boolean>

  // Threads
  moveThreadToProject: (
    threadId: string,
    projectId: string | null,
  ) => Promise<boolean>
  pinThread: (threadId: string) => Promise<boolean>
  unpinThread: (threadId: string) => Promise<boolean>
  deleteThread: (threadId: string) => Promise<boolean>

  /** Thread ids with an LLM job still pending/processing (from `chat_turn_jobs`). */
  pendingThreadIds: ReadonlySet<string>
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null)

export function useWorkspace(): WorkspaceApi {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  }
  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RawMessage {
  thread_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface RawThread {
  thread_id: string
  title: string | null
  project_id: string | null
  pinned_at: string | null
  created_at: string | null
  updated_at: string | null
}

interface RawProject {
  id: string
  name: string
  description: string | null
  instructions: string | null
  created_at: string
  updated_at: string
}

function assembleThreads(
  rawMessages: RawMessage[],
  rawThreads: RawThread[],
): Thread[] {
  // Build per-thread aggregates in a single pass.
  interface Aggregate {
    firstMessage: string
    firstMessageAt: string
    lastMessageAt: string
  }
  const agg = new Map<string, Aggregate>()
  for (const m of rawMessages) {
    const current = agg.get(m.thread_id)
    if (!current) {
      agg.set(m.thread_id, {
        firstMessage: m.role === 'user' ? m.content : '',
        firstMessageAt: m.created_at,
        lastMessageAt: m.created_at,
      })
      continue
    }
    if (m.created_at < current.firstMessageAt) {
      current.firstMessageAt = m.created_at
      if (m.role === 'user') current.firstMessage = m.content
    } else if (!current.firstMessage && m.role === 'user') {
      // Backfill: earliest row wasn't a user message (shouldn't happen in
      // practice but be defensive).
      current.firstMessage = m.content
    }
    if (m.created_at > current.lastMessageAt) {
      current.lastMessageAt = m.created_at
    }
  }

  const threadsById = new Map<string, RawThread>()
  for (const t of rawThreads) threadsById.set(t.thread_id, t)

  // Union of thread IDs seen in either source. A thread may appear in
  // chat_threads with no messages yet (possible between upsert and insert
  // ordering under heavy concurrency) or in chat_messages without a
  // chat_threads row (historically, before migration 004 backfilled them).
  const allIds = new Set<string>([
    ...agg.keys(),
    ...rawThreads.map((t) => t.thread_id),
  ])

  const out: Thread[] = []
  for (const id of allIds) {
    const a = agg.get(id)
    const t = threadsById.get(id)
    // A thread with neither messages nor a chat_threads row would be a ghost —
    // skip it. (Impossible given we derived `allIds` from both sources, but
    // TypeScript doesn't know that.)
    if (!a && !t) continue
    out.push({
      threadId: id,
      title: t?.title ?? null,
      firstMessage: a?.firstMessage ?? '',
      firstMessageAt: a?.firstMessageAt ?? t?.created_at ?? new Date(0).toISOString(),
      lastMessageAt: a?.lastMessageAt ?? t?.updated_at ?? t?.created_at ?? new Date(0).toISOString(),
      projectId: t?.project_id ?? null,
      pinnedAt: t?.pinned_at ?? null,
    })
  }

  // Sort by recency (newest message first) — every view that cares about a
  // different ordering (pinned, project detail, recents buckets) re-sorts.
  out.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function WorkspaceProvider({
  user,
  children,
}: {
  user: User
  children: ReactNode
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [pendingThreadIds, setPendingThreadIds] = useState<Set<string>>(
    () => new Set(),
  )

  // Guard against stale responses overwriting fresh state when refresh() is
  // called back-to-back (e.g. navigation + mutation racing each other).
  const fetchIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const fetchId = ++fetchIdRef.current
    setError(null)
    try {
      const [messagesRes, threadsRes, projectsRes] = await Promise.all([
        supabase
          .from('chat_messages')
          .select('thread_id, role, content, created_at')
          .eq('user_id', user.id),
        supabase
          .from('chat_threads')
          .select('thread_id, title, project_id, pinned_at, created_at, updated_at')
          .eq('user_id', user.id),
        supabase
          .from('chat_projects')
          .select('id, name, description, instructions, created_at, updated_at')
          .eq('user_id', user.id),
      ])
      if (fetchIdRef.current !== fetchId) return

      if (messagesRes.error) throw messagesRes.error
      if (threadsRes.error) throw threadsRes.error
      if (projectsRes.error) throw projectsRes.error

      const rawMessages = (messagesRes.data ?? []) as RawMessage[]
      const rawThreads = (threadsRes.data ?? []) as RawThread[]
      const rawProjects = (projectsRes.data ?? []) as RawProject[]

      setThreads(assembleThreads(rawMessages, rawThreads))
      setProjects(
        rawProjects
          .map(
            (p): Project => ({
              id: p.id,
              name: p.name,
              description: p.description,
              instructions: p.instructions,
              createdAt: p.created_at,
              updatedAt: p.updated_at,
            }),
          )
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
    } catch (e) {
      if (fetchIdRef.current !== fetchId) return
      console.error('WorkspaceProvider.refresh failed', e)
      setError('Could not load your workspace. Please refresh the page.')
    } finally {
      if (fetchIdRef.current === fetchId) setLoading(false)
    }
  }, [user.id])

  // Initial load + reload on user change.
  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  const syncPendingChatJobs = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('chat_turn_jobs')
      .select('thread_id')
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing'])
    if (err) {
      console.warn('syncPendingChatJobs failed', err)
      return
    }
    const next = new Set<string>()
    for (const row of data ?? []) {
      const id = (row as { thread_id: string }).thread_id
      if (typeof id === 'string' && id.length > 0) next.add(id)
    }
    setPendingThreadIds(next)
  }, [user.id])

  useEffect(() => {
    void syncPendingChatJobs()
  }, [syncPendingChatJobs])

  useEffect(() => {
    const channel = supabase
      .channel(`chat-turn-jobs-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_turn_jobs',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          void syncPendingChatJobs()
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
        () => {
          void syncPendingChatJobs()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user.id, syncPendingChatJobs])

  // ───── Project CRUD ─────

  const createProject = useCallback<WorkspaceApi['createProject']>(
    async ({ name, description }) => {
      const payload: Record<string, unknown> = { user_id: user.id, name }
      if (description != null && description.trim().length > 0) {
        payload.description = description.trim()
      }
      const { data, error: err } = await supabase
        .from('chat_projects')
        .insert(payload)
        .select('id, name, description, instructions, created_at, updated_at')
        .single()
      if (err || !data) {
        console.error('createProject failed', err)
        return null
      }
      const project: Project = {
        id: data.id,
        name: data.name,
        description: data.description,
        instructions: data.instructions,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      }
      setProjects((prev) =>
        [...prev, project].sort((a, b) => a.name.localeCompare(b.name)),
      )
      return project
    },
    [user.id],
  )

  const renameProject = useCallback<WorkspaceApi['renameProject']>(
    async (id, name) => {
      const previous = projects.find((p) => p.id === id)
      if (!previous) return false
      if (previous.name === name) return true
      setProjects((prev) =>
        prev
          .map((p) => (p.id === id ? { ...p, name } : p))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      const { error: err } = await supabase
        .from('chat_projects')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', user.id)
      if (err) {
        console.error('renameProject failed', err)
        setProjects((prev) =>
          prev
            .map((p) => (p.id === id ? { ...p, name: previous.name } : p))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
        return false
      }
      return true
    },
    [user.id, projects],
  )

  const updateProjectField = useCallback(
    async (
      id: string,
      field: 'description' | 'instructions',
      value: string | null,
    ): Promise<boolean> => {
      const previous = projects.find((p) => p.id === id)
      if (!previous) return false
      const normalized = value && value.trim().length > 0 ? value : null
      if (previous[field] === normalized) return true
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, [field]: normalized } : p)),
      )
      const { error: err } = await supabase
        .from('chat_projects')
        .update({ [field]: normalized, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', user.id)
      if (err) {
        console.error(`updateProject ${field} failed`, err)
        setProjects((prev) =>
          prev.map((p) => (p.id === id ? { ...p, [field]: previous[field] } : p)),
        )
        return false
      }
      return true
    },
    [user.id, projects],
  )

  const updateProjectDescription = useCallback<
    WorkspaceApi['updateProjectDescription']
  >((id, description) => updateProjectField(id, 'description', description), [
    updateProjectField,
  ])

  const updateProjectInstructions = useCallback<
    WorkspaceApi['updateProjectInstructions']
  >((id, instructions) => updateProjectField(id, 'instructions', instructions), [
    updateProjectField,
  ])

  const deleteProject = useCallback<WorkspaceApi['deleteProject']>(
    async (id) => {
      const threadIds = threads
        .filter((t) => t.projectId === id)
        .map((t) => t.threadId)

      // Cascade: wipe messages + thread rows + project. The FK on
      // chat_threads.project_id is ON DELETE SET NULL, so we must delete the
      // threads explicitly or they'd survive the project deletion.
      if (threadIds.length > 0) {
        const { error: msgErr } = await supabase
          .from('chat_messages')
          .delete()
          .eq('user_id', user.id)
          .in('thread_id', threadIds)
        if (msgErr) {
          console.error('deleteProject (messages) failed', msgErr)
          return false
        }
        const { error: thErr } = await supabase
          .from('chat_threads')
          .delete()
          .eq('user_id', user.id)
          .in('thread_id', threadIds)
        if (thErr) {
          console.error('deleteProject (threads) failed', thErr)
          return false
        }
      }
      const { error: prErr } = await supabase
        .from('chat_projects')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)
      if (prErr) {
        console.error('deleteProject (project) failed', prErr)
        return false
      }

      setProjects((prev) => prev.filter((p) => p.id !== id))
      setThreads((prev) => prev.filter((t) => !threadIds.includes(t.threadId)))
      return true
    },
    [user.id, threads],
  )

  // ───── Thread actions ─────

  const moveThreadToProject = useCallback<WorkspaceApi['moveThreadToProject']>(
    async (threadId, projectId) => {
      const previous = threads.find((t) => t.threadId === threadId)?.projectId ?? null
      if (previous === projectId) return true
      setThreads((prev) =>
        prev.map((t) => (t.threadId === threadId ? { ...t, projectId } : t)),
      )
      const { error: err } = await supabase
        .from('chat_threads')
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq('thread_id', threadId)
        .eq('user_id', user.id)
      if (err) {
        console.error('moveThreadToProject failed', err)
        setThreads((prev) =>
          prev.map((t) =>
            t.threadId === threadId ? { ...t, projectId: previous } : t,
          ),
        )
        return false
      }
      return true
    },
    [user.id, threads],
  )

  const setPinned = useCallback(
    async (threadId: string, pinnedAt: string | null): Promise<boolean> => {
      const previous =
        threads.find((t) => t.threadId === threadId)?.pinnedAt ?? null
      setThreads((prev) =>
        prev.map((t) => (t.threadId === threadId ? { ...t, pinnedAt } : t)),
      )
      const { error: err } = await supabase
        .from('chat_threads')
        .update({ pinned_at: pinnedAt })
        .eq('thread_id', threadId)
        .eq('user_id', user.id)
      if (err) {
        console.error('setPinned failed', err)
        setThreads((prev) =>
          prev.map((t) =>
            t.threadId === threadId ? { ...t, pinnedAt: previous } : t,
          ),
        )
        return false
      }
      return true
    },
    [user.id, threads],
  )

  const pinThread = useCallback<WorkspaceApi['pinThread']>(
    (threadId) => setPinned(threadId, new Date().toISOString()),
    [setPinned],
  )

  const unpinThread = useCallback<WorkspaceApi['unpinThread']>(
    (threadId) => setPinned(threadId, null),
    [setPinned],
  )

  const deleteThread = useCallback<WorkspaceApi['deleteThread']>(
    async (threadId) => {
      const [msgRes, trRes] = await Promise.all([
        supabase
          .from('chat_messages')
          .delete()
          .eq('user_id', user.id)
          .eq('thread_id', threadId),
        supabase
          .from('chat_threads')
          .delete()
          .eq('user_id', user.id)
          .eq('thread_id', threadId),
      ])
      if (msgRes.error || trRes.error) {
        console.error('deleteThread failed', msgRes.error ?? trRes.error)
        return false
      }
      setThreads((prev) => prev.filter((t) => t.threadId !== threadId))
      return true
    },
    [user.id],
  )

  const api = useMemo<WorkspaceApi>(
    () => ({
      loading,
      error,
      projects,
      threads,
      pendingThreadIds,
      refresh,
      createProject,
      renameProject,
      updateProjectDescription,
      updateProjectInstructions,
      deleteProject,
      moveThreadToProject,
      pinThread,
      unpinThread,
      deleteThread,
    }),
    [
      loading,
      error,
      projects,
      threads,
      pendingThreadIds,
      refresh,
      createProject,
      renameProject,
      updateProjectDescription,
      updateProjectInstructions,
      deleteProject,
      moveThreadToProject,
      pinThread,
      unpinThread,
      deleteThread,
    ],
  )

  return (
    <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>
  )
}
