# Enemy damage — recovered from the binary (2026-07-27)

Method: `ZF2R_extracted/tools/re/objc_disasm.py` against `app-internals/executable/ZF2R`, with an
annotator pass that also resolves direct `add rX, pc` cfstring loads and `vldr [pc, #imm]` literal
pools (the stock tool leaves both unannotated). Companion to `COMBAT_STATS_RECOVERED.md`, which
covers the per-hit damage math; this file covers **how often** enemies hit and what their hazards
actually do.

Enemies are `StageActor → CivilianActorFight → Actor`. Player zombies are `ZombieActor → Actor`.
Both share `Actor`'s attack plumbing, which is why the two sides differ only by data.

## What was already right

`-[StageActor initFightDataAfterLoad]` (0xd34f8) confirms the enemy half of the stat conversion:

| field | source |
| --- | --- |
| `hitPoints` / `finalHitPointsTotal` | `con × 100` (literal `100.0f` at 0xd3724) |
| `power` | `str × 10` |
| `attackSpeed` | `1 ÷ dex` |

Per-swing damage is `finalPower × damageMultiplier` (`Actor damageIn:`), with the lineup-depth
band gated on `isKindOfClass: ZombieActor` — enemies always swing at band 1.0. Enemy stats are
**not** scaled by stage or player level: `Enemies.json stageSettings` ramps difficulty purely by
enemy composition, so the straight pass-through in `prep_raids.py` is correct.

## The cadence bug (`ENEMY_ATTACK_PACE`)

`-[Actor getFightAttackSpeed]` (0x368e0) returns

```
interval = attackVariation.speedMultiplier (default 1) × fightData.finalAttackSpeed
```

and the attack loop consumes it as the **whole cycle**:

1. `CivilianActorFight startAnim:interrupt:` on the attack state sets `attacking = YES` and calls
   `schedule: doneAttacking: interval: <that value>` — a *repeating* cocos2d timer (0x69be0).
2. `civilianUpdate` re-arms `fightAttack:` with interval 0 (next frame) the moment `attacking`
   clears.
3. `fightAttack:` unschedules itself, schedules `damageIn:` at `interval × damageTiming`, and
   starts the animation — all inside the same cycle.

`ZombieActor startAnim:interrupt:` (0x45898) does the identical thing with its own
`getFightAttackSpeed`. **The animation gates nothing.** So the raw fight-data clock is the cadence,
and the 2× asymmetry is intentional: at equal dex an enemy attacks twice as often as a zombie.

The retired `ENEMY_ATTACK_PACE = 2` therefore halved every enemy's sustained DPS — measured across
all 37 raid units, every one was at exactly 0.50× its real output (the Lumberjack at 0.71×, because
its un-modelled `speedMultiplier` partly cancelled the error).

## The rest of `getFightAttackSpeed`

- **`speedMultiplier` is per-rolled-attack.** `Actor setAttackVariation` rolls the unit's
  `attacks[]` through `rollAgainstFrequencyInArray:` every cycle, and the rolled attack sets both
  that swing's damage and its cycle length. `LumberjackSpecial` is ×1.5 damage on a ×5 cycle;
  `ZombieDoubleStrike` is ×0.25 on a ×0.2 cycle. The deterministic resolver collapses the roll to
  its expectation, taking the mean of each field independently — correct for sustained DPS,
  because a renewal process delivers `E[damage] / E[cycle]`.
- **Player lineup-depth SLOWDOWN** (0x36aae–0x36b4c): a zombie's interval is multiplied by
  `[1.0, 1.425, 2.0, 4.0][min(floor(index/5), 3)]`, gated exactly like the damage band (skipped in
  states 0x20 / 0x1c and for the front five). Rear zombies hit softer *and* slower.
- **Pirate Scallywag override** (0x36960): `finalAttackSpeed = max(0.5, opponentInterval² / 0.8)`.
  The same opponent value is fetched twice and multiplied, which is almost certainly a source bug,
  but it ships: against a dex-1 zombie (2 s) the Scallywag runs at 5 s, against a dex-3 zombie
  (0.67 s) it clamps to the 0.5 s floor. This — not a global pace — is where the "pirate brute
  swings every ~4 s" reference observation comes from.
  - **DELIBERATE DIVERGENCE (ruleset 38, re-tuned in 44): Arrrnold mirrors too, on his own
    terms.** The binary reaches the override through `isKindOfClass: PirateStageActorScallywag`
    alone, so the boss is not in it. The reimpl treats mirroring as a family trait — his 5000-damage
    slam one-shots every body in the game, so con cannot answer him and his CLOCK is the only dial
    the matchup has. He reads the front zombie's **species base** cycle (2 s / catalog dex, nothing
    else applied), on divisor `2² / 6.5 ≈ 0.6154`, floored at 1.25 s: a Headless-led line holds him
    to one slam every 6.5 s and keeps holding it however upgraded that Headless is. The Scallywag's
    own numbers above are untouched ground truth — see `combatStats.PIRATE_BOSS_KEY`.
- **Old McDonnell's farm level ramp** (0x36b8e–0x36be6): when `zfGameData.currentEnemy == 1`, every
  NON-zombie actor's interval is multiplied by 0.66 at player level ≥ 10 and 0.44 at ≥ 15. Only
  raid 1 does this; it keeps the starter raid dangerous as you out-level it.

## Hazard damage

| hazard | ground truth | source |
| --- | --- | --- |
| boss `throw` | the bossAction's `damage` field, applied **verbatim** — re-verified: no arithmetic between `damageAmount` and `damage:` | `ZFFightPhysics throwProjectile:` copies @"damage" into `damageAmount`; `damageZombie:withProjectile:withContact:` passes it to `[zombie damage:]` |
| `alienLaser` | flat **200** | `AlienStageBullet collidedWith:` passes the immediate `0x43480000` |
| `pixelFire` | picks **one** random eligible zombie and calls `setOnFire` — which, as recovered, burns for a single frame: see below. **The reimpl deliberately diverges here.** | `ZFFightMan pixelFire`, `ZombieActor fightUpdate:` 0x4dedc |
| `telekinesis` | **no damage** — `knockBackBy:force:` + `stunSelfFor:` only | `ZFFightMan telekinesis:` |

### pixelFire burns for exactly one frame

The burn tick is real — `damage: hitPointsTotal/20 × dt`, 5 % of max HP per second — and the
`tbh` jump table in `fightUpdate:` confirms it belongs to state **0x31**, precisely what
`setOnFire` sets on the zombie (the table does `subs r0, #6` before `cmp #0x2b`, so it covers
states 6–49 and 0x31 is its last entry; states 0x2d/0x2e enter the same block earlier and branch
past the tick).

But it never accumulates. `setOnFire` calls `[self moveToPoint: [self position]]` — the zombie's
destination is **where it already is** — and the state-0x31 block burns once, then compares
`position` to `destinationPoint`, finds them equal, and leaves for state 0x28. So the effect is one
frame: `5 % ÷ 60 ≈ 0.083 %` of max HP, about 2 damage on a 3000 HP zombie. Nothing holds the lock
either (the only `setLockState: 0` is on an unrelated path).

That is near-certainly a source bug — the surrounding code fetches the enemy, and moving to your own
position is a no-op. As shipped, **`pixelFire` is an attack interrupt with a cosmetic flourish**
(cancelled swing, `stun.wav`, `pixelExplosion` particles), not a damage-over-time.

#### DELIBERATE DIVERGENCE (ruleset 31): the reimpl burns

The reading above is what the binary does, and it stands. What the reimpl does is different, on
purpose. A one-frame burn makes the boss's headline special worth about two damage — the player
cannot see it, cannot answer it, and cannot lose to it — so the reimpl keeps the recovered RATE and
replaces the accidental duration with a real one:

* the burn lasts `PIXEL_FIRE_BURN_MS` (`src/raid/videoGameStage.ts`) at the recovered
  5 %/s, so a full untapped burn costs 30 % of max HP;
* the burning zombie panics — no attacks, no advance, arms overhead, pacing on the spot;
* the player can **tap the fire out**, which is transcribed as a `fireTap` input and replayed by
  the verifier (the burn is fully simulated, so an untranscribed smother would desynchronise the
  two simulations exactly as the ruleset-14 wall bug did).

The cancelled swing, the single-target pick and the 5 %/s rate are all still ground truth. Only the
duration is ours. If you are here to make the reimpl faithful again, the thing to change is
`PIXEL_FIRE_BURN_MS`, not `BURN_MAX_HP_FRACTION_PER_SEC`.

Scope check: `pixelFire` appears in exactly ONE unit's `bossActions` in the whole game —
`VideoGameStageBossActor`, raid 9 (unlock level 43). Likewise `telekinesis` (RobotStageActorBrainBot,
whose action carries an explicit `"damage": "0"`, corroborating the no-damage reading) and
`turnZombie` (the same Video Games boss).

### turnZombie CONVERTS — it does not kill

`turnZombie` is the other Video Games boss action, and the reimpl had it modelled as
`dealDamage(victim, victim.hp)`: the front zombie was dealt its own remaining hit points and died
where it stood. Nothing was thrown at it, nothing animated, and no attacker was within reach — the
zombie simply vanished, and went home a permanent casualty. **That is the "zombies die suddenly for
no reason" players reported on this invasion.**

It was never a kill. The action's name, the raid's own flavour text ("wants to turn all zombies into
video game cannon fodder"), and `VideoGameStageZombieActor` — a fully authored unit (con 10000,
dex 6, str 8, `VideoGameZombieBite`) shipping its own idle/attack frames but referenced by no
`stageSettings` entry anywhere, because nothing spawns it as wave population — all say the same
thing: the zombie changes sides.

The reimpl (ruleset 31) does that. The victim is marked `taken` — alive, out of this fight, and
still a survivor rather than a loss, exactly like a Beach crab's passenger — and a pixel zombie
stands up on the abductee's mark mid-lane carrying its id. `PIXEL_ZOMBIE_TAPS` taps break it open
and hand the zombie back (`turnedTap`, transcribed).

Three consequences follow from that con of 10000, which is a **million hit points**:

* it is **excluded from the win condition**. A fight that had to kill it could never end.
* it is **not a lane blocker** and **not a melee target**. Measured: as a blocker it made the
  invasion unwinnable outright for a maxed roster, and as a target the army just poured the whole
  four minutes into it. It stands where it lands, swings at whatever files past, and answers only
  to taps.
* only **one stands at a time** (the `allowedToSummonBoss` shape), so clearing it is what lets
  Zedzox turn another.

## Throws and specials share ONE action budget

`bossUpdate:` (0x67e8c) makes a single `rollAgainstFrequencyInArray:` pick over the boss's whole
`bossActions` array each cycle, then dispatches on the chosen action's name — `alienLaser`,
`throw`, `wall`, `telekinesis`, `summonBoss`. A `throw` arms
`bossActionCooldownTimer = throwSpeed × 60` frames; the cast-based actions arm
`bossActionCastTimer = castTime × 60`. So **throws compete with specials for the same slot**
rather than running on a parallel timer, and each action's `allowedTo…` gate is checked after the
roll but before any timer is armed — an action it cannot perform right now (a second wall while
one stands, a summon past the cap) costs nothing and is simply re-rolled.

`bossActionCooldownTimer` is written only by `bossUpdate:`, so it starts at ObjC's zero: the
boss's first action resolves as soon as it becomes active.

For most bosses every entry is a `throw`, so the budget degenerates to a plain interval and
nothing changes. It bites for the three mixed lists — measured over full boss-stage fights:

| boss | P(throw) | throws before | after |
| --- | --- | --- | --- |
| City / Pirate / Farm (all throws) | 100 % | 5 | 5 |
| Ninja (throws + wall) | 47 % | 14 | 13 |
| Robot BrainBot (throws + telekinesis) | 75 % | 46 | 12 |
| Video Games (throws + turnZombie + pixelFire) | 27 % | — | 3 |

The Robot drop is larger than its 75 % share alone implies because each telekinesis also spends
its 3 s cast plus recovery: of 87 s perched, 40 s goes to casting.

## Not in the data at all

`enrage` appears in no plist. `ZFFightMan enrageTimeInterval` reads ability tag 11's
`timerActivateIn`, so the round-timer enrage in `BattleSim` (3:00 → ×1.5 boss damage, faster
throws) is invented. It is still there — flagged, not removed, because there is no recovered
behaviour to replace it with.

## Where this lives in the reimpl

`src/raid/combatStats.ts` holds the pure ground truth (`lineupSpeedBand`,
`mirroredAttackIntervalSec`, `farmRaidEnemyPace`, `ALIEN_LASER_DAMAGE`,
`BURN_MAX_HP_FRACTION_PER_SEC`). `CombatEngine.buildEnemyUnits` folds `speedMultiplier` and the
farm ramp into `attackCooldownMs` and flags the Scallywag; `BattleSim.cycleMs` applies the depth
band and the mirror at fight time. `src/raid/balance.ts` is deleted.

**This changes the deterministic transcript**, so `RAID_RULESET_VERSION` went 7 → 8 (it has been
bumped many times since — 9 for the `pixelFire` and Mini Buddy corrections, 10 for the shared
boss-action budget below, and on past those; `src/raid/replay.ts` carries the authoritative
version history and the current value, and is the only place to read it from) and
`server/src/raidVerifier.ts` passes the same `{ raidId, playerLevel }` the client does. The epic
boss builders (`src/epicBoss/combat.ts` and `server/src/v3/epicBoss.ts`) both dropped their ×2 —
they must stay identical or the authoritative replay diverges.

**Balance check** (headless, real data, 16-zombie army, abilities unlocked): every raid is winnable
with a tier-appropriate army and lost with an under-tiered one. No content rebalance was needed.
