# Zombies vs Aliens (raid 6) — recovered from the binary

Source of truth: the ARMv7 `ZF2R` executable (`ZF2R_extracted/app-internals/executable/ZF2R`),
`AlienStage.plist` / `AlienStageElements.plist`, `alienLaser.plist`, and `UnitStats.json`.
Disassembly via `ZF2R_extracted/tools/re/objc_disasm.py`; the annotated variants used here
(`disas2.py` for PC-relative NSString/float literals, `findsel.py`, `xref.py`) were added
alongside it in the same pass.

Everything below is transcribed from compiled code. Where the reimplementation disagreed,
the delta is called out.

---

## 1. The laser targets the FRONT LINE, not the healers

**`-[ZFFightMan shootBullet:from:]` (0x5ea74)** builds a fresh candidate array by walking
`self.zombies` and keeping each one that is either

* `isInMeleeRange` — and `-[ZombieActor isInMeleeRange]` (0x4f538) is
  `actorIsFighting || (position == destination && knockBackPoint == 0 && state ∈ <tbb set>)`,
  where **`-[Actor actorIsFighting]` (0x3e2b8) is exactly `state ∈ {11, 12, 13}`**; or
* `state ∈ {10, 31, 32}` — 31/32 being the two states `damageIn:` also exempts from the
  lineup-depth penalty (see `COMBAT_STATS_RECOVERED.md`), i.e. mid special attack.

It then picks **one at random**:

```
idx = (arc4random() % 100) / 100.0f * [candidates count]
[bullet shootBulletAt:[candidates[idx] position] from:bulletPos]
```

An **empty candidate list means no bullet at all** — and `-[ZFFightMan
allowedToShootBullet]` (0x5e918) applies the same predicate as a gate before the action is
even chosen, on top of requiring both boss-action timers to be ≤ 0.

So the saucer is a front-line weapon: it burns whoever is toe-to-toe with the wave, and it
holds fire entirely while the army is still walking up.

**This is the opposite of the boss THROW.** `-[ZFFightPhysics getThrowTarget]` (0x6c970)
walks the same array but keeps the **last** zombie passing
`isZombieAllowedToThrowAt:` (states 10, 12, 13, 28, 33, 35) — the deepest one — which is why
`BattleSim.throwTarget()` picks the rear-most deployed unit. Using that selector for the
laser was the bug: every alien bolt landed on the Garden healers massed at the support line.

> **Open item, not fixed here.** `getThrowTarget` has a *higher* priority branch than the
> rear-most walk: the first zombie in `zombies` order whose `state == 10` short-circuits the
> loop and wins outright (state 35 is a weaker second preference). Since index 0 is the
> front-most slot (the `index / 5` depth band), that means throws should often land on the
> FRONT-most zombie in that state rather than the back line. Left alone deliberately — it
> changes every throwing raid's balance, and the alien boss has no `throw` at all.

**Fixed:** `BattleSim.laserTarget()`, and an `alienLaser` case in `canPerform`.

> **DELIBERATE DIVERGENCE (raid ruleset 45): the candidate list is every DEPLOYED zombie,
> not only the engaged ones.** The random draw above is kept exactly — same roll, same
> salt, one candidate — and so is the empty-list refusal; only the set it draws from is
> wider. Two reasons the recovered reading could not stay. First, it can stall the raid:
> a Garden zombie holds at a fixed absolute x (`GARDEN_STATION_X`, itself a divergence)
> and closes on nothing, so it is never `isInMeleeRange` — an army of nothing but healers,
> or one whose last ordinary body has died, hands the saucer an empty list on *every*
> cycle, and the fight runs out the four-minute cap with neither side able to reach the
> other. Second, even in ordinary fights the engaged-only list goes empty for seconds at a
> time (between waves, and while the front rank crosses the lane), and a boss that
> visibly stops shooting reads as broken rather than as faithful.
>
> This is NOT a return to the `getThrowTarget` bug described above. That selector picks the
> rear-most deployed zombie *every time*, so every bolt of the fight lands on the support
> station; a random draw puts one bolt in N on a healer with N zombies deployed. Measured
> on the balance stick: weakest-winning-army 0.977 → 0.991 ordinary, 2.119 → 2.206 elite,
> no win or loss flipped at any rung. On the projectile stick (one healer in an 8-strong
> army) the healer goes from surviving the fight to dying to the laser during it.

## 2. Bolt physics

| Quantity | Ground truth | Where |
| --- | --- | --- |
| Damage | flat **200.0f**, only if `target.fightData.hitPoints > 0` | `-[AlienStageBullet collidedWith:]` 0x6aee4 |
| Speed | `setSpeed: 3.0`, integrated as `pos += unit * (dt * 60 * speed)` = **180 pt/s** | `-[AlienStageBullet init]` 0x6ac5c, `-[ZFBulletWrapper bulletTime:]` 0x6aa50 |
| Aim | `[target position]` read ONCE at fire time, normalized — **no lead, no homing, no gravity** | `-[ZFBulletWrapper shootBulletAt:from:]` 0x6a9d4 |
| Muzzle | 50/50 roll between `(-55, +2)` and `(+5, -5)` off the boss | `-[AlienStageActor createBullet]` 0xc7370 |
| Fire cue | `alienLaser.wav` | `AlienStageBullet init` |
| Hit cue | `stun.wav` + `alienLaserHit.plist` burst | `collidedWith:` |

The raid stage is authored at **480×320 points**; `BattleSim`'s field is 1000×560, so
`SIM_PER_SOURCE_X = 1000/480` converts both the speed (180 → 375 sim px/s) and the muzzle
offsets. Cocos is y-up, so muzzle y is negated.

**Fixed:** `LASER_SPEED` was a guessed 900 (2.4× too fast); the bolt was led like a lob; it
launched from the bare boss origin; and it had no sprite key, so it rendered as the generic
orange "no art" hazard dot. Bolt art (`raids/images/alienLaser.png`) is the emitter baked
into one sprite: 5 additive `ring01FX` quads, 32 px, fading red `(1,0,0)` → yellow `(1,1,0)`
over a 0.2 s lifespan.

## 3. The boss rides a UFO — and he is SMALL inside it

`-[AlienStageActorBoss initSprite]` (0xc68b8):

* attaches the six paper-doll parts (`bossArmF/ArmB/FootF/FootB/Body/Face` in attachment
  slots 2/3/4/7/0/1), with `bossBody` as the root bone;
* loads `bossShip.png` and `bossShipBack.png` from **AlienStageElements.png** into
  `bossShipFront` / `bossShipBack`;
* ends with **`[rigRoot setScale: 0.58]`** (`0x3f147ae1`).

The **ship halves are not scaled by that 0.58** — only the rig root is. So the composed boss
is exactly the saucer's 140×128 art box, with a 96.8 px pilot sitting inside the canopy.

`-[AlienStageActorBoss movementUpdate:]` (0xc6e20) keeps both halves at
`actor.position + rigScale * body.position`, and `bossUpdate:` (0xc6bb8) attaches the front
half at `zOrder + 1` and the back half at `zOrder - 1` on state 19, then removes **both** on
state 9.

> **CORRECTED 2026-08-13.** This section originally called state 9 "death". It is not — state
> 9 is the LANDED, fighting-on-the-ground state (see §7.1). The saucer is dropped the moment
> the boss touches down, not when it dies. Actual death is state 100 → 101.

Authored anchors (cocos, y from the bottom): `bossShip` `(0.53, 0.25)`, `bossShipBack`
`(0.56, −0.75)`. `bossBody`'s rig offset is `(0, 3)`, so the ship anchor sits 1.7 px above
the boss's feet.

**Fixed:** `RaidScene`'s UFO block was explicitly eyeballed — it fitted the *pilot* to
`BOSS_H` (195) and drew the saucer at 156, i.e. the alien was ~32 % too big and the canopy
~20 % too small, so his head burst out beside the dome. It now fits the **saucer** to
`BOSS_H` and places the pilot at the authored 0.58 with the rig's own art-box offsets.

### Idle hover

`-[AlienStageActor startAnim:interrupt:]` (0xc76ac), anim state 0, for an
`AlienStageActorBoss` with a ship: a looping `CCSequence` of two 0.5 s `CCMoveTo`s on the
**body** attachment, to `(0, −10)` then `(0, +10)`. Because `movementUpdate:` drags the ship
halves along, pilot and saucer bob together. Reproduced as a triangle wave (linear
`CCMoveTo`, not an eased sine) on the whole boss token.

Anim state 2 (walk) runs `bodyWalkMove` / `footWalkFront|BackMove` / `footWalkFrontRotate`
for **both** boss and minion, so the alien does walk on legs with the saucer following.

## 4. Minions do NOT get ships

`AlienStageElements.png` also contains `minionShip.png`, `minionShipBack.png` and
`drone.png`, which is what makes the atlas look like a squadron. **None of the three is
referenced anywhere in the binary** — no `__cfstring`, no `__cstring`, no selector
(`AlienStageElements` cfstrings are only `bossShip.png` / `bossShipBack.png`). They are
unused art. `-[AlienStageActorMinion initSprite]` (0xc70e0) attaches only the eight
paper-doll parts and `setScale: 0.58`.

Don't "restore" them.

## 5. Boss actions

`UnitStats.json`:

```
AlienStageActorBoss   con 250  dex 5  str 7   standardBossLoot
  bossActions: summonBoss (frequency 50, castTime 2)
               alienLaser (frequency 30, cooldownTime 2)
  attacks:     CrazedWorkerAttack (100)
AlienStageActorMinion con  60  dex 1  str 6   standardGoldLoot
```

No `throw` entry — the alien boss never lobs debris, so its whole ranged game is the laser.
`Enemies.json` gives the wave `population: 20` of `AlienStageActorMinion` at 100 %.

Every stage boss (not just this one) gets exactly one `ZFActorFightEffect initWithTag: 11`
in `initActorSpecificAbilities`, so tag 11 is a generic boss effect, not an alien trait.

## 6. Not changed (in the 2026-08-09 pass)

* `SUMMON_CAP = 3` in `BattleSim` is still a reimpl invention. The source draws from a
  `bossSummonList` populated at load and pops one entry per `summonBoss:`; the cap was not
  pinned in this pass. **Pinned in §7.3 below.**
* `AlienStageActorMinion colorFromSubType:` (0xc70c4) is a 3-byte `memcpy` out of a table —
  minions carry a per-subtype tint that the reimpl does not apply. Not pinned.
  **This reading was WRONG — see §7.4. The method just returns `savedColor`; the real
  colour comes from a random roll in `spawnEnemy`.**

---

# 7. Round 2 (2026-08-13) — a tester's six alien-raid complaints, run to ground

Six symptoms were reported against the reimplementation. Five are real deviations; one is
not. Everything below is transcribed from the same ARMv7 binary.

> **All five deviations below are FIXED and shipped (raid ruleset 27).** The "REAL BUG"
> headings record what was wrong and how the binary says it should behave — they are the
> derivation, not an open work list. What landed: the saucer is dropped at state 9 (§7.2),
> a six-concurrent swarm on a 10 s drip (§7.3, `ALIEN_MAX_ACTIVE` / `ALIEN_DRIP_MS` in
> `src/raid/alienStage.ts`), a random per-alien tint (§7.4, `alienTintFor`), abducted
> humans as the summon (§7.5, `ABDUCTEE_SEED` / `ABDUCTEE_POOL`), and lasers stopping on
> descent (§7.6). One deliberate divergence rides on top: the minion's `str` ships at 5
> rather than the recovered 6 — see `UNIT_OVERRIDES` in `tools/prep_raids.py` for why.

Two prerequisites that unlock most of it:

**`ZFFightMan` ivar map** (dumped from `class_ro_t.ivars`; the disassembler prints these as
bare GOT offsets, e.g. `[0x4a2ce0]=0x10c`):

| off | name | off | name |
| --- | --- | --- | --- |
| 0xe0 | `boss` | 0x134 | `currentEnemyMaxHp` |
| 0xe4 | `enemy` (the CURRENT one) | 0x140 | `enemyCasualty` |
| 0x108 | `enemyList` | **0x150** | **`spawnTimer`** (f) |
| **0x10c** | **`enemySlots`** (NSMutableArray) | 0x158 | `enemyPopulation` (i) |
| 0x110 | `bossSummonList` | 0x16c | `bossPosition` |
| 0x114 | `bossWall` | 0x174 | `enemyPosition` |
| 0x128/0x12c | `bossActionCastTimer` / `…CooldownTimer` (f, **in FRAMES** — `update:` decrements them by `dt*60`) | 0x1f0 | `bossKey` |

`Actor`: 0x108 `state`, 0x110 `type`, 0x114 `subType`, 0x118 `color`, **0x11b `savedColor`**,
0x100 `destinationPoint`, 0x160 `widthScale`. `AlienStageActorBoss`: 0x180/0x184
`bossShipFront` / `bossShipBack`.

**Stage-position defaults** (`-[ZFFightMan loadDataWithDictionary:]` 0x55b94). The alien
entry in `Enemies.json` sets neither, so both defaults apply:
`enemyPosition` = **(435, 20)**, `bossPosition` = **(450, 200)** — the sky perch.

## 7.1 The actor state machine (the piece everything else hangs off)

`-[CivilianActorFight bossUpdate:]` (0x67b40) opens with

```
r0 = self->state; r0 -= 15; if (r0 > 12) goto civilianUpdate;   // states 15..27 only
tbh [pc, r0, lsl #1]
```

so **boss behaviour exists only in states 15–27**, and the jump table (decoded at 0x67c0e) is

| state | 15 | 16/17/18/26 | **19** | 20 | 21 | 22 | 23 | 24 | 25 | 27 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | stop actions | plain `civilianUpdate` | **roll a boss action** | throw wind-up | | | wall/summon cast | begin exit | exiting | fire bullet → 19 |

Everything else is a plain ground actor. The states that matter here:

* **9 — LANDED / actively fighting.** `spawnEnemy` (0x57b74) stamps `setState: 9` on every
  minion it creates; `update:` promotes a queued slot enemy with
  `setState: (state == 13) ? 34 : 9`; and the boss's own landing sets it (below). It is
  **not** death.
* **100 → 101 — dying → removed.** `civilianUpdate` (0x686a4) at state 100 does
  `enemyPopulation--`, `enemyCasualty++`, `setState: 101`.
* **19 — perched.** The alien boss spawns straight into it (`initialSpawn` 0x56cdc:
  `setSubType:1`, `setAnchorPoint:(1,0)`, `setState: 0x13`).

**The generic boss descent** (states 24 → 25, 0x67da0 / 0x67dda / 0x68024) — this is every
raid, not just the alien one:

```
state 24:  [self moveToPoint: (600 * self.widthScale, fightMan.bossPosition.y)]
           [self setState: 25]                       // fly/walk OFF the right edge (stage is 480 wide)
state 25:  if (self.position == self.destinationPoint) {
               [self setPosition: fightMan.enemyPosition];   // (435, 20) — the ground doorway
               [self setState: 9];                           // <<< LANDED
               [self.spriteMan.parent reorderChild: self.spriteMan z: 3];
           }
```

`ZFFightMan update:` (0x5d2ee) starts it: once `enemyPopulation <= 0` and `boss.state == 19`,
it sets the boss to 24 and makes it `self.enemy`.

> The reimpl's `"descending"` route (out the right edge at perch height, then re-enter on the
> ground — `BattleSim.ts` ~2201) already matches this. Good.

## 7.2 → symptom 1: "the UFO is displayed with the boss after the boss descends" — REAL BUG

`-[AlienStageActorBoss bossUpdate:]` is exactly:

```
if (self.state == 19)      { attach bossShipFront at zOrder+1 and bossShipBack at zOrder-1
                             (each only if its .parent is nil), both at self.position }
else if (self.state == 9)  { removeChild both halves (cleanup:YES); setBossShipFront:nil;
                             setBossShipBack:nil }
[super bossUpdate:dt]
```

Chained with §7.1: the saucer is attached while perched, **rides along through the exit
(24/25) — and is destroyed and nilled the instant the boss lands at state 9.** The alien boss
fights the last phase on foot, no UFO. The reimpl welds the two ship sprites into the boss
token for the whole fight (`RaidScene.ts` ~1126), so the saucer never leaves.

**Fix:** drop the two UFO sprites when the boss's sim state leaves `"descending"`. There is
no re-attach — `setBossShipFront:nil` is permanent.

### 7.2.1 …and the HOVER goes with it

`-[AlienStageActor startAnim:interrupt:]` (0xc7b1e), anim state 0, guards the whole idle
bob on **two** conditions, not one:

```
if ([self isKindOfClass:[AlienStageActorBoss class]] && [self bossShipFront] != nil) {
    // CCSequence of two 0.5 s CCMoveTos on the body attachment, (0,-10) <-> (0,+10)
}
```

`bossShipFront` is exactly what §7.2 nils on landing. So it is the SHIP that hovers, and
the moment it is destroyed the alien stands on the ground like any other enemy. A grounded
boss still bobbing was the tester's second follow-up report.

**Fix:** gate the renderer's triangle wave on the token still owning its saucer.

## 7.3 → symptom 2: "new aliens only come after the previous one is killed" — REAL BUG

`-[ZFFightMan spawnEnemyIn:]` (0x58100), in full:

```
[self unschedule:@selector(spawnEnemyIn:)];
if (self.enemy == nil) { self.enemy = [self spawnEnemy];
                         self.currentEnemyMaxHp = self.enemy.fightData.hitPoints; }
else                   { for (i = 0; i <= 4; i++)                       // FIVE slots
                             if ([self.enemySlots[i] isKindOfClass:[NSNull class]]) {
                                 self.enemySlots[i] = [self spawnEnemy]; break; } }
```

`enemySlots` is built in `initialSpawn` (0x576f4) as `movs r5, #5` NSNulls. So the field
holds **one "current" enemy plus five more — six enemies at once.**

Two schedulers feed it, both arming `spawnEnemyIn:` at a **1.0 s** interval and both gated on
`enemyPopulation - liveCount >= 1`:

* `update:` (0x5d60c) — fires when the current enemy has just died (the classic
  "replace the one you killed").
* `updateTimer:` (0x61250) — `spawnTimer -= dt; if (spawnTimer <= 0) { …schedule…;
  spawnTimer = 10.0f; }`. **A reinforcement every 10 seconds regardless of kills.**

And `spawnTimer`'s seed is the alien raid's one big divergence (`initialSpawn` 0x575fe):

```
if ([[[GameState gameState] zfGameData] currentEnemy] == 6)   // 6 == Zombies vs Aliens
     self->spawnTimer = 10.0f;
else self->spawnTimer = 3600.0f;                              // i.e. never
```

So **Zombies vs Aliens is the only raid in the game with a timed drip** — every other stage
only ever refills on a death. Combined with `population: 20`, the alien raid is designed as a
*swarm*: up to six aliens on the field, a fresh one every 10 s, 20 to kill.

The reimplementation had a fixed `BattleSim.MAX_ACTIVE_ENEMIES = 1`, which is what produced
the symptom. The faithful model — 6 concurrent (1 + 5 slots) with a 10 s alien-only
reinforcement clock on top of the on-death refill — now ships as `ALIEN_MAX_ACTIVE` and
`ALIEN_DRIP_MS` in `src/raid/alienStage.ts`, read through `waveCadenceFor(raidId)` so every
other raid keeps the on-death-only behaviour.

`enemyPopulation` decrements only in `civilianUpdate` at state 100, and **only when the dying
actor is not `fightMan.bossWall`** — so summoned abductees (§7.5) are free and do not eat the
wave budget.

## 7.4 → symptom 3: "aliens are colourless" — REAL BUG

The atlas is the tell. Measured over `AlienStage.png` (opaque pixels only):

| part | avg RGB | saturation |
| --- | --- | --- |
| `minionBody` / `minionArmF` / `minionArmB` | ~(197,197,197) | **1** |
| `minionHead` / `minionFace` | ~(153,153,153) | **0** |
| `bossArmF` / `bossFootF` | (173,93,205) / (140,15,192) | 112 / 177 |

The **minion art is pure greyscale** (the boss's is already purple). It is meant to be tinted
at runtime — and the tint is *random per alien*. `-[ZFFightMan spawnEnemy]` (0x57f3a):

```
if ([[[GameState gameState] zfGameData] currentEnemy] == 6) {            // aliens only
    r = (int)((arc4random() % 100) / 100.0f * 255.0f);
    g = (int)((arc4random() % 100) / 100.0f * 255.0f);                   // three separate rolls
    b = (int)((arc4random() % 100) / 100.0f * 255.0f);
    [enemy setSavedColor: ccc3(r, g, b)];
    [enemy resetColor];
}
```

Each channel lands on a multiple of 2.55 in 0…252. `-[Actor resetColor]` (0x38bac) then walks
the attachments, calls `colorFromSubType:` and applies the result to every part whose
`inheritColor` is YES.

`-[AlienStageActorMinion initSprite]` (0xc70e0) sets **`setInheritColor: NO` on attachment
slots 1 and 11** (`minionFace` and `minionBodyDetail`) — those two stay grey; the body, head,
arms and feet take the random hue. So a wave of aliens is a wave of *differently coloured*
aliens with matching grey faces.

Correcting §6: `-[AlienStageActorMinion colorFromSubType:]` (0xc70c4) is
`memcpy(ret, (char*)self + 0x11b, 3)` — it simply returns `savedColor`, ignoring its argument.
It differs from `-[StageActor colorFromSubType:]` (0xd121c) only in *not* re-applying
`setColor:`. There is no subtype→colour table. Every stage minion class has the identical
override.

## 7.5 → symptom 4: "no summoned enemies" — REAL BUG (the reimpl summons the wrong thing)

The alien boss's `summonBoss` does not summon aliens. It **abducts humans.**

`initialSpawn` (0x57618), inside the same `currentEnemy == 6` branch that sets `spawnTimer`:

```
self.bossSummonList = [NSMutableArray array];
[… addObject:@"FarmStageActorLumberjack"];      // twice
[… addObject:@"CityStageActorCrazedWorker"];
[… addObject:@"NinjaStageActorBoy"];
```

Every other stage gets an empty list (and `allowedToSummonBoss` needs a non-empty one, so no
other boss can summon at all).

`-[ZFFightMan summonBoss:]` (0x5ee2c) pops **index 0**, `NSClassFromString`s it, spawns it
**at the CENTRE OF THE STAGE** with zOrder 3 — then **refills the queue** with a fresh
random name:

```
i = (int)((arc4random() % 100) / 100.0f * 5.0f);     // 0..4, 20% each
switch (i) { 0: FarmStageActorFarmhand   1: FarmStageActorLumberjack
             2: CityStageActorCrazedWorker  3: PirateStageActorSwashbuckler
             4: NinjaStageActorGirl }
```

so the list never empties — **the alien boss can summon indefinitely.** What actually limits
it is `-[ZFFightMan allowedToSummonBoss]` (0x5eda4):

```
return self.bossWall == nil                 // <<< only ONE abductee alive at a time
    && self.bossSummonList.count > 0
    && self.bossActionCooldownTimer <= 0
    && self.bossActionCastTimer <= 0;
```

The spawned human is stored in `self.bossWall` (0x5f190) and `update:` (0x5d6a8) clears that
ivar when its state hits 100/101, re-arming the summon.

The spawn point is worth spelling out, because it is the one place the method branches on
the device (0x5ef28) and it is easy to misread as "the enemy door":

```
r4 = 240.0f                                              // iPhone
if ([[UIDevice currentDevice] respondsToSelector:@selector(userInterfaceIdiom)]
    && [[UIDevice currentDevice] userInterfaceIdiom] == UIUserInterfaceIdiomPad) r4 = 480.0f
…
[actorManager spawnFightActor: cls
                      atPoint: CGPointMake(r4, fightMan.enemyPosition.y)   // x in r3, y on the stack
                   fromObject: self.parent
                   withZOrder: 3];
```

Only the **y** comes from `enemyPosition`. The x is that hard-coded 240 / 480 — the exact
horizontal **centre** of each build's stage (480 wide on the phone, 960 on the tablet). An
abductee therefore lands mid-field, already past the wave's hold line, rather than walking
in through the doorway like every other enemy. Landing them at the door was the tester's
first follow-up report.

**And it stays there.** It does not walk, chase or reposition — it holds dead centre and
swings at whatever comes into reach. Two playtest adjustments sit on top of the recovered
point: it stands on the stage art's SCORCH MARK (art x~220 of 480) rather than the
arithmetic centre at 240, and RaidScene shifts the drawn figure left by its own half-width
so that mark lands under its middle — enemy rigs are drawn from their model-space left
edge, which is invisible in a doorway crowd and obvious on a lone unit mid-field. (A first pass had it advancing on the army, reasoning
from a `moveToPoint: (0, enemyPosition.y)` site inside `civilianUpdate` that was never
attributed to a state; the tester corrected it. Do not re-derive that — the site is not
this actor's.)

One consequence has to be modelled rather than transcribed. The zombies' combat zone
begins `COMBAT_ZONE_DEPTH` short of the front line, which is well to the right of centre,
so a stationary abductee would otherwise chip the army as it filed past and never be
reachable in return. The reimplementation therefore treats it as the mid-lane blocker it
is, exactly as it already treats a boss WALL: zombies that have not yet passed it stop
short and fight it, and those already ahead of it carry on (the same `passedWall` latch).
The two can never coexist — only the Ninja and Robot bosses build walls, and only the alien
boss summons.

The rest of the cast, for presentation:

* `[spawned setSubType: 2]`, `setAnchorPoint:(1,0)`, `[spawned setState: 29]`, then a
  `CCSequence` of `CCDelayTime(1.0)` + `CCCallFuncND(callSetState:, 18)` — it stands frozen
  for one second, then joins the fight.
* A `CCColorLayer` beam (scaled/faded via `CCSpawn` of `CCScaleTo` + `CCFadeTo`, offsets −50 /
  75) plus a `mindControl.plist` particle attached to the actor, and **`resurrect.wav`**.
* Boss side (`bossUpdate:` 0x68310): `bossActionCastTimer = castTime*60` (2 s),
  `bossActionCooldownTimer = castTimer * 1.25` (2.5 s), `schedule:@selector(summonBoss:)
  interval: castTimer/60`, `[self setState: 23]` (the casting pose).
* `UnitStats.json` frequencies: `summonBoss` 50, `alienLaser` 30 — so ~5 casts in 8 rolls are
  summons.

`RaidManager.summonWallTemplatesOf` currently clones the wave's own minion, and
`BattleSim.SUMMON_CAP = 3` caps it. Both are wrong: it should be the human queue above,
uncapped, one alive at a time, off-budget.

## 7.6 → symptom 6: "lasers are still fired after the boss descends" — REAL BUG

From §7.1: the action ROLL lives only in the state-19 arm of `bossUpdate:`. Once the boss
lands it is in state 9, which is below the 15–27 window, so `bossUpdate:` falls straight
through to `civilianUpdate` — **a landed boss has no specials at all.** It just swings.

For completeness, `-[ZFFightMan allowedToShootBullet]` (0x5e918) itself has *no* boss-state
gate — it only checks the two action timers and that at least one zombie is engaged. The
state gate is upstream, in the dispatcher.

`BattleSim.canPerform` gates only `throw` and `wall` on `boss.state === "structure"`. It must
gate **every** boss action that way — `alienLaser`, `summonBoss`, `pixelFire`, `turnZombie`,
`telekinesis`. (The reimpl comment at line 2380 already worked out *why* for throws; the rule
is simply universal.)

## 7.7 → symptom 5: "boss health bar is displayed before the boss descends" — NOT a deviation

`-[ZFActorManager spawnFightActor:atPoint:fromObject:withZOrder:andDataKey:]` (0x2f3e8) ends
with an **unconditional** `[[FightHUD fightHUD] addHealthBarToActor: actor]` for every fight
actor it creates, boss included, plus the actor's own `lifeBG`/`lifeBar`/`lifeBarTemp`
children at z 200/202/201. `-[FightHealthBar update]` (0x1a57f4) only bails on
`[self isHidden]`; there is no state or perch condition anywhere.

And the alien boss *is* on screen from the first frame: `initialSpawn` spawns it at
`bossPosition` (450, 200) in state 19 — it has to be, since hovering there firing lasers and
beaming down abductees is its entire mid-fight role.

So a health bar over the perched saucer is faithful. Nothing to change.

## 7.8 Summary of the alien stage's five hard-coded `currentEnemy == 6` divergences

Grepping the fight code for the stage-ID compare turns up exactly these:

1. `initialSpawn` 0x575fe — `spawnTimer = 10` instead of 3600 (the reinforcement drip).
2. `initialSpawn` 0x57618 — seed `bossSummonList` with the four abductees.
3. `spawnEnemy` 0x57f5c — random RGB `savedColor` per minion.
4. `update:` 0x5d4d2 — an alternate live-enemy count when the current slot is empty and
   `enemyPopulation <= 14` (counts live `CivilianActorFight`s down from the remaining
   population instead of up from zero; behaviourally equivalent, listed for completeness).

Everything else about the raid is the generic stage machinery.
