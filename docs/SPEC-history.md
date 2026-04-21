# Spec: History Sidebar

## File
`frontend/src/components/HistorySidebar.tsx`

---

## Purpose
Left sidebar showing the current user's past conversations, grouped by recency. Allows switching between threads, starting new ones, and deleting individual threads.

---

## Props
```typescript
interface HistorySidebarProps {
  user: User
  activeThreadId: string | null         // UUID of the active thread, or null for a fresh "New Chat" state
  onSelectThread: (threadId: string, firstMessage: string) => void
  onNewThread: () => void
  onThreadDeleted: (threadId: string) => void
  refreshToken: number                  // bump from App.tsx to force a re-query after a new assistant response
}
```

---

## Data

### Thread concept
Each thread is identified by a `thread_id uuid` column on `chat_messages`. The UUID is minted by the frontend the first time a user sends a message in a fresh chat (see `SPEC-chat-ui.md`), passed through the Edge Function, and stored on both the user row and the assistant row.

This replaces the earlier v1 simplification where a thread was defined as "all messages from the same calendar day". That approach merged every same-day conversation into one bucket, so clicking "New Chat" within the same day silently continued the existing thread. The real `thread_id` column keeps every "New Chat" click as its own independent conversation, regardless of date.

The `"Today" / "Yesterday" / "This week" / "Earlier"` grouping labels are still derived from `created_at`, but each group can now contain multiple distinct threads.

### Query
```typescript
const { data } = await supabase
  .from('chat_messages')
  .select('id, content, created_at, thread_id')
  .eq('user_id', user.id)
  .eq('role', 'user')
  .order('created_at', { ascending: true })
  .limit(500)
```

Client-side:
1. Bucket rows by `thread_id`
2. Within each bucket, keep the **earliest** user message as the thread title and its `created_at` as the thread timestamp
3. Sort threads newest-first by that first-message timestamp
4. Group by recency label ("Today", "Yesterday", "This week", "Earlier") using `created_at`

`.limit(500)` is a rough ceiling on total user messages fetched per load. If any user regularly exceeds this, we'll move to a `threads` view that returns one row per `thread_id` with the first message already joined.

---

## Layout

```
┌─────────────────────┐
│  Book of Heaven     │
│                     │
│  [+ New Chat]       │
│                     │
│  Today              │
│  • Soul who lives…  ← active, highlighted
│  • Luisa on mercy…  │
│                     │
│  Yesterday          │
│  • Luisa says…      │
│  • Key requireme…   │
│                     │
│  Earlier            │
│  • Primary themes…  │
│  • The sublimity…   │
│                     │
└─────────────────────┘
```

Hovering a thread row reveals a trash icon at the right edge for deletion.

---

## Behaviour

- Active thread highlighted with warm brown background + white text
- Hover state on inactive threads: light warm tint; trash icon fades in
- Thread title = first 40 chars of the earliest user message for that `thread_id`, truncated with ellipsis
- Grouping labels: "Today", "Yesterday", "This week", "Earlier" — computed from the thread's first message `created_at`
- **New Chat** button at top: calls `onNewThread()` which clears `activeThreadId` to `null`, resetting ChatWindow to an empty state. The next message submission mints a new `thread_id` UUID.
- **Thread click**: calls `onSelectThread(threadId, firstMessage)` which loads that thread's messages into ChatWindow via `thread_id` equality (no date range).
- **Delete thread**:
  - Hovering a thread reveals a trash icon
  - Clicking it shows `window.confirm()` with a preview of the thread title
  - On confirm, issues `delete from chat_messages where user_id = ? and thread_id = ?` (RLS policy also enforces `user_id = auth.uid()`)
  - On success: removes the thread locally and calls `onThreadDeleted(threadId)` so `App.tsx` can clear `activeThreadId` if it matched the deleted thread and refresh the sidebar

---

## Styling

- Width: 256px, fixed, not collapsible in v1
- Background: `#1c0a00` (deep dark brown) — sidebar is dark, main area is light
- Text: `#f5e6d3` (warm cream)
- Active item: `#92400e` background, white text
- Hover item: `rgba(255,255,255,0.08)` background
- Group labels: `#a07850` (muted gold), uppercase, small, semibold, letter-spacing
- New Chat button: outlined style, cream border, cream text, hover fills with brown tint
- Thread titles: small, truncated, cursor-pointer
- Trash icon: 14×14, appears on hover/focus of the row, warm red on hover

---

## Loading state
Show 4–5 skeleton placeholder rows with an animated pulse while fetching.

---

## Empty state
If the user has no messages yet, show a small icon with text:
"No conversations yet. Ask your first question below."

---

## Refresh behaviour
After each new assistant response in ChatWindow, `App.tsx` increments a `historyRefresh` counter and passes it as the `refreshToken` prop. `HistorySidebar` re-runs its query whenever `refreshToken` changes, so:

- A brand-new thread appears in "Today" immediately after its first assistant reply
- A deleted thread disappears immediately after the `delete` call succeeds, without a full page reload
