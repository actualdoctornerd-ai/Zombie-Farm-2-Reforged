# Security and Anti-Cheat Status

Last reviewed: 2026-07-15

## Scope and status

This document describes the current source tree at protocol v3. It covers authentication,
sessions, social features, gameplay commands, persistence, economy, farms, quests, raids,
rate limiting, and operational controls.

The configured public Worker responds to health checks and rejects unauthenticated protected
requests, but its deployed commit and database migration state are not exposed publicly. Treat
the production posture as unconfirmed until the rollout checks in
`docs/PROTOCOL_V3_ROLLOUT.md` are performed against the live environment.

## Current conclusion

Protocol v3 is a strong server-authoritative base for ordinary farm, shop, inventory, object,
storage, roster, and social operations. It is **not currently safe for paid currency,
competitive rankings, trading, PvP, or other rewards whose integrity has real-world value**.

Two known anti-cheat gaps block that use:

1. Raid finish trusts client-asserted victory and casualty data after a minimum elapsed time.
2. Raid mutations do not participate in the account command compare-and-swap boundary, leaving
   cross-route race and stale-write opportunities.
Until those gaps are fixed, raid rewards and competitive progression must be treated as
fun-only. Use `MUTATIONS_DISABLED=1` if active exploitation is observed.

## Controls currently implemented

### Authentication and account isolation

- Google ID tokens are verified for signature, issuer, audience, expiry, and subject.
- Access tokens are signed JWTs backed by revocable D1 session rows.
- Protected operations derive the account from the authenticated session rather than accepting
  a target account ID from the client.
- Logout, logout-all, individual session revocation, session listing, and idle expiry are
  supported.
- The `DEV_AUTH` bypass is gated server-side and production configuration sets it to `0`.

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
  numbers, a batch ID, and a D1 transaction guard. A retry of the latest committed batch returns
  its stored result rather than applying it twice.
- Presentation state is stored separately, versioned independently, allowlisted by top-level
  key, and capped at 128 KiB. Presentation data is not used as gameplay authority.
- Historical v2 save/sync/action/checkpoint routes return `410 update_required` after
  authentication.

### Social and abuse controls

- Friendships require consent; blocks are checked in both directions.
- Brain gifts require friendship, are limited by a database uniqueness constraint, and use a
  unique grant record to prevent duplicate claims.
- All routes have a global body ceiling. Presentation and command batches have tighter semantic
  limits.
- Cloudflare rate-limit bindings protect authentication, read, and write tiers before gameplay
  handlers. Protocol v3 additionally limits accepted semantic commands to 120 per account per
  minute.
- `MUTATIONS_DISABLED=1` stops `/commands`, `/presentation`, `/raid/start`, and `/raid/finish`
  while retaining authenticated read/bootstrap access.

## Known vulnerabilities and limitations

### Critical: client-asserted raid outcomes

Protocol-v3 `/raid/finish` accepts `win`, `survivors`, and `losses` from the client. The server
checks that survivors and losses form a partition of the roster pinned at start and enforces a
15-second earliest finish, but it does not replay combat or prove the result. A modified client
can therefore submit a flawless victory and receive the catalog-bounded gold, first-clear XP,
loot, quest events, and progress for that raid.

The deterministic protocol-v2 verifier remains in the repository but is not used by the active
v3 raid endpoints. Documentation or tests for that verifier must not be interpreted as a v3
security guarantee.

Required fix: derive victory, casualties, veterancy, and rewards from a server simulation or a
server-verified deterministic input transcript. Until then, disable valuable raid rewards or
treat them as noncompetitive.

### High: raids are outside the account mutation transaction

`/commands` serializes state changes through `account_runtime_v3.account_version` and
`active_batch_id`. Raid start and finish instead read and directly overwrite balances, gameplay
JSON, quests, raid state, and roster rows without acquiring that boundary or incrementing the
account version.

Concurrent command and raid requests can therefore produce stale writes, restore or double-use a
consumable, lose a reward, or race a roster lock against sell/combine. Raid start also does not
verify that every conditional roster-lock update changed exactly one row.

Required fix: settle raid start and finish through the same per-account transaction/CAS model as
command batches, including guarded reads, version advancement, and checked lock-update counts.

### Resolved: free-plow XP loop

When a placed `monolithPlowing` object reduces plow cost to zero, plowing now grants zero XP.
Instead, the monolith adds one XP to every time-gated crop, zombie, and fruit-tree harvest. The
offline client, legacy exact-economics path, and protocol-v3 command engine use the same reward
rule. Regression coverage repeatedly removes and re-plows free soil and verifies that XP does not
increase, then verifies the harvest bonus.

### Medium: minimum protocol version does not revoke raid clients

`MIN_PROTOCOL_VERSION` is currently enforced by `/commands`. `/raid/start`, `/raid/finish`, and
`/presentation` do not carry or validate a protocol version. Raising the minimum version blocks
command batches but does not disable a compromised client from calling the raid endpoints.

Use `MUTATIONS_DISABLED=1` as the reliable current incident stop. A future fix should apply a
shared protocol/build gate to every gameplay mutation route.

### Medium: v3 rejection telemetry is incomplete

The v3 audit ledger records selected successful durable commands and zombie creation. Individual
semantic command rejections inside an otherwise successful HTTP batch are returned to the client
but are not emitted as structured security events. The request metric records the batch as HTTP
200, so repeated prerequisite/timing probes may not be distinguishable from routine traffic.

Required fix: aggregate rejection counts and reason codes per batch/account hash, log repeated or
high-signal failures, and alert on raid forgery attempts, command-rate violations, writer
takeovers, and cross-route conflicts without logging raw account identifiers.

### Other residual risk

- A compromised active session can act as its account until the session is revoked.
- A custom client can automate legitimate commands up to server limits. Server authority prevents
  arbitrary values but does not by itself enforce a bot policy.
- Random server rolls currently use runtime randomness rather than a durable deterministic seed;
  this is not client-controlled, but it complicates replay and incident reconstruction.
- D1/Worker interruption can withhold or overwrite value at uncoordinated mutation boundaries.
  Idempotency reduces duplicate application but does not repair every partial or stale-write case.
- Local/offline presentation and gameplay can be modified. Protocol v3 does not import that local
  value into a reset online account, but offline play is not cheat-resistant by design.

## Verification status

On 2026-07-15 the following local checks passed:

```text
npm test                              # client: 126 passed, 1 skipped
cd server && npm run typecheck        # passed
cd server && npm test                 # server: 189 passed
cd server && npm run test:integration # passed
```

The Plowing Monolith reward change was re-verified on 2026-07-19:

```text
npm run build                         # passed
npm test                              # client: 271 passed, 1 skipped
cd server && npm run typecheck        # passed
cd server && npm test                 # server: 239 passed
```

Passing tests do not close the remaining known vulnerabilities above. The current suites do not
establish deterministic v3 raid outcomes or cross-route raid/command serialization.

## Required release gates

Before enabling valuable or competitive features:

1. Replace client-asserted raid outcomes with server-proven outcomes and add forged perfect-win,
   future-finish, malformed-transcript, and duplicate-settlement tests.
2. Put raid start/finish inside the account version/CAS transaction and add adversarial races
   against boost use, purchase, roster sell/combine, gift credit, and command settlement.
3. Enforce protocol/build revocation on every mutation route and verify it against a stale client.
4. Add structured v3 semantic-rejection telemetry and connect alert thresholds.
5. Apply `0020_protocol_v3_reset.sql`, rotate `SESSION_SECRET`, deploy the matching Worker/client,
   and perform the destructive-rollout smoke checks in order.
6. Confirm the live Worker commit/configuration and verify the remote D1 schema rather than
   inferring production state from source control.
7. Keep paid currency, trading, competitive rankings, and PvP disabled until all prior gates pass.

## Incident response

If exploitation is suspected:

1. Set `MUTATIONS_DISABLED=1` and deploy the Worker. Confirm all four v3 mutation endpoints reject
   writes.
2. Preserve D1 and Worker-log snapshots before corrective edits.
3. Revoke affected sessions or rotate `SESSION_SECRET` if session compromise is possible.
4. Inspect raid start/finish audit records, account-version history, command metrics, gift grants,
   and inventory/roster inconsistencies.
5. Repair related gameplay documents, balance, quest state, roster, and raid state together; do
   not restore one JSON document in isolation.
