# Protocol v3 destructive rollout

> **Security status (2026-07-19):** the anti-cheat gaps that made protocol v3 fun-only are
> closed — raid/Epic Boss outcomes are server-verified by deterministic replay, all mutation
> routes are serialized through the writer lease's active-operation lock, and the free-plow XP
> loop is gone. Before enabling valuable/competitive features, complete the deployment-time
> release gates in `../SECURITY.md` (notably `WRITER_LEASE_MODE=enforce`, `MIN_PROTOCOL_VERSION=3`,
> `SESSION_SECRET` rotation, and confirming the live commit/D1 schema).

Protocol v3 deliberately has no data migration or backward compatibility. The reset
migration deletes every account, session, friendship, gift, gameplay row, save, receipt,
and audit record. Take a D1 backup only if a historical snapshot may be useful; it is not
usable by the v3 application.

## Maintenance sequence

1. Set `MUTATIONS_DISABLED=1` and deploy the Worker. Confirm `/commands`, `/presentation`,
   and the raid, Epic Boss, and Black Market mutation routes reject writes.
2. Disable or hide sign-in at the client edge so a user cannot create an account while
   the database is being replaced.
3. Apply the pending migrations through `server/migrations/0027_v3_raid_replay.sql`
   to the production D1 database. `0020_protocol_v3_reset.sql` is intentionally
   repeatable and recreates the protocol-v3 baseline; `0021` adds Epic Boss runs and
   sessions; `0024` adds run-scoped fight tokens; `0025` adds the authenticated
   writer-lease columns (`writer_session_id` / `writer_token_hash` / `writer_last_activity_at`
   / `active_batch_expires_at`) and clears prior unauthenticated writer ids so the first
   upgraded client must re-acquire control; `0026` adds the Black Market order tables; and
   `0027` adds the pinned raid-replay columns (`config_json` / `ruleset_version`) that make
   server-side raid verification possible. Confirm Wrangler reports no pending migrations
   afterward.
4. Rotate `SESSION_SECRET` with `wrangler secret put SESSION_SECRET`. Never reuse the
   historical value. This invalidates any token copied before the database reset even if
   it is presented to a different environment.
5. Deploy the protocol-v3 Worker with `MIN_PROTOCOL_VERSION=3` and `WRITER_LEASE_MODE=enforce`
   (so un-upgraded clients are rejected on every mutation route, not just `/commands`). Verify
   v2 save, sync, quest-complete, farm-action, and raid-checkpoint routes return
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
- A raid result is derived by server-side replay of the submitted input transcript against the
  pinned enemy config, not asserted by the client. A `/raid/finish` carrying a forged win or a
  `finalTick` beyond elapsed real time is rejected; a stale `rulesetVersion` returns
  `426 stale_ruleset`. The outcome, casualties, and rewards come from the replay.
- Presentation changes generate at most one `/presentation` request per minute and
  authoritative reconciliation generates none.
- Friends, requests, and inbox make no polling requests and refresh only at bootstrap or
  when their menu opens.

## Emergency controls

- Set `MUTATIONS_DISABLED=1` to stop all protocol-v3 gameplay writes while preserving
  read-only bootstrap and investigation access.
- Raise `MIN_PROTOCOL_VERSION` to reject stale `/commands` clients after the replacement
  is deployed. Mutation routes beyond `/commands` (`/raid/*`, `/epic-boss/*`,
  `/black-market/*`, `PUT /presentation|/save`) are instead gated by the writer lease's
  `X-Integrity-Version` / `WRITER_LEASE_MODE=enforce` check; use `MUTATIONS_DISABLED=1` when all
  gameplay mutations must stop regardless of client version.
- Use route/build/account-hash metrics to compare request volume, commands per batch,
  rejection reasons, retry attempts, D1 reads/writes, CPU, payload size, and latency.
  Routine successes are sampled; security failures and errors remain unsampled.

The farm document retains exactly one previous structural version. Never restore that
JSON alone: first use the latest aggregate batch result to reverse its balance, quest,
object, inventory, and zombie effects in the same maintenance operation.

Raid start/finish now hold the writer lease's exclusive active-operation lock, so a command
batch cannot interleave with a raid settlement (`batch_in_progress` / `operation_in_progress`).
Each finish write is additionally guarded by a session-scoped `result_json` CAS. During
investigation or repair, still reconcile balance, gameplay, quest, raid, and roster documents as
one account state, since a partial D1 write at the boundary can leave them briefly inconsistent.
