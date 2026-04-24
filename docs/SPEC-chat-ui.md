# Spec: Chat UI

## Files
```
frontend/src/components/ChatWindow.tsx
frontend/src/components/ChatJobNotifier.tsx
frontend/src/routes/ProtectedLayout.tsx
frontend/src/components/CitationBadge.tsx
```

---

## ChatWindow.tsx

### Purpose
Main chat interface. Displays the messages in the active thread and handles sending new messages to the Edge Function.

### Props
```typescript
interface ChatWindowProps {
  user: User
  session: Session
  threadId: string | null                            // UUID of the active thread, or null for a fresh "New Chat"
  onAssistantResponse?: (threadId: string) => void   // notify App.tsx that a reply landed (possibly on a just-minted thread_id)
}
```

### State
```typescript
const [messages, setMessages] = useState<Message[]>([])
const [input, setInput] = useState('')
const [loading, setLoading] = useState(false)
const skipNextFetchForRef = useRef<string | null>(null)
```

`skipNextFetchForRef` avoids a redundant refetch-and-flicker right after this component itself mints a new `thread_id`: the parent echoes that UUID back as a prop change, which would normally trigger the loader `useEffect` to re-query the DB and replace the just-inserted local messages with identical rows. We skip that one fetch.

### Message type
```typescript
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
```

### Loading thread messages
When `threadId` changes to a non-null UUID, load that thread's messages (no date range — threads are identified purely by UUID):
```typescript
supabase
  .from('chat_messages')
  .select('*')
  .eq('user_id', user.id)
  .eq('thread_id', threadId)
  .order('created_at', { ascending: true })
```
When `threadId` is `null`, clear messages to `[]` to show an empty "new chat" state.

### Sending a message

1. Compute `isNewThread = !threadId` and `submitThreadId = threadId ?? crypto.randomUUID()`.
2. Append the user message to local `messages` state immediately (optimistic).
3. Clear input, set `loading = true`.
4. POST to `chat-proxy` with `message`, `thread_id`, a client-minted `turn_id` (UUID) for idempotency and grouping, and `source` (`text` | `narrated` | `both`); include `project_id` when the thread is being created in a project context. See the edge spec for the exact contract.
   ```typescript
   const res = await fetch(
     `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-proxy`,
     {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${session.access_token}`,
         'Content-Type': 'application/json',
       },
       body: JSON.stringify({
         message: trimmed,
         thread_id: submitThreadId,
         turn_id: submitTurnId,
         source: effectiveSource,
         project_id: projectId ?? undefined,
       }),
     },
   )
   ```
5. Handle the response:
   - **`res.status === 200`** (idempotent replay, same `turn_id` as an already-finished job) — parse the JSON body with `replies` (and optional `title`), append the assistant message(s) like before, set `skipNextFetchForRef` for new threads, call `onAssistantResponse`, then `setLoading(false)`.
   - **`res.status === 202`** (normal path) — read `job_id` from the body. Open `EventSource` to `…/functions/v1/chat-job-events?job_id=…&access_token=<session access token>`, parse each SSE `data:` JSON line. On `event: "complete"`, use `payload` as the same `replies` structure as 200, merge assistant bubbles, `setLoading(false)`, call `onAssistantResponse`. On `event: "error"`, show an assistant error bubble. If the stream errors or times out, **leave loading true** — a Supabase Realtime `INSERT` on `chat_messages` for this `thread_id` and `turn_id` still applies the result (and expects two assistant rows when the user source is `both` before turning off the typing indicator). Close the `EventSource` when done or on unmount.
   - **`res.status === 401`** — token is dead. Show a clear "Your session has expired… signing you out" bubble, call `supabase.auth.signOut()`, and let the app's `onAuthStateChange` listener route back to `AuthPage`. Do **not** retry.
   - **`res.status === 409`** — this `turn_id` already failed on the server; show the server `error` string.
   - **Other non-2xx** — clone the response and try to read `{ error: "..." }`; display that message verbatim. Fall back to status-based copy (`"The server hit an unexpected error…"` for 5xx, `"The request was rejected. Please refresh and try again."` for 400, etc.) if no `error` field is present.
   - **Network-level failure (thrown from `fetch`)** → show `"Could not reach the assistant. Check that the Supabase functions server is running and try again."`.
6. `finally` — call `setLoading(false)` only when the request is **not** waiting on a background job (`202` defers the finally until SSE or Realtime applies the reply; see implementation).

### `ChatJobNotifier` (global toast)

`ProtectedLayout` renders `ChatJobNotifier` so that Supabase Realtime on `INSERT` to `chat_messages` (role `assistant`) and `UPDATE` to `chat_turn_jobs` (`status: error`) can show a fixed-position toast with a "View" link to `/c/<threadId>` when the event is for a **different** thread than the one in the current URL. It calls `WorkspaceContext.refresh()` so the sidebar picks up new titles and thread rows.

### Auto-scroll
After each new message (and when `loading` toggles to show the typing indicator), scroll the message list to the bottom via a ref and `ref.current?.scrollIntoView({ behavior: 'smooth' })`.

### Layout
```
┌────────────────────────────────────────┐
│  [message thread — scrollable]         │
│                                        │
│        [user bubble right-aligned]     │
│  [assistant bubble left-aligned]       │
│    markdown-rendered with citations    │
│                                        │
│  [loading indicator when waiting]      │
│                                        │
├────────────────────────────────────────┤
│  [text input]           [Send button]  │
└────────────────────────────────────────┘
```

### Message bubbles

**User messages:**
- Right-aligned
- Background: `#92400e` (warm brown)
- Text: white
- Rounded: large corners, small top-right corner
- Max width: 75%

**Assistant messages:**
- Left-aligned
- Background: `#fdf8f0` (warm cream)
- Border: `1px solid #e7d5b3`
- Text: `#1c0a00`
- Rounded: large corners, small top-left corner
- Max width: 85% (wider to accommodate citations)
- Content is rendered via `react-markdown` so the LLM's `**bold**`, `##` headings, lists, and blockquotes come through as real HTML instead of literal characters.
- Citation highlighting (see below) is applied inside the markdown's block-level component overrides (`p`, `li`, `h1`–`h4`, `blockquote`) only, so nested inline elements don't double-wrap pills.

### Loading indicator
When `loading === true`, show a typing indicator in the assistant position:
- Three animated dots (CSS pulse animation)
- Same styling as assistant bubble

### Input bar
- Full-width text input, warm white background, brown border on focus
- Send button: warm brown background, white text
- Disable both while `loading === true`
- Submit on Enter key (no shift+enter for multiline in v1)
- Placeholder: "Ask about the Book of Heaven..."

---

## CitationBadge.tsx

### Purpose
Scans rendered text for Book of Heaven citation patterns and swaps the matching substrings for styled badge elements inline with the surrounding text.

### Citation patterns detected
Broader than v1 — the LLM produces several formats and they should all render as pills:
```
[Book of Heaven Volume 14 - Number 1]
[Book of Heaven Volume 14 – Number 1]
[Vol 18 - audio 9]
[Vol 20 - audio No 7]
[... (00:17:26-00:18:27)]        ← timestamped audio citations
```
A single permissive regex handles all of them.

### API
Exported as a helper rather than a component:
```typescript
export function highlightCitations(children: React.ReactNode): React.ReactNode
```

- Accepts any React node (string, element, array).
- Recursively walks children; for each string segment, splits on the citation regex and wraps matches in `<span className="citation-badge">`.
- Called from the `react-markdown` `components` map at block level only; the internal recursion handles nested inline elements like `<strong>` / `<em>` / `<a>` correctly without double-wrapping.

### Citation badge style
```
display: inline-block       ← prevents overlap when pills wrap across lines
background: #fef3c7         (amber-100)
border: 1px solid #f59e0b   (amber-400)
color: #92400e              (amber-900)
font-size: 11px
font-weight: 500
padding: 2px 8px
border-radius: 9999px       (pill shape)
line-height: 1.4
vertical-align: baseline
max-width: 100%
overflow: hidden
text-overflow: ellipsis
margin: 0 2px
```

`display: inline-block` is deliberate — earlier `display: inline` caused pills to visually overlap each other when adjacent, and broke vertical rhythm when a pill wrapped to the next line.

### Example
Input markdown (from AnythingLLM):
```
Jesus teaches that the soul **living in His Divine Will** remains always young. [Book of Heaven Volume 17 - Number 13] This unity opens heaven to the soul.
```

Renders as:
```
Jesus teaches that the soul living in His Divine Will remains always young.
[amber pill: Book of Heaven Volume 17 - Number 13]
This unity opens heaven to the soul.
```

With `living in His Divine Will` bolded via `<strong>`, and the citation rendered as a single amber pill inline with the paragraph.
