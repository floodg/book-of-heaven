import './ModelSelector.css'

export const DEFAULT_MODEL_SENTINEL = 'workspace-default'

/** Models supported by the legacy AnythingLLM chat-proxy edge function. */
export const LEGACY_CHAT_MODELS: { label: string; value: string }[] = [
  { label: 'Default model', value: DEFAULT_MODEL_SENTINEL },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
]

/** Full model list for the pgvector RAG research-chat edge function. */
export const CHAT_MODELS: { label: string; value: string }[] = [
  { label: 'Default model', value: DEFAULT_MODEL_SENTINEL },
  // Anthropic
  { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5' },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  // OpenAI
  { label: 'GPT-4o mini', value: 'gpt-4o-mini' },
  // Google
  { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
  // Groq / Meta
  { label: 'Llama 3.3 70B (Groq)', value: 'llama-3-3-70b' },
]

interface ModelSelectorProps {
  value: string
  onChange: (model: string) => void
  disabled?: boolean
  models?: { label: string; value: string }[]
}

export function ModelSelector({ value, onChange, disabled, models = CHAT_MODELS }: ModelSelectorProps) {
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
        {models.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}
