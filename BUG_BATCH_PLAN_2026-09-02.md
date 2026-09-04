# Bug batch plan — 2026-09-02

Working document for the eight player reports triaged on 2026-09-02. It is a checklist,
not a design doc: each workstream lists the root cause (already verified), the exact
changes, the tests that pin them, and how to prove it. **Step 9 deletes this file** and
moves everything durable into the places the repo already keeps such knowledge.

Conventions for the whole batch:

- Work directly on `main`, one commit per workstream, verified before committing. The
  owner pushes; nothing is pushed, deployed, or migrated without explicit permission
  (AGENTS.md). Every commit message ends with the Claude co-author trailer.
- Verification baseline before touching anything: `npm test` in the repo root, and in
  `server/`: `npm run typecheck && npm test && npm run test:integration`. Record the
  counts so a reddened suite is attributable.
- Where a Worker change and a client change ship together, **the Worker deploys first**
  (bulk commands and ruleset bumps both fail closed against an older Worker).
- Decisions the owner has not made yet are marked **DECISION** with the default that
  will be taken if nothing is said.

Order of work (rationale: severity, then blast radius):

| # | Workstream | Touches | Deploy |
|---|---|---|---|
| 1 | Account deletion (broken for everyone on prod) | server | Worker |
| 2 | Mobile FAB over Retreat | client CSS | — |
| 3 | Double Invade launches two battles | client + server 409 mapping | Worker (optional) |
| 4 | Mutation Almanac misses online adjacency mutations | client | — |
| 5 | Daily quests: instant board, client-authored, server-verified | client + server | Worker |
| 6 | Quest fulfilment delay (periodic preview, completion preview, `harvest_many`) | client + server | Worker |
| 7 | Brain lifetime tally inflation | client | — |
| 8 | Randomised enemy order (ruleset 48) | shared sim + docs | Worker first, quiet window |
| 9 | Close out: record, then delete this file | docs, memory | — |

---

## 1. Account deletion fails on production

**Cause (confirmed on prod).** `ACCOUNT_REFERENCES` in `server/src/accountDeletion.ts:50-110`
names 25 tables that migration `0020_protocol_v3_reset.sql` dropped (`combine_jobs`,
`command_receipts`, `crop_plots`, `farm_actions`, `farm_state`, `game_events`, `inventory`,
`inventory_actions`, `item_storage`, `object_actions`, `object_counts`, `owned_climates`,
`plowed_soil`, `quest_completions`, `quest_event_applications`, `quest_progress`,
`raid_checkpoints`, `raid_clears`, `raid_roster_locks`, `raid_sessions`, `raid_state`,
`roster`, `roster_actions`, `saves`, `storage_actions`). `purgeAccount` runs one atomic
`db.batch()`; statement 9 (`DELETE FROM combine_jobs`) throws `no such table`, the batch rolls
back, the route has no try/catch → Hono 500 → client shows the generic toast
(`src/hud.ts:3357`). Tests pass because `server/schema.sql` still declares the legacy tables
and every test builds from it. `service_state.mode` is `open`, so the 503 path is not involved.

**Changes.**
1. `server/schema.sql`: delete the 25 legacy table definitions (and their indexes/triggers)
   so the fresh-DB path matches the migration-built path. Also reconcile
   `epic_boss_retry_skips_v3`: it exists only on migrated DBs (migration 0022) and is marked
   unused in `migrations/README.md` — add it to `schema.sql` AND to `ACCOUNT_REFERENCES`
   (cheapest; avoids a DROP migration).
2. `server/src/accountDeletion.ts`: remove the 25 entries; keep alphabetical order but add a
   comment that parents with NO ACTION children must come after their children (the
   `game_events` ← `quest_event_applications` ordering hazard goes away with the tables).
3. `server/src/index.ts:1704-1737`: wrap `purgeAccount` in try/catch; on failure `slog` the
   D1 message and answer `500 { error: "purge_failed" }`. Move the `account_deleted` log
   AFTER the batch succeeds.
4. Client `src/hud.ts:3349-3357` / `src/main.ts:4405-4417`: crumb the error code into
   diagnostics; distinct copy for `mutations_disabled` ("deletion is paused while the service
   is closing"), `rate_limited` ("wait a minute"), `purge_failed` / `http_5xx` ("server error,
   the maintainer has been told"). Keep the two existing 409 messages.
5. Tests:
   - New `server/test/schemaParity.test.ts`: apply every file in `server/migrations/` in
     order to a `node:sqlite` DB (as `migration0049.test.ts` does), apply `schema.sql` to a
     second one, assert the table sets are identical. This is the test that would have
     caught this bug and will catch the next drift.
   - `server/test/accountDeletion.test.ts` already mirrors `ACCOUNT_REFERENCES` against
     `schema.sql`; it goes green once both are trimmed.
   - `server/test/integration/accountDeletion.spec.ts`: seed one row in EVERY v3 table that
     references accounts (raid session, PvP session both roles, gift, fallen zombie, epic run,
     periodic quest doc, audit row, black-market receipt) and assert the account and all
     children are gone; assert a 200, not just `statements > 40`.
   - `server/test/accountDeletionGuards.test.ts`: add the purge-failure → `purge_failed` case.

**Verify.** Server suites green; then, with permission, deploy to **staging** and delete a
seeded staging account end-to-end (`window.zfDevSignIn`, then Account → Delete). Read the
Worker log for `account_deleted` with a following 200.

**Deploy.** Worker: yes (production, after staging). Migration: no.

**STATUS: DONE (committed 2026-09-02), staging/prod deploy still needs permission.**
- Widened beyond the table set: the parity test (`server/test/schemaParity.test.ts`) diffs
  tables, columns (type/NOT NULL/default/PK), foreign-key actions, indexes and triggers, and
  `schema.sql` was aligned on all of them — 25 tables + orphan index removed, the two
  `balances` nonneg triggers removed (prod never had them; the v3 reset recreated `balances`
  bare), `ON DELETE CASCADE` restored on sessions/friendships/friend_requests/blocks/gifts/
  grants/balances, defaults on `accounts.last_online_at`, `gifts.day_bucket`, `balances.*`,
  `raid_sessions_v3.config_json`/`ruleset_version`, and `epic_boss_retry_skips_v3` declared.
  Result: 363 schema objects identical between the replayed chain and `schema.sql`.
- Production ground truth read on 2026-09-02 (`SELECT … FROM sqlite_master`): 32 tables, 28
  indexes, 0 triggers — exactly the replay.
- Purge list 59 → 35 references (+ the accounts row = 36 statements). Route answers
  `purge_failed` (500) with the D1 message in the Worker log (`account_delete_failed`).
- New `server/test/accountDeletionPurge.test.ts` seeds every referencing table generically and
  runs the real batch with FKs on; also recreates the outage (a dropped table) and asserts
  nothing is deleted.
- Side finding, FIXED: `/dev/fixture/roster` also wrote the legacy `roster` table (all 45
  integration failures after the trim). Side finding, NOT fixed (task chip spawned): the
  protocol-v2 routes (`/save`, `/state`, `/farm/*`, `/inventory/*`, `/roster/*`,
  `/storage/*`, `/shop/*`, `/quest/state`) still exist and 500 on prod.
- Client: `deleteRefusalCopy()` in hud.ts (distinct copy for mutations_disabled /
  rate_limited / offline / purge_failed+5xx); `account:delete-refused <code>` crumb.
- Verified: server typecheck, migrations:check, catalogs:check, 652 unit, 99 integration;
  root tsc + 2063 tests. Staging e2e delete NOT done (needs deploy permission).

---

## 2. Mobile tool button (FAB) drawn over Retreat during tutorial raids

**Cause.** `src/ui/hud.css:2160` `#hud.tutorial .fab { display: block !important; }` ties on
specificity with the raid hide rule at `hud.css:423-426` and wins by source order. The tutorial
class stays on `#hud` for the whole tutorial, including its Invade raid, so the FAB paints
over the Pixi Retreat button (`RaidScene.ts:2556-2559`), which sits in the same corner.

**Changes.**
1. `hud.css:2160` → `#hud.tutorial:not(.raiding) .fab { display: block !important; }`.
2. `src/ui/tutorialLayering.test.ts`: add a text assertion that the tutorial FAB rule carries
   `:not(.raiding)` (same style as the file's existing cascade guards).

**Verify.** Browser pane at 375×812 (`resize_window` mobile preset), run the tutorial to the
Invade beat, screenshot the raid: Retreat visible, no FAB. Non-tutorial raid unchanged.

**Deploy.** Worker: no. Migration: no.

**STATUS: DONE (committed 2026-09-02).** Rule is `#hud.tutorial:not(.raiding) .fab` with a comment;
`tutorialLayering.test.ts` pins the text. Verified in the dev server at 375×812 by toggling
classes on `#hud` and reading the computed display of `.fab`: tutorial → block,
tutorial+raiding → none, raiding → none, plain → block (mobile). The full tutorial-to-Invade
playthrough was not run; the cascade is the whole bug and the computed style is the proof.

---

## 3. Double Invade launches two battles

**Cause.** The only in-flight guard is `start.disabled` in the army panel, and `refresh()`
(`src/hud.ts:6133-6141`, line 6139) reassigns it from the selection count on every card tap —
deselect/reselect re-enables the button mid-launch. `raidLaunchLockedUntil` is only set after
`/raid/start` answers (`main.ts:5443`) and lasts 15 s, but Tim's two tips (`main.ts:5511`,
`5531`) await dismissal with the panel still open, so `raidActive` (`main.ts:5537`) is set far
later than 15 s in the tutorial. A second click then passes `main.ts:5379`, runs
`main.ts:5380-5382` (nulls `raidSessionId`, `clearRaidExpiry`, `setLiveRaid(null)` — drops the
fence on the LIVE session), and: online gets a 409 from the server (unique index
`idx_raid_v3_live`, or a raw 500 on a true tie); offline launches a second `RaidScene`. Both
scenes `addChild`; only the last one ticks (`main.ts:7187`) and receives Pixi input — the
first is the "unresponsive" battle. The Epic Boss launcher (`main.ts:4790`) never sets the
lock at all and its panel rebuild hands out a fresh enabled button.

**Changes.**
1. `src/main.ts`: one synchronous launch token beside `raidActive`:
   `let launchInFlight = false; const withLaunchToken = async (fn, refused) => {...}` — set
   on entry, cleared in `finally`. Wrap the whole bodies of `hud.onLaunchRaid` (`:5378`),
   `hud.onLaunchEpicBoss` (`:4790`), the PvP army callback (`:5182`), and add it to the
   entry guards at `:5379`, `:4791`, `:5180`, `:5292`.
2. Move `main.ts:5380-5382` below the guard/token so a refused re-entry never clears the
   live-session fence.
3. Per-launch epoch: `const epoch = ++launchEpoch` before every `RaidScene.create`; in each
   `.then` (`:5750`, `:5026`, `:5159`, `:5359`) `if (!raidActive || epoch !== launchEpoch)
   return scene.destroy();`.
4. `src/hud.ts`: army panel `start.onclick` removes/inerts the panel synchronously before
   awaiting the launch (the PvP panel at `hud.ts:6420-6425` already does this); restore it
   only when the launch returns `false`. Same for the Epic Boss panel (`hud.ts:2681-2690`).
   `refresh()` must OR in an `launching` local so it can never re-enable the button.
5. Server (small, optional in the same commit): `server/src/v3/raid.ts:277` — catch a
   `UNIQUE constraint failed: idx_raid_v3_live` from `db.batch` and return the existing
   `409 raid_in_progress`; same for `epicBoss.ts` (`battle_in_progress`) and `pvp.ts`.
6. Tests: new `src/raidLaunchGuard.test.ts` (open army panel with a deferred `onLaunchRaid`,
   click start, toggle a card twice, click start again → launched once; second scene never
   attached); server test firing two `/raid/start` without awaiting → one 200, one 409,
   never a 500, one live row.

**Verify.** Repro the player's sequence in the browser pane (offline profile is the easiest:
Invade → toggle zombie twice → Fight during Tim's tip). Expect one battle, and the console
free of a second `RaidScene` build.

**Deploy.** Worker: only if step 5 is included (yes, recommended). Migration: no.

**STATUS: DONE (committed 2026-09-02).** Step 5 included → Worker deploy: yes.
- `src/raid/launchGate.ts` (LaunchGate: token via `run()`, epoch via `stamp()`/`isCurrent()`)
  wired into `hud.onLaunchRaid`, `hud.onLaunchEpicBoss`, the PvP army callback and
  `onWatchPvpReplay`; all four `RaidScene.create` sites stamp and check. The bodies became
  `launchRaid` / `launchEpicBoss` consts typed off `Hud[...]` so no re-indent was needed.
- hud.ts: army + Epic panels keep a `launching` local ORed into `refresh()`; the panel is NOT
  removed synchronously (the token makes that unnecessary and the screen stays up for a
  declined launch exactly as before).
- Server: `server/src/v3/liveSessionRace.ts` `isLiveSessionCollision()` maps the unique-index
  throw to 409 in raid.ts / epicBoss.ts / pvp.ts; `liveSessionRace.test.ts` pins SQLite's
  actual message for all three indexes. The integration tie test (raidGates.spec.ts) proves
  200+409 and never 500 but CANNOT force a true tie on local D1 — the loser usually gets
  `unit_not_owned` from the roster pin, which runs before the live-session read.
- Verified in the dev server (Play Local, 3 spawned Regulars, Old McDonnell): Fight →
  deselect/reselect mid-launch → Fight button stayed disabled, a direct second
  `onLaunchRaid` returned false, the stage gained exactly one scene. `launchGate.test.ts` (7)
  pins the token/epoch semantics. Root 2071 + server 657 tests green.

---

## 4. Mutation Almanac never records online crop-adjacency mutations

**Cause.** Online harvests spawn optimistically with `mutation = 0` (`main.ts:322-323` returns
undefined online; `ZombieField.spawn` → `recordZombieDiscovered(key, 0)` at
`ZombieField.ts:283`). The server rolls the real mask and it lands on the unit in
`reconcileServerRoster` (`ZombieField.ts:991`), but discovery there is gated on `!source`
(`:1003`) and the harvested unit always has a source via the alias map. The load-time backfill
(`SaveManager.ts:775-778`) only runs when `almanac.mutations` is EMPTY, so the gap never heals.
Prod: 5 of 65 accounts owning a tomato-bit non-Tomato-species zombie have no `tomato` entry;
the same holds for every crop mutation acquired online.

**Changes.**
1. `ZombieField.reconcileServerRoster`: when an aliased/direct source's mask changes to a
   value with bits the local unit did not have, call `recordZombieDiscovered` for the NEW
   bits only (a helper `newMutationBits(before, after)` in `mutationMask.ts` — never `&`/`|`
   on the raw number above 32 bits; use the existing mask helpers). Keep the `restored`
   suppression.
2. `SaveManager.ts:775-778`: make the backfill per-key — for each owned zombie, any mutation
   key it wears that is absent from the map gets `max(existing, 1)`. Runs on every load;
   idempotent; never lowers a count.
3. `src/GameState.ts:484`: drop the `mutation = 0` default so a caller must pass the mask
   explicitly (compile-time catch for the next such gap).
4. Tests: `src/zombie/ZombieField.arrival.test.ts` — "credits the server's mask when an
   aliased optimistic harvest is reconciled"; `src/zombie/mutationAlmanac.test.ts` — per-key
   backfill with a non-empty map; a `newMutationBits` unit test with a tier-4 bit (bit 32768).
5. Do NOT add strict server validation of `almanac.mutations`: a rejected presentation write
   kills the whole blob (`server/src/index.ts:1313`). Sanitise client-side only.

**Verify.** Online against staging: plant a zombie crop beside tomatoes, harvest, open the
Almanac → Tomatohead lit without reload. Reload → still lit. Existing account with the gap:
open the game → backfill lights it.

**Deploy.** Worker: no. Migration: no.

**STATUS: DONE (committed 2026-09-03).** One deviation from step 1: crediting the new bits through
`recordZombieDiscovered` would have counted the SPECIES a second time (it was counted at the
optimistic spawn), so GameState gained `recordMutationsDiscovered(mask)` — mutations only — and
`recordZombieDiscovered` routes through it. The reconcile calls it with
`newMutationBits(source.mutation, save.mutation)` (mutationMask.ts) for any aliased/direct source,
NOT gated on `rosterLive` (a mask that landed after the app closed is still news on the next
load; the local mask only catches up once, so it cannot inflate). Step 2 became
`repairMutationDiscovered(existing, roster)` in mutationAlmanac.ts: whole-map seed when empty,
otherwise a per-key floor of 1; runs on every load. Step 3 done (two test callers now pass 0).
Verified in the dev server (Play Local): spawn a Regular (mask 0), reconcile it under a server id
with alias + mask 1 → `mutationDiscovered.tomato = 1`, species count unchanged, Mutations tab
"2 / 16 discovered" with Tomatohead lit, repeat reconcile credits nothing, gaining carrot credits
carrot only; a doctored save with `almanac.mutations = {carrot:1}` and a tomato-wearing roster
reloads to `{carrot:1, tomato:1}`. Not verified against staging (the fix is client-only; the
reconcile path driven above is the one a server roster hits). Root 2079 tests green.

---

## 5. Daily quests: instant at level 5, client-authored, server-verified

**Cause.** `applyCommandBatch` runs `refreshPeriodic` BEFORE the command loop
(`server/src/v3/engine.ts:1441-1445`) with the pre-batch XP, so the batch that crosses level 5
sees level 4 and returns `daily: null`; the board appears on the NEXT batch (≥1 more command
and up to 30 s), or on reload. `raid.ts:623` has the same one-step lag. The online
`PeriodicQuestSystem` is a pure sink (`PeriodicQuestSystem.ts:60-80`). The generator
(`src/quest/periodic/generate.ts`) is already deterministic (FNV salt over account id + UTC
period, walked pools, total sort) and the Worker imports the same module — so "client authors,
server verifies" is "client generates locally, server re-derives and compares".

**DECISION** (default: explicit author command, as asked). The lean alternative — client
generates locally and the post-loop server refresh derives the same board — differs only when
a single batch crosses two levels.

**Changes.**
1. Client `src/quest/periodic/PeriodicQuestSystem.ts`: in authoritative mode, keep the
   `gameState.onChange` level-up subscription; on crossing `unlockLevel(scope)` (or on a
   period rollover while online) generate the set locally with `generatePeriodicSet` using
   the account id from `identity()`, render it immediately, and enqueue
   `{ type: "quest.periodic_author", scope, level }` via a new
   `EconomyClient.submitPeriodicQuestAuthor` (flush immediately, like the claim). Counts and
   claims remain server-owned; `adoptAuthoritative` replaces the local board when the
   projection lands (identical when the level matched).
2. Protocol `src/net/protocol.ts:96-99`: add the command type; update the doc comment at
   `:175-183` ("server-owned" → "client-authored, server-verified").
3. Server `server/src/index.ts:1032` (`validGameplayCommand`): accept the new type with
   integer `level` and scope ∈ {daily, weekly}.
4. Server `server/src/v3/engine.ts` beside `quest.periodic_claim` (`:1390`): derive `period`
   from `options.now` only; `level = min(command.level, levelForXp(balance.xp))`; reject
   `below_unlock` if `level < unlockLevel(scope)`; reject `already_authored` if the persisted
   `state[scope]?.period === period` (no re-roll — this is the per-day cap's backbone);
   otherwise `generatePeriodicSet` server-side and install. Never read a quest array from the
   command.
5. Server: run `refreshPeriodic` a SECOND time after the command loop (after `:1484`, before
   `periodicChanged` at `:1504`), and in `raid.ts` after `nextBalance` (`:641-644`), so a
   second device or a raid-crossing converges without the command. Keep the pre-loop call
   (claim expiry depends on it).
6. Tests: `server/test/periodicQuests.test.ts` — author at level ≤ real level lands; forged
   higher level is clamped; below unlock refused; second author in the same period refused
   and does not reset counts/claimed; level-5 crossing in one batch returns a board in THAT
   response. `src/quest/periodic/PeriodicQuestSystem.test.ts` — local board renders on
   level-up and is replaced by the projection. `server/test/commandValidation.test.ts:57`.
7. Docs: `docs/FEATURES.md:67` wording; `src/tutorial/unlockNotices.ts` copy stays.

**Verify.** Staging: L4 seed account, harvest across 250 XP → star button and Tim's notice
appear in the same frame; the next batch response carries the identical board.

**Deploy.** Worker: yes, FIRST (an old Worker rejects the unknown command type and the client
would show an error). Migration: no (`periodic_quest_documents_v3` unchanged).

**STATUS: DONE (committed 2026-09-03).** All seven steps as written, plus two things the plan
did not say: (a) the client keeps `authored`/`refused` period maps per scope, so the command
goes once per period and a `below_unlock` refusal (the optimistic level was not real) takes
the local board down via `PeriodicQuestSystem.authorRefused`, wired from
`economy.onCommandRejected` in main.ts (`already_authored` is silent — the server's board is
the same one); (b) authoring is gated on `adopted` so a board is never drawn over a
projection that has not arrived. Server: the engine case clamps `min(command.level, level)`
where `level` already includes the XP earlier commands in the batch earned — that is how the
crossing batch lands its board. Verified against a LOCAL Worker (wrangler dev + `--mode
localapi`, dev sign-in, `/dev/fixture/balance` xp=249, a carrot backdated in local D1):
harvest with the 1-XP preview → level 5, the 3-quest daily board and the ★ button in the SAME
tick; the flushed batch carried `farm.harvest` + `quest.periodic_author`, both applied, and
the response board was identical to the local one. A batch that crossed via plow XP with no
local author got the board in its own response (step 5 live). A `below_unlock` refusal took
the local board down live. Root 2086 + server unit + integration 103/103 (one flake on the
first run, clean on rerun). NOT verified against staging — needs the Worker deploy first.
Trap: local D1 farm document `current_json` IS the plots map (keys `"0:0"`), not
`{plots:{}}`.

---

## 6. Quest fulfilment delay

**Cause.** Catalog quests already preview optimistically (`QuestSystem.authoritativePreview`).
What lags: (a) periodic quests have no preview and update only on the next batch response
(30 s window anchored to the first command, `protocol.ts:13`, `commandQueue.ts:360-366`);
(b) a finished catalog quest stays on the rail as `2/2` and its successor stays hidden until
the server's `questChanges` arrive; (c) harvest has no bulk command (`protocol.ts:44` only
plows/plants), so insta-harvest ships one semantic command per plot against the 120/min budget
(`server/src/v3/db.ts:461-464`) and can back off for minutes; (d) insta-harvest with no
zombie crops does not force a flush (`economy.ts:663-677`).

**Changes.**
1. Periodic preview: `PeriodicQuestSystem` online subscribes to the quest bus and applies
   `applyPeriodicEvents` (the server's own function) to a CLONE of the adopted state, display
   only; `views()` reads the preview; the preview is discarded on every `adoptAuthoritative`.
   The Claim button stays gated on the AUTHORITATIVE count (the header comment's reason
   stands) but the badge and bar move instantly.
2. Catalog completion preview: `previewAuthoritativeEvent` (`QuestSystem.ts:288-322`) may
   mark `previewCompleted` and let `eligible()` show the successor; key the preview to the
   command sequences that fed it (same shape as `EconomyClient.optimistic`), and clear it
   when those sequences are answered without the quest in `questChanges`. This is the
   rollback seam that works while commands are pending (today's wholesale rollback is
   skipped under `deferStructural`, `economy.ts:1248`). Rewards stay server-only
   (`dispatchReward` untouched; `sweepSatisfied` stays disabled online).
3. `farm.harvest_many`: protocol (`protocol.ts:44`, `FARM_BULK_LIMIT`), client bulking in
   `src/net/farmBulk.ts` / `economy.ts` for harvest (regular and insta), server
   `engine.ts` handler mirroring `plant_many` (one semantic command, per-plot results,
   quest events per plot). Rate-limit accounting unchanged.
4. Flush on any insta-harvest, not only when zombie crops were involved (`economy.ts:663`).
5. Tests: `src/quest/QuestSystem.test.ts` (completion preview + rollback on a rejected
   sequence + no double celebration); `src/quest/periodic/PeriodicQuestSystem.test.ts`
   (preview moves, adopt replaces); `src/net/farmBulk.test.ts` + `server/test/v3.farmBulk.test.ts`
   for `harvest_many`; `server/test/harvestEventSplit.test.ts` still green.

**Verify.** Staging with a daily "harvest N carrots" board: insta-harvest → badge and bar
move in the same frame; batch response confirms; a forced rejection rolls the preview back.
Watch `/commands` for 429s on a 56-plot insta-harvest before/after `harvest_many`.

**Deploy.** Worker: yes, FIRST (bulking memory: an old Worker rejects `harvest_many`).
Migration: no.

**STATUS: DONE (committed 2026-09-03).** Two corrections to the cause as written: (c) was
wrong about Insta-Harvest — it already ships as ONE `power.use` semantic command (main.ts
`applyBoost` deliberately does not call onFarm per plot); the per-plot cost was the HAND
harvest (JobSystem → `state.onFarm` per plot). (d) was right and is done (flush on any
`insta_harvest`). Change 2 keys the rollback to the response that leaves the outbox EMPTY
(`onQuestChanges(changes, settled)`), not to individual sequences: QuestSystem never sees
sequence numbers and the fold makes "which command carried this event" unknowable; settled
is the one moment every posted event is known to be answered. Rollback also drops the
COUNT preview for that quest (its events were refused too) and deactivates successors that
only qualified through the preview; the popup is never repeated. Periodic preview: views
carry `pending` (done in preview, not in the server's count) and the panel renders
"Confirming…" instead of Claim; `claim()` still reads the authoritative state; a preview
completion calls `requestConfirmation` (flush). `applyBulkFarm` now aggregates
createdIds/createdZombieSources so a bulk harvest pairs zombies by plot. Verified against
the LOCAL Worker: posting the Apple Tree buy event retired quest 62 and showed successor 63
in the same tick, and the next settled batch (a plow) rolled it back (62 at 0/1, 63 gone);
three hand harvests → daily "Harvest 45 vegetable crops" read 3 in the same tick, the batch
carried ONE result for three plots, and the response's counts were [0,3,0]. Root 2091 +
server unit + integration 103/103. NOT verified against staging (Worker deploy first).
Trap: the line-ending check `grep -q $'\r'` reported LF for files that were CRLF; an
edit script without a CRLF fallback then "MISSING"-ed. 16 working-tree files were
normalised to LF (git autocrlf makes that transparent in the blobs).

---

## 7. Brain lifetime tally inflation (Asami: 141/127 vs a real 62)

**Cause (verified against prod).** Asami's 62 is exact. Both counters are inflated by the
same ≈64 because `GameState.accrueCurrencyStats` (`GameState.ts:319-329`) books every balance
MOVEMENT, so any dip-and-recover adds equally to spent and earned. Her account shows the two
live triggers: `writer_generation` 19 (lease loss → `economy.ts:278` `optimistic.clear()` +
re-bootstrap) and 172 raids in six hours (local `addBrains` at fight end,
`RaidManager.ts:631`, reconciled away by a farm batch whose base predates the settlement,
then re-credited when `/raid/finish` answers). Rejections (`economy.ts:1221`), conflict
reloads (`:522`), the cached-snapshot boot (`SaveManager.ts:545-554`) and Black Market
escrow cancel/expiry (`main.ts:4443-4460`) inflate the same way for other players.
`mergeFarmStats` (`stats.ts:144`) ratchets by max, so nothing can ever correct downward.

**Changes.**
1. `GameState.syncBalance(gold, brains, xp, { rebase?: boolean })`: the two
   `optimistic.clear()` sites (`economy.ts:278`, `:522`) and the cached-snapshot → bootstrap
   adoption call it with `rebase: true` (no accrue).
2. Rejected / dependency-failed result (`economy.ts:1221-1236`): when the deleted delta had
   been booked as a spend, reverse the booking (`stats.brainsSpent -= cost`, floor 0) instead
   of letting the spring-back count as income. Add `GameState.reverseSpend(currency, n)`.
3. Online raid brain drop: do not `addBrains` locally when `serverRewards`; register the
   drop as a pending optimistic delta keyed to the settlement (like `withPendingBossTokens`)
   so `reconcile()` keeps it until `/raid/finish` answers. Same for XP/gold already handled.
4. Black Market: on a BUY post cancel/expiry refund, book the balance rise as a spend
   reversal at the call site (pass an `expectedRefund` into the refresh that follows).
5. Tests: `src/GameState.stats.test.ts` — rebase path books nothing; rejected online spend
   nets to zero on both counters; raid drop + interleaved batch books the drop once;
   BM cancel nets to zero. `src/net/economy.v3.test.ts` for the reconcile ordering.
6. **DECISION** (default: accept history). Existing inflated counters cannot be repaired
   (they satisfy the balance identity and the merge ratchets). Alternative: a one-time
   Statistics "reset counters" button. Note the friend leaderboard exposes `brainsEarned`.

**Verify.** Staging: buy a monolith, lose the writer lease (second tab signs in), regain it —
counters unchanged. Run a raid with a farm batch in flight — earned rises by the drop once.

**Deploy.** Worker: no. Migration: no.

**STATUS: DONE (committed 2026-09-04).** Built on ONE primitive instead of the four
mechanisms above: `GameState.unbookCurrency(gold, brains)` gives a booking back (stats
minus, tally baseline shifted by the delta) so the correction that follows books nothing
and the server's balance then counts the real movement once. Applied: (a) rejected /
dependency_failed deltas in `adoptCommandResponse`; (b) BOTH `optimistic.clear()` sites —
not `rebase` as planned: rebase keeps the spend booking, which is wrong when the outbox is
DROPPED (writer lost: `markWriterLost` discards pending) and double-books when it is
RETRIED (conflict: `rebaseAfterConflict` keeps the commands, so the spend books again on
landing) — unbook is exact in both; (c) Black Market cancel of a BUY_ZOMBIE post via
`refreshAuthoritative({ unbook })`, applied INSIDE `adoptGameplay` in the same run as the
refunded balance (a tally shifted ahead of its balance would book the gap on the next
harvest); the cancel response's `order.kind/price/currency` supply the amount, so hud.ts
is untouched. Expiry refunds have no client call site and remain a (small) residual.
Step 3 was moot: `RaidManager` only calls addBrains OFFLINE (the online path hands rewards
to /raid/finish); the raid-adjacent inflation is the stale-response ordering, closed by
`EconomyClient.adoptBase(balance, serverTime)` — a balance stamped earlier than the one on
hand is skipped (batch response, bootstrap, raid finish, epic boss result, gift claim all
pass their serverTime; a balance with no stamp is taken as current). Cached-snapshot boot
left alone: the snapshot is written only at settled points with the stats it matches, so
a rebase there would hide genuine off-device movement. Verified live (local Worker): a
`power.buy` the server refused (`bad_item`) with a -100 optimistic gold booked spent
86→186 in the same tick and returned to 86 after the rejection, earned unchanged, gold
restored. Root 2108 tests green (9 new). Existing inflated counters accepted as history.

---

## 8. Randomised enemy emergence order (ruleset 48)

**Cause / design.** `weightedPopulation` (`src/raid/CombatEngine.ts:349-364`) apportions the
authored table then emits the wave grouped by type; `promote()` spawns in array order
(`BattleSim.ts:2530-2536`). `resolveStageWave` (`src/raid/RaidCatalog.ts:373-387`) already
receives the session-seeded RNG on both client (`RaidManager.ts:406`) and Worker
(`raidVerifier.ts:378`) and pins the result into `config_json`. Bosses never enter the list
and `BattleSim.ts:1020` sorts them last regardless. PvP (`pvp.ts`) and Epic Boss
(`epicBoss/combat.ts:111`) never call `resolveStageWave`, so both stay exempt for free.

**DECISIONS** (defaults): shuffle the exact multiset (counts per fight unchanged) rather than
i.i.d. draws; shuffle `weighted` waves only, leaving McDonnell stages 0-4's explicit
`enemyKeys` (lumberjack last at the tutorial rung) authored.

**Changes.**
1. Export `weightedPopulation` (or move it to `RaidCatalog.ts`); in `resolveStageWave`, for a
   non-`randomBoss` stage with `weighted`, materialise the multiset, seeded Fisher–Yates with
   `rand`, return `{...stage, enemyKeys, weighted: undefined, population: n}`. Keep the
   Robots (`randomBoss`) draw order first so raid 5 stays bit-identical.
2. `src/raid/replay.ts:790`: `RAID_RULESET_VERSION = 48` with a `// v48 —` block naming the
   raids that diverge (2,3,4,7,8,9,10,11; 6 single-type no-op; 5 already random; 1 authored),
   PvP/Epic untouched, and the standard in-flight cost sentence.
3. Docs pinned by `src/docsVersionSync.test.ts`: every "47" → "48" (at least
   `SECURITY.md:29,175,177`, README, CONTRIBUTING, server/README, server/RUNBOOK,
   docs/PROTOCOL_V3_ROLLOUT, docs/EPIC_BOSS_MECHANICS, docs/BLACK_MARKET_IMPLEMENTATION_PLAN).
4. Tests: rewrite `src/raid/raidWaves.test.ts:158-165` (identity → same-seed determinism +
   multiset preserved + boss absent from the list); re-run and re-baseline
   `src/raid/eliteInvasion.balance.test.ts` and `src/raid/projectileScale.test.ts`, updating
   the p* table in `src/raid/eliteInvasion.ts:28-45` if rungs move (move the profile, not
   the threshold — see the elite-refit memory); `fightConfig.test.ts`, `CombatEngine.test.ts`
   should stay green. Add a comment to `server/test/fixtures/circusTruncatedSession.json`
   that its grouped order predates v48.
5. CHANGELOG "### Invasions" entry with the bump line.

**Verify.** `npm test` root; Raid Lab (`/raid-lab.html`) with two seeds shows two orders and
the boss last in both; a staging fight settles (replay matches).

**Deploy.** Worker FIRST, then client (deploy.yml refuses a client ahead of the Worker). Pick
a quiet window: fights in flight at deploy settle as `stale_ruleset` and pay nothing.

---

## 9. Close out — record, then delete this file

Do this last, after every workstream above is committed and verified.

1. `CHANGELOG.md` → "Unreleased (working tree)": one entry per workstream in the existing
   voice (why it was wrong, what changed, what it refuses to do). Invasions entries for #8
   (ruleset 48) and #3; Quality-of-life for #1, #2, #4, #5, #6, #7.
2. `docs/FEATURES.md`: periodic quests are client-authored / server-verified (`:67`);
   `harvest_many` alongside the plow/plant bulking; the emergence shuffle under invasions.
3. `SECURITY.md`: ruleset 48 lines (done in #8); a sentence on `quest.periodic_author`
   verification (level clamp, no re-roll, no quest array on the wire).
4. `server/RUNBOOK.md`: the deletion-failure signature (`account_deleted` log with no 200;
   `purge_failed`) and the schema-parity test as the guard; the brain-ledger forensic
   (`raid_sessions_v3.result_json.balance.brains` trajectory vs `audit_events_v3`).
5. `src/net/protocol.ts` doc comments: periodic quests (`:175-183`) and the bulk list (`:44`).
6. Memory (`~/.claude/projects/.../memory/`):
   - update `lifetime-stats-tally.md` — the balance-diff design now rebases on authoritative
     replaces and reverses rejected spends; history not repaired;
   - update `farm-command-bulking.md` — `harvest_many` added, Worker-first still applies;
   - update `tutorial-portrait-invade-trap.md` — FAB `:not(.raiding)` rule + launch token;
   - update `raid-authority-scope.md` or `attack-list-per-swing-roll.md` — ruleset 48 shuffle
     lives in `resolveStageWave`, PvP/Epic exempt;
   - update `zombie-dex-design.md` — aliased-harvest discovery credit + per-key backfill;
   - add a short `account-deletion-schema-parity.md` (schema.sql vs migrations drift is
     the trap; the parity test is the guard);
   - replace `bug-batch-2026-09-02-plan.md` with a two-line "DONE, see CHANGELOG" pointer
     or delete it and its `MEMORY.md` line.
7. Report the two AGENTS.md items for the batch as a whole: Worker deploy **Yes**
   (#1, #3, #5, #6, #8 — Worker before client for #5, #6, #8); migration **No**.
8. `git rm BUG_BATCH_PLAN_2026-09-02.md` and commit ("Close out the 2026-09-02 bug batch").
