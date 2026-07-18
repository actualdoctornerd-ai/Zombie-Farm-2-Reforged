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
- **Boss specials** run on `bossActionCastTimer` (wind-up) + `bossActionCooldownTimer`.
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
| Zombies vs Robots | 2 s | — | — |
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
  front again. Attacks with it: `OldMcDonnellPunch`, `CorporateBossPunchSpecial`,
  `LumberjackSpecial`, `SpecialBossAttack`, `VideoGameBossPunch` /
  `VideoGameKnightPoke` / `VideoGameMonsterFlail`. **This is the "boss pushes zombies
  back" mechanic.**
- **Stun** (`stun: true`, `stunTimer` seconds) — the zombie can't act for the duration.
  `CorporateBossPunchSpecial` (1 s); the player Explode ability stuns enemies (3 s).
- **Zombie AoE** (`zombieAOE` radius) + **`cantInterrupt`** — the player Bash/Explode
  abilities hit an area and can't be interrupted.
- **`speedMultiplier`** scales the attack/knockback animation speed (Lumberjack 5×,
  Explode 6×).

Other movement mechanics seen: `StageActor jumpToPlayer:` (leap attacks, `jumpLength` /
`jumpHeight`), and the action-string system (`grabZombie` etc. — the Circus Trapeze and
Lawyers cars grab a zombie and drop it).

## Boss special actions (UnitStats.bossActions)

Every boss throws 3–5 **weighted debris** (frequency ≈ sums to 100, escalating damage), at
the `throwSpeed` cadence. Specials add extra hazards with their own cast/cooldown:

- **Aliens** — `alienLaser` (cooldown **2 s**) + `summonBoss` (cast **2 s**), rapid throws (0.2 s).
- **Video Games (Zedzox)** — `turnZombie` (cast **3 s**, *converts your zombie to an enemy*),
  `pixelFire` (cast **2 s**, AoE), + 100-dmg throws.
- **Ninjas** — `wall` (cast **3 s**, hp **1500**, collision 70) — a carrotWall blocking the lane.
- **Robots (BrainBot)** — `telekinesis` (cast **3 s**) + 5 debris types.
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

**3. If the tier is empty, walk DOWN** to commoner tiers until one has eligible items.
**4. Pick uniformly** among that tier's eligible alternatives.

A tier-0 **"Bonus Gold"** pick pays gold instead of an item:
`getBonusGoldLootForStageLevel:` = **stageLevel × 100**.

(The `getTotalLootWeight:` / `weight`-key path exists but feeds the *brains* table, not
items — see below.)

**Brains ARE a real table** — `gameplayParameters.brainDropRateInvasion`
(read by `buildStandardBossLootTable`):

| Amount | Chance (lower → upper) |
|---|---|
| 10 brains | 2.5% → **5%** |
| 30 brains | 1.0% → **2%** |
| 50 brains | 0.5% → **1%** |

The chance scales with the raid's level from the lower limit up to the upper ("optimal")
limit, reaching it at `epicBossLootLevelWithOptimalChances` = **level 20**. This replaces
the reimpl's old flat 5% / 10-brains.

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
- **Throw cadence + `throwingDisabled`** — from stage `throwSpeed` (already wired).
- **Boss specials** — data-driven cast/cooldown scheduler:
  - `alienLaser` → a fast straight bolt at a forward zombie.
  - `pixelFire` → AoE chip to all fighting zombies.
  - `turnZombie` → removes your front zombie (turned against you).
  - `telekinesis` → a heavy single-target hit.
- **Obstacle hazards** — Beach/Tree World/Valentine spawn crossing obstacles every
  `obstacleSpawnTimer` up to `obstacleLimit`; `initialSpawnClass` drops one at the start
  (the beach Crab). They traverse the lane and damage zombies they touch.
- **Knockback + stun** — an enemy attack with `knockBack` shoves the struck zombie back
  down the lane and re-slots it to the **back of the formation** (it must re-advance);
  a `stun` attack freezes it for `stunTimer`. Derived per-enemy from `Attacks.json` in
  `buildEnemyUnits`; applied in `BattleSim.tryAttack`. Verified headlessly (interrupted /
  frozen zombies deal measurably less damage over a fixed window).
- **Brain drop table** — `RaidManager.rollBrainDrop` implements the 10/30/50-brain table
  above, level-scaled toward the upper chances (replaces the old flat 5%).
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
  It sweeps in from the LEFT across the combat band, seizes the rear-most deployed zombie (→
  `grabbed` state, inactive), holds ~1 s, then RISES to carry it off. The player **taps it (100/tap,
  1000 HP → ~10 taps, tapDelay 0.25 s)**; killed → the zombie **drops** back and resumes fighting;
  escaped off the top → the carried zombie **dies**. Renders as a tappable sprite with an HP bar
  (`RaidScene.syncGrabbers`); the carried zombie rides up via `mapProjY`. Verified headlessly
  (`BattleSim.hazards.test.ts`: grab / tap-to-free / escape-kills / tap-cooldown / wall-tap).
  NOTE: the old crossing-`HazardConfig` "grab" (a ~2.5 s stun + knockback dot) was an agent-added
  fabrication — NOT in the base game — and is retired; `hazardOf` stays disabled. The Lawyers cars
  (`hasGrab`, no shipped sprite) reuse `grabZombie` but different motion and are NOT wired.

**DEFERRED:**
- The Circus trapeze + both walls ship real sprites (`hazard_trapeze_girl.png`, `carrotWall.png`,
  `junkWall.png`). The Beach/Tree World/Valentine crossing OBSTACLES stay disabled (`hazardOf`
  returns null) pending a non-fabricated model + atlas frames; the Lawyers cars aren't wired.
- Round length is the observational 3:00 default; not sourced from a named data field.

(Pirate / Ninja / City (Lawyers) stage art is no longer a gap — the rigs were recovered and
now ship; see "Stage sprite sheets … RECOVERED" above.)
