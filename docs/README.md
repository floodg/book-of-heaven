# Run commands

Daily commands to run the app locally. For first-time setup, see [local-dev-setup.md](./local-dev-setup.md).

Docker Desktop must be running before starting Supabase.

Leave `VITE_SUPABASE_URL` empty in `frontend/.env`. Vite proxies `/auth`, `/rest`, `/functions`, `/realtime`, and `/storage` to local Kong (`http://127.0.0.1:54331`), so the browser always talks to the page origin (localhost or ngrok). Do not start a second ngrok tunnel for Supabase.

## Start

From the repo root, use separate terminals:

**1. Supabase**

```bash
supabase start
```

**2. Edge Function**

```bash
supabase functions serve chat-proxy --env-file ./supabase/functions/.env
```

**3. Frontend**

```bash
cd frontend
npm run dev
```

**4. AnythingLLM** (Docker)

```bash
docker start anythingllm
```

Or open the AnythingLLM desktop app.

**5. ngrok** (public frontend URL)

```bash
ngrok http --url=dallyingly-cisternal-loida.ngrok-free.dev 5173
```

This reserved domain is the only public URL you need. It does not include your home ISP IP, so a DHCP/reconnect change does not require editing `.env` or Vite config. If the home connection drops, restart this ngrok agent — do not retarget env vars at a new IP.

Vite already allows this host in `frontend/vite.config.ts`. Start the frontend first so the tunnel has something to reach.

## Stop

```bash
supabase stop
docker stop anythingllm
```

## URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Frontend (ngrok) | https://dallyingly-cisternal-loida.ngrok-free.dev |
| Supabase Studio | http://localhost:54333 |
| Supabase API (direct) | http://localhost:54331 |
| Edge Function (via Vite / ngrok origin) | /functions/v1/chat-proxy |
| AnythingLLM | http://localhost:3001 |

## YouTube map

Citation pills resolve Volume/Number to a YouTube video from this file:

`frontend/public/data/youtube-map.json`

The SPA loads it at boot (`/data/youtube-map.json`). The chat-proxy Edge Function imports the same JSON, so both the browser and the server stay in sync from one file.

Keys are `"volume:number"` (for example `"18:1"`). Values are the 11-character YouTube video ID.

### Updating

When new videos land (a new volume, or replacement slugs):

1. Open `frontend/public/data/youtube-map.json`.
2. Merge the new `"<volume>:<number>": "<videoId>"` entries. If the slugs file is a full map, you can replace the JSON wholesale as long as existing keys are not dropped by accident.
3. Leave out numbers that have no video yet (for example missing `11:10` / `12:12`). The UI hides the YouTube icon when a key is absent.
4. Keep valid JSON (comma after the previous last entry, no trailing comma on the new last entry).
5. Commit the file. Redeploy the frontend **and** the Edge Function so production picks up the new IDs.

To regenerate instead of editing by hand, from the repo root:

```bash
npm run build-youtube-map -- --csv path/to/slugs.csv --out frontend/public/data/youtube-map.json
```

See [SPEC-source-linking.md](./SPEC-source-linking.md) for the citation → YouTube pipeline.
