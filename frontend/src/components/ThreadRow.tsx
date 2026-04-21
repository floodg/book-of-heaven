import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import type { Thread, Project } from '../lib/WorkspaceContext'
import { useWorkspace } from '../lib/WorkspaceContext'
import { useModal } from './Modal'
import {
  IconFolder,
  IconFolderMove,
  IconMore,
  IconPin,
  IconPinOff,
  IconTrash,
} from './Icons'
import './ThreadRow.css'

interface ThreadRowProps {
  thread: Thread
  /** Render in the dark sidebar (light text) vs. the light project page. */
  variant?: 'light' | 'dark'
  /** When true, suppresses the "in project" folder indicator because the row
   *  is already rendered inside that project's page. */
  hideProjectIndicator?: boolean
  /** Navigate target when the row is clicked. Defaults to `/c/:threadId`. */
  href?: string
}

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

/**
 * Fallback title derived from the first user message when the LLM-generated
 * title isn't available yet (fresh thread waiting on the backend, or the
 * title-generation call failed). Keeps behaviour consistent with the
 * previous HistorySidebar humanizer.
 */
function humanizeFirstMessage(msg: string): string {
  const cleaned = msg.trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'New conversation'
  // Strip a few noisy conversational lead-ins that made earlier sidebars ugly.
  const stripped = cleaned.replace(
    /^(?:hi[,!.\s]+|hello[,!.\s]+|hey[,!.\s]+|please[,!.\s]+)/i,
    '',
  )
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1)
  return capitalized || cleaned
}

function labelForThread(thread: Thread): string {
  if (thread.title && thread.title.trim().length > 0) return thread.title
  if (thread.firstMessage) return humanizeFirstMessage(thread.firstMessage)
  return 'New conversation'
}

export function ThreadRow({
  thread,
  variant = 'light',
  hideProjectIndicator = false,
  href,
}: ThreadRowProps) {
  const workspace = useWorkspace()
  const modal = useModal()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [submenu, setSubmenu] = useState<'main' | 'move'>('main')
  const rowRef = useRef<HTMLDivElement | null>(null)

  const target = href ?? `/c/${thread.threadId}`
  const project = thread.projectId
    ? workspace.projects.find((p) => p.id === thread.projectId) ?? null
    : null

  const display = labelForThread(thread)
  const truncated = truncate(display, 44)

  // Close on outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rowRef.current) return
      if (!rowRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setSubmenu('main')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Close on Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setSubmenu('main')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const closeMenu = () => {
    setMenuOpen(false)
    setSubmenu('main')
  }

  const handlePin = async () => {
    closeMenu()
    if (thread.pinnedAt) await workspace.unpinThread(thread.threadId)
    else await workspace.pinThread(thread.threadId)
  }

  const handleMove = async (targetProjectId: string | null) => {
    closeMenu()
    const ok = await workspace.moveThreadToProject(
      thread.threadId,
      targetProjectId,
    )
    if (!ok) {
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not move the conversation. Please try again.',
      })
    }
  }

  const handleDelete = async () => {
    closeMenu()
    const preview = truncate(display, 80)
    const ok = await modal.confirm({
      title: 'Delete conversation?',
      message: `"${preview}"\n\nAll messages will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const deleted = await workspace.deleteThread(thread.threadId)
    if (!deleted) {
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not delete this conversation. Please try again.',
      })
      return
    }
    // If the user is currently looking at the thread they just deleted, send
    // them back to the landing page so the chat pane doesn't render a ghost.
    if (window.location.pathname === `/c/${thread.threadId}`) {
      navigate('/')
    }
  }

  return (
    <div
      ref={rowRef}
      className="thread-row-wrapper"
      style={{ position: 'relative' }}
    >
      <NavLink
        to={target}
        className={({ isActive }) => {
          const base = 'thread-row'
          const classes = [base]
          if (isActive) classes.push('thread-row-active')
          if (variant === 'dark') classes.push('thread-row-in-dark')
          return classes.join(' ')
        }}
        title={display + (project ? ` · ${project.name}` : '')}
      >
        <span className="thread-row-text">{truncated}</span>
        {(!hideProjectIndicator && project) || thread.pinnedAt ? (
          <span className="thread-row-meta">
            {thread.pinnedAt ? <IconPin size={11} /> : null}
            {!hideProjectIndicator && project ? (
              <span title={`In project: ${project.name}`}>
                <IconFolder size={11} />
              </span>
            ) : null}
          </span>
        ) : null}
        <button
          type="button"
          className="thread-row-menu-btn"
          data-open={menuOpen ? 'true' : 'false'}
          aria-label="Conversation actions"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen((v) => !v)
            setSubmenu('main')
          }}
        >
          <IconMore size={14} />
        </button>
      </NavLink>

      {menuOpen ? (
        <ThreadRowMenu
          thread={thread}
          projects={workspace.projects}
          submenu={submenu}
          setSubmenu={setSubmenu}
          onPin={handlePin}
          onMove={handleMove}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  )
}

interface MenuProps {
  thread: Thread
  projects: Project[]
  submenu: 'main' | 'move'
  setSubmenu: (s: 'main' | 'move') => void
  onPin: () => void
  onMove: (projectId: string | null) => void
  onDelete: () => void
}

function ThreadRowMenu({
  thread,
  projects,
  submenu,
  setSubmenu,
  onPin,
  onMove,
  onDelete,
}: MenuProps) {
  const move = useCallback(
    (projectId: string | null) => () => onMove(projectId),
    [onMove],
  )

  if (submenu === 'move') {
    return (
      <div className="thread-row-menu" role="menu">
        <div className="thread-row-menu-header">Move to project</div>
        <div className="thread-row-submenu">
          {thread.projectId ? (
            <button
              type="button"
              className="thread-row-menu-item"
              onClick={move(null)}
            >
              Remove from project
            </button>
          ) : null}
          {projects.length === 0 ? (
            <div className="thread-row-menu-empty">No projects yet</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="thread-row-menu-item"
                onClick={move(p.id)}
                disabled={thread.projectId === p.id}
                style={
                  thread.projectId === p.id ? { opacity: 0.5, cursor: 'default' } : undefined
                }
              >
                <IconFolder size={12} />
                <span>{p.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="thread-row-menu" role="menu">
      <button type="button" className="thread-row-menu-item" onClick={onPin}>
        {thread.pinnedAt ? <IconPinOff size={14} /> : <IconPin size={14} />}
        <span>{thread.pinnedAt ? 'Unpin' : 'Pin'}</span>
      </button>
      <button
        type="button"
        className="thread-row-menu-item"
        onClick={() => setSubmenu('move')}
      >
        <IconFolderMove size={14} />
        <span>Move to project…</span>
      </button>
      <div className="thread-row-menu-separator" />
      <button
        type="button"
        className="thread-row-menu-item thread-row-menu-item-danger"
        onClick={onDelete}
      >
        <IconTrash size={14} />
        <span>Delete</span>
      </button>
    </div>
  )
}
