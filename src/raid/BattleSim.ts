// The live battle simulation (Phase 3+): a pure, RNG-free, real-time stepping
// model that the RaidScene renders. No Pixi, no DOM — positions, health, focus
// charge, ballistic boss projectiles, and attack clocks over a 1D combat lane.
// This is the AUTHORITY for a raid's outcome — the game ALWAYS plays it out; there is
// no instant/auto-resolve (CombatEngine.resolveRaid is retained only for the ZF.runRaid
// dev hook + headless tests).
//
// Cadence (both sides "one at a time"):
//   Zombies mill in a GROUP on the LEFT. One at a time the front zombie steps out
//   to its lane and charges a FOCUS bar; when full it is released to advance right
//   and fight, and the next steps up. Only one charges at a time.
//   Normal enemies EMERGE one at a time and hold just outside the entrance at the
//   RIGHT edge; zombies stop at a front line to their LEFT and never pass them.
//   The BOSS perches on its structure (top-right) and TOSSES projectiles in an arc
//   at the zombies (preferring Garden zombies). Throws are ballistic and use lazy
//   circle collision — a fast/small zombie can be missed. Once the minions are
//   cleared the boss descends and fights as a ground unit.
//
// Now implemented: focus-bar distractions (butterfly/brain bubbles, with
// Concentration bypass), activated abilities (windup/cooldown/stun/knockback),
// boss specials, ballistic projectiles, boss summon reinforcements, the
// carrotWall/junkWall blockers, the Circus trapeze carried-grab (grabberOf), and the
// Beach crab carry-off (crabOf). The trapeze and crab are CLIENT-ONLY — the server
// verifier replays the un-harassed fight and the client concedes via clientWin.
// NOTE: a ground-crossing obstacle/grab hazard once lived here. It was NOT a base-game
// mechanic — it was fabricated during development — and has been removed entirely.
// Do not reintroduce it without ground truth from the binary.
//
// Combat numbers are the GROUND-TRUTH fight-data model (combatStats.ts, recovered from
// the binary): maxHp = con*100 and cadence = attackCooldownMs (2s zombie / 1s enemy ÷ dex)
// arrive on the CombatUnit; per-swing damage = finalPower(str*10) * mult, then the player
// lineup-depth band (1.0/0.85/0.7/0.55; enemies ×1.0). See combatStats.lineupDamageBand.
import type { BossActionChoice, BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, RaidFeats, RaidOutcome, SummonConfig, WaveCadence } from "./types";
import { emptyRaidFeats } from "./types";
import { ACTIVATED_ABILITY, activatedGroupsOf, teamAbilitiesIn } from "../zombie/abilities";
import {
  ALIEN_LASER_DAMAGE,
  applyDamage,
  BURN_MAX_HP_FRACTION_PER_SEC,
  deriveAttackIntervalMs,
  deriveHitDamage,
  deriveMaxHp,
  lineupDamageBand,
  lineupSpeedBand,
  mirroredAttackIntervalSec,
  protectReduction,
  POWER_PER_STR,
} from "./combatStats";
import {
  PIXEL_FIRE_BURN_MS,
  PIXEL_FIRE_PACE_REACH,
  PIXEL_FIRE_PACE_SPEED,
  PIXEL_ZOMBIE_TAPS,
} from "./videoGameStage";

/** Logical field the sim runs in; RaidScene scales this to the viewport. */
export const FIELD_W = 1000;
export const FIELD_H = 560;

// The original raid stage is authored at 480x320 cocos2d points (every fightBG*_bg.png is
// that size, and every position in Enemies.json is in those units). Recovered constants
// are kept in SOURCE units and converted here, so a number lifted out of the disassembly
// can be pasted in as-is.
const SOURCE_STAGE_W = 480;
const SOURCE_STAGE_H = 320;
const SIM_PER_SOURCE_X = FIELD_W / SOURCE_STAGE_W;
const SIM_PER_SOURCE_Y = FIELD_H / SOURCE_STAGE_H;

export const CHARGE_X = 220; // staging slot the front zombie steps into to focus
export const ENEMY_HOLD_X = 940; // enemies hold in the structure's doorway (not the far edge),
// ~2/3 of a sprite forward of the entrance so they stand IN the open door.
// Moved 915 -> 940 on a playtest note that the wave stood too far into the lane. It carries
// the zombies' own line with it (`frontX` below is this minus the melee gap), which was the
// other half of the same note: they now close to 880 before they start swinging.
export const ENEMY_SPAWN_X = 1120; // off the right edge (hidden) before emerging
// Epic Bosses enter from above instead of through the stage doorway. Land them just
// right of the field's midpoint so zombies spend more of the short attempt fighting
// and less of it crossing an otherwise empty lane.
export const EPIC_BOSS_HOLD_X = 600;
// Boss perch field-x. Chosen so RaidScene.mapX() lands it on the silo perch
// (PERCH_FX), which is also where thrown projectiles originate.
export const BOSS_STRUCT_X = 848;
/** Boss perch height in sim space (negative = up); RaidScene reads it to place
 *  the boss on the barn and lerp its descent. */
export const BOSS_STRUCT_Y = -150;
/** Epic Boss entry starts well above the visible stage, then falls to ground. */
export const EPIC_BOSS_FALL_Y = -4_000;
const EPIC_BOSS_FALL_SPEED = 4_800;
export const EPIC_BOSS_LAND_MS = 500;
const BAND_TOP = 90;
const BAND_BOT = FIELD_H - 70;
const CENTER_Y = FIELD_H / 2;
const ENGAGE = 60; // x-distance at which two units trade blows

const CHARGE_MS = 3600; // focus-bar fill (zombies take a while to get out)
// Focus-bubble minigame thresholds: the fill pauses at 1/4, 2/4, 3/4 (a butterfly
// distraction) and again at full (a brain, gating the release). Popping a bubble
// resumes instantly; if the player never taps, it auto-resolves after these
// generous timeouts so the battle can't soft-lock.
const CHARGE_STEPS = [0.25, 0.5, 0.75, 1];
const BUTTERFLY_AUTO_MS = 4200; // distraction auto-refocuses if not popped
const BRAIN_AUTO_MS = 3200; // full bar auto-advances if not popped
const STEP_SPEED = 260; // zombie stepping out to its lane (px/s)
const EMERGE_SPEED = 210; // enemy walking in from the right (px/s)
const CIRCUS_BOSS_KEY = "CircusStageActorBoss";
const BOSS_JUMP_MS = 650; // Circus Ringmaster drops directly from the car to the lane
const ENEMY_EMERGE_GAP_MS = 450; // beat before the next enemy emerges
/** Default wave cadence: strictly one enemy at a time. GROUND TRUTH — every stage owns a
 *  five-slot `enemySlots` array, but the only scheduler that ever FILLS a slot is the
 *  `spawnTimer` drip, and `spawnTimer` is seeded to an hour everywhere except the alien
 *  stage. So one-at-a-time is right for ten of the eleven raids. See types.WaveCadence. */
const SOLO_WAVE: WaveCadence = { maxActive: 1, dripMs: 0 };
const MAX_SIM_MS = 4 * 60 * 1000; // hard safety cap (min-damage 1 avoids stalls)

// ---- Front formation (GROUND TRUTH: `-[ZombieActor calculateDestinationPoint]` 0x4c9d4)
// The army's ORDER *is* the formation — there is no separate layout pass. A zombie's index
// in `[fightMan zombies]` gives its depth BAND (index / 5, the same divisor the damage and
// cadence falloffs use — see combatStats.lineupDamageBand), and its rank among that band's
// engaged members, ordered by BODY TYPE, gives its slot inside the row. The recovered
// formula, in the source's 480x320 points:
//
//   x = zombieAttackPosition.x - 55 - 35*band - standoff(body) + 5*(n - 1 - slot)
//   y = 4*slot - 2*n + 10
//
// `zombieAttackPosition` defaults to (435, 20) and no shipped raid overrides it, so the
// front row plants at x=380 with the enemy at 435. We keep `frontX` as the anchor (it is
// derived from the raid's own hold position and engage distance) and apply the recovered
// geometry RELATIVE to it.
//
// ONE part of this block is deliberately not the binary's: the `Small` body's place in the
// row. See MINI_STANDS_WITH_REGULAR below.
const BAND_SIZE = 5; // zombies per depth band — `index / 5`, exactly the damage band
const SRC_BAND_GAP = 35; // each band stands this much further back
const SRC_SLOT_X_STEP = 5; // slots inside one row fan FORWARD by this much
const SRC_SLOT_Y_STEP = 4; // ...and step DOWN the screen by this much
/** Per-body-type standoff, SUBTRACTED from x: a heavy body plants further off the enemy, a
 *  light one steps in past the line. Bodies not listed take 0.
 *
 *  DELIBERATE DIVERGENCE (see MINI_STANDS_WITH_REGULAR): the source's `Small: -15` is gone.
 *  A Mini now takes Regular's 8, so Headless is the only body that steps ahead of the line. */
const SRC_BODY_STANDOFF: Record<string, number> = {
  Large: 15, Garden: 15, Regular: 8, Girl: 4, Headless: -5,
};
/** Slot order inside a band, front-most first — the order the bucketed insertion in
 *  `calculateDestinationPoint` produces (nested prefix counters, smallest bucket first).
 *
 *  The source's list opens with `Small`; ours does not, for the same reason the standoff
 *  above dropped it (MINI_STANDS_WITH_REGULAR). Minis bucket with Regular, and so do the
 *  Cupid Gardens that bucket with Small in the source. */
const BODY_ROW_ORDER = ["Headless", "Girl", "Regular", "Large", "Garden"];
// MINI_STANDS_WITH_REGULAR — why a Mini no longer leads the row.
//
// In the binary the lightest body plants CLOSEST to the enemy: `Small` carries the most
// negative standoff and takes the front-most slot in its band. This sim's enemies commit
// all their damage to the single front-most zombie down the lane (`playerInRange`), so
// that pairing hands every incoming blow to the frailest unit on the field, for the whole
// fight, in every raid — the army's Minis walked to the front and died there. Players
// reported exactly that.
//
// ZF2 spreads its damage differently, so the rule costs it far less there; here it is the
// difference between a Mini being a unit and a Mini being a casualty. So a Mini stands
// where a Regular stands, and the one body that still pushes to the front is the Headless
// — which is its defining behaviour and the thing its owner chose it for.
//
// This is a deliberate departure from `-[ZombieActor calculateDestinationPoint]`, in the
// same spirit as the Zombie Pot's species ladder. Do not "restore" it from the disassembly.
const BAND_GAP = SRC_BAND_GAP * SIM_PER_SOURCE_X;
const SLOT_X_STEP = SRC_SLOT_X_STEP * SIM_PER_SOURCE_X;
const SLOT_Y_STEP = SRC_SLOT_Y_STEP * SIM_PER_SOURCE_Y;
/** Where a Garden zombie stands to heal — an ABSOLUTE support station rather than a
 *  setback from the front line.
 *
 *  DELIBERATE DIVERGENCE. `reorderZombies` shoves a Garden's destination back by 120
 *  source points from wherever the line happens to be, which in this sim's deeper
 *  formation dropped them into the milling crowd — measured at sim ~75, about a sixth of
 *  the way across the stage, so the healers read as stragglers who had not deployed. They
 *  now hold at a fixed 3/10 of the visible stage: RaidScene insets the lane by 10 % of the
 *  stage width at each end, so sim 250 renders exactly 30 % from the left edge of the
 *  background art. Far enough back to stay out of the combat band (which starts at
 *  `frontX - COMBAT_ZONE_DEPTH`) and so off the alien laser's target list, which is the
 *  property the setback existed to produce. */
const GARDEN_STATION_X = 250;
/** How much wider than the source the rows are drawn. The recovered 4-point row step packs
 *  five zombies into a 16-point ribbon — correct, and the reason the source ships an
 *  explicit per-zombie zOrder rather than sorting on y. Our sprites are drawn larger
 *  relative to the field, so at 1.0 the army reads as one smear; this is the ONE knob in
 *  the block that is not ground truth. Set it to 1 for the source's exact spacing. */
const ROW_SPREAD = 2;
/** How close to its band's line a zombie must stand before the row is allowed to
 *  ANCHOR on it (see assignFormation). Small: the closest two members of a row are one
 *  slot step apart, which is several times this even after `rowXFit` compresses it, so
 *  in practice only the member actually parked on the line qualifies.
 *
 *  WHY THE ROW HAS TO WAIT FOR IT. The row hangs off its front-most member's body
 *  standoff, so the whole row shifts when a lighter body takes the lead. That is right
 *  once the newcomer is standing there and wrong before it arrives: a Headless released
 *  from the charge slot re-anchored the row the instant it was RELEASED, which stepped
 *  the zombie already toe-to-toe with the wave 32 units backwards — out of
 *  `engageDistance`, while its replacement was still three seconds of walking away. The
 *  enemy had nothing in reach for that whole crossing and stood there being hit
 *  (measured: 3.3 s of a 8 s window, and it re-arms its attack clock every idle tick, so
 *  the cost is worse than the gap). Reported as the enemy stopping mid-fight whenever a
 *  Regular or Headless was sent in.
 *
 *  The binary has no such transient, because its geometry is anchored at the row's REAR:
 *  `x = attackPos - 55 - 35*band - standoff + 5*(n - 1 - slot)` counts the units BEHIND
 *  you, so joining a row never moves anyone back. This sim re-anchors on the FRONT
 *  instead — deliberately, because `frontX` is derived from the raid's hold position and
 *  a rear anchor plants a Large-led row ~20 units outside a 60-unit melee reach, where
 *  it could never be hit at all. Waiting for the arrival keeps the front anchor and
 *  costs the transient nothing: the row re-forms on the frame its new leader reaches the
 *  line, with that leader in contact, so there is no moment where nobody is. */
const ROW_ANCHOR_EPS = 2;
/** How deep behind the line a zombie can still swing from. The source has NO such band — a
 *  zombie attacks once it has ARRIVED at its computed destination, however deep — but this
 *  sim's "everyone in the combat zone attacks" rule needs a number, so there is nothing to
 *  move it to. Held at exactly the 4x52+12 it has always been: the elite-balance guardrails
 *  sit close enough to their thresholds that even a 5% change here tips one of them, and
 *  that would be an unrelated balance edit riding along with a formation fix. */
const COMBAT_ZONE_DEPTH = 4 * 52 + 12;
/** Depth one row occupies at the source's own scale: the slot fan plus the spread between
 *  the heaviest and the lightest standoff. Derived, not authored — dropping the Small
 *  bucket narrowed that spread from 30 source points to 20, so the row is genuinely
 *  shallower than it was and `rowXFit` compresses it less. */
const BAND_ROW_DEPTH = (BAND_SIZE - 1) * SLOT_X_STEP
  + (Math.max(...Object.values(SRC_BODY_STANDOFF)) - Math.min(...Object.values(SRC_BODY_STANDOFF)))
    * SIM_PER_SOURCE_X;

// Anti-one-shot safeguard (INFERRED from `-[Actor damage:]` 0x3a064). A single ENEMY hit
// blow can't take a player zombie from above the floor straight to death or below 10% of max
// HP — its HP snaps to exactly 1 instead, so it survives to act once more. Protection is
// latched as consumed so healing above 1 HP cannot re-arm it; the next lethal hit kills it.
// This models the in-binary state bit 0x10 that eventually permits the killing blow, which
// we can't fully pin. `turnZombie` deliberately bypasses it because that action converts the
// target rather than dealing an ordinary hit.
const ONE_SHOT_FLOOR = 0.1; // hit is capped if it would leave HP fraction below this

// Mini Buddy: the binary sets the carrier to 4× walking speed. On arrival it
// stuns the enemy for 2 seconds and the carrier for 1 second.
const MINI_MOUNT_MS = 500;
const MINI_CARRIER_SPEED_MULT = 4;
const MINI_ENEMY_STUN_MS = 2000;
const MINI_CARRIER_STUN_MS = 1000;

// Garden support recovered from ZombieActorGarden: both heals restore half of
// finalPower. Heal selects another zombie at or below 50% Life; Heal All has its
// own automatic 20-second timer.
const HEAL_POWER_MULT = 0.5;
/** No revive ever happens on the defender pass, so it shares one frozen empty set. */
const EMPTY_CAST: ReadonlySet<string> = new Set<string>();
const HEAL_AOE_MS = 20_000;

// Ballistic throws.
const GRAVITY = 820; // sim px/s^2 pulling projectiles down
const GROUND_Y = BAND_BOT + 24; // a throw that reaches here has missed (fizzles)
const ZOMBIE_HIT_R = 30; // zombie collision radius in sim units
const PROJ_HIT_FACTOR = 0.4; // projectile radius = spriteSize * this
// Predictive lead: throws aim where the target WILL be after the flight time, but the
// lead speed is CAPPED here — a target moving faster than this is led only as much as a
// "lowish speed" zombie would be, so the throw lands behind it and a fast zombie outruns
// the shot. Normal/slow zombies (≤ cap) are led accurately and get hit. Chosen against
// advanceSpeed(dex) (90–260): ~dex 1–4 (≤178) are led enough to connect; dex 5+ (≥200)
// under-lead into a miss on the longer lobs to the back of the lane.
const PREDICT_SPEED_CAP = 150; // sim px/s — never lead a target faster than this
// Above this per-step displacement, a unit was teleported (knockback re-slot, boss
// perch↔ground) rather than walking — its measured velocity is discarded (max real
// step is moveSpeed≤260 × dt≤0.05s ≈ 13 px).
export const TELEPORT_PX = 40;
// Boss-action throw damage is an independently authored chip value applied VERBATIM:
// `ZFFightPhysics throwProjectile:` reads the bossAction's @"damage" straight into the
// projectile's `damageAmount`, and the contact handler passes that to `[zombie damage:]`.
// No conversion, no scaling — McDonnell's 6/12/18 really are 6/12/18 against con×100 HP.

// ---- Round timer + enrage (ZFFightMan updateTimer:/showEnrageTimer) ----
// The fight is a countdown; when it expires the boss ENRAGES. The reference build
// shows a 3:00 round. On enrage the boss throws twice as fast, recovers its special
// actions faster, and hits ~1.5× harder (chip → threat if you stall).
const DEFAULT_ROUND_MS = 3 * 60 * 1000; // 3:00
const ENRAGE_THROW_MULT = 0.5; // throw interval halves
// One full arm-swing of the perched boss's throw animation. The sim owns this value —
// not just the renderer — because a throw held on an empty lane parks its timer HERE
// rather than at zero (ruleset 39): the release is then always a whole wind-up after a
// target enters the lane, so the renderer can never be asked to launch a projectile it
// was given no frames to telegraph. bossThrowSwing() reads the same constant, keeping
// the animation window and the guaranteed gap between lane-entry and release identical.
export const THROW_WINDUP_MS = 550;
const ENRAGE_SPECIAL_MULT = 0.6; // special cooldowns shorten
const ENRAGE_DMG_MULT = 1.5; // boss melee damage grows

// ---- Boss special actions (non-throw bossActions) ----
// alienLaser fires a fast straight bolt (flat 200, ALIEN_LASER_DAMAGE); pixelFire sets
// ONE zombie on fire; turnZombie removes your front zombie (it's turned against you);
// telekinesis lifts + slams a zombie for knockback and stun but NO damage. summonBoss
// spawns a capped reinforcement and wall spawns a single standing blocker — both go
// through spawnEnemy and join the normal queue. Damage values are all ground truth
// (see combatStats); only the telekinesis hold below is un-recovered.
// Alien laser bolt speed. GROUND TRUTH: `AlienStageBullet init` ends with
// `setSpeed: 3.0`, and `ZFBulletWrapper bulletTime:` integrates
// `position += unitVector * (dt * 60 * speed)` — i.e. 180 points/second in the source's
// 480x320 stage. This field is FIELD_W (1000) wide, so 180 * 1000/480 = 375 sim px/s.
// (The old 900 was a guess and made the bolt effectively instant.)
const LASER_SPEED = 3.0 * 60 * SIM_PER_SOURCE_X; // straight-bolt speed (sim px/s)
/** The saucer's two gun ports, from `AlienStageActor createBullet`'s 50/50 roll. Source
 *  offsets are cocos2d (y UP) points off the boss, so y is negated into the sim's
 *  y-down space and both axes are scaled into field units. */
const LASER_MUZZLE_A = { dx: -55 * SIM_PER_SOURCE_X, dy: -2 * SIM_PER_SOURCE_Y };
const LASER_MUZZLE_B = { dx: 5 * SIM_PER_SOURCE_X, dy: 5 * SIM_PER_SOURCE_Y };
/** Sprite key for the bolt, so the renderer draws the authored laser art instead of the
 *  generic orange "no art" hazard dot every unnamed projectile falls back to. */
export const ALIEN_LASER_SPRITE = "alienLaser";
// Telekinesis hold. `stunSelfFor:` takes its duration from the action, which this
// data doesn't carry, so the sim uses the same 1 s as an ordinary stun attack.
const TELEKINESIS_STUN_MS = 1000;

// ---- Knockback (`Actor damageIn:` 0x3777a -> `Actor knockBackBy:force:` 0x37e68) ----
// GROUND TRUTH: `[victim knockBackBy: -(50 + arc4random() % 100) force: 5.0]`. So the shove
// is 50-149 source points BACKWARD, randomised per hit, and it is a SLIDE at force*60
// points/second (0.17-0.5 s of travel), not a teleport. See knockBackZombie / stepKnockBack.
// The shove is expressed in MELEE GAPS rather than raw points, and that is deliberate.
// Straight unit conversion (x FIELD_W/480) would be wrong here: this sim's lane is 1000
// wide against the source's 480, but its ENGAGE distance is 60 where the source's melee gap
// is 55 — so combat distances live at roughly 1:1 while the lane lives at 1:2. Scaling a
// shove by the lane factor would make it nearly three melee gaps deeper than the source's.
// Measured against the gap it is a shove away from, 50-149 points is 0.91-2.71 gaps, which
// is the invariant that survives either scale. The slide DURATION is exact either way — the
// scale cancels between distance and speed.
const SRC_MELEE_GAP = 55; // zombieAttackPosition.x - front row x, from calculateDestinationPoint
const SRC_KNOCKBACK_BASE = 50; // the shove's fixed part; the roll adds 0..99 on top
const SRC_KNOCKBACK_FORCE = 5; // `force:` — multiplied by 60 for points/second

// ---- Carried-grab hazard (Circus Trapeze Artist `grabZombie`) ----
// GROUND TRUTH (Enemies.json Trapeze Artist + StageActor doActionsForString:): the actor
// sweeps in from the LEFT across the combat band, grabs the rear-most deployed zombie
// (collidedAction grabZombie → the zombie goes inactive), pauses ~1s, then RISES to carry
// it off (changeSpeed_0.5 : setRotationTo_90). The player taps it (touchedAction
// damageSelf_100, tapDelay 0.25) to whittle its HP; killed → dyingAction dropZombie frees
// the zombie back into the fight; if it reaches its exit still carrying, that zombie DIES.
// movingAnimation `rotateTo_180_17`: Actor.parseAnimationString interprets this
// as a 180-degree target over 17 animation ticks (the stage cadence is 0.1 s).
// Collision then explicitly snaps the grabbed actor to 90 degrees for the carry.
const GRABBER_FULL_ARC_MS = 1700;
// The texture runs from its suspension point at x=0 to the artist at the far end.
// In logical field space that span is about half the lane, so the target's x determines
// the angle at which the artist reaches it. Successive appearances approach that angle
// from alternating sides instead of traversing both directions in one appearance.
const GRABBER_SWING_RADIUS_X = FIELD_W * 0.5;
const GRABBER_CONTACT_DEG = 90;
const GRABBER_RISE_SPEED = 92; // carry-off rise speed (sim px/s), the slow 0.5 speed
const GRABBER_CARRY_PAUSE_MS = 1000; // changeStateWithDelay_run_1: hold 1s before rising
// tapDelay 0.25 — min gap between registered taps, shared by both rescue hazards. This is
// the AUTHORED (touch) pace; the live scene overrides it per input device through
// `hazardTapCooldownMs`. See src/raid/hazardTaps.ts.
const RESCUE_TAP_CD_MS = 250;
// The renderer places this pivot at horizontal center and one-quarter viewport above
// the top edge. The logical x is retained for target-angle and snapshot calculations.
const GRABBER_PIVOT_X = FIELD_W * 0.5;
const GRABBER_PIVOT_Y = BOSS_STRUCT_Y - 140;
// Keep the zombie a little below the ground-line offset at pickup. This makes its upper
// body meet the artist while leaving the zombie itself lower during the upward carry.
const GRABBER_ZOMBIE_OFFSET_Y = CENTER_Y - GRABBER_PIVOT_Y + 30;
// mapProjY maps BOSS_STRUCT_Y to the visible perch, not the top edge. A full logical
// field-height above zero clears even the tallest stage perch, so the zombie stays alive
// until its whole sprite is off-screen rather than dying after the first small lift.
const GRABBER_ESCAPE_ZOMBIE_Y = -FIELD_H;
const GRABBER_SPAWN_MS = 7000; // respawn cadence after one leaves (initial from config)
// ---- Beach crab hazard (BeachStageActorCrab) ----
// Disassembled: wanders, grabs a zombie on contact, holds 2 s, then carries it off the
// LEFT edge (source destination x = −100) where the zombie leaves the fight. Tapped to
// death → the zombie is released and resumes. See types.ts CrabConfig.
const CRAB_WALK_SPEED = 70; // lane speed (sim px/s). NOT ground truth — the source sets
// this via a scaled setWalkingSpeed: the disassembly did not resolve; tuned to read as a
// scuttle that a player has time to react to.
const CRAB_CARRY_SPEED = 95; // speed while hauling a zombie toward the left edge
const CRAB_EXIT_X = -60; // past this (off the left edge) the carried zombie is out
const CRAB_HIT_R = 30; // contact radius for the grab (sim units)
const CRAB_WANDER_MS = 1400; // how long it holds one wander heading before re-picking
// Wander band: the source picks random destinations around the mid-lane. The exact
// formula did not disassemble cleanly, so this is a bounded patrol of the contested
// middle instead of a guess at the original RNG.
const CRAB_WANDER_MIN_X = 300;
const CRAB_WANDER_MAX_X = 760;

// ---- Boss summon / wall specials ----
/** Where an abducted human is beamed down. GROUND TRUTH (`-[ZFFightMan summonBoss:]`
 *  0x5ef28): the spawn point is `CGPointMake(240, enemyPosition.y)`, or 480 on an iPad —
 *  the one value the method picks off `userInterfaceIdiom`. Both are the exact horizontal
 *  CENTRE of that build's stage (480 wide on the phone, 960 on the tablet), so an abductee
 *  lands mid-field rather than walking in through the wave's doorway like every other
 *  enemy.
 *
 *  It lands on the SCORCH MARK rather than on that arithmetic centre. The burnt
 *  crop-circle in fightBGAlien_bg.png — visibly what the beam targets — has its core at
 *  about x=220 of the 480-wide art, a little LEFT of the middle. RaidScene insets the
 *  combat lane by FIELD_INSET_FX (10 % of the stage width) at each end, so sim x renders
 *  at art `48 + (x/1000)*384`; art 220 is sim 448 and the stage centre is sim 500.
 *  Playtest call, and the art wins: a beam that misses its own landing burn reads as a
 *  bug however defensible the number behind it is.
 *
 *  This is the point the abductee is CENTRED on. Enemy rigs are drawn from their
 *  model-space left edge rather than their middle, so RaidScene shifts a summon left by
 *  its own half-width (`hpCenterX`) to put the figure here — per unit, because the five
 *  abductees are not the same width and a fixed offset would only centre the widest. */
const SUMMON_SPAWN_X = 448;
/** An abductee STANDS where it lands. It never walks, chases or repositions — it holds
 *  dead centre and swings at whatever comes into reach.
 *
 *  That makes it a mid-lane roadblock rather than a member of the wave, so zombies treat
 *  it the way they already treat a boss WALL: those that have not yet passed it stop
 *  short and fight it, and those already ahead of it carry on (the `passedWall` latch).
 *  Some such rule is forced — the zombies' combat zone begins COMBAT_ZONE_DEPTH short of
 *  the front line, well beyond centre, so without it an abductee could chip the army as
 *  it filed past and never be reachable in return. */
const SUMMON_MELEE_GAP = ENGAGE;
// There is deliberately NO summon cap. GROUND TRUTH (`summonBoss:` 0x5ee2c): every cast
// pops `bossSummonList[0]` and pushes a freshly rolled replacement, so the list never
// empties. `allowedToSummonBoss` (0x5eda4) is the real limit — the summoned actor is
// parked in the `bossWall` ivar, so a second one is refused until the first is dead.
// Per-tap chip on a boss wall (ground truth ZFFightWall ccTouchEnded → damage: = const/20,
// const ≈ the wall's HP 1500 → 75). Zombies do the bulk; tapping is an assist.
const WALL_TAP_DAMAGE = 75;
// Walls materialize where Garden support normally holds. Zombies that had already
// crossed that point when the cast began keep fighting ahead; everyone behind it must
// stop here and break it before continuing.
const WALL_MELEE_GAP = ENGAGE;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Deterministic 0..1 hash (no RNG — keeps the sim replayable). */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function stringSeed(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i++) out = (Math.imul(out, 31) + value.charCodeAt(i)) >>> 0;
  return out % 100;
}

export function laserInterval(abilities: readonly string[], attackCooldownMs: number): number {
  if (abilities.includes("zomBeam")) return attackCooldownMs / 6;
  if (abilities.includes("laserBeam")) return attackCooldownMs / 3;
  return 0;
}

/** Zombie advance speed scales with DEX (quicker zombies reach the front sooner). */
function advanceSpeed(dex: number): number {
  return clamp(90 + dex * 22, 90, 260);
}

/** A loose 2D spot in the left-side waiting group. */
function clusterHome(i: number): { x: number; y: number } {
  const cols = 3;
  const bx = 45 + (i % cols) * 32;
  const by = BAND_TOP + 40 + Math.floor(i / cols) * 42;
  const jx = (hash(i * 2 + 1) - 0.5) * 26;
  const jy = (hash(i * 2 + 7) - 0.5) * 26;
  // Preserve the original loose formation and move the entire crowd left uniformly.
  return { x: clamp(bx + jx, 26, 158) - 27, y: clamp(by + jy, BAND_TOP, BAND_BOT) };
}

export type UnitState =
  | "waiting" // zombie milling in the back group
  | "charging" // zombie stepping out + focusing
  | "advance" // released, moving to the front line
  | "fight" // trading blows
  | "carried" // Small zombie riding a Large zombie via Mini Buddy
  | "grabbed" // seized by the Trapeze Artist — inactive, being carried off (rescue by tapping)
  | "queued" // enemy off-screen, not yet emerged
  | "descending" // boss coming down off the structure + exiting out the back
  | "emerging" // enemy walking to its holding spot (or boss re-entering)
  | "falling" // Epic Boss dropping vertically from above the stage
  | "landing" // Epic Boss playing its authored landing/enter beat
  | "structure" // boss perched on its structure, throwing
  | "hold" // enemy standing, no target in range
  | "dead";

/** A combatant with spatial + charge state, consumed by the renderer each frame. */
export interface SimUnit {
  id: string;
  sourceKey: string;
  mutation: number;
  team: "player" | "enemy";
  name: string;
  group?: string;
  className?: string;
  /** Presentation-only body tint (see CombatUnit.color). Never read by the sim. */
  color?: [number, number, number];
  isBoss: boolean;
  isGarden: boolean;
  isHeadless: boolean;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  damageReduction: number;
  teamAuraStats: CombatUnit["teamAuraStats"] | null;
  attackMultiplier: number;
  walkingSpeedMult: number;
  alive: boolean;
  oneShotProtectionUsed: boolean; // remains consumed through healing and replay checkpoints
  state: UnitState;
  charge: number; // 0..1 focus fill (zombies only)
  focus: number; // 0..100 focus stat: distraction resistance (ground truth Help.json)
  // ---- focus-bubble minigame (zombies, while charging) ----
  distracted: boolean; // butterfly bubble showing — fill paused until popped
  awaitRelease: boolean; // brain bubble showing — full, gated until popped
  distractStep: number; // how many CHARGE_STEPS have fired (0..4)
  distractSeed: number; // per-unit seed for the deterministic distraction roll
  bubbleMs: number; // ms until the current bubble auto-resolves
  struckThisTick: boolean;
  vx: number; // measured velocity over the last step (sim px/s) — drives throw lead
  vy: number;
  prevX: number; // position at the start of the current step (velocity bookkeeping)
  prevY: number;
  damage: number;
  /** Primary authored attack name, used only to select its presentation SFX. */
  attackName: string;
  cooldownMs: number;
  timerMs: number;
  moveSpeed: number;
  power: number; // finalPower, retained for lasers and Garden heals
  homeX: number; // waiting-group spot (zombies)
  homeY: number;
  mill: number; // per-unit wander phase
  formOrder: number; // release order (formation priority tiebreak)
  /** Headless units push to the front. Sending one to the back temporarily clears
   * this flag so the row behind can fill the vacancy while it recovers. */
  frontPriority: boolean;
  lineupIndex: number; // front-to-back rank among committed zombies (0 = front) → damage band
  slotX: number; // assigned formation position
  slotY: number;
  // ---- abilities ----
  abilities: string[]; // this unit's unlocked ability keys (players only)
  windupKey: string | null; // the activated move currently charging (null = none)
  windupMs: number; // ms left in the current wind-up
  windupTotal: number; // full wind-up duration (for the charge bar)
  abilityCdMs: number; // cooldown before this unit can be activated again
  buddyId: string | null; // Small zombie currently carried by this Large zombie
  buddyCarrierId: string | null; // Large zombie carrying this Small zombie
  buddyMountMs: number; // jump-to-carrier animation time remaining
  healTimerMs: number; // Garden support heal cadence
  healAoeTimerMs: number; // independent 20-second Heal All timer
  /** Running total of post-mitigation damage AIMED at this unit (renderer trigger).
   *  Presentation only — nothing in the simulation reads it. It is the damage the
   *  attack DEALT, after armor / damage reduction / attack multipliers, and BEFORE
   *  the two clamps that decide how much health actually came off: the remaining-HP
   *  floor (overkill) and the one-shot protection latch. That is what the floating
   *  damage numbers report, so a 5000 slam on a 300-HP zombie reads 5000 rather than
   *  300, and a latched hit reads its real size rather than "maxHp - 1". A fully
   *  mitigated hit (a Block proc) adds nothing and so shows no number at all. */
  damageFxTaken: number;
  healFxSeq: number; // increments when this unit receives a heal (renderer trigger)
  healCastSeq: number; // increments when this Garden zombie performs a heal
  laserTimerMs: number; // automatic walking-laser cadence
  laserFxSeq: number; // increments when a walking laser fires (renderer trigger)
  laserTargetId: string | null; // target of the most recent walking laser
  explodeFxSeq: number; // increments on the tick this unit blows itself up (renderer trigger)
  abilityRollSeq: number; // replay-safe proc sequence (Block/Stun/Double Strike)
  usedAbilities: string[]; // one-use activated abilities already consumed
  resurrectUsed: boolean; // one-use automatic Resurrect latch
  stunMs: number; // ms of stun left — can't act while > 0 (enemies AND zombies)
  /** Live knockback slide (`ActorFightData knockBackPoint` / `knockBackSpeed`). While
   *  `knockBackMs > 0` the zombie is being shoved and is NOT in melee — it can't attack,
   *  can't be targeted as an engaged unit, and doesn't walk. 0 = no slide. */
  knockBackToX: number;
  knockBackSpeed: number; // sim px/s of the slide (0 = not sliding)
  // ---- enemy attack effects inflicted on a struck zombie ----
  knockBack: boolean; // this enemy's attack shoves the zombie back down the lane
  /** Share of this enemy's swings that actually carry the shove — one attack is rolled
   *  per swing, so an effect on a 10 %-frequency entry lands one hit in ten. See
   *  CombatEngine.attackEffects. */
  knockBackChance: number;
  stunInflictMs: number; // stun this enemy applies to a zombie on hit (ms)
  stunChance: number; // …and the same share for the stun.
  attackDamageTiming: number; // 0..1 fraction of the swing when it connects (enemy anim)
  isWall: boolean; // boss-summoned blocker (carrotWall / junkWall) — tappable, no attacks
  /** Abducted human beamed in by the alien boss's `summonBoss`. It fights like any other
   *  enemy but is OFF-BUDGET: the source only decrements `enemyPopulation` for a dying
   *  actor that is NOT `fightMan.bossWall` (`civilianUpdate` 0x687c0), so a summon neither
   *  counts toward the wave nor holds the boss on its perch. Without that exclusion an
   *  uncapped summon would deadlock the descent. */
  isSummon: boolean;
  /** A pixel zombie Zedzox's `turnZombie` made out of one of YOUR zombies (raid 9). It
   *  rides the `isSummon` machinery — stationary mid-lane blocker, off the wave budget —
   *  and additionally does NOT gate the win (see anyAlive): its authored body is a
   *  million hit points, so a fight that had to kill it could never end. */
  isTurned: boolean;
  /** Id of the player zombie this pixel zombie was made from. Tapping it apart hands that
   *  zombie back (see tapTurned), which is the whole reason the taps are worth spending. */
  turnedFromId: string | null;
  /** Ms of `pixelFire` left to burn. While > 0 the zombie panics: no attacks, no advance,
   *  pacing on the spot, losing BURN_MAX_HP_FRACTION_PER_SEC of max HP a second, until it
   *  runs out or the player taps the fire out. */
  burnMs: number;
  /** Which way the panic pace is currently heading (+1 / −1) and how far it has strayed
   *  from where the fire caught it. Kept on the unit so the pacing survives a checkpoint
   *  rather than restarting from the snapshot's position. */
  burnDir: 1 | -1;
  burnAnchorX: number;
  // ---- PvP formation defense (friend invasions). All null outside it, which is
  // what keeps every raid transcript byte-identical. See src/raid/pvp.ts.
  /** Authored hold position: this unit walks here and stands, instead of holding at
   *  the shared doorway. */
  stationX: number | null;
  stationY: number | null;
  /** Fight-clock ms at which this unit walks on, ignoring the wave's drip budget. */
  deployAtMs: number | null;
  /** Held in reserve until the perched boss descends (PvP formation mini). */
  deployWithBoss: boolean;
  /** The job this defender holds in the farm's defense. */
  defenseRole: string | null;
  passedWall: boolean; // latched when already beyond a newly summoned wall
  /** Carried off the field by a Beach crab: still ALIVE (it comes home after the raid —
   *  source state 38 is not the death path) but out of this fight, so it counts as a
   *  survivor while no longer keeping the battle alive. */
  taken: boolean;
  /** Enemy that ignores its dex clock and mirrors its opponent's (Pirate Scallywag). */
  mirrorsOpponentSpeed: boolean;
}

/** A Trapeze Artist grab hazard, consumed by the renderer. Sweeps in, seizes a zombie,
 *  then carries it off unless the player taps it to death. */
/** A Beach crab hazard, consumed by the renderer. Wanders, grabs a zombie, holds, then
 *  hauls it off the left edge unless the player taps it to death. */
export interface SimCrab {
  id: string;
  x: number;
  y: number;
  state: "wander" | "hold" | "carry" | "gone";
  dir: -1 | 1; // current wander heading (−1 = toward the zombies / left)
  wanderMs: number; // time left on the current heading
  hp: number;
  maxHp: number;
  tapDamage: number;
  grabbedId: string | null;
  holdMs: number; // pre-carry pause left (source: 2.0 s)
  tapCdMs: number;
  sprite: string;
  struckThisTick: boolean;
}

export interface SimGrabber {
  id: string;
  x: number;
  y: number;
  state: "swoop" | "carry" | "gone";
  hp: number;
  maxHp: number;
  tapDamage: number;
  grabbedId: string | null; // the zombie being carried (null while still swooping)
  pauseMs: number; // hold time left before it starts rising (post-grab)
  tapCdMs: number; // min gap enforcement between registered taps
  sprite: string;
  rot: number; // visual rotation (renderer)
  swingStartDeg: number; // 0 = enters from right, 180 = enters from left
  contactDeg: number; // target-aware angle where the artist reaches the zombie
  swingTotalMs: number;
  targetId: string | null; // intended contact target while swooping
  struckThisTick: boolean; // a tap landed this step (renderer feedback)
}

/** A boss projectile in flight, consumed by the renderer. Ballistic throws use the
 *  default gravity; straight-line bolts (the alien laser) set `gravity: 0`. */
export interface SimProjectile {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotSpeed: number;
  damage: number;
  sprite: string;
  spriteSize: number;
  done: boolean;
  gravity: number;
}

/** Compact, JSON-safe verifier state used by the server's 15-second replay checkpoints. */
export interface BattleSimSnapshot {
  units: SimUnit[];
  projectiles: SimProjectile[];
  bossId: string | null;
  /** Ms until the pre-rolled `nextAction` resolves (throws and specials share it). */
  actionCd: number;
  nextAction: BossActionChoice | null;
  actionCount: number;
  throwCount: number;
  releaseSeq: number;
  projSeq: number;
  elapsed: number;
  emergeCooldown: number;
  attacksLanded: number;
  playerDamage: number;
  /** Absent on a snapshot taken before technique attribution existed; restored as
   *  empty, which under-reports that fight rather than corrupting it. */
  feats?: RaidFeats;
  /** Ids of every player zombie that has fallen and not been brought back, oldest
   *  first — the source game's `ZFFightMan.defeatedZombies`. Resurrect draws from
   *  it, so it MUST survive a checkpoint or a restored fight would forget its dead.
   *  Optional only so a snapshot that predates the backlog still restores — `restore`
   *  rebuilds it from the units in that case rather than losing every corpse. */
  fallen?: string[];
  roundLeft: number;
  enraged: boolean;
  specialCast: number;
  pendingSpecial: BossSpecial | null;
  /** `bossSummonList` as source keys, in queue order. Replaces the old `summonsLeft`
   *  counter (there is no cap — see the SUMMON notes above). */
  summonQueue?: string[];
  /** The alien reinforcement clock (`spawnTimer`), ms until the next drip. */
  dripLeft?: number;
  /** How many of the wave are allowed on the field right now — grows one per drip. */
  activeTarget?: number;
  spawnSeq: number;
  activatedKeys: string[];
  grabbers: SimGrabber[];
  grabberTimer: number;
  grabSeq: number;
  // Client-only Beach crab hazard: absent from server-built snapshots (see crabOf).
  crabs?: SimCrab[];
  crabTimer?: number;
  crabSeq?: number;
}

/** Deterministic stand-in for the source game's weighted random roll. Replay must be
 * identical on client and server, so hash the independent action counter into a stable
 * unit interval and then apply the recovered cumulative-frequency selection rule. */
function weightedPick<T extends { weight: number }>(items: readonly T[], count: number, salt: number): T | null {
  if (!items.length) return null;
  const weighted = items
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.weight - b.weight);
  if (!weighted.length) return items[count % items.length] ?? items[0];
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let x = (count + 1 + salt) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  const roll = (((x ^ (x >>> 15)) >>> 0) / 0x1_0000_0000) * total;
  let cumulative = 0;
  for (const item of weighted) {
    cumulative += item.weight;
    if (roll < cumulative) return item;
  }
  return weighted[weighted.length - 1];
}

function toSim(u: CombatUnit, i: number): SimUnit {
  const mult = u.attacks[0]?.mult ?? 1;
  const isPlayer = u.team === "player";
  const home = isPlayer ? clusterHome(i) : { x: ENEMY_SPAWN_X, y: CENTER_Y };
  // Enemies are authored with `abilities: []` everywhere in the raid catalog, so
  // passing the list through is byte-identical for raids — and it is what lets a PvP
  // formation defender keep the passives that run themselves (a healer that heals).
  const abilities = u.abilities ?? [];
  return {
    id: u.id,
    sourceKey: u.sourceKey,
    mutation: u.mutation ?? 0,
    team: u.team,
    name: u.name,
    group: u.group,
    className: u.className,
    color: u.color,
    isBoss: u.isBoss,
    isGarden: u.isGarden,
    isHeadless: u.isHeadless,
    x: home.x,
    y: home.y,
    // Epic Boss attempts can begin with damage retained from an earlier escape.
    // Preserve the supplied combat HP instead of silently healing every unit to
    // max while translating it into simulation state.
    hp: Math.max(0, Math.min(u.maxHp, u.hp)),
    maxHp: u.maxHp,
    damageReduction: u.damageReduction ?? 0,
    teamAuraStats: u.teamAuraStats ? { ...u.teamAuraStats } : null,
    attackMultiplier: mult,
    walkingSpeedMult: u.walkingSpeedMult ?? 1,
    alive: true,
    oneShotProtectionUsed: false,
    state: isPlayer ? "waiting" : "queued",
    charge: 0,
    focus: u.focus ?? 0,
    distracted: false,
    awaitRelease: false,
    distractStep: 0,
    distractSeed: i,
    bubbleMs: 0,
    struckThisTick: false,
    vx: 0,
    vy: 0,
    prevX: home.x,
    prevY: home.y,
    // Ground-truth per-swing damage BEFORE the lineup band: finalPower(str×10) × attackMult.
    // Enemies use this as-is (band always 1.0); a player zombie's normal swing multiplies it by
    // lineupDamageBand(lineupIndex) at hit time (activated specials use the unbanded value).
    damage: Math.max(1, Math.round(deriveHitDamage(u.str * POWER_PER_STR, mult))),
    attackName: u.attacks[0]?.name ?? "",
    cooldownMs: u.attackCooldownMs,
    timerMs: u.attackCooldownMs,
    moveSpeed: isPlayer ? advanceSpeed(u.dex) * (u.walkingSpeedMult ?? 1) : EMERGE_SPEED,
    power: u.str * POWER_PER_STR,
    homeX: home.x,
    homeY: home.y,
    mill: hash(i * 3 + 2) * Math.PI * 2,
    formOrder: 0,
    frontPriority: isPlayer && !!u.isHeadless,
    lineupIndex: 0,
    slotX: home.x,
    slotY: home.y,
    abilities,
    windupKey: null,
    windupMs: 0,
    windupTotal: 0,
    abilityCdMs: 0,
    buddyId: null,
    buddyCarrierId: null,
    buddyMountMs: 0,
    healTimerMs: 0,
    healAoeTimerMs: abilities.includes("healAOE") ? 20_000 : 0,
    damageFxTaken: 0,
    healFxSeq: 0,
    healCastSeq: 0,
    laserTimerMs: laserInterval(abilities, u.attackCooldownMs),
    laserFxSeq: 0,
    laserTargetId: null,
    explodeFxSeq: 0,
    abilityRollSeq: 0,
    usedAbilities: [],
    resurrectUsed: false,
    stunMs: 0,
    knockBackToX: 0,
    knockBackSpeed: 0,
    knockBack: !isPlayer && !!u.knockBack,
    // Absent chance = "every swing carries it", but only where the effect exists at
    // all: defaulting a unit with no stun to stunChance 1 would open the shared roll
    // below for it and hand back the every-hit knockback this replaced.
    knockBackChance: isPlayer ? 0 : u.knockBackChance ?? (u.knockBack ? 1 : 0),
    stunInflictMs: isPlayer ? 0 : u.stunMs ?? 0,
    stunChance: isPlayer ? 0 : u.stunChance ?? ((u.stunMs ?? 0) > 0 ? 1 : 0),
    attackDamageTiming: u.attackDamageTiming ?? 0.5,
    isWall: false,
    isSummon: false,
    stationX: u.stationX ?? null,
    stationY: u.stationY ?? null,
    deployAtMs: u.deployAtMs ?? null,
    deployWithBoss: u.deployWithBoss ?? false,
    defenseRole: u.defenseRole ?? null,
    isTurned: false,
    turnedFromId: null,
    burnMs: 0,
    burnDir: 1,
    burnAnchorX: home.x,
    passedWall: false,
    taken: false,
    mirrorsOpponentSpeed: !isPlayer && !!u.mirrorsOpponentSpeed,
  };
}

export class BattleSim {
  readonly units: SimUnit[];
  readonly projectiles: SimProjectile[] = [];
  /** Presentation-only count; reset at the start of every fixed simulation step. */
  projectileImpactsThisTick = 0;
  /** Presentation-only: the `sprite` of the last projectile to connect this step, so the
   *  renderer can pick the authored impact cue (the alien bolt plays stun.wav, not the
   *  generic splat). Cleared with the count above. */
  lastProjectileImpactSprite = "";
  /** Minimum gap between rescue-hazard taps that register (Trapeze Artist, Beach crab).
   *  Defaults to the authored touch pace; the live scene lowers it for a mouse, which
   *  clicks two to three times faster than the gate allows and had most of those clicks
   *  silently discarded. Safe to vary because BOTH hazards are client-only and neither
   *  one's taps are transcribed — the verifier never calls tapCrab/tapGrabber at all, so
   *  it keeps this default forever. See src/raid/hazardTaps.ts. */
  hazardTapCooldownMs = RESCUE_TAP_CD_MS;
  private players: SimUnit[];
  private enemies: SimUnit[];
  private boss: SimUnit | null;
  private bossThrow: BossThrowConfig | null;
  private throwCount = 0;
  private releaseSeq = 0;
  private projSeq = 0;
  private elapsed = 0;
  private emergeCooldown = 0;
  private attacksLanded = 0;
  private playerDamage = 0;
  /** Technique record for achievement quests — see RaidFeats. Part of the snapshot so
   *  a sim restored mid-fight keeps what it has already witnessed. */
  private feats: RaidFeats = emptyRaidFeats();
  /** GROUND TRUTH (`-[ZombieActor fightUpdate:]` 0x4d406): a zombie that dies is appended
   *  to `ZFFightMan.defeatedZombies` and removed from `zombies`. Nothing ever drains that
   *  list except a revival, so it is a BACKLOG that accumulates for the whole fight —
   *  Resurrect is polled against it (`canRez`), not fired at the instant of a death. That
   *  is why a Garden zombie deployed AFTER a casualty can still bring that casualty back.
   *  Ids, not references, so the list survives snapshot/restore intact. */
  private fallen: string[] = [];
  finished = false;
  // ---- round timer + enrage ----
  private roundLeft: number;
  private _enraged = false;
  escaped = false;
  // ---- boss actions (throws AND specials share ONE budget — see stepBossActions) ----
  private specials: BossSpecial[];
  private actions: BossActionChoice[] = []; // the merged weighted roll table
  private nextAction: BossActionChoice | null = null; // pre-rolled, so the renderer can telegraph
  private actionCd = 0; // ms until `nextAction` resolves
  private actionCount = 0; // deterministic roll counter
  private specialCast = 0; // wind-up left on the pending special
  private pendingSpecial: BossSpecial | null = null;
  // ---- carried-grab hazard (Trapeze Artist) ----
  readonly grabbers: SimGrabber[] = [];
  private grabberCfg: GrabberConfig | null;
  private grabberTimer: number; // ms until the next trapeze sweeps in
  private grabSeq = 0;
  // ---- Beach crab hazard (client-only; see the ctor param) ----
  readonly crabs: SimCrab[] = [];
  private crabCfg: CrabConfig | null;
  private crabTimer: number; // ms until the next crab scuttles in
  private crabSeq = 0;
  // ---- summon / wall specials ----
  private summonCfg: SummonConfig | null;
  /** `bossSummonList`, by source key. Popped from the front, pushed on the back. */
  private summonQueue: string[] = [];
  private wallTemplate: CombatUnit | null;
  /** The pixel zombie `turnZombie` stands up (null = this boss can't turn anyone). */
  private turnedTemplate: CombatUnit | null;
  private spawnSeq = 0;
  // ---- wave cadence (see types.WaveCadence) ----
  private cadence: WaveCadence;
  private dripLeft: number;
  /** Enemies allowed on the field right now. Starts at 1 and climbs by one per drip up
   *  to `cadence.maxActive`, which is how the source's swarm actually builds: the drip
   *  can only ever fill ONE free `enemySlots` entry per tick. */
  private activeTarget = 1;
  private engageDistance: number;
  private rowXFit = 1; // fraction of the recovered in-row depth that fits inside contact
  private frontX: number;
  /** Any defender carries an authored station (PvP formation defense). Absent in every
   *  raid, which is what keeps the dynamic front line below off their transcripts. */
  private authoredStations = false;
  private supportX: number;
  /** Distinct ACTIVATED moves present in the army (fixed) — the tappable strip. */
  readonly activatedKeys: string[];
  /** The same moves grouped into the BUTTONS that show them (fixed): Explode and
   *  Explode Ver.2 share one, everything else — Bash and Smash included — stands
   *  alone. Derived from `activatedKeys`, so it needs no snapshot slot. See
   *  ACTIVATED_STACKS for why that pair is the only one worth collapsing. */
  readonly activatedGroups: string[][];
  /** Distinct TEAM-passive abilities present (fixed) — the strip's info icons. */
  readonly teamKeys: string[];

  constructor(
    playerUnits: CombatUnit[],
    enemyUnits: CombatUnit[],
    bossThrow: BossThrowConfig | null = null,
    /** Concentration boost spent: skip the focus-bubble minigame (no distractions,
     *  auto-release at full), matching the boost's "fight at full focus" effect. */
    private concentration = false,
    /** Boss special (non-throw) actions to schedule. */
    bossSpecials: BossSpecial[] = [],
    /** Round length before the boss enrages (ms). */
    roundMs: number = DEFAULT_ROUND_MS,
    /** The alien boss's abductee queue (null = this boss can't summon). */
    summonCfg: SummonConfig | null = null,
    /** Blocker the boss's `wall` action spawns (null = don't). */
    wallTemplate: CombatUnit | null = null,
    /** Epic Boss: no butterflies, but the full brain bubble still gates release. */
    private noDistractions = false,
    /** Epic Boss: reaching zero ends the attempt instead of triggering enrage. */
    private escapeOnRoundEnd = false,
    /** Epic Boss presentation: fall from above and land on the combat line instead
     *  of walking in from the right or occupying the normal raid perch. */
    private bossFallsFromSky = false,
    /** Larger bosses need a wider melee line so their art does not swallow zombies. */
    engageDistance = ENGAGE,
    /** Carried-grab hazard (Circus Trapeze Artist) for this raid (null = none). */
    grabber: GrabberConfig | null = null,
    /** Beach crab hazard (null = none). CLIENT-ONLY by design: the server verifier
     *  omits it, so the authoritative replay is the un-harassed run and a crab can only
     *  ever make the player's own result WORSE. See RaidManager.crabOf. */
    crab: CrabConfig | null = null,
    /** How this stage feeds its wave in. Only Zombies vs Aliens departs from the
     *  one-at-a-time default; see types.WaveCadence. */
    cadence: WaveCadence = SOLO_WAVE,
    /** The pixel zombie the Video Games boss's `turnZombie` converts a zombie INTO
     *  (null = this boss can't turn anyone). See raid/videoGameStage.ts. */
    turnedTemplate: CombatUnit | null = null
  ) {
    this.engageDistance = Math.max(ENGAGE, Math.min(300, engageDistance));
    this.grabberCfg = grabber;
    this.grabberTimer = grabber?.spawnDelayMs ?? Infinity;
    this.crabCfg = crab;
    this.crabTimer = crab?.spawnMs ?? Infinity;
    const enemyHoldX = this.bossFallsFromSky ? EPIC_BOSS_HOLD_X : ENEMY_HOLD_X;
    this.frontX = enemyHoldX - this.engageDistance;
    // A formation defense does not stand at the shared doorway, so the army's line
    // cannot be a constant derived from it — see refreshFrontLine, which runs once the
    // rosters below exist and again every step.
    this.authoredStations = enemyUnits.some((u) => u.stationX !== undefined && u.stationX !== null);
    // How much of the recovered row depth actually fits. The source's row spans ~90 of its
    // own points and its enemies reach that far; ours reach `engageDistance`, which is less
    // than half that, so the standoff/fan is compressed to fit inside contact. The ORDER is
    // untouched — only the absolute gaps shrink — and this is the one place the recovered
    // formation does not survive at the source's own scale. Raising `ENGAGE` to the
    // source's melee gap would let it, at the cost of re-balancing every raid.
    this.rowXFit = Math.min(1, Math.max(0, this.engageDistance - 8) / BAND_ROW_DEPTH);
    this.supportX = CHARGE_X + (this.frontX - CHARGE_X) * 0.5;
    // Boss always resolves last, after the normal enemies.
    const ordered = [...enemyUnits].sort((a, b) => Number(a.isBoss) - Number(b.isBoss));
    this.players = playerUnits.map((u, i) => toSim(u, i));
    this.enemies = ordered.map((u, i) => toSim(u, i));
    this.units = [...this.players, ...this.enemies];
    this.refreshFrontLine();

    this.boss = this.enemies.find((e) => e.isBoss) ?? null;
    if (this.boss) {
      if (this.bossFallsFromSky) {
        this.boss.state = "falling";
        this.boss.x = EPIC_BOSS_HOLD_X;
        this.boss.y = EPIC_BOSS_FALL_Y;
      } else {
        this.boss.state = "structure";
        // An authored perch (PvP formation defense) wins over the shared structure
        // position, which is tuned for a boss SPRITE rather than a zombie rig.
        this.boss.x = this.boss.stationX ?? BOSS_STRUCT_X;
        this.boss.y = this.boss.stationY ?? BOSS_STRUCT_Y;
      }
    }
    // Own it: enrage halves `intervalMs` IN PLACE (see applyEnrage), and the verifier is
    // handed the same pinned config object every time it builds a sim. Sharing it meant a
    // second sim off one config started with an already-enraged boss — the replay silently
    // stopped being a pure function of (config, transcript).
    this.bossThrow = bossThrow ? { ...bossThrow } : null;
    this.specials = this.boss ? bossSpecials : [];
    this.actions = this.buildActionBudget();
    this.rollNextAction();
    // `bossActionCooldownTimer` is only ever written by bossUpdate:, so it starts at
    // ObjC's zero — the boss's first action resolves as soon as it becomes active.
    this.actionCd = 0;
    this.roundLeft = roundMs;
    this.summonCfg = this.boss ? summonCfg : null;
    this.summonQueue = this.summonCfg ? this.summonCfg.queue.map((u) => u.sourceKey) : [];
    this.wallTemplate = this.boss ? wallTemplate : null;
    this.turnedTemplate = this.boss ? turnedTemplate : null;
    this.cadence = {
      maxActive: Math.max(1, Math.round(cadence.maxActive)),
      dripMs: Math.max(0, Math.round(cadence.dripMs)),
    };
    this.dripLeft = this.cadence.dripMs;
    // Keep every activated move represented. In particular, Mini Buddy remains
    // available on a veteran Large zombie even when it also owns Bash/Smash.
    this.activatedKeys = [
      ...new Set(this.players.flatMap((p) => p.abilities.filter((k) => !!ACTIVATED_ABILITY[k]))),
    ];
    this.activatedGroups = activatedGroupsOf(this.activatedKeys);
    this.teamKeys = [...new Set(this.players.flatMap((p) => teamAbilitiesIn(p.abilities)))];
    this.refreshTeamAuras();
  }

  snapshot(): BattleSimSnapshot {
    return {
      units: this.units.map((u) => ({
        ...u,
        abilities: [...u.abilities],
        teamAuraStats: u.teamAuraStats ? { ...u.teamAuraStats } : null,
      })),
      projectiles: this.projectiles.map((p) => ({ ...p })),
      bossId: this.boss?.id ?? null,
      actionCd: this.actionCd,
      nextAction: this.nextAction ? { ...this.nextAction } : null,
      actionCount: this.actionCount,
      throwCount: this.throwCount,
      releaseSeq: this.releaseSeq,
      projSeq: this.projSeq,
      elapsed: this.elapsed,
      emergeCooldown: this.emergeCooldown,
      attacksLanded: this.attacksLanded,
      playerDamage: this.playerDamage,
      feats: {
        abilityKills: this.feats.abilityKills.map((kill) => ({ ...kill })),
        resurrections: this.feats.resurrections.map((rez) => ({ ...rez })),
      },
      fallen: [...this.fallen],
      roundLeft: this.roundLeft,
      enraged: this._enraged,
      specialCast: this.specialCast,
      pendingSpecial: this.pendingSpecial ? { ...this.pendingSpecial } : null,
      summonQueue: [...this.summonQueue],
      dripLeft: this.dripLeft,
      activeTarget: this.activeTarget,
      spawnSeq: this.spawnSeq,
      activatedKeys: [...this.activatedKeys],
      grabbers: this.grabbers.map((g) => ({ ...g })),
      grabberTimer: this.grabberTimer,
      grabSeq: this.grabSeq,
      crabs: this.crabs.map((c) => ({ ...c })),
      crabTimer: this.crabTimer,
      crabSeq: this.crabSeq,
    };
  }

  restore(snapshot: BattleSimSnapshot): void {
    this.units.splice(0, this.units.length, ...snapshot.units.map((u) => ({
      ...u,
      abilities: [...u.abilities],
      teamAuraStats: u.teamAuraStats ? { ...u.teamAuraStats } : null,
      attackMultiplier: u.attackMultiplier ?? Math.max(0.1, u.power ? u.damage / u.power : 1),
      walkingSpeedMult: u.walkingSpeedMult ?? 1,
      damageFxTaken: u.damageFxTaken ?? 0,
      healCastSeq: u.healCastSeq ?? 0,
      healAoeTimerMs: u.healAoeTimerMs ??
        (u.abilities.includes("healAOE") ? HEAL_AOE_MS : 0),
      laserTimerMs: u.laserTimerMs ?? laserInterval(u.abilities, u.cooldownMs),
      laserFxSeq: u.laserFxSeq ?? 0,
      laserTargetId: u.laserTargetId ?? null,
      abilityRollSeq: u.abilityRollSeq ?? 0,
      usedAbilities: [...(u.usedAbilities ?? [])],
      resurrectUsed: u.resurrectUsed ?? false,
      power: u.power ?? u.damage,
      // An old checkpoint parked at the 1-HP floor has necessarily consumed
      // its protection. New checkpoints persist the explicit latch.
      oneShotProtectionUsed: u.oneShotProtectionUsed ?? (u.team === "player" && u.hp <= 1),
      frontPriority: u.frontPriority ?? false,
      knockBackToX: u.knockBackToX ?? 0,
      knockBackSpeed: u.knockBackSpeed ?? 0,
      passedWall: u.passedWall ?? false,
      isSummon: u.isSummon ?? false,
      stationX: u.stationX ?? null,
      stationY: u.stationY ?? null,
      deployAtMs: u.deployAtMs ?? null,
    deployWithBoss: u.deployWithBoss ?? false,
      defenseRole: u.defenseRole ?? null,
      // A checkpoint from before the conversion / burn can only exist on a ruleset the
      // session handshake already rejects, so these defaults are belt-and-braces: they
      // restore a fight in which nobody is on fire and nobody has been turned, which is
      // exactly what such a snapshot described.
      isTurned: u.isTurned ?? false,
      turnedFromId: u.turnedFromId ?? null,
      burnMs: u.burnMs ?? 0,
      burnDir: u.burnDir ?? 1,
      burnAnchorX: u.burnAnchorX ?? u.x,
      knockBackChance: u.knockBackChance ?? (u.knockBack ? 1 : 0),
      stunChance: u.stunChance ?? (u.stunInflictMs > 0 ? 1 : 0),
      mirrorsOpponentSpeed: u.mirrorsOpponentSpeed ?? false,
    })));
    this.players = this.units.filter((u) => u.team === "player");
    this.enemies = this.units.filter((u) => u.team === "enemy");
    this.boss = snapshot.bossId ? this.units.find((u) => u.id === snapshot.bossId) ?? null : null;
    this.projectiles.splice(0, this.projectiles.length, ...snapshot.projectiles.map((p) => ({ ...p })));
    this.actionCd = snapshot.actionCd ?? 0;
    this.nextAction = snapshot.nextAction ? { ...snapshot.nextAction } : null;
    this.actionCount = snapshot.actionCount ?? 0;
    this.throwCount = snapshot.throwCount;
    this.releaseSeq = snapshot.releaseSeq;
    this.projSeq = snapshot.projSeq;
    this.elapsed = snapshot.elapsed;
    this.emergeCooldown = snapshot.emergeCooldown;
    this.attacksLanded = snapshot.attacksLanded;
    this.playerDamage = snapshot.playerDamage;
    this.feats = {
      abilityKills: (snapshot.feats?.abilityKills ?? []).map((kill) => ({ ...kill })),
      resurrections: (snapshot.feats?.resurrections ?? []).map((rez) => ({ ...rez })),
    };
    // A snapshot with no explicit backlog is reconstructed from the units themselves: every
    // player zombie already down is a corpse Resurrect could still claim. Deployment order
    // is the best available stand-in for the order they fell in.
    this.fallen = snapshot.fallen
      ? [...snapshot.fallen]
      : this.players.filter((p) => !p.alive && !p.taken).map((p) => p.id);
    this.roundLeft = snapshot.roundLeft;
    this._enraged = snapshot.enraged;
    this.specialCast = snapshot.specialCast;
    this.pendingSpecial = snapshot.pendingSpecial ? { ...snapshot.pendingSpecial } : null;
    // A checkpoint that predates the abductee queue restores the ctor's seed order, which
    // is the same thing a fresh sim would hold — such a snapshot can only exist on a
    // ruleset the session handshake already rejects, so it never reaches a live fight.
    this.summonQueue = snapshot.summonQueue
      ? [...snapshot.summonQueue]
      : this.summonCfg?.queue.map((u) => u.sourceKey) ?? [];
    this.dripLeft = snapshot.dripLeft ?? this.cadence.dripMs;
    this.activeTarget = snapshot.activeTarget ?? 1;
    this.spawnSeq = snapshot.spawnSeq;
    this.activatedKeys.splice(0, this.activatedKeys.length, ...snapshot.activatedKeys);
    // Purely derived, so it is not in the snapshot — re-derive it from the keys that are.
    this.activatedGroups.splice(0, this.activatedGroups.length, ...activatedGroupsOf(this.activatedKeys));
    this.grabbers.splice(
      0,
      this.grabbers.length,
      ...(snapshot.grabbers ?? []).map((g) => ({
        ...g,
        swingStartDeg: g.swingStartDeg ?? g.rot,
        contactDeg: g.contactDeg ?? GRABBER_CONTACT_DEG,
        swingTotalMs: g.swingTotalMs ?? Math.max(1, g.pauseMs),
        targetId: g.targetId ?? null,
      }))
    );
    this.grabberTimer = snapshot.grabberTimer ?? this.grabberTimer;
    this.grabSeq = snapshot.grabSeq ?? this.grabSeq;
    // Crab fields are absent from server-built snapshots (the verifier omits the hazard),
    // in which case the local crab state simply carries on unchanged.
    this.crabs.splice(0, this.crabs.length, ...(snapshot.crabs ?? []).map((c) => ({ ...c })));
    this.crabTimer = snapshot.crabTimer ?? this.crabTimer;
    this.crabSeq = snapshot.crabSeq ?? this.crabSeq;
  }

  // ---- activated abilities (player-triggered from the battle strip) ----

  private isLarge(p: SimUnit): boolean {
    return p.group === "Large" || /^ZombieActorLarge/i.test(p.sourceKey);
  }

  private isSmall(p: SimUnit): boolean {
    return p.group === "Small" || /^ZombieActorSmall/i.test(p.sourceKey);
  }

  private isHealer(p: SimUnit): boolean {
    return p.isGarden && (p.abilities.includes("heal") || p.abilities.includes("healAOE"));
  }

  /** Where an un-deployed zombie sits in the queue to go out. `promote()` releases the
   *  first "waiting" unit in roster order, so the roster index IS the deploy order — and
   *  whoever is already "charging" is ahead of every one of them. Only meaningful for a
   *  unit that has not deployed; the callers all filter for that first. */
  private deployRank(p: SimUnit): number {
    const i = this.players.indexOf(p);
    return p.state === "charging" ? i : this.players.length + i;
  }

  /** A Mini that has not deployed yet, and so is still available to be picked up.
   *  One that has been released is out on the field on its own feet — there is
   *  nothing left to mount.
   *
   *  Picked in DEPLOY ORDER (v37). Nothing ever re-enters the queue, so it is only
   *  ever drained from the front and deploy order and roster order coincide — this
   *  ranks the same mini the old `find` did. It is written this way so both halves of
   *  the pairing state the same rule, and so it stays true if anything ever does put a
   *  zombie back in line. The CARRIER half is the one that actually moved. */
  private availableMini(): SimUnit | null {
    let best: SimUnit | null = null;
    for (const p of this.players) {
      if (!p.alive || !this.isSmall(p) || p.buddyCarrierId) continue;
      if (p.state !== "waiting" && p.state !== "charging") continue;
      if (!best || this.deployRank(p) < this.deployRank(best)) best = p;
    }
    return best;
  }

  /** Mini Buddy's whole window, in one place because the button's look and the tap
   *  it accepts must agree exactly (they did not: see `readyToActivate`).
   *
   *  The move loads onto a Large ANY TIME BEFORE IT HAS DEPLOYED — still queued at
   *  the back ("waiting"), or out being deployed ("charging": the walk to the slot
   *  and the focus fill both). The window was narrowed for a while to the instant
   *  the Large stood in the charge slot, on the theory that a tap should only land
   *  on the zombie the player is looking at — but that made it a few seconds per
   *  fight, easy to miss outright, and a Large that deployed un-mounted had spent
   *  the army's one shot at the move. Deliberately reverted (v36): anywhere short
   *  of deployed, the mount is an order the pair carries out when the carrier goes. */
  private canTakeMini(p: SimUnit): boolean {
    return (
      p.alive && this.isLarge(p) && p.abilities.includes("attachMini") &&
      !p.buddyId && !p.usedAbilities.includes("attachMini") &&
      (p.state === "waiting" || p.state === "charging") && !!this.availableMini()
    );
  }

  /** A player unit is READY for an activated move when it's alive, in the thick of
   *  the fight, off cooldown, and not already charging one.
   *
   *  A SUICIDE move (Explode) reads "in the thick of the fight" as position alone —
   *  the same test the button's own display window uses — rather than demanding an
   *  enemy be standing there this instant. It is a fuse the player lights on their own
   *  timing: waiting for a target defeats the purpose, and `state` flips out of "fight"
   *  in every gap between one enemy dying and the next walking on, which made the one
   *  move you most want to pre-time the one move you could not. */
  private readyToActivate(p: SimUnit, key: string): boolean {
    if (p.usedAbilities.includes(key)) return false;
    // Mini Buddy is the one move performed OFF the field, so it does not go through
    // the in-position test below at all — see `canTakeMini` for its window (any
    // time before the carrier has deployed).
    if (key === "attachMini") return this.canTakeMini(p);
    // Strictly a WIDENING for suicide moves: everything that could be lit before still
    // can, plus the standing-in-position-with-nothing-to-hit case.
    const engaged = p.state === "fight" ||
      (!!ACTIVATED_ABILITY[key]?.suicide && this.inAttackPosition(p));
    return (
      p.alive &&
      p.team === "player" &&
      p.abilities.includes(key) &&
      engaged &&
      !p.windupKey &&
      p.abilityCdMs <= 0
    );
  }

  /** A deployed zombie that has reached striking range — IN POSITION to attack,
   *  whether or not an enemy happens to be standing in front of it this instant.
   *
   *  This is the sim's own attack gate (see the advance step: `inCombatZone ||
   *  atBlockingWall`) with the enemy-arrived clause dropped. That clause is what
   *  flips `state` back to "advance" in every gap between one enemy dying and the
   *  next walking on, so a button driven off `state === "fight"` strobed on and off
   *  and left the player nothing steady to time a wind-up into. Position alone only
   *  moves forward, so it holds still. */
  private inAttackPosition(p: SimUnit): boolean {
    if (!p.alive || p.team !== "player") return false;
    if (p.state !== "advance" && p.state !== "fight") return false;
    const wall = this.wallInWay(p);
    if (wall) return Math.abs(wall.x - p.x) <= this.blockerGap(wall) + 2;
    return p.x >= this.frontX - COMBAT_ZONE_DEPTH;
  }

  /** Whether a move has any carrier inside its DISPLAY window — the span over which
   *  the battle strip keeps its button on screen. Wider than `readyToActivate`
   *  (which also demands off-cooldown and not-already-winding-up) precisely so the
   *  button stays put while its zombie charges and recharges.
   *
   *  Mini Buddy is the exception: its window is "an un-mounted Large short of
   *  deployment, with a Mini still behind it" — and it has no cooldown to wait out,
   *  so "on screen" and "a tap lands" are the same instant. Same predicate as
   *  `readyToActivate`, deliberately. */
  private abilityPresent(key: string): boolean {
    if (key === "attachMini") return this.players.some((p) => this.canTakeMini(p));
    return this.players.some(
      (p) => this.inAttackPosition(p) &&
        p.abilities.includes(key) && !p.usedAbilities.includes(key)
    );
  }

  /** Per activated move: how many zombies could perform it this instant (`ready`,
   *  the badge count) and whether the strip should be showing it at all
   *  (`present`). A present move with nothing ready is a button on cooldown. */
  activatedStatus(): { key: string; ready: number; present: boolean }[] {
    return this.activatedKeys.map((key) => ({
      key,
      ready: this.players.filter((p) => this.readyToActivate(p, key)).length,
      present: this.abilityPresent(key),
    }));
  }

  /** Which move a tap on a STACKED button fires right now (see ACTIVATED_STACKS).
   *
   *  Highest tier first: the group's keys are already in that order, so the answer is
   *  the first one with a ready carrier anywhere in the army. That deliberately makes
   *  the upgrade the move a tap spends — Explode Ver.2 is the only one of the pair that
   *  can touch a boss, so a rule that could leave it unreachable would cost the player
   *  a capability rather than a preference. The explode pair is now the ONLY stack, and
   *  that is exactly the reason: where the two tiers are a genuine trade rather than an
   *  upgrade (Bash/Smash), the choice belongs to the player and they get a button each.
   *
   *  Nothing about `activate` changes: this only decides WHICH key the tap sends, and
   *  the key it sends is one `activate` will accept, so the recorded transcript still
   *  names a concrete move and the server's replay is unaffected.
   *
   *  Falls back to the highest tier merely PRESENT (a recharging button keeps a stable
   *  face rather than flickering to its stackmate), then to the group's top key. */
  nextInGroup(group: string[]): string {
    for (const key of group) if (this.players.some((p) => this.readyToActivate(p, key))) return key;
    for (const key of group) if (this.abilityPresent(key)) return key;
    return group[0];
  }

  /** Per activated BUTTON, the strip's version of `activatedStatus`: the move a tap
   *  fires now (`key`), how many zombies could perform ANY move in the group (`ready`,
   *  the badge count), and whether the group has a carrier on screen (`present`).
   *
   *  `ready` counts ZOMBIES, not key-hits — a Silver Small carries both Explode and
   *  Explode Ver.2 but is one tap's worth of exploder, and summing per-key readiness
   *  would have advertised it as two. */
  activatedGroupStatus(): { keys: string[]; key: string; ready: number; present: boolean }[] {
    return this.activatedGroups.map((keys) => ({
      keys,
      key: this.nextInGroup(keys),
      ready: this.players.filter((p) => keys.some((k) => this.readyToActivate(p, k))).length,
      present: keys.some((k) => this.abilityPresent(k)),
    }));
  }

  /** Active deployed-holder count per team ability. Waiting, dead, grabbed, and
   *  carried zombies do not project team effects.
   *
   *  Resurrect is the one ability whose holders can run out while still standing there,
   *  so its count is REVIVES LEFT rather than holders present — a Garden zombie that has
   *  already spent its revive contributes an aura of nothing and should not read as if it
   *  still has one banked. At zero the icon drops off the strip entirely, which is the
   *  honest signal that the army's safety net is gone. */
  teamAbilityStatus(): { key: string; count: number }[] {
    const deployed = this.players.filter(
      (p) => p.alive && (p.state === "advance" || p.state === "fight")
    );
    return this.teamKeys.map((key) => ({
      key,
      count: key === "ressurect"
        ? this.resurrectsLeft()
        : deployed.filter((p) => p.abilities.includes(key)).length,
    }));
  }

  /** Totals behind the two top-HUD team bars.
   *
   *  NUMERATOR AND DENOMINATOR MUST COME FROM THE SAME UNITS. The scene used to divide the
   *  live HP sum by a constant captured from the roster `buildPlayerUnits` handed over, and
   *  that roster's con — so its maxHp — already carries the FULL team aura (chivalry / grace
   *  / fortitude), while `refreshTeamAuras` only pays the aura to zombies that have actually
   *  DEPLOYED. Before the first zombie marched in, every carrier's maxHp therefore sat below
   *  the number the bar divided by, and an army holding aura carriers opened the fight with a
   *  partly dark bar while every zombie in it was at full health. Summing maxHp here tracks
   *  the aura in lockstep. Dead units keep their maxHp, so a loss stays visible as a loss.
   *
   *  Walls and summons are left out of the ENEMY total: they are transient obstacles the boss
   *  conjures mid-fight, and adding their HP to a numerator whose denominator never heard of
   *  them pinned the bar at full for as long as one stood. Both keep their own on-field bars.
   *  The head COUNT still includes them — that is a tally of what is on the field. */
  teamTotals(): {
    playerHp: number; playerMax: number; playerAlive: number;
    enemyHp: number; enemyMax: number; enemyAlive: number;
  } {
    let playerHp = 0, playerMax = 0, playerAlive = 0;
    let enemyHp = 0, enemyMax = 0, enemyAlive = 0;
    for (const u of this.units) {
      // Totals count every unit, including a zombie still waiting to charge and an
      // enemy still queued off-screen.
      if (u.team === "player") {
        playerHp += Math.max(0, u.hp);
        playerMax += u.maxHp;
        if (u.alive) playerAlive++;
      } else {
        if (u.alive) enemyAlive++;
        if (u.isWall || u.isSummon) continue;
        enemyHp += Math.max(0, u.hp);
        enemyMax += u.maxHp;
      }
    }
    return {
      playerHp, playerMax: Math.max(1, playerMax), playerAlive,
      enemyHp, enemyMax: Math.max(1, enemyMax), enemyAlive,
    };
  }

  /** Recompute type auras from currently deployed carriers. Their source behavior
   *  adds percentages, so two holders contribute +20%, three +30%, and so on. */
  private refreshTeamAuras(): void {
    const counts = new Map(this.teamAbilityStatus().map(({ key, count }) => [key, count]));
    const chivalry = counts.get("chivalry") ?? 0;
    const grace = counts.get("grace") ?? 0;
    const protect = counts.get("protect") ?? 0;
    const fortitude = counts.get("tankHitPointsBuff") ?? 0;
    for (const p of this.players) {
      const stats = p.teamAuraStats;
      p.damageReduction = protectReduction(protect, p.abilities.includes("protect"));
      if (!stats) continue;
      const statCarriers = p.group === "Female" ? chivalry : p.group === "Regular" ? grace : 0;
      const lifeCarriers = statCarriers + (p.group === "Headless" ? fortitude : 0);
      const oldMaxHp = p.maxHp;
      const oldCooldown = p.cooldownMs;
      const str = stats.baseStr + stats.strPerCarrier * statCarriers;
      const dex = stats.baseDex + stats.dexPerCarrier * statCarriers;
      const con = stats.baseCon + stats.conPerCarrier * lifeCarriers;
      p.maxHp = Math.max(1, Math.round(deriveMaxHp(con)));
      p.hp = Math.max(0, Math.min(p.maxHp, p.hp + (p.maxHp - oldMaxHp)));
      p.power = str * POWER_PER_STR;
      p.damage = Math.max(1, Math.round(deriveHitDamage(p.power, p.attackMultiplier)));
      p.cooldownMs = deriveAttackIntervalMs(dex, "player");
      if (oldCooldown > 0 && p.timerMs > 0) p.timerMs *= p.cooldownMs / oldCooldown;
      p.moveSpeed = advanceSpeed(dex) * p.walkingSpeedMult;
    }
  }

  /** Which of two eligible zombies performs an activated move: the front-most, since it
   *  is nearest the enemy and already in the thick of it. There is no revived-exploder
   *  tiebreak to make — a revived zombie comes back with its one-use moves already spent
   *  (see `resurrect`), so it never re-enters this queue at all.
   *
   *  MINI BUDDY IS THE EXCEPTION (v37). It is the one move performed OFF the field, by a
   *  pair that has not deployed, and a waiting zombie's x is where it happens to be
   *  milling in the back group — `clusterHome` scatter plus a shuffle that re-rolls every
   *  few seconds. Ranking those by x hands the mount to an arbitrary Large that also
   *  changes with the clock. Take the carrier in the order it will DEPLOY instead: the
   *  brute going out next gets the mini going out next, which is the pairing the player
   *  is looking at when they tap. */
  private outranks(candidate: SimUnit, current: SimUnit, key: string): boolean {
    if (key === "attachMini") return this.deployRank(candidate) < this.deployRank(current);
    return candidate.x > current.x;
  }

  /** Trigger an activated move on ONE eligible zombie. Returns false if none is ready.
   *  Starts the wind-up; the payoff lands when it fills. */
  activate(key: string): boolean {
    if (this.finished) return false;
    const ab = ACTIVATED_ABILITY[key];
    if (!ab) return false;
    let pick: SimUnit | null = null;
    for (const p of this.players) {
      if (!this.readyToActivate(p, key)) continue;
      if (!pick || this.outranks(p, pick, key)) pick = p;
    }
    if (!pick) return false;
    if (key === "attachMini") {
      const mini = this.availableMini();
      if (!mini) return false;
      pick.buddyId = mini.id;
      mini.buddyCarrierId = pick.id;
      mini.buddyMountMs = MINI_MOUNT_MS;
      mini.state = "carried";
      mini.distracted = false;
      mini.awaitRelease = false;
      pick.usedAbilities.push(key);
      return true;
    }
    pick.windupKey = key;
    const windup = Math.max(1, pick.cooldownMs * ab.speedMultiplier * ab.damageTiming);
    pick.windupMs = windup;
    pick.windupTotal = windup;
    pick.abilityCdMs = ab.cooldownMs;
    // A one-use move is spent when the player COMMITS it, not when it pays off. The
    // wind-up is cancellable — knockback, pixelFire, and the two client-only grabs all
    // clear `windupKey` — and Explode carries no cooldown to cover the gap, so marking
    // it at the payoff handed the move straight back every time its charge was
    // interrupted. On a hazard raid only the CLIENT interrupts, so only the client
    // re-armed, and the server refused the second tap as `illegal_ability`.
    if (ab.useOnce) pick.usedAbilities.push(key);
    return true;
  }

  /** Advance a charging zombie; on completion deliver the payoff blow. While it
   *  charges it makes no normal attacks (the wind-up is the trade-off) — the
   *  else-branch in the advance step is the only place `tryAttack` runs, so a unit
   *  holding a `windupKey` cannot land an ordinary swing at all.
   *
   *  `foe` is null when a suicide fuse burns down with nothing in front of the zombie.
   *  That is not an error case: the blast still goes off on schedule, and an area hit
   *  over an empty field simply damages nobody. Only a single-target payoff needs a
   *  target, and no suicide move has one. */
  private stepWindup(p: SimUnit, foe: SimUnit | null, dtMs: number) {
    p.windupMs -= dtMs;
    if (p.windupMs > 0) return;
    const key = p.windupKey!;
    const ab = ACTIVATED_ABILITY[key]!;
    const dmg = Math.max(1, Math.round(p.damage * ab.damageFactor));
    if (ab.aoe) {
      for (const e of this.enemies) {
        if (!e.alive || e.state === "queued" || e.state === "structure" || e.state === "descending") continue;
        // A converted pixel zombie is not a target for the army's damage, by blast any
        // more than by melee (see targetEnemy). It is one of YOUR zombies with a million
        // hit points, answerable only to taps; letting a blast chip it would put ability
        // kills and `playerDamage` against a unit the army is not supposed to be fighting.
        if (e.isTurned) continue;
        if (e.isBoss && !ab.hitBoss && (key === "explode" || key === "explodeV2")) continue;
        this.recordAbilityKill(key, e, () => this.dealDamage(e, dmg, true));
        if (ab.stunMs) e.stunMs = Math.max(e.stunMs, ab.stunMs);
        this.playerDamage += dmg;
      }
    } else if (foe) {
      this.recordAbilityKill(key, foe, () => this.dealDamage(foe, dmg, true));
      if (ab.stunMs) foe.stunMs = Math.max(foe.stunMs, ab.stunMs);
      this.playerDamage += dmg;
    }
    p.struckThisTick = true;
    this.attacksLanded++;
    p.windupKey = null;
    p.windupMs = 0;
    // `useOnce` was already spent at activate() — a cancelled charge must not refund it.
    p.timerMs = this.cycleMs(p, null); // resume normal attacks after a beat
    // Explode is a SUICIDE move: the zombie goes up with the blast and is a casualty of
    // the raid. Killed AFTER the payoff so the blast it just delivered still counts, and
    // through `dealDamage` rather than around it, so a Garden holder's Resurrect gets its
    // shot at the exploder exactly as it would at any other casualty.
    if (ab.suicide) {
      p.explodeFxSeq++;
      this.dealDamage(p, p.hp, false);
    }
  }

  /** Run `deal` and note it if it was the blow that finished `target`.
   *
   *  Attribution is deliberately "was alive before, dead after" rather than anything
   *  the damage numbers imply: an area blast can land on an enemy already burning or
   *  mid-cascade, and only the transition actually identifies the killer. */
  private recordAbilityKill(key: string, target: SimUnit, deal: () => void): void {
    const wasAlive = target.alive;
    deal();
    if (wasAlive && !target.alive) {
      this.feats.abilityKills.push({ ability: key, boss: target.isBoss });
    }
  }

  /** What a Mini Buddy carrier is CHARGING AT: the nearest enemy that has actually come
   *  out and is standing on the field. Null when there is nothing to ram yet, in which
   *  case the carrier walks to its formation slot as usual and waits — it should not go
   *  and stand on the doorway a queued enemy has yet to walk through.
   *
   *  A blocker in the lane (a boss wall, an alien abductee) is a legitimate ram target;
   *  the caller clamps the destination to it anyway. A converted pixel zombie is NOT —
   *  `targetEnemy` refuses it, and this uses the same rule so the pair never charge a
   *  hazard the army is not supposed to be fighting. */
  private ramTargetFor(carrier: SimUnit): SimUnit | null {
    const foe = this.targetEnemy(carrier);
    if (!foe || (foe.state !== "hold" && foe.state !== "fight")) return null;
    return foe;
  }

  /** Dismount a Mini Buddy at the line. The shipped ram stuns the enemy for two
   *  seconds and the carrier for one; both zombies then remain in combat. */
  private deployMiniBuddy(carrier: SimUnit, foe: SimUnit | null) {
    if (!carrier.buddyId) return;
    const mini = this.players.find((p) => p.id === carrier.buddyId);
    carrier.buddyId = null;
    carrier.abilityCdMs = 0;
    carrier.stunMs = Math.max(carrier.stunMs, MINI_CARRIER_STUN_MS);
    if (foe) foe.stunMs = Math.max(foe.stunMs, MINI_ENEMY_STUN_MS);
    if (!mini || !mini.alive) return;
    mini.buddyCarrierId = null;
    mini.buddyMountMs = 0;
    mini.x = carrier.x - 10;
    mini.y = carrier.y;
    mini.prevX = mini.x;
    mini.prevY = mini.y;
    mini.charge = 1;
    mini.formOrder = carrier.formOrder + 0.25;
    mini.state = "advance";
    mini.timerMs = this.cycleMs(mini, null);
  }

  /** Deployed Garden holders that still have their one revive banked — the count the
   *  battle strip shows the player. A holder that is dead, waiting at the back, or
   *  carried off projects nothing, exactly like every other team ability. */
  resurrectsLeft(): number {
    return this.players.filter((p) => this.canResurrect(p)).length;
  }

  /** GROUND TRUTH (`-[ZombieActorGarden canRez]` 0x7c745): the ability must be `active`
   *  and `unlocked`, which is the source game's way of spelling "carried and not yet
   *  spent" — `ressurectZombie:` sets `setConsumed:YES` / `setActive:NO` on tag 29 the
   *  moment it fires, so each Garden zombie revives exactly once per fight. */
  private canResurrect(p: SimUnit): boolean {
    return (
      p.alive && !p.taken && p.isGarden &&
      (p.state === "advance" || p.state === "fight") &&
      p.abilities.includes("ressurect") && !p.resurrectUsed
    );
  }

  /** Poll Resurrect against the corpse backlog, the way `-[ZombieActorGarden fightUpdate:]`
   *  (0x7bf39) does: every holder in a position to cast checks `canRez` each frame rather
   *  than reacting to a death event. Two consequences the instant-on-death model missed —
   *  a holder deployed after a casualty still brings that casualty back, and the target is
   *  the MOST RECENT corpse at cast time (`ressurectZombie:` reads the last element of
   *  `defeatedZombies` and ignores its own argument), not whoever happened to die last tick.
   *
   *  Returns the holders that cast this step. The source game gives Resurrect and Heal ONE
   *  shared cast slot and checks `canRez` first (0x7c0a8, before the `canHeal` branch), so
   *  a holder that revives does not also heal on the same beat. */
  private stepResurrect(): Set<string> {
    const cast = new Set<string>();
    if (!this.fallen.length) return cast;
    for (const healer of this.players) {
      if (!this.fallen.length) break;
      if (!this.canResurrect(healer) || this.wallInWay(healer)) continue;
      const corpseId = this.fallen[this.fallen.length - 1];
      const corpse = this.players.find((p) => p.id === corpseId);
      if (!corpse) {
        this.fallen.pop(); // unreachable in practice; never let a bad id wedge the backlog
        continue;
      }
      this.resurrect(healer, corpse);
      cast.add(healer.id);
    }
    return cast;
  }

  /** Authentic Garden support. Heal selects the most injured OTHER deployed
   *  zombie with missing Life and restores 50% of the healer's Power.
   *  Heal All independently fires every 20 seconds for the same amount. */
  private stepHealing(dtMs: number, rezCast: ReadonlySet<string>, roster: SimUnit[] = this.players) {
    const deployed = roster.filter(
      (p) => p.alive &&
        // "hold" is the enemy side's standing state; no player is ever in it, so this
        // is byte-identical for raids and for the attacking army.
        (p.state === "advance" || p.state === "fight" || p.state === "hold")
    );
    for (const healer of deployed) {
      if (!this.isHealer(healer)) continue;
      if (rezCast.has(healer.id)) continue; // spent this beat's cast on the revive
      // A lane blocker takes priority over Garden support work. Note that `wallInWay` no
      // longer counts a blocker a healer was never marching past (see there): at its
      // station a Garden zombie keeps healing straight through an abductee or a wall, and
      // this gate only trips if one ever ends up close enough to be fighting one.
      if (this.wallInWay(healer)) {
        healer.healTimerMs = Math.max(healer.healTimerMs, 250);
        continue;
      }
      const amount = Math.max(1, Math.round(healer.power * HEAL_POWER_MULT));

      if (healer.abilities.includes("heal")) {
        healer.healTimerMs -= dtMs;
        if (healer.healTimerMs <= 0) {
          const candidates = deployed.filter(
            (p) => p.id !== healer.id && p.hp > 0 && p.hp < p.maxHp
          );
          if (candidates.length) {
            const target = candidates.reduce(
              (a, b) => b.hp / b.maxHp < a.hp / a.maxHp ? b : a
            );
            target.hp = Math.min(target.maxHp, target.hp + amount);
            target.healFxSeq++;
            healer.healCastSeq++;
            healer.healTimerMs = healer.cooldownMs;
          } else {
            healer.healTimerMs = 250;
          }
        }
      }

      if (healer.abilities.includes("healAOE")) {
        healer.healAoeTimerMs -= dtMs;
        if (healer.healAoeTimerMs <= 0) {
          const damaged = deployed.filter((p) => p.hp > 0 && p.hp < p.maxHp);
          for (const target of damaged) {
            target.hp = Math.min(target.maxHp, target.hp + amount);
            target.healFxSeq++;
          }
          if (damaged.length) healer.healCastSeq++;
          healer.healAoeTimerMs += HEAL_AOE_MS;
        }
      }
    }
  }

  /** Nearest enemy a zombie can reach (on the ground, not queued/perched). */
  private targetEnemy(u: SimUnit): SimUnit | null {
    const wall = this.wallInWay(u);
    if (wall) return wall;
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.state === "queued" || e.state === "structure" || e.state === "descending" ||
          e.state === "falling" || e.state === "landing" || e.isWall || e.isTurned) continue;
      const d = Math.abs(e.x - u.x);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** A stationary blocker ahead of this zombie: a boss WALL, or an abductee beamed into
   *  the middle of the lane (see SUMMON_SPAWN_X / SUMMON_MELEE_GAP — both stand still
   *  mid-field rather than holding at the wave's doorway). The latch keeps zombies which
   *  were already beyond the spawn point from turning around to attack it.
   *
   *  The two can never be on the field together — only the Ninja and Robot bosses build
   *  walls and only the alien boss summons — so they share the one `passedWall` latch.
   *
   *  A converted PIXEL ZOMBIE is pointedly NOT one of these, even though it rides the same
   *  `isSummon` flag for spawning and budget. It is not a blocker and not a melee target
   *  (see targetEnemy): the army walks straight past it and ignores it. It has to be that
   *  way round. Its body is a million hit points, so a lane it barred would be barred for
   *  the whole fight and every conversion would be an automatic loss — measured, exactly
   *  that: with it blocking, a MAXED roster could not clear the Video Games invasion at
   *  all. Making it a target instead of a blocker is no better; the army would simply pour
   *  four minutes of damage into it. So it is a hazard rather than an enemy: it stands
   *  where it lands, swings at whatever files past, and answers only to taps. */
  private wallInWay(u: SimUnit): SimUnit | null {
    if (u.passedWall) return null;
    const blocker = this.enemies.find(
      (e) => e.alive && (e.isWall || e.isSummon) && !e.isTurned && u.x <= e.x + 0.5
    ) ?? null;
    if (!blocker) return null;
    // A blocker only intercepts a zombie that was going to WALK PAST it. A Garden zombie
    // holds at GARDEN_STATION_X, a fixed station far behind the line and far behind either
    // kind of blocker, so it never closes on one, is never in reach of one, and can never
    // break one — yet an abductee beamed into mid-lane still counted as "in its way" and
    // shut its healing and its revive off for as long as the abductee lived. That is the
    // whole raid, in the raid the player has the least business being short a healer in:
    // the alien boss re-summons the moment the last abductee dies. The healers just stood
    // there, out of reach of a fight they had been drafted into.
    //
    // The test is exactly the one the march already applies below (`destinationX`): a
    // blocker that does not move where this unit stops is not blocking it. Everything that
    // marches to the LINE still stops short and fights — a slot beyond the blocker fails
    // this test — so interception is unchanged for every zombie that walks into one. The
    // carrier of a Mini Buddy is always blocked: it rams the enemy line rather than its own
    // slot, and asking `ramTargetFor` here would recurse back through `targetEnemy`.
    //
    // Only a DEPLOYED zombie has a real slot — `armyOrder` places the advancing/fighting
    // block and nobody else — so one still waiting at the back is left exactly as it was
    // rather than being read off its staging position.
    const deployed = u.state === "advance" || u.state === "fight";
    if (deployed && !u.buddyId && u.slotX <= blocker.x - this.blockerGap(blocker)) return null;
    return blocker;
  }

  /** How close a zombie gets to a blocker before trading blows with it. */
  private blockerGap(e: SimUnit): number {
    return e.isWall ? WALL_MELEE_GAP : SUMMON_MELEE_GAP;
  }

  /** The FRONT-MOST player within an enemy's striking range — the single zombie
   *  nearest the enemy down the lane, NOT the whole front row. Enemies commit all
   *  their damage to this one target (a big/slow hit knocks it back or drops it
   *  rather than chipping the entire line), so losses are more focused. Among the
    *  front column (zombies sharing the lead x) the tiebreak picks the visually
    *  front-most unit (largest y), matching the renderer's depth order.
    *
    *  RANGE IS ASYMMETRIC ON PURPOSE, but not unboundedly so. Zombies attack from
    *  anywhere in the combat zone — a band COMBAT_ZONE_DEPTH deep — while an enemy strikes
    *  only what stands within `engageDistance` of it. That is what makes the front row (and
    *  the Headless zombies that fight for it) matter: the back rows deal damage without
    *  taking it.
    *
    *  What that must NOT become is an enemy WITH NO ONE TO HIT WHILE A STANDING ROW IS
    *  HITTING IT. The melee band empties in ways the zombies control: a knockback attack
    *  shoves its victim 0.9-2.7 melee gaps down the lane (see knockBackZombie) and
    *  re-slots it last; a Headless walking to its promotion slot RESERVES the front slot
    *  while the rest of the row STANDS a row-depth back, inside the combat zone, swinging
    *  every cycle. The enemy stood there with a null target, contractually blind
    *  ("enemies not attacking despite zombies being in front of them"). v36 answered the
    *  knockback case (the enemy disarmed ITSELF — its reach is unconditional); v40(b)
    *  answers the reserved-slot case: a LINE enemy with an empty melee range strikes the
    *  front-most FRONT-BAND zombie STANDING at its slot.
    *
    *  Three deliberate limits on the v40 half, each holding a measured regression out:
    *  - STANDING only: a line mid-walk (re-forming after a death, a burn, a conversion)
    *    stays untargetable exactly as it always was — waves must not get free hits on
    *    every re-form (+35% on the ordinary Video Games p* without it).
    *  - FRONT BAND only: the deep rows keep dealing damage without taking it — that
    *    asymmetry is the design, not the bug.
    *  - LINE enemies only (not turned / summoned / wall units): a turned pixel zombie or
    *    a beamed-in abductee stands MID-LANE, usually with an empty melee ring of its
    *    own, and the reach let it shred the army from behind the line all fight long. */
  private playerInRange(e: SimUnit): SimUnit | null {
    // A zombie mid-shove is not a melee target: `-[ZombieActor isInMeleeRange]` returns
    // false for the whole time `knockBackPoint` is live, and every melee set the fight
    // manager builds is filtered through it. Without this the shove is a pure penalty —
    // the victim cannot act, but is still stood inside the reach of the thing that hit it.
    const inMelee = this.frontMostPlayer(
      (p) => p.knockBackSpeed <= 0 && Math.abs(p.x - e.x) <= this.engageDistance
    );
    if (inMelee) return inMelee;
    // Reach-of-last-resort: a zombie in attack position, with no wall standing between
    // the two of them (that fight is the wall's, not this enemy's). A KNOCKBACK enemy
    // reaches any such zombie (v36 — whatever it shoved away, it can still answer);
    // every other enemy reaches only one STANDING at its slot (v40 — the reserved-slot
    // case), so a line mid-re-form walks in unpunished exactly as it always did.
    const standingFrontBand = (p: SimUnit) =>
      p.lineupIndex < BAND_SIZE &&
      Math.abs(p.slotX - p.x) <= 2 && Math.abs(p.slotY - p.y) <= 2;
    // The v40 reach belongs to enemies AT THE LINE — a turned pixel zombie or a beamed-in
    // abductee stands MID-LANE, often with no one in its own melee ring, and handing one
    // the standing reach let it shred the army from behind the line (measured: +35% on
    // the ordinary Video Games p* almost entirely from the turned unit).
    const onTheLine = !e.isTurned && !e.isSummon && !e.isWall;
    return this.frontMostPlayer((p) =>
      this.inAttackPosition(p) && !this.wallInWay(p) &&
      (e.knockBack || (onTheLine && standingFrontBand(p)))
    );
  }

  /** The front-most living, on-lane player satisfying `pick` (null if none). Ties on x
   *  break to the visually front-most (largest y), matching the renderer's depth order. */
  private frontMostPlayer(pick: (p: SimUnit) => boolean): SimUnit | null {
    let best: SimUnit | null = null;
    for (const p of this.players) {
      // Off the lane: seized by a trapeze, or carried out of the fight entirely (a crab's
      // passenger, a zombie Zedzox has turned). `taken` used to imply the `grabbed` state
      // — the crab was the only way to get it — so testing the state alone was enough.
      // `turnZombie` broke that: a converted zombie keeps whatever state it was in, so it
      // has to be excluded by the flag or the enemy team keeps aiming at a unit that is
      // not on the field.
      if (!p.alive || p.taken || p.state === "grabbed") continue;
      if (!pick(p)) continue;
      if (
        !best ||
        p.x > best.x + 0.5 || // more forward (nearer the enemy) wins
        (Math.abs(p.x - best.x) <= 0.5 && p.y > best.y)
      ) {
        best = p;
      }
    }
    return best;
  }

  /** Whom the boss aims at: the FARTHEST-BACK deployed zombie (min x), so lobbed
   *  throws arc over the frontline tanks and land on the support/healers massed
   *  behind them. "Deployed" = released from the focus bar (brain popped) and now
   *  advancing/fighting on the lane; zombies still waiting or charging are off-limits.
   *  Returns null when nothing is deployed — so the boss doesn't throw at an empty
   *  lane. The lead (see leadVelocity) is applied at launch. */
  private throwTarget(): SimUnit | null {
    const deployed = this.players.filter(
      (p) => p.alive && !p.taken && (p.state === "advance" || p.state === "fight")
    );
    if (!deployed.length) return null;
    return deployed.reduce((a, b) => (b.x < a.x ? b : a));
  }

  /** Whom the ALIEN LASER aims at — and it is NOT whom a throw aims at.
   *
   *  GROUND TRUTH (`ZFFightMan shootBullet:from:` 0x5ea74): the saucer builds a fresh
   *  candidate array of zombies that are `isInMeleeRange` — which `-[ZombieActor
   *  isInMeleeRange]` resolves to `actorIsFighting` (state 11/12/13), plus a zombie
   *  parked at its destination in one of the listed states — OR are in state 10 / 31 /
   *  32 (the two states `damageIn:` also exempts from the lineup-depth penalty, i.e.
   *  mid special attack). It then picks ONE AT RANDOM:
   *      idx = (arc4random() % 100) / 100.0 * count
   *  and fires at that zombie's position. Empty candidate list -> no bullet at all.
   *
   *  So the laser is a FRONT-LINE weapon: it burns whoever is toe-to-toe with the wave,
   *  never the Garden healers massed back at the support line. That is the opposite of
   *  the boss THROW (see throwTarget), which is a lob aimed over the tanks — and using
   *  throwTarget() here was the bug that had every alien bolt land on the healers.
   *
   *  `state === "fight"` is this sim's `actorIsFighting`: a zombie in the combat band
   *  with an arrived foe. Healers hold at supportX, well short of the band, so they stay
   *  in "advance" and are correctly off the target list. */
  private laserTarget(): SimUnit | null {
    const engaged = this.players.filter((p) => p.alive && !p.taken && p.state === "fight");
    if (!engaged.length) return null;
    return engaged[Math.floor(hash(this.actionCount * 13 + 7) * engaged.length) % engaged.length];
  }

  /** The velocity a throw leads a target by: its MEASURED velocity (how it actually
   *  moved last step), CLAMPED to PREDICT_SPEED_CAP. So a slow/normal zombie is led by
   *  its true speed (and gets hit), while a fast one is led only as if it were "lowish
   *  speed" — the shot lands behind it and it outruns the throw. Zero when it's not
   *  moving (parked at its slot, fighting), so a stationary target is aimed at directly. */
  private leadVelocity(u: SimUnit): { vx: number; vy: number } {
    const spd = Math.hypot(u.vx, u.vy);
    if (spd < 1) return { vx: 0, vy: 0 };
    const k = Math.min(1, PREDICT_SPEED_CAP / spd);
    return { vx: u.vx * k, vy: u.vy * k };
  }

  /** Can this side still fight? A zombie carried off by a crab is still ALIVE (it returns
   *  after the raid) but is out of the battle, so it must not keep a lost fight running.
   *
   *  A converted PIXEL ZOMBIE is excluded for a different reason: its authored body is a
   *  million hit points (con 10000), so a win condition that had to kill it could never be
   *  met — the fight would run to the four-minute cap every time Zedzox landed one. It is
   *  a hazard standing on the field, not a member of the wave, and it dies to taps rather
   *  than to the army. Clearing the wave and the boss therefore still wins; a zombie still
   *  captive at that point comes home the same way a crab's passenger does. */
  private anyAlive(side: SimUnit[]): boolean {
    return side.some((u) => u.alive && !u.taken && !u.isTurned);
  }

  /** Replay-safe equivalent of `(arc4random() % 100)`. Multiplication by 37
   *  permutes all 100 integer results once per cycle, preserving the binary's
   *  exact 9/4/29 successful rolls without making replays nondeterministic. */
  private abilityRoll(u: SimUnit): number {
    const roll = (stringSeed(u.id) + u.abilityRollSeq * 37) % 100;
    u.abilityRollSeq++;
    return roll;
  }

  /** Fire the automatic walking laser. Both versions deal 10% of finalPower;
   *  Ver.2 schedules at finalAttackSpeed/6 instead of /3. */
  private stepLaser(u: SimUnit, dtMs: number) {
    const interval = laserInterval(u.abilities, u.cooldownMs);
    if (interval <= 0) return;
    u.laserTimerMs -= dtMs;
    if (u.laserTimerMs > 0) return;
    const foe = this.targetEnemy(u);
    if (foe) {
      const dmg = Math.max(1, Math.round(u.power * 0.10));
      this.dealDamage(foe, dmg, true);
      u.laserTargetId = foe.id;
      u.laserFxSeq++;
      u.struckThisTick = true;
      this.attacksLanded++;
      this.playerDamage += dmg;
    }
    u.laserTimerMs += interval;
  }

  /** One attack cycle in ms for `u` while facing `foe` — ground truth
   *  `-[Actor getFightAttackSpeed]`. `cooldownMs` already carries the raw dex clock
   *  (2/dex zombie, 1/dex enemy) times the attack's `speedMultiplier`; on top of that:
   *   - a player zombie deeper than the front five swings slower (lineupSpeedBand);
   *   - a Scallywag throws its own clock away and mirrors its opponent's cycle.
   *  Everything that re-arms an attack timer goes through here. */
  private cycleMs(u: SimUnit, foe: SimUnit | null): number {
    if (u.team === "player") return u.cooldownMs * lineupSpeedBand(u.lineupIndex);
    if (u.mirrorsOpponentSpeed && foe && foe.team === "player") {
      const foeSec = (foe.cooldownMs * lineupSpeedBand(foe.lineupIndex)) / 1000;
      return mirroredAttackIntervalSec(foeSec) * 1000;
    }
    return u.cooldownMs;
  }

  /** Land a hit from `u` on `foe` when its clock is ready; else re-arm. An enemy
   *  hit can also knock the zombie back (to the back of the line) and/or stun it. */
  private tryAttack(u: SimUnit, foe: SimUnit, dtMs: number) {
    u.timerMs -= dtMs;
    if (u.timerMs > 0) return;
    u.timerMs += this.cycleMs(u, foe);
    // Player normal swings take the lineup-depth band (front five full, then 0.85/0.7/0.55);
    // enemies always hit at band 1.0. See combatStats.lineupDamageBand (ground truth).
    const dmg =
      u.team === "player"
        ? Math.max(1, Math.round(u.damage * lineupDamageBand(u.lineupIndex)))
        : u.damage;
    if (u.team === "enemy") {
      this.dealEnemyDamage(foe, dmg);
    } else {
      this.dealDamage(foe, dmg, true);
      this.playerDamage += dmg;

      // Girl `damageIn:` uses integer rolls >.70 and >.95. Double Strike adds
      // the authored 0.25× Power strike; Random Stun holds the target for 1s.
      if (u.abilities.includes("doubleStrike") && this.abilityRoll(u) > 70 && foe.alive) {
        const bonus = Math.max(
          1,
          Math.round(u.power * 0.25 * lineupDamageBand(u.lineupIndex))
        );
        this.dealDamage(foe, bonus, true);
        this.playerDamage += bonus;
        this.attacksLanded++;
      }
      if (u.abilities.includes("stun") && this.abilityRoll(u) > 95 && foe.alive) {
        foe.stunMs = Math.max(foe.stunMs, 1000);
      }
    }
    u.struckThisTick = true;
    this.attacksLanded++;
    if (u.team === "enemy" && foe.alive && foe.team === "player") {
      // Enemy attack effects on the struck zombie — BOTH of which `-[Actor damageIn:]`
      // (0x37738) refuses while the victim's `fightData.canInterrupt` is NO. See
      // `uninterruptible`: only the bash and explode families ever set it.
      if (!this.uninterruptible(foe)) {
        // Which attack this swing WAS decides whether it carries an effect: the source
        // rolls one entry out of the unit's list per swing and applies that entry's
        // flags. One roll covers both effects, matching the single `rollAgainstFrequency`
        // the source makes — so the Lawyers boss's Double Punch is stun-and-shove or
        // neither, never half of one. See CombatEngine.attackEffects.
        const special = this.abilityRoll(u) < 100 * Math.max(u.knockBackChance, u.stunChance);
        if (special && u.stunInflictMs > 0 && u.stunChance > 0) {
          foe.stunMs = Math.max(foe.stunMs, u.stunInflictMs);
        }
        if (special && u.knockBack && u.knockBackChance > 0) this.knockBackZombie(foe);
      }
    }
  }

  /** Is this zombie mid-swing on a move that cannot be interrupted?
   *
   *  GROUND TRUTH: `-[Actor fightAttack:]` (0x36d28) reads `cantInterrupt` off the attack
   *  variation rolled for the swing and sets `fightData.canInterrupt = !cantInterrupt`;
   *  `-[Actor doneAttacking:]` (0x37cd8) restores YES when the swing ends. `damageIn:` then
   *  refuses both the stun and the knockback while it is NO.
   *
   *  Attacks.json carries `cantInterrupt` on EXACTLY four attacks — ZombieBash, ZombieBashV2,
   *  ZombieExplode, ZombieExplodeV2 — which are precisely this sim's wind-up moves. So it is
   *  super armour on the activated big hits and nothing else: pay for a Smash or light a
   *  fuse and no enemy shoves you out of it. (It is also why the depth-damage penalty exempts
   *  states 31/32 — the same two moves; see COMBAT_STATS_RECOVERED.md.) */
  private uninterruptible(p: SimUnit): boolean {
    return !!p.windupKey && !!ACTIVATED_ABILITY[p.windupKey]?.cantInterrupt;
  }

  /** Knock a zombie back. GROUND TRUTH — `-[Actor damageIn:]` 0x3777a rolls the shove and
   *  `-[Actor knockBackBy:force:]` 0x37e68 applies it:
   *
   *      [victim knockBackBy: -(50 + arc4random() % 100) force: 5.0]
   *
   *  `knockBackBy:force:` then, for a ZombieActor only:
   *    * `setZombieToLastIndex` — pull it out of the army array and re-insert it just
   *      BEFORE the first zombie still in the back group, i.e. at the tail of the DEPLOYED
   *      block. Not the tail of the roster: it stays ahead of everyone yet to deploy.
   *    * unschedule `damageIn:` / `fightAttack:` / `attackSFXIn:` — the swing in flight is
   *      cancelled outright, it does not resume on landing.
   *    * nudge x by -1 and set state 10 if it was in melee, breaking the position ==
   *      destination equality `isInMeleeRange` tests.
   *    * `reorderZombies`, and (ZombieActor override) recompute `destinationPoint` from the
   *      NEW index — which is why the shove costs depth: a deeper band means a slot further
   *      back to walk to, softer hits and a slower swing.
   *
   *  The shove itself is a SLIDE, not a teleport: `knockBackPoint` is parked at
   *  `(x + distance, y)` and `-[Actor movementUpdate:]` moves the zombie toward it at
   *  `force * 60` px/s, clearing the point on arrival (see stepKnockBack). */
  private knockBackZombie(p: SimUnit) {
    // `damageIn:` gates BOTH the stun and the shove on `[fightData canInterrupt]` (0x37738)
    // and on `!invincible`. What writes `canInterrupt` was not pinned in this pass, so only
    // the narrowest reading is applied: a zombie already mid-shove is not shoved again.
    // Without it a fast knockback attacker re-parks the point every hit and its victim
    // never lands — which is a compounding buff the source's gate plainly exists to stop.
    if (p.knockBackSpeed > 0) return;
    p.windupKey = null;
    p.windupMs = 0;
    // Replay-safe stand-in for `arc4random() % 100`: the victim's id and the current tick
    // are both part of the deterministic transcript, so client and verifier roll alike.
    const roll = Math.floor(hash(stringSeed(p.id) + this.elapsed * 0.37) * 100) % 100;
    const gapsPerSourcePoint = this.engageDistance / SRC_MELEE_GAP;
    const dist = (SRC_KNOCKBACK_BASE + roll) * gapsPerSourcePoint;
    // The source lets a zombie be shoved anywhere; we floor it at the staging slot so it
    // cannot be driven back into the milling crowd it was released from. `min(p.x, …)`
    // keeps that floor from turning the shove into a shove FORWARD for a zombie that is
    // somehow already behind the slot.
    p.knockBackToX = Math.min(p.x, Math.max(CHARGE_X, p.x - dist));
    p.knockBackSpeed = SRC_KNOCKBACK_FORCE * 60 * gapsPerSourcePoint;
    p.formOrder = this.releaseSeq++; // tail of the deployed block → deeper band
    p.frontPriority = false;
    p.state = "advance";
    p.timerMs = this.cycleMs(p, null);
  }

  /** Advance a live knockback slide. Returns true while the zombie is still being shoved,
   *  in which case it neither walks nor fights this step (source: `movementUpdate:` returns
   *  early, and a non-zero `knockBackPoint` makes `isInMeleeRange` false). */
  private stepKnockBack(p: SimUnit, dtMs: number): boolean {
    if (p.knockBackSpeed <= 0) return false;
    const step = (p.knockBackSpeed * dtMs) / 1000;
    const dx = p.knockBackToX - p.x;
    if (Math.abs(dx) <= step) {
      p.x = p.knockBackToX;
      p.knockBackSpeed = 0;
    } else {
      p.x += Math.sign(dx) * step;
    }
    p.state = "advance";
    p.timerMs = this.cycleMs(p, null);
    return true;
  }

  private dealDamage(foe: SimUnit, dmg: number, fromPlayer: boolean) {
    // Publish the hit at its full post-mitigation size BEFORE the HP subtraction clamps
    // it. `hp` is what the fight runs on; `damageFxTaken` is what the numbers report.
    if (dmg > 0) foe.damageFxTaken += dmg;
    foe.hp -= dmg;
    if (foe.hp > 0) return;
    foe.hp = 0;
    foe.alive = false;
    foe.state = "dead";
    if (foe.buddyId) this.deployMiniBuddy(foe, null);
    if (foe.buddyCarrierId) {
      const carrier = this.players.find((p) => p.id === foe.buddyCarrierId);
      if (carrier) carrier.buddyId = null;
      foe.buddyCarrierId = null;
    }
    // A fallen zombie joins the corpse backlog a Garden holder's Resurrect draws from.
    // It is NOT revived here: the source game polls `canRez` from the Garden's own
    // update, so the revive lands whenever a holder is next in a position to cast —
    // which may be long after this death, and may be a holder not yet deployed.
    if (foe.team === "player") {
      this.fallen.push(foe.id);
      return;
    }
    // A pixel zombie broken open hands its captive back. Done HERE rather than in
    // `tapTurned` so it cannot be bypassed: this is the one choke point every death goes
    // through, and a captive stranded by some other damage path would sit `taken` with
    // nothing left on the field able to release it.
    if (foe.isTurned) {
      this.releaseTurned(foe);
      return; // …and it is not wave population, so it does not gate the next emergence.
    }
    // Only an enemy reaches here. A downed one opens the gate for the next to emerge.
    if (fromPlayer) this.emergeCooldown = ENEMY_EMERGE_GAP_MS;
  }

  /** Resurrect is automatic and one-use. A living Garden holder revives the
   *  defeated zombie at full Life and sends it back into formation. */
  private resurrect(healer: SimUnit, defeated: SimUnit): void {
    healer.resurrectUsed = true;
    const slot = this.fallen.indexOf(defeated.id);
    if (slot >= 0) this.fallen.splice(slot, 1);
    defeated.alive = true;
    defeated.hp = defeated.maxHp;
    defeated.state = "advance";
    defeated.x = CHARGE_X;
    defeated.y = CENTER_Y;
    defeated.prevX = defeated.x;
    defeated.prevY = defeated.y;
    defeated.formOrder = this.releaseSeq++;
    defeated.frontPriority = false;
    defeated.timerMs = this.cycleMs(defeated, null);
    defeated.windupKey = null;
    defeated.windupMs = 0;
    defeated.stunMs = 0;
    defeated.burnMs = 0; // whatever it died of, it does not come back still alight
    defeated.oneShotProtectionUsed = false;
    // GROUND TRUTH (`-[ZombieActorGarden ressurectZombie:]` 0x7d3c2-0x7d436): the revived
    // actor's whole `abilityList` is walked and EVERY ability carrying `consumable` is
    // handed `setConsumed:YES` — and `-[ZFActorAbility isUseable]` (0x9cafc) refuses a
    // consumed ability outright. So a zombie comes back ALIVE but SPENT: it can never
    // light a second fuse, and a revived Garden holder can never pay the revive forward
    // (which is what stops two holders reviving each other for the rest of the fight).
    // The consumable set is exactly the four one-use abilities (`ZFActorActivatedAbility
    // initWithTag:` writes the flag for tags 29/30/35/36) — Resurrect, Mini Buddy,
    // Explode, Explode Ver.2 — which is `useOnce` here plus the Resurrect latch.
    //
    // It is UNCONDITIONAL: a move the zombie never got round to using is spent too, so a
    // bomber cut down before it lit its fuse comes back without one. Coming back at all is
    // the reward; coming back armed is not.
    //
    // Read BEFORE the abilities are marked: a zombie that spent Explode and is standing
    // here as a casualty is, by definition, the one that blew itself up. That combination —
    // a Garden holder pulling a Small zombie back out of its own blast — is the
    // "Recycled" achievement, and this is the only moment it is observable.
    const exploded = defeated.usedAbilities.some((k) => k === "explode" || k === "explodeV2");
    this.feats.resurrections.push({ exploded });
    for (const key of defeated.abilities) {
      if (ACTIVATED_ABILITY[key]?.useOnce && !defeated.usedAbilities.includes(key)) {
        defeated.usedAbilities.push(key);
      }
    }
    if (defeated.abilities.includes("ressurect")) defeated.resurrectUsed = true;
    defeated.healFxSeq++;
  }

  /** Apply an ordinary enemy hit through the recovered player-zombie one-shot floor. */
  private dealEnemyDamage(foe: SimUnit, dmg: number) {
    if (dmg > 0 && foe.abilities.includes("block") && this.abilityRoll(foe) > 90) return;
    const applied = applyDamage(dmg, 0, foe.team === "player" ? foe.damageReduction ?? 0 : 0);
    if (
      applied > 0 &&
      foe.team === "player" &&
      foe.alive &&
      !foe.oneShotProtectionUsed &&
      foe.hp > 1 &&
      (foe.hp - applied) / foe.maxHp < ONE_SHOT_FLOOR
    ) {
      // The latch spares the zombie but does not soften the blow: the number still
      // reads the whole hit. This branch bypasses `dealDamage`, so it publishes itself.
      foe.damageFxTaken += applied;
      foe.hp = 1;
      foe.oneShotProtectionUsed = true;
      return;
    }
    this.dealDamage(foe, applied, false);
  }

  /** Burn down one tick of `pixelFire`. The RATE is ground truth — `damage:
   *  hitPointsTotal/20 × dt`, 5 % of max HP a second, through the normal damage path so
   *  armour, damage reduction and the one-shot floor all apply. The DURATION is ours (see
   *  PIXEL_FIRE_BURN_MS): the shipped game's burn lasts a single frame.
   *
   *  Costed against the tick actually taken rather than a fixed frame, so a 50 ms sim step
   *  and a 16 ms one remove the same HP per second of burn. */
  private stepBurn(p: SimUnit, dtMs: number) {
    if (p.burnMs <= 0) return;
    const burnt = Math.min(p.burnMs, dtMs);
    p.burnMs -= dtMs;
    if (p.burnMs <= 0) {
      p.burnMs = 0;
      p.timerMs = this.cycleMs(p, null); // it comes out of the fire mid-swing, not primed
    }
    this.dealEnemyDamage(p, (p.maxHp * BURN_MAX_HP_FRACTION_PER_SEC * burnt) / 1000);
    p.struckThisTick = true;
  }

  /** A burning zombie's panic walk: back and forth over PIXEL_FIRE_PACE_REACH either side
   *  of wherever the fire caught it, turning at each end. It covers no ground and reaches
   *  no formation slot — that is the point of being on fire. */
  private pacePanicked(p: SimUnit, dtMs: number) {
    p.x += (p.burnDir * PIXEL_FIRE_PACE_SPEED * dtMs) / 1000;
    if (p.burnDir < 0 && p.x <= p.burnAnchorX - PIXEL_FIRE_PACE_REACH) {
      p.x = p.burnAnchorX - PIXEL_FIRE_PACE_REACH;
      p.burnDir = 1;
    } else if (p.burnDir > 0 && p.x >= p.burnAnchorX + PIXEL_FIRE_PACE_REACH) {
      p.x = p.burnAnchorX + PIXEL_FIRE_PACE_REACH;
      p.burnDir = -1;
    }
    p.y = p.slotY;
  }

  /** Advance the charging zombie's focus bar, running the bubble minigame unless
   *  Concentration is active. See CHARGE_STEPS: the fill clamps to the next
   *  threshold so a big frame can't skip a distraction. */
  private stepCharge(p: SimUnit, dtMs: number) {
    if (this.concentration) {
      p.charge = Math.min(1, p.charge + dtMs / CHARGE_MS);
      if (p.charge >= 1) this.releaseCharger(p);
      return;
    }
    if (this.noDistractions) {
      if (p.awaitRelease) {
        p.bubbleMs -= dtMs;
        if (p.bubbleMs <= 0) this.releaseCharger(p);
        return;
      }
      p.charge = Math.min(1, p.charge + dtMs / CHARGE_MS);
      if (p.charge >= 1) { p.awaitRelease = true; p.bubbleMs = BRAIN_AUTO_MS; }
      return;
    }
    if (p.distracted) {
      p.bubbleMs -= dtMs;
      if (p.bubbleMs <= 0) p.distracted = false; // auto-refocus
      return;
    }
    if (p.awaitRelease) {
      p.bubbleMs -= dtMs;
      if (p.bubbleMs <= 0) this.releaseCharger(p); // auto-advance
      return;
    }
    const next = CHARGE_STEPS[p.distractStep] ?? 1;
    p.charge = Math.min(next, p.charge + dtMs / CHARGE_MS);
    if (p.charge >= next) {
      p.distractStep++;
      if (next >= 1) {
        // Full bar: gate the release (brain bubble). This is a release prompt, not
        // a focus roll, so it always shows (Concentration path above skips it).
        p.awaitRelease = true;
        p.bubbleMs = BRAIN_AUTO_MS;
      } else if (this.rollDistract(p)) {
        // Passing a 0.25 segment: distract only if the focus roll fails. Miss the
        // roll and the meter keeps filling toward the next segment uninterrupted.
        p.distracted = true;
        p.bubbleMs = BUTTERFLY_AUTO_MS;
      }
    }
  }

  /** Deterministic per-segment distraction roll. GROUND TRUTH (`-[FightFocusBar
   *  update:]`): at each 0.25 charge segment a zombie is distracted iff
   *  `rand01 > focus/100` — so focus 100 (premium) is NEVER distracted, and a
   *  focus-40 starter is distracted ~60% of the time per segment. Uses the
   *  replayable `hash` (keyed by the unit's seed + which segment) instead of an RNG
   *  so the sim stays deterministic/replayable. */
  private rollDistract(p: SimUnit): boolean {
    const r = hash(p.distractSeed * 16.7 + p.distractStep * 3.1);
    return r > clamp(p.focus, 0, 100) / 100;
  }

  /** Release a fully-charged zombie to advance to the front line. */
  private releaseCharger(p: SimUnit) {
    p.state = "advance";
    p.formOrder = this.releaseSeq++; // claim a formation slot on release
    p.distracted = false;
    p.awaitRelease = false;
  }

  /** Player tapped the focus bubble over the charging zombie: a butterfly
   *  (distraction) pop resumes the fill; a brain (full) pop sends it forward.
   *  Returns true if a bubble was actually popped (drives tap feedback). */
  popBubble(id: string): boolean {
    if (this.finished) return false;
    const p = this.players.find((u) => u.id === id);
    if (!p || !p.alive || p.state !== "charging") return false;
    if (p.awaitRelease) { this.releaseCharger(p); return true; }
    if (p.distracted) { p.distracted = false; return true; }
    return false;
  }

  /** The charging zombie showing a focus bubble right now (or null). Only one
   *  zombie charges at a time, so at most one bubble is ever live. */
  chargingBubble(): { id: string; kind: "butterfly" | "brain" } | null {
    const p = this.players.find(
      (u) => u.alive && u.state === "charging" && (u.distracted || u.awaitRelease)
    );
    return p ? { id: p.id, kind: p.awaitRelease ? "brain" : "butterfly" } : null;
  }

  /** Promote the zombie charge queue + the enemy emerge queue.
   *
   *  GROUND TRUTH for the enemy half — see types.WaveCadence. Two things release a
   *  queued enemy in the source, and both boil down to "fill a free `enemySlots` entry":
   *  a death (`update:` 0x5d60c) and the `spawnTimer` drip (`updateTimer:` 0x613ee).
   *  The death path only ever REPLACES what died, so the field can grow past one enemy
   *  only via the drip — which is why `activeTarget` climbs one per drip rather than the
   *  whole wave pouring out at t=0. Ten of the eleven raids have no drip at all and so
   *  stay at `activeTarget` 1 for the whole fight. */
  private promote(dtMs: number) {
    this.emergeCooldown -= dtMs;

    const charging = this.players.some((p) => p.alive && p.state === "charging");
    if (!charging) {
      const next = this.players.find((p) => p.alive && p.state === "waiting");
      if (next) next.state = "charging";
    }

    // The reinforcement clock runs on its own regardless of the emerge beat below.
    const queuedLeft = this.enemies.some((e) => e.alive && !e.isBoss && e.state === "queued");
    if (this.cadence.dripMs > 0 && this.activeTarget < this.cadence.maxActive && queuedLeft) {
      this.dripLeft -= dtMs;
      if (this.dripLeft <= 0) {
        this.dripLeft = this.cadence.dripMs;
        this.activeTarget++;
      }
    }

    if (this.emergeCooldown > 0) return;

    // A summoned abductee is off-budget on BOTH counts: it does not occupy one of the
    // wave's slots, and it does not hold the boss on its perch. See SimUnit.isSummon.
    // The front-most surviving station decides where the army stands (no-op in raids).
    this.refreshFrontLine();
    // AUTHORED DEFENDERS (PvP formation defense) ignore the wave budget entirely:
    // each walks on when its own clock says so, and none of them counts toward or
    // competes for `activeTarget`. Absent `deployAtMs` this loop does nothing, which
    // is every raid.
    for (const e of this.enemies) {
      if (e.deployAtMs === null || !e.alive || e.state !== "queued") continue;
      if (this.elapsed >= e.deployAtMs) e.state = "emerging";
    }
    // A support defender alone at the back would stand past the attackers' reach and
    // run the fight to the four-minute cap. Drop its station so it walks up to the
    // ordinary doorway, where every raid's enemies are fought — the fight can end.
    const standing = this.enemies.filter((e) => e.alive && !e.isSummon && !e.isTurned);
    if (standing.length === 1 && standing[0].defenseRole === "support" &&
        standing[0].stationX !== null) {
      standing[0].stationX = null;
      if (standing[0].state === "hold") standing[0].state = "emerging";
    }

    const activeMelee = this.enemies.filter(
      (e) => e.alive && !e.isBoss && !e.isWall && !e.isSummon &&
        e.deployAtMs === null && e.state !== "queued"
    ).length;
    // A mini still waiting in the barn is ammunition, not a defender holding the line:
    // counting it here would hold the brute on its perch forever, since the very thing
    // that releases the mini is the brute climbing down.
    const normalsLeft = this.enemies.some(
      (e) => !e.isBoss && !e.isWall && !e.isSummon && e.alive &&
        !(e.deployWithBoss && e.state === "queued")
    );
    const blockersLeft = this.enemies.some((e) => e.isWall && e.alive);

    if (activeMelee < this.activeTarget) {
      const next = this.enemies.find(
        (e) => e.alive && !e.isBoss && e.deployAtMs === null && e.state === "queued" &&
          !e.deployWithBoss
      );
      if (next) next.state = "emerging";
    }

    if (this.boss && this.boss.alive && this.boss.state === "structure" &&
        !normalsLeft && !blockersLeft && activeMelee === 0) {
      // Climb down, exit out the back, then re-enter. An authored PERCH is dropped
      // here: from now on this is a ground unit, and keeping the station would walk
      // it back to a spot up in the air.
      this.boss.stationX = null;
      this.boss.stationY = null;
      this.boss.state = "descending";
      // The brute brings its ammunition down with it — the mini stops being a thrown
      // projectile and joins the fight on foot. (The scripted Mini Buddy mount, when
      // the brute has that ability, is still to come; today they simply arrive together.)
      for (const e of this.enemies) {
        if (e.deployWithBoss && e.alive && e.state === "queued") e.state = "emerging";
      }
    }
  }

  /** The army's line follows the FRONT-MOST defender.
   *
   *  `frontX` is normally a constant — every raid's wave holds at the same doorway, so
   *  `ENEMY_HOLD_X - engageDistance` is where the zombies stop. A formation defense
   *  breaks that assumption: its tank stands well forward of the barn, and an army
   *  anchored on the doorway would walk straight PAST it to a line behind its back.
   *
   *  So when stations are authored the line is re-derived from the front-most station
   *  still held by a live defender. It reads STATIONS rather than live positions on
   *  purpose: a reinforcement still walking in would otherwise drag the line around
   *  behind it. When the tank falls, the next station forward becomes the line and the
   *  army pushes up — which is the behaviour you want anyway. */
  private refreshFrontLine(): void {
    if (!this.authoredStations) return;
    const holdX = this.bossFallsFromSky ? EPIC_BOSS_HOLD_X : ENEMY_HOLD_X;
    let front = holdX;
    for (const e of this.enemies) {
      // The perched brute is up in the air and unreachable until it climbs down, so
      // it must never pull the army's line forward onto a position it cannot fight.
      if (!e.alive || e.isSummon || e.isTurned || e.isBoss) continue;
      // Same reasoning as the perched brute: a mini still in the barn is unreachable.
      if (e.deployWithBoss && e.state === "queued") continue;
      front = Math.min(front, e.stationX ?? holdX);
    }
    this.frontX = front - this.engageDistance;
  }

  /** Where this enemy stands once it has walked in: its authored station if it has
   *  one (PvP formation defense), otherwise the shared doorway every raid uses. */
  private holdXOf(e: SimUnit): number {
    if (e.stationX !== null) return e.stationX;
    return this.bossFallsFromSky ? EPIC_BOSS_HOLD_X : ENEMY_HOLD_X;
  }

  /** Which row bucket a zombie falls in — `calculateDestinationPoint` dispatches on the
   *  concrete ZombieActor subclass, and a Cupid Garden buckets with Small, not Garden.
   *
   *  The source's `Small` bucket is folded into `Regular` here on purpose; see
   *  MINI_STANDS_WITH_REGULAR above. That takes the Cupid Gardens with it, since they
   *  bucket with Small rather than with Garden. */
  private bodyOf(p: SimUnit): string {
    if (/Cupid/i.test(p.sourceKey)) return "Regular";
    if (p.isHeadless) return "Headless";
    if (p.isGarden) return "Garden";
    const g = p.group ?? "";
    if (BODY_ROW_ORDER.includes(g)) return g;
    return "Regular"; // includes every Small: a Mini queues with the ordinary bodies
  }

  /** Build the ordered army — the reimpl's stand-in for `[fightMan zombies]`, which is the
   *  single source of truth for depth band, damage band, deploy order and draw order.
   *
   *  Order is deployment order (`formOrder`), then the two mutations `reorderZombies`
   *  (0x5b554) makes every time it runs:
   *
   *   1. HEADLESS PROMOTION — only if NONE of the front five is an engaged Headless does it
   *      take the LAST engaged Headless anywhere in the array and `insertObject:atIndex:0`.
   *      It is a repair, not a standing sort: a Headless that is already up front stays
   *      wherever it is, and a second one is never pulled forward.
   *   2. GARDEN PUSH-BACK — `setZombieToLastIndex` on every deployed Garden, which lands
   *      them at the end of the DEPLOYED block (that call inserts before the first zombie
   *      still in the back group), in their existing relative order. */
  private armyOrder(): SimUnit[] {
    // `!p.taken`: a zombie carried out of the fight (a crab's passenger, a zombie
    // Zedzox has converted) keeps whatever state it was in, and it used to keep its
    // SLOT too. The ghost anchored its row from the front — a Headless leads its row,
    // and the front fighter is exactly the zombie `turnZombie` takes — so the
    // survivors re-slotted BEHIND a unit that was no longer on the field, one
    // body-standoff short of the wave's reach, and the enemies held with nothing in
    // range for the rest of the fight ("the enemies stop attacking when my headless
    // becomes the pixel zombie").
    const committed = this.players
      .filter((p) => p.alive && !p.taken && (p.state === "advance" || p.state === "fight"))
      .sort((a, b) => a.formOrder - b.formOrder);

    const gardens = committed.filter((p) => p.isGarden);
    const rest = committed.filter((p) => !p.isGarden);
    const order = gardens.length && rest.length ? [...rest, ...gardens] : committed;

    const engagedHeadless = (p: SimUnit) => p.isHeadless && p.state === "fight";
    if (!order.slice(0, BAND_SIZE).some(engagedHeadless)) {
      let last = -1;
      for (let i = 0; i < order.length; i++) if (engagedHeadless(order[i])) last = i;
      if (last >= 0) {
        // The source does `insertObject:atIndex:0` on the real array, so the promotion
        // STICKS. Write it into formOrder rather than only into this frame's copy —
        // re-deriving it every tick would satisfy the front-five test on the next frame,
        // drop the zombie back, and leave it oscillating between two slots forever.
        order[last].formOrder = Math.min(...order.map((p) => p.formOrder)) - 1;
        order.unshift(...order.splice(last, 1));
      }
    }
    return order;
  }

  /** Place the army. Band = index / 5; the slot inside a band is the zombie's rank among
   *  that band's members ordered by body type (BODY_ROW_ORDER), and both the x fan and the
   *  y step come from `calculateDestinationPoint`. */
  private assignFormation() {
    const order = this.armyOrder();

    // Lineup index = index in the army array. It drives the damage and cadence falloff
    // bands (combatStats), and now the formation reads from the SAME index, so the visible
    // rank and the band a zombie is punished for finally agree.
    order.forEach((p, i) => {
      p.lineupIndex = i;
    });

    for (let start = 0; start < order.length; start += BAND_SIZE) {
      const band = start / BAND_SIZE;
      const members = order.slice(start, start + BAND_SIZE);
      // Row order inside the band: Headless to the front, healers to the back, everyone
      // else (Minis included — MINI_STANDS_WITH_REGULAR) by weight in between.
      const row = members.slice().sort((a, b) => {
        const d = BODY_ROW_ORDER.indexOf(this.bodyOf(a)) - BODY_ROW_ORDER.indexOf(this.bodyOf(b));
        return d || a.formOrder - b.formOrder;
      });
      const n = row.length;
      // Source x is absolute off `zombieAttackPosition`; ours hangs off `frontX`, which is
      // derived from the raid's own hold position. Normalising on the row's front-most
      // member keeps band 0's leading slot exactly ON the old line, so the recovered
      // standoff/fan only ever adds depth BEHIND it and never pushes the whole army out of
      // contact.
      const rel = (p: SimUnit, slot: number) =>
        -(SRC_BODY_STANDOFF[this.bodyOf(p)] ?? 0) * SIM_PER_SOURCE_X + (n - 1 - slot) * SLOT_X_STEP;
      const bandX = this.frontX - band * BAND_GAP;
      const rels = row.map(rel);
      // Anchor the row on the front-most member that has actually REACHED the line —
      // not on one still walking in from the charge slot. See ROW_ANCHOR_EPS.
      const standing = rels.filter((_, i) => row[i].x >= bandX - ROW_ANCHOR_EPS);
      const relMax = Math.max(...(standing.length ? standing : rels));
      row.forEach((p, slot) => {
        // A healer keeps its station EXACTLY — no band gap, no row fan. Those terms are
        // relative to a front line it is not part of, and they dragged it ~36 units off
        // the mark. Gardens share the one x and are separated by `slotY` below.
        //
        // The `min` only bites for a zombie still crossing that outranks everyone
        // standing: with the row anchored behind it, its own offset comes out NEGATIVE
        // (a slot in front of the line). It walks to the line instead, and takes the
        // anchor with it when it gets there.
        p.slotX = p.isGarden
          ? GARDEN_STATION_X
          : Math.min(bandX, bandX - (relMax - rels[slot]) * this.rowXFit);
        // Source: y = 4*slot - 2*n + 10, whose midpoint is y=8 for ANY n. Two adjustments:
        // we hang the row off the lane centre instead of the stage's y origin (so the +10
        // becomes +2 — the formula minus its own fixed centre — and the block stays centred
        // as the row fills), and the sign FLIPS because cocos2d y grows upward while this
        // sim's grows downward. Slot 0 therefore takes the largest y, i.e. nearest the
        // camera and drawn in front, which is what the source's explicit zOrder does too.
        // ROW_SPREAD widens the whole step for legibility; see its note.
        p.slotY = CENTER_Y
          - (SLOT_Y_STEP * slot - (SLOT_Y_STEP / 2) * n + 2 * SIM_PER_SOURCE_Y) * ROW_SPREAD;
      });
    }
  }

  /** Advance the sim by `dtMs`. Returns false once the battle is over. */
  step(dtMs: number): boolean {
    if (this.finished) return false;
    this.elapsed += dtMs;
    this.projectileImpactsThisTick = 0;
    this.lastProjectileImpactSprite = "";
    for (const u of this.units) {
      u.struckThisTick = false;
      u.prevX = u.x; // snapshot for this step's velocity measurement (see below)
      u.prevY = u.y;
    }
    for (const g of this.grabbers) g.struckThisTick = false;

    this.promote(dtMs);
    this.refreshTeamAuras();
    this.stepEnrage(dtMs);

    // Throws and specials draw from ONE action budget (ground truth: the boss rolls a
    // single weighted pick over `bossActions` per cycle — see stepBossActions).
    this.stepBossActions(dtMs);
    this.stepGrabbers(dtMs);
    this.stepCrabs(dtMs);
    this.stepProjectiles(dtMs);

    this.assignFormation();
    this.stepHealing(dtMs, this.stepResurrect());
    // The DEFENDER's own support pass. Only a PvP formation defense carries healing
    // abilities on the enemy side (raid enemies are authored with none), so this is a
    // no-op everywhere else. Resurrect is deliberately NOT mirrored: it draws on the
    // player-side corpse backlog, and a defender backlog is its own piece of work.
    this.stepHealing(dtMs, EMPTY_CAST, this.enemies);
    const frontX = this.frontX;

    // Zombies.
    for (const p of this.players) {
      if (!p.alive) continue;
      // Carried out of the fight — by a crab, or converted into a pixel zombie. Still
      // alive and still a survivor, but it neither walks nor swings until it is back.
      if (p.taken) continue;
      // The fire burns on a WALL CLOCK, so it is ticked ahead of every other gate —
      // including the trapeze's. The trapeze and crab are client-only, so a burn the
      // client paused while a zombie dangled would run out earlier on the server; ticking
      // it here keeps the burn bit-identical on both sides whatever the hazards do.
      this.stepBurn(p, dtMs);
      if (!p.alive) continue; // the burn can be the killing blow
      if (p.state === "grabbed") continue; // seized by the trapeze — position driven by stepGrabbers
      if (p.abilityCdMs > 0) p.abilityCdMs -= dtMs; // activated-move recharge
      switch (p.state) {
        case "waiting": {
          // Idle in the back group: stand STILL most of the time, with only an
          // occasional brief shuffle to a nearby spot — so the crowd looks alive
          // without the old constant pacing. Deterministic (cycle-indexed hash, no
          // RNG): each zombie holds a spot for ~85% of its cycle, then eases a few
          // px to the next spot in the last ~15%. No vertical hover.
          const off = p.mill / (Math.PI * 2); // 0..1 per-unit phase
          const period = 2600 + off * 2200; // 2.6-4.8s per shuffle cycle
          const raw = this.elapsed / period + off;
          const cyc = Math.floor(raw);
          const ph = raw - cyc; // 0..1 within the cycle
          const MOVE_FRAC = 0.12; // only the last 12% of the cycle is a shuffle
          const AMP = 14; // shuffle reach in sim px (was a ±26 constant pace) — big
          // enough that the brief shuffle clears the walk-anim threshold (a real
          // step, not a glide), while the long still stretch keeps them planted
          const spot = (c: number) => (hash(c * 1.73 + p.mill) - 0.5) * 2 * AMP;
          const from = spot(cyc);
          let d = from;
          if (ph > 1 - MOVE_FRAC) {
            const t = (ph - (1 - MOVE_FRAC)) / MOVE_FRAC; // 0..1 across the shuffle
            const e = t * t * (3 - 2 * t); // smoothstep ease
            d = from + (spot(cyc + 1) - from) * e;
          }
          p.x = p.homeX + d;
          p.y = p.homeY;
          break;
        }
        case "charging": {
          // Step out to the staging slot (in front of the group) and focus.
          const dx = CHARGE_X - p.x;
          const dy = CENTER_Y - p.y;
          const d = Math.hypot(dx, dy);
          const stepd = (STEP_SPEED * dtMs) / 1000;
          if (d > 2) {
            p.x += (dx / d) * Math.min(stepd, d);
            p.y += (dy / d) * Math.min(stepd, d);
            p.timerMs = this.cycleMs(p, null);
          } else {
            this.stepCharge(p, dtMs);
          }
          break;
        }
        case "carried": {
          p.buddyMountMs = Math.max(0, p.buddyMountMs - dtMs);
          p.timerMs = this.cycleMs(p, null);
          break;
        }
        default: {
          // Being shoved: the slide owns the zombie's position, and it is out of melee for
          // the duration (`movementUpdate:` returns before the walk, and a live
          // knockBackPoint makes `isInMeleeRange` false). Checked BEFORE the stun so a
          // knockback attack that also stuns still travels — the source parks the point on
          // fightData and slides it regardless of what else the hit applied.
          if (this.stepKnockBack(p, dtMs)) break;
          // Stunned by an enemy hit — can't move or attack until it wears off.
          if (p.stunMs > 0) {
            p.stunMs -= dtMs;
            p.timerMs = this.cycleMs(p, null);
            break;
          }
          // On fire: the zombie is beating at itself, not fighting. It holds no formation
          // slot and lands no swings — it just paces on the spot until the fire goes out
          // or the player taps it out. Checked after the shove and the stun so neither is
          // swallowed by the fire (a burning zombie can still be knocked back or held).
          if (p.burnMs > 0) {
            this.pacePanicked(p, dtMs);
            p.timerMs = this.cycleMs(p, null);
            break;
          }
          // Move to the assigned formation slot (never past the enemy).
          //
          // …EXCEPT while carrying a Mini Buddy, which is a RAM and not a march. A brute
          // with a mini aboard drives at the enemy line rather than to its own slot: the
          // move is "it runs forward and stuns what it hits", and a Large's slot is the
          // furthest back of any body type (v23 gave each body its own standoff), so
          // aiming at the slot stopped the charge well SHORT of the enemy — measured on a
          // real party: it halted 72 units behind its own front rank and stunned a knight
          // 162 units away that it had never reached. The stun looked like it fired at
          // random from across the field, because effectively it did.
          const blockingWall = this.wallInWay(p);
          const ramTarget = p.buddyId ? this.ramTargetFor(p) : null;
          const slotX = ramTarget ? ramTarget.x - this.engageDistance : p.slotX;
          const destinationX = blockingWall
            ? Math.min(slotX, blockingWall.x - this.blockerGap(blockingWall))
            : slotX;
          const mdx = destinationX - p.x;
          const mdy = p.slotY - p.y;
          const md = Math.hypot(mdx, mdy);
          const wasWalking = md > 2;
          const stepd = (p.moveSpeed * (p.buddyId ? MINI_CARRIER_SPEED_MULT : 1) * dtMs) / 1000;
          if (md > stepd) {
            p.x += (mdx / md) * stepd;
            p.y += (mdy / md) * stepd;
          } else {
            p.x = destinationX;
            p.y = p.slotY;
          }
          if (wasWalking) this.stepLaser(p, dtMs);
          // The formation is only for spacing / projectile hitboxes — EVERY zombie
          // that has reached the combat zone attacks the enemy once it has arrived
          // (not just the front row). The enemy still only strikes those in melee
          // range (the front), so front-row / headless zombies take the hits.
          const foe = this.targetEnemy(p);
          const enemyArrived = !!foe && (foe.state === "hold" || foe.state === "fight");
          const inCombatZone = p.x >= frontX - COMBAT_ZONE_DEPTH;
          const atSlot = Math.hypot(destinationX - p.x, p.slotY - p.y) <= 2;
          // Knockback and carry/drop effects send a Headless zombie to the rear long
          // enough for another row to fill the open front slot. Once it reaches that
          // recovery slot, restore its defining behavior: it pushes forward again.
          if (p.isHeadless && !p.frontPriority && atSlot) p.frontPriority = true;
          // The ram lands on CONTACT with the thing it charged, not on arrival at a slot.
          // `atSlot` is kept as a backstop so a carrier whose target dies mid-charge (or
          // that is walled off short of it) still puts its passenger down instead of
          // running around with it for the rest of the fight.
          if (p.buddyId && enemyArrived) {
            const reached = Math.abs(foe!.x - p.x) <= this.engageDistance + 2;
            if (reached || atSlot) this.deployMiniBuddy(p, foe);
          }
          const atBlockingWall = !!blockingWall &&
            Math.abs(blockingWall.x - p.x) <= this.blockerGap(blockingWall) + 2;
          if (foe && enemyArrived && (inCombatZone || atBlockingWall)) {
            p.state = "fight";
            // A charging zombie makes no normal attacks — it's winding up the big
            // hit; deliver the payoff when the wind-up fills. Otherwise attack.
            if (p.windupKey) this.stepWindup(p, foe, dtMs);
            else this.tryAttack(p, foe, dtMs);
          } else {
            p.state = "advance";
            // A lit Explode fuse burns down wherever the zombie is and whether or not
            // anything is standing in front of it — that is the whole point of being
            // able to light it early. Every OTHER wind-up is a swing at a specific foe,
            // so it still waits for one (the bash family keeps its charge held).
            if (ACTIVATED_ABILITY[p.windupKey ?? ""]?.suicide) this.stepWindup(p, null, dtMs);
            else p.timerMs = this.cycleMs(p, null);
          }
        }
      }
    }

    // Enemies (emerge / boss descends, then stand and strike; never move otherwise).
    for (const e of this.enemies) {
      if (!e.alive || e.state === "queued" || e.state === "structure") continue;
      if (e.isWall) {
        e.state = "hold";
        e.timerMs = this.cycleMs(e, null);
        continue;
      }
      if (e.state === "falling") {
        e.y = Math.min(CENTER_Y, e.y + (EPIC_BOSS_FALL_SPEED * dtMs) / 1000);
        e.timerMs = this.cycleMs(e, null);
        if (e.y >= CENTER_Y) {
          e.y = CENTER_Y;
          e.state = "landing";
          e.timerMs = EPIC_BOSS_LAND_MS;
        }
        continue;
      }
      if (e.state === "landing") {
        e.timerMs -= dtMs;
        if (e.timerMs <= 0) {
          e.state = "hold";
          e.timerMs = this.cycleMs(e, null);
        }
        continue;
      }
      if (e.state === "descending") {
        if (e.sourceKey === CIRCUS_BOSS_KEY) {
          // The Ringmaster jumps straight down from the circus car instead of using
          // the generic boss route (walk out behind the structure, then re-enter).
          // Keep progress in the existing x/y fields so snapshots and replays need
          // no raid-specific animation state.
          const dy = CENTER_Y - BOSS_STRUCT_Y;
          e.y = Math.min(CENTER_Y, e.y + (dy * dtMs) / BOSS_JUMP_MS);
          const t = clamp((e.y - BOSS_STRUCT_Y) / dy, 0, 1);
          e.x = BOSS_STRUCT_X + (ENEMY_HOLD_X - BOSS_STRUCT_X) * t;
          e.timerMs = this.cycleMs(e, null);
          if (e.y >= CENTER_Y) {
            e.x = ENEMY_HOLD_X;
            e.y = CENTER_Y;
            e.state = "hold";
          }
          continue;
        }
        // Leave the perch by heading OUT THE RIGHT SIDE (through the entrance),
        // staying up at structure height; the renderer slides it off-screen behind
        // the structure. Only once fully off-screen does it drop to the ground and
        // re-enter — no floating diagonally toward the middle.
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        e.x = Math.min(ENEMY_SPAWN_X, e.x + sx); // walk out to the hidden spawn
        e.timerMs = this.cycleMs(e, null);
        if (e.x >= ENEMY_SPAWN_X) {
          e.x = ENEMY_SPAWN_X;
          e.y = CENTER_Y; // now a ground unit, hidden off the right edge
          e.state = "emerging"; // walk back in from the entrance, facing the zombies
        }
        continue;
      }
      if (e.state === "emerging") {
        // Re-enter from the right at ground level and walk left to the hold spot —
        // exactly where the normal enemies attack from, unless this defender was
        // authored a station of its own (PvP formation defense).
        const holdX = this.holdXOf(e);
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        e.x = Math.max(holdX, e.x - sx);
        e.y = e.stationY ?? CENTER_Y;
        e.timerMs = this.cycleMs(e, null);
        if (e.x <= holdX) {
          e.x = holdX;
          e.y = e.stationY ?? CENTER_Y;
          e.state = "hold";
        }
        continue;
      }
      // Stunned (by an Explode) — can't act; hold its attack clock.
      if (e.stunMs > 0) {
        e.stunMs -= dtMs;
        e.timerMs = this.cycleMs(e, null);
        continue;
      }
      const foe = this.playerInRange(e);
      if (foe) {
        e.state = "fight";
        this.tryAttack(e, foe, dtMs);
      } else {
        e.state = "hold";
        e.timerMs = this.cycleMs(e, null);
      }
    }

    // Measure each unit's velocity from this step's movement (for boss-throw lead).
    // A big jump is a teleport (knockback re-slot, boss perch↔ground) not real motion —
    // zero it so a throw doesn't lead a phantom high-speed vector.
    const dtSec = dtMs / 1000;
    if (dtSec > 0) {
      for (const u of this.units) {
        const ddx = u.x - u.prevX;
        const ddy = u.y - u.prevY;
        if (Math.hypot(ddx, ddy) > TELEPORT_PX) {
          u.vx = 0;
          u.vy = 0;
        } else {
          u.vx = ddx / dtSec;
          u.vy = ddy / dtSec;
        }
      }
    }

    if (!this.anyAlive(this.players) || !this.anyAlive(this.enemies) || this.elapsed >= MAX_SIM_MS) {
      this.finished = true;
    }
    return !this.finished;
  }

  /** Throw wind-up for the renderer's perched-boss throw animation: 0..1 filling over
   *  the last `windowMs` before the next throw releases (the arm cocks and swings), or
   *  null when the boss isn't perched-and-throwing / has no target. The projectile
   *  launches as this reaches 1, so the renderer can time the arm to the release. */
  bossThrowSwing(windowMs = THROW_WINDUP_MS, visualLeadMs = 0): number | null {
    if (!this.bossThrow || !this.boss || !this.boss.alive || this.boss.state !== "structure") {
      return null;
    }
    if (this.isCastingWall()) return null;
    if (this.nextAction?.kind !== "throw") return null; // a special is up next — arm rests
    if (!this.throwTarget()) return null; // empty lane → arm rests
    const visualTimer = Math.max(0, this.actionCd - visualLeadMs);
    if (visualTimer > windowMs) return 0;
    return clamp(1 - visualTimer / windowMs, 0, 1);
  }

  private isCastingWall(): boolean {
    return this.pendingSpecial?.name === "wall";
  }

  /** Progress of the wall-summoning pose. This replaces the normal throw swing
   *  throughout the wall action's authored cast time. */
  bossWallSummonProgress(): number | null {
    const sp = this.pendingSpecial;
    if (!sp || sp.name !== "wall") return null;
    return clamp(1 - this.specialCast / Math.max(1, sp.castMs), 0, 1);
  }

  /** Whether the boss is "active" (able to throw / cast specials): alive and either
   *  perched on its structure or fighting on the ground (not descending/queued). */
  private bossActive(): boolean {
    const b = this.boss;
    return !!b && b.alive && (b.state === "structure" || b.state === "hold" || b.state === "fight");
  }

  /** Round countdown → enrage. When the timer expires the boss enrages once: throws
   *  come faster, specials recover faster, and its melee hits harder. */
  private stepEnrage(dtMs: number) {
    if (this._enraged || !this.boss || !this.boss.alive) return;
    this.roundLeft -= dtMs;
    if (this.roundLeft > 0) return;
    if (this.escapeOnRoundEnd) {
      this.roundLeft = 0;
      this.escaped = true;
      this.finished = true;
      return;
    }
    this._enraged = true;
    if (this.bossThrow) this.bossThrow.intervalMs *= ENRAGE_THROW_MULT;
    this.boss.damage = Math.max(1, Math.round(this.boss.damage * ENRAGE_DMG_MULT));
  }

  /** Boss action scheduler — GROUND TRUTH (`CivilianActorFight bossUpdate:` 0x67e8c).
   *  When the boss's action cooldown expires it makes ONE weighted roll over its whole
   *  `bossActions` list (`rollAgainstFrequencyInArray:`) and dispatches on the chosen
   *  action's name: `throw` launches a projectile and recovers for the raid's
   *  `throwSpeed`; every other action winds up for its `castTime` and then recovers for
   *  its `cooldownTime`. Throws therefore COMPETE with specials for the same slot —
   *  a boss whose list is all throws (most of them) tosses on a plain interval, while
   *  the Robot BrainBot (75 % throws) and the Video Games boss (27 %) throw
   *  proportionally less because their specials consume the budget.
   *
   *  The next action is rolled as soon as the previous one resolves so the renderer can
   *  telegraph it (`bossThrowSwing` only winds the arm when a throw is actually next). */
  private stepBossActions(dtMs: number) {
    if (!this.actions.length || !this.bossActive() || !this.anyAlive(this.players)) return;
    // A special that is already winding up owns the boss until it lands.
    if (this.pendingSpecial) {
      this.specialCast -= dtMs;
      if (this.specialCast <= 0) {
        const sp = this.pendingSpecial;
        this.runSpecial(sp);
        this.pendingSpecial = null;
        this.actionCd = Math.max(300, sp.cooldownMs * (this._enraged ? ENRAGE_SPECIAL_MULT : 1));
        this.rollNextAction();
      }
      return;
    }
    const next = this.nextAction;
    if (!next) return;
    // Once the boss is off its perch it has no action budget at all (see bossCanAct), so
    // let the slot rest instead of re-rolling it every tick for the rest of the fight.
    // A cast ALREADY in flight is deliberately left to land above: the source arms those
    // through `schedule:interval:`, which fires whatever state the boss has moved on to.
    if (!this.bossCanAct()) return;
    // A throw waiting on an empty lane parks its timer at the full wind-up instead of
    // running out (ruleset 39). The old pin-at-zero released the projectile on the very
    // tick a target first appeared — so the first throw of every fight, and every throw
    // after a line wipe, fired with no arm-swing at all. Parked here, the moment a
    // zombie enters the lane the timer runs THROW_WINDUP_MS down to release, which is
    // exactly the window bossThrowSwing() animates over. Checked before the decrement
    // (not at expiry) so a lane that empties mid-wind-up re-parks the timer too.
    if (next.kind === "throw" && this.actionCd <= THROW_WINDUP_MS && !this.throwTarget()) {
      this.actionCd = THROW_WINDUP_MS;
      return;
    }
    this.actionCd -= dtMs;
    if (this.actionCd > 0) return;
    // The source checks each action's `allowedTo…` gate AFTER the roll but BEFORE arming
    // any timer, so an action it cannot perform right now (a second wall, an exhausted
    // summon) costs nothing — it simply re-rolls on the next tick instead of burning the
    // slot on a no-op cast.
    if (!this.canPerform(next)) {
      this.rollNextAction();
      return;
    }
    if (next.kind === "throw") {
      const target = this.throwTarget();
      if (!target) {
        // Unreachable at the fixed 50 ms tick (the empty-lane park above catches the
        // timer long before expiry) — kept as the same hold for safety at any dt.
        this.actionCd = THROW_WINDUP_MS;
        return;
      }
      this.launchProjectile(target, next.option.damage, next.option.sprite, next.option.spriteSize);
      this.throwCount++;
      this.actionCd = this.bossThrow!.intervalMs;
      this.rollNextAction();
      return;
    }
    // A special: wind up now, resolve when the cast completes (above).
    this.pendingSpecial = next.special;
    this.specialCast = Math.max(0, next.special.castMs);
  }

  /** Is the boss in its action posture at all?
   *
   *  GROUND TRUTH: `-[CivilianActorFight bossUpdate:]` (0x67b40) opens with
   *  `if (state - 15 > 12) goto civilianUpdate`, and inside that 15..27 window the action
   *  ROLL lives only in the state-19 arm. A boss that has finished its descent is in
   *  state 9 — below the window — so it drops straight through to `civilianUpdate` and
   *  has NO specials at all: no laser, no summon, no wall, no throw. It just swings.
   *
   *  An Epic Boss is the one exception, and only because it has no perch to be gated on:
   *  it falls onto the lane instead of occupying a state-19 phase, so it keeps its
   *  actions once it has landed. */
  private bossCanAct(): boolean {
    if (!this.boss || !this.boss.alive) return false;
    if (this.bossFallsFromSky) return this.boss.state !== "falling";
    return this.boss.state === "structure";
  }

  /** The source's per-action `allowedTo…` gates: a wall while one already stands and a
   *  summon while the last abductee still lives are refused, and the boss picks again
   *  rather than casting a no-op. Everything else is performable while it is up top. */
  private canPerform(action: BossActionChoice): boolean {
    // EVERY action is gated on the boss still being on its perch, not just throws. Doing
    // this as "un-performable" rather than "wait" matters: otherwise a pre-rolled action
    // would sit in the slot forever once the boss descends.
    if (!this.bossCanAct()) return false;
    if (action.kind === "throw") return !!this.bossThrow;
    if (action.kind !== "special") return true;
    if (action.special.name === "wall") {
      const wt = this.wallTemplate;
      return !!wt && !this.enemies.some((e) => e.alive && e.sourceKey === wt.sourceKey);
    }
    if (action.special.name === "summonBoss") {
      // `allowedToSummonBoss` (0x5eda4): a non-empty list, and `bossWall` empty — the
      // summoned actor is parked there, so only one abductee lives at a time.
      return (
        !!this.summonCfg &&
        this.summonQueue.length > 0 &&
        !this.enemies.some((e) => e.alive && e.isSummon)
      );
    }
    if (action.special.name === "turnZombie") {
      // Same shape as `allowedToSummonBoss`: one converted zombie stands at a time, and
      // there has to be a front fighter to convert. Refusing costs the boss nothing — it
      // re-rolls — so an army with nobody deployed yet is not quietly given a free pass.
      return (
        !!this.turnedTemplate &&
        !this.enemies.some((e) => e.alive && e.isTurned) &&
        !!this.frontFighter()
      );
    }
    if (action.special.name === "alienLaser") {
      // `ZFFightMan allowedToShootBullet` walks `zombies` and refuses the shot unless at
      // least one is ENGAGED (`isInMeleeRange`, or one of the special-attack states). With
      // the lane empty of fighters the saucer holds its fire — it never snipes the crowd
      // still walking up. See laserTarget().
      return !!this.laserTarget();
    }
    return true;
  }

  /** Roll the next action from the merged budget (deterministic — no RNG). */
  private rollNextAction() {
    this.nextAction = weightedPick(this.actions, this.actionCount, 0x51ec1a1);
    if (this.nextAction) this.actionCount++;
  }

  /** Merge the boss's throw options and specials into one weighted table, exactly the
   *  `bossActions` array the source rolls against: each throwable debris keeps its own
   *  authored frequency alongside each special's. */
  private buildActionBudget(): BossActionChoice[] {
    const out: BossActionChoice[] = [];
    if (this.boss && this.bossThrow) {
      for (const option of this.bossThrow.options) {
        out.push({ kind: "throw", weight: option.weight, option, special: null as never });
      }
    }
    for (const special of this.specials) {
      out.push({ kind: "special", weight: special.weight, special, option: null as never });
    }
    return out;
  }

  /** Land a boss special. Effects that need spawned entities (summonBoss, wall) go
   *  through spawnEnemy; both are capped so the fight still resolves. */
  private runSpecial(sp: BossSpecial) {
    switch (sp.name) {
      case "alienLaser": {
        // Flat 200 per bolt — a hard constant in the source, not a stat-derived value
        // (`AlienStageBullet collidedWith:` passes the immediate 200.0f to `damage:`).
        // The saucer has TWO guns and picks between them 50/50 every shot
        // (`AlienStageActor createBullet`: a `(arc4random()%100)/100 < 0.5` roll chooses
        // (-55,+2) or (+5,-5) off the boss, in the source's 480x320 stage points).
        const target = this.laserTarget();
        if (target) {
          const muzzle = hash(this.actionCount * 11 + 3) < 0.5 ? LASER_MUZZLE_A : LASER_MUZZLE_B;
          this.launchProjectile(target, sp.damage || ALIEN_LASER_DAMAGE, ALIEN_LASER_SPRITE, 20, {
            straight: true,
            originDx: muzzle.dx,
            originDy: muzzle.dy,
          });
        }
        break;
      }
      case "pixelFire": {
        // Source (`ZFFightMan pixelFire`): picks ONE random eligible zombie and calls
        // `setOnFire`. The target selection is ground truth and unchanged; what the fire
        // then DOES is a deliberate divergence.
        //
        // Recovered, the burn lasts exactly one frame — `setOnFire` sets the zombie's
        // destination to its own current position, so the burning state ticks once, finds
        // it has already arrived, and leaves. ~0.08 % of max HP: Zedzox's headline special
        // was worth about two damage. We ship the burn it is plainly reaching for instead
        // (PIXEL_FIRE_BURN_MS at the recovered 5 %/s), and give the player the answer the
        // one-frame version never needed: tap it out. See raid/videoGameStage.ts.
        const eligible = this.players.filter(
          (p) => p.alive && !p.taken && !p.burnMs && (p.state === "advance" || p.state === "fight")
        );
        const victim = eligible.length
          ? eligible[Math.floor(hash(this.actionCount * 7 + 5) * eligible.length) % eligible.length]
          : null;
        if (victim) {
          victim.windupKey = null; // the cancelled swing (this half IS ground truth)
          victim.windupMs = 0;
          victim.timerMs = this.cycleMs(victim, null);
          victim.burnMs = PIXEL_FIRE_BURN_MS;
          victim.burnAnchorX = victim.x;
          // Panic AWAY from the enemy first, so the fire visibly breaks the front line
          // rather than shoving the zombie further into it.
          victim.burnDir = -1;
          victim.struckThisTick = true;
        }
        break;
      }
      case "turnZombie": {
        // Zedzox turns a zombie against you. This USED to be modelled as
        // `dealDamage(victim, victim.hp)` — the front zombie simply evaporated, with no
        // projectile, no animation and no attacker anywhere near it, and went down as a
        // permanent casualty. That is the "zombies die suddenly for no reason" players
        // reported on this invasion, and it was never what the action does: the source
        // name, the wiki text and an authored-but-unspawnable `VideoGameStageZombieActor`
        // all say CONVERT.
        //
        // So it converts. The zombie is carried out of the fight — `taken`, exactly like a
        // Beach crab's passenger: still alive, still a survivor, NOT a loss — and a pixel
        // zombie stands up in the middle of the lane wearing its identity. Tap that apart
        // and you get the zombie back (tapTurned).
        const template = this.turnedTemplate;
        const victim = template ? this.frontFighter() : null;
        if (victim && template) {
          victim.taken = true;
          victim.windupKey = null;
          victim.windupMs = 0;
          victim.burnMs = 0; // a zombie that is dragged off stops being on fire
          victim.struckThisTick = true;
          const turned = this.spawnEnemy(template);
          turned.isSummon = true; // off the wave budget, so it can't hold the descent
          turned.isTurned = true;
          turned.turnedFromId = victim.id;
          // Beamed in mid-field on the scorch mark, standing, exactly as an abductee is —
          // same landing point, same "already past it" latch. See SUMMON_SPAWN_X.
          turned.state = "hold";
          turned.x = SUMMON_SPAWN_X;
          turned.y = CENTER_Y;
          turned.prevX = turned.x;
          turned.prevY = turned.y;
          // No `passedWall` latch here, unlike an abductee or a wall: this one blocks
          // nobody (see wallInWay), so there is nothing to have got past.
        }
        break;
      }
      case "telekinesis": {
        // Source (`ZFFightMan telekinesis:`) deals NO damage: it lifts the zombie,
        // `knockBackBy:force:` it down the lane and `stunSelfFor:` holds it there.
        const victim = this.frontFighter() ?? this.throwTarget();
        if (victim) {
          this.knockBackZombie(victim);
          victim.stunMs = Math.max(victim.stunMs, TELEKINESIS_STUN_MS);
          victim.struckThisTick = true;
        }
        break;
      }
      case "summonBoss": {
        // GROUND TRUTH (`-[ZFFightMan summonBoss:]` 0x5ee2c): the alien boss abducts a
        // HUMAN. It pops `bossSummonList[0]`, spawns it at `enemyPosition`, and then
        // pushes ONE freshly rolled name back on — five candidates, 20 % each — so the
        // queue never empties. The only limit is one abductee alive at a time, enforced
        // in canPerform. The victim is off-budget (see SimUnit.isSummon).
        const cfg = this.summonCfg;
        const key = this.summonQueue.shift();
        if (!cfg || !key) break;
        const template = cfg.queue.find((u) => u.sourceKey === key)
          ?? cfg.pool.find((u) => u.sourceKey === key);
        if (template) {
          const victim = this.spawnEnemy(template);
          victim.isSummon = true;
          // Beamed down mid-field, not queued behind the wave at the doorway — see
          // SUMMON_SPAWN_X. Leaving it "queued" would also deadlock it, since the wave's
          // release gate deliberately ignores summons.
          victim.state = "hold";
          victim.x = SUMMON_SPAWN_X;
          victim.y = CENTER_Y;
          victim.prevX = victim.x;
          victim.prevY = victim.y;
          // Same latch the wall uses: a zombie already past the spawn point does not turn
          // round to fight something that appeared behind it.
          for (const p of this.players) {
            if (p.alive && p.x > victim.x + 0.5) p.passedWall = true;
          }
        }
        // The refill roll: `(int)((arc4random() % 100) / 100.0f * 5.0f)`, hashed here for
        // replay. Rolled even when the spawn itself failed, exactly as the source does.
        //
        // Its own salt. Every draw in this sim is `hash(actionCount * a + b)`, so two
        // draws sharing (a, b) are not merely both deterministic — they are the SAME
        // number. This one shared (13,7) with `laserTarget`, and both belong to the
        // ALIEN boss, so which human it abducted was locked to which zombie its laser
        // would have picked on that same cycle. The pairs in use are (13,7) laser
        // target, (11,3) laser muzzle, (7,5) pixelFire victim, and (17,11) here; no two
        // of them agree for any actionCount.
        if (cfg.pool.length) {
          const i = Math.min(
            cfg.pool.length - 1,
            Math.floor(hash(this.actionCount * 17 + 11) * cfg.pool.length)
          );
          this.summonQueue.push(cfg.pool[i].sourceKey);
        }
        break;
      }
      case "wall": {
        // Materialize at the Garden support line. It never walks or attacks.
        // Re-check the perch here as well as in canPerform: with no wall standing and
        // the last minion dead, promote() can start the boss's descent DURING the 3 s
        // cast, and a wall that lands after that would sit behind the boss forever.
        const wt = this.boss?.state === "structure" ? this.wallTemplate : null;
        if (wt && !this.enemies.some((e) => e.alive && e.sourceKey === wt.sourceKey)) {
          const wall = this.spawnEnemy(wt);
          wall.isWall = true;
          wall.state = "hold";
          wall.x = this.supportX;
          wall.y = CENTER_Y;
          wall.prevX = wall.x;
          wall.prevY = wall.y;
          wall.vx = 0;
          wall.vy = 0;
          for (const p of this.players) {
            if (p.alive && p.x > wall.x + 0.5) p.passedWall = true;
          }
        }
        break;
      }
      // telekinesis handled above; anything else is a no-op.
      default:
        break;
    }
  }

  /** Spawn a new enemy from a template mid-fight (abductee / wall). It joins the enemy
   *  roster + the shared units array (so the renderer picks it up) and emerges through
   *  the normal queue. */
  private spawnEnemy(template: CombatUnit): SimUnit {
    const su = toSim({ ...template, id: `spawn${this.spawnSeq++}` }, this.enemies.length);
    su.state = "queued";
    su.hp = su.maxHp;
    su.alive = true;
    this.enemies.push(su);
    this.units.push(su);
    return su;
  }

  /** Front-most fighting player zombie (nearest the enemy), or null. */
  private frontFighter(): SimUnit | null {
    let best: SimUnit | null = null;
    for (const p of this.players) {
      // `!p.taken` for the reason spelled out in frontMostPlayer: a zombie already turned
      // into a pixel zombie is not standing there to be turned (or shoved) again.
      if (!p.alive || p.taken || (p.state !== "fight" && p.state !== "advance")) continue;
      if (!best || p.x > best.x + 0.5 || (Math.abs(p.x - best.x) <= 0.5 && p.y > best.y)) best = p;
    }
    return best;
  }

  /** Deployed zombies (released from the focus bar and out on the lane). */
  private deployed(): SimUnit[] {
    return this.players.filter(
      (p) => p.alive && !p.taken && (p.state === "advance" || p.state === "fight")
    );
  }

  /** Advance the Trapeze Artist grab hazard. Spawns one at a time on a cadence; successive
   *  appearances alternate right-to-left and left-to-right, seize a selected zombie on
   *  contact, hold ~1s, then rise to carry it off. Tapping (tapGrabber) whittles its HP — killed → the
   *  zombie DROPS back into the fight; escaped off the top → the carried zombie DIES. */
  private stepGrabbers(dtMs: number) {
    if (!this.grabberCfg) return;
    // Spawn one at a time on a cadence, only while there's a deployed zombie to threaten.
    const active = this.grabbers.some((g) => g.state !== "gone");
    if (!active && this.anyAlive(this.players)) {
      this.grabberTimer -= dtMs;
      if (this.grabberTimer <= 0 && this.deployed().length > 0) {
        const victim = this.deployed().sort((a, b) => a.x - b.x)[0];
        this.spawnGrabber(victim);
        this.grabberTimer = GRABBER_SPAWN_MS;
      }
    }
    for (const g of this.grabbers) {
      if (g.state === "gone") continue;
      if (g.tapCdMs > 0) g.tapCdMs -= dtMs;
      if (g.state === "swoop") {
        g.pauseMs = Math.max(0, g.pauseMs - dtMs);
        const t = 1 - g.pauseMs / g.swingTotalMs;
        const eased = t * t * (3 - 2 * t);
        g.rot = g.swingStartDeg + (g.contactDeg - g.swingStartDeg) * eased;
        if (g.pauseMs <= 0) {
          const victim = g.targetId
            ? this.players.find((p) => p.id === g.targetId)
            : null;
          if (!victim || !victim.alive ||
              (victim.state !== "advance" && victim.state !== "fight")) {
            g.state = "gone";
            continue;
          }
          // Re-anchor directly above the victim and turn vertical. Because contactDeg
          // put the artist itself at the victim first, only the rope pivot jumps.
          g.x = victim.x;
          g.y = victim.y - GRABBER_ZOMBIE_OFFSET_Y;
          g.rot = GRABBER_CONTACT_DEG;
          g.grabbedId = victim.id;
          g.targetId = null;
          g.state = "carry";
          g.pauseMs = GRABBER_CARRY_PAUSE_MS;
          victim.state = "grabbed";
          victim.windupKey = null;
          victim.windupMs = 0;
          victim.stunMs = 0;
        }
      } else if (g.state === "carry") {
        const z = g.grabbedId ? this.players.find((p) => p.id === g.grabbedId) : null;
        if (!z || !z.alive) {
          g.grabbedId = null;
          g.state = "gone";
          continue;
        }
        if (g.pauseMs > 0) {
          g.pauseMs -= dtMs;
        } else {
          g.y -= (GRABBER_RISE_SPEED * dtMs) / 1000;
          g.rot = 90;
        }
        z.x = g.x; // the seized zombie rides below the overhead trapeze
        z.y = g.y + GRABBER_ZOMBIE_OFFSET_Y;
        z.prevX = z.x;
        z.prevY = z.y;
        if (z.y <= GRABBER_ESCAPE_ZOMBIE_Y) {
          z.hp = 0; // carried off — the zombie is lost
          z.alive = false;
          z.state = "dead";
          g.grabbedId = null;
          g.state = "gone";
        }
      }
    }
    // Drop inert grabbers so the array (and snapshots) stay small.
    for (let i = this.grabbers.length - 1; i >= 0; i--) {
      if (this.grabbers[i].state === "gone") this.grabbers.splice(i, 1);
    }
  }

  /** Advance the Beach crab hazard. Ground truth (`BeachStageActorCrab update:`): spawns on
   *  the obstacle timer up to `limit` alive at once, wanders, grabs the first deployed
   *  zombie it touches (that zombie goes inert + invincible), holds `holdMs`, then hauls it
   *  off the LEFT edge — at which point the zombie leaves the fight (`taken`, source state
   *  38: NOT death, it comes home afterwards). Tapping it to death (`tapCrab`) frees the
   *  zombie and returns the spawn slot. */
  private stepCrabs(dtMs: number) {
    if (!this.crabCfg) return;
    const live = this.crabs.filter((c) => c.state !== "gone").length;
    if (live < this.crabCfg.limit && this.anyAlive(this.players)) {
      this.crabTimer -= dtMs;
      if (this.crabTimer <= 0) {
        this.spawnCrab();
        this.crabTimer = this.crabCfg.spawnMs;
      }
    }
    for (const c of this.crabs) {
      if (c.state === "gone") continue;
      if (c.tapCdMs > 0) c.tapCdMs -= dtMs;
      if (c.state === "wander") {
        c.wanderMs -= dtMs;
        if (c.wanderMs <= 0) {
          // Re-pick a heading deterministically from the crab's own id + the sim clock,
          // so a replay of the same tick stream reproduces the same patrol.
          c.dir = ((this.crabSeq + Math.floor(this.elapsed / CRAB_WANDER_MS)) % 2 === 0 ? -1 : 1);
          c.wanderMs = CRAB_WANDER_MS;
        }
        c.x += (CRAB_WALK_SPEED * c.dir * dtMs) / 1000;
        if (c.x < CRAB_WANDER_MIN_X) { c.x = CRAB_WANDER_MIN_X; c.dir = 1; }
        if (c.x > CRAB_WANDER_MAX_X) { c.x = CRAB_WANDER_MAX_X; c.dir = -1; }
        const victim = this.deployed().find(
          (p) => !p.taken && Math.hypot(p.x - c.x, p.y - c.y) <= CRAB_HIT_R
        );
        if (victim) {
          c.grabbedId = victim.id;
          c.state = "hold";
          c.holdMs = this.crabCfg.holdMs;
          victim.state = "grabbed";
          victim.windupKey = null;
          victim.windupMs = 0;
          victim.stunMs = 0;
        }
      } else if (c.state === "hold" || c.state === "carry") {
        const z = c.grabbedId ? this.players.find((p) => p.id === c.grabbedId) : null;
        if (!z || !z.alive) {
          c.grabbedId = null;
          c.state = "gone";
          continue;
        }
        if (c.state === "hold") {
          c.holdMs -= dtMs;
          if (c.holdMs <= 0) c.state = "carry";
        } else {
          c.x -= (CRAB_CARRY_SPEED * dtMs) / 1000; // haul it off the left edge
        }
        z.x = c.x; // the seized zombie rides along with the crab
        z.y = c.y;
        z.prevX = z.x;
        z.prevY = z.y;
        if (c.x <= CRAB_EXIT_X) {
          z.taken = true; // out of THIS fight; still alive, still a survivor
          c.grabbedId = null;
          c.state = "gone";
        }
      }
    }
    for (let i = this.crabs.length - 1; i >= 0; i--) {
      if (this.crabs[i].state === "gone") this.crabs.splice(i, 1);
    }
  }

  private spawnCrab() {
    const cfg = this.crabCfg!;
    this.crabs.push({
      id: `crab${this.crabSeq++}`,
      x: CRAB_WANDER_MAX_X,
      y: CENTER_Y,
      state: "wander",
      dir: -1,
      wanderMs: CRAB_WANDER_MS,
      hp: cfg.hp,
      maxHp: cfg.hp,
      tapDamage: cfg.tapDamage,
      grabbedId: null,
      holdMs: 0,
      tapCdMs: 0,
      sprite: cfg.sprite,
      struckThisTick: false,
    });
  }

  /** Player tapped a crab: one tap of damage (rate-limited). Ground truth is 100 damage a
   *  tap against 1000 HP — ten taps; the shipped HP is tuned down per input device (seven
   *  taps on touch, four with a mouse — see RaidManager.crabOf and raid/hazardTaps.ts),
   *  and the rate limit likewise. Killing it releases any zombie it holds back onto the lane
   *  (source state 9 → 10, invincibility off) and frees its spawn slot. */
  tapCrab(id: string): boolean {
    const c = this.crabs.find((x) => x.id === id && x.state !== "gone");
    if (!c || c.tapCdMs > 0) return false;
    c.tapCdMs = this.hazardTapCooldownMs;
    c.hp -= c.tapDamage;
    c.struckThisTick = true;
    if (c.hp <= 0) {
      c.hp = 0;
      const z = c.grabbedId ? this.players.find((p) => p.id === c.grabbedId) : null;
      if (z && z.alive) {
        z.state = "advance"; // released: back on the lane, re-advances from the rear
        z.y = CENTER_Y;
        z.timerMs = this.cycleMs(z, null);
        z.stunMs = 0;
        z.formOrder = this.releaseSeq++;
        z.frontPriority = false;
      }
      c.grabbedId = null;
      c.state = "gone";
    }
    return true;
  }

  /** Crabs the renderer can draw / the player can tap. */
  activeCrabs(): SimCrab[] {
    return this.crabs.filter((c) => c.state !== "gone");
  }

  /** Prepare living zombies for the presentation-only end march. Remaining rescue
   *  hazards are destroyed and drop their passengers; focus/ability poses are
   *  cleared so nobody keeps thinking or attacking after combat has ended. */
  prepareArmyExit(): void {
    const heldIds = new Set<string>();
    for (const grabber of this.grabbers) {
      if (grabber.grabbedId) heldIds.add(grabber.grabbedId);
    }
    for (const crab of this.crabs) {
      if (crab.grabbedId) heldIds.add(crab.grabbedId);
    }

    this.grabbers.length = 0;
    this.crabs.length = 0;
    this.projectiles.length = 0;
    // Combat is over, so anything still holding a zombie lets go: a pixel zombie left
    // standing when the boss fell hands its captive back for the victory march. It costs
    // the player nothing either way (a captive is `taken`, so it was already coming home),
    // but marching out one short of the army that won looks like a bug.
    for (const turned of this.enemies) {
      if (turned.isTurned) this.releaseTurned(turned);
    }

    for (const zombie of this.players) {
      if (!zombie.alive || zombie.taken) continue;
      zombie.burnMs = 0; // nobody marches out of a won fight still on fire
      if (heldIds.has(zombie.id)) zombie.y = CENTER_Y;
      if (!zombie.buddyCarrierId) zombie.state = "advance";
      zombie.prevX = zombie.x;
      zombie.prevY = zombie.y;
      zombie.vx = 0;
      zombie.vy = 0;
      zombie.charge = 0;
      zombie.distracted = false;
      zombie.awaitRelease = false;
      zombie.bubbleMs = 0;
      zombie.windupKey = null;
      zombie.windupMs = 0;
      zombie.stunMs = 0;
    }
  }

  private spawnGrabber(victim: SimUnit) {
    const cfg = this.grabberCfg!;
    const seq = this.grabSeq++;
    const swingStartDeg = seq % 2 === 0 ? 0 : 180;
    const targetDx = clamp(
      (victim.x - GRABBER_PIVOT_X) / GRABBER_SWING_RADIUS_X,
      -1,
      1
    );
    const contactDeg = Math.acos(targetDx) * 180 / Math.PI;
    const swingTotalMs = Math.max(
      1,
      GRABBER_FULL_ARC_MS * Math.abs(contactDeg - swingStartDeg) / 180
    );
    this.grabbers.push({
      id: `grab${seq}`,
      x: GRABBER_PIVOT_X,
      y: GRABBER_PIVOT_Y,
      state: "swoop",
      hp: cfg.hp,
      maxHp: cfg.hp,
      tapDamage: cfg.tapDamage,
      grabbedId: null,
      pauseMs: swingTotalMs,
      tapCdMs: 0,
      sprite: cfg.sprite,
      rot: swingStartDeg,
      swingStartDeg,
      contactDeg,
      swingTotalMs,
      targetId: victim.id,
      struckThisTick: false,
    });
  }

  /** Player tapped a Trapeze Artist: deal one tap of damage (rate-limited by tapDelay).
   *  Killing it frees (drops) the zombie it carried back onto the lane. Returns true if a
   *  tap registered (drives tap feedback). */
  tapGrabber(id: string): boolean {
    const g = this.grabbers.find((x) => x.id === id && x.state !== "gone");
    if (!g || g.tapCdMs > 0) return false;
    g.tapCdMs = this.hazardTapCooldownMs;
    g.hp -= g.tapDamage;
    g.struckThisTick = true;
    if (g.hp <= 0) {
      g.hp = 0;
      const z = g.grabbedId ? this.players.find((p) => p.id === g.grabbedId) : null;
      if (z && z.alive) {
        // Dropped: it just falls back to the lane and resumes advancing/fighting.
        z.state = "advance";
        z.y = CENTER_Y;
        z.timerMs = this.cycleMs(z, null);
        z.stunMs = 0;
        z.formOrder = this.releaseSeq++; // re-enters at the back of the formation
        z.frontPriority = false;
      }
      g.grabbedId = null;
      g.state = "gone";
    }
    return true;
  }

  /** The live Trapeze Artist currently carrying a zombie (renderer taps it), or null. */
  activeGrabber(): SimGrabber | null {
    return this.grabbers.find((g) => g.state === "carry") ?? null;
  }

  /** Player tapped a converted PIXEL ZOMBIE: beat one tap's worth out of it. Sized off its
   *  own max HP so PIXEL_ZOMBIE_TAPS taps break it open whatever the elite profile did to
   *  its body. Breaking it hands the zombie inside back to the lane — the same release the
   *  crab and the trapeze already do for a passenger, and the reason the taps are worth
   *  spending on a body the army cannot chew through.
   *
   *  Returns true if a pixel zombie took the tap (drives the tap feedback + the
   *  transcript). */
  tapTurned(id: string): boolean {
    const z = this.enemies.find((e) => e.id === id && e.isTurned && e.alive);
    if (!z) return false;
    this.dealDamage(z, Math.max(1, z.maxHp / PIXEL_ZOMBIE_TAPS), true);
    z.struckThisTick = true; // the release itself is dealDamage's job, not this one's
    return true;
  }

  /** Hand a broken-open pixel zombie's captive back. It re-enters at the BACK of the
   *  formation and re-advances, exactly as a dropped trapeze / crab passenger does. */
  private releaseTurned(turned: SimUnit): void {
    const z = turned.turnedFromId
      ? this.players.find((p) => p.id === turned.turnedFromId)
      : null;
    turned.turnedFromId = null;
    if (!z || !z.alive || !z.taken) return;
    z.taken = false;
    z.state = "advance";
    z.x = CHARGE_X;
    z.y = CENTER_Y;
    z.prevX = z.x;
    z.prevY = z.y;
    z.vx = 0;
    z.vy = 0;
    z.stunMs = 0;
    z.burnMs = 0;
    z.timerMs = this.cycleMs(z, null);
    z.formOrder = this.releaseSeq++;
    z.frontPriority = false;
  }

  /** Player tapped a burning zombie: smother the fire. One tap does it — the burn is on a
   *  clock, not a health bar, and making the player land several taps on a panicking rig
   *  that is pacing across the lane would mean the fire usually wins by default.
   *
   *  Returns true if a fire was actually put out, so a tap on a zombie that is not burning
   *  (or whose fire has already run out) is refused rather than transcribed. */
  tapFire(id: string): boolean {
    const z = this.players.find((p) => p.id === id && p.alive && !p.taken && p.burnMs > 0);
    if (!z) return false;
    z.burnMs = 0;
    z.timerMs = this.cycleMs(z, null); // back to a full swing, not a half-charged one
    return true;
  }

  /** Every zombie currently on fire — the renderer draws a flame on each and makes it a
   *  tap target. */
  burningPlayers(): SimUnit[] {
    return this.players.filter((p) => p.alive && !p.taken && p.burnMs > 0);
  }

  /** Live converted pixel zombies (the renderer taps these). */
  turnedEnemies(): SimUnit[] {
    return this.enemies.filter((e) => e.isTurned && e.alive);
  }

  /** Player tapped a boss-summoned wall: chip it (ground truth ZFFightWall ccTouchEnded →
   *  damage: ≈ maxHp/20). Returns true if a wall took the tap. */
  tapWall(id: string): boolean {
    const w = this.enemies.find((e) => e.id === id && e.isWall && e.alive);
    if (!w) return false;
    this.dealDamage(w, WALL_TAP_DAMAGE, true);
    w.struckThisTick = true;
    return true;
  }

  /** Launch a projectile at a target, LEADING its (capped) motion so it connects with
   *  advancing zombies. Ballistic by default (a lobbed throw); pass `straight` for a
   *  fast flat bolt (alien laser). */
  private launchProjectile(
    target: SimUnit,
    damage: number,
    sprite: string,
    spriteSize: number,
    opts: { straight?: boolean; originDx?: number; originDy?: number } = {}
  ) {
    const x0 = BOSS_STRUCT_X + (opts.originDx ?? 0);
    const y0 = BOSS_STRUCT_Y + (opts.originDy ?? 0);
    const grav = opts.straight ? 0 : GRAVITY;
    // Flight time: a straight bolt is range/speed; a ballistic lob scales with range.
    const T = opts.straight
      ? (Math.hypot(target.x - x0, target.y - y0) || 1) / LASER_SPEED
      : clamp(Math.abs(target.x - x0) / 520 + 0.7, 0.85, 1.7);
    // Aim where the target will be after T, using its speed-capped lead velocity — a
    // LOB only. A straight bolt is fired at wherever the target stood when the trigger
    // was pulled: `shootBullet:from:` reads `[target position]` once and hands the raw
    // point to `shootBulletAt:from:`, which just normalizes the difference. No lead.
    const { vx: lvx, vy: lvy } = opts.straight
      ? { vx: 0, vy: 0 }
      : this.leadVelocity(target);
    const tx = target.x + lvx * T;
    const ty = target.y + lvy * T;
    let vx: number;
    let vy: number;
    if (opts.straight) {
      const dx = tx - x0;
      const dy = ty - y0;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * LASER_SPEED;
      vy = (dy / d) * LASER_SPEED;
    } else {
      vx = (tx - x0) / T;
      vy = (ty - y0) / T - 0.5 * GRAVITY * T; // ballistic solve to the lead point
    }
    this.projectiles.push({
      id: `proj${this.projSeq++}`,
      x: x0,
      y: y0,
      vx,
      vy,
      rot: 0,
      rotSpeed: (vx < 0 ? -1 : 1) * 7,
      damage: damage > 0 ? Math.max(1, Math.round(damage)) : 0,
      sprite,
      spriteSize,
      done: false,
      gravity: grav,
    });
  }

  /** Integrate each throw under gravity; lazy circle collision vs zombies; a throw
   *  that reaches the ground has missed. Fast/small zombies can be missed. */
  private stepProjectiles(dtMs: number) {
    const dt = dtMs / 1000;
    for (const pr of this.projectiles) {
      if (pr.done) continue;
      pr.vy += pr.gravity * dt; // gravity 0 for straight bolts (alien laser)
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.rot += pr.rotSpeed * dt;
      const hitR = ZOMBIE_HIT_R + pr.spriteSize * PROJ_HIT_FACTOR;
      for (const p of this.players) {
        // A thrown item can only strike zombies that have moved out to fight —
        // ones still waiting in the group or charging up are safe.
        if (!p.alive || (p.state !== "advance" && p.state !== "fight")) continue;
        const dx = p.x - pr.x;
        const dy = p.y - pr.y;
        if (dx * dx + dy * dy <= hitR * hitR) {
          // Carried grabs are the Trapeze Artist (stepGrabbers) and the Beach crab
          // (stepCrabs), not projectiles — a projectile only ever deals damage.
          this.dealEnemyDamage(p, pr.damage);
          p.struckThisTick = true;
          this.projectileImpactsThisTick++;
          this.lastProjectileImpactSprite = pr.sprite;
          pr.done = true;
          break;
        }
      }
      if (pr.done) continue;
      // A ballistic throw fizzles (misses) once it reaches the ground.
      if (pr.y >= GROUND_Y) pr.done = true;
      // A GRAVITY-FREE bolt (the alien laser) never comes down, so the ground test can
      // never retire one that missed. Fizzle it at the lane edges instead.
      else if (pr.gravity === 0 && (pr.x < -80 || pr.x > FIELD_W + 80)) pr.done = true;
    }
    // Compact in place (keep the readonly array reference stable).
    let w = 0;
    for (let r = 0; r < this.projectiles.length; r++) {
      if (!this.projectiles[r].done) this.projectiles[w++] = this.projectiles[r];
    }
    this.projectiles.length = w;
  }

  /** Whether the player side won (all enemies dead). Meaningful once finished. */
  get playerWon(): boolean {
    return !this.anyAlive(this.enemies);
  }

  /** Ms left before the boss enrages (0 once enraged / no boss). For the HUD timer. */
  roundRemainingMs(): number {
    return this.boss ? Math.max(0, this.roundLeft) : 0;
  }

  /** Has the boss enraged (round timer expired)? Drives the HUD's ENRAGED banner. */
  get enraged(): boolean {
    return this._enraged;
  }

  /** Snapshot the result in the shape the reward pipeline expects. */
  outcome(): RaidOutcome {
    return {
      win: this.playerWon,
      rounds: this.attacksLanded,
      survivors: this.players.filter((u) => u.alive).map((u) => u.id),
      losses: this.players.filter((u) => !u.alive).map((u) => u.id),
      // A pixel zombie broken open is a RESCUE, not a kill — it was one of yours. Counting
      // it would put a rescue in the "Enemies Beaten" line on the results panel.
      enemiesBeaten: this.enemies.filter((e) => !e.alive && !e.isTurned).length,
      playerDamage: this.playerDamage,
      escaped: this.escaped,
      feats: {
        abilityKills: this.feats.abilityKills.map((kill) => ({ ...kill })),
        resurrections: this.feats.resurrections.map((rez) => ({ ...rez })),
      },
    };
  }
}
