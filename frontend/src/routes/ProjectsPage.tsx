import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useWorkspace, type Project } from '../lib/WorkspaceContext'
import { useModal } from '../components/Modal'
import {
  IconMore,
  IconPlus,
  IconSearch,
  IconSort,
  IconTrash,
} from '../components/Icons'
import { relativeTime } from '../lib/time'
import './ProjectsPage.css'

type SortKey = 'recent' | 'alphabetical' | 'created'

const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently updated',
  alphabetical: 'Name (A–Z)',
  created: 'Recently created',
}

export function ProjectsPage() {
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const modal = useModal()

  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('recent')
  const [sortOpen, setSortOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement | null>(null)

  // Close sort menu on outside click.
  useEffect(() => {
    if (!sortOpen) return
    const handler = (e: MouseEvent) => {
      if (!sortRef.current) return
      if (!sortRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sortOpen])

  // Derive thread-counts once so each card can show "N chats" cheaply.
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of workspace.threads) {
      if (!t.projectId) continue
      counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1)
    }
    return counts
  }, [workspace.threads])

  // Per-project last activity — the max lastMessageAt across all of its
  // threads. Falls back to the project's own updatedAt when the project has
  // no threads yet so sort-by-recent still gives a sensible slot for an
  // empty-but-just-created project.
  const lastActivity = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of workspace.threads) {
      if (!t.projectId) continue
      const prev = map.get(t.projectId)
      if (!prev || t.lastMessageAt > prev) map.set(t.projectId, t.lastMessageAt)
    }
    return map
  }, [workspace.threads])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = workspace.projects
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q),
      )
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'alphabetical':
          return a.name.localeCompare(b.name)
        case 'created':
          return a.createdAt < b.createdAt ? 1 : -1
        case 'recent':
        default: {
          const aAct = lastActivity.get(a.id) ?? a.updatedAt
          const bAct = lastActivity.get(b.id) ?? b.updatedAt
          return aAct < bAct ? 1 : -1
        }
      }
    })
    return sorted
  }, [workspace.projects, query, sortKey, lastActivity])

  const handleDelete = async (project: Project) => {
    const threadCount = threadCounts.get(project.id) ?? 0
    const ok = await modal.confirm({
      title: threadCount === 0 ? 'Delete project?' : `Delete project and ${threadCount} conversation${threadCount === 1 ? '' : 's'}?`,
      message:
        threadCount === 0
          ? `"${project.name}" will be permanently deleted. This cannot be undone.`
          : `"${project.name}" and all ${threadCount} conversation${threadCount === 1 ? '' : 's'} inside it will be permanently deleted.\n\nThis cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const deleted = await workspace.deleteProject(project.id)
    if (!deleted) {
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not delete the project. Please try again.',
      })
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="projects-toolbar">
          <h1 className="projects-title">Projects</h1>
          <div className="projects-toolbar-actions">
            <div className="projects-search">
              <IconSearch size={14} />
              <input
                type="text"
                placeholder="Search projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="projects-sort" ref={sortRef}>
              <button
                type="button"
                className="projects-toolbar-icon-btn"
                data-active={sortOpen ? 'true' : 'false'}
                onClick={() => setSortOpen((v) => !v)}
                title={`Sort: ${SORT_LABELS[sortKey]}`}
                aria-label="Sort projects"
              >
                <IconSort size={16} />
              </button>
              {sortOpen ? (
                <div className="projects-sort-menu" role="menu">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className="projects-sort-option"
                      data-selected={key === sortKey ? 'true' : 'false'}
                      onClick={() => {
                        setSortKey(key)
                        setSortOpen(false)
                      }}
                    >
                      {SORT_LABELS[key]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="projects-new-btn"
              onClick={() => setNewOpen(true)}
            >
              <IconPlus size={14} />
              <span>New project</span>
            </button>
          </div>
        </div>

        {workspace.loading ? (
          <div style={{ color: 'rgba(74, 46, 24, 0.6)' }}>Loading…</div>
        ) : filtered.length === 0 && workspace.projects.length === 0 ? (
          <div className="projects-empty">
            <h2 className="projects-empty-title">No projects yet</h2>
            <p className="projects-empty-body">
              Projects group related chats and can carry their own instructions.
              Try one for each long-running topic you care about.
            </p>
            <button
              type="button"
              className="projects-new-btn"
              onClick={() => setNewOpen(true)}
            >
              <IconPlus size={14} />
              <span>New project</span>
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="projects-empty">
            <p className="projects-empty-body">
              No projects match “{query}”.
            </p>
          </div>
        ) : (
          <div className="projects-grid">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                threadCount={threadCounts.get(p.id) ?? 0}
                lastActivity={lastActivity.get(p.id) ?? p.updatedAt}
                onDelete={() => handleDelete(p)}
              />
            ))}
          </div>
        )}
      </div>

      {newOpen ? (
        <NewProjectModal
          onCancel={() => setNewOpen(false)}
          onCreated={(p) => {
            setNewOpen(false)
            navigate(`/projects/${p.id}`)
          }}
        />
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Project card
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project
  threadCount: number
  lastActivity: string
  onDelete: () => void
}

function ProjectCard({
  project,
  threadCount,
  lastActivity,
  onDelete,
}: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const cardRef = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (!cardRef.current) return
      if (!cardRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <Link
      ref={cardRef}
      to={`/projects/${project.id}`}
      className="project-card"
    >
      <div className="project-card-header">
        <div className="project-card-name">{project.name}</div>
        <button
          type="button"
          className="project-card-menu-btn"
          data-open={menuOpen ? 'true' : 'false'}
          aria-label="Project actions"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          <IconMore size={14} />
        </button>
        {menuOpen ? (
          <div className="project-card-menu" role="menu">
            <button
              type="button"
              className="project-card-menu-item danger"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenuOpen(false)
                onDelete()
              }}
            >
              <IconTrash size={14} />
              <span>Delete project</span>
            </button>
          </div>
        ) : null}
      </div>

      {project.description ? (
        <div className="project-card-description">{project.description}</div>
      ) : (
        <div className="project-card-empty-description">No description</div>
      )}

      <div className="project-card-footer">
        <span>
          {threadCount === 0
            ? 'No chats yet'
            : `${threadCount} chat${threadCount === 1 ? '' : 's'}`}
        </span>
        <span>{relativeTime(lastActivity)}</span>
      </div>
    </Link>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// New project modal
// ─────────────────────────────────────────────────────────────────────────────

interface NewProjectModalProps {
  onCancel: () => void
  onCreated: (project: Project) => void
}

function NewProjectModal({ onCancel, onCreated }: NewProjectModalProps) {
  const workspace = useWorkspace()
  const modal = useModal()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || submitting) return
    setSubmitting(true)
    const project = await workspace.createProject({
      name: trimmedName,
      description: description.trim() || null,
    })
    setSubmitting(false)
    if (!project) {
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not create the project. Please try again.',
      })
      return
    }
    onCreated(project)
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <form
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onSubmit={handleSubmit}
        style={{ maxWidth: 480 }}
      >
        <h2 id="new-project-title" className="modal-title">
          New project
        </h2>
        <div className="modal-message">
          <label
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 500,
              color: '#2a1408',
              marginBottom: 6,
            }}
          >
            Name
          </label>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. daily-catholic"
            required
            maxLength={80}
            style={{
              width: '100%',
              padding: '9px 12px',
              border: '1px solid #e7d5b3',
              borderRadius: 8,
              fontSize: 14,
              fontFamily: 'inherit',
              color: '#2a1408',
              background: '#ffffff',
              outline: 'none',
              marginBottom: 14,
            }}
          />
          <label
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 500,
              color: '#2a1408',
              marginBottom: 6,
            }}
          >
            Description <span style={{ color: 'rgba(74, 46, 24, 0.5)', fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project about?"
            rows={3}
            maxLength={280}
            style={{
              width: '100%',
              padding: '9px 12px',
              border: '1px solid #e7d5b3',
              borderRadius: 8,
              fontSize: 14,
              fontFamily: 'inherit',
              color: '#2a1408',
              background: '#ffffff',
              outline: 'none',
              resize: 'vertical',
              minHeight: 64,
            }}
          />
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="modal-btn modal-btn-primary"
            disabled={!name.trim() || submitting}
          >
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  )
}
