# Zombie Farm server

Ground-truth game server: cloud saves + async friend gifting. Cloudflare Worker
(Hono) + D1 (SQLite). Identity is Google Sign-In, verified server-side; the client
lives on GitHub Pages and calls this API cross-origin.

The whole thing is **additive**: with `VITE_API_URL` unset the client is offline-only
and never touches the network.

## Endpoints

`POST /auth` · `GET /me` · `GET|PUT /save` · `GET /friends` · `POST /friends/add`
· `POST /gifts` · `GET /gifts/inbox` · `POST /gifts/claim`. See `src/index.ts`.

The save blob is opaque to the server except `player.brains`, which a gift claim
credits (the one deliberate coupling). Writes are guarded by a `rev` (optimistic
concurrency → 409 on a stale write). The once-per-day gift limit is enforced here.

## Local dev

```bash
cd server
npm install
cp .dev.vars.example .dev.vars          # DEV_AUTH=1 enables the no-Google bypass
npm run db:apply:local                   # create local D1 tables
npm run dev                              # wrangler dev on http://127.0.0.1:8787
```

Point the client at it: in the repo root, `cp .env.example .env.local` (defaults to
`VITE_API_URL=http://127.0.0.1:8787`) and `npm run dev`.

With `DEV_AUTH=1` the client exposes `window.zfDevSignIn(sub, name)` to sign in
without the Google popup — used for automated end-to-end testing. **Never ship with
`DEV_AUTH=1`.**

Run the pure-logic tests: `npm test`.

## One-time production setup (manual)

1. **Google Cloud** → APIs & Services → Credentials → create an **OAuth 2.0 Client
   ID** (type: Web). Under *Authorized JavaScript origins* add your Pages origin
   (`https://actualdoctornerd-ai.github.io`) and `http://localhost:5173`. Copy the
   client id.

2. **Cloudflare / D1:**
   ```bash
   npx wrangler login
   npx wrangler d1 create zombiefarm      # paste the printed database_id into wrangler.toml
   npm run db:apply:remote                 # create the tables on the real DB
   npx wrangler secret put SESSION_SECRET  # any long random string
   ```
   In `wrangler.toml` set `GOOGLE_CLIENT_ID` (the id from step 1), `ALLOWED_ORIGIN`
   (your Pages origin), and keep `DEV_AUTH = "0"`.

3. **Deploy the Worker:** `npm run deploy` (or push to `main` — see
   `.github/workflows/deploy-server.yml`, which needs a repo secret
   `CLOUDFLARE_API_TOKEN` with Workers + D1 edit permission). Note the Worker URL.

4. **Wire the client:** add GitHub repo **variables** `VITE_API_URL` (the Worker URL)
   and `VITE_GOOGLE_CLIENT_ID` (the client id). The Pages build (`deploy.yml`) embeds
   them. Leaving them unset keeps the site offline-only.

## Notes / limits

- Cross-origin: CORS allows `ALLOWED_ORIGIN` + localhost. If the Pages site can't
  reach the Worker, check this first.
- Trust: the save blob is client-authored (currency/level are honor-system — fine
  for fun-only leaderboards). Identity, friendships, and the gift limit are
  server-enforced and tamper-proof.
- Conflicts: multi-device writes use last-write-wins with a rev guard; on a 409 the
  client pauses server autosave until a reload reconciles (a reload always pulls
  server truth). No merge.
- Free tier: Workers (100k req/day) + D1 (5 GB, 5M reads/day) — ample for a hobby game.
