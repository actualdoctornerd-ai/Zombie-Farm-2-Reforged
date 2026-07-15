# Security and Anti-Cheat Status

Last reviewed: 2026-07-14

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

**Update (own-account containment shipped — Phase 0 — plus Phase C level/quest authority; raids
excluded).** The trivial value-minting paths are closed and covered by tests: `/economy/apply` is
spend-only (positive deltas rejected `earn_forbidden`); the public `grant` actions were removed
from both `/inventory/actions` and `/roster/actions` (no free boost/voucher, no mint-a-zombie-to-
sell); and **every** client-declared seed — the `*/sync` endpoints AND the gift-claim/grant balance
seed — is gated by a creation-time cutoff (`MIGRATION_CUTOFF_MS`) and made once-per-empty-subsystem,
so a new account can no longer self-declare a starting balance/roster/farm and receives fixed server
defaults. (The gift-claim seed path was a residual of the first pass, now closed via `balanceSeed`.)

**Phase C (partial) is now in too:** level-up rewards are fully server-authoritative — level is
derived from server-owned `balances.xp` (`levels.ts`) and the +1-brain-per-level reward is granted
exactly once per level via `claimed_level`, needing no client input. Quest rewards have a bounded-
once server home: `POST /quest/complete` grants the quest's reward from a server catalog
(`questCatalog.ts`) at most once per `(account, quest)`, credits currency + any level-up it triggers,
and the client now routes completion through it. Quest *item/zombie* rewards are recorded-only, which
turns out to match the client: type-5's zombie key (`ZombieActorRegularData`) isn't a zombies.json key
at all, so the client's spawn already resolves to nothing (missing content, not a missing grant), and
type-3 items land in the save's `received` list whose claim path goes through the inventory `grant`
the server rejects — so both are fail-closed today. Quest requirement *proof* is still client-asserted
(bounded-once, not proven-earned — same posture as raid wins).

**Phase D — placeable objects AND the zombie field are now server-owned.** (1) Object OWNERSHIP is
a server-authoritative count per key (`objectCatalog.ts` mirrors placeables.json): `POST
/object/actions` prices a `buy` (debit exact cost + grant buyXp) and a `refund` (credit
floor(cost*0.2)) — the refund only fires for an object the server records you owning, so a client
can't fabricate a placeable or refund one it never bought. Free/promo (cost 0) objects and the
dynamic-priced Zombie Pot stay on the client path. (2) The ZOMBIE FIELD is server-owned: a zombie is
grown from a zombie crop, and `/farm/actions` now prices the plant (gold OR brains, `zombieCropCatalog.ts`),
gates the harvest by real server grow time, and grants the resulting VERIFIED unit into the roster —
so a client can no longer fast-grow zombies or spawn an unearned (then sellable) unit. Both seed once
(cutoff-gated) and are wired through the client (object buy/sellObject; zombie-crop plant/harvest with
a suppressed local grant). Placement/position stays cosmetic client-side layout. (3) GIFT VOUCHERS
redeem server-side: a `use` of a gift boost consumes the voucher and grants the zombie the catalog
(not the client) names, in one atomic action, enforcing "1 per farm" — previously the client spawned
that zombie locally and the server never saw it, so it was an unsellable phantom. (4) OBJECT UPGRADES
(the in-place shed upgrade) go through `/object/actions` `upgrade`: it charges the new object's full
catalog price and consumes the old one with no refund, so it's strictly worse than refund-then-buy and
can't launder value whatever key pair a client names. A free `from` (the starter Shabby Shed, cost 0)
needs no count — free objects are deliberately never server-tracked.

**Phase E — the farm's geometry, soil, and level gates are now server-owned.** (1) PLOWED SOIL is real
server state (`plowed_soil`, migration 0015): a `plow` farm action debits the server's plow cost (0 only
while the account's server-owned object counts include a Plowing Monolith) + grants 1 xp and records the
soil, and a plant now REQUIRES it. Previously `plow` was only a ledger reason — the till was a local
spend, so online it cost nothing and a plant never checked for soil at all. The plant consumes the soil,
so the two tables stay disjoint and re-planting needs a fresh till; re-plowing plowed soil is rejected,
so a till can't be farmed for xp. (2) The OWNED FARM bounds plant/plow: `plotWithin` mirrors
`Field.fits()` against `farm_state.size`, replacing a flat 128-coord structural cap that let a client
farm land it never bought. (3) LEVEL GATES are enforced from server-owned xp (`levelForXp`) on crop
plants, zombie-crop plants, boost buys, and object buys/upgrades — a level-1 client can no longer buy a
level-25 gift voucher. Catalog level `-1` means "no requirement" (59 seasonal placeables), matching the
client's own check. A migrating save's already-plowed soil imports ONCE via `POST /farm/sync`, guarded by
`farm_state.soil_seeded` rather than seed-once-if-empty — an empty soil set is a legitimate steady state,
so an if-empty guard would let a client re-import free soil (plow cost + 1 xp each) forever.

**Raids T1 — the gates that don't need replay.** `/raid/start` now enforces the raid's UNLOCK LEVEL
against server-owned xp (`raidUnlocked` mirrors `RaidCatalog.isUnlocked`). This was the worst remaining
hole: a level-1 account could invade raid 9 (5000+1200 gold AND 5500 first-clear XP) and, since XP pays
level-up brains, convert a fabricated win into premium currency. It also reserves ONE open raid per
account atomically (the cooldown only advances at finish, so a client could otherwise bank session ids),
reaping expired sessions first so an abandoned raid can't lock the account out; enforces session expiry
INSIDE the finish CAS (`expires_at` was previously written but only read by the cron purge); and refunds
a bypass voucher if the reserve loses. Raid PROGRESS is server-owned (`raid_clears.wins`, imported once
via `/raid/sync`): without the import a migrating veteran looked like they'd cleared nothing and could
re-earn every first-clear XP award (~21k XP), and wins drive zombie ability unlocks, so they must not
live in the editable save.

**Raids T2 — server-rolled loot.** A drop is real value, so the SERVER rolls it (`loot.ts`), pinning the
Golden Dice at `/raid/start` so the luck bracket isn't a client claim. `loot.ts` IMPORTS `rollLootTier`
from the client source rather than copying it, so the thresholds recovered from the binary have exactly
one definition. `item_storage` (0018) makes the Received bucket + the shed real server state — loot needs
somewhere to land, and the roll's unique/limit filters need to answer "do you already own one?".
Claim/store/retrieve are server MOVES (`/storage/actions`), which also fixes a live bug: claiming a
Received boost used to route through the removed inventory `grant`, so online it deleted the item and
granted nothing. The BRAIN drop stays DEFERRED and documented (not silently omitted) — `win` is still
client-asserted and buying a ticket to raid again is intended play, so raids are deliberately not
rate-capped; a server-rolled brain drop would therefore make premium currency unlimited. It returns when
a win is verifiable. It didn't work online before either, so this is no regression.

The remaining security weakness is the rest of gameplay authority. The browser still authors progression
the server does not yet own — quest requirement proof, tutorial rewards, raid win/loss (bounded to the
raid's real catalog reward), and unit combat state (veterancy/casualties/mutation — a raid outcome) — and
uploads a save blob those systems still read. A modified client can still manipulate those within the
structural bounds the server accepts; it just can no longer directly mint currency, items, units by ANY
route (bought, combined, grown, or redeemed), a starting balance, level-up brains, object refunds, a free
object upgrade, free soil, land it never bought, content above its level, raid loot, or raid progress.

### Phase F (save split) — NOT done, and why

`PUT /save` still stores the client's authoritative fields verbatim. That is a parallel, writable source
of truth: harmless only while nothing reads it back. Making the blob cosmetic is the last structural
step, and it is NOT a matter of deleting fields on write. Three concrete hazards, found while attempting
it, are why it is staged rather than shipped:

1. **`GET /save` seeds the balance FROM the stored blob** (`balanceSeed(env, id, save?.player)`), and
   `/raid/sync` seeds wins from what the client restored out of it. Stripping those fields before an
   account has been seeded makes a migrating player seed to STARTER_BALANCE and lose their raid wins.
   Any strip must therefore be ordered against the per-account `*_seeded` flags, not applied blindly.
2. **Layout lives only in the blob.** `objects`, `ownedZombies`, and `farm.plots` carry POSITIONS; the
   server owns only counts/identity. Stripping them wipes the farm. The client needs a merge (server
   truth + blob layout) on restore before those fields can go.
3. **Some fields are half-owned.** `quests` holds both the completed set (server-owned) and live
   per-requirement counters (client). It can't be dropped wholesale.

What IS done: every field Phase F would strip now has server-owned state behind it, and the two that a
client actively re-reads on load (raid progress, item storage) are already adopted from the server. The
rest of Phase F is client-side work — the restore merge — plus the seeding order in (1).

Known pre-existing gap (NOT introduced by Phase E): planted crops themselves have no seed path, so a
crop planted before the farm became server-owned lives only in the blob and its harvest is rejected as
`nothing_planted`. Fail-closed (no mint), and folded into the Phase F save split.

Current practical conclusions:

- Directly overwriting another account's save remains unlikely without stealing a valid session.
- Forcing another player into a friendship has been addressed by request/accept consent.
- Friend-code enumeration has been materially reduced by longer codes, generic add responses,
  rotation, and rate limiting.
- Malformed farms are less capable of hanging visitors because saves and dimensions are bounded
  at both the API and visitor hydration boundary.
- Gift races and duplicate claims are materially better controlled, and gift brains settle into
  the server-owned balance. The remaining problem is that other public grant paths do not prove
  where a reward came from.
- Cheating on one's own progression and raid outcomes remains easy because those systems are
  still client-authoritative.
- A valid abusive client can still consume free-tier capacity through large action batches and
  distributed traffic, although session touches are throttled and production request counters no
  longer write to D1.

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
| Mint currency via a public positive `/economy/apply` delta | **Closed — endpoint is spend-only (earn_forbidden)** | High |
| Fabricate boosts/vouchers via public inventory `grant` | **Closed — `grant` removed; boosts enter only via priced buy** | High |
| Launder gold via roster `grant` → `sell` | **Closed — `grant` removed; only owned (seeded/combined) units sell** | High |
| Self-seed a new account's balance/roster/boosts/farm | **Closed — new/post-cutoff accounts get fixed server defaults** | High |
| Re-inject units via repeated `/roster/sync` | **Closed — seeding is once-per-empty-subsystem, cutoff-gated** | High |
| Change own XP/level/quest/tutorial rewards in the save | High (server has no quest/level authority yet; rewards just don't persist online) | Medium |
| Plant beyond owned farm size / on un-plowed soil | High (coord only bounded to 128; plot/soil ownership not yet server-checked) | Low-medium |
| Forge raid win (bounded to the raid's real catalog reward) | Certain with a modified client (deferred — raid replay) | Medium |
| Upload a fabricated but structurally bounded farm | High (progression not yet split from the presentation save) | Medium |
| Directly write another account's save | Low without session theft | Critical |
| Force friendship without consent | Low after full deployment | Medium |
| Enumerate accounts through friend codes | Low after full deployment | Medium |
| Duplicate a daily gift through concurrent sends | Low after full deployment | Medium |
| Double-claim one gift | Low; unique grant is the serialization point | Medium-high |
| Hang a visitor with extreme farm data | Low after validation; requires adversarial testing | Medium-high |
| Use a stolen live session | Low-medium; revocable but still a bearer credential | Critical |
| Exhaust free-tier capacity with a valid abusive client | Plausible | High availability impact |

## Own-account manipulation prevention plan

### Security objective

The client may report **intent and player input**, but it must never be allowed to author value.
Every valuable state transition must be derived by the server from canonical prior state, a
server catalog, server time, and a unique trusted source event.

The target rule is:

> No public request may directly specify a positive currency delta, reward amount, unrestricted
> grant, owned item, owned zombie, completed raid, completed quest, or authoritative timer result.

Client prediction is still desirable for responsive play. It is only a temporary display layer;
the server response is the committed result.

### Current concerns and danger points

| # | Danger point | What a modified client can do now | Required correction |
| --- | --- | --- | --- |
| 1 | Raw economy earns | Repeatedly submit positive `/economy/apply` events with fresh IDs. Per-event caps do not prevent unlimited accumulation. | Remove public positive deltas. Replace them with explicit server-priced commands and internal-only credit functions. |
| 2 | First-use seeding | Initialize a new balance, boost inventory, roster, farm size, or climate set from an already-edited client state. | New accounts receive server defaults. Existing-account import must be a one-time, cutoff-gated migration from a server-captured snapshot. |
| 3 | Inventory grants | Submit `inventory grant` for arbitrary known boosts, including raid vouchers. | Remove `grant` from the public inventory action union. Only trusted server subsystems may issue inventory grants with a unique source ID. |
| 4 | Roster grants and sync | Add arbitrary catalog zombies with new unit IDs, then sell them for server-authoritative gold. Repeated roster sync is effectively another grant path. | Remove public roster grants and make roster initialization truly one-time. Zombie creation must name a verified source such as crop harvest, quest reward, purchase, or combine job. |
| 5 | Client-asserted raid outcome | Report `win=true` and maximum survival without proving the fight, roster, unlock, or legal inputs. | Verify the interactive input transcript or advance an authoritative raid state machine. The server derives outcome, casualties, loot, and reward. |
| 6 | Raid-session lifecycle | Open many sessions before any finish starts the cooldown; settle expired sessions because expiry is not checked at finish. | Atomically reserve one active raid per account, enforce expiry in the finish write, and make start/finish/cooldown one consistent state machine. |
| 7 | Partial farm authority | Plant anywhere inside the global 128-coordinate cap without proving that the coordinate is within the owned farm, plowed, or otherwise usable. | Maintain server plot/soil state and validate coordinates against server-owned farm size and legal plot transitions. |
| 8 | Client quest, loot, object, and refund sources | Complete or fabricate local quest/raid history, received items, placed objects, unlocks, and object refunds, then route some value through generic economy/grant paths. | Give each system an explicit server command and server-owned source record. No generic fallback may award value. |
| 9 | Opaque cloud save | Upload a structurally valid snapshot containing fabricated progression. Even when a newer server table overrides some fields, other systems may still read the blob. | Split authoritative progression from cosmetic/layout persistence. Ignore or reject authoritative fields on `PUT /save`; compose them from server tables on read. |
| 10 | Read-check-write races | Concurrent requests can both pass an affordability, idempotency, or cooldown read before either commits. Some paths update a balance even when an `INSERT OR IGNORE` did not win. | Use conditional writes/transactions whose changed-row count decides whether value moves. Add database constraints and adversarial concurrency tests. |
| 11 | Batch and quota amplification | One allowed request can contain up to 256 value-changing actions; distributed clients can exceed location-scoped throttles. | Set smaller per-command batch limits, per-account daily mutation budgets, and global load-shedding thresholds in addition to request-rate limits. |

### Phase 0: contain the currently trivial paths

Ship these changes first because they remove the browser-Network-tab exploits without waiting for
the full farm or raid rebuild.

**Status: shipped (raids excluded), tested (server unit + integration suites green).** Items 1–5
are done; the remainder are as noted.

1. **DONE.** `/economy/apply` is spend-only — any positive delta is rejected `earn_forbidden`
   (`server/src/economy.ts`), regardless of reason or size; earn reasons removed.
2. **DONE.** Public `grant` removed from `/inventory/actions` and `/roster/actions`
   (`server/src/inventory.ts`, `server/src/roster.ts`, and the `db.ts` handlers). Boosts enter
   only via a priced `buy`; units only via the migration seed or the validated combine.
3. **DONE.** `/roster/sync` (and inventory/shop/economy sync) seed once-per-empty-subsystem and
   only for a migration-eligible account — repeated sync can no longer inject additional units.
4. **DONE.** New accounts (and any account once import is closed) receive fixed server defaults
   (`STARTER_BALANCE`, base farm, empty roster/boosts). A client cannot self-declare a start state.
5. **DONE (config-based, no per-account record).** A creation-time cutoff `MIGRATION_CUTOFF_MS`
   gates import: only accounts created before it may import, once per subsystem (enforced by the
   subsystem being empty). This was chosen over an `eligible_at`/`completed_at` table because
   "row/collection already exists" is a sufficient once-guard and needs no new schema. If a
   per-account audit trail of *what* was imported is later required, add the record then.
6. **Not done.** Audit already-seeded accounts for impossible balances/inventory/roster/farm.
   (Legacy accounts seeded before this change keep their values; their rows are preserved.)
7–8. **Deferred (raids, out of current scope).** One-open-session, expiry-at-finish, and the
   win-verification ceiling remain as written.
9. **Not done (deferred).** Batch cap stays at 256 and there is no per-account daily budget yet.
   Lower priority now that positive deltas and public grants — the amplified vectors — are gone;
   this is a DoS/capacity control, not a cheat control.
10. **Partial.** `economy_rejected` / `inventory_rejected` / `roster_rejected` / `farm_rejected`
    are logged (rejected earns and stripped-grant attempts land in these). Dedicated counters for
    seeding attempts and alert wiring are still open.

### Phase 1: replace generic value changes with trusted commands

Create one internal value-issuance layer. Route handlers must not update balances, inventory, or
roster rows directly.

Each internal credit or grant must include:

- account ID;
- source type, such as `crop_harvest`, `quest_completion`, `raid_finish`, `gift_claim`,
  `purchase_refund`, or `combine_collect`;
- immutable source ID;
- server-computed amount or catalog key;
- ruleset/catalog version;
- creation time;
- a uniqueness constraint over the source so it can apply only once.

Replace generic client events with explicit commands:

- `plant`, `harvest`, `plow`, and plot expansion;
- item purchase, placement, movement, storage, removal, and refund;
- zombie planting, harvest, sale, casualty, veterancy, storage, and deployment;
- boost purchase and consumption;
- combine start and collect;
- quest progress and completion;
- farm-size and climate purchase;
- gift claim;
- raid start, input, and finish.

For each command, the server loads canonical state, checks prerequisites and ownership, computes
the exact result from its catalog, commits the state and its ledger/grant event atomically, and
returns the new authoritative projection.

There must be no `misc`, `tutorial`, `quest`, `gift`, `refund`, `raid_loot`, or similar public
catch-all capable of producing value. Those names may exist only as internal source types attached
to a source record the server has independently validated.

### Phase 2: finish farm, inventory, roster, and progression authority

1. Store soil/plot state against the server-owned farm dimensions. Validate bare -> plowed ->
   planted -> ripe -> harvested transitions.
2. Use server timestamps for planting, growing, combining, construction, cooldowns, and other
   delayed jobs. The client may display countdowns but cannot complete a job early.
3. Represent placeable ownership as item instances or counts separate from placement. Placement
   consumes or references an owned instance; removal can refund only a recorded purchased instance.
4. Make zombie creation source-specific. Crop harvest must reference a ripe server crop; combine
   collect must reference a completed server job; rewards must reference a unique server grant.
5. Derive level and unlocks from server XP. Validate every level-gated crop, zombie, shop upgrade,
   quest, and raid against that server-derived level.
6. Track quest state server-side for any quest that awards currency, items, zombies, XP, or unlocks.
   Cosmetic-only local quests may remain client-side if they cannot feed a valuable path.
7. Roll random loot and rare rewards on the server from a pinned source event and server RNG.

### Phase 3: implement interactive raid verification

1. `POST /raid/start` atomically verifies cooldown, unlock, server roster, deployment order, owned
   boosts, and vouchers. It reserves the account's single active raid.
2. Store raid ID, ruleset version, roster snapshot, loadout, server RNG seed, start time, expiry,
   and any consumed resources.
3. Record every outcome-relevant player input with a simulation tick: target selection, ability
   activation, concentration interaction, retreat, and future direct-control actions.
4. `POST /raid/finish` accepts the session ID and input transcript, never `win`, casualties,
   survival fraction, loot, or reward totals as authoritative fields.
5. Replay the deterministic combat rules and reject impossible, late, duplicated, reordered, or
   resource-invalid actions. Rendering and animation are not part of replay.
6. Atomically close the raid session, start the cooldown, apply casualties/veterancy, roll loot,
   record first clear, and issue rewards through unique internal source events.
7. Benchmark worst-case replay against the Worker CPU limit. If deterministic replay cannot meet
   it, use an authoritative coarse action state machine rather than trusting the final result.

### Phase 4: separate cloud presentation saves from authoritative state

Change `PUT /save` into a presentation/layout endpoint. It may persist bounded cosmetic state such
as camera-independent placement, selected appearance, tutorial presentation, and client settings.

It must ignore or reject:

- gold, brains, XP, level, and unlocks;
- inventory and received rewards;
- zombie ownership, permanent mutation state, casualties, and veterancy;
- crop readiness and authoritative job timestamps;
- farm size and purchased terrain ownership;
- quest completion with rewards;
- raid wins, cooldowns, loot, and first clears.

`GET /save` or a replacement bootstrap endpoint should compose the response from authoritative
server tables plus the bounded presentation snapshot. Editing local storage or replaying an old
snapshot must therefore have no valuable effect.

Offline play requires an explicit product decision:

- **Untrusted offline mode:** progression remains local and cannot enter online competitive or
  paid systems.
- **Online authoritative mode:** commands queue locally while disconnected, but the server may
  reject them on reconnect if prerequisites, order, or timing cannot be proven.

Do not silently merge arbitrary offline snapshots into authoritative online progression.

### Phase 5: make concurrency and idempotency part of every invariant

- Scope idempotency keys to the account and command type, and store the committed response.
- Apply value only when insertion of the unique source/command row succeeds.
- Use guarded debits such as `UPDATE ... WHERE balance >= cost` and require exactly one changed row.
- Make raid start a conditional transition from `idle` to `active`; make finish a conditional
  transition from the same active session to `finished` while unexpired.
- Add nonnegative balance/count constraints and legal-state constraints where D1 supports them.
- Never perform a security decision in a read followed later by an unconditional write.
- Retain idempotency records for at least the maximum retry/offline window; purging them after seven
  days is unsafe if an old client outbox can retry later than seven days.

Required concurrency tests include duplicate event IDs in parallel requests, overlapping purchases,
simultaneous inventory use, repeated roster sale, multiple raid starts, finish versus expiry,
finish retries, gift claim versus autosave, block versus friend acceptance, and stale/offline command
replay.

### Phase 6: rollout without corrupting legitimate accounts

1. Add schema and server code before enabling the new client.
2. Run new validation in shadow mode and record disagreements without rejecting legitimate traffic.
3. Measure the real ranges of balances, roster sizes, action rates, raid lengths, and offline retry
   delays before fixing final caps.
4. Migrate existing state once, record exactly what was imported, and close the migration endpoint.
5. Deploy the client only after the Worker and migrations are confirmed live.
6. Gradually disable legacy raw-event and snapshot paths with a server-side feature flag and a
   forced minimum client version.
7. Provide administrative tools to inspect source events, reconcile a player, reverse a bad grant,
   revoke sessions, and quarantine suspicious progression without deleting the account.
8. Monitor rejected commands, source uniqueness conflicts, negative-state attempts, raid replay
   failures, initialization attempts, and accepted commands per account/day.

### Definition of done

Own-account manipulation is materially controlled when all of the following are true:

- No public route accepts a positive currency delta or unrestricted inventory/roster grant.
- A newly created account always starts from server defaults.
- Every positive ledger, inventory, roster, loot, and unlock change references one unique trusted
  server source.
- Editing or replacing the cloud/local save cannot change authoritative progression.
- Farm actions are constrained by owned dimensions, plot state, catalog, cost, level, and server
  time.
- Only one unexpired raid can be active, and rewards require a server-verified outcome.
- Concurrent and repeated requests cannot double-credit, overdraft, reopen, or bypass cooldowns.
- Per-account budgets and global load shedding prevent a valid client from turning batching into a
  denial of service.
- Adversarial integration tests cover every value-producing command and its concurrency behavior.

## Broader remaining work: priority order

The own-account manipulation plan above supersedes the older implementation notes under items 1-4.
Those items are not complete merely because a value is stored in a server table; the server must
also prove the provenance of every value-producing input.

### 1. Make valuable balances and progression server-owned

Move gold, brains, XP, inventory, boosts, unique items, zombie ownership, permanent casualties,
raid wins, cooldowns, loot, and unlocks out of the opaque client save. The server should derive
or validate every change to these values. The client may display predicted results, but it must
not be able to commit arbitrary balances.

Do this before adding paid currency, trading, competitive rankings, or rewards that influence
other accounts.

**Progress with an important qualification:** balances, boost counts, roster rows, crop records,
farm size, climate ownership, raid cooldown, and server-priced rewards now have server-side storage.
Exact crop economics, gift settlement, catalog pricing, fertilization rolls, and parts of combining
are meaningful improvements. However, public raw earns, inventory grants, roster grants/sync,
first-use seeding, and client-asserted raid wins mean storage authority is not yet reward authority.
Treat this item as incomplete until the provenance requirements in the plan above are satisfied.

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

### 4. Generalize the trusted grant ledger

Gift brains now settle into the server-owned balance through a unique grant. Apply that same model
to every other value source. Inventory, roster, quest, loot, tutorial, refund, raid, promotion, and
administrative grants must originate from server-validated source records and unique idempotency
keys. Public clients must not be able to construct grant events directly.

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

The current production backend throttles session activity updates to approximately once every 15
minutes and uses Cloudflare Rate Limiting bindings, so most authenticated requests no longer create
session or rate-counter writes. A normal remote snapshot is therefore approximately one Worker
request and one primary save-row write, plus reads and occasional session maintenance. Value-command
batches can write several rows per accepted command and are now the larger capacity and abuse risk.

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
the current session throttling and native request counters, those periodic snapshots are roughly
12,000 save-row writes plus modest authentication and social overhead. Server-authoritative action
commands add their own ledger and state writes, so accepted commands per player-hour must be tracked
separately from snapshot frequency.

Real use should normally be lower because the five-second debounce coalesces bursts and the maximum
timer runs only while state is dirty. Measure actual remote saves per player-hour and D1 query
metadata before treating these estimates as capacity guarantees.

This optimization does not replace abuse controls. Without comprehensive limits, a single valid
automated client can deliberately generate enough requests or D1 writes to exhaust a free daily
allowance even when legitimate player traffic is small.
