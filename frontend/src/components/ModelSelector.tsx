import './ModelSelector.css'

export const DEFAULT_MODEL_SENTINEL = 'workspace-default'

export const CHAT_MODELS: { label: string; value: string }[] = [
  { label: 'Default workspace model', value: DEFAULT_MODEL_SENTINEL },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
]

interface ModelSelectorProps {
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}

export function ModelSelector({ value, onChange, disabled }: ModelSelectorProps) {
  return (
    <label className="model-selector">
      <span className="model-selector-label">Model</span>
      <select
        className="model-selector-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Chat model"
      >
        {CHAT_MODELS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}
