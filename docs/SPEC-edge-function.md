# Spec: Edge Function — chat-proxy

## File
`supabase/functions/chat-proxy/index.ts`

## Purpose
Secure proxy between the React frontend and AnythingLLM. Validates the user's Supabase JWT, forwards the message to AnythingLLM, persists both the user and assistant messages to the database with the caller-supplied `thread_id`, generates a short human-readable title for the thread on its first exchange, optionally stamps a new thread with the project it was created from, prepends per-project instructions to the LLM call, captures the retrieval source chunks AnythingLLM surfaces so the frontend can link each citation to its PDF page / YouTube timestamp, and returns the aggregated AI response.

## Environment Variables
Available via `Deno.env.get()`:
```
ANYTHINGLLM_URL        e.g. http://host.docker.internal:3001
ANYTHINGLLM_KEY        AnythingLLM API key
ANYTHINGLLM_WORKSPACE  workspace slug e.g. book-of-heaven-narrated
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
  "project_id": "b12c4a0f-33a1-4d48-9b2f-71aa4a9d6ef1"
}
```

- `message` — required, non-empty string
- `thread_id` — required, lowercase RFC 4122 UUID. Minted by the frontend on the first message of a fresh chat and reused for every subsequent message in that conversation (see `SPEC-chat-ui.md`).
- `project_id` — optional, UUID. Only honoured on the **first** insert of a thread: the upserted `chat_threads` row is stamped with this project. Subsequent requests for the same thread ignore it (upsert uses `ignoreDuplicates: true`), so the client can't sneak a thread into a different project by replaying messages. See `SPEC-projects.md`.

## Response

**Success 200:**
```json
{
  "reply": "Based on the Book of Heaven writings...[Book of Heaven Volume 17 - Number 13]...",
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10",
  "title": "Divine Will and the soul",
  "sources": [
    {
      "title": "Volume_17.pdf",
      "chunkSource": "file:///.../Volume_17.pdf",
      "text": "<document_metadata> pageNumber: 412 </document_metadata>\n\nAnd Jesus said...",
      "score": 0.82
    }
  ]
}
```

`thread_id` is echoed back verbatim so the client can confirm the server persisted the message against the expected thread. `title` is the newly-generated thread title if this request triggered title generation (i.e. this was the first exchange in the thread, or the thread existed but had no `chat_threads` row yet); it is `null` when the thread already had a title or when title generation failed gracefully. The frontend does not depend on reading it from the response — the sidebar re-queries `chat_threads` on refresh — but surfacing it keeps the API observable.

`sources` is the retrieval chunks AnythingLLM surfaced for this turn (may be an empty array or `null`). The exact shape is pass-through from AnythingLLM's SSE stream; the frontend treats every field as optional. See `docs/SPEC-source-linking.md` for how the UI turns this payload into PDF-page + YouTube-timestamp links on each citation pill. The same payload is persisted to `chat_messages.sources` (jsonb) so the links still resolve after a page reload. The title-generation call deliberately does **not** forward its sources — only the main response's sources are captured and returned.

**Error responses** — all JSON with a single `error` field so the frontend can surface a meaningful message:
- `400` — missing/empty `message`, missing/invalid `thread_id` (not a UUID), or malformed JSON body
- `401` — missing `Authorization` header or invalid/expired JWT (frontend treats this as "session dead" and signs the user out)
- `500` — AnythingLLM unreachable, insert failure, or any uncaught exception

```json
{ "error": "Missing or invalid thread_id (expected UUID)" }
```

## Logic — step by step

1. Handle CORS preflight (`OPTIONS` request) — return 200 with permissive headers
2. Extract `Authorization` header — return 401 if missing
3. Create a service-role Supabase client using `SUPABASE_URL` + `SERVICE_ROLE_KEY`
4. Call `supabase.auth.getUser(token)` to validate the JWT and get `user.id` — return 401 if invalid
5. Parse request body, extract `message`, `thread_id`, `project_id`:
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
10. Build the LLM-bound message. When project instructions are present, wrap the user message like:
    ```text
    You are acting inside a user's project. Follow these project-level
    instructions for the rest of this conversation:

    ---
    {project.instructions}
    ---

    User message:
    {message}
    ```
    AnythingLLM's `/stream-chat` endpoint doesn't expose a per-request system prompt slot, so baking the preamble into `message` is the least invasive integration. The title LLM call deliberately **skips** instructions — titles should describe the user's question, not the project's framing.
11. Fire two AnythingLLM calls **in parallel** with `Promise.all`:
   1. The main chat request (always). `message` here is the composed message from step 10 — with the project-instructions preamble when applicable, otherwise the user's raw text.
      ```
      URL: {ANYTHINGLLM_URL}/api/v1/workspace/{ANYTHINGLLM_WORKSPACE}/stream-chat
      Headers:
        Authorization: Bearer {ANYTHINGLLM_KEY}
        Content-Type: application/json
        Accept: text/event-stream
      Body: { "message": "<composed message>", "mode": "chat" }
      ```
      We use `/stream-chat` rather than `/chat` because AnythingLLM's non-streaming endpoint returns an empty `textResponse` for our workspace configuration (LLM/embedding combination) while the streaming endpoint works reliably. The proxy aggregates the stream server-side so the public contract stays non-streaming.
   2. The title request (only when the thread needs a title) — same endpoint, with a wrapper prompt:
      ```
      Generate a 3 to 6 word title that describes the topic of the user
      request below. The title is shown in a chat history sidebar, so it must
      be concise and readable. Output ONLY the title itself — no quotes, no
      trailing punctuation, no citations, no "Title:" prefix, no explanation,
      no markdown.

      User request: <titleSeed>
      ```
      Run title generation in parallel with the main response so it does not extend user-perceived latency; the title stream is short (a few tokens) and typically finishes well before the main reply.
12. Read each SSE stream, parse `data: { ... }` frames, accumulate `chunk.textResponse` into `fullText`, capture any `chunk.error` string, and capture the last non-empty `chunk.sources` array seen on the stream. (Shared helper `anythingLlmChat` does this for both calls; only the main-response sources are used, the title call's sources are dropped.)
13. Decide the final reply:
    - `fullText.trim()` non-empty → use `fullText`
    - Otherwise if `llmError` was set → return `"AnythingLLM error: <llmError>"` so the frontend shows a diagnostic rather than a blank reply
    - Otherwise → return an instructional fallback message explaining the workspace needs documents and an LLM configured
14. Normalize the title output: strip any `[Book of Heaven ...]` / `[Volume ...]` citations the system prompt may have leaked in, strip `Title:` prefixes, take only the first non-empty line, strip wrapping quotes (straight + curly), strip trailing `.?!,;:`, collapse whitespace, and hard-cap at 60 characters (appending `…` if it had to be cut). If what's left is under 2 characters, treat the title as unusable and skip the update.
15. Insert the assistant reply into `chat_messages` using the same `thread_id`, attaching the retrieval sources we captured in step 12 (or `null` if the stream didn't surface any):
    ```json
    {
      "user_id": "<user.id>",
      "role": "assistant",
      "content": "<reply>",
      "thread_id": "<thread_id>",
      "sources": "<mainResult.sources | null>"
    }
    ```
    The column is `jsonb` (migration `006_chat_message_sources.sql`) and the frontend treats every field as optional.
16. If a title was generated, update the existing `chat_threads` row (the row already exists because step 7 upserted it):
    ```sql
    update chat_threads
       set title = :title, updated_at = now()
     where thread_id = :thread_id and user_id = :user_id and title is null
    ```
    The `title is null` guard prevents two concurrent requests racing on the same thread from clobbering each other's titles; whichever one wins the race sets the title and the other one becomes a no-op. Any update error is logged but not thrown — we'd rather return the user's reply than 500 over a cosmetic title.
17. Return `{ reply, thread_id, title, sources }` with JSON + CORS headers. `title` is `null` when no title was generated this request; `sources` is the (possibly `null`) retrieval payload from step 12.

## CORS Headers (on every response)
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Methods: POST, OPTIONS
```

## AnythingLLM API reference (streaming)
```
POST /api/v1/workspace/{slug}/stream-chat
Authorization: Bearer {key}
Content-Type: application/json
Accept: text/event-stream

Body: { "message": string, "mode": "chat" }

Response: text/event-stream of frames shaped like:
  data: { "id": "...", "type": "textResponseChunk", "textResponse": "..."}
  data: { "id": "...", "type": "finalizeResponseStream", "close": true }
  data: { "error": "..." }   // on failure
```

## Error handling
- Wrap the entire handler in try/catch
- Log errors with `console.error` (full object for AnythingLLM failures so the dev terminal shows the raw upstream response)
- Return 500 with `{ "error": "Internal error" }` — never expose internal stack traces or the service role key to the client
- 4xx responses **do** include a short human-readable `error` string because the client displays it verbatim to help the user recover

## Imports (Deno style)
```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```
