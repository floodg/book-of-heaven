# AnythingLLM Workspace Config

> **Note:** The production app path uses **Supabase `document_chunks` + pgvector** for semantic search (see `supabase/migrations/010_document_chunks.sql` and `index_supabase.py` in the splitter repos). This directory remains useful for **reference prompts / workspace JSON** or if you run AnythingLLM locally for experiments—it is no longer required for the default chat flow.

This directory is the source of truth for our AnythingLLM workspace settings — most importantly the **system prompt** that instructs Claude how to answer, attribute, and cite. Committing it here means local dev and the production VPS can be kept in sync with one command instead of being configured by hand through the UI.

## Layout

```
anythingllm/
├── README.md                              ← this file
├── apply-workspace.mjs                    ← Node 18+ script: applies a config to an instance
└── workspaces/
    ├── book-of-heaven-narrated.config.json ← non-prompt settings for the "narrated" workspace (audio transcripts)
    ├── book-of-heaven-narrated.prompt.md   ← system prompt for the "narrated" workspace
    ├── book-of-heaven-text.config.json     ← non-prompt settings for the "text" workspace (`book-of-heaven-text-files`)
    └── book-of-heaven-text.prompt.md       ← system prompt for the text workspace (markdown is just for readability; AnythingLLM stores it as plain text)
```

## What's captured

| File | Contents |
|---|---|
| `*.prompt.md` | The workspace's system prompt. Plain text; markdown is only used for author readability. |
| `*.config.json` | Slug, display name, reference to the prompt file, and all chat/retrieval settings (model, `topN`, temperature, vector search mode, etc.). The narrated (VTT) config keeps **`similarityThreshold` very low (0)** because VTT vector scores are smaller; the text (PDF) config uses **`0.25`** (AnythingLLM’s “Low / ≥ 0.25” preset) for better recall than a stricter value like `0.5`. |

What is **not** captured:

- **Embedded documents.** Your transcripts live inside AnythingLLM storage and aren't versioned here. Adding the 221 VTT files to a fresh workspace is a separate step (upload via UI or via the AnythingLLM API).
- **API keys** and per-instance secrets. Those belong in `.env` files that are gitignored.

## Applying a config

Requires Node 18+ (uses global `fetch`).

```bash
# Local (your desktop AnythingLLM)
ANYTHINGLLM_URL=http://localhost:3001 \
ANYTHINGLLM_KEY=your-local-key \
node anythingllm/apply-workspace.mjs \
  --config anythingllm/workspaces/book-of-heaven-narrated.config.json

# Production VPS
ANYTHINGLLM_URL=https://your-vps-host:3001 \
ANYTHINGLLM_KEY=your-production-key \
node anythingllm/apply-workspace.mjs \
  --config anythingllm/workspaces/book-of-heaven-narrated.config.json
```

Flags override env vars if you prefer explicit:

```bash
node anythingllm/apply-workspace.mjs \
  --config anythingllm/workspaces/book-of-heaven-narrated.config.json \
  --url http://localhost:3001 \
  --key your-key
```

The script will:

1. Read the config JSON and the referenced prompt file.
2. Check whether the workspace already exists at the target instance.
3. If not, create it (you'll then need to embed documents into it).
4. POST `settings + openAiPrompt` to `/api/v1/workspace/{slug}/update`.
5. Re-fetch the workspace and print a summary so you can eyeball the applied values.

## Editing the prompt

Always edit `book-of-heaven-narrated.prompt.md` in this repo — **not** in the AnythingLLM UI — and run the apply script. That way the repo stays authoritative and prod + local can't drift.

If you ever edit the prompt in the UI by accident, pull it back into the repo before making any local changes:

```bash
curl -s -H "Authorization: Bearer $ANYTHINGLLM_KEY" \
  "$ANYTHINGLLM_URL/api/v1/workspace/book-of-heaven-narrated" \
  | jq -r '.workspace.openAiPrompt' \
  > anythingllm/workspaces/book-of-heaven-narrated.prompt.md
```

## Deployment workflow

Both workspaces — `book-of-heaven-text-files` (text) and `book-of-heaven-narrated` — must exist and be populated on every instance (local + VPS). The chat-proxy edge function picks one or the other (or both, in parallel) per request based on the frontend's per-message source selector; if a slug is missing, that source will surface an error in the UI instead of silently falling back.

Typical flow when deploying to the VPS for the first time:

1. Install AnythingLLM on the VPS (see `docs/vps-setup.md`).
2. Create **both** workspaces and embed their documents:
   - `book-of-heaven-narrated`: 221 VTT transcripts of Francis Hogan's readings.
   - `book-of-heaven-text-files`: diary text chunks (markdown), e.g. from `book-of-heaven-txt-splitter`.
3. Run `apply-workspace.mjs` against the VPS URL **once per workspace** to configure settings + system prompt:

   ```bash
   node anythingllm/apply-workspace.mjs \
     --config anythingllm/workspaces/book-of-heaven-narrated.config.json
   node anythingllm/apply-workspace.mjs \
     --config anythingllm/workspaces/book-of-heaven-text.config.json
   ```
4. Run the same commands against local whenever you pull prompt changes from the repo, so dev parity is maintained.
