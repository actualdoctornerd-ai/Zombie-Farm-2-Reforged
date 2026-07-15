# Security and Anti-Cheat Status

Last reviewed: 2026-07-14

## Scope and deployment assumption

This document covers the browser client, cloud saves, Cloudflare Worker/D1 backend,
authentication and sessions, social features, economy, farms, quests, raids, abuse controls,
and expected free-tier load.

The status below describes the current source tree assuming migration `0019_integrity_v2.sql`,
the Worker, and the client are deployed together. Until the remote migration and Worker version
are confirmed, this is the release-candidate posture rather than a claim about production.

## Current conclusion

Integrity v2 changes online play from server-bounded client claims to server-proven value
transitions. Editing a cloud save, replaying a request, calling a reward endpoint directly,
racing purchases, fabricating a roster casualty, or submitting a claimed raid outcome should not
create persistent value.

The remaining work is operational: apply the migration, deploy the Worker/client, run production
smoke tests, confirm replay CPU in the Workers runtime, and connect the documented security events
to alerts. Paid currency, trading, leaderboards, and PvP should remain disabled until those release
gates pass.

Cross-account authorization remains the strongest part of the system and was not redesigned:
the authenticated account determines ownership, friendship requires consent, blocks are honored,
gifts are unique/idempotent, visitor data is projected, and sessions are revocable.

## Controls implemented

### 1. Migration closure and atomic value bounds

- `account_import_state` permanently records inventory, object, roster, quest, balance, and shop
  import decisions. Empty imports close their category too.
- Production config now sets `MIGRATION_CUTOFF_MS="0"`. Online value imports are closed
  immediately; preserving legacy online value is intentionally not a release requirement.
- Legacy completed quest IDs can only be imported during an explicitly enabled recovery window,
  and import pays no reward. Active quest counters are never imported.
- Balance, inventory, object-count, and storage nonnegative constraints are enforced by D1
  triggers as well as application validation.
- Farm, inventory, object, roster, storage, economy, and shop mutations use durable action IDs.
  Shop size/climate commands use account-scoped command receipts and per-attempt nonces. Existing
  action receipts and new command receipts are retained for 45 days; client outbox entries expire
  after 30 days.
- Debits, guarded decrements/deletes, grants, ownership changes, and ledgers are tied to accepted
  server commands. Database constraints prevent distinct racing actions from over-drawing counts
  or balances.
- Level rewards remain recoverable through the server-owned `claimed_level` compare-and-swap.

### 2. Server-owned quest progression

- The Worker loads the full quest catalog: prerequisites, level gates, requirements, subjects,
  targets, and rewards.
- Accepted farm, purchase, combiner, and verified raid commands write trusted gameplay events.
  No public route accepts gameplay events.
- `game_events`, `quest_progress`, and nonce-bearing `quest_event_applications` make application
  idempotent and resumable. Eligibility is evaluated from server state at event time; earlier
  events do not count toward quests that were not yet eligible.
- Subject matching is exact and case-insensitive. Concurrent/retried events cannot double-count.
- Currency, XP, brains, supported boost/item rewards, and level rewards grant from the server
  catalog exactly once. Unsupported zombie reward keys remain no-grant.
- Social, photo, stage-actor, seasonal/epic, and other unsupported event categories are dormant.
- `POST /quest/complete` returns `410 client_upgrade_required`; direct completion claims cannot
  pay. `GET /quest/state` and ordinary command responses return authoritative progress changes.

### 3. Deterministic raid verification

- Browser and Worker use the same pure TypeScript `BattleSim`/raid catalogs at a fixed 50 ms tick.
- Every session pins ruleset version 2, raid definition, server RNG seed, ordered server-owned
  roster snapshot, derived stats/mutations/veterancy/abilities, enemy configuration, and consumed
  voucher/Concentration/Golden Dice.
- Start verifies ownership, uniqueness, raid/level/army gates, current locks, and consumables.
  Participating units are locked against sale, combination, or another raid.
- The client records only focus-bubble taps, ability activations, and retreat, each with monotonic
  sequence and simulation tick. Finish accepts only `sessionId`, `finalTick`, and inputs.
- Sequence, tick, ability, bubble, finish-state, session ownership/expiry, 512-input, and 32 KiB
  transcript constraints are enforced. Invalid finishes close the session, pay nothing, and
  release locks. Duplicate valid finishes return the stored result.
- Outcomes, survivors, casualties, veterancy, cooldown, wins, gold, XP, loot, brain drops, quest
  events, and unlocks are derived server-side. Loot/brain randomness is derived from the pinned
  session seed, never from a finish claim.
- A full synthetic three-minute 16v16 replay measured above the 8 ms CPU target locally, so the
  predetermined checkpoint fallback is enabled. Every 15 simulated seconds the client pauses,
  sends only the new input segment, and the Worker CAS-stores a JSON-safe verifier snapshot while
  enforcing real-time tick pacing. Finish replays only the final segment. The dedicated,
  non-contended checkpoint benchmark passes the 8 ms p95 gate locally; production Workers must
  confirm it before release.
- The historical raid start/finish implementations are not fallbacks: their routes return
  `410 client_upgrade_required` and cannot accept outcome claims.

### 4. Authoritative state separated from cloud saves

- `GET /state` returns authoritative balance/level, inventory, object ownership, roster, farm
  soil/crops, shop ownership, raids, storage, and quests.
- After import closure, cloud saves retain presentation only: layout/positions, camera/UI state,
  tutorial presentation, and other nonvaluable data. Authoritative submitted fields are sanitized
  before storage and cannot become future seeds.
- Load restores presentation first, then overlays `/state`; server values always win. Conflicting
  presentation dirt/hole entries are removed where authoritative soil/crops exist.
- Visitor farms combine server-owned identities/counts with bounded presentation layout, so
  fabricated objects or zombies cannot appear or mutate value.
- Offline play remains local. With imports closed, offline-earned value cannot be promoted to an
  online account.

### 5. Abuse controls and observability

- Farm batches are capped at 64 actions; other value routes are capped at 32. Client outboxes use
  matching chunk sizes.
- Native rate limiting runs before D1. Account command volume warns at 1,000 accepted commands per
  hour and rejects at 2,000/hour or 10,000/day.
- Integrity v2 is advertised by the client and production sets immediate enforcement. Old mutation
  clients receive `426 client_upgrade_required`.
- Structured, PII-free events cover auth failures, rate limits, rejected prerequisites, command
  volume, save conflicts, forged quest completion, invalid raid input, transcript size, replay CPU,
  and cleanup. Aggregate Worker requests/CPU and D1 reads/writes/storage must also be monitored.
- Cleanup retains idempotency longer than client outboxes and removes processed gameplay events,
  verifier checkpoints/locks, expired raid sessions, old ledgers, sessions, and rate buckets.

## Adversarial coverage

The automated suite now covers:

- duplicate and distinct action IDs, including a 50-way barely-affordable shop race;
- empty import permanence and roster reseed rejection;
- nonnegative balances/counts and server-priced farm/inventory/object/roster commands;
- direct quest-completion rejection, trusted-event progression, and retry deduplication;
- stale raid rulesets, foreign/duplicate rosters, roster locks, claimed outcomes, future/reordered
  transcript inputs, invalid-session closure, stored-result retries, checkpoint CAS, and snapshot
  equivalence with uninterrupted replay;
- presentation/authoritative state overlay and existing authentication, consent, gift, block,
  visitor, revocation, and cross-account isolation behavior.

Required release commands:

```text
npm test
npm run build
npm run test:replay-benchmark
cd server
npm run typecheck
npm test
npm run test:integration
```

## Remaining work and release gates

1. Apply all remote migrations, especially `0019_integrity_v2.sql`, before deploying the Worker.
2. Deploy the compatible Worker, then the v2 client. Do not deploy either half alone.
3. Confirm the live Worker version and `integrityVersion: 2`; verify old mutation requests receive
   426 and direct quest/legacy raid claims receive 410.
4. Smoke-test `/state`, farm commands, purchases, quest event completion, raid start/checkpoint/
   finish, duplicate finish, invalid transcript lock release, logout/revocation, gifts, friendship,
   blocks, and visitor projection against remote D1.
5. Run the worst-case replay benchmark in the Workers test runtime and inspect production
   `raid_replay` p95. Keep checkpoint mode enabled unless p95 is demonstrably below 8 ms.
6. Wire alert rules/paging for repeated account integrity failures and aggregate D1 writes, Worker
   requests/errors, and replay CPU. Exercise session revoke and route-disable response procedures.
7. Keep paid currency, trading, competitive rankings, and PvP disabled until all prior gates pass.

## Residual risk

- A player can automate legitimate commands, but cannot exceed server affordability, ownership,
  timing, catalog, quest, raid, and volume rules. Automation may still create gameplay advantage
  within those rules and should be handled through telemetry and account policy.
- A compromised active session can act as its account until revoked. It cannot select another
  account for ownership mutation. Protect `SESSION_SECRET`, monitor token failures, and retain
  logout-all/revocation response capability.
- Client presentation can still be modified locally. This can change appearance/UI but is not
  accepted as online value.
- D1/Worker interruption can delay or, in a narrow multi-step recovery edge, withhold a reward;
  durable IDs and reconciliation prevent retrying that interruption from minting duplicate value.
  Continue fault-injection testing before introducing money-like assets.

## Method for reducing server load

Use this policy to remain compatible with Cloudflare's free tier while preserving integrity:

1. Save locally immediately after meaningful presentation changes.
2. Use a trailing five-second debounce for remote presentation saves so work bursts coalesce.
3. While dirty, force one coalesced upload at least every 30 seconds; a pure debounce can postpone
   forever during continuous play.
4. Flush critical server-command outboxes immediately after purchases, gift claims, raid results,
   rewards, logout, and app backgrounding. Treat `beforeunload` as best effort.
5. Keep at most one save upload and one value-batch flush in flight. If state changes during either,
   mark dirty and send one newer snapshot/batch afterward.
6. Send compact action batches (64 farm, 32 other) rather than one request per tap. Retry with the
   same action IDs; never generate new IDs for a transport retry.
7. Keep ordinary raids to start plus one checkpoint per 15 simulated seconds plus finish. A full
   three-minute raid therefore has at most 12 checkpoint requests/writes, but most raids end sooner.
8. Persist session `last_used_at` only every 10–30 minutes and use native rate limiting for ordinary
   throttles; reserve D1 writes for authoritative state and uniqueness.
9. Retain the 1,000/hour warning and 2,000/hour/10,000-day rejection thresholds, and lower them if
   measured normal play is substantially below those values.
10. Track requests, replay CPU, D1 rows read/written, DB size, accepted commands per player-hour,
    checkpoint count per raid, and remote saves per player-hour. Capacity estimates are not a
    substitute for telemetry.

At 100 daily players each playing one continuous hour, a continuously dirty 30-second maximum is
about 12,000 presentation saves/day before critical-boundary saves. Authoritative commands add
their own writes; a three-minute raid adds up to roughly 14 Worker requests (start, 12 checkpoints,
finish). Five-second debounce normally reduces save traffic well below the maximum. A single bot
still must be rejected before D1 to avoid exhausting shared free-tier quotas, which is why native
limits and account command ceilings remain mandatory even after cheat routes are closed.
