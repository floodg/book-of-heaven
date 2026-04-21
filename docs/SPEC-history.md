# Spec: Sidebar

## Files
- `frontend/src/components/Sidebar.tsx` — the sidebar shell
- `frontend/src/components/ThreadRow.tsx` — reusable row + `⋯` menu
- `frontend/src/lib/WorkspaceContext.tsx` — shared projects/threads data
- `frontend/src/lib/time.ts` — relative time + Recents bucketing

---

## Purpose
Permanent left rail that lets the user:

1. Start a fresh chat (`New chat`).
2. Jump to the `Projects` landing page.
3. See their pinned threads and recent threads, bucketed by age.
4. Rename / move / pin / unpin / delete a thread via a `⋯` action menu on each row.

The sidebar is not where projects are *managed* anymore — all project CRUD and per-project settings live on the `Projects` grid page and the per-project detail page. See `SPEC-projects.md`.

---

## Data source

The sidebar (and every page that cares about threads or projects) reads from a single React context:

```typescript
const workspace = useWorkspace()
// workspace.projects: Project[]
// workspace.threads:  Thread[]
// workspace.refresh(): Promise<void>
// workspace.{pinThread,unpinThread,deleteThread,moveThreadToProject,…}
```

`WorkspaceProvider` sits inside `ProtectedLayout`, so there is exactly one copy of the projects/threads state across the whole authenticated app. Mutations update local state optimistically and also write to Supabase; a full `refresh()` is used after the chat-proxy responds so the new thread + LLM-generated title show up without the sidebar falling out of sync.

On mount (and when `refresh()` is called) the provider issues three parallel queries:

```typescript
const [messagesRes, threadsRes, projectsRes] = await Promise.all([
  supabase.from('chat_messages')
    .select('thread_id, role, content, created_at')
    .eq('user_id', user.id),
  supabase.from('chat_threads')
    .select('thread_id, title, project_id, pinned_at, created_at, updated_at')
    .eq('user_id', user.id),
  supabase.from('chat_projects')
    .select('id, name, description, instructions, created_at, updated_at')
    .eq('user_id', user.id),
])
```

`assembleThreads()` then walks the message rows once to compute per-thread {firstMessage, firstMessageAt, lastMessageAt}, merges in the `chat_threads` row (title, project_id, pinned_at), and returns a single `Thread[]` sorted by `lastMessageAt` desc.

---

## Thread fallback titles

When `chat_threads.title` is still null (brand-new thread waiting on title generation, or a thread the edge function never got a chance to title), the sidebar falls back to a client-side heuristic on the first user message (`humanizeFirstMessage`): trims whitespace, strips common conversational lead-ins (`hi`, `hello`, `please`, …), capitalizes the first letter, and hard-caps to 44 chars with an ellipsis. Every row renders through the same `labelForThread(thread)` helper so the fallback is consistent across the sidebar, Pinned section, and the project detail page's thread list.

---

## Layout

```
┌────────────────────────────┐
│  + New chat                │
│  📁 Projects               │
│                            │
│  PINNED                    │
│  · Pinned thread A     📌  │
│  · Pinned thread B     📌  │
│                            │
│  RECENTS                   │
│  Today                     │
│  · Thread 1            📁  │
│  · Thread 2                │
│  Yesterday                 │
│  · Thread 3                │
│  Previous 7 days           │
│  · Thread 4                │
│  March                     │
│  · …                       │
│                            │
│  user@email      [Log out] │
└────────────────────────────┘
```

The Pinned section is hidden entirely when no threads are pinned.

Recents buckets in order: `Today`, `Yesterday`, `Previous 7 days`, `Previous 30 days`, then a month label (with year when different from current year) for older items. A thread inside a project still appears in Recents — Projects are not a filter, they are just an extra grouping.

---

## Row actions (`⋯` menu on each thread)

Single popover with three sections:

1. **Pin / Unpin** — writes `chat_threads.pinned_at` (now / null). Pinned threads float to the Pinned section, sorted by most recently pinned.
2. **Move to project…** → submenu listing all projects plus (if the thread is currently in one) a "Remove from project" shortcut at the top.
3. **Delete** — confirm modal, then wipes `chat_messages` + `chat_threads` for that thread. If the user was looking at the deleted thread, the row navigates them back to `/`.

Every mutation runs optimistically; the provider rolls back local state if the Supabase write fails and surfaces an alert via `useModal()`.

---

## Styling

- Width: 260px, fixed.
- Background: `#2a1408` (deep brown), text `#f5e9d8`.
- Active route: `rgba(255,255,255,0.12)` tint (sidebar links use `<NavLink>`).
- Hover: `rgba(255,255,255,0.06)` tint.
- Section headers ("PINNED", "RECENTS"): `11px`, uppercase, letter-spaced, low-alpha cream.
- Bucket headers ("Today", "Yesterday", etc.): `11px`, lower-alpha.
- Row `⋯` button: `opacity: 0` by default, fades in on row hover or when its menu is open.
- Footer: user email (ellipsized) + `Log out` button. Replaces the old top-of-page header.

---

## Loading + empty states

- Loading: `"Loading…"` placeholder. Parallel queries typically resolve in under 100ms on local Supabase so a skeleton isn't worth it.
- No conversations yet: inline empty text inside Recents, prompting the user to click **New chat**.
- No pinned threads: the section renders nothing (no "no pinned threads" placeholder — keeps the chrome quiet).

---

## Refresh behaviour

Every mutation that originates in the sidebar updates the provider's state directly, so no explicit refresh is needed. The only automatic refresh happens after a chat-proxy response: `ChatPage` calls `workspace.refresh()` so the new thread row + its freshly-generated title appear in Recents without a full page reload.
