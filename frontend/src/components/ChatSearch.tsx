import { IconSearch } from './Icons'
import './ChatSearch.css'

interface ChatSearchProps {
  value: string
  onChange: (value: string) => void
  variant?: 'dark' | 'light'
  placeholder?: string
}

export function ChatSearch({
  value,
  onChange,
  variant = 'light',
  placeholder = 'Search chats…',
}: ChatSearchProps) {
  return (
    <div className={`chat-search chat-search-${variant}`} role="search">
      <IconSearch size={14} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label="Search chats"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  )
}
