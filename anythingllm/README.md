# AnythingLLM Workspace Config

This directory is the source of truth for our AnythingLLM workspace settings — most importantly the **system prompt** that instructs Claude how to answer, attribute, and cite. Committing it here means local dev and the production VPS can be kept in sync with one command instead of being configured by hand through the UI.

## Layout

```
anythingllm/
├── README.md                              ← this file
├── apply-workspace.mjs                    ← Node 18+ script: applies a config to an instance
└── workspaces/
    ├── book-of-heaven-narrated.config.json ← non-prompt settings for the "narrated" workspace (audio transcripts)
    ├── book-of-heaven-narrated.prompt.md   ← system prompt for the "narrated" workspace
    ├── book-of-heaven-text.config.json     ← non-prompt settings for the "text" workspace (diary PDFs)
    └── book-of-heaven-text.prompt.md       ← system prompt for the "text" workspace (markdown is just for readability; AnythingLLM stores it as plain text)
```

## What's captured

| File | Contents |
|---|---|
| `*.prompt.md` | The workspace's system prompt. Plain text; markdown is only used for author readability. |
| `*.config.json` | Slug, display name, reference to the prompt file, and all chat/retrieval settings (model, `topN`, temperature, vector search mode, etc.). |

What is **not** captured:

- **Embedded documents.** Your transcripts live inside AnythingLLM storage and aren't versioned here. Adding the 241 VTT files to a fresh workspace is a separate step (upload via UI or via the AnythingLLM API).
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

Typical flow when deploying to the VPS for the first time:

1. Install AnythingLLM on the VPS (see `docs/vps-setup.md`).
2. Upload/embed the VTT transcripts (241 files).
3. Run `apply-workspace.mjs` against the VPS URL to configure settings + system prompt.
4. Run the same command against local whenever you pull prompt changes from the repo, so dev parity is maintained.
