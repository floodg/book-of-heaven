# Spec: Edge Functions — chat-proxy & semantic-search

## Files
- `supabase/functions/chat-proxy/index.ts` — main chat turn + persistence (pgvector semantic search)
- `supabase/functions/_shared/pgvector_search.ts` — OpenAI embeddings + `search_document_chunks` RPC
- `supabase/functions/_shared/format_hits.ts` — markdown reply + `sources` jsonb from ranked hits
- `supabase/functions/semantic-search/index.ts` — optional direct POST for search-only clients
- `supabase/functions/chat-job-events/index.ts` — server-sent job status / final JSON for a `chat_turn_jobs` row

## Purpose (chat-proxy)
Secure proxy between the React frontend and the database-backed search pipeline. Validates the user's Supabase JWT, inserts the user message, creates a `chat_turn_jobs` row, and runs **embedding + pgvector retrieval + markdown formatting** in a background task via `EdgeRuntime.waitUntil` so the HTTP response can return immediately (`202` + `job_id`). The normal completion payload (thread id, turn id, title, and `replies` array) is stored on the job when finished and is also the shape returned for an idempotent `200` when the same `turn_id` is replayed. When the run fails, the job row is set to `error` and a single assistant error bubble may be inserted. The client can poll completion either through Supabase Realtime on `chat_messages` / `chat_turn_jobs` or by opening a GET **chat-job-events** stream (see below).

## Purpose (semantic-search)
Lightweight POST endpoint with the same JWT validation: body `{ "query": "…", "source": "text"|"narrated"|"both", "match_count"?: number, "filter_volume"?: number }` returns `{ "replies": [ { "source", "reply", "sources" } ] }` without writing `chat_messages` or jobs. Useful for tooling and experiments; the main app uses **chat-proxy** so turns stay in history.

## Environment Variables
Available via `Deno.env.get()`:
```
OPENAI_API_KEY         required for embeddings (same model/dim as migration: text-embedding-3-small, 1536)
SUPABASE_URL           Supabase Kong URL, e.g. http://host.docker.internal:54331
SERVICE_ROLE_KEY       sb_secret_... key from `supabase status`
```

> **Note:** the env var is `SERVICE_ROLE_KEY`, **not** `SUPABASE_SERVICE_ROLE_KEY`. The edge runtime blocks any custom env name starting with `SUPABASE_` (it reserves that prefix for its own injected variables) and silently drops them at startup. Similarly `SUPABASE_URL` in `supabase/functions/.env` is effectively user-supplied only because we need a value when running `supabase functions serve` outside the managed runtime.

## Request

**Method:** POST
**Headers:**
```
Authorization: Bearer <supabase_user_jwt>
Content-Type: application/json
```
**Body:**
```json
{
  "message": "What does Jesus say about the soul living in the Divine Will?",
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10",
  "turn_id": "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2",
  "source": "text",
  "project_id": "b12c4a0f-33a1-4d48-9b2f-71aa4a9d6ef1"
}
```

- `message` — required, non-empty string
- `thread_id` — required, lowercase RFC 4122 UUID. Minted by the frontend on the first message of a fresh chat and reused for every subsequent message in that conversation (see `SPEC-chat-ui.md`).
- `turn_id` — required UUID per user message. Uniquely identifies one user+assistant exchange; used for idempotent jobs and for pairing user/assistant rows.
- `source` — required: `text`, `narrated`, or `both` (which `document_chunks.source_type` rows to search).
- `project_id` — optional, UUID. Only honoured on the **first** insert of a thread: the upserted `chat_threads` row is stamped with this project. Subsequent requests for the same thread ignore it (upsert uses `ignoreDuplicates: true`), so the client can't sneak a thread into a different project by replaying messages. See `SPEC-projects.md`.

## Response (chat-proxy)

**Accepted 202 (normal path for a new turn):** the handler inserted the user row, created a `chat_turn_jobs` row, and enqueued the LLM work. The client should connect to `chat-job-events` or listen with Realtime for completion.
```json
{
  "job_id": "…uuid…",
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10",
  "turn_id": "…uuid…",
  "title": null,
  "status": "accepted"
}
```

**Success 200 (idempotent replay of the same `turn_id` when the job is already `complete` on the server):** same body shape as a finished job, including the `replies` array and optional `job_id` echo.

**Job finished payload (also stored in `chat_turn_jobs.result` and streamed by chat-job-events on `event: "complete"`):**
```json
{
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10",
  "turn_id": "…uuid…",
  "title": "Divine Will and the soul",
  "replies": [
    {
      "source": "text",
      "reply": "Based on the Book of Heaven…",
      "sources": [ { "title": "Volume_17.pdf", "score": 0.82 } ]
    }
  ]
}
```

- For `source: "both"` the server inserts two assistant messages and returns two entries in `replies` (one with `source: "text"`, one with `source: "narrated"`), each with its own `sources` list.
- `title` is the newly generated thread title when this turn satisfied title generation; otherwise `null`. The UI still refreshes `chat_threads` on completion.

**Conflict 409** — a prior request with the same `turn_id` already failed; the same message must not be retried with that id:
```json
{ "error": "…", "job_id": "…" }
```

**Error responses** — all JSON with a single `error` field so the frontend can surface a meaningful message, except where 409 (above) includes `job_id`.
- `400` — missing/empty `message`, missing/invalid `thread_id` / `turn_id` (not a UUID), missing/invalid `source`, or malformed JSON body
- `401` — missing `Authorization` header or invalid/expired JWT (frontend treats this as "session dead" and signs the user out)
- `500` — OpenAI/DB failure, insert failure, or any uncaught exception in the request handler

```json
{ "error": "Missing or invalid thread_id (expected UUID)" }
```

## chat-job-events (GET SSE)

`supabase/functions/chat-job-events/index.ts` — for browsers that use `EventSource` (no custom headers), auth is passed as `access_token` (Supabase JWT) in the query string.

**Request:** `GET /functions/v1/chat-job-events?job_id=<uuid>&access_token=<jwt>`

**Response:** `text/event-stream`. Each `data:` line is a JSON object, for example:
- `{ "event": "status", "status": "pending" | "processing" }` — the server polls the job row every 500ms
- `{ "event": "complete", "payload": { …same as job `result` / 200 body… } }`
- `{ "event": "error", "error": "…" }` — job failed or the stream errored
- `{ "event": "timeout", "error": "…" }` — after 10 minutes of polling; the client can rely on Realtime

## Logic — request handler and background task

The numbered flow below is implemented in the background function `runChatTurn`, scheduled with `EdgeRuntime.waitUntil` after the handler returns `202`. The request handler first validates the JWT, checks idempotency on `chat_turn_jobs` and `chat_messages` (unique user row per `turn_id`), inserts the user message, upserts `chat_threads`, inserts a `chat_turn_jobs` row, then returns `202` and starts the background task. **Outdated: the following step numbers describe the in-order work inside the background task and no longer run before the HTTP response is sent.**

1. Handle CORS preflight (`OPTIONS` request) — return 200 with permissive headers
2. Extract `Authorization` header — return 401 if missing
3. Create a service-role Supabase client using `SUPABASE_URL` + `SERVICE_ROLE_KEY`
4. Call `supabase.auth.getUser(token)` to validate the JWT and get `user.id` — return 401 if invalid
5. Parse request body, extract `message`, `thread_id`, `turn_id`, `source`, `project_id` (as implemented in code; see `chat-proxy/index.ts`):
   - Return 400 if `message` is missing/empty
   - Return 400 if `thread_id` is missing or doesn't match the UUID regex
   - If `project_id` is provided, return 400 if it doesn't match the UUID regex. Null/absent means "no project stamp".
6. Insert the user message into `chat_messages`:
   ```json
   {
     "user_id": "<user.id>",
     "role": "user",
     "content": "<message>",
     "thread_id": "<thread_id>"
   }
   ```
7. Upsert a `chat_threads` row with `onConflict: 'thread_id', ignoreDuplicates: true` so every thread is immediately addressable for project assignment, even if title generation later fails. When `project_id` was supplied and the row doesn't exist yet, it's stamped on the upsert (the `ignoreDuplicates` flag guarantees no overwrite for an existing thread).
8. Read back `chat_threads.title` and `chat_threads.project_id` for this thread. A null title means the thread still needs one (covers brand-new threads and older threads backfilled with NULL). If `project_id` is set, read `chat_projects.instructions` — trimmed, non-empty — so we can inject it as an inline system-style preamble. Both lookups are server-side only; the request body's `project_id` is never trusted past the upsert stamp.
9. For the title seed, fetch the earliest user message in the thread from `chat_messages` (for a brand-new thread this is the message we just inserted in step 6; for an older thread that predates the `chat_threads` table it's the historical first question, which keeps the title faithful to the conversation's actual topic).
10. Build the **search query string** the same way as before: when project instructions are present, prepend the same preamble so project-scoped turns embed the combined text.
11. Call OpenAI **embeddings** once for that string (`text-embedding-3-small`, 1536 dimensions).
12. For each assistant corpus implied by `source` (`text`, `narrated`, or both in parallel), call Postgres RPC `search_document_chunks` with the embedding, `match_count`, `filter_corpus`, and optional `filter_volume`.
13. Turn ranked rows into markdown (`### Semantic search results`, numbered citations + blockquotes) and a `sources` jsonb array (chunk text + metadata for the UI). Insert **one** assistant row per corpus with the shared `turn_id`.
14. If the thread still has no title, derive one with the same `normalizeTitle` heuristic on the title seed (first ~8 words of the earliest user message) and update `chat_threads` where `title is null`.

## CORS Headers (on every response)
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Methods: POST, OPTIONS
```

## OpenAI embeddings (reference)
```
POST https://api.openai.com/v1/embeddings
Authorization: Bearer {OPENAI_API_KEY}
Content-Type: application/json

Body: { "model": "text-embedding-3-small", "input": "<string>", "dimensions": 1536 }
```

## Error handling
- Wrap the entire handler in try/catch
- Log errors with `console.error` (include OpenAI / Supabase RPC error bodies when safe)
- Return 500 with `{ "error": "Internal error" }` — never expose internal stack traces or the service role key to the client
- 4xx responses **do** include a short human-readable `error` string because the client displays it verbatim to help the user recover

## Imports (Deno style)
```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```
