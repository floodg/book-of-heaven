import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import './HistorySidebar.css'

interface HistorySidebarProps {
  user: User
  activeThreadId: string | null
  onSelectThread: (threadId: string, firstMessage: string) => void
  onNewThread: () => void
  onThreadDeleted: (threadId: string) => void
  refreshToken: number
}

interface UserMessageRow {
  id: string
  content: string
  created_at: string
  thread_id: string
}

interface Thread {
  threadId: string
  firstMessage: string
  createdAt: string
}

type GroupLabel = 'Today' | 'Yesterday' | 'This week' | 'Earlier'

const GROUP_ORDER: GroupLabel[] = ['Today', 'Yesterday', 'This week', 'Earlier']

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function groupFor(createdAt: string, today: Date): GroupLabel {
  const d = new Date(createdAt)
  const threadDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round(
    (today.getTime() - threadDay.getTime()) / (24 * 60 * 60 * 1000),
  )
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This week'
  return 'Earlier'
}

function truncate(text: string, max = 40): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

function dedupeByThread(rows: UserMessageRow[]): Thread[] {
  // Keep the earliest user message per thread as the title; order threads
  // newest-first by that same first-message timestamp.
  const byThread = new Map<string, UserMessageRow>()
  for (const row of rows) {
    const existing = byThread.get(row.thread_id)
    if (!existing || new Date(row.created_at) < new Date(existing.created_at)) {
      byThread.set(row.thread_id, row)
    }
  }
  return Array.from(byThread.values())
    .map((row) => ({
      threadId: row.thread_id,
      firstMessage: row.content,
      createdAt: row.created_at,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function HistorySidebar({
  user,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onThreadDeleted,
  refreshToken,
}: HistorySidebarProps) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null)

  const handleDeleteThread = async (
    event: React.MouseEvent<HTMLButtonElement>,
    thread: Thread,
  ) => {
    event.stopPropagation()
    const preview = thread.firstMessage.trim().slice(0, 60)
    const confirmed = window.confirm(
      `Delete this conversation?\n\n"${preview}${thread.firstMessage.length > 60 ? '…' : ''}"\n\nThis cannot be undone.`,
    )
    if (!confirmed) return

    setDeletingThreadId(thread.threadId)
    const { error } = await supabase
      .from('chat_messages')
      .delete()
      .eq('user_id', user.id)
      .eq('thread_id', thread.threadId)

    if (error) {
      console.error('Failed to delete thread', error)
      window.alert('Could not delete this conversation. Please try again.')
      setDeletingThreadId(null)
      return
    }

    setThreads((prev) => prev.filter((t) => t.threadId !== thread.threadId))
    setDeletingThreadId(null)
    onThreadDeleted(thread.threadId)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    supabase
      .from('chat_messages')
      .select('id, content, created_at, thread_id')
      .eq('user_id', user.id)
      .eq('role', 'user')
      .order('created_at', { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error('Failed to load history', error)
          setThreads([])
          setLoading(false)
          return
        }
        setThreads(dedupeByThread((data ?? []) as UserMessageRow[]))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user.id, refreshToken])

  const today = startOfToday()
  const grouped = new Map<GroupLabel, Thread[]>()
  for (const thread of threads) {
    const label = groupFor(thread.createdAt, today)
    const list = grouped.get(label) ?? []
    list.push(thread)
    grouped.set(label, list)
  }

  return (
    <aside className="history-sidebar" aria-label="Conversation history">
      <div className="history-sidebar-header">
        <h2 className="history-sidebar-title">Book of Heaven</h2>
        <button
          type="button"
          className="history-new-chat"
          onClick={onNewThread}
        >
          <span aria-hidden="true" className="history-new-chat-plus">
            +
          </span>
          New Chat
        </button>
      </div>

      <div className="history-sidebar-body">
        {loading ? (
          <div className="history-skeleton-list" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="history-skeleton-row" />
            ))}
          </div>
        ) : threads.length === 0 ? (
          <div className="history-empty">
            <svg
              className="history-empty-icon"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <p className="history-empty-text">
              No conversations yet. Ask your first question below.
            </p>
          </div>
        ) : (
          GROUP_ORDER.filter((label) => grouped.has(label)).map((label) => (
            <div key={label} className="history-group">
              <div className="history-group-label">{label}</div>
              <ul className="history-group-list">
                {grouped.get(label)!.map((thread) => {
                  const isActive = thread.threadId === activeThreadId
                  const isDeleting = deletingThreadId === thread.threadId
                  return (
                    <li key={thread.threadId} className="history-thread-row">
                      <button
                        type="button"
                        className={
                          isActive
                            ? 'history-thread history-thread-active'
                            : 'history-thread'
                        }
                        onClick={() =>
                          onSelectThread(thread.threadId, thread.firstMessage)
                        }
                        title={thread.firstMessage}
                        disabled={isDeleting}
                      >
                        {truncate(thread.firstMessage)}
                      </button>
                      <button
                        type="button"
                        className="history-thread-delete"
                        onClick={(e) => handleDeleteThread(e, thread)}
                        aria-label={`Delete conversation: ${truncate(thread.firstMessage)}`}
                        title="Delete conversation"
                        disabled={isDeleting}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
