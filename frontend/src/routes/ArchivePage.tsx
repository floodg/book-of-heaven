import { useMemo, useState } from 'react'
import { useWorkspace } from '../lib/WorkspaceContext'
import { filterThreadsByQuery } from '../lib/threadSearch'
import { ThreadRow } from '../components/ThreadRow'
import { ChatSearch } from '../components/ChatSearch'
import { IconArchive } from '../components/Icons'
import './ArchivePage.css'

export function ArchivePage() {
  const workspace = useWorkspace()
  const [query, setQuery] = useState('')

  const archived = useMemo(
    () =>
      workspace.threads
        .filter((t) => t.archivedAt)
        .sort((a, b) => ((a.archivedAt ?? '') < (b.archivedAt ?? '') ? 1 : -1)),
    [workspace.threads],
  )

  const visible = useMemo(
    () => filterThreadsByQuery(archived, query),
    [archived, query],
  )

  const searching = query.trim().length > 0

  return (
    <div className="archive-page">
      <header className="archive-page-header">
        <div className="archive-page-title-row">
          <IconArchive size={20} />
          <h1 className="archive-page-title">Archive</h1>
        </div>
        <p className="archive-page-subtitle">
          Archived conversations are hidden from your sidebar and projects, but
          you can still open and continue them here.
        </p>
        {archived.length > 0 ? (
          <div className="archive-page-search">
            <ChatSearch value={query} onChange={setQuery} />
          </div>
        ) : null}
      </header>

      {workspace.loading ? (
        <div className="archive-page-loading">Loading…</div>
      ) : archived.length === 0 ? (
        <div className="archive-page-empty">
          <IconArchive size={28} />
          <p>No archived conversations.</p>
          <p className="archive-page-empty-hint">
            Archive a chat from its ⋯ menu to tidy up your sidebar without
            deleting it.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="archive-page-empty">
          <p>No archived conversations match “{query.trim()}”.</p>
        </div>
      ) : (
        <div className="archive-page-list">
          {searching ? (
            <p className="archive-page-count">
              {visible.length} match{visible.length === 1 ? '' : 'es'}
            </p>
          ) : null}
          {visible.map((t) => (
            <ThreadRow key={t.threadId} thread={t} variant="light" />
          ))}
        </div>
      )}
    </div>
  )
}
