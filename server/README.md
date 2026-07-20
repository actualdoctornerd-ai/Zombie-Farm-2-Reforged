# Zombie Farm server

Protocol-v3 gameplay and social server built on a Cloudflare Worker (Hono) and D1
(SQLite). Identity is Google Sign-In verified server-side; the browser client calls
the API cross-origin from GitHub Pages.

Both the ordinary command path and the raid path are server-authoritative. Residual
concurrency and audit gaps remain. Read `../SECURITY.md` before deploying or enabling
anything competitive or money-like.

The online server remains optional. With `VITE_API_URL` unset, the client runs in
offline-only mode and never contacts the Worker.

## Active protocol-v3 surface

Core routes:

- `POST /auth`
- `POST /bootstrap`
- `POST /commands`
- `PUT /presentation`
- `POST /raid/start`
- `POST /raid/finish`
- `POST /raid/revive`
- account/session, friend, visit, and gift routes in `src/index.ts`

`/commands` applies allowlisted semantic gameplay commands against server-held state
using an account version, writer generation, sequential commands, and a D1 transaction
guard. Presentation state is stored and versioned separately. Historical v2 save,
state-sync, action, and raid-checkpoint routes are authenticated but return
`410 update_required`.

`/raid/start` pins the combat config (enemy set and player roster, built from
server-owned tables and catalogs) into the session row. `/raid/finish` accepts only
`{ sessionId, finalTick, inputs }` — there is no field through which a client can
assert a `win`, survivor, or casualty. The outcome is derived by replaying that input
transcript against the pinned config (`src/raidVerifier.ts` → `src/raid/replay.ts`),
and rewards are priced from the server catalog against the replayed survivor ratio. An
elapsed-time gate (`future_finish`) and ruleset-version pinning (`stale_ruleset`) are
defense-in-depth on top of the replay, not substitutes for it. Epic Boss finishes use
the same path.

## Current security restrictions

- Raid start/finish do not yet join the `/commands` account-version transaction and can
  race command writes.
- A placed Plowing Monolith allows a repeatable remove/re-plow XP loop.
- `MIN_PROTOCOL_VERSION` gates `/commands` only. Use `MUTATIONS_DISABLED=1` to stop
  commands, presentation writes, and both raid mutation routes during an incident.
- Paid currency, trading, competitive rankings, and PvP must remain disabled until the
  release gates in `../SECURITY.md` pass.

## Local development

```bash
cd server
npm install
cp .dev.vars.example .dev.vars
npm run db:apply:local
npm run dev
```

The local Worker runs at `http://127.0.0.1:8787`. In the repository root, copy
`.env.example` to `.env.local` and run the client with `npm run dev`.

With `DEV_AUTH=1`, the client exposes `window.zfDevSignIn(sub, name)` for automated
local sign-in without the Google popup. **Never deploy with `DEV_AUTH=1`.**

Validation commands:

```bash
npm run typecheck
npm test
npm run test:integration
```

## Production setup

1. In Google Cloud, create an OAuth 2.0 Web client and add the Pages origin and local
   development origin to Authorized JavaScript origins.
2. Create the D1 database and place its ID in `wrangler.toml`.
3. Follow `../docs/PROTOCOL_V3_ROLLOUT.md`. Protocol v3 uses a destructive reset and
   intentionally has no legacy data migration.
4. Store `SESSION_SECRET` with `wrangler secret put SESSION_SECRET`; never commit it.
5. Set `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGIN`, `DEV_AUTH=0`, and the operational protocol
   variables in `wrangler.toml`.
6. Deploy the Worker and client in the documented order, then perform the authenticated
   smoke checks before enabling mutations.

## Operational notes

- CORS permits `ALLOWED_ORIGIN` plus the local development origins. CORS is a browser
  boundary, not an anti-cheat control.
- Cloudflare rate-limit bindings throttle authentication, read, and write tiers. D1
  uniqueness and transaction guards remain the correctness controls.
- Multi-device command writes use single-writer account-version CAS. A takeover changes
  writer generation and makes the replaced device read-only.
- Repair balance, gameplay, quest, farm/object, roster, and raid state together. Restoring
  an individual JSON document can create an inconsistent or exploitable account.
