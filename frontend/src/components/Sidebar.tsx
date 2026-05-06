import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useWorkspace } from '../lib/WorkspaceContext'
import { recentBucket } from '../lib/time'
import { ThreadRow } from './ThreadRow'
import { IconArrowLeft, IconChat, IconFolder, IconPlus } from './Icons'
import './Sidebar.css'

interface SidebarProps {
  user: User
  onHide: () => void
}

// Bucket order for the Recents section — matches what the previous
// HistorySidebar showed. Buckets that don't appear (e.g. no "Yesterday"
// conversations) are simply skipped.
const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']

export function Sidebar({ user, onHide }: SidebarProps) {
  const workspace = useWorkspace()

  const pinned = useMemo(
    () =>
      workspace.threads
        .filter((t) => t.pinnedAt)
        .sort((a, b) => ((a.pinnedAt ?? '') < (b.pinnedAt ?? '') ? 1 : -1)),
    [workspace.threads],
  )

  const knownThreadIds = useMemo(
    () => new Set(workspace.threads.map((t) => t.threadId)),
    [workspace.threads],
  )
  const orphanPendingCount = useMemo(() => {
    let n = 0
    for (const tid of workspace.pendingThreadIds) {
      if (!knownThreadIds.has(tid)) n += 1
    }
    return n
  }, [workspace.pendingThreadIds, knownThreadIds])

  const bucketedRecents = useMemo(() => {
    const buckets = new Map<string, typeof workspace.threads>()
    const order: string[] = []
    for (const t of workspace.threads) {
      const key = recentBucket(t.lastMessageAt)
      let list = buckets.get(key)
      if (!list) {
        list = []
        buckets.set(key, list)
        order.push(key)
      }
      list.push(t)
    }
    // Enforce canonical ordering for the known buckets, then append any
    // month/year buckets (older items) in the order they first appeared —
    // which, given the threads are pre-sorted by lastMessageAt desc, is
    // already "newest month first".
    const sortedKeys: string[] = []
    for (const key of BUCKET_ORDER) if (buckets.has(key)) sortedKeys.push(key)
    for (const key of order) {
      if (!BUCKET_ORDER.includes(key) && !sortedKeys.includes(key)) {
        sortedKeys.push(key)
      }
    }
    return sortedKeys.map((key) => ({ key, items: buckets.get(key)! }))
  }, [workspace.threads])

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-topbar">
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={onHide}
          aria-label="Hide sidebar"
          title="Hide sidebar"
        >
          <IconArrowLeft size={14} />
        </button>
      </div>
      <nav className="sidebar-nav">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            isActive
              ? 'sidebar-nav-link sidebar-nav-link-active'
              : 'sidebar-nav-link'
          }
        >
          <IconPlus size={14} />
          <span>New chat</span>
          {orphanPendingCount > 0 ? (
            <span
              className="sidebar-nav-pending-badge"
              title={`${orphanPendingCount === 1 ? 'One reply' : `${orphanPendingCount} replies`} generating…`}
              aria-label="A reply is still generating for a new chat"
            >
              <span className="sidebar-nav-pending-dot" />
            </span>
          ) : null}
        </NavLink>
        <NavLink
          to="/projects"
          className={({ isActive }) =>
            isActive
              ? 'sidebar-nav-link sidebar-nav-link-active'
              : 'sidebar-nav-link'
          }
        >
          <IconFolder size={14} />
          <span>Projects</span>
        </NavLink>
      </nav>

      <div className="sidebar-sections">
        {workspace.loading ? (
          <div className="sidebar-loading">Loading…</div>
        ) : (
          <>
            {pinned.length > 0 ? (
              <div className="sidebar-section">
                <div className="sidebar-section-header">Pinned</div>
                {pinned.map((t) => (
                  <ThreadRow key={t.threadId} thread={t} variant="dark" />
                ))}
              </div>
            ) : null}

            <div className="sidebar-section">
              <div className="sidebar-section-header">Recents</div>
              {workspace.threads.length === 0 ? (
                <div className="sidebar-empty-state">
                  No conversations yet. Click <IconChat size={11} /> New chat to
                  start one.
                </div>
              ) : (
                bucketedRecents.map(({ key, items }) => (
                  <div key={key}>
                    <div className="sidebar-bucket-header">{key}</div>
                    {items.map((t) => (
                      <ThreadRow key={t.threadId} thread={t} variant="dark" />
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-footer-email" title={user.email ?? ''}>
          {user.email}
        </span>
        <button
          type="button"
          className="sidebar-footer-logout"
          onClick={handleLogout}
        >
          Log out
        </button>
      </div>
    </aside>
  )
}
