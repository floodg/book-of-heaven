import { useCallback } from 'react'
import {
  savePreferredRetrievalMode,
  type RetrievalMode,
} from '../lib/retrievalMode'
import './SourceToggle.css'

const OPTIONS: { value: RetrievalMode; label: string; title: string }[] = [
  {
    value: 'anythingllm',
    label: 'AnythingLLM',
    title: 'Use the existing AnythingLLM retrieval/chat behavior',
  },
  {
    value: 'pgvector',
    label: 'pgvector',
    title: 'Use Supabase pgvector retrieval and show raw semantic hits',
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    title: 'Run pgvector raw hits and AnythingLLM independently',
  },
]

interface RetrievalModeToggleProps {
  value: RetrievalMode
  onChange: (next: RetrievalMode) => void
  disabled?: boolean
  className?: string
}

export function RetrievalModeToggle({
  value,
  onChange,
  disabled,
  className,
}: RetrievalModeToggleProps) {
  const handleSelect = useCallback(
    (next: RetrievalMode) => {
      if (disabled || next === value) return
      savePreferredRetrievalMode(next)
      onChange(next)
    },
    [disabled, value, onChange],
  )

  return (
    <div
      className={className ? `source-toggle ${className}` : 'source-toggle'}
      role="radiogroup"
      aria-label="Retrieval mode"
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={opt.title}
            disabled={disabled}
            className={
              selected
                ? 'source-toggle-option source-toggle-option-selected'
                : 'source-toggle-option'
            }
            onClick={() => handleSelect(opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
