# Raid timing & hazards — ground truth + implementation

Recovered from the iOS binary (`ZFFightMan` — the fight controller) plus the per-raid
config in `Enemies.json` / `UnitStats.json`. Method: `BINARY_RE_METHODOLOGY.md`.
Implemented in `zombiefarm/src/raid/` (BattleSim is the authority; RaidScene renders it).

## The fight loop (ZFFightMan)

`update:` → `updateTimer:` → `throwProjectile:` / `spawnObstacle:` / boss-action scheduler.

- **Round is a countdown → enrage.** `updateTimer:` subtracts `dt` from a `fightTime` timer;
  at 0 the boss **enrages** (`showEnrageTimer`). Reference footage shows a **3:00** round.
  (The exact value is an ivar, not a named data field — 180 s is observational.)
- **Boss throws** are gated by `allowedToThrowProjectile` at a cadence of `throwSpeed`
  (binary base **0.75 s**, overridden per-raid/per-wave by the data).
- **Obstacles** spawn every `obstacleSpawnTimer` s, up to `obstacleLimit` on screen.
- **Boss actions are ONE budget.** `bossUpdate:` makes a single weighted roll over the whole
  `bossActions` array each cycle and dispatches on the chosen name, so throws COMPETE with
  specials for the same slot rather than running on a parallel timer. A `throw` arms
  `bossActionCooldownTimer = throwSpeed × 60` frames; cast-based actions arm
  `bossActionCastTimer = castTime × 60`. See `ENEMY_DAMAGE_RECOVERED.md`.
- Difficulty ladder: `stageSettings[playerLevel − recommendedLevel]` overrides
  `throwSpeed` / `throwingDisabled` / `population` / `enemyKeys` / `bossKey`.

## Per-raid timing + hazards (Enemies.json)

`throwSpeed` = seconds between boss throw attempts (lower = more spam).

| Raid | Throw cadence | Obstacles (limit / every) | Stage-actor hazard |
|---|---|---|---|
| Old McDonnell's Farm | 2 s | — | — |
| Zombies vs Lawyers | 5 s | — | Cars/vans cross & `grabZombie` |
| Zombies vs Pirates | 8 s | — | ship (decorative) |
| Zombies vs Ninjas | 2 s | — | — |
| Zombies vs Robots | 2 s (Bro-Bot as boss: **1 s**, reimpl ruleset 49 — see below) | — | — |
| Zombies vs Aliens | **0.2 s** | — | — |
| Summer Break (Beach) | 1.5 s | **2 / 5 s** turtles + a Crab (initial) | — |
| Zombies vs Circus | 1.5 s | — | Trapeze Artist `grabZombie` then drops |
| Zombies vs Video Games | 2 s | — | — |
| Tree World | — | **3 / 20 s** turtle obstacles | — |
| Valentine's Day | — | **1 / 10 s** geyser walls | — |

## Knockback, stun, and other attack effects (Attacks.json)

Each attack in `Attacks.json` carries effect flags, applied by the combat code
(`Actor knockBackBy:force:`, ivars `knockBackSpeed` / `knockBackPoint`):

- **Knockback** (`knockBack: true`) — the struck zombie is **interrupted** (its
  `damageIn:` / `fightAttack:` are unscheduled) and, per the binary,
  **`setZombieToLastIndex`** — sent to the **back of the line**. It must charge to the
  front again. Attacks with it in the SOURCE: `OldMcDonnellPunch`,
  `CorporateBossPunchSpecial`, `LumberjackSpecial`, `SpecialBossAttack`,
  `VideoGameBossPunch` / `VideoGameKnightPoke` / `VideoGameMonsterFlail`. **This is the
  "boss pushes zombies back" mechanic.**
- **Stun** (`stun: true`, `stunTimer` seconds) — the zombie can't act for the duration.
  `CorporateBossPunchSpecial` (1 s); the player Explode ability stuns enemies (3 s).
- **DELIBERATE DIVERGENCE (ruleset v17)** — the reimplementation strips `knockBack` from
  `CorporateBossPunchSpecial`, so the Lawyers boss's Double Punch (40%) **stuns only**.
  The source flags that attack both ways, but his page lists his special as a stun, and
  it is the ONLY `stun: true` attack in the table — leaving the shove on made him play as
  yet another push-back boss. The override lives in `ATTACK_OVERRIDES`
  (`tools/prep_raids.py`) so regenerating `attacks.json` cannot undo it. Don't "fix" it
  back to the plist.
- **Zombie AoE** (`zombieAOE` radius) + **`cantInterrupt`** — the player Bash/Explode
  abilities hit an area and can't be interrupted.
- **`speedMultiplier`** scales the attack/knockback animation speed (Lumberjack 5×,
  Explode 6×).

Other movement mechanics seen: `StageActor jumpToPlayer:` (leap attacks, `jumpLength` /
`jumpHeight`), and the action-string system (`grabZombie` etc. — the Circus Trapeze and
Lawyers cars grab a zombie and drop it).

## Boss special actions (UnitStats.bossActions)

Every boss has 3–5 **weighted debris** throws (frequency ≈ sums to 100, escalating damage).
Throws and specials are rolled from the SAME weighted table, so a boss whose list mixes them
throws proportionally less often — for most bosses every entry is a `throw`, and the budget
degenerates to a plain `throwSpeed` interval. The specials:

- **Aliens** — `alienLaser` (cooldown **2 s**) + `summonBoss` (cast **2 s**), rapid throws (0.2 s).
- **Video Games (Zedzox)** — `turnZombie` (cast **3 s**, *converts your zombie to an enemy* — the
  reimpl now does exactly that; see below), `pixelFire` (cast **2 s**; the source data labels it
  AoE, but the recovered behaviour is a single-target one-frame interrupt, which the reimpl
  deliberately replaces with a real burn — see the implementation note below), + 100-dmg throws.
- **Ninjas** — `wall` (cast **3 s**, hp **1500**, collision 70) — a carrotWall blocking the lane.
- **Robots (BrainBot)** — `telekinesis` (cast **3 s**) + 5 debris types.
- **Robots (Bro-Bot)** — no special action in the data; the wiki's "incredible throwing arm" (about
  one throw a second against the raid's 2 s) is reimplemented as `RaidCatalog.BOSS_THROW_PACE`
  (x0.5 on the interval, applied after the ruleset-34 damage sizing and before the elite profile,
  in both throw builders). JunkBot and BrainBot keep the raid cadence.
- Farm/Pirate/City — pure escalating throws (McDonnell 6/12/18; Pirate 12.5/25/50; City 12/24/36).

## Loot & drop tables — RECOVERED (ground truth)

The item-loot algorithm is fully recovered from `ZFFightSummary rollForDrop:` +
`lootTableFromCategory:` in the binary. A win rolls **exactly one** item drop:

**1. Pick a rarity tier (0–5).** `Enemies.json` `loot` is 6 tiers per raid — tier 0
common ("Bonus Gold"), tier 5 rarest (the signature decoration). The tier is chosen by
`roll = arc4random() % 100` (as a fraction) against **cumulative thresholds that shift
rarer as the loot-luck bonus rises**. The luck bonus is `[ZFFightMan bonusRoll]` — the
number of **Golden Dice** spent, *reset to 0 (`setBonusRoll:0`) after each roll*:

| bonus (dice) | tier thresholds (roll <) → tier | reachable tiers |
|---|---|---|
| 0 | .09→t0, .24→t1, .84→t2, .92→t3, else t4 | 0–4 (9/15/60/8/8 %) |
| 1 | .14→t1, .74→t2, .84→t3, .92→t4, else t5 | 1–5 (14/60/10/8/8 %) |
| 2 | .59→t2, .79→t3, .89→t4, else t5 | 2–5 (59/20/10/11 %) |
| ≥3 | n=bonus−3; r′=roll+0.10n, d=0.9ⁿ; r′<0.39d→t3, r′<0.79d→t4, else t5 | 3–5 |

So one die makes the common tiers impossible and puts the rarest tier on the table;
each further die compresses the roll toward tier 5. (Tier 2 — the boosts like
Insta-Plow — is the 60 % "normal" drop with no dice.)

**2. Filter the tier to eligible items** (`lootTableFromCategory:`): drop `unique`
items already owned (19 items: banners + signature decorations), drop `limit`-capped
items at their cap (only `Rusty Fragment`, limit 3), skip the special-cased
`Rusty Fragment`. `Drops.json` carries these flags (`unique` / `limit`) but **no
probability field** — the probability is entirely the tier table above.

*Owned* means all three places an item can sit: the unclaimed **Received** bucket, the
**shed**, and the **object it becomes once placed** (its `drops.json` `tile`) — the
binary's `doesOwnItem:` / `numberOfItemInStorageWithKey:` pair. Getting this wrong
silently disables `unique` for the whole game, because claiming a drop is how a player
uses it and claiming empties Received. Both sides share one rule: `ownedLootCounter`
(server `loot.ts`) and `RaidManager.rollLoot` via its `placedCount` hook.

**3. If the tier is empty, walk DOWN** to commoner tiers until one has eligible items.
**4. Pick uniformly** among that tier's eligible alternatives.

A tier-0 **"Bonus Gold"** pick pays gold instead of an item:
`getBonusGoldLootForStageLevel:` = **stageLevel × 100**.

**Boost drops can pay a bundle — a deliberate divergence.** The source hands over one of
whatever boost the tier names. **Insta-Grow drops ten at a time** instead
(`RAID_BOOST_BUNDLE` in `src/raid/lootBundles.ts`), because one Insta-Grow is a poor prize
for a whole invasion; every other boost still drops singly, and the table applies to the RAID
roll only — buying still grants `perPurchase`, claiming from Received still grants one. Both
settlement paths read the one table (`server/src/loot.ts` `resolveLoot` online,
`RaidManager.finishRaid` offline) and the results panel labels it "Insta-Grow x10".

(The `getTotalLootWeight:` / `weight`-key path exists but feeds the *brains* table, not
items — see below.)

**Brains ARE a real table** — `gameplayParameters.brainDropRateInvasion`
(read by `buildStandardBossLootTable`):

| Amount (shipped) | Recovered amount | Chance (lower → upper) |
|---|---|---|
| **1 brain** | 10 | 5% → **10%** |
| **3 brains** | 30 | 2% → **4%** |
| **5 brains** | 50 | 1% → **2%** |

The chance scales with the raid's level from the lower limit up to the upper ("optimal")
limit, reaching it at `epicBossLootLevelWithOptimalChances` = **level 20**. These are the
recovered base rates with the live game's 2× invasion-brain multiplier applied
(`BRAIN_DROP_RATE_MULTIPLIER = 2`, `BRAIN_OPTIMAL_LEVEL = 20` in `src/raid/brainDrops.ts`).

**Amounts diverge from the recovered source on purpose.** The brainflation revert made a brain
~10x more valuable, so the shipped stacks are 1/10 of the recovered 10/30/50 — the drop
*chances* are untouched. Tiers roll rarest-first, so a boss awards at most one stack. Online
rolls are pinned at start and credited only after replay verifies that the boss was defeated.

**Pity floor — a second deliberate divergence (no ZF2 equivalent).** At the top of the table
a boss win pays brains only ~15% of the time, so ordinary bad luck can run very long. After
`BRAIN_PITY_INVASIONS = 8` brain-eligible invasions with no brain, the next one's zero roll is
floored to **1 brain** (`rollBrainDropWithPity` in `src/raid/brainDrops.ts`). Only a WIN against
a boss counts toward the streak — a loss pays nothing, and the low-level McDonnell's stages
field no boss, so neither can roll brains. The counter lives server-side in
`raid_state_v3.brain_dry_streak` (offline: `GameState.brainDryStreak`, saved under `raids`).

The floor is **deliberately invisible**: the counter is never sent to the client, and nothing
in the UI names it, counts it out, or marks a floored drop differently from a rolled one. Keep
it that way when touching the result panel or the fight's brain pickup.

**Rare zombies are a separate roll, with the same treatment.** Nine raids independently roll a
special zombie on a win (`src/raid/zombieDrops.ts`), on ONE rate ladder read off the raid's
recommended level — about 1%, a tenth of a percent more per story invasion: Old McDonnell's →
Old McZombie and Summer Break / Tree World / Valentine's Day → Diver / Forest / Teddy at **1%**;
Lawyers → Deputy **1.1%**, Pirates → MerZombie **1.2%**, Ninjas → Ninjombie **1.3%**, Robots →
Zombie Bot **1.4%**, Aliens → Zastronaut **1.5%**. The four faction invasions pay a **pair**: an
ELITE (Brain Ticket) win rolls for the promoted zombie *instead* — Sheriff / Poseidon / Master
Ninjombie / Omega Zombie Bot at **double** the raid's ordinary rate (2.2 / 2.4 / 2.6 / 2.8%,
`RAID_ELITE_ZOMBIE_DROPS`, `ELITE_PRIZE_RATE_MULTIPLIER`). On those four the doubled rate IS the
elite premium: `ELITE_BRAIN_LUCK` is deliberately not stacked on top, or the sheriff would be
eight times as common as the deputy. Single-prize raids keep the 4x (the Zastronaut reaches 6% on
a ticket). In the source these eight were alternate Epic Boss prizes for events that were never
built. `zombieDrops.test.ts` pins the ladder to the recommended-level order.

**Golden Dice raise that rate too — a deliberate divergence.** In the source the dice touch only
the item tier roll; here each die spent adds one further base rate to the rare-zombie chance
(`ZOMBIE_LUCK_PER_DIE = 1`, so 1 die doubles it, 2 dice triple it), matching what the boost's own
description already promises about "rare items". Old McZombie runs 1 → 2 → 3 → … → **6%** across
the five dice a full six-tier loot table allows (`maxLuckTiers`); the harder invasions climb the
same way from their own rung (the Aliens' Zastronaut 1.5 → **9%**).
The count is the same PINNED one the item roll uses — charged at `/raid/start`, never taken from
the finish request — and it is clamped (`ZOMBIE_LUCK_DICE_CAP`) so a forged count can't make the
drop certain.

**The rare-zombie roll also has its own pity**, counted **per prize**: after `RAID_ZOMBIE_PITY_WINS = 100` wins of *that* raid
without *its* zombie, the next win of it hands the zombie over
(`rollRaidZombieDropWithPity`). Winning a different raid does nothing for it, a loss is not a
completion, and receiving the zombie (rolled or guaranteed) resets that raid's count to 0 — so a
collector starts a fresh 100 rather than being handed duplicates. A paired raid keeps TWO streaks
(`raidZombieDryKey`): ordinary wins under `"<raidId>"` and elite wins under `"<raidId>:elite"`, so a
hundred dry Lawyers wins guarantee the Deputy, never a Sheriff on the first ticket. Stored server-side as
`raid_state_v3.zombie_dry_json` (`{"<raidId>": <dryWins>, "<raidId>:elite": <dryWins>}`), offline as
`GameState.zombieDryWins`. Same secrecy rule as the brain floor: never sent to the client, never
surfaced, and a guaranteed zombie arrives through the ordinary reward row.

Gold: `getStandardGoldLootForStageLevel:` + `goldDistributionLevelCoefficient` = 2.3
(win gold scales with level); wiki figures still used where exact source gold is unmapped.

## Stage sprite sheets (Pirate / Ninja / City-Lawyers) — RECOVERED

**Resolved.** All three raids now render decoded side-view rigs instead of flat portrait
tokens. The parts ship as `public/assets/raids/enemies/parts/{Pirate,Ninja,City}StageActor*.png`
and the bone/anchor rig lives in `public/assets/raids/enemies/models.json` (keys
`PirateStageActorBoss/Scallywag/Swashbuckler`, `NinjaStageActorBoss/Boy/Girl`,
`CityStageActorBoss/CrazedWorker/Lawyer`), driven by `EnemyActor`.

Historical context (why a custom recovery was needed):

- The atlas **PNGs existed** — `assets/spritesheets/stages/{Pirate,Ninja,City}Stage.png` (all 256×256).
- Their **TexturePacker frame plist was genuinely absent** — not an extraction miss. Both the
  1.0 *and* 0.60 ipas ship the `.png` with **no `.plist`** (every other stage — Circus, Beach,
  Alien, Robot, … — ships `.png` + `.plist`/rig). So the name→rect mapping was lost from the build.
- The **frame names survived in the binary** (`scallywagBat`, `swashbucklerSword`, the
  `*StageActor*` classes), so the parts were known by name — just not their positions.
- **Recovery path used:** the binary's `initSpriteDictionary` bone layout was decoded to place
  each named part, producing the rigs now in `models.json`. (The earlier alpha-island auto-slice
  idea — Pirate ≈ 12 islands, Ninja ≈ 20, City ≈ 9 — was superseded by the binary rig decode.)

## Implementation status (zombiefarm)

Data: `tools/prep_raids.py` carries `obstacleLimit`/`obstacleSpawnSecs`/`obstacleActors`/
`initialSpawnClass`; the full `bossActions` (incl. `castTime`/`cooldownTime`/`hp`) already
flow through `enemy_stats.json`. `RaidManager.beginRaid` builds `bossSpecials` + `hazard`
configs and threads them to the scene.

**DONE (in `BattleSim`, verified headlessly):**
- **Round timer + enrage** — 3:00 countdown; on expiry throws come 2× faster and the boss
  hits 1.5× harder. Shown as a top-center HUD countdown that flips to "⚠ ENRAGED".
  **Caveat:** `ENEMY_DAMAGE_RECOVERED.md` establishes that no `enrage` field exists in any
  plist — this mechanic is an invention that was kept deliberately. Treat the 2×/1.5× figures
  as tuning, not ground truth.
- **Throw cadence + `throwingDisabled`** — from stage `throwSpeed`.
- **Shared action budget** — REWORKED at ruleset v10: throws and specials are one pre-rolled
  weighted choice per cycle (`BattleSim` `actionCd` / `nextAction` / `actionCount`), matching the
  source's single `rollAgainstFrequencyInArray:` over `bossActions`. An action the boss cannot
  currently perform (a second wall, a summon past the cap) is re-rolled at no cost. The specials:
  - `alienLaser` → a fast straight bolt at a forward zombie (`ALIEN_LASER_DAMAGE = 200`).
  - `pixelFire` → recovered as a **one-frame interrupt on a single random zombie** (~0.083% of max
    HP), NOT an AoE burn (corrected at ruleset v9). **Ruleset v31 deliberately diverges**: the
    recovered 5 %/s rate now runs for `PIXEL_FIRE_BURN_MS`, the burning zombie panics on the spot
    with its arms up, and the player taps the fire out (`fireTap`). See
    `ENEMY_DAMAGE_RECOVERED.md`.
  - `turnZombie` → **converts** your front zombie into a pixel zombie (ruleset v31). It used to
    deal the victim its own remaining HP, which is what players saw as zombies dying suddenly and
    for no reason. The victim is now `taken` (alive, a survivor, not a loss) and the pixel zombie
    stands mid-lane until tapped apart, which hands the zombie back (`turnedTap`). It blocks
    nothing, is not a melee target, and does not gate the win — its authored body is a million hit
    points. See `ENEMY_DAMAGE_RECOVERED.md`.
  - `telekinesis` → **zero damage**: knockback + stun only. It is not a heavy hit.
- **Beach crab** — `initialSpawnClass` identifies the `BeachStageActorCrab`, and
  `obstacleSpawnTimer` / `obstacleLimit` set its cadence and concurrent cap. It grabs and carries
  a zombie off rather than damaging it (see the crab bullet below). This is the **only** consumer
  of the obstacle fields; the generic crossing-obstacle hazard that once used them was a
  fabrication and has been removed — see "REMOVED" at the end of this document.
- **Knockback + stun** — an enemy attack with `knockBack` shoves the struck zombie back
  down the lane and re-slots it to the **back of the formation** (it must re-advance);
  a `stun` attack freezes it for `stunTimer`. Derived per-enemy from `Attacks.json` in
  `buildEnemyUnits`; applied in `BattleSim.tryAttack`. Verified headlessly (interrupted /
  frozen zombies deal measurably less damage over a fixed window).
- **Brain drop table** — `src/raid/brainDrops.ts` (`rollBrainDrop`) implements the 1/3/5-brain
  table above, level-scaled toward the upper chances (replaces the old flat 5%).
- **Item loot tier-weighting** — `src/raid/LootTable.ts` (`rollLootTier`) encodes the
  bracket→threshold→tier tables above; `RaidManager.rollLoot` picks one tier from the
  luck bracket (`dice`), filters to eligible items (unique-owned / limit via the new
  `drops.json` `unique`/`limit` fields), walks down on an empty tier, and picks
  uniformly. "Bonus Gold" pays `recommendedLevel × 100`. Replaces the old flat
  equal-chance-over-all-tiers pool. Golden Dice now raise the **rarity bracket** (one
  tier rarer per die) rather than granting extra rolls. Verified headlessly: 0-dice
  distribution is 60 %/15 %/9 %/8 %/8 % across tiers 2/1/gold/3/4 with tier 5
  unreachable; 5 dice put tier 5 at ~56 %; owned uniques never re-drop and force a
  walk-down. (Divergence: decorations already *placed on the farm* aren't tracked as
  inventory, so a placed unique can still re-drop — only received/stored copies filter.)
- **`summonBoss`** — the boss reinforces with a copy of the wave's minion (capped at 3 per
  fight), which emerges through the normal queue while the boss stays perched behind it.
- **`wall` (carrotWall / junkWall)** — REWORKED 2026-07-17 to be faithful. The boss drops a
  1500-HP blocker (`carrotWall` Ninja / `junkWall` Robot); zombies attack it AND the player can
  **tap it to chip 75/tap** (ground truth `ZFFightWall ccTouchEnded → damage: ≈ maxHp/20`), and it
  **shrinks as its HP drops** to a 0.5 floor (`setScale`). `RaidManager.summonWallTemplatesOf` +
  `bossSpecialsOf` now scan the whole stage roster for the `wall` action, so the Robot **junkWall**
  (which lives on the JunkBot minion, not the BrainBot boss) is found and cast; the wall template
  uses the action's own sprite. Sim: `SimUnit.isWall` + `BattleSim.tapWall`.
- **Trapeze Artist grab (Circus)** — REWRITTEN 2026-07-17 as the real carried-grab minigame
  (`BattleSim` `SimGrabber` / `stepGrabbers` / `tapGrabber`, config from `RaidManager.grabberOf`).
  It swings in across the combat band, seizes a selected zombie (→ `grabbed` state, inactive),
  holds ~1 s, then RISES to carry it off. Successive appearances **alternate the entry side**
  (`swingStartDeg` 0°/180° by sequence) and aim at a chosen victim rather than always the
  rear-most (`contactDeg`, `targetId`). The player **taps it (100/tap, `RESCUE_HAZARD_HP` 667 →
  7 taps, tapDelay 0.25 s)**; killed → the zombie **drops** back and resumes fighting; escaped
  off the top → the carried zombie **dies**. Renders as a tappable sprite with an HP bar
  (`RaidScene.syncGrabbers`); the carried zombie rides up via `mapProjY`. Verified headlessly
  (`BattleSim.hazards.test.ts`: grab / tap-to-free / escape-kills / tap-cooldown / wall-tap).
  NOTE: the old crossing-`HazardConfig` "grab" (a ~2.5 s stun + knockback dot) was an agent-added
  fabrication — NOT in the base game — and is retired. The Lawyers cars
  (`hasGrab`, no shipped sprite) reuse `grabZombie` but different motion and are NOT wired.
- **Beach crab carry-off (Summer Break)** — WIRED (`RaidManager.crabOf`, `BattleSim` `SimCrab` /
  `stepCrabs` / `tapCrab`, `RaidScene.syncCrabs`, sprite `hazard_beach_crab.png`). The
  `BeachStageActorCrab` wanders the lane, grabs a zombie, holds 2 s, then hauls it off-screen.
  Same tap-to-rescue economy as the trapeze (667 HP, 100/tap → 7 taps); `spawnMs` and `limit`
  come from the raid's `obstacleSpawnSecs` / `obstacleLimit` (5 s, 2). A zombie carried off is
  **alive but out of the fight**, not killed. Tests: `BattleSim.hazards.test.ts`.

**CLIENT-ONLY (important):** the crab and the trapeze run only on the client. Since raid ruleset
version 6 `raidVerifier.grabberOf` returns `null`, so the server replays the *un-harassed* fight
as an optimistic ceiling and the player concedes the difference via `clientWin`/`clientLosses`.
Those concessions are merged one-way and can only worsen the submitting player's own result.
See `../../SECURITY.md`.

**THE WALL IS NOT CLIENT-ONLY.** It is a real enemy unit in the pinned config
(`raidVerifier.summonWallTemplatesOf` → `createPinnedSim`), so BOTH simulations spawn it and both
must agree on its hit points. Until ruleset 14 the player's 75-per-tap chip was applied on the
client and never transcribed: one tap and the verifier was fighting a wall the player had already
knocked down. The concession path only absorbs that on a conceded LOSS, so a **won** Ninja or Robot
invasion was rejected outright (`illegal_ability` / `truncated_transcript`) and the player's farm
was resynced back to before the fight. Ruleset 14 transcribes every tap as a `wallTap` input
(`replay.ts` → `sim.tapWall`, rejected as `illegal_wall_tap` if no live wall takes it). Any future
mechanic that lets the player touch a verifier-simulated unit must be transcribed the same way.

**REMOVED — the crossing-obstacle hazard was a fabrication.**
A ground-crossing obstacle/grab mechanic (a sprite or dot sliding down the lane, damaging or
seizing zombies) was implemented during development and is **not a base-game mechanic**. It has
been deleted outright: `HazardConfig`, `RaidManager.hazardOf`, `BattleSim.spawnObstacle` /
`stepObstacles`, the `hazard` / `crossing` / `grab` projectile flags, and the `obstacleTimer`
snapshot field are all gone. It was previously described here and in the README as "disabled
pending better visual integration", which wrongly framed an invention as deferred work. Do not
reintroduce it without ground truth from the binary.

Note the distinction from the recovered data above: `obstacleLimit` / `obstacleSpawnTimer` /
`initialSpawnClass` **are** real fields in `Enemies.json`, and they are still read — but only to
drive the Beach crab. What was never established is a faithful crossing-obstacle behaviour.

**DEFERRED:**
- The Circus trapeze, the Beach crab, and both walls ship real sprites (`hazard_trapeze_girl.png`,
  `hazard_beach_crab.png`, `carrotWall.png`, `junkWall.png`). The Lawyers cars (`hasGrab`, no
  shipped sprite) are still unwired.
- Round length is the observational 3:00 default; not sourced from a named data field.

(Pirate / Ninja / City (Lawyers) stage art is no longer a gap — the rigs were recovered and
now ship; see "Stage sprite sheets … RECOVERED" above.)
