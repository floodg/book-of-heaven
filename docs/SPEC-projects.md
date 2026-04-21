# Spec: Projects

## Files
- `supabase/migrations/004_chat_organization.sql` — initial `chat_projects` + `chat_threads.project_id`
- `supabase/migrations/005_projects_redesign.sql` — drops Labels, adds `description` / `instructions`, adds `chat_threads.pinned_at`
- `frontend/src/routes/ProjectsPage.tsx` — grid / sort / search / new-project modal
- `frontend/src/routes/ProjectDetailPage.tsx` — detail page: title, description, instructions, chat input, threads list
- `frontend/src/lib/WorkspaceContext.tsx` — shared state + CRUD
- `supabase/functions/chat-proxy/index.ts` — per-project instructions injection

---

## Purpose

A project is a user-owned folder that groups chat threads and injects a shared system prompt into every thread inside it. The UI is modeled on ChatGPT / Claude projects:

- **Projects page** at `/projects`: grid of cards with sort + search + "New project".
- **Project detail page** at `/projects/:id`: title, description, chat input for starting a new thread in the project, list of threads in the project, and an Instructions panel.

A thread belongs to at most one project; it can also live on its own (no project). Every thread — including those inside projects — still appears in the sidebar's `Recents` list so users can navigate chronologically without diving into a project.

---

## Schema

### `chat_projects`
```
chat_projects(
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users not null,
  name          text not null,
  description   text null,                   -- shown on the project card + detail page
  instructions  text null,                   -- per-project system prompt, injected by chat-proxy
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
)
```
- RLS policy: `auth.uid() = user_id` (select/insert/update/delete).
- Indexes: `(user_id, created_at)`.
- `description` and `instructions` were added in migration 005. Both are nullable; empty / whitespace-only strings are coerced to NULL on write so the "project has instructions" check is simple (`instructions is not null and trim(instructions) <> ''`).

### `chat_threads.project_id`
```sql
alter table chat_threads
  add column project_id uuid references chat_projects(id) on delete set null;
create index on chat_threads (user_id, project_id);
```
- FK is `on delete set null` at the DB level, **but the application performs the full cascade** (messages + thread rows + project) inside `deleteProject`, because `chat_messages` isn't reachable from `chat_projects` via FK and we want a single atomic user action that removes everything inside a project.

### `chat_threads.pinned_at`
```sql
alter table chat_threads add column pinned_at timestamptz;
create index on chat_threads (user_id, pinned_at desc) where pinned_at is not null;
```
- Null = not pinned (default). When non-null, the thread appears in the sidebar's Pinned section, sorted by `pinned_at desc`.
- Partial index so lookups for "my pinned threads" don't scan every thread in the account.

### Labels (removed)
Migration 005 drops `chat_thread_labels` and `chat_labels` outright. The Labels feature was introduced in 004 and removed before shipping; no historical data is preserved.

---

## Edge Function behaviour

### Thread upsert
When the edge function handles a chat message, it upserts a `chat_threads` row (with `onConflict: 'thread_id', ignoreDuplicates: true`) so every thread is addressable immediately, even if title generation later fails:

```typescript
const upsertPayload = { thread_id, user_id }
if (incomingProjectId) upsertPayload.project_id = incomingProjectId
await supabase.from('chat_threads').upsert(upsertPayload, {
  onConflict: 'thread_id',
  ignoreDuplicates: true,
})
```

`project_id` is only honoured on **first insert**. If the thread already exists, `ignoreDuplicates: true` means the upsert is a no-op — so the edge function can't be tricked into moving threads between projects via the chat message body. Move operations go through `WorkspaceContext.moveThreadToProject` directly against `chat_threads`.

### Instructions injection
After inserting the user message, the edge function re-reads `chat_threads` (for `title` and `project_id`). If the thread lives in a project and that project has non-empty `instructions`, they're prepended to the message sent to AnythingLLM as an inline system-style preamble:

```text
You are acting inside a user's project. Follow these project-level
instructions for the rest of this conversation:

---
{project.instructions}
---

User message:
{message}
```

Notes:
- AnythingLLM's `/stream-chat` endpoint doesn't expose a per-request system prompt slot, so baking instructions into `message` is the least invasive integration.
- The title-generation LLM call intentionally skips instructions. Titles describe the user's question, not the project's framing.
- The project row is always fetched server-side (never trusted from the request body) so a client can't inject someone else's instructions by spoofing a `project_id`.

---

## UI contract

### Projects page (`/projects`)
| Element | Behaviour |
|---|---|
| Title + toolbar | `Projects` heading, search input, sort icon (menu: Recently updated / Name A–Z / Recently created), `+ New project` button. |
| Search | Client-side filter on `name` + `description`. Empty query shows everything. |
| Sort | Recently updated is the default and uses per-project last-thread-activity (falling back to the project's own `updated_at` for empty projects). |
| New project modal | Inline dialog with `Name` (required, ≤80 chars) + `Description` (optional, ≤280 chars). On submit, inserts via `createProject`, closes, and navigates to `/projects/:id`. |
| Card | Name (serif), description (2-line clamp) or muted "No description" placeholder, footer: thread count + relative time since last activity. Clicking the card navigates to `/projects/:id`. |
| Card `⋯` menu | `Delete project` — same cascade as the detail page. |
| Empty state | First-time empty: full-page hero with a `New project` call-to-action. Empty-after-search: terse "No projects match …". |

### Project detail page (`/projects/:id`)
| Element | Behaviour |
|---|---|
| `← All projects` | Link back to the grid. |
| Title | Click to edit; Enter or blur commits via `renameProject`, Esc reverts. |
| Description | Click to edit (multi-line textarea); blur commits, Esc reverts, empty string clears. |
| `Delete project` | Top-right secondary button. Same confirm + cascade as the grid card. Navigates back to `/projects` on success. |
| Chat input | Prominent card `"How can I help you today?"`. On submit, mints a new thread UUID and navigates to `/c/:threadId` with route state `{ initialMessage, projectId }`. `ChatPage` forwards both to `ChatWindow`, which auto-submits the message on mount and tells chat-proxy to stamp the new thread with `project_id`. Enter submits, Shift+Enter inserts a newline. |
| Threads list | Shows all threads where `projectId === :id`, sorted by `lastMessageAt desc`. Each row is a regular `ThreadRow` with `hideProjectIndicator` (the folder badge is redundant inside the project's own page). |
| Instructions panel (aside) | Textarea bound to `chat_projects.instructions`. Save button is disabled until dirty; `Revert` appears alongside when dirty. Unsaved hint text beneath the buttons. Character cap 4000. |

### Invariants
- **Optimistic updates** — every mutation in `WorkspaceContext` updates local state first, then hits Supabase; failures roll back and surface a modal alert via `useModal()`.
- **Thread in a project AND in Recents** — a thread always appears in Recents, regardless of whether it's in a project. Projects are a secondary grouping, not a filter.
- **Cascade delete** — deleting a project wipes every thread inside it, including all of their messages.
- **First-message project stamping only** — `project_id` passed in a `chat-proxy` body is only honoured when the thread is brand new. Subsequent moves require an `UPDATE` on `chat_threads` directly (through the workspace API, which is what the sidebar's "Move to project" submenu and the project page's detail flows use).

---

## What this does NOT do (deferred)

- **Per-project uploaded knowledge / workspace-scoped documents.** Would require a separate AnythingLLM workspace per project, or AnythingLLM's attachment feature — out of scope.
- **Per-project memory / auto-extracted facts.** Claude-style "Memory" is significant on its own; not attempted.
- **Nested projects / sub-projects.** A thread belongs to at most one flat project. If needed, adding `chat_projects.parent_id` is straightforward.
- **Drag-and-drop thread → project** or drag-to-pin in the sidebar. All of these actions are available via the row `⋯` menu.
- **Multiple projects per thread / tagging beyond a single project.** Labels were removed; if cross-cutting tagging becomes needed again it would be reintroduced as its own join table.
