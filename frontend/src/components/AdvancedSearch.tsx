import type { RetrievalMode } from '../lib/retrievalMode'
import { VOLUME_OPTIONS } from '../lib/volumes'
import './AdvancedSearch.css'

interface AdvancedSearchProps {
  filterVolume: number | null
  onFilterVolumeChange: (volume: number | null) => void
  retrievalMode: RetrievalMode
  disabled?: boolean
}

/**
 * Collapsible extras for chat retrieval. Volume filtering only affects the
 * pgvector path (and hybrid's pgvector leg); AnythingLLM has no doc filter.
 */
export function AdvancedSearch({
  filterVolume,
  onFilterVolumeChange,
  retrievalMode,
  disabled,
}: AdvancedSearchProps) {
  const volumeFilterEnabled = retrievalMode !== 'anythingllm'
  const selectDisabled = disabled || !volumeFilterEnabled

  return (
    <details className="advanced-search">
      <summary className="advanced-search-summary">Advanced search</summary>
      <div className="advanced-search-body">
        <label className="advanced-search-field">
          <span className="advanced-search-label">Volume</span>
          <select
            className="advanced-search-select"
            value={filterVolume ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              onFilterVolumeChange(raw === '' ? null : Number.parseInt(raw, 10))
            }}
            disabled={selectDisabled}
            aria-label="Filter search to a specific volume"
          >
            <option value="">All volumes</option>
            {VOLUME_OPTIONS.map((n) => (
              <option key={n} value={n}>
                Volume {n}
              </option>
            ))}
          </select>
        </label>
        {!volumeFilterEnabled ? (
          <p className="advanced-search-hint">
            Volume filter needs Hybrid or pgvector (AnythingLLM cannot scope by
            document).
          </p>
        ) : filterVolume != null ? (
          <p className="advanced-search-hint">
            Searching Volume {filterVolume} only
            {retrievalMode === 'hybrid' ? ' (pgvector leg)' : ''}.
          </p>
        ) : null}
      </div>
    </details>
  )
}
