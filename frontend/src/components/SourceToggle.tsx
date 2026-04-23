import { useCallback } from 'react'
import { savePreferredSource, type Source } from '../lib/source'
import './SourceToggle.css'

// Short label + hover tooltip per option. The labels are deliberately
// single-word so the segmented control stays compact next to the input.
const OPTIONS: { value: Source; label: string; title: string }[] = [
  { value: 'text', label: 'Text', title: 'Search the diary PDFs only' },
  { value: 'narrated', label: 'Narrated', title: 'Search the audio transcripts only' },
  { value: 'both', label: 'Both', title: 'Search both sources and show replies side-by-side' },
]

interface SourceToggleProps {
  value: Source
  onChange: (next: Source) => void
  disabled?: boolean
  /** Extra class for the wrapping segmented control (e.g. to align it inside
   *  an existing form). */
  className?: string
}

export function SourceToggle({
  value,
  onChange,
  disabled,
  className,
}: SourceToggleProps) {
  const handleSelect = useCallback(
    (next: Source) => {
      if (disabled || next === value) return
      savePreferredSource(next)
      onChange(next)
    },
    [disabled, value, onChange],
  )

  return (
    <div
      className={
        className ? `source-toggle ${className}` : 'source-toggle'
      }
      role="radiogroup"
      aria-label="Source to search"
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
