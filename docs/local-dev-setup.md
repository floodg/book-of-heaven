# Local Development Setup (Windows)

This guide sets up the full Book of Heaven platform on your local machine so you can develop and test before deploying to production.

## Prerequisites

You already have these installed:
- **Node.js** — confirm version: `node -v` (need v18+)
- **Docker Desktop** — must be running before starting Supabase
- **Supabase CLI** — confirm version: `supabase -v`
- **Git**

---

## Overview

Locally you will run:

| Service | How | URL |
|---|---|---|
| React frontend | Vite dev server | `http://localhost:5173` |
| Supabase (auth + DB) | Docker via Supabase CLI | `http://localhost:54321` |
| Edge Function proxy | Supabase CLI functions serve | `http://127.0.0.1:54331/functions/v1/chat-proxy` (see `supabase/config.toml` for ports) |
| Chunk index | Postgres `document_chunks` + pgvector | Populate via `index_supabase.py` in the txt/vtt splitter repos |

Set `OPENAI_API_KEY` in `supabase/functions/.env` and run the ingestion scripts so `document_chunks` has rows before expecting non-empty search results.

---

## Step 1 — Clone the Repo

```bash
git clone https://github.com/YOUR_USERNAME/book-of-heaven.git
cd book-of-heaven
```

---

## Step 2 — OpenAI key + chunk ingestion

1. Add `OPENAI_API_KEY=...` to `supabase/functions/.env` (same key the ingestion scripts use).
2. From **`book-of-heaven-txt-splitter`**, with `SUPABASE_URL` + `SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) exported:
   ```powershell
   python index_supabase.py --limit 50
   ```
3. From **`book-of-heaven-vtt-splitter`**, same env vars:
   ```powershell
   python index_supabase.py --output-dir output --limit 50
   ```
   Use `--dry-run` first to sanity-check paths.

AnythingLLM is **optional** for this stack; see `anythingllm/README.md` if you still run it for side experiments.

---

## Step 3 — Scaffold the Project Structure

From the repo root, create the frontend and supabase folders:

```bash
# Create frontend with Vite
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
npm install @supabase/supabase-js @supabase/auth-ui-react @supabase/auth-ui-shared
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
cd ..
```

Your folder structure should now look like:

```
book-of-heaven/
├── README.md
├── docs/
│   └── local-dev-setup.md     ← this file
├── frontend/
│   ├── src/
│   ├── .env.example
│   └── package.json
└── supabase/                  ← created in Step 4
```

---

## Step 4 — Supabase Local Stack

```bash
# From repo root
supabase init
supabase start
```

`supabase start` pulls and boots several Docker containers (Postgres, Auth, Storage, etc). First run takes a few minutes. When it finishes you'll see output like:

```
API URL:      http://localhost:54321
DB URL:       postgresql://postgres:postgres@localhost:54322/postgres
Studio URL:   http://localhost:54323
Anon key:     eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Service key:  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Copy the Anon key** — you'll need it for the frontend `.env`.

### Run the database migration

Create the migrations file:

```bash
# From repo root
mkdir -p supabase/migrations
```

Create `supabase/migrations/001_chat_messages.sql` with this content:

```sql
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

Then create `supabase/migrations/002_thread_id.sql` to add the real thread column (see `SPEC.md` → "Database Schema" for the full file). The short version:

```sql
alter table chat_messages add column thread_id uuid;
-- backfill existing rows so (user_id, day) share a uuid, then:
alter table chat_messages alter column thread_id set not null;
create index on chat_messages (user_id, thread_id, created_at);
```

Apply both migrations:

```bash
supabase db reset
```

Confirm in Supabase Studio at `http://localhost:54333` — you should see the `chat_messages` table with a `thread_id` column under Table Editor.

---

## Step 5 — Edge Function (Chat Proxy)

```bash
# From repo root
supabase functions new chat-proxy
```

This creates `supabase/functions/chat-proxy/index.ts`. Replace its contents with:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANYTHINGLLM_URL = Deno.env.get('ANYTHINGLLM_URL')!
const ANYTHINGLLM_KEY = Deno.env.get('ANYTHINGLLM_KEY')!
const ANYTHINGLLM_WORKSPACE = Deno.env.get('ANYTHINGLLM_WORKSPACE')!

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      }
    })
  }

  try {
    // Validate user JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response('Unauthorized', { status: 401 })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response('Unauthorized', { status: 401 })

    // Get the user's message
    const { message } = await req.json()
    if (!message) return new Response('Bad Request', { status: 400 })

    // Save user message to DB
    await supabase.from('chat_messages').insert({
      user_id: user.id,
      role: 'user',
      content: message
    })

    // Forward to AnythingLLM
    const llmResponse = await fetch(
      `${ANYTHINGLLM_URL}/api/v1/workspace/${ANYTHINGLLM_WORKSPACE}/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ANYTHINGLLM_KEY}`
        },
        body: JSON.stringify({ message, mode: 'query' })
      }
    )

    const llmData = await llmResponse.json()
    const reply = llmData.textResponse || 'No response from AI.'

    // Save assistant response to DB
    await supabase.from('chat_messages').insert({
      user_id: user.id,
      role: 'assistant',
      content: reply
    })

    return new Response(JSON.stringify({ reply }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    })

  } catch (err) {
    console.error(err)
    return new Response('Internal Server Error', { status: 500 })
  }
})
```

### Create local secrets file

Create `supabase/functions/.env` (this file should be in `.gitignore`):

```env
ANYTHINGLLM_URL=http://host.docker.internal:3001
ANYTHINGLLM_KEY=your-anythingllm-api-key-here
ANYTHINGLLM_WORKSPACE=book-of-heaven-narrated
SUPABASE_URL=http://host.docker.internal:54331
SERVICE_ROLE_KEY=sb_secret_...                 # from `supabase status`
```

> **Note 1:** Use `host.docker.internal` instead of `localhost` — this lets the Edge Function container reach AnythingLLM running on your Windows host machine.
>
> **Note 2:** The service role key is stored as `SERVICE_ROLE_KEY`, not `SUPABASE_SERVICE_ROLE_KEY`. The edge runtime reserves the `SUPABASE_` prefix for its own injected variables and silently drops any custom env var starting with it. If you see `Env name cannot start with SUPABASE_, skipping: ...` in the `functions serve` terminal, rename the key.

### Serve the function locally

```bash
supabase functions serve chat-proxy --env-file ./supabase/functions/.env
```

---

## Step 6 — Frontend Environment

```bash
cd frontend
cp .env.example .env
```

If `.env.example` doesn't exist yet, create `frontend/.env`:

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=paste-your-local-anon-key-here
```

The anon key comes from the `supabase start` output in Step 4.

Also create `frontend/.env.example` (safe to commit):

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

---

## Step 7 — Start the Frontend

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173` — you should see the Vite default page for now. The app components come in Phase 4.

---

## Running Everything Together

Once set up, your daily dev workflow is:

### Terminal 1 — Supabase
```bash
supabase start
```

### Terminal 2 — Edge Function
```bash
supabase functions serve chat-proxy --env-file ./supabase/functions/.env
```

### Terminal 3 — Frontend
```bash
cd frontend
npm run dev
```

### Terminal 4 — AnythingLLM (if using Docker)
```bash
docker start anythingllm
```

Or just open the AnythingLLM desktop app.

---

## Verify Everything Works

Test the Edge Function directly with PowerShell:

```powershell
# First get a user token (after creating a test account at http://localhost:5173)
$response = Invoke-RestMethod -Uri "http://localhost:54321/functions/v1/chat-proxy" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer YOUR_USER_JWT"; "Content-Type" = "application/json" } `
  -Body '{"message": "What does Jesus say about the Divine Will?"}'

$response.reply
```

Or with curl in Git Bash:

```bash
curl -X POST http://localhost:54321/functions/v1/chat-proxy \
  -H "Authorization: Bearer YOUR_USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"message": "What does Jesus say about the Divine Will?"}'
```

---

## Useful Local URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Supabase Studio (DB viewer) | http://localhost:54323 |
| Supabase API | http://localhost:54321 |
| AnythingLLM | http://localhost:3001 |
| Edge Function | http://localhost:54321/functions/v1/chat-proxy |

---

## Stopping Everything

```bash
# Stop Supabase (preserves data)
supabase stop

# Stop AnythingLLM (if Docker)
docker stop anythingllm
```

---

## Troubleshooting

**`supabase start` fails**
Make sure Docker Desktop is running before running `supabase start`. Check Docker Desktop system tray icon.

**Edge Function can't reach AnythingLLM**
Use `host.docker.internal:3001` not `localhost:3001` in your secrets file. The function runs inside Docker and needs to reach your Windows host.

**`supabase` command not found**
Re-open your terminal after installing the CLI, or run:
```bash
npm install -g supabase
```

**Port 3001 already in use**
Another process is using the port. Find and stop it:
```powershell
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

**CORS errors in browser**
Make sure the Edge Function's `OPTIONS` handler is returning the correct headers. Check the `supabase functions serve` terminal for errors.

**502 "An invalid response was received from the upstream server" on `/auth/v1/*` (or any `/rest/v1/*`, `/functions/v1/*`)**

This is a Kong DNS-caching issue and does *not* mean the upstream container is broken.

When you run `supabase db reset`, or any other command that restarts an upstream container (auth / rest / realtime / storage / functions), that container can come back up on a different Docker IP. Kong's nginx caches the IP it resolved at startup and keeps trying the stale address, so every request fails with `connect() failed (111: Connection refused)` and returns a 502.

Diagnose:
```powershell
# Are the upstream containers healthy on their own?
docker ps --format "table {{.Names}}\t{{.Status}}"

# What IP does the auth container currently have?
docker inspect supabase_auth_book-of-heaven `
  --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"

# What IP is Kong actually trying to reach?
docker logs supabase_kong_book-of-heaven --tail 20
# Look for lines like:
#   connect() failed (111: Connection refused) ... upstream: "http://172.19.0.6:9999/..."
# If that IP differs from the one docker inspect reports, it's the cache issue.
```

Fix — restart Kong so it re-resolves DNS:
```powershell
docker restart supabase_kong_book-of-heaven
```

Or nuclear option:
```powershell
supabase stop
supabase start
```

After the restart, `Invoke-WebRequest http://127.0.0.1:54331/auth/v1/health` (with the `apikey` header) should return the GoTrue version JSON instead of a 502.

---

## .gitignore additions

Make sure these are in your root `.gitignore`:

```
# Local env files
frontend/.env
supabase/functions/.env
.env.local

# Supabase local data
supabase/.branches
supabase/.temp
```
