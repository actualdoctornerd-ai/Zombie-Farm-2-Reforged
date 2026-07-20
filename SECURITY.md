# Security and Anti-Cheat Status

Last reviewed: 2026-07-19

## Reporting a vulnerability

**Do not open a public issue for a security bug.** Use GitHub's private vulnerability
reporting instead: the repository's **Security** tab → **Report a vulnerability**. That
opens a private advisory thread visible only to the maintainer.

In scope: anything that lets a client forge currency, items, zombies, XP, raid or Epic
Boss outcomes, or Black Market orders; anything that reads or writes another player's
account or save; authentication or session bypass; and anything defeating the writer
lease or rate limits.

Out of scope: cheats that only affect a purely offline/local save (there is no server
and no other player to defend against there — the client is the authority by design),
and the known gaps already documented below.

This is a non-commercial hobby project with no bounty and best-effort response times.
Please give a reasonable window before disclosing publicly.

## Scope and status

This document describes the current source tree at gameplay protocol v3 (client integrity
version 4, raid ruleset version 4). It covers authentication, sessions, the exclusive writer
lease, social features, gameplay commands, persistence, economy, farms, quests, raids, Epic
Boss runs, the Black Market, rate limiting, and operational controls.

The configured public Worker responds to health checks and rejects unauthenticated protected
requests, but its deployed commit and database migration state are not exposed publicly. Treat
the production posture as unconfirmed until the rollout checks in
`docs/PROTOCOL_V3_ROLLOUT.md` are performed against the live environment.

## Current conclusion

Protocol v3 is a server-authoritative base for farm, shop, inventory, object, storage, roster,
raid, Epic Boss, Black Market, and social operations. The three anti-cheat gaps that previously
blocked valuable/competitive use have been closed:

1. **Raid outcomes are now server-verified by deterministic replay.** `/raid/finish` no longer
   accepts a client-asserted `win`/`survivors`/`losses`. It replays the pinned combat with the
   submitted input transcript and derives the outcome server-side (`server/src/raidVerifier.ts`
   → `src/raid/replay.ts`). Epic Boss finishes replay the same way.
2. **Raid, Epic Boss, and Black Market mutations are serialized with `/commands`.** All mutation
   routes acquire the same exclusive per-account active-operation lock (`active_batch_id`) through
   the writer lease, so a raid settlement and a command batch can no longer interleave.
3. **The free-plow XP loop is closed.** With a Plowing Monolith placed, plowing is free but grants
   **zero** XP (the repeatable XP moved onto time-gated harvests); without the monolith, each plow
   costs gold. Neither path yields cost-free repeatable XP.

**Remaining posture.** Rewards and progression are now server-derived and catalog-bounded. The
residual risks below are integrity limitations (bot-optimal input, deployment-gated enforcement,
non-deterministic loot rolls, session compromise, offline mutability), not outcome forgery. This
build is a non-commercial fan reimplementation with no real payment rail, so "paid currency" is
notional. `MUTATIONS_DISABLED=1` remains the incident stop for all gameplay writes.

## Controls currently implemented

### Authentication and account isolation

- Google ID tokens are verified for signature, issuer, audience, expiry, and subject.
- Access tokens are signed JWTs backed by revocable D1 session rows.
- Protected operations derive the account from the authenticated session rather than accepting
  a target account ID from the client.
- Logout, logout-all, individual session revocation, session listing, and idle expiry are
  supported.
- The `DEV_AUTH` bypass is gated server-side and production configuration sets it to `0`.

### Exclusive writer lease (single-writer serialization)

- One authenticated device at a time holds the account's writer lease: a device id + session +
  generation + **SHA-256 token hash** row on `account_runtime_v3` (`server/src/v3/writer.ts`,
  migration `0025_writer_lease.sql`).
- Acquiring, recovering, taking over, and releasing the lease all run as compare-and-swap
  updates on `account_version` / `writer_generation`; a takeover revokes the displaced session
  in the same transaction.
- Every mutation route (`/commands`, `/gifts`, `/raid/*`, `/epic-boss/*`, `/black-market/*`,
  and `PUT /presentation|/save`) is fenced by the middleware in `index.ts`. `/commands`
  validates the lease inline; the rest acquire a short-TTL **active-operation** guard
  (`beginOperation`/`endOperation`) that blocks any concurrent command batch or other mutation
  for that account.
- Enforcement is deployment-gated: upgraded clients send `X-Integrity-Version`
  (`CLIENT_INTEGRITY_VERSION = 4`) and are always fenced. When `WRITER_LEASE_MODE=enforce`,
  un-upgraded clients receive `426 client_upgrade_required` on every mutation route; in the
  default observe mode they are allowed through unfenced during rollout.

### Protocol-v3 authoritative state

- `/bootstrap` returns the server gameplay projection, presentation projection, writer state,
  social summary, and resumable raid metadata.
- `/commands` accepts an allowlisted semantic command union. It rejects arbitrary balance/state
  setters and validates catalog keys, ownership, affordability, level gates, capacity, crop
  timing, and coordinates on the server.
- Farm timestamps, random IDs, fertilization, combine output, prices, refunds, XP, level rewards,
  inventory counts, object ownership, storage counts, and roster changes are computed from
  server-held state.
- Command batches use account versions, a single writer device/generation, sequential command
  numbers, a batch ID, and a D1 transaction guard. A batch cannot commit while an
  active-operation lock is held (`batch_in_progress`), and a retry of the latest committed batch
  returns its stored result rather than applying it twice.
- Presentation state is stored separately, versioned independently, allowlisted by top-level
  key, and capped at 128 KiB. Presentation data is not used as gameplay authority.
- Historical v2 save/sync/action/checkpoint routes return `410 update_required` after
  authentication.

### Server-verified raids and Epic Boss runs

- `/raid/start` pins the entire combat configuration from server-owned roster and catalog state
  (`buildPinnedV3Raid`): player/enemy units, boss throw/specials, summon and wall templates,
  grabber, and concentration. The pinned config and `ruleset_version` are stored on the session
  (migrations `0016`, `0017`, `0027`).
- `/raid/finish` requires a matching `rulesetVersion` (`RAID_RULESET_VERSION = 4`; a mismatch
  returns `426 stale_ruleset` and closes the session), rejects a `finalTick` beyond the paced
  elapsed real time (`future_finish`), then **replays** the pinned sim with the submitted input
  transcript and derives `win`/`survivors`/`losses`/`retreated`. Illegal inputs (e.g. an
  un-unlocked ability) are rejected by the replay.
- Casualties are deleted, survivor veterancy is incremented, and rewards (gold, first-clear XP,
  brains, one loot roll) are computed server-side and catalog-bounded. Roster culling is
  server-only: a forged casualty submitted through `/roster/actions` is rejected
  (`server_only_raid_result`).
- Every finish write carries a session-scoped `result_json` CAS guard and checks that exactly
  one row changed; a raced/duplicate finish returns the stored result. Post-battle revival
  restores casualties only from a server-owned snapshot, one brain each, idempotently.
- Epic Boss activation spends brains atomically; start pins the run; finish replays the input
  transcript the same way as raids.

### Black Market (server-authoritative trading)

- Buy/sell-zombie orders escrow the counter-value on the server: a buy order escrows the brain
  price, a sell order escrows the zombie (with its mutation/veterancy snapshot).
- Order creation enforces a per-day order cap, price bounds (`1 … 1,000,000` brains), and a
  request fingerprint so a retried create is idempotent.
- Fulfillment settles both deliveries atomically against authoritative roster/balance state;
  cancellation returns the escrow. Orders cannot be self-fulfilled or double-settled.

### Social and abuse controls

- Friendships require consent; blocks are checked in both directions.
- Brain gifts require friendship, are limited by a database uniqueness constraint, and use a
  unique grant record to prevent duplicate claims.
- All routes have a global body ceiling. Presentation and command batches have tighter semantic
  limits.
- Cloudflare rate-limit bindings protect authentication, read, and write tiers before gameplay
  handlers. Protocol v3 additionally limits `/commands` to 30 requests per account per minute,
  and raid start/finish/revive, Epic Boss, and Black Market writes to 60 per account per minute
  each.
- `MUTATIONS_DISABLED=1` stops `/commands`, `/presentation`, `/raid/*`, `/epic-boss/*`, and
  `/black-market/*` while retaining authenticated read/bootstrap access.

## Known limitations and residual risk

These are the remaining integrity limitations after the three former gaps were closed. None of
them allow a client to forge a raid outcome or set an arbitrary balance.

### Enforcement is deployment-gated

The writer lease only rejects un-upgraded clients when `WRITER_LEASE_MODE=enforce`. In observe
mode a legacy client bypasses fencing, so single-writer serialization is guaranteed only for
upgraded clients. Set `WRITER_LEASE_MODE=enforce` (and confirm the client integrity version)
before treating serialization as guaranteed for every request.

### Bot-optimal input, not forged outcomes

Because the server replays the client's input transcript against the pinned enemies, a modified
client can submit frame-optimal (rather than human) inputs. This yields a bounded skill-ceiling
advantage within legitimate combat, not an impossible result. A bot policy (input plausibility
heuristics, anomaly rates) is out of scope; server authority prevents arbitrary values but does
not by itself enforce "played by a human."

### Non-deterministic loot rolls

Raid brain drops are seeded per session, but the single item-loot pick still uses runtime
randomness (`Math.random`) on the server. It is not client-controlled and stays inside the
enemy-scoped, inventory-deduped catalog, but it is not reproducible for audit/replay. A durable
per-session seed would make settlement fully reconstructable.

### Rejection telemetry is aggregate, not alerting

`/commands` records per-batch rejection counts and the top-level rejection reason in the request
metric, and durable commands plus raid start/finish/revive are written to the v3 audit ledger.
There is still no thresholded alerting on repeated forgery/timing/writer-takeover probes;
failures are observable in logs but not yet triaged automatically.

### Other residual risk

- A compromised active session can act as its account until the session is revoked.
- A custom client can automate legitimate commands up to server limits.
- D1/Worker interruption can withhold or overwrite value at a mutation boundary; idempotency and
  the CAS guards reduce duplicate application but do not repair every partial-write case.
- Local/offline presentation and gameplay can be modified. Protocol v3 does not import that local
  value into a reset online account, but offline play is not cheat-resistant by design.

## Verification status

On 2026-07-19 the following local checks passed on a clean working tree:

```text
npm test                              # client: 274 passed, 1 skipped
cd server && npm run typecheck        # passed
cd server && npm test                 # server: 239 passed
cd server && npm run test:integration # 16 passed
```

Coverage now includes the anti-forgery paths directly: replay determinism and illegal-input
rejection (`src/raid/replay.test.ts`), a forged `/raid/finish` rejected with `bad_final_tick`
(`server/test/integration/raidRewards.spec.ts`), a settlement that ignores a client-claimed
outcome and derives the retreat plus the `stale_ruleset` gate (`server/test/integration/v3.spec.ts`,
`raidGates.spec.ts`), a server-only roster-cull rejection (`roster.spec.ts`), and writer-lease
takeover/replacement (`v3.spec.ts`). Passing tests do not by themselves certify the production
deployment; confirm the live commit and remote D1 schema per the rollout doc.

## Required release gates

The former blocking gates are met in source. Before treating a live deployment as safe for
valuable/competitive features, confirm on the running environment:

1. `WRITER_LEASE_MODE=enforce` and `MIN_PROTOCOL_VERSION=3` are set, and an un-upgraded client is
   actually rejected on every mutation route.
2. The live Worker commit and remote D1 schema match this source (migrations applied through
   `0027_v3_raid_replay.sql`); do not infer production state from source control.
3. `SESSION_SECRET` has been rotated for the current deployment and is not a reused historical
   value.
4. Add thresholded alerting on the existing audit/rejection telemetry (forged-finish attempts,
   `stale_ruleset`/`future_finish` spikes, writer takeovers, command-rate violations).
5. Optionally, replace the runtime loot roll with a durable per-session seed so raid settlement
   is fully reconstructable.

## Incident response

If exploitation is suspected:

1. Set `MUTATIONS_DISABLED=1` and deploy the Worker. Confirm `/commands`, `/presentation`, and the
   raid, Epic Boss, and Black Market mutation routes reject writes.
2. Preserve D1 and Worker-log snapshots before corrective edits.
3. Revoke affected sessions or rotate `SESSION_SECRET` if session compromise is possible; a
   writer takeover also revokes the displaced session.
4. Inspect raid/Epic Boss start/finish audit records, account-version history, command metrics,
   gift grants, Black Market escrow rows, and inventory/roster inconsistencies.
5. Repair related gameplay documents, balance, quest state, roster, and raid/market state
   together; do not restore one JSON document in isolation.
