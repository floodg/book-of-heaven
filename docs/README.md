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
