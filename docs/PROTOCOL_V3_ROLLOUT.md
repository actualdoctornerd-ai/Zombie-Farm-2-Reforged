# Protocol v3 destructive rollout

> **Current security restriction (2026-07-15):** protocol v3 must remain fun-only.
> Raid outcomes are client-asserted and raid mutations are not serialized with `/commands`.
> Do not enable paid currency, trading,
> competitive rankings, or PvP until the release gates in `../SECURITY.md` are complete.

Protocol v3 deliberately has no data migration or backward compatibility. The reset
migration deletes every account, session, friendship, gift, gameplay row, save, receipt,
and audit record. Take a D1 backup only if a historical snapshot may be useful; it is not
usable by the v3 application.

## Maintenance sequence

1. Set `MUTATIONS_DISABLED=1` and deploy the Worker. Confirm `/commands`,
   `/presentation`, and both raid mutation routes reject writes.
2. Disable or hide sign-in at the client edge so a user cannot create an account while
   the database is being replaced.
3. Apply the pending migrations through `server/migrations/0025_writer_lease.sql`
   to the production D1 database. `0020_protocol_v3_reset.sql` is intentionally
   repeatable and recreates the protocol-v3 baseline; `0021` adds Epic Boss runs and
   sessions, `0024` adds run-scoped fight tokens, and `0025` adds the authenticated
   writer-lease columns (`writer_session_id` / `writer_token_hash` / `writer_last_activity_at`
   / `active_batch_expires_at`) and clears prior unauthenticated writer ids so the first
   upgraded client must re-acquire control. Confirm Wrangler reports no pending
   migrations afterward.
4. Rotate `SESSION_SECRET` with `wrangler secret put SESSION_SECRET`. Never reuse the
   historical value. This invalidates any token copied before the database reset even if
   it is presented to a different environment.
5. Deploy the protocol-v3 Worker with `MIN_PROTOCOL_VERSION=3`. Verify v2 save, sync,
   quest-complete, farm-action, and raid-checkpoint routes return
   `410 {"error":"update_required","protocolVersion":3}`.
6. Deploy the v3 client. It uses new session, device, presentation, and command-outbox
   storage keys and removes historical Zombie Farm local-save/outbox/profile keys at
   startup.
7. Run the smoke checks below while mutations remain disabled, then set
   `MUTATIONS_DISABLED=0` and re-enable sign-in.

Do not reverse the order of steps 3–6: an old client writing after the reset or a new
client reaching the old schema can create state that must be reset again.

## Smoke checks

- A historical access token receives `401`.
- A fresh sign-in creates a new account, username flow, friend code, and empty social
  graph.
- Sign-in performs authentication followed by one `/bootstrap` request.
- Ten idle minutes produce no application requests.
- Fifty ordinary farm commands per minute settle in no more than six `/commands`
  requests per minute; a 64-command batch may flush earlier.
- Insta-Plow and Insta-Harvest each appear as one semantic command.
- A second device's first takeover mutation returns a state conflict without applying
  its commands; the replaced device becomes read-only.
- A raid produces one `/raid/start` and one `/raid/finish`; an early finish gets one
  scheduled retry from the supplied `retryAfterMs` and never polls.
- A raid result is currently a client claim bounded by server roster membership, elapsed
  time, catalog rewards, and cooldown. This smoke check verifies transport behavior only;
  it does not prove that combat occurred or that the submitted outcome is genuine.
- Presentation changes generate at most one `/presentation` request per minute and
  authoritative reconciliation generates none.
- Friends, requests, and inbox make no polling requests and refresh only at bootstrap or
  when their menu opens.

## Emergency controls

- Set `MUTATIONS_DISABLED=1` to stop all protocol-v3 gameplay writes while preserving
  read-only bootstrap and investigation access.
- Raise `MIN_PROTOCOL_VERSION` to reject stale `/commands` clients after the replacement
  is deployed. This gate currently does **not** cover `/raid/start`, `/raid/finish`, or
  `/presentation`; use `MUTATIONS_DISABLED=1` when all gameplay mutations must stop.
- Use route/build/account-hash metrics to compare request volume, commands per batch,
  rejection reasons, retry attempts, D1 reads/writes, CPU, payload size, and latency.
  Routine successes are sampled; security failures and errors remain unsampled.

The farm document retains exactly one previous structural version. Never restore that
JSON alone: first use the latest aggregate batch result to reverse its balance, quest,
object, inventory, and zombie effects in the same maintenance operation.

Raid start/finish currently update balance, gameplay, quest, raid, and roster state outside
the command account-version transaction. During investigation or repair, assume those
documents can disagree after a concurrent request and reconcile them as one account state.
