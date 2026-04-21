import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useWorkspace, type Project } from '../lib/WorkspaceContext'
import { useModal } from '../components/Modal'
import { ThreadRow } from '../components/ThreadRow'
import { IconArrowLeft } from '../components/Icons'
import { generateThreadId } from '../lib/ids'
import type { ChatPageRouteState } from './ChatPage'
import './ProjectDetailPage.css'

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const workspace = useWorkspace()
  const project = useMemo<Project | null>(
    () => workspace.projects.find((p) => p.id === id) ?? null,
    [workspace.projects, id],
  )

  if (!id) {
    return (
      <div className="project-detail">
        <div className="project-detail-main">
          <div className="project-detail-missing">Project not found.</div>
        </div>
      </div>
    )
  }

  if (workspace.loading && !project) {
    return (
      <div className="project-detail">
        <div className="project-detail-main">
          <div style={{ color: 'rgba(74, 46, 24, 0.55)' }}>Loading…</div>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="project-detail">
        <div className="project-detail-main">
          <div className="project-detail-missing">
            <p>
              This project doesn't exist, or it was deleted.
            </p>
            <p>
              <Link to="/projects">← All projects</Link>
            </p>
          </div>
        </div>
      </div>
    )
  }

  return <ProjectDetailBody project={project} />
}

// Extracted into its own component so the hooks below are only mounted once
// we know a real project exists — otherwise the conditional early-returns
// above would violate the rules of hooks.
function ProjectDetailBody({ project }: { project: Project }) {
  const workspace = useWorkspace()
  const modal = useModal()
  const navigate = useNavigate()

  const threadsInProject = useMemo(
    () =>
      workspace.threads
        .filter((t) => t.projectId === project.id)
        .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
    [workspace.threads, project.id],
  )

  const handleSubmitNewChat = useCallback(
    (draft: string) => {
      const trimmed = draft.trim()
      if (!trimmed) return
      const threadId = generateThreadId()
      const state: ChatPageRouteState = {
        initialMessage: trimmed,
        projectId: project.id,
      }
      navigate(`/c/${threadId}`, { state })
    },
    [navigate, project.id],
  )

  return (
    <div className="project-detail">
      <div className="project-detail-main">
        <Link to="/projects" className="project-detail-back">
          <IconArrowLeft size={14} />
          <span>All projects</span>
        </Link>

        <ProjectHeader project={project} modal={modal} workspace={workspace} />

        <ProjectChatInput
          placeholder="How can I help you today?"
          onSubmit={handleSubmitNewChat}
          projectName={project.name}
        />

        <div>
          <h2 className="project-threads-header">Chats in this project</h2>
          {threadsInProject.length === 0 ? (
            <div className="project-threads-empty">
              Start a chat above to keep conversations organized and
              {project.instructions
                ? ' follow this project\'s instructions.'
                : ' re-use project knowledge.'}
            </div>
          ) : (
            <div className="project-threads-list">
              {threadsInProject.map((t) => (
                <ThreadRow key={t.threadId} thread={t} hideProjectIndicator />
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="project-detail-aside" aria-label="Project settings">
        <InstructionsPanel
          projectId={project.id}
          initial={project.instructions ?? ''}
        />
      </aside>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Editable header (title + description + delete)
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectHeaderProps {
  project: Project
  modal: ReturnType<typeof useModal>
  workspace: ReturnType<typeof useWorkspace>
}

function ProjectHeader({ project, modal, workspace }: ProjectHeaderProps) {
  const navigate = useNavigate()
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(project.name)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState(project.description ?? '')
  const descInputRef = useRef<HTMLTextAreaElement | null>(null)

  // Keep local drafts in sync when the project prop changes (e.g. another
  // tab renamed it). We only reset when the user isn't mid-edit, so their
  // in-progress typing doesn't get yanked from under them.
  useEffect(() => {
    if (!titleEditing) setTitleDraft(project.name)
  }, [project.name, titleEditing])
  useEffect(() => {
    if (!descEditing) setDescDraft(project.description ?? '')
  }, [project.description, descEditing])

  useEffect(() => {
    if (titleEditing) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [titleEditing])

  useEffect(() => {
    if (descEditing) {
      descInputRef.current?.focus()
    }
  }, [descEditing])

  const saveTitle = async () => {
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === project.name) {
      setTitleDraft(project.name)
      setTitleEditing(false)
      return
    }
    const ok = await workspace.renameProject(project.id, trimmed)
    setTitleEditing(false)
    if (!ok) {
      setTitleDraft(project.name)
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not rename the project. Please try again.',
      })
    }
  }

  const saveDescription = async () => {
    const trimmed = descDraft.trim()
    const prev = project.description ?? ''
    if (trimmed === prev) {
      setDescEditing(false)
      return
    }
    const ok = await workspace.updateProjectDescription(
      project.id,
      trimmed.length > 0 ? trimmed : null,
    )
    setDescEditing(false)
    if (!ok) {
      setDescDraft(prev)
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not save the description. Please try again.',
      })
    }
  }

  const handleTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setTitleDraft(project.name)
      setTitleEditing(false)
    }
  }

  const handleDescKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setDescDraft(project.description ?? '')
      setDescEditing(false)
    }
    // Allow Enter for newlines; save on blur instead.
  }

  const handleDelete = async () => {
    const threadCount = workspace.threads.filter(
      (t) => t.projectId === project.id,
    ).length
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
      return
    }
    navigate('/projects', { replace: true })
  }

  return (
    <>
      <div className="project-detail-title-row">
        {titleEditing ? (
          <input
            ref={titleInputRef}
            type="text"
            className="project-detail-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={handleTitleKey}
            maxLength={80}
          />
        ) : (
          <h1
            className="project-detail-title"
            onClick={() => setTitleEditing(true)}
            title="Click to rename"
          >
            {project.name}
          </h1>
        )}
        <button
          type="button"
          className="modal-btn modal-btn-secondary"
          onClick={handleDelete}
          style={{ height: 34, padding: '0 12px', minWidth: 'auto' }}
        >
          Delete project
        </button>
      </div>

      {descEditing ? (
        <textarea
          ref={descInputRef}
          className="project-detail-description-input"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => void saveDescription()}
          onKeyDown={handleDescKey}
          maxLength={280}
          rows={2}
          placeholder="Add a description"
        />
      ) : (
        <div
          className="project-detail-description"
          onClick={() => setDescEditing(true)}
          title="Click to edit description"
        >
          {project.description ?? ''}
        </div>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat input (for starting a new thread in this project)
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectChatInputProps {
  placeholder: string
  projectName: string
  onSubmit: (draft: string) => void
}

function ProjectChatInput({
  placeholder,
  projectName,
  onSubmit,
}: ProjectChatInputProps) {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-resize the textarea so multi-line drafts don't get clipped. Capped
  // by the CSS max-height so the page doesn't jump the chat input off-screen.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [draft])

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    onSubmit(draft)
    setDraft('')
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits, Shift+Enter inserts newline — matches chat UX conventions.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (draft.trim()) {
        onSubmit(draft)
        setDraft('')
      }
    }
  }

  return (
    <div className="project-input-card">
      <div className="project-input-prompt">{placeholder}</div>
      <form className="project-input-form" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          className="project-input-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Start a chat in ${projectName}…`}
          rows={1}
        />
        <button
          type="submit"
          className="project-input-submit"
          disabled={!draft.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Instructions aside panel
// ─────────────────────────────────────────────────────────────────────────────

interface InstructionsPanelProps {
  projectId: string
  initial: string
}

function InstructionsPanel({ projectId, initial }: InstructionsPanelProps) {
  const workspace = useWorkspace()
  const modal = useModal()
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)

  // Sync local draft if the underlying instructions change (from another
  // tab or a different navigation into the same project). Only reset if the
  // user has no unsaved edits, otherwise their typing gets obliterated.
  useEffect(() => {
    setDraft((current) => (current === '' || current === initial ? initial : current))
  }, [initial])

  const dirty = draft !== initial

  const handleSave = async () => {
    if (!dirty || saving) return
    setSaving(true)
    const ok = await workspace.updateProjectInstructions(
      projectId,
      draft.trim().length > 0 ? draft : null,
    )
    setSaving(false)
    if (!ok) {
      await modal.alert({
        title: 'Something went wrong',
        message: 'Could not save instructions. Please try again.',
      })
    }
  }

  const handleRevert = () => {
    setDraft(initial)
  }

  return (
    <div className="project-aside-panel">
      <div className="project-aside-panel-header">
        <h3 className="project-aside-panel-title">Instructions</h3>
      </div>
      <p className="project-aside-panel-subtitle">
        Added to every chat in this project as a system prompt. Use it for
        recurring context the model should always respect — tone, audience,
        citation style, etc.
      </p>
      <textarea
        className="project-aside-instructions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Respond in the style of a devotional reflection; cite Book of Heaven volumes when possible."
        maxLength={4000}
      />
      <div className="project-aside-save-row">
        {dirty ? (
          <button
            type="button"
            className="project-aside-save-btn project-aside-save-btn-secondary"
            onClick={handleRevert}
            disabled={saving}
          >
            Revert
          </button>
        ) : null}
        <button
          type="button"
          className="project-aside-save-btn"
          onClick={handleSave}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {dirty ? (
        <div className="project-aside-save-hint">Unsaved changes</div>
      ) : null}
    </div>
  )
}
