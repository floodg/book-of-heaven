# Book of Heaven — Project Spec

## What We're Building

A public multi-user web platform for searching and exploring all 612 transcripts of the Book of Heaven by Luisa Piccarreta. Users sign up, ask natural language questions, and receive AI-generated answers with cited volume/number references. Each user has private conversation history. All users share the same underlying document embeddings.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Vite + TypeScript | Already scaffolded in `/frontend` |
| Styling | Tailwind CSS v3 | Already installed |
| Auth | Supabase Auth + Auth UI React | Email + Google OAuth |
| Database | Supabase PostgreSQL | Local on port 54331 |
| API Proxy | Supabase Edge Function (Deno) | `/supabase/functions/chat-proxy` |
| Document AI | AnythingLLM desktop app | Running on port 3001 |
| LLM | Anthropic Claude Haiku via AnythingLLM | Configured in AnythingLLM |

---

## Local Environment

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Supabase API | http://127.0.0.1:54331 |
| Supabase Studio | http://127.0.0.1:54333 |
| Edge Functions | http://127.0.0.1:54331/functions/v1 |
| AnythingLLM | http://localhost:3001 |

### Environment files

`frontend/.env`:
```
VITE_SUPABASE_URL=http://127.0.0.1:54331
VITE_SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
```

`supabase/functions/.env`:
```
ANYTHINGLLM_URL=http://host.docker.internal:3001
ANYTHINGLLM_KEY=<your-key>
ANYTHINGLLM_WORKSPACE=book-of-heaven
SUPABASE_URL=http://host.docker.internal:54331
SERVICE_ROLE_KEY=sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz
```

> The edge runtime refuses to load any custom env var whose name starts with `SUPABASE_`, so the service role key is stored as `SERVICE_ROLE_KEY` (not `SUPABASE_SERVICE_ROLE_KEY`). See `SPEC-edge-function.md`.

---

## Project Structure

```
book-of-heaven/
├── docs/
│   ├── SPEC.md                          ← this file
│   ├── SPEC-edge-function.md
│   ├── SPEC-auth.md
│   ├── SPEC-chat-ui.md
│   ├── SPEC-history.md
│   └── local-dev-setup.md
├── frontend/
│   ├── src/
│   │   ├── lib/
│   │   │   └── supabase.ts              ← Supabase client singleton
│   │   ├── components/
│   │   │   ├── AuthPage.tsx
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── HistorySidebar.tsx
│   │   │   └── CitationBadge.tsx
│   │   ├── App.tsx                      ← route between auth/chat
│   │   ├── main.tsx
│   │   └── index.css                    ← Tailwind directives
│   ├── .env
│   ├── .env.example
│   ├── index.html
│   ├── tailwind.config.js
│   └── vite.config.ts
├── supabase/
│   ├── config.toml                      ← ports shifted to 5433x range
│   ├── migrations/
│   │   ├── 001_chat_messages.sql        ← initial table + RLS
│   │   └── 002_thread_id.sql            ← adds thread_id uuid column
│   └── functions/
│       └── chat-proxy/
│           └── index.ts
├── .gitignore
└── README.md
```

---

## Database Schema

Applied via `supabase db reset` (which runs `001_chat_messages.sql` and `002_thread_id.sql` in order):

```sql
-- 001_chat_messages.sql
create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz default now()
);

alter table chat_messages enable row level security;

create policy "Users see own messages"
  on chat_messages for all
  using (auth.uid() = user_id);

create index on chat_messages (user_id, created_at desc);

-- 002_thread_id.sql
alter table chat_messages add column thread_id uuid;
-- (backfill existing rows: one shared uuid per (user_id, day)
--  so pre-migration history still groups as one thread per day)
alter table chat_messages alter column thread_id set not null;
create index on chat_messages (user_id, thread_id, created_at);
```

### Thread model
A **thread** is a set of messages sharing the same `thread_id`. UUIDs are minted by the frontend the first time a user sends a message in a fresh chat and reused for every subsequent message in that conversation. Clicking **New Chat** mints a brand-new `thread_id` so same-day conversations stay visually and logically separate. See `SPEC-history.md` and `SPEC-chat-ui.md` for how the client and sidebar consume this column.

---

## Data Flow

```
User types message
      ↓
ChatWindow.tsx — mints thread_id if new chat, POSTs { message, thread_id } with user JWT
      ↓
chat-proxy/index.ts — validates JWT, validates thread_id is a UUID
      ↓
Edge Function — inserts user row (with thread_id) into chat_messages
      ↓
Edge Function — forwards message to AnythingLLM /stream-chat, aggregates SSE
      ↓
AnythingLLM — searches 612 embedded transcripts, calls Claude, streams back
      ↓
Edge Function — inserts assistant row (same thread_id) into chat_messages
      ↓
Edge Function — returns { reply, thread_id } (non-streaming public contract)
      ↓
ChatWindow.tsx — renders reply as markdown with CitationBadge highlights
      ↓
App.tsx — bumps history refreshToken; HistorySidebar re-queries and shows the new/updated thread
```

---

## Key Design Decisions

- **Edge Function as proxy** — the AnythingLLM API key never reaches the browser
- **Per-user RLS** — Supabase Row Level Security ensures users only see their own messages
- **Shared embeddings** — all users query the same AnythingLLM workspace; no per-user indexing needed
- **Threads are UUIDs, not days** — every "New Chat" click mints a fresh `thread_id`, so same-day conversations stay separate. The v1 approach of grouping by calendar day proved confusing once users had more than one conversation in the same day.
- **Client mints `thread_id`** — keeps the edge function stateless with respect to thread lifecycle; the server just writes whatever UUID the client supplies. RLS still prevents cross-user reads/writes because every row is keyed by `user_id = auth.uid()`.
- **Citation highlighting** — responses contain `[Book of Heaven Volume X - Number Y]` and related patterns that are rendered as styled amber pills inline with the surrounding markdown.
- **Markdown rendering for assistant messages** — AnythingLLM returns markdown (headings, bold, lists, blockquotes); we render it with `react-markdown` rather than as plain text.
- **Streaming is internal, not public** — the chat-proxy consumes AnythingLLM's SSE `/stream-chat` endpoint (the non-streaming `/chat` endpoint returns empty replies for our workspace config), but aggregates server-side and returns a single JSON body so the client contract stays simple.

---

## UI Layout

```
┌─────────────────────────────────────────────────┐
│  📖 Book of Heaven          [user@email] [logout]│
├──────────────────┬──────────────────────────────┤
│                  │                              │
│  History         │   Chat Window                │
│  Sidebar         │                              │
│                  │   [previous messages]        │
│  • Soul who...   │                              │
│  • Luisa says... │   [user bubble]              │
│  • Key Reqs...   │   [assistant bubble          │
│                  │    with citation badges]     │
│  + New Chat      │                              │
│                  │   [message input bar]        │
└──────────────────┴──────────────────────────────┘
```

---

## Aesthetic Direction

- **Warm, reverent, minimal** — this is a spiritual research tool
- Color palette: warm off-whites, deep brown/sepia tones, gold accents
- Typography: serif display font for headings (e.g. Lora, Playfair Display), clean sans for UI
- Citation badges: small pill-shaped tags in warm gold/amber
- No dark mode required for v1
- Mobile-responsive

---

## Running Locally (daily workflow)

Open 3 terminals in VS Code:

**Terminal 1:**
```powershell
cd C:\Code\book-of-heaven
supabase start
```

**Terminal 2:**
```powershell
cd C:\Code\book-of-heaven
supabase functions serve chat-proxy --env-file ./supabase/functions/.env
```

**Terminal 3:**
```powershell
cd C:\Code\book-of-heaven\frontend
npm run dev
```

Also open AnythingLLM desktop app.
