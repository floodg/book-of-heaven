# Spec: Edge Function — chat-proxy

## File
`supabase/functions/chat-proxy/index.ts`

## Purpose
Secure proxy between the React frontend and AnythingLLM. Validates the user's Supabase JWT, forwards the message to AnythingLLM, persists both the user and assistant messages to the database with the caller-supplied `thread_id`, and returns the aggregated AI response.

## Environment Variables
Available via `Deno.env.get()`:
```
ANYTHINGLLM_URL        e.g. http://host.docker.internal:3001
ANYTHINGLLM_KEY        AnythingLLM API key
ANYTHINGLLM_WORKSPACE  workspace slug e.g. book-of-heaven
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
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10"
}
```

- `message` — required, non-empty string
- `thread_id` — required, lowercase RFC 4122 UUID. Minted by the frontend on the first message of a fresh chat and reused for every subsequent message in that conversation (see `SPEC-chat-ui.md`).

## Response

**Success 200:**
```json
{
  "reply": "Based on the Book of Heaven writings...[Book of Heaven Volume 17 - Number 13]...",
  "thread_id": "7a2f8d5c-7e43-4e1f-9a0a-4b5f8d2a3c10"
}
```

`thread_id` is echoed back verbatim so the client can confirm the server persisted the message against the expected thread.

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
5. Parse request body, extract `message` and `thread_id`:
   - Return 400 if `message` is missing/empty
   - Return 400 if `thread_id` is missing or doesn't match the UUID regex
6. Insert the user message into `chat_messages`:
   ```json
   {
     "user_id": "<user.id>",
     "role": "user",
     "content": "<message>",
     "thread_id": "<thread_id>"
   }
   ```
7. POST to AnythingLLM's streaming endpoint:
   ```
   URL: {ANYTHINGLLM_URL}/api/v1/workspace/{ANYTHINGLLM_WORKSPACE}/stream-chat
   Headers:
     Authorization: Bearer {ANYTHINGLLM_KEY}
     Content-Type: application/json
     Accept: text/event-stream
   Body: { "message": "<message>", "mode": "chat" }
   ```
   We use `/stream-chat` rather than `/chat` because AnythingLLM's non-streaming endpoint returns an empty `textResponse` for our workspace configuration (LLM/embedding combination) while the streaming endpoint works reliably. The proxy aggregates the stream server-side so the public contract stays non-streaming.
8. Read the SSE stream, parse `data: { ... }` frames, accumulate `chunk.textResponse` into `fullText` and capture any `chunk.error` string
9. Decide the final reply:
   - `fullText.trim()` non-empty → use `fullText`
   - Otherwise if `llmError` was set → return `"AnythingLLM error: <llmError>"` so the frontend shows a diagnostic rather than a blank reply
   - Otherwise → return an instructional fallback message explaining the workspace needs documents and an LLM configured
10. Insert the assistant reply into `chat_messages` using the same `thread_id`:
    ```json
    {
      "user_id": "<user.id>",
      "role": "assistant",
      "content": "<reply>",
      "thread_id": "<thread_id>"
    }
    ```
11. Return `{ reply, thread_id }` with JSON + CORS headers

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
