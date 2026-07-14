# Security and Anti-Cheat Status

Last reviewed: 2026-07-13

## Scope and deployment assumption

This document covers the browser client, cloud save system, Cloudflare Worker/D1 backend,
Google authentication, sessions, friends, gifts, farm visits, economy, raids, build output,
and operational abuse controls.

This status assumes the current backend-integrity working tree, schema changes, client changes,
and configuration are migrated and deployed together. A partial deployment, especially one
without the D1 migrations, must not be treated as having these protections.

## Current assessment

The account boundary is now substantially stronger. The server derives save ownership from
the authenticated account, sessions can be revoked, friendships require consent, friend codes
are longer and rotatable, gifts have database uniqueness and idempotency controls, save writes
use an atomic revision compare-and-swap, and uploaded saves are structurally bounded.

The primary remaining security weakness is gameplay authority. The browser still authors most
progression and uploads the resulting snapshot. A modified client can therefore manipulate its
own gold, brains, XP, inventory, zombies, crops, timers, unlocks, raid history, cooldowns, and
rewards within the generous structural bounds accepted by the server.

Current practical conclusions:

- Directly overwriting another account's save remains unlikely without stealing a valid session.
- Forcing another player into a friendship has been addressed by request/accept consent.
- Friend-code enumeration has been materially reduced by longer codes, generic add responses,
  rotation, and rate limiting.
- Malformed farms are less capable of hanging visitors because saves and dimensions are bounded
  at both the API and visitor hydration boundary.
- Gift races and duplicate claims are materially better controlled, but brains are not yet a
  fully server-owned balance and deferred grant reconciliation remains necessary.
- Cheating on one's own progression and raid outcomes remains easy because those systems are
  still client-authoritative.
- A valid abusive client can still consume free-tier capacity, particularly because session
  activity and D1-backed rate counters amplify writes.

The current model is acceptable for an honor-system, noncompetitive preview. It is not yet a
safe foundation for paid currency, trading, leaderboards, PvP, or any feature where illegitimate
progress materially affects another player.

## Controls now present

- Google ID tokens are checked against Google's signing keys, issuer, and configured audience.
- API access tokens are signed, expire after seven days, identify a server-side session, and are
  rejected after that session is revoked.
- Logout and account-wide logout revoke server sessions.
- Save ownership is always derived from the authenticated session.
- Save uploads have a 512 KiB limit, runtime structure and numeric bounds, collection caps,
  duplicate-ID checks, and bounded farm dimensions.
- Save revisions are committed with a database compare-and-swap, including safe first-save
  creation.
- Friendship uses pending requests and explicit acceptance; remove, reject, block, and friend-code
  rotation routes exist.
- Friend addition returns a generic result to reduce friend-code validity probing.
- Friend, request, and gift collections have caps or bounded responses.
- Reading another farm requires an accepted friendship and returns a projected save.
- Visitor hydration independently checks dimensions before allocating farm state.
- The daily sender/recipient gift rule is enforced by a unique database constraint.
- Gift grants are keyed uniquely by source gift ID, preventing duplicate credit from retries or
  concurrent claims.
- Sensitive routes have per-IP or per-account fixed-window limits.
- SQL statements use bound parameters.
- Production development authentication remains disabled by configuration.

These controls protect identity, ownership, boundedness, and common races. They do not prove
that a structurally valid progression snapshot was legitimately earned.

## Current risk summary

| Scenario | Current likelihood | Impact |
| --- | --- | --- |
| Change own currency, XP, inventory, zombies, or farm | Certain with a modified client | High |
| Forge raid results, loot, casualties, or cooldowns | Certain with a modified client | High |
| Upload a fabricated but structurally bounded farm | High | High |
| Directly write another account's save | Low without session theft | Critical |
| Force friendship without consent | Low after full deployment | Medium |
| Enumerate accounts through friend codes | Low after full deployment | Medium |
| Duplicate a daily gift through concurrent sends | Low after full deployment | Medium |
| Double-claim one gift | Low; unique grant is the serialization point | Medium-high |
| Lose/defer a gift credit during extreme save churn | Plausible until reconciliation exists | Medium |
| Hang a visitor with extreme farm data | Low after validation; requires adversarial testing | Medium-high |
| Use a stolen live session | Low-medium; revocable but still a bearer credential | Critical |
| Exhaust free-tier capacity with a valid abusive client | Plausible | High availability impact |

## Remaining work: priority order

### 1. Make valuable balances and progression server-owned

Move gold, brains, XP, inventory, boosts, unique items, zombie ownership, permanent casualties,
raid wins, cooldowns, loot, and unlocks out of the opaque client save. The server should derive
or validate every change to these values. The client may display predicted results, but it must
not be able to commit arbitrary balances.

Do this before adding paid currency, trading, competitive rankings, or rewards that influence
other accounts.

**Progress:** gold/brains/XP (P4), crop economics (P6/P7), raid rewards + cooldown + voucher (P10/P11),
consumable boosts (P11), **zombie ownership + selling** (P12), the **Garden-zombie fertilize roll**
(P13 — server-owned, so a client can't force the 2× harvest), and the **Zombie Pot combine result**
(P14 — the server validates the result is one of the two consumed parents, closing the fabricate-an-
expensive-result path) are now server-owned. **farm size** and **ground/climate skins**
(P16 — server-owned scalar + owned-set, exact-price, seeded from the save **once at first
initialization** and reconciled thereafter — re-posting owned state can't re-grant it) are now
server-owned too. **Remaining under this item:** veterancy in the shadow (cosmetic — sell value is
key-based), the combine TIMER (instant-combine has no gold value), **placeable objects** (their
ownership is farm-layout placement, which can't reconcile like a scalar/set — a one-time, largely
cosmetic gap; functional monoliths are QoL/time, not gold), and received (non-boost) loot items are
still client-authored; and the roster shadow isn't yet used to validate raid deployments (that pairs
with item 3's input replay).

### 2. Replace arbitrary farm snapshots with validated action batches

Do not make one server request for every tap. Queue ordered farm actions such as planting,
harvesting, purchasing, placing, moving, combining, and consuming an item. Submit compact batches
at short intervals and important boundaries. The server validates ownership, cost, prerequisites,
legal transitions, and the expected starting revision, then commits one canonical update.

Crop, construction, combination, and cooldown times must be based on server time. Client clocks
and client-authored timestamps must not decide whether rewards are ready.

Presentation-only placement can remain snapshot-like if dimensions, ownership, counts, and legal
transitions are checked.

### 3. Implement interactive raid authority

Raid verification must reproduce the raid the player actually played; an automatic runner cannot
predict an outcome when targeting, ability timing, concentration interactions, retreat, and future
player controls materially affect combat.

Recommended flow:

1. `POST /raid/start` validates the server-owned roster, deployed order, boosts, vouchers,
   cooldown, and launch requirements.
2. The server atomically consumes required items and creates a unique, expiring raid session with
   a pinned ruleset, roster snapshot, and server RNG seed.
3. The client records every outcome-relevant input in order with a simulation tick or bounded
   timestamp.
4. `POST /raid/finish` submits the raid session ID and input transcript, not an authoritative win
   flag or reward total.
5. The server deterministically replays the same rules, validates that every action was legal at
   that point, and derives the result.
6. Rewards, casualties, progress, unlocks, and cooldowns are committed once using the raid session
   ID as an idempotency key.

If exact replay is not ready, use a signed start ticket plus invariant and plausibility checks as
a transitional measure. Treat that as cheat resistance, not proof. Benchmark replay against the
Workers Free 10 ms CPU-per-invocation ceiling before selecting the production design.

**Transitional layer implemented (server-authoritative rewards):** `POST /raid/start` now pins the
raid being fought on its one-use session (`raid_sessions.raid_id`); `POST /raid/finish` computes the
base win gold + first-clear XP from a SERVER catalog (`raidCatalog.ts`, mirroring raids.json +
`winGold`), credits them to the balance ledger idempotently (keyed by session id), and grants
first-clear XP at most once per (account, raid) via `raid_clears`. The client sends `win` +
`survivalFrac` (bounded/clamped) but no reward total, and reconciles the returned balance
(`EconomyClient.submitRaid`, crash-safe outbox). So reward *amounts* can no longer be fabricated —
a claimed win yields at most that raid's real ceiling, still cooldown-gated. **Not yet done (the
remaining gap):** the server does not replay inputs, so a modified client can still assert a WIN it
didn't earn (bounded to the catalog reward). Steps 1 (roster/order/boost validation), 3, and 5
(deterministic input replay) remain; `raid_sessions` is the seam they hang on. Loot items, bonus
gold, and brain drops also stay on the bounded economy/inventory path pending server-owned inventory.

**Update:** the raid-cooldown **voucher** is now server-owned and consumed on `/raid/start` (see the
server-owned boost inventory below), so a modified client can no longer bypass the cooldown for
free — the trusted-`bypass` residual is closed.

### 4. Finish the server-owned gift and grant ledger

The unique grant prevents double-credit, but a gift still ultimately changes `player.brains` inside
the client-shaped save. Make the ledger or a server balance row authoritative. Add a reconciliation
job or read-time repair path for grants that were recorded but could not be projected into the save
after repeated revision conflicts. Ensure a claim cannot be reported as complete while its durable
balance effect remains indefinitely unapplied.

All future purchases, refunds, promotions, and administrative grants should use unique ledger
events and idempotency keys.

### 5. Remove production mutation and debugging surfaces

Compile the invisible developer menu and `window.ZF` mutation helpers out of production builds.
Keep development authentication and mutation helpers behind both build-time and server-side
controls. This reduces casual cheating and accidental misuse, although it is not a substitute for
server authority.

### 6. Complete browser and session hardening

Add a restrictive Content Security Policy compatible with Google sign-in. Replace runtime-data
`innerHTML` paths with DOM construction and `textContent`. Provide a user-facing session/device
list and individual session removal if multiple devices are supported. Define session retention,
idle expiry, cleanup, credential rotation, and account-recovery procedures.

Do not update `sessions.last_used_at` on every authenticated request; throttle it to once every
10-30 minutes per session.

### 7. Make abuse prevention comprehensive and cost-efficient

Cover authenticated reads, polling, save downloads, friend-farm reads, session refresh, and all
mutations--not only the currently sensitive write routes. Reject abusive traffic before performing
avoidable D1 work.

Move ordinary request throttles from D1 counters to the Cloudflare Workers Rate Limiting binding
where eventual consistency is acceptable. Keep database uniqueness and conditional writes for
security invariants such as gift uniqueness, claims, purchases, and raid completion; rate limiting
must never be the sole correctness control.

Apply payload-size limits before parsing, cap response sizes, and enforce sensible account, IP,
route, and global ceilings. One authenticated bot must not be able to consume the entire free-tier
database allowance through otherwise harmless reads.

### 8. Formalize migrations, cleanup, and deployment verification

Turn the commented schema migration instructions into versioned, repeatable migrations. Test an
upgrade from the real production schema as well as a fresh database. Add cleanup for expired or
revoked sessions, old rate-limit buckets, old pending requests, expired raid sessions, and retained
operational events.

After deployment, run smoke checks for authentication, logout/revocation, save creation and CAS
conflicts, request/accept/remove/block, gift send/claim/idempotency, visitor projection, and rate
limits. A local implementation is not a production control until its schema and Worker version are
confirmed live together.

### 9. Add adversarial integration, concurrency, and replay tests

Test unauthorized and cross-account access, first-save races, concurrent save writes, simultaneous
gift sends and claims, grant reconciliation, friendship races, blocks, enumeration behavior,
malformed and oversized JSON, collection boundaries, duplicate IDs, malicious visitor data,
session expiry/revocation, and cleanup.

For raids, test altered rosters, changed seeds, illegal timing, reordered or duplicated actions,
stale rulesets, transcript truncation, duplicate completion, disconnect/retry behavior, reward
idempotency, and worst-case replay CPU. Fuzz validators and replay inputs rather than relying only
on expected examples.

### 10. Add security and capacity observability with response procedures

**Largely addressed.** The Worker emits structured, PII-free `slog` lines of the shape
`{ sec: <event>, lvl: info|warn|alert, … }` for authentication failures (`auth_token_invalid`,
`auth_denied`), the dev-bypass probe (`dev_auth_rejected`), rate-limit rejections (`rate_limited`),
save-write conflicts (`save_conflict`), invalid/oversized payloads (`save_invalid`, `save_too_large`),
economy and farm rejections (`economy_rejected`, `farm_rejected`), deferred/reconciled grants
(`gift_credit_deferred`, `grants_reconciled`), revocations (`logout_all`), and the nightly cron
(`cleanup`). The `lvl` field lets an alert rule filter cheaply by severity.

Per-event meaning, per-account and global alert thresholds, the capacity signals to track (D1 rows
written/read, DB size, Worker requests/CPU/error rate), and the response procedures — revoke a
session, sign out everywhere, rotate the session secret, disable a route, reconcile grants,
quarantine a save, point-in-time restore (D1 Time Travel), and quota-pressure load-shedding — are
documented in [`server/RUNBOOK.md`](server/RUNBOOK.md).

Remaining: alert *rules* are documented but not yet wired to a paging channel; and the anti-cheat
signals that don’t exist yet (impossible progression, raid validation failures) arrive with items
1–3. `duplicate completions` are already prevented structurally (idempotent raid finish).

## Acceptance boundary

The system should not be described as meaningfully anti-cheat until items 1-4 are complete. Items
5-10 reduce exploitability, operational risk, and recovery time, but they cannot compensate for a
client that is still allowed to author valuable outcomes.

For cross-account safety, the minimum production acceptance checks are:

- no route can select a target account for save mutation;
- social relationships require consent and honor blocks;
- every cross-account grant is unique, atomic, bounded, and auditable;
- visitor data is projected and bounded;
- stolen sessions can be revoked;
- abusive traffic is rejected before it can exhaust shared persistence capacity.

## Method for reducing server load

Cloudflare's Workers Free plan currently allows 100,000 Worker requests per day and 10 ms of CPU
per invocation. D1 Free allows 5 million rows read and 100,000 rows written per day. Static Pages
assets do not consume Worker requests. The daily limits reset at 00:00 UTC. See
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/).

The present backend amplifies writes: every authenticated call updates session activity, and a
rate-limited save also writes its rate counter before writing the save. A typical remote save can
therefore cost approximately one Worker request and three D1 row writes. D1 writes are likely to
be the first free-tier constraint.

Use the following save policy:

1. Persist locally immediately after meaningful state changes so a browser crash does not depend
   on a recent network upload.
2. Use a trailing five-second debounce for remote saves. A burst of planting, harvesting, moving,
   or purchasing should become one upload after five seconds of inactivity.
3. Add a 30-second maximum dirty interval. A plain debounce can postpone saving forever during
   continuous play; while dirty, force one coalesced upload at least every 30 seconds.
4. Flush immediately after critical boundaries such as a server-confirmed purchase, gift claim,
   raid completion, reward grant, logout, and app backgrounding. Treat `beforeunload` as best effort,
   not the only durability mechanism.
5. Maintain at most one save upload in flight. If changes occur during it, mark the state dirty and
   send one newer snapshot or action batch afterward instead of starting parallel uploads.
6. Keep an idempotent local outbox for failed batches and retry with revision/idempotency keys after
   reconnecting.
7. Once farm actions become authoritative, send compact ordered action batches rather than one API
   request per tap. Commit one canonical state change per accepted batch.
8. Keep raids to approximately two normal API calls: start and finish. Submit the player's compact
   input transcript at finish and perform one atomic result commit.
9. Throttle session `last_used_at` persistence to once every 10-30 minutes. Authentication still
   checks the live session, but most requests no longer generate a session write.
10. Use Cloudflare's Rate Limiting binding for ordinary request throttles instead of writing a D1
    counter on every request. Retain D1 constraints only for authoritative uniqueness and ledger
    invariants.

For 100 daily players each playing one continuous hour, a 30-second maximum produces at most about
120 periodic remote saves per player, or 12,000 saves per day, before critical-boundary saves. With
the current approximately three-write save path, that is about 36,000 D1 writes plus login, social,
and other overhead--roughly 40,000-50,000 writes on a busy day. With session writes throttled and
request counters removed from D1, the same periodic saves are closer to 12,000 save-row writes plus
modest overhead.

Real use should normally be lower because the five-second debounce coalesces bursts and the maximum
timer runs only while state is dirty. Measure actual remote saves per player-hour and D1 query
metadata before treating these estimates as capacity guarantees.

This optimization does not replace abuse controls. Without comprehensive limits, a single valid
automated client can deliberately generate enough requests or D1 writes to exhaust a free daily
allowance even when legitimate player traffic is small.
