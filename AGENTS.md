# Repository Agent Instructions

These instructions apply to the entire repository.

## Server Environments

There are two deployed server environments (Cloudflare Worker + D1), both defined
in `server/wrangler.toml`:

- **Staging (the default)** — Worker `zombiefarm-server-staging` at
  `https://zombiefarm-server-staging.zombiefarm.workers.dev`, database
  `zombiefarm-staging`. This is the TOP-LEVEL config, so every bare wrangler
  command (`deploy`, `dev`, `d1`, `migrations`) targets staging. Its data is
  disposable; `DEV_AUTH=1` is on, so `window.zfDevSignIn("any-id")` creates
  throwaway accounts without Google.
- **Production** — Worker `zombiefarm-server`, database `zombiefarm` (real player
  data). Reachable ONLY with an explicit `--env production` flag;
  `npm run deploy:prod` runs the full check suite (migrations:check, catalogs:check, typecheck,
  unit + integration tests) before deploying. Omitting the flag fails safe for
  config-bound commands, but `wrangler d1 execute <name> --remote` resolves any
  database in the account by name — so `d1 execute zombiefarm --remote` touches
  the PRODUCTION database even without the flag. Treat writes there accordingly.

Test server-based features against staging, never production. To connect a local
client to staging: set `VITE_API_URL` to the staging URL in `.env.local`, serve
the client on `http://localhost:5173` or `:4173` exactly (the CORS allowlist is
exact-match; `127.0.0.1` and other ports are rejected — the
`zombiefarm-staging-client` launch config serves 4173 for when 5173 is taken),
then in the browser console set
`localStorage.setItem("zf2r.play-mode.v1","online")`, reload, and
`await window.zfDevSignIn("you@test.local","Name")`, reload. Real Google sign-in
does not work from localhost. Full recipe: root `README.md` ("Online against the
deployed STAGING server"); operations detail: `server/README.md`.

## Actions Requiring Explicit Permission

- Do not push code or branches to any remote without the user's explicit permission.
- Do not deploy the server or worker to any environment without the user's explicit
  permission. This includes staging — its data is disposable, but a deploy changes
  what the shared staging stack serves.
- Do not apply database migrations to any local or remote database without the user's explicit permission.
- A request to implement, fix, test, or complete a task does not by itself grant permission for any of the actions above. Obtain permission for the specific push, deployment, or migration before performing it.

## Completion Report

After completing every task, explicitly report:

- Whether the worker needs to be deployed for the completed changes to take effect.
- Whether a database migration needs to be applied for the completed changes to take effect.

State `Yes`, `No`, or `Unknown` for each item and briefly explain any required next action. Reporting that an action is needed does not authorize performing it.
