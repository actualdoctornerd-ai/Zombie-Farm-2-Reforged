# Security and Anti-Cheat Status

Last reviewed: 2026-08-28

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
and the known gaps already documented below. In particular, the `clientWin`/`clientLosses`
raid concession is **intended** — it exists because two hazards are client-only, and it can
only make the submitting player's own result worse. A report showing it can improve an
outcome, affect another account, or yield rewards is very much in scope.

This is a non-commercial hobby project with no bounty and best-effort response times.
Please give a reasonable window before disclosing publicly.

## Scope and status

This document describes the current source tree at gameplay protocol v3 (client integrity
version 5, raid ruleset version 48). It covers authentication, sessions, the exclusive writer
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

1. **Raid outcomes are server-verified by deterministic replay, with one-way concessions.**
   `/raid/finish` replays the pinned combat with the submitted input transcript and derives the
   outcome server-side (`server/src/raidVerifier.ts` → `src/raid/replay.ts`). Since ruleset
   version 6 it also accepts optional `clientWin` / `clientLosses` fields, because the Beach crab
   and Circus trapeze hazards are client-only and the verifier deliberately replays the
   *un-harassed* fight. These are merged **monotonically downward** (`server/src/v3/raid.ts`):
   `win = !retreated && replayOutcome.win && !conceded` (AND, never OR), and conceded casualties
   are intersected with the zombies the replay had escaping. A client can therefore make its own
   result worse, never better — it cannot claim a win the replay did not produce, nor save a
   zombie the replay killed. Epic Boss finishes replay the same way and have **no** concession path.
2. **Raid, Epic Boss, and Black Market mutations are serialized with `/commands`.** All mutation
   routes acquire the same exclusive per-account active-operation lock (`active_batch_id`) through
   the writer lease, so a raid settlement and a command batch can no longer interleave.
3. **The free-plow XP loop is closed.** With a Plowing Monolith placed, plowing is free but grants
   **zero** XP (the repeatable XP moved onto time-gated harvests); without the monolith, each plow
   costs gold. Neither path yields cost-free repeatable XP.

**Remaining posture.** Rewards and progression are server-derived and catalog-bounded, and **raid
outcomes** admit no upward client assertion — no path lets a client claim a better result than the
replay produced. Most residual risks below are integrity limitations rather than forgery
(client-only hazards and their concession fallback, bot-optimal input, deployment-gated
enforcement, non-deterministic loot rolls, session compromise, offline mutability). The one
current exception is **client-asserted fertilization**, a bounded but genuinely upward assertion
documented below. It is an accepted design tradeoff for this non-commercial fan reimplementation:
keeping the fertilization animation immediate and inside the existing command batch is more
valuable than preventing a bounded increase to ordinary vegetable gold. It cannot directly award
brains, XP, zombies, premium inventory, or combat rewards, and there is no real payment rail, so
"paid currency" is notional. `MUTATIONS_DISABLED=1` remains the incident stop for all gameplay
writes.

## Controls currently implemented

### Local Farm / Online Farm separation

The client is no longer online-or-offline by build. When online services are configured, the
player picks **Local Farm** or **Online Farm** at first launch (`src/playMode.ts`, persisted in
`localStorage`, switchable in Settings). This matters to the threat model in three ways:

- **The farm choice, not a retained session, owns the gameplay boundary.** The mode is resolved
  before auth is touched (`src/main.ts`), so Local Farm issues no account or gameplay-server
  request even when the browser still holds a valid Online Farm session.
- **Storage domains are namespaced and never cross.** Local saves live under
  `zf2r.local.save.v1`, the online read-only snapshot under `zf2r.online.snapshot.v1`, and the
  online presentation cache under `zf2r.online.presentation.v1`. In online mode the save manager
  writes nothing at all when the session is missing, rather than falling through to a local
  write — the cross-contamination path this split removes.
- **Failure never silently degrades authority.** A failed online bootstrap renders a labelled
  read-only "offline view" from the last server-confirmed snapshot, or offers a *separate* local
  farm as an explicit choice. It never promotes local state into the account.

Local Farm is client-authoritative by design and remains out of scope for vulnerability reports
(see above) — it has no server and no other player to defend against. The security-relevant
property is only that it stays isolated from the account.

**Crash diagnostics are local-only, on purpose.** `src/diagnostics.ts` keeps captured errors in
`localStorage` and exposes them through a Settings button that copies to the clipboard. Nothing
is transmitted. If a server-side reporting route is ever added it must be Online-Farm-only or
explicitly opt-in, or it silently breaks the no-network guarantee above — update this section and
the README in the same change.

The same report also carries a short ACTIVITY TRAIL (`src/breadcrumbs.ts`) — the last forty
steps the session took, with the gap between them — because the errors buffer can only see
things that threw, and the failures that cost the most were stalls rather than crashes. It is
held to the same contract, and to one more: a crumb is a fixed tag plus a short *structural*
detail (a catalog name, a same-origin asset path, a count). It must never carry save data, an
account id, a session token, or anything the player typed. The player is told what the button
copies, in the Settings note beside it; a new crumb that widens what is copied has to update
that note too.

The writer-lease crumbs are held to that rule deliberately and visibly: they carry the
generation (a small counter), whether a claim was a takeover, and whether the client key still
AGREES with the lease — never the clientId, the writer token, or the account id, all three of
which are in scope at those call sites. `src/net/writerIdentity.test.ts` asserts that none of
them reaches the trail.

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
  (`CLIENT_INTEGRITY_VERSION = 5`) and are always fenced. When `WRITER_LEASE_MODE=enforce`,
  un-upgraded clients receive `426 client_upgrade_required` on every mutation route; in the
  default observe mode they are allowed through unfenced during rollout.

### Protocol-v3 authoritative state

- `/bootstrap` returns the server gameplay projection, presentation projection, writer state,
  social summary, resumable raid metadata, and the Worker's `raidRulesetVersion` (advisory: the
  client uses it to prompt a reload when its bundle and the Worker disagree, which would
  otherwise surface as a `426 stale_ruleset` on every `/raid/start`). The unauthenticated
  `GET /` health probe publishes the same version so the client deploy can gate on it.
- `/commands` accepts an allowlisted semantic command union. It rejects arbitrary balance/state
  setters and validates catalog keys, ownership, affordability, level gates, capacity, crop
  timing, and coordinates on the server.
- Daily/weekly quest boards are client-authored and server-verified: `quest.periodic_author`
  carries only a scope and a level, never a quest array. The server takes the period from its
  own clock, clamps the level to the XP it holds, refuses a level below the scope's unlock and
  a scope that already has this period's board (no re-roll — the per-day cap's backbone), and
  derives the set itself with the shared deterministic generator. Counts and claims stay
  server-owned.
- Farm timestamps, random IDs, combine output, prices, refunds, XP, level rewards,
  inventory counts, object ownership, storage counts, and roster changes are computed from
  server-held state. **Fertilization is no longer in this list** — see the known limitation below.
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
  and concentration. The pinned config and `ruleset_version` are stored on the session
  (migrations `0016`, `0017`, `0027`). The config still carries a `grabber` field, but since
  ruleset 6 (current version 48) `raidVerifier.grabberOf` returns `null` unconditionally — hazards are client-only
  and are not simulated server-side at all.
- `/raid/finish` requires a matching `rulesetVersion` (`RAID_RULESET_VERSION = 48`; a mismatch
  returns `409 stale_ruleset` and closes the session), rejects a `finalTick` beyond the paced
  elapsed real time (`future_finish`), then **replays** the pinned sim with the submitted input
  transcript and derives `win`/`survivors`/`losses`/`retreated`, subject to the one-way
  concession merge described above.
- Casualties are deleted, survivor veterancy is incremented, and rewards (gold, first-clear XP,
  brains, one loot roll) are computed server-side and catalog-bounded. On the concession-fallback
  branch survivors are deliberately emptied so **no unverifiable veterancy is awarded**. Roster
  culling is server-only: a forged casualty submitted through `/roster/actions` is rejected
  (`server_only_raid_result`).
- Every rejected finish writes a durable `raid_finish_rejected` row to `audit_events_v3`
  (stale ruleset, bad session config, replay failure, roster mismatch).
- Every finish write carries a session-scoped `result_json` CAS guard and checks that exactly
  one row changed; a raced/duplicate finish returns the stored result. Post-battle revival
  restores casualties only from a server-owned snapshot, one brain each, idempotently.
- Epic Boss activation spends brains atomically; start pins the run; finish replays the input
  transcript the same way as raids. `/epic-boss/start` performs the same ruleset handshake as
  `/raid/start` — a client on a stale bundle is refused `426 stale_ruleset` before a token or
  brain is charged, rather than being sold an attempt its simulation would settle differently.
- `RAID_RULESET_VERSION` is declared once, in `src/raid/replay.ts`, and imported by both the
  client and the Worker. Every bump has to be reflected in the three version numbers quoted in
  this section, in `server/README.md`, and in `docs/PROTOCOL_V3_ROLLOUT.md`.

### Black Market (server-authoritative trading)

- Buy/sell-zombie orders escrow the counter-value on the server: a buy order escrows the asking
  price, a sell order escrows the zombie (with its mutation/veterancy snapshot).
- A post is priced in **gold or brains** (`currency`, migration `0045`), chosen at creation and
  fixed for its lifetime. The currency is read from the stored order on every later step, never
  from the fulfiller's request, so escrow, settlement, payout and refund all move the same wallet
  and no request can redirect a payment to the cheaper one. An unrecognised currency is a 400, not
  a fallback; an absent one means brains, which is what every pre-`0045` post was.
- Order creation enforces a cap of 10 simultaneously-open orders and 50 per UTC day, price bounds
  (`1 … 10,000,000`, enforced in the Worker and again by a column CHECK), and a request fingerprint
  so a retried create is idempotent. Both caps are checked twice — pre-flight, and again in the
  insert's `WHERE` clause so a race cannot exceed them.
- Buy orders may demand **specific mutations** (`mutation_required`, migration `0030`): a 13-bit
  mask, legal only on `BUY_ZOMBIE` with `mutated: true`, validated bit-by-bit. Every anatomical
  slot in the mask must be satisfied; bits within one slot are OR-alternatives; unrequested extra
  mutations are allowed. The match is compiled into SQL and re-checked inside the fulfillment
  transaction, not merely pre-flight.
- Delivery is gated on the **recipient**: `special`-category zombies require player level 20, and
  Blue/Red/Silver classes require the level that unlocks their gravestone (1/15/25), without
  requiring the gravestone itself (`server/src/rosterCatalog.ts`).
  Checked pre-flight and re-checked as a SQL guard inside the fulfillment claim.
- Fulfillment settles both deliveries atomically against authoritative roster/balance state;
  cancellation returns the escrow. Orders cannot be self-fulfilled or double-settled.

### Social and abuse controls

- Friendships require consent; blocks are checked in both directions.
- A friend list is capped at 50, and the cap bounds ACCEPTING rather than receiving: requests
  still arrive at a full list and wait in the inbox, and only the accept is refused
  (`friends_full`). Because a friendship is written in BOTH directions, every path that forms
  one checks BOTH parties — `/friends/accept` also refuses when the requester has filled up
  since asking (`requester_full`), and the mutual-intent shortcut in `/friends/add` (adding
  back someone who already asked auto-accepts) applies the same two checks rather than
  bypassing them. That shortcut stays a non-oracle: it returns the same generic response
  whether or not it accepted.
- Gifts require friendship and are doubly bounded in SQL, both bounds PER RECIPIENT: a
  `(from_id, to_id, day_bucket)` uniqueness constraint allows one gift per friend per day
  (`already_gifted_today`), and the insert's own `WHERE` clause refuses a send while that
  recipient still holds an unopened gift from this sender (`gift_pending`), so gifts cannot
  be stockpiled on a player who never logs in. There is no per-sender daily ceiling — gold is
  the only limit on breadth: the first two daily sends are free, and the same statement
  requires at least 100 authoritative gold before inserting any later send, with successful
  paid sends atomically debiting that gold. These rules are enforced in SQL, so failed,
  duplicate, or racing sends cannot bypass them or overdraw the sender. A unique grant record
  prevents duplicate claims.
- Chosen usernames pass a two-part check (`validateUsername`, `server/src/logic.ts`) on the one
  route that can set one. The SHAPE half is an allowlist — `^[\p{L}\p{N} _.'-]+$`, 2–20 chars —
  so zero-width characters, RTL/LTR overrides, stacked combining marks and emoji are rejected
  structurally rather than by enumeration. The CONTENT half (`server/src/nameFilter.ts`) folds
  homoglyphs, fullwidth forms and leetspeak, then matches slurs, profanity and staff
  impersonation. This is an abuse control, not an integrity one: a username is the only
  player-authored string other players see, and it reaches strangers rather than only friends,
  because every Black Market listing carries its creator's name. Refusals return
  `blocked_username` with a coarse category and never the matched term.
- **Self-service account deletion** (`POST /account/delete`, `server/src/accountDeletion.ts`) is
  irreversible and authenticated. It requires an explicit `confirm: "DELETE"` body token so it
  cannot be reached by a bare replayed POST, is limited to 5/account/minute, and is refused
  while a command batch or raid settlement is in flight, or while the account has an open Black
  Market post or a fulfilled trade whose zombie is unclaimed — the latter because the order rows
  cascade with the account and would otherwise destroy a counterparty's property.
  `black_market_orders.fulfilled_by_account_id` is nulled rather than deleted for the same
  reason. It deletes the `accounts` row itself, freeing the `google_sub`, so a subsequent
  sign-in creates a new account rather than restoring the old one. The purge list is written out
  in source because D1 refuses `pragma_foreign_key_list` with `SQLITE_AUTH`; `accountDeletion.test.ts`
  holds that list to `schema.sql` so a migration adding a table fails a test instead of orphaning
  a deleted player's rows. Deliberately NOT a writer-protected mutation: `endOperation` would
  write to a row the handler has just deleted.
- All routes have a global body ceiling. Presentation and command batches have tighter semantic
  limits.
- Cloudflare rate-limit bindings protect authentication, read, and write tiers before gameplay
  handlers. Protocol v3 additionally limits `/commands` to 30 requests per account per minute,
  and raid start/finish/revive, Epic Boss, and Black Market writes to 60 per account per minute
  each.
- `MUTATIONS_DISABLED=1` stops `/commands`, `/presentation`, `/raid/*`, `/epic-boss/*`,
  `/black-market/*`, and `/account/delete` while retaining authenticated read/bootstrap access.
  Deletion is halted with the rest deliberately: during an incident an irreversible purge is the
  last thing that should still run, and in the `export_only` closedown mode a player deleting
  instead of exporting would lose the farm that window exists to hand them.

## Known limitations and residual risk

These are the remaining integrity limitations after the three former gaps were closed. None of
them allow a client to forge a raid outcome or set an arbitrary balance.

### Enforcement is deployment-gated

The writer lease only rejects un-upgraded clients when `WRITER_LEASE_MODE=enforce`. In observe
mode a legacy client bypasses fencing, so single-writer serialization is guaranteed only for
upgraded clients. Set `WRITER_LEASE_MODE=enforce` (and confirm the client integrity version)
before treating serialization as guaranteed for every request.

### Client-only hazards and the concession fallback

Since ruleset 6 the Beach crab and Circus trapeze run only on the client, so the server replays a
fight that is strictly easier than the one the player saw. The player concedes the difference via
`clientWin: false` / `clientLosses`. Two consequences:

- A player who genuinely *would* have won can be forced to report a loss by a hostile local
  modification, but only against their own account — the merge is one-way and zero-reward.
- If a transcript fails replay with `truncated_transcript`, `illegal_bubble`, `illegal_ability`,
  `illegal_wall_tap`, or `input_after_finish` **and** the client conceded, the settlement no longer hard-rejects. It
  closes the session as a synthesised zero-reward loss and skips roster-partition validation
  (`server/src/v3/raid.ts`). `illegal_ability` and `illegal_bubble` were previously treated as
  forgery rejections. This is self-harming by construction — it grants nothing — but it is a real
  hole in the otherwise absolute claim that every settlement is replay-verified. The fallback is
  recorded in the audit ledger, so its rate is observable.

Closing this properly means simulating the hazards server-side (restoring `grabberOf`) so no
concession is needed.

### Client-asserted fertilization (accepted design tradeoff)

The Garden-zombie fertilize roll moved from the server to the client so the actor animation and
leaf effect appear immediately. `farm.plant` now carries an optional `fertilized` boolean, and
`server/src/v3/engine.ts` takes it **verbatim** — the only checks are that the value is a boolean
(`server/src/index.ts`) and that the crop is a vegetable. The server's own roll is gone;
`fertilizeProbability` in `server/src/rosterCatalog.ts` no longer has a caller.

A modified client can therefore set `fertilized: true` on every vegetable plant and collect the
2x harvest every time, with no adjacency requirement and no probability gate. The gain is bounded
(2x on vegetable harvests only, still time-gated by grow timers, and it cannot touch zombie
crops), so this is yield inflation rather than arbitrary value creation — but unlike the raid
concession it is a strict *upward* client assertion, which is the property the rest of this
document otherwise excludes. This is the explicit exception to that general guarantee.

Fertilization does not multiply XP and cannot directly create brains, zombies, premium inventory,
raid/Epic Boss rewards, or Black Market escrow. This exception is intentionally accepted so
fertilization can appear at planting time without an extra server request.

Revisit server-owned rolling only if gold becomes scarce or competitive, can be converted into
brains or real value, or the project receives enough operating support to justify the additional
server work. Until then, security claims should describe protocol v3 as server-authoritative
**except for this documented, bounded vegetable-gold outcome**.

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
Additional durable/structured signals now exist: `raid_finish_rejected` audit rows (with the
`concessionFallbackError` code when the fallback branch is taken), and `writer_operation_rejected`
and `gift_claim_deferred` warn logs. There is still no thresholded alerting on repeated
forgery/timing/writer-takeover probes; failures are observable in logs but not yet triaged
automatically.

### Other residual risk

- A compromised active session can act as its account until the session is revoked.
- A custom client can automate legitimate commands up to server limits.
- D1/Worker interruption can withhold or overwrite value at a mutation boundary; idempotency and
  the CAS guards reduce duplicate application but do not repair every partial-write case.
- Local/offline presentation and gameplay can be modified. Protocol v3 does not import that local
  value into a reset online account, but offline play is not cheat-resistant by design.

## Verification status

On 2026-08-28 the following local checks passed on a clean working tree:

```text
npm test                              # client: 2057 passed, 1 skipped (205 files)
cd server && npm run typecheck        # passed
cd server && npm run migrations:check # 58 files verified
cd server && npm run catalogs:check   # passed
cd server && npm test                 # server: 642 passed (57 files)
cd server && npm run test:integration # 99 passed (7 files)
```

Coverage includes the anti-forgery paths directly: replay determinism and illegal-input
rejection (`src/raid/replay.test.ts`), a settlement that derives the retreat rather than trusting
a client-claimed win plus the `stale_ruleset` gate (`server/test/integration/v3.spec.ts`,
`raidGates.spec.ts`), the `/raid/finish` elapsed-time gate refusing a finish paced past real
time, a body-asserted win paying nothing and moving no balance, and a duplicate finish replaying
the stored result rather than settling twice (all `raidGates.spec.ts`), a server-only roster-cull
that removes the casualty and offers it back only as a paid revival (`v3.spec.ts`) over a roster
validator that refuses a fabricated or reward-only species key (`server/test/roster.test.ts`),
and writer-lease takeover/replacement (`v3.spec.ts`). Every server catalog that
mirrors a client asset is now held to it by a test — `boostCatalogSync`, `raidCatalogSync`
(rewards, unlock gates and loot tables), `shopCatalogSync`, `objectCatalogSync` and
`farm.test.ts`, with `rosterCatalog` / `zombieCropCatalog` / `questCatalog` derived from their
asset at load and so unable to drift. A price or level gate can no longer be enforced on the
client alone, which is how the Brain Ticket's level-20 gate came to be advisory. Passing tests do not by themselves certify the
production deployment; confirm the live commit and remote D1 schema per the rollout doc.

**What the integration run does not cover.** `vitest.integration.config.ts` runs every
`test/integration/**/*.spec.ts` except four excluded protocol-v2 specs — `api`, `inventory`,
`raidLoot` and `raidRewards`. Those drive routes that now answer `410`; anything they uniquely
proved about the live surface has to be re-established against v3 before it counts. The
forged-finish coverage this section used to cite from `raidRewards.spec.ts` was in exactly that
state and has now been ported to `raidGates.spec.ts` (the v2 spec asserted `bad_final_tick`; the
v3 route spells the same property as `future_finish`). Reward-table and inventory-grant
assertions from `raidLoot` / `inventory` have **not** been ported and remain dark at the route
level, though the unit suites cover the same catalogs.

## Required release gates

The former blocking gates are met in source. Before treating a live deployment as safe for
valuable/competitive features, confirm on the running environment:

1. `WRITER_LEASE_MODE=enforce` and `MIN_PROTOCOL_VERSION=3` are set, and an un-upgraded client is
   actually rejected on every mutation route.
2. The live Worker commit and remote D1 schema match this source — `wrangler d1 migrations
   list zombiefarm --remote --env production` reports nothing pending, and `GET /` reports the
   `raidRulesetVersion` this source declares. Do not infer production state from source
   control. Several migrations are non-idempotent `ALTER TABLE ... ADD COLUMN`; the table in
   `server/migrations/README.md` names each one and what it does on a re-run.
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
