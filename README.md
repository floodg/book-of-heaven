# Book of Heaven Research Platform

> *"If you only knew what it means to live in my will — there's no division between the soul and heaven."*
> — Volume 17, Number 13

A public, multi-user web platform for searching and exploring all 612 transcripts of the **Book of Heaven** by Luisa Piccarreta, powered by AI semantic search and cited answers with volume/number references.

---

## What It Does

Anyone can create an account and ask natural language questions across the entire Book of Heaven corpus. The AI retrieves the most relevant passages and responds with structured answers and source citations like `[Book of Heaven Volume 4 – Number 4]`.

Each user has their own private conversation history. All users share the same underlying document embeddings.

---

## Architecture

```
Users (browser)
      ↕  HTTPS
React + Vite frontend         ← Vercel (free)
      ↕  Supabase Auth JWT
Supabase Edge Function        ← secure proxy, never exposes API keys
      ↕  API key (secret)
AnythingLLM (VPS)             ← 612 embedded transcripts, shared
      ↕  pay-per-use
Anthropic Claude API          ← claude-haiku-4-5
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| Auth | Supabase Auth (email + Google OAuth) |
| Database | Supabase PostgreSQL with Row Level Security |
| API Proxy | Supabase Edge Functions (Deno) |
| Document AI | AnythingLLM (self-hosted) |
| LLM | Claude Haiku via Anthropic API |
| Frontend hosting | Vercel (free tier) |
| VPS | Hetzner Cloud CX22 (~$6/month) |

---

## Project Structure

```
book-of-heaven/
├── README.md
├── frontend/                        # React + Vite app (react-router)
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuthPage.tsx
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── CitationBadge.tsx
│   │   │   ├── Icons.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Sidebar.tsx          # permanent left rail
│   │   │   └── ThreadRow.tsx        # row + ⋯ action menu
│   │   ├── routes/
│   │   │   ├── ProtectedLayout.tsx  # WorkspaceProvider + Sidebar + <Outlet />
│   │   │   ├── ChatPage.tsx         # /, /c/:threadId
│   │   │   ├── ProjectsPage.tsx     # /projects
│   │   │   └── ProjectDetailPage.tsx # /projects/:id
│   │   ├── lib/
│   │   │   ├── supabase.ts
│   │   │   ├── WorkspaceContext.tsx # shared projects + threads state
│   │   │   ├── ids.ts
│   │   │   └── time.ts
│   │   ├── App.tsx                  # auth gate + BrowserRouter
│   │   └── main.tsx
│   ├── .env.example
│   └── package.json
├── supabase/
│   ├── migrations/
│   │   ├── 001_chat_messages.sql
│   │   ├── 002_thread_id.sql
│   │   ├── 003_chat_threads.sql
│   │   ├── 004_chat_organization.sql
│   │   └── 005_projects_redesign.sql
│   └── functions/
│       └── chat-proxy/
│           └── index.ts
└── docs/
    ├── SPEC.md
    ├── SPEC-edge-function.md
    ├── SPEC-history.md              # sidebar + thread rows
    ├── SPEC-projects.md             # projects grid + detail + instructions
    ├── vps-setup.md
    ├── anythingllm-config.md
    └── deployment.md
```

---

## Build Phases

### Phase 1 — VPS & AnythingLLM (~2 hours)

Deploy AnythingLLM to a cloud server and migrate your embedded transcripts.

- [ ] Rent Hetzner CX22 (2 vCPU, 4GB RAM, Ubuntu 22.04)
- [ ] Install Docker on VPS
- [ ] Deploy AnythingLLM container
- [ ] Configure Nginx reverse proxy + HTTPS (Let's Encrypt)
- [ ] Export local AnythingLLM workspace (all 612 embeddings)
- [ ] Import workspace to VPS instance
- [ ] Generate production API key
- [ ] Test API endpoint

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Run AnythingLLM
docker run -d \
  -p 3001:3001 \
  -v anythingllm_storage:/app/server/storage \
  --name anythingllm \
  mintplexlabs/anythingllm

# Test
curl http://localhost:3001/api/v1/auth \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

### Phase 2 — Supabase Setup (~1 hour)

Create the database schema and configure authentication.

- [ ] Create new Supabase project (`book-of-heaven`)
- [ ] Enable Email auth provider
- [ ] Enable Google OAuth provider
- [ ] Run `001_chat_messages.sql` migration
- [ ] Add `ANYTHINGLLM_URL` secret to Edge Functions
- [ ] Add `ANYTHINGLLM_KEY` secret to Edge Functions

```sql
-- supabase/migrations/001_chat_messages.sql
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
```

### Phase 3 — Edge Function Proxy (~1 hour)

Secure proxy that validates user identity before forwarding to AnythingLLM.

- [ ] Install Supabase CLI
- [ ] Scaffold `chat-proxy` function
- [ ] Implement JWT validation + AnythingLLM forwarding
- [ ] Save messages to `chat_messages` table
- [ ] Deploy and test

```bash
npm install -g supabase
supabase functions new chat-proxy
supabase functions deploy chat-proxy
```

The Edge Function:
1. Validates the user's Supabase JWT
2. Forwards the message to AnythingLLM `/api/v1/workspace/{slug}/chat`
3. Saves user message + AI response to `chat_messages`
4. Returns the AI response to the frontend

### Phase 4 — React Frontend (~3 hours)

- [ ] Scaffold Vite + React + TypeScript project
- [ ] Install and configure Tailwind CSS
- [ ] Install `@supabase/supabase-js` and `@supabase/auth-ui-react`
- [ ] Build `AuthPage` — sign up / sign in with Supabase Auth UI
- [ ] Build `ChatWindow` — message input, scrollable thread, loading states
- [ ] Build `Sidebar` + `ThreadRow` — pinned + recents, per-row ⋯ menu
- [ ] Build `ProjectsPage` / `ProjectDetailPage` — grid + per-project instructions
- [ ] Build `CitationBadge` — renders `[Volume X – Number Y]` as styled badges
- [ ] Configure `.env` with Supabase URL + anon key
- [ ] Deploy to Vercel

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install @supabase/supabase-js @supabase/auth-ui-react
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

---

## Environment Variables

### Frontend (`frontend/.env`)

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### Supabase Edge Function secrets

```bash
supabase secrets set ANYTHINGLLM_URL=https://your-vps-ip:3001
supabase secrets set ANYTHINGLLM_KEY=your-anythingllm-api-key
supabase secrets set ANYTHINGLLM_WORKSPACE=book-of-heaven
```

---

## AnythingLLM Workspace Configuration

The workspace system prompt and chat/retrieval settings are versioned in `anythingllm/workspaces/` so local dev and the production VPS stay in sync. See [`anythingllm/README.md`](anythingllm/README.md) for the full workflow. TL;DR:

```bash
# Apply the committed config to your local AnythingLLM
ANYTHINGLLM_URL=http://localhost:3001 \
ANYTHINGLLM_KEY=your-local-key \
node anythingllm/apply-workspace.mjs \
  --config anythingllm/workspaces/book-of-heaven.config.json

# Same command, pointed at the VPS, keeps production in lockstep
ANYTHINGLLM_URL=https://your-vps-host:3001 \
ANYTHINGLLM_KEY=your-production-key \
node anythingllm/apply-workspace.mjs \
  --config anythingllm/workspaces/book-of-heaven.config.json
```

Edit the prompt in [`anythingllm/workspaces/book-of-heaven.prompt.md`](anythingllm/workspaces/book-of-heaven.prompt.md) — never directly in the AnythingLLM UI — then re-run the apply command to push the change.

---

## Estimated Costs

| Service | Cost | Notes |
|---|---|---|
| Hetzner CX22 VPS | ~$6/month | AnythingLLM host |
| Supabase | Free tier | Up to 50,000 MAU |
| Vercel | Free tier | Frontend hosting |
| Anthropic API | ~$0.001/query | Claude Haiku |
| Domain (optional) | ~$15/year | e.g. bookofheavensearch.com |
| **Total** | **~$7–10/month** | |

---

## Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/book-of-heaven.git
cd book-of-heaven

# Frontend
cd frontend
cp .env.example .env    # add your Supabase keys
npm install
npm run dev

# Supabase (local)
supabase start
supabase db reset       # runs migrations
supabase functions serve chat-proxy
```

---

## Roadmap

- [x] AnythingLLM local setup with 612 embedded transcripts
- [x] Claude API integration with citation system prompt
- [ ] Phase 1 — VPS deployment
- [ ] Phase 2 — Supabase schema + auth
- [ ] Phase 3 — Edge Function proxy
- [ ] Phase 4 — React frontend
- [ ] Custom domain + HTTPS
- [ ] Topic quick-buttons (Divine Will, Luisa's mission, Kingdom, etc.)
- [ ] Saved/bookmarked passages per user
- [ ] Volume browser — browse by volume and number
- [ ] Email notifications for new content

---

## Contributing

This is a personal project for the study of the Book of Heaven. If you'd like to contribute, please open an issue first to discuss.

---

## License

MIT