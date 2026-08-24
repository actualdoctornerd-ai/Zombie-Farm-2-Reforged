// The live raid battle scene (Phase 1). A full-screen Pixi layer that renders a
// BattleSim: a cover-fit stage background, a token per combatant (zombie
// portrait / enemy icon / boss portrait) with a health bar, and top-corner team
// bars (total HP + unit count). Zombies march in, the fight plays out live, and
// survivors march off on a win — then onFinish(outcome) hands the result back to
// RaidManager.finishRaid for rewards.
//
// Scope note: the boss is a plain fighter here; its structure, thrown
// projectiles, phase-2 re-entry, charge bars, distractions, and ability effects
// are later phases (see IMPLEMENTATION_RAIDS_PLAN.md). Tokens are placeholder
// portraits, not side-view stage actors.
import { AnimatedSprite, Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { GameAssets, raidImage, zombiePortrait } from "../assets";
import { isEpicBossKey } from "../epicBoss/combat";
import { noteAssetFailure } from "../assetFailures";
import { ALIEN_LASER_SPRITE, BattleSim, BOSS_STRUCT_X, BOSS_STRUCT_Y, CHARGE_X, ENEMY_HOLD_X, ENEMY_SPAWN_X, EPIC_BOSS_LAND_MS, FIELD_H, FIELD_W, laserInterval, SimUnit, TELEPORT_PX, THROW_WINDUP_MS } from "./BattleSim";
import { RaidActor } from "./RaidActor";
import { EnemyActor, type EnemyAttackPose } from "./EnemyActor";
import { ParticleField, ParticleConfig } from "./Particles";
import { ABILITY_POOL } from "../zombie/traits";
import { ACTIVATED_ABILITY } from "../zombie/abilities";
import { BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, RaidDef, RaidLevelAsset, RaidOutcome, SummonConfig, WaveCadence } from "./types";
import { ABDUCTEE_KEYS, alienTintFor } from "./alienStage";
import { RAID_MAX_INPUTS, RAID_TICK_MS, type RaidReplayInput } from "./replay";
import { PVP_ZOMBIE_SPRITE_PREFIX } from "./pvp";
import {
  extrapolatePosition,
  interpolatePosition,
  isOffstageBossReentryFrame,
  playerStagingOffset,
  visualCountdown,
} from "./renderInterpolation";
import { advanceRaidArmy, raidArmyHasExited } from "./raidOutro";
import { zombieRaidHeightScale } from "../zombie/displayScale";
import { visibleMutations } from "../zombie/mutationVisibility";
import { zombieBasicAttackName } from "./zombieAttackPresentation";
import { zombieFacingDelta } from "./zombieFacing";
import {
  epicAttackFrameIndex, epicBossAnimationLoops, epicStripFrameIndex, selectEpicBossAnimation,
} from "./epicBossAnimation";
import { PixelFire } from "./pixelFireFx";
import { hazardTapProfile } from "./hazardTaps";
import {
  formatHealthNumbers, newDamageTally, tallyDamage, type DamageTally,
} from "./combatNumbers";
import { getShowDamageNumbers, getShowHealthNumbers } from "../prefs";
import { isMobile } from "../platform";
import { readSafeAreaInsets } from "../safeArea";
import { abilityColumnStep, computeRaidHudLayout } from "./raidHudLayout";

type RaidInputDraft =
  | { type: "bubble"; unitId: string }
  | { type: "ability"; abilityKey: string }
  | { type: "wallTap"; unitId: string }
  | { type: "fireTap"; unitId: string }
  | { type: "turnedTap"; unitId: string }
  | { type: "retreat" };
import { BASE } from "../base";

export interface RaidSceneParams {
  raid: RaidDef;
  assets: GameAssets; // for the per-type zombie models + enemy sprites
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossThrow: BossThrowConfig | null;
  /** Boss special (non-throw) actions to schedule during the fight. */
  bossSpecials?: BossSpecial[];
  /** The alien boss's abductee queue (null/omitted = this boss can't summon). */
  summon?: SummonConfig | null;
  /** How this stage feeds its wave in (omitted = the one-at-a-time default). */
  waveCadence?: WaveCadence;
  /** Blocker the boss's wall action spawns (null/omitted = none). */
  wallTemplate?: CombatUnit | null;
  /** Pixel zombie the boss's turnZombie converts a zombie into (null/omitted = none).
   *  Only the Video Games boss carries the action — see raid/videoGameStage.ts. */
  turnedTemplate?: CombatUnit | null;
  /** Carried-grab hazard (Circus Trapeze Artist) for this raid (null/omitted = none). */
  grabber?: GrabberConfig | null;
  /** Beach crab hazard for this raid (null/omitted = none). Client-only — see crabOf. */
  crab?: CrabConfig | null;
  /** Concentration boost spent — skip the focus-bubble minigame this fight. */
  concentration?: boolean;
  /** Precommitted 10/30/50 brain award. Each visible brain represents a stack of 5. */
  brainDrop?: number;
  roundMs?: number;
  escapeOnRoundEnd?: boolean;
  noDistractions?: boolean;
  imageBase?: string;
  bossTexture?: string;
  /** Face portrait for the enemy team badge; defaults to raid.bossPortrait. */
  bossPortrait?: string;
  bossAnimations?: Record<string, { file: string; cellWidth: number; cellHeight: number; frameCount: number; frameSeconds: number }>;
  bossFallsFromSky?: boolean;
  bossEngageDistance?: number;
  bossGroundOffset?: { x: number; y: number };
  confirmRetreat?: () => Promise<boolean>;
  /** Watch-a-recording mode: the verified transcript is injected at its recorded
   *  ticks and every fight control is disabled, so the deterministic sim re-fights
   *  the exact stored fight. The retreat button becomes "End Replay". Used by the
   *  PvP replay viewer — the config must be the fight's PINNED config, same ruleset. */
  playback?: { finalTick: number; inputs: RaidReplayInput[] };
  onCheckpoint?: (finalTick: number, inputs: RaidReplayInput[]) => Promise<void>;
  /** Presentation-only authored attack cue; combat remains deterministic without it. */
  onStrike?: (strike: {
    team: "player" | "enemy";
    attackName?: string;
    impact?: "projectile";
    sfxFile?: string;
  }) => void;
  /** Presentation-only zombie bark when its full-focus brain bubble sends it forward. */
  onBrainRelease?: (sourceKey: string) => void;
  /** Presentation-only callback on the decisive victory tick, before the outro march. */
  onVictory?: () => void;
  onFinish: (outcome: RaidOutcome, finalTick: number, inputs: RaidReplayInput[]) => void;
}

// Smash (bash / bashV2) tell: while charging, the zombie GROWS to 1+SMASH_GROW as it
// raises its arms; when the raise completes (damage lands) it rapidly slams the arms
// back down and shrinks over SMASH_SLAM_S. Grow is anchored at the feet so it looms
// upward in place. Only the bash family smashes (explode/mini keep the plain raise).
const SMASH_KEYS = new Set(["bash", "bashV2"]);
const SMASH_GROW = 0.4;
const SMASH_SLAM_S = 0.18;

// Explode / Explode Ver.2 — the one move that costs the player the zombie performing
// it (BattleSim.stepWindup). It has to LOOK like it: a full-screen-ish fireball with a
// shockwave that outruns it, a burst of sparks, a lingering smoke column, and a short
// shake of the battlefield layers. Radii are in unscaled field pixels — everything is
// multiplied by sizeScale() at draw time so it reads the same on a phone.
const BLAST_LIFE_S = 0.85; // fireball + shockwave lifetime
const BLAST_BALL_R = 132; // fireball radius at full swell
const BLAST_RING_R = 260; // how far the shockwave ring races out
const BLAST_SHAKE_S = 0.45;
const BLAST_SHAKE_PX = 11;
const FUSE_SPARK_S = 0.11; // spark cadence while the fuse burns down
// Sparks thrown by the blast: a fast omnidirectional additive burst that falls under
// gravity and shrinks to embers. Authored here rather than as a particles/*.json
// because it has no ZF2R original to copy — the source never destroyed its exploder.
const BLAST_SPARKS: ParticleConfig = {
  maxParticles: 110,
  angle: 90, angleVariance: 180,
  speed: 300, speedVariance: 170,
  gravityx: 0, gravityy: -520, // cocos y-UP: negative pulls the sparks down-screen
  particleLifespan: 0.75, particleLifespanVariance: 0.35,
  startParticleSize: 30, finishParticleSize: 3,
  sourcePositionVariancex: 14, sourcePositionVariancey: 12,
  startColorRed: 1, startColorGreen: 0.74, startColorBlue: 0.26, startColorAlpha: 1,
  finishColorAlpha: 0,
  rotatePerSecond: 0,
  blendFuncDestination: 1, // additive — reads as fire, not as dust
};
// The same sparks, tiny and slow: the fuse fizzing while the zombie charges.
const FUSE_SPARKS: ParticleConfig = {
  ...BLAST_SPARKS,
  maxParticles: 6,
  speed: 90, speedVariance: 50,
  gravityy: -260,
  particleLifespan: 0.35, particleLifespanVariance: 0.15,
  startParticleSize: 14, finishParticleSize: 2,
  startColorRed: 1, startColorGreen: 0.86, startColorBlue: 0.42,
};
// The T3/T4 Regular-zombie eye beam: the sim deals its laser damage in instant
// ticks (BattleSim.stepLaser), and each tick re-arms the drawn beam for one firing
// interval plus this linger. While the cadence keeps re-arming it the beam reads
// as a single continuous ray from the eyes to the victim; once the ticks stop
// (zombie halted, target down) it winks out after the fade below.
const BEAM_LINGER_S = 0.2;
const BEAM_FADE_IN_S = 0.05;
const BEAM_FADE_OUT_S = 0.12;
// The whole beam throbs — width and brightness together — at this angular rate
// (~6.5 pulses/second), so the laser reads as pumped energy rather than a drawn line.
const BEAM_PULSE_RAD_S = 41;
// While a beam burns, the impact point smoulders: a small wisp of the stage's own
// smoke particle (the enemy-death swirlCloudFX) on this cadence, at this scale.
const BEAM_SMOKE_S = 0.22;
const BEAM_SMOKE_SCALE = 0.35;
// The per-hit dust burst a PLAYER zombie throws off as it connects, held back for
// now: a full army swinging at once turned the frontline into a permanent cloud.
// Enemy strikes keep theirs — they land one at a time and the puff is what marks
// the hit. Flip this back on to restore the zombie side of the effect.
const SHOW_ZOMBIE_ATTACK_DUST = false;
const INTRO_MS = 700; // brief establishing hold before combat starts
const END_PAUSE_MS = 650; // beat after the last blow before we move on
// On a win, survivors stroll off to the right at a normal walking pace (not the old
// victory sprint). Results wait until the entire visible army clears the stage.
const OUTRO_WALK_SPEED = 230; // sim px/s — a normal march (cf. enemy EMERGE_SPEED 210)
const OUTRO_RESULT_DELAY_MS = 1500; // keep the original menu timing while the march continues behind it
const RETREAT_RESULT_DELAY_MS = 1500;
const EPIC_BOSS_EXIT_MS = 800; // reverse the sky entry before the result panel appears
const DEATH_FADE = 0.45; // seconds for a fallen unit to poof + fade out
const HEAL_POSE_S = 0.7; // Garden healer raises, holds, then lowers both arms
// Beam-down pillar, recovered from the binary — see spawnLightPillar for the derivation.
// The width is in design units (of DESIGN_W); the height is the whole stage.
const PILLAR_DESIGN_W = 100;
const PILLAR_OPEN_S = 0.2;
const PILLAR_CLOSE_S = 1.3;
const PILLAR_TOTAL_S = PILLAR_OPEN_S + PILLAR_CLOSE_S;
const PLAYER_COLOR = 0x8bc34a;
const ENEMY_COLOR = 0xef5350;
const BOSS_COLOR = 0xffc107;

// Ability chrome. Activated moves are buttons, so they get the bigger cell and the
// wooden face; team passives are read-only status, so they get the small flat one.
const ABILITY_ACTIVE_R = 27; // half-size of a tappable wooden ability button
const ABILITY_PASSIVE_R = 15; // half-size of an informational team-passive icon
const ABILITY_ACTIVE_STEP = 2 * ABILITY_ACTIVE_R + 10; // vertical pitch of the button column
const ABILITY_PASSIVE_STEP = 2 * ABILITY_PASSIVE_R + 6; // horizontal pitch of the passive row
/** Gap between the top HUD's lower edge and the passive row beneath the health bar. */
const ABILITY_PASSIVE_GAP = 7;
/** Gap between the top HUD and the button column when there is no passive row. */
const ABILITY_ACTIVE_GAP = 14;
// Activated buttons hold their slot for the whole fight and signal availability by
// darkening instead of vanishing. Tint (not alpha) keeps them solid over a busy
// battlefield, so a dark button still reads as a button.
// Kept light enough that the ICON stays legible at every level: the player learns
// the column by which move sits in which slot, so an unreadable slot is no better
// than a missing one.
const ABILITY_TINT_ARMED = 0xffffff; // a tap lands right now
const ABILITY_TINT_RECHARGING = 0x9a9a9a; // in position, mid wind-up or cooling down
const ABILITY_TINT_UNAVAILABLE = 0x5e5e5e; // nobody in position to perform it

/** The face of a tappable ability button: the HUD's plank browns, a lit top bevel,
 *  a warm inner rule, and a dark rim — the same read as the farm's wooden buttons. */
function woodenButtonFace(R: number): Graphics {
  const D = 2 * R;
  const g = new Graphics()
    .roundRect(-R, -R, D, D, 9).fill({ color: 0x5c3819 })
    .roundRect(-R + 2, -R + 2, D - 4, (D - 4) * 0.52, 7).fill({ color: 0x7d5227 });
  // Plank grain: a few darker strokes so the face isn't a flat brown square.
  for (let i = 1; i <= 3; i++) {
    const y = -R + (D * i) / 4;
    g.moveTo(-R + 5, y).lineTo(R - 5, y).stroke({ width: 1, color: 0x3f2711, alpha: 0.35 });
  }
  return g
    .roundRect(-R + 3, -R + 3, D - 6, D - 6, 6).stroke({ width: 1, color: 0xc7a05a, alpha: 0.45 })
    .roundRect(-R, -R, D, D, 9).stroke({ width: 3, color: 0x2f1d0d });
}

/** The face of a passive (informational) ability icon: the flat dark slot frame. */
function passiveIconFrame(R: number): Graphics {
  return new Graphics()
    .roundRect(-R, -R, 2 * R, 2 * R, 6)
    .fill({ color: 0x14140f, alpha: 0.82 })
    .stroke({ width: 2, color: 0x6f9a52 });
}
// On-screen heights (px) the unit sprites are scaled to. Enemies + boss read bigger
// than the zombies in the real game (a lumberjack towers over a grunt, McDonnell is
// huge on the silo), so they carry a larger target height.
// These are the target heights (px) AT the reference stage scale below. Because the
// stage is contain-fit (it scales with the window), units are drawn at H * (current
// stage scale / SIZE_REF_SCALE) so they track the background instead of being a fixed
// pixel size (which turned them into giants on a small window / specks on a big one).
const ZOMBIE_H = 91;
const ZOMBIE_HP_HALF_W = 32;
const ENEMY_H = 130;
const BOSS_H = 195;
// Optional battlefield numbers (Settings → Display), both off by default. A floating
// damage figure lives this long, rises this far (in unit-space px, so it tracks the
// stage scale), and the field holds at most this many at once — a fifty-strong brawl
// must not turn into a Text-allocation storm on a phone.
const DAMAGE_NUMBER_LIFE_S = 0.85;
const DAMAGE_NUMBER_RISE = 46;
const DAMAGE_NUMBER_MAX = 32;
// The Beach crab hazard. It used to be mis-filed as a wave enemy and so rendered at the
// full ENEMY_H, which read far too big for a critter that scuttles between ankles; a third
// of that is the size the player asked for (and matches the source's 0.8-scaled 86x43 art
// sitting well below the zombies' heads).
const CRAB_H = ENEMY_H / 3;
// Approximate attachment/contact point along hazard_trapeze_girl.png's 358px width.
// The ropes occupy x=0..~280 and the artist's grabbing body is centered near x=300.
const TRAPEZE_ARTIST_X = 300;
// Per-boss height multipliers (by enemy source key) for bosses that read wrong at the
// shared BOSS_H. Old McDonnell is a chunky sprite that looms too large on his silo —
// scaled down 20% to sit better on the structure.
// Per-enemy forward nudge, as a fraction of the sprite's RENDERED width (+ = toward the
// zombies / screen-left). Enemy rigs are authored with every part in positive model x, so
// the art hangs entirely to the RIGHT of the unit's sim origin (see the hpCenterX note in
// makeToken). Enemies scale to a target HEIGHT, so a very WIDE rig renders correspondingly
// wide and its art overhangs the stage's right edge at the doorway hold spot. Keyed by
// enemy source key.
const ENEMY_FORWARD_FX: Record<string, number> = {
  // Valentine's chocolate monsters. Minion1 is the extreme case: a 219x69 rig (~3.2:1),
  // so at enemy height it renders ~6x wider than a normal humanoid minion and sat mostly
  // off-screen. 2 and 3 are squatter than average too, but far less severe.
  ValentinesDayStageActorMinion1: 0.4,
  ValentinesDayStageActorMinion2: 0.4,
  ValentinesDayStageActorMinion3: 0.4,
};
const BOSS_H_SCALE: Record<string, number> = {
  FarmStageActorBoss: 0.8, // Old McDonnell — 20% smaller
};
// The contain-fit scale at which the *_H heights above render 1:1. Raise this to make
// all units smaller across the board, lower it to make them bigger.
const SIZE_REF_SCALE = 1.6;
// Background layout. The bg is CONTAIN-fit (whole scene visible, no bottom crop);
// the ground line the characters stand on sits GROUND_FY down the image, and the
// boss perches on the silo at PERCH_F*. Letterbox areas fill with sky/grass.
const GROUND_FY = 0.9;
// Units sit below the bg's painted ground line. The second offset is shared by all
// ground combatants so enemy feet use the same baseline as zombie feet.
const GROUND_NUDGE = ZOMBIE_H * 0.2;
const UNIT_GROUND_NUDGE = ZOMBIE_H * 0.22;
// Default boss perch (fraction of the stage rect) for raids with no right-side
// structure — the boss hovers up-right like a UFO (Aliens) rather than standing.
const PERCH_FX = 0.82;
const PERCH_FY = 0.2;
// How far to sink the boss BELOW the perch structure's top edge (fraction of the
// structure height), so it stands behind the roof/silo with its legs occluded by the
// structure — the boss renders in a layer BEHIND the perch art (see bossBackLayer).
const PERCH_SINK_F = 0.14;
// Where a perched boss's THROWS leave from — its hand, in unit-space offsets from the
// boss token origin (feet at the perch). Without this the projectile spawned at the
// raw sim origin (mapped separately from the boss token) appeared down-left of him.
const BOSS_HAND_DX = -4; // slightly toward the zombies (screen-left) of centre
const BOSS_HAND_FY = 0.58; // up the boss sprite (fraction of its rendered height)
// Where along the perch structure (fraction from its LEFT edge) the boss stands.
// 0.5 = dead centre (a big boss then clips the screen's right edge); lower = farther
// left, over the building.
const PERCH_BIAS_FX = 0.22;
// Per-raid perch nudge (screen-rect fractions; +dx = right, +dy = DOWN). Corrects the
// computed/default perch where a specific boss reads wrong vs. the real game — eyeballed.
// Applies to BOTH structure perches (sinks the boss lower behind the building) and sky
// perches (moves the hovering boss). Keyed by raid id.
const PERCH_TWEAK: Record<number, { dx?: number; dy?: number }> = {
  // At the reference stage scale a boss is ~0.38 of the stage height, so 0.19
  // moves CorporateVille down about half of his rendered height. Keep his
  // existing 0.13 correction as well.
  2: { dy: 0.32 }, // Lawyers: existing correction + another half-height down
  3: { dy: 0.095 }, // Pirates: about one quarter of the boss's rendered height down
  4: { dy: 0.12 }, // Ninjas: too high on the structure
  5: { dy: 0.31 }, // Robots: another ~40% of the boss's rendered height down
  6: { dx: -0.03, dy: 0.2 }, // Aliens (sky perch): too high; rides a UFO
  7: { dx: -0.18, dy: 0.28 }, // Summer Break (sky perch): squid boss too far right + too high
  8: { dx: -0.14 }, // Circus: boss too far right on the car
  10: { dy: 0.2 }, // Tree World (sky perch): head cropped off the top of the screen
  // Valentine's: Felix Wonky stands on the shop table, not up in the sky. The default
  // sky perch (PERCH_FY 0.2) puts him near the ceiling; +0.45 lands his feet at 0.65
  // down the stage rect — i.e. ~35% up from the bottom, on the table top.
  11: { dy: 0.45 },
};
// Alien boss rides a UFO (AlienStageElements bossShip/bossShipBack): the saucer + glass
// dome sit IN FRONT of the alien (its transparent centre shows the pilot), the small back
// dome behind.
//
// GROUND TRUTH — `-[AlienStageActorBoss initSprite]` (0xc68b8) + `movementUpdate:`
// (0xc6e20) + AlienStageElements.plist. Everything below is transcribed, not eyeballed:
//
//   * The rig root is scaled 0.58 (`setScale: 0x3f147ae1`) and the two ship halves are
//     NOT — they hang off the actor at full size. So the pilot is a SMALL alien inside a
//     BIG canopy: the 140x128 saucer is the whole silhouette, and the 0.58 pilot (96.8 px
//     tall) sits entirely inside it. The old eyeballed constants had it the other way up
//     — a 195 px alien bursting out of a 156 px saucer.
//   * Both halves are positioned at `actor.position + rigScale * body.position`; the body
//     attachment rests at AlienStage.json's bossBody offset (0, 3), so the ship anchor is
//     1.7 px above the boss's feet.
//   * `bossUpdate:` attaches the front half at the actor's zOrder + 1 and the back half at
//     zOrder - 1 (state 19), and removes BOTH on state 9 (death) — the saucer does not
//     outlive its pilot.
const ALIEN_BOSS_KEY = "AlienStageActorBoss";
const CIRCUS_BOSS_KEY = "CircusStageActorBoss";
const NINJA_BOSS_KEY = "NinjaStageActorBoss";
/** `setScale:` on the alien's rig root — the pilot's size RELATIVE to its saucer. */
const UFO_PILOT_SCALE = 0.58;
/** The composed boss is exactly the saucer's 140x128 art box. */
const UFO_GROUP_W = 140;
const UFO_GROUP_H = 128;
/** Where the ship halves hang, in source px above the boss's feet (rigScale x bossBody
 *  offsetY = 0.58 x 3). */
const UFO_ANCHOR_DY = -UFO_PILOT_SCALE * 3;
/** Authored cocos anchorPoints (y measured from the BOTTOM) for the two halves. */
const UFO_FRONT_ANCHOR = { x: 0.53, y: 0.25 };
const UFO_BACK_ANCHOR = { x: 0.56, y: -0.75 };
/** The pilot rig's own art box relative to the boss's feet, at the authored 0.58 —
 *  derived from AlienStage.json's boss parts (pivot + offset), so the rig sits in the
 *  canopy instead of being naively bottom-aligned to the token origin. */
const UFO_PILOT_BOX = { left: -24.9, top: -88.7, bottom: 8.1 };
/** The saucer's art box relative to the same origin (bossShip 140x128 at its anchor). */
const UFO_SHIP_BOX = { left: -74.2, top: -97.7 };
/** The idle hover: `startAnim:` state 0 runs a looping CCSequence of two 0.5 s CCMoveTos
 *  on the body attachment, to (0,-10) and (0,+10) — and `movementUpdate:` drags the ship
 *  halves along with it, so pilot and saucer bob together. Amplitude is in source px and
 *  is scaled by the rig root (0.58), like the body position it is applied to. */
const UFO_HOVER_PX = 10 * UFO_PILOT_SCALE;
const UFO_HOVER_HALF_PERIOD_SEC = 0.5;
// Letterbox fill behind the contain-fit stage image (visible only where the screen
// shape leaves bars around the 480x320 art). Kept DARK so it reads as an inset stage
// rather than fake sky/grass that never matched the real background art. (The stage
// backgrounds themselves still need proper work — this is the interim treatment.)
const LETTERBOX_TOP = 0x1b1e24;
const LETTERBOX_BOT = 0x101216;
// Horizontal inset of the combat lane inside the stage rect: units used to run right
// to ~4% of the edges and spill past the ground area of the art. Pull them in.
const FIELD_INSET_FX = 0.1;
// Waiting and focus-queue zombies use the left letterbox edge as their visual
// boundary instead of floating well inside the authored raid image.
const PLAYER_STAGING_NUDGE_FX = 0.06;
const CENTER_Y = FIELD_H / 2; // sim y that sits on the ground line
// Source fight-stage design space: level assets are authored 1:1 in 480x320 points
// (verified: every fightBG*_bg is 480x320; structures like the barn are positioned
// within it), with cocos2d Y-UP anchors/positions. The whole stage is CONTAIN-fit.
const DESIGN_W = 480;
const DESIGN_H = 320;

/** Parse a source "{x,y}" vector string into [x, y]. */
function parseVec(s: string): [number, number] {
  const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(s || "");
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
}
/** Composited static enemy sprite (from tools/prep_enemies.py), if one exists. */
const enemySprite = (key: string) => `${BASE}assets/raids/enemies/${key}.png`;
/** Packed part strip for an enemy's animated rig (raids/enemies/parts/<key>.png). */
const enemyStripUrl = (key: string) => `${BASE}assets/raids/enemies/parts/${key}.png`;
const enemyFrameUrl = (key: string, state: "idle" | "attack", frame: number) =>
  `${BASE}assets/raids/enemies/animations/${key}/${state}-${frame}.png`;
// ---- pixelFire flame (see raid/pixelFireFx.ts) ----
/** One flame square at SIZE_REF_SCALE, in unit px. Coarse on purpose: the fire has to read
 *  as built out of blocks at a glance, and a finer grid just looks like a smooth flame. */
const FIRE_CELL_PX = 7;
/** How far the flame's base sinks below the rig's top edge, so it burns ON the zombie
 *  rather than floating above its head. Sized against a rendered zombie: at 10 the flame
 *  balanced on the crown and read as a party hat. It wants to start around the eyes and
 *  wrap the head — the zombie is alight, it is not carrying a candle. */
const FIRE_HEAD_OVERLAP = 26;
/** The flame fades out over this much of the burn's tail. */
const FIRE_FADE_MS = 900;

const ENEMY_FRAME_COUNTS: Record<string, { idle: number; attack: number }> = {
  VideoGameStageBossActor: { idle: 2, attack: 4 },
  VideoGameStageGhostActor: { idle: 3, attack: 3 },
  VideoGameStageKnightActor: { idle: 3, attack: 3 },
  VideoGameStageMonsterActor: { idle: 3, attack: 3 },
  VideoGameStageZombieActor: { idle: 4, attack: 3 },
};
// Source-game focus thought-bubbles (misc/thoughtBubble*.png), shown over the
// charging zombie. Butterfly = distracted; brain = fully focused / ready; hmm = the
// same bubble, empty but for a "..." (all three are the same 64x62 shape).
const BUBBLE_BUTTERFLY = BASE + "assets/ui/thoughtBubbleButterfly.png";
const BUBBLE_BRAIN = BASE + "assets/ui/thoughtBubbleBrains.png";
const BUBBLE_HMM = BASE + "assets/ui/thoughtBubbleHmm.png";
const DROP_BRAIN = BASE + "assets/ui/topbar_brain_icon.png";
const BUBBLE_SCALE = 0.91; // the source art is 64x62 (1.3 enlarged, then scaled ~30% down)
const BUBBLE_DX = 74; // shift the (mirrored) bubble right of the charging zombie (~one bubble width: 16 + 64*0.91)

type Phase = "intro" | "fight" | "outro" | "retreat" | "defeat" | "done";

interface Token {
  root: Container;
  actor?: RaidActor; // player zombie rig (walk animation)
  enemyActor?: EnemyActor; // enemy rig (idle bob / walk / limb animation)
  frameActor?: {
    sprite: Sprite;
    idle: Texture[];
    attack: Texture[];
    time: number;
  }; // authentic pre-rendered Video Games frames
  epicActor?: AnimatedSprite;
  epicAnim?: string;
  /** The alien boss's two saucer halves. GROUND TRUTH: `-[AlienStageActorBoss
   *  bossUpdate:]` (0xc6bb8) attaches them while the boss is perched (state 19) and
   *  `removeChild`s BOTH — nilling the ivars, so it is permanent — the moment it finishes
   *  its descent and lands (state 9). The alien boss fights the ground phase on foot. */
  ufoParts?: Sprite[];
  /** Bar geometry for the alien boss ALONE, applied when the saucer above is destroyed —
   *  the bars were sized to the 140x128 ship and have to shrink onto the 0.58 pilot. */
  pilotBars?: { base: number; hpCenterX: number; topY: number };
  hp: Graphics;
  /** "27/40" over the health bar. Built ONLY when the player asked for the numbers,
   *  so the default battlefield allocates no extra Text per combatant. */
  hpText?: Text;
  charge: Graphics; // focus bar (zombies, while charging)
  base: number; // half-width for the bars
  hpCenterX: number; // visual center of the actor in token-local coordinates
  topY: number; // y of the sprite top (negative), for the hp bar
  atkCount: number; // basic hits landed; advances this zombie's bite/scratch alternation
  deathAnim: number; // seconds since death (-1 while alive); drives the fade+poof
  emerged: boolean; // has this token appeared on-field yet (for the spawn puff)
  // Smash grow/slam (bash family). smashSlam counts down the post-release slam (-1 =
  // inactive); wasSmashWindup is last frame's smash charge (0..1) to detect release.
  smashSlam: number;
  wasSmashWindup: number;
  actorBaseScale: number; // the zombie rig's normal container scale (for the feet-anchored grow)
  actorBaseY: number; // and its normal container y (feet at the token origin)
  // Last-drawn bar states. Graphics.clear()+redraw forces a re-tessellation and a
  // GPU geometry upload, so the bars only redraw when their drawn width changes
  // (-1 = hidden). Keys quantise the fraction to ¼% steps.
  hpKey: number;
  chargeKey: number;
  healFxSeq: number; // last heal event rendered for this unit
  healCastSeq: number; // last heal cast rendered for this Garden zombie
  healPose: number; // seconds remaining in the arms-overhead healing pose
  laserFxSeq: number; // last automatic laser event rendered for this unit
  explodeFxSeq: number; // last self-destruct blast rendered for this unit
  fuseT: number; // seconds accumulated toward the next Explode wind-up spark
}

/** The opaque box inside a texture, in texture pixels — everything outside it is
 *  transparent padding. A species portrait frames its zombie inside a fixed 160x180
 *  card with a LOT of air (a mini fills about 46% of the height, sitting low), so a
 *  sprite sized by the texture draws a zombie roughly half the intended size, parked
 *  off-centre. Callers that need the ZOMBIE to be a given size on screen have to
 *  measure the content, not the card. Null when pixels are unavailable (no document,
 *  a tainted canvas); callers fall back to plain texture sizing. */
function opaqueBounds(url: string): { x: number; y: number; w: number; h: number } | null {
  if (typeof document === "undefined") return null;
  const source = Assets.cache.get(url) as Texture | undefined;
  const image = source?.source?.resource as CanvasImageSource | undefined;
  if (!image) return null;
  const w = Math.max(1, source!.width);
  const h = Math.max(1, source!.height);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, w, h);
    const pixels = context.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 8/255, not 0: the extracted art carries a faint premultiplied halo that
        // would otherwise measure as content and re-inflate the padding.
        if (pixels[(y * w + x) * 4 + 3] <= 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch {
    return null;
  }
}

async function loadTex(url: string): Promise<Texture | null> {
  try {
    return (await Assets.load(url)) as Texture;
  } catch {
    // Returning null is deliberate — a missing decoration must not cost the player the
    // fight — but it must not be SILENT as well. An unloadable texture was invisible from
    // inside the game and from the bug report alike, which is how a three-second stall on
    // a URL that could never exist survived a whole beta. See assetFailures.ts.
    noteAssetFailure(url);
    return null;
  }
}

/** Fetch a cocos2d particle config (raids/particles/<name>.json); null on failure. */
async function loadParticle(name: string): Promise<ParticleConfig | null> {
  try {
    return (await (await fetch(`${BASE}assets/raids/particles/${name}.json`)).json()) as ParticleConfig;
  } catch {
    return null;
  }
}

export class RaidScene {
  readonly container = new Container();
  private sim: BattleSim;
  private raid: RaidDef;
  private onFinish: (o: RaidOutcome, finalTick: number, inputs: RaidReplayInput[]) => void;
  private onCheckpoint: ((finalTick: number, inputs: RaidReplayInput[]) => Promise<void>) | null;
  private onStrike: ((strike: {
    team: "player" | "enemy";
    attackName?: string;
    impact?: "projectile";
    sfxFile?: string;
  }) => void) | null;
  private onBrainRelease: ((sourceKey: string) => void) | null;
  private onVictory: (() => void) | null;
  private lastCheckpointTick = 0;
  private checkpointing = false;
  private checkpointRetryAt = 0;

  private assets: GameAssets;
  private regularZombieNativeHeight: number | null = null;
  private backdrop = new Graphics(); // sky/grass fill behind the (letterboxed) stage
  private stageLayer = new Container(); // parallax level-asset layers (behind everyone)
  private stageLayers: { sp: Sprite; asset: RaidLevelAsset }[] = [];
  // The perch STRUCTURE (barn/silo/…) is split into its own layer drawn in FRONT of
  // the boss, so a boss standing on it has its legs occluded by the roof, while
  // ground units (enemies in the doorway) still render in front of the structure.
  private stageFrontLayer = new Container();
  private bossBackLayer = new Container(); // boss token, BEHIND the perch structure
  private perchLayer: { sp: Sprite; asset: RaidLevelAsset } | null = null;
  private perchFX = PERCH_FX; // boss perch, computed from the stage's structure
  private perchFY = PERCH_FY;
  private tokenLayer = new Container();
  private tokens = new Map<string, Token>();
  private texByUnit = new Map<string, Texture | null>(); // fallback portrait tokens
  private enemyTex = new Map<string, Texture | null>(); // composited enemy sprites
  private enemyStrip = new Map<string, Texture | null>(); // packed part strips (animated rigs)
  private enemyFrames = new Map<string, { idle: Texture[]; attack: Texture[] }>();
  private ufoBackTex: Texture | null = null; // alien boss UFO (back dome)
  private ufoFrontTex: Texture | null = null; // alien boss UFO (saucer + glass dome)
  private hoverClock = 0; // seconds, drives the alien saucer's idle bob

  /** How to draw a thrown ZOMBIE so it reads at its true field size (see
   *  `opaqueBounds`). Keyed by the same `zombie:<key>` sprite name as `projTex`;
   *  absent for every ordinary boss projectile, which keeps its authored sizing. */
  private projZombieDraw = new Map<string, { scale: number; anchorX: number; anchorY: number }>();
  // Boss projectiles.
  private bossThrow: BossThrowConfig | null;
  private wallTemplate: CombatUnit | null; // preloaded so a spawned wall renders as a sprite
  private summon: SummonConfig | null; // alien abductee queue (drives their art preload)
  private turnedTemplate: CombatUnit | null; // pixel zombie (drives its art preload)
  private grabberSprite = ""; // Trapeze Artist art (preloaded), "" if this raid has none
  private crabSprite = ""; // Beach crab art (preloaded), "" if this raid has none
  private grabTex: Texture | null = null; // trapeze texture
  private grabLayer = new Container(); // trapeze sprites (above the field, tappable)
  private grabSprites = new Map<string, {
    root: Container;
    pendulum: Container;
    ropeExtension: Graphics;
    body: Sprite;
    bar: Graphics;
    extensionLength: number;
  }>();
  private crabTex: Texture | null = null; // beach crab hazard texture
  private crabLayer = new Container(); // crab sprites (above the field, tappable)
  private crabSprites = new Map<string, { root: Container; body: Sprite; bar: Graphics }>();
  /** `pixelFire` flames, one per burning zombie (above the field, tappable to smother). */
  private fireLayer = new Container();
  private fires = new Map<string, PixelFire>();
  private imageBase: string | null;
  private bossTexture: string;
  private bossPortrait: string;
  private bossAnimationDefs: RaidSceneParams["bossAnimations"];
  private bossGroundOffset: { x: number; y: number };
  private bossFallsFromSky = false;
  private bossExitMs = 0;
  private bossFrames = new Map<string, Texture[]>();
  private projLayer = new Container();
  private projTex = new Map<string, Texture | null>();
  private projSprites = new Map<string, Sprite>();
  // Screen position of the perched boss's throwing hand (updated in layout), so
  // projectiles visually leave his hand rather than a separately-mapped sim origin.
  private bossHandX = 0;
  private bossHandY = 0;
  private dotTex: Texture | null = null; // round placeholder for sprite-less hazards
  private fxLayer = new Container(); // transient effects (death poofs) above the field
  private beamLayer = new Container(); // beam-down pillars, BEHIND the units they deliver
  private beams: { g: Graphics; t: number }[] = [];
  private fx: { g: Graphics; t: number; life: number; color: number }[] = [];
  /** Settings → Display, read once when the scene is built: a raid does not change
   *  what it draws halfway through, and these are consulted per unit per tick. */
  private readonly showHealthNumbers = getShowHealthNumbers();
  private readonly showDamageNumbers = getShowDamageNumbers();
  /** Damage numbers: each unit's running damage-taken total as of the last sim tick, and
   *  the small hits held back since its last figure (see combatNumbers.ts). Watching
   *  `damageFxTaken` rather than `hp` is what makes a number read the size of the ATTACK
   *  instead of the health that came off — see BattleSim's field comment. */
  private damageWatch = new Map<string, number>();
  private damageTallies = new Map<string, DamageTally>();
  private damageNumbers: { text: Text; t: number; x: number; y: number }[] = [];
  /** Live T3/T4 eye beams, one per firing zombie (keyed by unit id). Redrawn every
   *  frame so both ends track their moving owners; see stepZombieBeams. */
  private zombieBeams = new Map<string, {
    g: Graphics; targetId: string; holdS: number; ageS: number; upgraded: boolean;
    smokeS: number; // countdown to the next impact-smoke wisp
  }>();
  private blastFx: { g: Graphics; t: number; scale: number }[] = [];
  private shakeT = 0; // seconds left in the blast shake (0 = still)
  private brainLayer = new Container();
  private brainTex: Texture | null = null;
  private brainDrop = 0;
  private brainDropFired = false;
  private brainSprites: {
    root: Container; t: number; delay: number; startX: number; startY: number; endX: number; endY: number;
  }[] = [];
  private particles = new ParticleField(); // melee-impact dust + victory confetti
  // Foreground aperture matte: battlefield art stays inside the stage image even
  // while units, projectiles, and hazards travel beyond any of its four edges.
  private stageMatte = new Graphics();
  private bashCfg: ParticleConfig | null = null;
  private confettiCfg: ParticleConfig | null = null;
  private smokeCfg: ParticleConfig | null = null; // enemy death poof (source: playDeathEffect → smoke.plist)
  private healCfg: ParticleConfig | null = null;
  private confettiFired = false;

  // Top HUD backing + team bars. The backing visually separates the health/stats
  // row from busy raid backgrounds while remaining translucent over the scene.
  private topHudBack = new Graphics();
  private pFill = new Graphics();
  private eFill = new Graphics();
  private pLabel!: Text;
  private eLabel!: Text;
  private roundLabel!: Text; // top-center countdown → "ENRAGED" when it expires
  private pFace = new Container(); // generic zombie face badge, left of the player bar
  private eFace = new Container(); // boss face badge, right of the enemy bar
  private retreatBtn = new Container();
  private retreatRequested = false;
  private retreated = false;
  private simAccumulatorMs = 0;
  private simTick = 0;
  private inputSeq = 0;
  private replayInputs: RaidReplayInput[] = [];
  /** Watch-a-recording mode (see RaidSceneParams.playback). */
  private playback: { finalTick: number; inputs: RaidReplayInput[] } | null = null;
  private playbackCursor = 0;

  private recordInput(input: RaidInputDraft): void {
    if (this.playback) return; // a replayed fight records nothing
    this.replayInputs.push({ ...input, seq: ++this.inputSeq, tick: this.simTick } as RaidReplayInput);
  }

  /** Feed the recorded transcript into the sim exactly where the verifier would:
   *  every input stamped `tick` applies before that tick is stepped. Refusals are
   *  ignored the same way the finish-path replay drops them. */
  private applyPlaybackInputs(): void {
    if (!this.playback) return;
    const inputs = this.playback.inputs;
    while (this.playbackCursor < inputs.length && inputs[this.playbackCursor].tick <= this.simTick) {
      const input = inputs[this.playbackCursor++];
      if (input.type === "bubble") this.sim.popBubble(input.unitId);
      else if (input.type === "ability") this.sim.activate(input.abilityKey);
      else if (input.type === "wallTap") this.sim.tapWall(input.unitId);
      else if (input.type === "fireTap") this.sim.tapFire(input.unitId);
      else if (input.type === "turnedTap") this.sim.tapTurned(input.unitId);
      else if (input.type === "retreat") this.retreatRequested = true;
    }
  }

  /** Hazard taps — on a boss WALL, on a burning zombie, on a converted pixel zombie — are
   *  the only input a player can produce without limit: one per tap, against however many
   *  blockers, fires and conversions a boss produces over a four-minute fight. Every one
   *  of them has to reach the verifier (an untranscribed tap desynchronises the two
   *  simulations), so once the transcript nears its cap the hazards simply stop taking
   *  taps. Refusing the tap keeps both sides in step; recording it past the cap would
   *  fail the whole finish with `too_many_inputs`. The reserve leaves room for the
   *  focus bubbles, ability taps, and the retreat that matter more. */
  private canRecordHazardTap(): boolean {
    return this.inputSeq < RAID_MAX_INPUTS - 64;
  }

  // Abilities read as two separate things, because they ARE two separate things.
  //
  //  • activeAbilityStrip — the tappable moves (Bash/Smash/Explode/Mini Buddy). Big
  //    wooden buttons in a vertical column, and each one is on screen ONLY while a
  //    zombie can actually perform it (Mini Buddy while a Large has yet to deploy,
  //    Bash/Smash/Explode once its zombie has reached the fighting line). A button
  //    the player can see is a button the player can press.
  //  • passiveAbilityStrip — small informational icons for the automatic team
  //    effects (Heal/Protect/Chivalry/…), laid out horizontally under the player's
  //    health bar. Nothing to tap, so nothing that looks tappable.
  private activeAbilityStrip = new Container();
  private passiveAbilityStrip = new Container();
  private abilityCells: {
    /** The button's identity for status lookup: a group's FIRST (highest-tier) key on
     *  an activated cell, the ability itself on a passive one. */
    key: string;
    cell: Container;
    badge?: Text;
    badgeDot?: Graphics;
    activated: boolean;
    /** Stacked buttons only: every move this button can fire, and the art for each,
     *  so `layout` can show the one a tap would actually spend. */
    icon?: Sprite;
    icons?: Map<string, Texture | null>;
    /** The key currently on the face — so the swap is skipped unless it changed. */
    shown?: string;
    /** Activated cells only: fixed index down the button column (-1 on a passive
     *  cell, which is laid out horizontally by its own slot counter). The pixel
     *  pitch is a layout-time decision; this index never changes. */
    slot: number;
  }[] = [];
  /** How many buttons the activated column holds — the divisor for its pitch. */
  private activeAbilityCount = 0;
  /** Whether the army carries any team passive at all — decides how far down the
   *  active column starts. Static for the whole fight, so the buttons never move. */
  private hasPassiveAbilities = false;

  // Focus bubble hovering over the charging zombie: the source game's own thought-
  // bubble art — a butterfly while distracted (tap to refocus), a brain when the
  // bar is full (tap to send it forward), or the empty "..." bubble while it simply
  // charges. One sprite, three textures, swapped in layout().
  private bubble = new Container();
  private bubbleSprite = new Sprite();
  private bubbleTexButterfly: Texture | null = null;
  private bubbleTexBrain: Texture | null = null;
  private bubbleTexHmm: Texture | null = null;
  private bubbleUnitId: string | null = null;
  /** Mirrors `bubble.eventMode`. Seeded `true` so the disarm in buildBubble is the
   *  write that establishes the real (non-interactive) starting state. */
  private bubbleInteractive = true;

  private phase: Phase = "intro";
  private phaseT = 0;
  private resultFired = false;
  private armyExitPrepared = false;
  private victoryNotified = false;
  private confirmRetreat: () => Promise<boolean>;

  private constructor(private app: Application, params: RaidSceneParams) {
    this.raid = params.raid;
    this.assets = params.assets;
    this.onFinish = params.onFinish;
    this.onCheckpoint = params.onCheckpoint ?? null;
    this.onStrike = params.onStrike ?? null;
    this.onBrainRelease = params.onBrainRelease ?? null;
    this.onVictory = params.onVictory ?? null;
    this.bossThrow = params.bossThrow;
    this.wallTemplate = params.wallTemplate ?? null;
    this.summon = params.summon ?? null;
    this.turnedTemplate = params.turnedTemplate ?? null;
    this.grabberSprite = params.grabber?.sprite ?? "";
    this.crabSprite = params.crab?.sprite ?? "";
    this.imageBase = params.imageBase ?? null;
    this.bossTexture = params.bossTexture ?? "";
    this.bossPortrait = params.bossPortrait ?? "";
    this.bossAnimationDefs = params.bossAnimations;
    this.bossGroundOffset = params.bossGroundOffset ?? { x: 0, y: 0 };
    this.bossFallsFromSky = !!params.bossFallsFromSky;
    this.confirmRetreat = params.confirmRetreat ?? (() => Promise.resolve(true));
    this.playback = params.playback ?? null;
    this.brainDrop = Math.max(0, Math.floor(params.brainDrop ?? 0));
    this.sim = new BattleSim(
      params.playerUnits,
      params.enemyUnits,
      params.bossThrow,
      !!params.concentration,
      params.bossSpecials ?? [],
      params.roundMs,
      params.summon ?? null,
      params.wallTemplate ?? null,
      !!params.noDistractions,
      !!params.escapeOnRoundEnd,
      !!params.bossFallsFromSky,
      params.bossEngageDistance,
      params.grabber ?? null,
      params.crab ?? null,
      params.waveCadence,
      params.turnedTemplate ?? null
    );
    // Rescue-hazard taps are paced for a finger by default. A mouse clicks two to three
    // times faster than that gate, so most of a click-spamming player's clicks landed
    // inside the cooldown and were dropped — which is what "there is a delay before my
    // clicks register" was. Client-only hazards, so this cannot reach the verifier.
    // A PLAYBACK sim must accept the recorded taps unpaced, like the verifier's does.
    this.sim.hazardTapCooldownMs = this.playback ? 0 : hazardTapProfile().cooldownMs;
  }

  /** Build a ready-to-add scene, preloading all textures first. */
  static async create(app: Application, params: RaidSceneParams): Promise<RaidScene> {
    const scene = new RaidScene(app, params);
    await scene.build();
    return scene;
  }

  private async build() {
    // Stage: render EVERY level asset as its own parallax layer, positioned in the
    // source 480x320 design space and z-sorted, so multi-layer raids (Pirate's
    // sky/water/mid/front, City's front building, Circus's car) compose correctly —
    // not just the single lowest-z layer.
    this.stageLayer.sortableChildren = true;
    this.container.addChild(this.backdrop, this.stageLayer);
    for (const asset of this.raid.levelAssets) {
      const tex = await loadTex(this.imageUrl(asset.sprite));
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.zIndex = asset.z;
      this.stageLayers.push({ sp, asset });
      this.stageLayer.addChild(sp);
    }
    this.computePerch();
    // Move the perch structure into a FRONT layer, with the boss layer just behind
    // it: render order becomes backdrop → stage (bg) → boss → perch structure →
    // ground tokens. So the boss stands behind the barn/silo (legs hidden by the
    // roof) while enemies in the doorway still draw in front of the structure.
    if (this.perchLayer) {
      this.stageLayer.removeChild(this.perchLayer.sp);
      this.stageFrontLayer.addChild(this.perchLayer.sp);
    }
    this.container.addChild(this.bossBackLayer, this.stageFrontLayer);

    // Enemy sprites: one composited actor per enemy type (farmhand/boss/…). Fall
    // back to the raid's flat enemy icon / boss portrait for types without one.
    // The alien boss's abductees arrive mid-fight, so their art has to be preloaded here
    // with the wave's — a token built at summon time has nothing to load from.
    const summonKeys = this.summon ? ABDUCTEE_KEYS : [];
    // Same for the pixel zombie `turnZombie` stands up: it too arrives mid-fight, and its
    // frames (idle-0..3 / attack-0..2, already in ENEMY_FRAME_COUNTS) have to be on hand
    // before the boss casts or the conversion lands as a blank token.
    const turnedKeys = this.turnedTemplate ? [this.turnedTemplate.sourceKey] : [];
    // Friend invasions field the DEFENDER's zombies as the enemy team. Those render
    // through the same farm rigs as the player's own (see makeToken's zombieRig test),
    // so their keys must not reach the enemy-art loader below — a zombie key under
    // assets/raids/enemies/ is the Epic Boss 404 stall all over again.
    const zombieRigEnemy = (u: SimUnit) => !!u.group && !!this.assets.zombieModels[u.sourceKey];
    const enemyKeys = [...new Set([
      ...this.sim.units.filter((u) => u.team === "enemy" && !zombieRigEnemy(u)).map((u) => u.sourceKey),
      ...summonKeys,
      ...turnedKeys,
    ])];
    await Promise.all(
      enemyKeys.map(async (k) => {
        // Prefer the animated rig (part strip) when a model exists; else the flat
        // composite; else the token falls back to the raid's icon / boss portrait.
        const frameCounts = ENEMY_FRAME_COUNTS[k];
        if (frameCounts) {
          const loadFrames = async (state: "idle" | "attack", count: number) =>
            (await Promise.all(
              Array.from({ length: count }, (_, i) => loadTex(enemyFrameUrl(k, state, i)))
            )).filter((tex): tex is Texture => tex !== null);
          this.enemyFrames.set(k, {
            idle: await loadFrames("idle", frameCounts.idle),
            attack: await loadFrames("attack", frameCounts.attack),
          });
        } else if (this.assets.enemyModels[k]) {
          this.enemyStrip.set(k, await loadTex(enemyStripUrl(k)));
        } else if (!isEpicBossKey(k)) {
          // NOT for an Epic Boss. Its key names an event, so `assets/raids/enemies/
          // EpicBoss:dr-groundhog.png` cannot exist — and asking anyway is not free:
          // `Assets.load` spends about THREE SECONDS discovering that (it falls back
          // from createImageBitmap to an <img> element, which has its own failure
          // delay), the result is never cached, so every attempt pays it again, and
          // the whole battle build is sitting on this await while it happens.
          //
          // Nothing was gained for the wait. An Epic Boss is drawn from its own folder
          // — the animation strips loaded below, or `bossTexture` through the fallback
          // — so this branch could only ever store a null. Reported as the Groundhog
          // battle "not loading" and showing a green screen: the farm is hidden and the
          // battle HUD is inside the scene, so until the scene lands there is nothing
          // on screen but the stage's clear colour. On a phone on mobile data that wait
          // is far longer than three seconds. See epicBoss/combat.isEpicBossKey.
          this.enemyTex.set(k, await loadTex(enemySprite(k)));
        }
      })
    );
    // A boss with combat art but no animation strips — the three reconstructed Epic
    // Bosses, whose atlases shipped without the frame metadata needed to cut strips —
    // is registered under its own source key so the token below builds it as a
    // full-size static sprite. Without this it matched no branch and fell through to
    // the last-resort portrait circle, fighting as a 34 px disc instead of a boss.
    if (this.bossTexture && !Object.keys(this.bossAnimationDefs ?? {}).length) {
      const bossKeys = new Set(
        this.sim.units.filter((u) => u.isBoss && !this.enemyTex.get(u.sourceKey))
          .map((u) => u.sourceKey)
      );
      if (bossKeys.size) {
        const tex = await loadTex(this.bossTexture);
        for (const key of bossKeys) this.enemyTex.set(key, tex);
      }
    }
    const enemyUrl = this.raid.enemyIcon ? raidImage(this.raid.enemyIcon) : "";
    const bossUrl = this.bossTexture || (this.raid.bossPortrait ? raidImage(this.raid.bossPortrait) : "");
    const fallbackUrls = new Map<string, string>();
    for (const u of this.sim.units) {
      if (u.team !== "enemy") continue;
      if (this.enemyFrames.get(u.sourceKey) || this.enemyTex.get(u.sourceKey)
        || this.enemyStrip.get(u.sourceKey)) continue;
      fallbackUrls.set(u.id, u.isBoss ? bossUrl : enemyUrl);
    }
    const uniq = [...new Set([...fallbackUrls.values()].filter(Boolean))];
    const texCache = new Map<string, Texture | null>();
    await Promise.all(uniq.map(async (url) => texCache.set(url, await loadTex(url))));
    for (const [id, url] of fallbackUrls) this.texByUnit.set(id, texCache.get(url) ?? null);
    if (this.bossAnimationDefs && this.imageBase) {
      await Promise.all(Object.entries(this.bossAnimationDefs).map(async ([name, def]) => {
        const sheet = await loadTex(this.imageUrl(def.file));
        if (!sheet) return;
        const frames: Texture[] = [];
        for (let i = 0; i < def.frameCount; i++) frames.push(new Texture({
          source: sheet.source,
          frame: new Rectangle(i * def.cellWidth, 0, def.cellWidth, def.cellHeight),
        }));
        this.bossFrames.set(name, frames);
      }));
    }

    // A spawned wall (Ninja carrotWall / Robot junkWall) uses its own bossAction sprite.
    // Preload it under its source key so the lazily-built token draws it, not a fallback
    // circle. sourceKey is the sprite name minus ".png" (see RaidManager wall template).
    if (this.wallTemplate) {
      this.enemyTex.set(
        this.wallTemplate.sourceKey,
        await loadTex(raidImage(`${this.wallTemplate.sourceKey}.png`))
      );
    }

    // Alien boss rides a UFO — preload its two ship sprites so makeToken can build it.
    if (this.sim.units.some((u) => u.isBoss && u.sourceKey === ALIEN_BOSS_KEY)) {
      [this.ufoBackTex, this.ufoFrontTex] = await Promise.all([
        loadTex(raidImage("ufo_bossShipBack.png")),
        loadTex(raidImage("ufo_bossShip.png")),
      ]);
    }

    // The Circus trapeze swings behind the zombies it targets. Add its layer first
    // so every zombie, including the carried one, remains readable in front of it.
    if (this.grabberSprite) this.container.addChild(this.grabLayer);
    // Beam-down pillars go in BEFORE the tokens, because the source puts them there:
    // `summonBoss:` adds the column at the arriving actor's `zOrder - 1`. In front, an
    // opaque full-height bar would white out the very unit it is delivering.
    this.container.addChild(this.beamLayer);
    this.tokenLayer.sortableChildren = true; // depth-sorted via per-token zIndex bands
    this.container.addChild(this.tokenLayer);
    for (const u of this.sim.units) this.tokens.set(u.id, this.makeToken(u));

    // Preload boss projectile sprites (chicken/bucket/debris).
    this.container.addChild(this.projLayer);
    this.container.addChild(this.fxLayer); // death poofs draw above everything
    this.container.addChild(this.particles.container); // impact dust / confetti on top
    this.container.addChild(this.brainLayer); // boss loot arcs above combat particles
    [this.bashCfg, this.confettiCfg, this.smokeCfg, this.healCfg] = await Promise.all([
      loadParticle("bash"),
      loadParticle("confetti"),
      loadParticle("smoke"),
      loadParticle("healSingle"),
    ]);
    for (const opt of this.bossThrow?.options ?? []) {
      if (this.projTex.has(opt.sprite)) continue;
      // A PvP formation defense throws its MINI, so the projectile is drawn from the
      // species portrait rather than the raid image folder. `zombie:<key>` is the
      // marker (src/raid/pvp.ts); every other sprite resolves exactly as before.
      const zombieKey = opt.sprite.startsWith(PVP_ZOMBIE_SPRITE_PREFIX)
        ? opt.sprite.slice(PVP_ZOMBIE_SPRITE_PREFIX.length)
        : "";
      const url = zombieKey ? zombiePortrait(zombieKey) : raidImage(opt.sprite);
      const tex = await loadTex(url);
      this.projTex.set(opt.sprite, tex);
      if (zombieKey && tex) this.planThrownZombie(opt.sprite, url, zombieKey, tex);
    }
    // The alien laser bolt. Without this it fell through to the generic "no art" hazard
    // dot — an orange circle. The art is the source's own alienLaser.plist emitter baked
    // into one sprite (5 additive ring01FX quads fading red -> yellow over 0.2 s).
    if (this.sim.units.some((u) => u.isBoss && u.sourceKey === ALIEN_BOSS_KEY)) {
      this.projTex.set(ALIEN_LASER_SPRITE, await loadTex(raidImage(`${ALIEN_LASER_SPRITE}.png`)));
    }
    // Trapeze Artist art; its layer was inserted behind the zombies above.
    if (this.grabberSprite) {
      this.grabTex = await loadTex(raidImage(this.grabberSprite));
    }
    // Beach crab art + layer (tappable while it wanders and while it hauls a zombie).
    if (this.crabSprite) {
      this.crabTex = await loadTex(raidImage(this.crabSprite));
      this.container.addChild(this.crabLayer);
    }
    // Flames ride above every unit: the fire has to be tappable through whatever rig is
    // burning, and it reads as sitting ON the zombie rather than behind it.
    this.container.addChild(this.fireLayer);
    // Added after every battlefield layer so the complete stage rectangle behaves
    // as an aperture. HUD and controls are added later and remain unobscured.
    this.container.addChild(this.stageMatte);

    // Team-bar face badges are stable team identities rather than whichever unit
    // happened to be selected: generic zombie on the left, active boss on the right.
    const bossFaceUrl = this.bossPortrait ||
      (this.raid.bossPortrait ? raidImage(this.raid.bossPortrait) : bossUrl);
    const [zFace, eFace] = await Promise.all([
      loadTex(`${BASE}assets/ui/topbar_zombie_icon.png`),
      bossFaceUrl ? loadTex(bossFaceUrl) : Promise.resolve(null),
    ]);

    this.buildTeamBars();
    this.fillFaceBadge(this.pFace, zFace, 0x8bc34a, 0.7);
    this.fillFaceBadge(this.eFace, eFace, 0xef5350);
    await this.buildAbilityStrip();
    [this.bubbleTexButterfly, this.bubbleTexBrain, this.bubbleTexHmm, this.brainTex] = await Promise.all([
      loadTex(BUBBLE_BUTTERFLY),
      loadTex(BUBBLE_BRAIN),
      loadTex(BUBBLE_HMM),
      loadTex(DROP_BRAIN),
    ]);
    this.buildBubble();
    this.layout();
  }

  private imageUrl(file: string): string {
    return this.imageBase ? `${this.imageBase}${file}` : raidImage(file);
  }

  /** The focus bubble (one, reused): the source game's thought-bubble sprite,
   *  tappable to pop the charging zombie's distraction / release it forward. Its
   *  texture is swapped each frame (butterfly vs brain vs "...") in layout(). */
  private buildBubble() {
    const s = this.bubbleSprite;
    s.anchor.set(0.5, 1); // bottom-center: the bubble's tail hangs just over the zombie
    s.scale.set(-BUBBLE_SCALE, BUBBLE_SCALE); // mirror over the vertical axis (tail to the left)
    if (this.bubbleTexButterfly) s.texture = this.bubbleTexButterfly;
    this.bubble.addChild(s);
    this.bubble.visible = false;
    this.setBubbleInteractive(false);
    this.bubble.on("pointertap", () => {
      if (this.sim.finished || this.playback) return;
      const bubble = this.sim.chargingBubble();
      if (this.bubbleUnitId && this.sim.popBubble(this.bubbleUnitId)) {
        this.recordInput({ type: "bubble", unitId: this.bubbleUnitId });
        if (bubble?.kind === "brain" && bubble.id === this.bubbleUnitId) {
          const zombie = this.sim.units.find((unit) => unit.id === this.bubbleUnitId);
          if (zombie) this.onBrainRelease?.(zombie.sourceKey);
        }
        this.bubble.scale.set(0.8); // tap feedback, eased back in layout
      }
    });
    this.container.addChild(this.bubble); // above tokens so it's tappable
  }

  /** Arm or disarm the focus bubble's tap target (and its pointer affordance).
   *  Called every frame, so it no-ops unless the state actually flips. */
  private setBubbleInteractive(on: boolean) {
    if (this.bubbleInteractive === on) return;
    this.bubbleInteractive = on;
    this.bubble.eventMode = on ? "static" : "none";
    this.bubble.cursor = on ? "pointer" : "default";
  }

  /** Build both ability strips from the army's abilities: one tappable wooden
   *  button per distinct ACTIVATED move (badge = how many zombies are ready) and
   *  one small static icon per TEAM-passive ability in play. Self-buffs aren't
   *  shown at all — the player has no decision to make about them.
   *
   *  Every activated button takes its slot in the column HERE, once, and keeps it
   *  for the whole fight. Nothing is ever removed or re-packed: a knocked-back Large
   *  used to take Smash out of the column, sliding Explode up into the space the
   *  player's thumb was already aimed at, and the next tap blew up a Small instead.
   *  A move that can't be used is darkened in place.
   *
   *  A button can, however, cover a FAMILY of moves (Explode/Explode Ver.2 — see
   *  ACTIVATED_STACKS), because five separate buttons overran the bottom of a
   *  landscape phone. Only the face changes; the slot never moves, so the thumb
   *  target the fix above protects is untouched.
   *
   *  The slot INDEX is fixed here; the pixel pitch between slots is not, because it
   *  depends on the viewport (see abilityColumnStep in layout). A slot never changes
   *  its index, and the column only re-spaces on a resize — never mid-fight from sim
   *  state — so the ordering guarantee above survives intact. */
  private async buildAbilityStrip() {
    const groups = [
      ...this.sim.activatedGroups.map((keys) => ({ keys, activated: true })),
      ...this.sim.teamKeys.map((key) => ({ keys: [key], activated: false })),
    ];
    const icons = new Map<string, Texture | null>();
    await Promise.all(
      groups.flatMap(({ keys }) => keys).map(async (key) => {
        const icon = ABILITY_POOL[key]?.icon;
        icons.set(key, icon ? await loadTex(icon) : null);
      })
    );
    let activeSlot = 0;
    for (const { keys, activated } of groups) {
      const shown = activated ? this.sim.nextInGroup(keys) : keys[0];
      const cell = this.makeAbilityCell(keys, icons.get(shown) ?? null, activated);
      const slot = activated ? activeSlot++ : -1;
      (activated ? this.activeAbilityStrip : this.passiveAbilityStrip).addChild(cell.cell);
      // Only THIS button's art, so a face swap can't reach for a move the button
      // does not cover.
      const own = new Map(keys.map((key) => [key, icons.get(key) ?? null]));
      this.abilityCells.push({ key: keys[0], ...cell, activated, icons: own, shown, slot });
      if (!activated) this.hasPassiveAbilities = true;
    }
    this.activeAbilityCount = activeSlot;
    // The column's pitch is decided in `layout`, which only re-runs its chrome pass on a
    // resize — and this build is async, so a layout can have already happened and banked
    // the current viewport. Invalidate that so the next one places these cells; without
    // it a strip built after the first layout sits piled at y = 0 until something resizes.
    this.chromeW = -1;
    this.container.addChild(this.passiveAbilityStrip, this.activeAbilityStrip);
  }

  /** Put `key`'s art on a stacked button's face, keeping the icon scaled to the cell
   *  (the two tiers' source images are not guaranteed to be the same size). */
  private setAbilityFace(c: RaidScene["abilityCells"][number], key: string) {
    if (c.shown === key || !c.icon) return;
    const tex = c.icons?.get(key);
    if (!tex) return;
    c.shown = key;
    c.icon.texture = tex;
    c.icon.scale.set((2 * ABILITY_ACTIVE_R * 0.68) / Math.max(tex.width, tex.height, 1));
  }

  /** One ability cell.
   *
   *  ACTIVATED cells are wooden buttons — the farm HUD's own plank palette, a lit
   *  bevel across the top and a dark rim — sized ABILITY_ACTIVE_R so they read as
   *  the thing you press. PASSIVE cells are half that size and keep the flat dark
   *  slot frame, so a glance separates "press me" from "you already have this". */
  private makeAbilityCell(keys: string[], tex: Texture | null, activated: boolean) {
    const R = activated ? ABILITY_ACTIVE_R : ABILITY_PASSIVE_R;
    const cell = new Container();
    cell.addChild(activated ? woodenButtonFace(R) : passiveIconFrame(R));
    let icon: Sprite | undefined;
    if (tex) {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set((2 * R * (activated ? 0.68 : 0.8)) / Math.max(tex.width, tex.height, 1));
      cell.addChild(sp);
      icon = sp;
    }
    // Count badge: ready-to-act zombies on a button, deployed carriers on a passive
    // icon. Either way it only earns its pixels past one, so layout() hides it at
    // exactly 1 — a badge on every icon is just noise.
    const dotR = activated ? 10 : 8;
    const badgeDot = new Graphics().circle(R - 4, -R + 4, dotR).fill(0xc0392b);
    const badge = new Text({
      text: "0",
      style: {
        fontFamily: "sans-serif", fontSize: activated ? 13 : 11,
        fontWeight: "800", fill: 0xffffff,
      },
    });
    badge.anchor.set(0.5);
    badge.position.set(R - 4, -R + 4);
    badgeDot.visible = false;
    badge.visible = false;
    cell.addChild(badgeDot, badge);
    if (activated) {
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () => {
        if (this.sim.finished || this.playback) return;
        // Resolved at TAP TIME, not from the drawn face: the face refreshes on a 150 ms
        // throttle, so between refreshes it can be one move stale. Asking the sim now
        // means the tap always fires the move that is actually available — and the
        // transcript records that concrete key, which is what the server replays.
        const key = this.sim.nextInGroup(keys);
        if (this.sim.activate(key)) {
          this.recordInput({ type: "ability", abilityKey: key });
          cell.scale.set(0.86); // tap feedback (eased back in layout)
        }
      });
    }
    return { cell, badge, badgeDot, icon };
  }

  /** A circular framed portrait badge for a team bar (feet-agnostic head-ish crop). */
  private fillFaceBadge(
    badge: Container,
    tex: Texture | null,
    ring: number,
    iconScale = 1,
  ) {
    const R = 23;
    badge.removeChildren();
    badge.addChild(new Graphics().circle(0, 0, R).fill(0x1c1c1c));
    if (tex) {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 0.5);
      // Leave a little more breathing room inside the badge and lower the crop so
      // the face sits naturally instead of pressing against the top rim.
      const s = ((R * 2 * 0.96) / Math.max(1, tex.width)) * iconScale;
      sp.scale.set(s);
      // Both portraits sit about one-quarter icon-height lower than the previous
      // crop, without moving their circular frames.
      sp.y = tex.height * s * 0.11;
      const mask = new Graphics().circle(0, 0, R).fill(0xffffff);
      badge.addChild(mask, sp);
      sp.mask = mask;
    }
    badge.addChild(new Graphics().circle(0, 0, R).stroke({ width: 3, color: ring, alpha: 0.95 }));
    this.container.addChild(badge);
  }

  private getRegularZombieNativeHeight(): number {
    if (this.regularZombieNativeHeight === null) {
      const reference = new RaidActor(
        this.assets, "ZombieActorRegularTier1", 0, "Regular",
      );
      this.regularZombieNativeHeight = reference.getNativeSizingHeight();
    }
    return this.regularZombieNativeHeight;
  }

  private makeToken(u: SimUnit): Token {
    const root = new Container();
    let actor: RaidActor | undefined;
    let enemyActor: EnemyActor | undefined;
    let frameActor: Token["frameActor"];
    let epicActor: AnimatedSprite | undefined;
    let epicAnim: string | undefined;
    let base = 22;
    let hpCenterX = 0;
    let topY = -60;
    let actorBaseScale = 1;
    let actorBaseY = 0;
    const ufoParts: Sprite[] = [];
    let pilotBars: Token["pilotBars"];

    // A defender zombie in a friend invasion fights on the ENEMY team but is drawn by
    // the same farm rig path as the player's own — `group` marks a player-zombie
    // taxonomy, which no authored enemy/wall/summon/turned unit carries.
    const zombieRig = u.team === "player" || (!!u.group && !!this.assets.zombieModels[u.sourceKey]);
    if (zombieRig) {
      // Real farm-style zombie rig (with the walk animation). Most families use
      // their authored raid height; Headless retains its actual farm silhouette.
      // `u.id` is the owned zombie's roster id (CombatEngine builds player units
      // from it), so the battlefield honours the same per-zombie mutation toggles
      // as its card and its farm rig. Presentation only — the sim never reads the
      // mask, and the stats it fights with already have the bonuses baked in.
      // (A defender's `d<n>` id has no local visibility prefs, so its full mask shows.)
      actor = new RaidActor(
        this.assets, u.sourceKey, visibleMutations(u.id, u.mutation), u.group, u.color,
      );
      if (u.team === "enemy") actor.setFacingFromDelta(-1); // square up to the attackers
      const b = actor.getSizingBounds();
      const heightScale = zombieRaidHeightScale(
        u.group ?? (u.isHeadless ? "Headless" : u.isGarden ? "Garden" : "Regular"),
        u.className ?? "Green",
        u.sourceKey,
        actor.getNativeSizingHeight(),
        this.getRegularZombieNativeHeight(),
      );
      const targetHeight = ZOMBIE_H * heightScale;
      const s = targetHeight / Math.max(1, b.height);
      actor.container.scale.set(s);
      actor.container.y = -(b.y + b.height) * s; // stand its feet at the origin
      root.addChild(actor.container);
      base = Math.max(14, (b.width * s) / 2);
      topY = -targetHeight;
      // Remember the base transform so the Smash grow can scale the rig about its
      // FEET (container.y scales with the same factor) without moving the HP bar.
      actorBaseScale = s;
      actorBaseY = actor.container.y;
    } else {
      const targetH = (u.isBoss ? BOSS_H : ENEMY_H) * (u.isBoss ? BOSS_H_SCALE[u.sourceKey] ?? 1 : 1);
      const initialEpicAnim = u.state === "falling" && this.bossFrames.has("fly") ? "fly" : "enter";
      epicAnim = initialEpicAnim;
      const epicFrames = u.isBoss ? this.bossFrames.get(initialEpicAnim) ?? this.bossFrames.get("idle") : undefined;
      if (epicFrames?.length) {
        const sp = new AnimatedSprite(epicFrames);
        const def = this.bossAnimationDefs?.[initialEpicAnim] ?? this.bossAnimationDefs?.idle;
        sp.anchor.set(0.5, 1);
        sp.scale.set(targetH / Math.max(1, epicFrames[0].height));
        sp.animationSpeed = def ? 1 / (60 * def.frameSeconds) : 0.2;
        sp.loop = initialEpicAnim === "fly";
        sp.play();
        root.addChild(sp);
        base = Math.max(16, epicFrames[0].width * sp.scale.x / 2);
        topY = -targetH;
        epicActor = sp;
      } else {
      const strip = this.enemyStrip.get(u.sourceKey) ?? null;
      const model = this.assets.enemyModels[u.sourceKey];
      const tex = this.enemyTex.get(u.sourceKey) ?? null;
      const frames = this.enemyFrames.get(u.sourceKey);
      if (frames?.idle.length) {
        const sp = new Sprite(frames.idle[0]);
        sp.anchor.set(0.5, 1);
        const s = targetH / Math.max(1, frames.idle[0].height);
        sp.scale.set(s);
        root.addChild(sp);
        base = Math.max(16, frames.idle[0].width * s / 2);
        topY = -targetH;
        frameActor = { sprite: sp, idle: frames.idle, attack: frames.attack, time: 0 };
      } else if (strip && model) {
        // Animated rig: assemble from the part strip and fit to the role height.
        const ea = new EnemyActor(strip, model, u.sourceKey);
        const b = ea.container.getLocalBounds();
        const s = targetH / Math.max(1, b.height);
        ea.container.scale.set(s);
        ea.container.y = -(b.y + b.height) * s; // stand its feet at the origin
        // Pull an over-wide rig forward (screen-left) so it doesn't overhang the stage's
        // right edge at the doorway hold spot. Fraction of the RENDERED width, so it
        // tracks the contain-fit stage automatically.
        const forwardX = (ENEMY_FORWARD_FX[u.sourceKey] ?? 0) * b.width * s;
        ea.container.x = -forwardX;
        root.addChild(ea.container);
        base = Math.max(16, (b.width * s) / 2);
        // Enemy rig parts are authored in positive model-space coordinates. Their
        // feet/sim origin remains at x=0, so center the HP bar on the rendered rig
        // bounds rather than on that origin (which put nearly every bar to the left).
        hpCenterX = (b.x + b.width / 2) * s - forwardX;
        topY = -(b.height * s);
        enemyActor = ea;
        const tint = alienTintFor(u.sourceKey, u.id);
        if (tint !== null) ea.applyTint(tint);
      } else if (tex) {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1); // feet at the origin
        const s = targetH / Math.max(1, tex.height);
        sp.scale.set(s); // composites already face LEFT toward the zombies — no mirror
        root.addChild(sp);
        base = Math.max(16, (tex.width * s) / 2);
        topY = -targetH;
      } else {
        // Fallback: the old portrait circle token.
        const R = u.isBoss ? 34 : 22;
        const color = u.isBoss ? BOSS_COLOR : ENEMY_COLOR;
        const t = this.texByUnit.get(u.id) ?? null;
        root.addChild(new Graphics().circle(0, 0, R).fill(t ? 0x161616 : color));
        if (t) {
          const body = new Sprite(t);
          body.anchor.set(0.5);
          body.scale.set((R * 2 * 1.06) / Math.max(t.width, t.height, 1));
          const mask = new Graphics().circle(0, 0, R).fill(0xffffff);
          root.addChild(mask, body);
          body.mask = mask;
        }
        root.addChild(new Graphics().circle(0, 0, R).stroke({ width: 3, color, alpha: 0.95 }));
        base = R;
        topY = -(R + 9);
      }
      }
    }

    // Alien boss rides a UFO: the small back dome BEHIND the pilot, the saucer + glass
    // dome IN FRONT (its transparent centre shows the alien through the canopy). Laid out
    // straight from the rig — see the UFO_* constants for the disassembly this comes from.
    if (this.ufoFrontTex && u.isBoss && u.sourceKey === ALIEN_BOSS_KEY && enemyActor) {
      // The SAUCER is the boss's silhouette, so it — not the pilot — is what gets fitted
      // to the boss height. Everything else follows at its authored ratio.
      const targetH = BOSS_H * (BOSS_H_SCALE[u.sourceKey] ?? 1);
      const k = targetH / UFO_GROUP_H;
      const ps = UFO_PILOT_SCALE * k; // the rig is authored at 1.0 px, drawn at 0.58

      const b = enemyActor.container.getLocalBounds();
      enemyActor.container.scale.set(ps);
      // Seat the pilot's art box where the rig puts it relative to the boss's feet,
      // rather than bottom-aligning it to the token origin (its feet parts hang below).
      enemyActor.container.x = UFO_PILOT_BOX.left * k - b.x * ps;
      enemyActor.container.y = UFO_PILOT_BOX.bottom * k - (b.y + b.height) * ps;

      if (this.ufoBackTex) {
        const back = new Sprite(this.ufoBackTex);
        back.anchor.set(UFO_BACK_ANCHOR.x, 1 - UFO_BACK_ANCHOR.y); // cocos y-up -> pixi y-down
        back.scale.set(k);
        back.position.set(0, UFO_ANCHOR_DY * k);
        root.addChildAt(back, 0); // zOrder - 1: behind the pilot rig
        ufoParts.push(back);
      }
      const front = new Sprite(this.ufoFrontTex);
      front.anchor.set(UFO_FRONT_ANCHOR.x, 1 - UFO_FRONT_ANCHOR.y);
      front.scale.set(k);
      front.position.set(0, UFO_ANCHOR_DY * k);
      root.addChild(front); // zOrder + 1: in front of the pilot, below the bars added next
      ufoParts.push(front);

      // Bars and hit-width now belong to the saucer, not the pilot inside it.
      base = (UFO_GROUP_W * k) / 2;
      hpCenterX = (UFO_SHIP_BOX.left + UFO_GROUP_W / 2) * k;
      topY = UFO_SHIP_BOX.top * k;
      // …until he lands and the saucer is destroyed, at which point the silhouette is the
      // 0.58 pilot alone and the bars have to shrink onto him. Derived from the same rig
      // box the seating above uses: its left edge and top are the authored UFO_PILOT_BOX
      // (times the fit factor), and its width is the rig's own, drawn at the pilot scale.
      pilotBars = {
        base: (b.width * ps) / 2,
        hpCenterX: UFO_PILOT_BOX.left * k + (b.width * ps) / 2,
        topY: UFO_PILOT_BOX.top * k,
      };
    }

    // Weapon reach should not dictate health-bar width. Enemy bars use compact,
    // role-based caps while player bars retain their body-relative sizing.
    if (u.team === "enemy") base = Math.min(base, u.isBoss ? 55 : 42);
    // Health bar sits ABOVE the head (enemies red, players green — set in layout).
    const hp = new Graphics();
    hp.x = hpCenterX;
    hp.y = topY - 8;
    root.addChild(hp);

    // …and its number sits just above it, when the player asked for one. Bottom-centre
    // anchored so it grows upward off the bar rather than over the unit's head.
    let hpText: Text | undefined;
    if (this.showHealthNumbers) {
      hpText = new Text({
        text: "",
        style: {
          fill: 0xffffff, fontSize: 12, fontWeight: "bold",
          stroke: { color: 0x14181f, width: 3 },
        },
      });
      hpText.anchor.set(0.5, 1);
      hpText.position.set(hpCenterX, topY - 10);
      hpText.visible = false;
      root.addChild(hpText);
    }

    // Focus/charge bar sits below the feet; only shown while a zombie charges.
    const charge = new Graphics();
    charge.y = 8;
    root.addChild(charge);

    // A boss on a perch structure renders BEHIND it (legs occluded by the roof);
    // everyone else, including a boss with no structure (sky-perch UFO), is in front.
    const layer = u.isBoss && this.perchLayer ? this.bossBackLayer : this.tokenLayer;
    layer.addChild(root);
    // Player tokens are visual only: focus/ability input lives in the separate
    // bubble and HUD controls. Keeping zombies out of pointer hit-testing lets the
    // visually lower Circus trapeze remain tappable even behind a Large zombie.
    if (u.team === "player") root.eventMode = "none";
    // A summoned wall (carrotWall / junkWall) is tappable to chip it (ZFFightWall touch),
    // in addition to the zombies attacking it. The wall is a fully simulated enemy, so —
    // unlike the client-only trapeze and crab — every tap MUST be transcribed or the
    // verifier keeps fighting a wall the player already knocked down.
    if (u.isWall) {
      root.eventMode = "static";
      root.cursor = "pointer";
      root.on("pointertap", () => {
        if (this.sim.finished || this.playback || !this.canRecordHazardTap()) return;
        if (this.sim.tapWall(u.id)) this.recordInput({ type: "wallTap", unitId: u.id });
      });
    }
    // A converted PIXEL ZOMBIE is the other fully-simulated tap target. Its body is a
    // million hit points — the army cannot chew through it, and it is not meant to; the
    // taps are how you break it open and get your zombie back. Transcribed for the same
    // reason the wall's taps are.
    if (u.isTurned) {
      root.eventMode = "static";
      root.cursor = "pointer";
      root.on("pointertap", () => {
        if (this.sim.finished || this.playback || !this.canRecordHazardTap()) return;
        if (this.sim.tapTurned(u.id)) this.recordInput({ type: "turnedTap", unitId: u.id });
      });
    }
    return {
      root, actor, enemyActor, frameActor, epicActor, epicAnim: epicActor ? epicAnim : undefined,
      ufoParts: ufoParts.length ? ufoParts : undefined,
      pilotBars,
      hp, hpText, charge, base, hpCenterX, topY, atkCount: 0,
      deathAnim: -1, emerged: false, hpKey: -1, chargeKey: -1,
      smashSlam: -1, wasSmashWindup: 0, actorBaseScale, actorBaseY,
      healFxSeq: 0, healCastSeq: 0, healPose: 0, laserFxSeq: 0,
      explodeFxSeq: 0, fuseT: 0,
    };
  }

  /** Seconds a dying token stays fully opaque before the death fade starts — the
   *  authored defeat strip's own run time for an Epic Boss, 0 for everyone else. */
  private epicDefeatHoldSecs(tok: Token): number {
    const def = tok.epicActor ? this.bossAnimationDefs?.defeat : undefined;
    return def ? def.frameCount * def.frameSeconds : 0;
  }

  private playEpic(sprite: AnimatedSprite, name: string, loop: boolean): void {
    const frames = this.bossFrames.get(name);
    const def = this.bossAnimationDefs?.[name];
    if (!frames?.length || !def) return;
    sprite.textures = frames;
    sprite.animationSpeed = 1 / (60 * def.frameSeconds);
    sprite.loop = loop;
    sprite.gotoAndPlay(0);
  }

  private buildTeamBars() {
    // Added after the battlefield layers but before every top-HUD child, keeping it
    // behind the bars, portraits, counts, timer, retreat button, and abilities.
    this.container.addChild(this.topHudBack);
    const mk = (fill: Graphics) => {
      const wrap = new Container();
      const bar = new Graphics();
      wrap.addChild(bar, fill);
      const label = new Text({
        text: "",
        style: { fontFamily: "sans-serif", fontSize: 16, fontWeight: "700", fill: 0xffffff },
      });
      label.y = 21;
      wrap.addChild(label);
      this.container.addChild(wrap);
      return { wrap, bar, label };
    };
    const p = mk(this.pFill);
    const e = mk(this.eFill);
    this.pLabel = p.label;
    this.eLabel = e.label;
    this.pWrap = p.wrap;
    this.eWrap = e.wrap;
    this.pBar = p.bar;
    this.eBar = e.bar;
    // Round countdown (top-center) → turns red "ENRAGED" when the boss enrages.
    this.roundLabel = new Text({
      text: "",
      style: { fontFamily: "sans-serif", fontSize: 18, fontWeight: "800", fill: 0xffffff },
    });
    this.roundLabel.anchor.set(0.5, 0);
    this.container.addChild(this.roundLabel);
    this.buildRetreatButton();
  }

  /** A "Retreat" button (bottom-right) that ends the raid as a
   *  loss — the army flees, so no rewards and no veterancy credit.
   *  In playback it is "End Replay": close the viewer, nothing to concede. */
  private buildRetreatButton() {
    const label = new Text({
      text: this.playback ? "✕ End Replay" : "⚑ Retreat",
      style: { fontFamily: "sans-serif", fontSize: 14, fontWeight: "700", fill: 0xffffff },
    });
    label.position.set(12, 6);
    const bg = new Graphics()
      .roundRect(0, 0, label.width + 24, label.height + 12, 6)
      .fill({ color: this.playback ? 0x3a4a63 : 0x8c2a2a, alpha: 0.92 })
      .stroke({ width: 2, color: this.playback ? 0x141d2c : 0x3a0d0d });
    this.retreatBtn.addChild(bg, label);
    this.retreatBtn.eventMode = "static";
    this.retreatBtn.cursor = "pointer";
    this.retreatBtn.on("pointertap", async () => {
      if (this.playback) {
        // The viewer bails out of the recording; the outcome was settled long ago.
        if (this.resultFired) return;
        this.resultFired = true;
        this.onFinish({ ...this.sim.outcome(), win: false, survivors: [] }, this.simTick, []);
        return;
      }
      if (this.retreatRequested || this.resultFired || this.sim.finished) return;
      if (!await this.confirmRetreat()) return;
      if (this.retreatRequested || this.resultFired || this.sim.finished) return;
      this.recordInput({ type: "retreat" });
      this.retreatRequested = true; // handled on the next update (safe phase change)
    });
    this.container.addChild(this.retreatBtn);
  }
  private pWrap!: Container;
  private eWrap!: Container;
  private pBar!: Graphics;
  private eBar!: Graphics;

  // The contain-fit stage rectangle (the 480x320 design space) + ground line,
  // recomputed live so the sim→screen mapping and unit placement track resizes.
  // Memoised on the screen size: mapX/mapY/sizeScale call this several times per
  // unit per frame, and a fresh object each call is pure GC pressure.
  // Last viewport the resize-only chrome (stage layers, letterboxes, HUD backing)
  // was drawn for; layout() skips those redraws while the size is unchanged.
  private chromeW = -1;
  private chromeH = -1;
  private chromeSafeKey = "";
  // Countdown to the next ability-strip content recompute (ms); see layout().
  private abilityRefreshMs = 0;
  private bgRectCache: {
    W: number; H: number;
    r: { left: number; top: number; w: number; h: number; scale: number; groundY: number };
  } | null = null;
  private bgRect() {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const c = this.bgRectCache;
    if (c && c.W === W && c.H === H) return c.r;
    const scale = Math.min(W / DESIGN_W, H / DESIGN_H); // CONTAIN — whole scene visible
    const w = DESIGN_W * scale;
    const h = DESIGN_H * scale;
    const left = (W - w) / 2;
    const top = (H - h) / 2;
    const r = { left, top, w, h, scale, groundY: top + GROUND_FY * h };
    this.bgRectCache = { W, H, r };
    return r;
  }

  // Stand the boss on top of the tallest RIGHT-SIDE structure (barn/silo/front
  // building/circus car) — the piece enemies emerge from. Raids without one (Aliens,
  // Beach, Tree World) keep the default up-right sky perch, so their boss hovers
  // (the Alien "UFO" reads as floating). Perch is stored as a fraction of the stage
  // rect so it survives resizes.
  private computePerch() {
    let best: { sp: Sprite; asset: RaidLevelAsset } | null = null;
    for (const layer of this.stageLayers) {
      const [ax] = parseVec(layer.asset.anchor);
      if (ax >= 0.9 && layer.asset.z >= 3 && (!best || layer.asset.z > best.asset.z)) {
        best = layer;
      }
    }
    if (!best) {
      this.applyPerchTweak(); // sky-perch raids still take their per-raid nudge
      return;
    }
    this.perchLayer = best; // this layer gets drawn in front of the boss (leg occlusion)
    const [ax, ay] = parseVec(best.asset.anchor);
    const [px, py] = parseVec(best.asset.position);
    const tw = best.sp.texture.width;
    const th = best.sp.texture.height;
    // Perch LEFT-of-centre on the structure. Structures are right-edge anchored, so a
    // big boss centred on the structure hangs off the screen's right edge; biasing it
    // toward the structure's left keeps it on-screen and over the building (not the
    // silo tip). tw*0.5 = centre; tw*PERCH_BIAS_FX pulls it left.
    const centerX = px - ax * tw + tw * PERCH_BIAS_FX;
    // Sink the perch BELOW the structure's top edge so the boss stands down behind
    // the roof (its legs hidden by the structure it renders behind), not floating on
    // the peak. topY is the top edge (design y, Y-up); subtract to move the feet down.
    const topY = py + (1 - ay) * th - PERCH_SINK_F * th;
    this.perchFX = centerX / DESIGN_W;
    this.perchFY = (DESIGN_H - topY) / DESIGN_H; // screen fraction from the top
    this.applyPerchTweak();
  }

  /** Nudge the computed perch by this raid's per-raid tuning override (if any). */
  private applyPerchTweak() {
    const tw = PERCH_TWEAK[this.raid.id];
    if (!tw) return;
    this.perchFX += tw.dx ?? 0;
    this.perchFY += tw.dy ?? 0;
  }

  // Sim→screen mapping, anchored to the background rect + its ground line.
  private mapX(sx: number): number {
    const r = this.bgRect();
    const mx = r.w * FIELD_INSET_FX;
    return r.left + mx + (sx / FIELD_W) * (r.w - 2 * mx);
  }
  /** How much to scale unit-space sizes/offsets so they track the contain-fit stage
   *  (1 at SIZE_REF_SCALE). Everything measured in "unit px" — heights, ground nudges,
   *  poof offsets — multiplies by this so it grows/shrinks with the window. */
  private sizeScale(): number {
    return this.bgRect().scale / SIZE_REF_SCALE;
  }
  private mapY(sy: number): number {
    const r = this.bgRect();
    // Shallow vertical band around the ground line (rows give a little depth).
    return r.groundY + GROUND_NUDGE * this.sizeScale() + (sy - CENTER_Y) * (r.h * 0.00028);
  }
  /** Vertical mapping for boss projectiles: unlike mapY's shallow ground band,
   *  this spans the full drop so a throw leaves the boss's perch and lands at the
   *  ground line (the boss is rendered up on the silo, out of mapY's range). */
  private mapProjY(sy: number): number {
    const r = this.bgRect();
    const perchY = r.top + this.perchFY * r.h;
    const groundLineY = r.groundY + (GROUND_NUDGE + UNIT_GROUND_NUDGE) * this.sizeScale();
    const t = (sy - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y);
    return perchY + t * (groundLineY - perchY);
  }
  /** Horizontal sim→screen scale, for sizing projectiles in field units. */
  private scaleX(): number {
    const r = this.bgRect();
    return (r.w * (1 - 2 * FIELD_INSET_FX)) / FIELD_W;
  }

  /** Recompute all screen positions from the current viewport + sim state.
   *  `dtSec` drives the zombie walk animation (0 for a static re-layout). */
  private layout(dtSec = 0) {
    this.hoverClock += dtSec;
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const r = this.bgRect();
    const safeArea = readSafeAreaInsets();
    const hudLayout = computeRaidHudLayout(W, H, safeArea, isMobile());
    const safeKey = `${safeArea.top},${safeArea.right},${safeArea.bottom},${safeArea.left},${hudLayout.hidePortraits}`;
    // Everything that depends only on the viewport (stage layers, letterbox fills,
    // HUD chrome) is drawn once per resize, not per frame: each Graphics.clear()
    // re-tessellates and re-uploads geometry, which mobile GPUs pay dearly for.
    const resized = W !== this.chromeW || H !== this.chromeH || safeKey !== this.chromeSafeKey;
    this.chromeW = W;
    this.chromeH = H;
    this.chromeSafeKey = safeKey;

    if (resized) {
    // Position every stage layer in the 480x320 design space (cocos2d Y-up anchors),
    // contain-fit into the viewport, so the whole scene (backgrounds + structure)
    // stays visible. Fill the letterbox with sky above the ground line, grass below.
    for (const { sp, asset } of this.stageLayers) {
      const [ax, ay] = parseVec(asset.anchor);
      const [px, py] = parseVec(asset.position);
      sp.anchor.set(ax, 1 - ay); // cocos Y-up anchor → Pixi Y-down
      sp.scale.set(r.scale);
      sp.position.set(r.left + px * r.scale, r.top + (DESIGN_H - py) * r.scale);
    }
    this.backdrop
      .clear()
      .rect(0, 0, W, r.groundY).fill(LETTERBOX_TOP)
      .rect(0, r.groundY, W, Math.max(0, H - r.groundY)).fill(LETTERBOX_BOT);
    // Repeat the backdrop colors in front of the battlefield layers. This makes all
    // four letterbox areas behave as an aperture: moving characters, hazards, and
    // projectiles cannot leak outside the authored stage image.
    const right = r.left + r.w;
    const bottom = r.top + r.h;
    this.stageMatte.clear();
    if (r.left > 0) {
      this.stageMatte
        .rect(0, 0, r.left, r.groundY).fill(LETTERBOX_TOP)
        .rect(0, r.groundY, r.left, Math.max(0, H - r.groundY)).fill(LETTERBOX_BOT);
    }
    if (right < W) {
      this.stageMatte
        .rect(right, 0, W - right, r.groundY).fill(LETTERBOX_TOP)
        .rect(right, r.groundY, W - right, Math.max(0, H - r.groundY)).fill(LETTERBOX_BOT);
    }
    if (r.top > 0) this.stageMatte.rect(r.left, 0, r.w, r.top).fill(LETTERBOX_TOP);
    if (bottom < H) this.stageMatte.rect(r.left, bottom, r.w, H - bottom).fill(LETTERBOX_BOT);
    }

    const toX = (sx: number) => this.mapX(sx);
    const toY = (sy: number) => this.mapY(sy);
    const renderPos = (u: SimUnit) => this.phase === "fight"
      ? interpolatePosition(
          { x: u.prevX, y: u.prevY },
          { x: u.x, y: u.y },
          this.simAccumulatorMs,
          RAID_TICK_MS,
          TELEPORT_PX
        )
      : { x: u.x, y: u.y };
    const visualLeadMs = this.phase === "fight" ? Math.min(this.simAccumulatorMs, RAID_TICK_MS) : 0;
    // Boss perch on the structure (computed), and its descent lerp back to the ground.
    const perchX = r.left + this.perchFX * r.w;
    const perchY = r.top + this.perchFY * r.h;
    const bossPos = (u: SimUnit, x: number, y: number): [number, number] => {
      // Perched: on the structure. Descending: slide right off-screen at perch height
      // (behind the structure — reads as exiting through the entrance). Emerging/hold/
      // fight: a normal ground unit, walking in from the right to the attack spot.
      if (u.state === "structure") return [perchX, perchY];
      if (u.state === "descending") {
        if (u.sourceKey === CIRCUS_BOSS_KEY) {
          const t = Math.max(0, Math.min(1, (y - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y)));
          const groundX = toX(ENEMY_HOLD_X) + this.bossGroundOffset.x * this.sizeScale();
          const groundY = toY(CENTER_Y) +
            (UNIT_GROUND_NUDGE + this.bossGroundOffset.y) * this.sizeScale();
          // A small upward arc makes the direct descent read as a jump rather than
          // a linear float. The simulation supplies the deterministic progress.
          return [
            perchX + (groundX - perchX) * t,
            perchY + (groundY - perchY) * t - Math.sin(Math.PI * t) * 30 * this.sizeScale(),
          ];
        }
        const t = Math.max(0, Math.min(1, (x - BOSS_STRUCT_X) / (ENEMY_SPAWN_X - BOSS_STRUCT_X)));
        return [perchX + t * (r.left + r.w + 140 - perchX), perchY];
      }
      return [toX(x), toY(y)];
    };

    // Both team bars read against live sums the sim owns — never against a total
    // captured at construction, which drifts from the units it claims to measure as
    // team auras come and go (see BattleSim.teamTotals).
    const totals = this.sim.teamTotals();
    for (const u of this.sim.units) {
      // Units spawned mid-fight (summoned minions, walls) get their token on first
      // sight — the renderer only holds tokens for the initial roster otherwise.
      let tok = this.tokens.get(u.id);
      if (!tok) {
        tok = this.makeToken(u);
        this.tokens.set(u.id, tok);
      }

      // Queued enemies haven't emerged yet — keep them hidden off the field.
      if (u.state === "queued") {
        tok.root.visible = false;
        continue;
      }
      // A finished corpse is pure cost: Pixi does not cull on alpha, so an
      // alpha-0 rig (15–25 sprites) would keep being posed, transformed and
      // batched for the rest of the fight. Once the death fade has played out,
      // hide the token and skip all of its per-frame work for good.
      if (!u.alive && tok.deathAnim >= DEATH_FADE) {
        if (tok.root.visible) {
          tok.root.visible = false;
          tok.hp.clear();
          if (tok.hpText) tok.hpText.visible = false;
          tok.charge.clear();
          tok.hpKey = -1;
          tok.chargeKey = -1;
        }
        continue;
      }
      tok.root.visible = true;

      // The sim drops a generic boss from perch height to ground height on the same
      // tick that its state becomes "emerging". ENEMY_SPAWN_X fully hides normal
      // enemies, but not the much wider bosses, which used to flash down in front of
      // the zombies for one render interval. Finish that wrap at the elevated,
      // explicitly offstage exit point; the following tick begins the ground walk-in.
      const bossWrappingOffstage = u.isBoss && u.sourceKey !== CIRCUS_BOSS_KEY &&
        isOffstageBossReentryFrame(u.state, u.prevY, u.y, BOSS_STRUCT_Y);

      // Boss layering: perched or exiting right, it renders BEHIND the structure
      // (legs/exit occluded by the roof); once it re-enters as a ground unit it's a
      // normal front-layer token that walks in front of the building.
      if (u.isBoss && this.perchLayer) {
        const wantLayer =
          u.state === "structure" ||
          (u.state === "descending" && u.sourceKey !== CIRCUS_BOSS_KEY) ||
          bossWrappingOffstage
            ? this.bossBackLayer
            : this.tokenLayer;
        if (tok.root.parent !== wantLayer) wantLayer.addChild(tok.root);
      }

      // Units track the stage size: their whole token (rig + bars) is scaled by szs,
      // so a smaller window shrinks them with the background instead of leaving them
      // fixed-pixel giants. szs also scales unit-space offsets (drop, poof, settle).
      const szs = this.sizeScale();
      const groundDrop = UNIT_GROUND_NUDGE * szs;
      const pos = renderPos(u);
      let [sx, sy] = u.isBoss ? bossPos(u, pos.x, pos.y) : [toX(pos.x), toY(pos.y) + groundDrop];
      if (u.team === "player") {
        const stagingOffsetPx = r.w * PLAYER_STAGING_NUDGE_FX;
        const stagingOffsetSim = stagingOffsetPx / this.scaleX();
        sx -= playerStagingOffset(u.state, pos.x, CHARGE_X, stagingOffsetSim) * this.scaleX();
      }
      if (bossWrappingOffstage) {
        sx = r.left + r.w + 140;
        sy = perchY;
      }
      // Mr. Whiskers' authored origin leaves his rig up/back from the intended perch.
      // Offset from the current position by proportions of the rendered actor itself.
      if (u.sourceKey === NINJA_BOSS_KEY &&
          (u.state === "structure" || u.state === "descending") && tok.enemyActor) {
        sx -= tok.enemyActor.container.width * 0.3 * szs;
        sy += Math.max(0, -tok.topY) * 0.5 * szs;
      }
      // An abducted human is placed by where it is DRAWN, not by its rig origin. Every
      // other enemy holds at the doorway in a mass, where left-edge anchoring reads fine;
      // a summon stands alone mid-field on a mark it is meant to be centred on, so shift
      // it left by its own half-width. `hpCenterX` is exactly that offset (the actor's
      // visual centre in token-local space), so this works for all five abductees rather
      // than only the widest. TOKEN-LOCAL is the trap: the token root is scaled by `szs`,
      // so the offset has to be scaled with it — unscaled, it lands the abductee on the
      // mark at szs 1 and drags it further left the smaller the stage gets (on a narrow
      // portrait viewport it ended up in the zombies' waiting crowd). See
      // BattleSim.SUMMON_SPAWN_X.
      if (u.isSummon) sx -= tok.hpCenterX * szs;
      // Perched/exiting bosses use their structure baseline; after re-entering the
      // lane they stand on the same lowered ground baseline as every other unit.
      if (u.isBoss && u.state !== "structure" && u.state !== "descending") {
        sx += this.bossGroundOffset.x * szs;
        sy += groundDrop + this.bossGroundOffset.y * szs;
        // …and the alien boss loses its saucer at exactly that moment. `bossUpdate:`
        // removes both halves and nils the ivars on state 9 — the landed state — so this
        // is one-way: the UFO never comes back for the rest of the fight.
        if (tok.ufoParts) {
          for (const part of tok.ufoParts) part.destroy();
          tok.ufoParts = undefined;
          if (tok.pilotBars) {
            tok.base = Math.min(tok.pilotBars.base, 55); // same enemy-bar cap as makeToken
            tok.hpCenterX = tok.pilotBars.hpCenterX;
            tok.topY = tok.pilotBars.topY;
            tok.hp.x = tok.hpCenterX;
            tok.hp.y = tok.topY - 8;
            tok.hpText?.position.set(tok.hpCenterX, tok.topY - 10);
            tok.hpKey = -1; // force the bar to redraw at its new width
          }
        }
      }
      // Epic Bosses leave through the same sky edge they entered from. This is
      // presentation-only: the deterministic fight has already ended, while the
      // authored escape strip plays during the upward launch.
      const bossLeaving = this.bossFallsFromSky && u.isBoss && u.alive &&
        (this.sim.escaped || this.phase === "retreat");
      if (bossLeaving) {
        const t = Math.min(1, this.bossExitMs / EPIC_BOSS_EXIT_MS);
        sy -= t * t * (this.app.screen.height + 400);
      }
      // Mini Buddy jumps from its waiting spot onto the Large zombie, then rides
      // near the carrier's shoulder until the pair reaches the frontline.
      if (u.state === "carried" && u.buddyCarrierId) {
        const carrier = this.sim.units.find((p) => p.id === u.buddyCarrierId);
        const carrierTok = carrier ? this.tokens.get(carrier.id) : undefined;
        if (carrier && carrierTok) {
          const carrierPos = renderPos(carrier);
          const tx = toX(carrierPos.x) - 8 * szs;
          const ty = toY(carrierPos.y) + UNIT_GROUND_NUDGE * szs + carrierTok.topY * 0.58 * szs;
          const mountMs = visualCountdown(u.buddyMountMs, visualLeadMs, RAID_TICK_MS);
          const t = Math.max(0, Math.min(1, 1 - mountMs / 500));
          sx += (tx - sx) * t;
          sy += (ty - sy) * t - Math.sin(Math.PI * t) * 30 * szs;
        }
      }
      // Seized by the Trapeze Artist: ride at the trapeze's screen position, rising with
      // it (mapProjY spans the full lift, unlike mapY's shallow ground band).
      if (u.state === "grabbed") {
        const g = this.sim.grabbers.find((gr) => gr.grabbedId === u.id);
        if (g) {
          sx = this.mapX(g.x);
          sy = this.mapProjY(u.y);
        }
        // Held by a Beach crab: pinned at the crab's spot on the ground line, riding
        // along once it starts hauling.
        const c = this.sim.crabs.find((cr) => cr.grabbedId === u.id);
        if (c) {
          sx = this.mapX(c.x);
          sy = this.mapY(c.y) + UNIT_GROUND_NUDGE * this.sizeScale();
        }
      }
      // The alien saucer HOVERS: `startAnim:` state 0 loops two 0.5 s CCMoveTos on the
      // body attachment between (0,-10) and (0,+10), and `movementUpdate:` carries both
      // ship halves along with it, so the whole boss rides the bob. A triangle wave
      // reproduces the linear CCMoveTo pair rather than easing it like a sine would.
      //
      // It is the SHIP that hovers, not the alien. `-[AlienStageActor startAnim:interrupt:]`
      // (0xc7b1e) guards the whole CCSequence on
      // `[self isKindOfClass:[AlienStageActorBoss class]] && [self bossShipFront] != nil`,
      // and `bossUpdate:` nils `bossShipFront` when he lands — so the moment the saucer is
      // dropped the bob stops and he stands on the ground like any other enemy.
      if (u.isBoss && u.alive && u.sourceKey === ALIEN_BOSS_KEY && tok.ufoParts) {
        const phase = (this.hoverClock / (2 * UFO_HOVER_HALF_PERIOD_SEC)) % 1;
        sy += (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) * UFO_HOVER_PX * szs;
      }
      // Carried off the field by a crab — gone from this fight (it comes home after).
      tok.root.visible = !u.taken;
      tok.root.position.set(sx, sy);
      // Depth-sort in 4-px bands, and only write zIndex when the band changes:
      // every write marks the whole render group structurally dirty, forcing Pixi
      // v8 to rebuild its cached instruction set (its main win over v7). A raw
      // interpolated sy would do that on every frame for every moving unit.
      const depth = u.isBoss ? 100000 : u.state === "grabbed" ? 90000 : u.alive ? Math.round(sy / 4) : 0;
      if (tok.root.zIndex !== depth) tok.root.zIndex = depth;

      // Track the perched boss's throwing hand so projectiles leave from it (his upper
      // body), not the raw sim origin mapped independently (which read down-left of him).
      if (u.isBoss && u.state === "structure") {
        this.bossHandX = sx + BOSS_HAND_DX * szs;
        this.bossHandY = sy + tok.topY * BOSS_HAND_FY * szs;
      }

      // Spawn puff the first time a unit reaches the field mid-fight (queued enemies
      // emerging, summoned minions) — the intro roster slides in and doesn't puff.
      if (!tok.emerged) {
        tok.emerged = true;
        if (this.phase !== "intro" && u.alive) this.spawnPoof(sx, sy + tok.topY * 0.5 * szs, 0xe6d6b0);
        // An abducted human does not walk on — it is beamed down mid-field, so it
        // arrives inside the pillar (`summonBoss:` builds both, plus its own particle).
        if (u.isSummon && u.alive) {
          this.spawnLightPillar(sx + tok.hpCenterX * szs);
          this.onStrike?.({ team: "enemy", sfxFile: "resurrect.mp3" });
        }
      }

      if (u.alive) {
        // Back on its feet: a Garden holder's Resurrect is the one way a unit leaves
        // the dead branch, and the death presentation has to be handed back with it.
        // Without this the rig stayed in its head-pop pose for the rest of the fight
        // (a revived zombie stood up headless), and a second death played no poof
        // because `deathAnim` never returned to its "not dying" value.
        if (tok.deathAnim >= 0) {
          tok.deathAnim = -1;
          tok.actor?.markAlive();
          // …and the pillar the source raises over the revived zombie. This edge IS the
          // revival (only Resurrect brings a unit back out of the dead branch), so no
          // separate sim signal is needed for it.
          this.spawnLightPillar(sx + tok.hpCenterX * szs);
          this.onStrike?.({ team: "player", sfxFile: "resurrect.mp3" });
        }
        // Every unit holds a stable size. Enemies used to swell 16% on each swing, but
        // the rigs already lunge into their attacks and the impact dust already marks
        // the hit, so the extra breathing only made them read as rubbery. Smash still
        // scales the actor rig itself below — that one IS the move.
        // A wall shrinks as it's whittled down (ground truth ZFFightWall.damage: setScale),
        // to a 0.5 floor at 0 HP — a clear "keep hitting it" cue.
        const wallShrink = u.isWall ? 0.5 + 0.5 * Math.max(0, u.hp / u.maxHp) : 1;
        tok.root.scale.set(szs * wallShrink);
        tok.root.alpha = 1;
      } else {
        // On death: puff a dust cloud once, then fade + settle out over DEATH_FADE
        // (was a lingering 18%-alpha ghost).
        if (tok.deathAnim < 0) {
          tok.deathAnim = 0;
          const midY = sy + tok.topY * 0.5 * szs;
          if (u.team === "enemy" && this.smokeCfg) {
            // Enemy death: the source game's own poof — CivilianActorFight
            // playDeathEffect fetches the "smoke" particle (swirlCloudFX) at the
            // actor's position, so a slain enemy vanishes in a rising smoke burst.
            this.particles.burst(this.smokeCfg, sx, midY, 1);
          } else {
            // Zombie death (or if the smoke config failed to load): the dust puff.
            this.spawnPoof(sx, midY, u.team === "player" ? 0xbfe39a : 0xe6d6b0);
          }
          tok.actor?.markDead(); // zombie: pop the head off, tumbling backward
        }
        tok.deathAnim += dtSec;
        // An Epic Boss holds full opacity until its authored defeat strip has played
        // out, THEN fades. Skunkarella's runs 1.2 s against a 0.45 s fade, so without
        // the hold the boss was transparent for most of its own death animation.
        const k = Math.min(
          1, Math.max(0, (tok.deathAnim - this.epicDefeatHoldSecs(tok)) / DEATH_FADE)
        );
        tok.root.scale.set((1 - 0.28 * k) * szs);
        tok.root.alpha = 1 - k;
        tok.root.y = sy + k * 7 * szs; // slight settle downward
      }

      // Self-destruct: the blast is centred on the zombie's body, not its feet, so the
      // fireball swallows it. Fires on the tick the sim killed it, before the death
      // fade has moved the token anywhere.
      if (u.explodeFxSeq > tok.explodeFxSeq) {
        tok.explodeFxSeq = u.explodeFxSeq;
        this.spawnExplosion(sx, sy + tok.topY * 0.5 * szs);
      }
      if (u.healFxSeq > tok.healFxSeq) {
        tok.healFxSeq = u.healFxSeq;
        if (this.healCfg) this.particles.burst(this.healCfg, sx, sy + tok.topY * 0.45 * szs, 0.55);
      }
      if (u.healCastSeq > tok.healCastSeq) {
        tok.healCastSeq = u.healCastSeq;
        tok.healPose = HEAL_POSE_S;
      }
      if (u.laserFxSeq > tok.laserFxSeq) {
        tok.laserFxSeq = u.laserFxSeq;
        if (u.laserTargetId && this.tokens.has(u.laserTargetId)) this.armZombieBeam(u);
      }
      if (tok.healPose > 0) tok.healPose = Math.max(0, tok.healPose - dtSec);

      // Zombie rig: play the walk animation whenever it's actually moving, and
      // turn to face the way it's pacing (so waiting zombies mill back and forth).
      const visualWindupMs = visualCountdown(u.windupMs, visualLeadMs, RAID_TICK_MS);
      const visualAttackMs = visualCountdown(u.timerMs, visualLeadMs, RAID_TICK_MS);
      const windup = u.windupKey ? 1 - visualWindupMs / Math.max(1, u.windupTotal) : 0;
      // Fuse: while an Explode charge runs down, throw off sparks on a cadence that
      // tightens as it fills — the zombie is visibly building to something, rather than
      // just standing there with its arms up not attacking.
      if (u.alive && ACTIVATED_ABILITY[u.windupKey ?? ""]?.suicide) {
        tok.fuseT += dtSec;
        if (tok.fuseT >= FUSE_SPARK_S * (1 - 0.55 * Math.max(0, Math.min(1, windup)))) {
          tok.fuseT = 0;
          this.particles.burst(FUSE_SPARKS, sx, sy + tok.topY * 0.85 * szs, 1);
        }
      } else if (tok.fuseT !== 0) {
        tok.fuseT = 0;
      }
      // The simulation advances at a fixed 50 ms cadence while rendering can run
      // faster. Use the velocity retained by the last simulation tick, rather than
      // comparing positions each render frame: the latter alternated moving/stopped
      // between ticks and made walking rigs twitch rapidly.
      const simMoving = Math.hypot(u.vx, u.vy) > 6;
      const exitMarch = (this.phase === "retreat" || this.phase === "outro") && u.team === "player" && u.alive;
      if (tok.actor) {
        // A defender's rig (friend invasion) fights mirrored: its enemy line is to the
        // LEFT, so the semantic returns of zombieFacingDelta ("+1 = toward the enemy")
        // don't apply — face the attackers while holding/fighting, else face the walk.
        const facing = u.team === "enemy"
          ? (u.state === "fight" || u.state === "hold"
            ? -1
            : Math.abs(u.vx) > 6 ? u.vx : null)
          : zombieFacingDelta(u, {
            exitMarch,
            retreating: this.phase === "retreat",
          });
        if (facing !== null) tok.actor.setFacingFromDelta(facing);
        const moving = u.alive && (simMoving || exitMarch);
        // The source focus pose narrows the eyes while the gold bar is advancing.
        // A distracted zombie or one waiting on the full-bar brain bubble is no
        // longer actively focusing, so its eyes relax.
        const focusing = this.phase === "fight" && !this.sim.finished &&
          u.state === "charging" && !u.distracted && !u.awaitRelease && u.charge < 1;
        tok.actor.update(dtSec, moving, focusing);

        // Garden heal: lift both arms overhead, hold through the healing burst, then
        // lower them. This pose is visual only; healing remains simulation-owned.
        const healElapsed = HEAL_POSE_S - tok.healPose;
        const healRaise = tok.healPose <= 0 ? 0
          : healElapsed < 0.14 ? healElapsed / 0.14
          : tok.healPose < 0.16 ? tok.healPose / 0.16
          : 1;

        // Smash (bash family): grow to 1+SMASH_GROW while charging (tracks the arm
        // raise), then a rapid slam+shrink on release. Detect release by the smash
        // charge dropping to 0 (windupKey clears once the payoff blow lands).
        const smashing = !!u.windupKey && SMASH_KEYS.has(u.windupKey);
        if (tok.wasSmashWindup > 0 && !smashing && tok.smashSlam < 0) {
          tok.smashSlam = SMASH_SLAM_S; // just released — begin the slam
        }
        tok.wasSmashWindup = smashing ? windup : 0;
        let grow = 1;
        let slamProg = -1;
        if (smashing) {
          grow = 1 + SMASH_GROW * windup; // loom up as the arms rise
        } else if (tok.smashSlam >= 0) {
          tok.smashSlam -= dtSec;
          slamProg = Math.max(0, tok.smashSlam) / SMASH_SLAM_S; // 1 → 0
          grow = 1 + SMASH_GROW * slamProg; // shrink 1.4 → 1
          if (tok.smashSlam <= 0) tok.smashSlam = -1;
        }
        // Feet-anchored grow: scale the rig container (and its feet offset) — NOT the
        // whole token — so the HP bar doesn't balloon with it.
        tok.actor.container.scale.set(tok.actorBaseScale * grow);
        tok.actor.container.y = tok.actorBaseY * grow;

        // On fire: HANDS UP, and nothing else. The rig's fully-raised arm angle is the
        // wind-up pose's endpoint, so the pose is expressed by handing poseArms a
        // saturated wind-up — a burning zombie has no real wind-up (pixelFire cancels the
        // swing it was charging), so nothing is being overridden. It is also not
        // "fighting" whatever the sim state says: it paces and flails, it does not swing.
        const burning = u.alive && u.burnMs > 0;
        // Arms: smash slam > wind-up (activated) > basic attack > walking > waiting.
        // Each zombie alternates Bite/Scratch after a landed hit; distractSeed offsets
        // its starting move so staggered fighters can show both attacks concurrently.
        const fighting = !burning &&
          this.phase === "fight" && u.state === "fight" && !u.windupKey && u.alive;
        const atkProg = Math.max(0, Math.min(1, 1 - visualAttackMs / Math.max(1, u.cooldownMs)));
        const attackName = zombieBasicAttackName(u.distractSeed, tok.atkCount);
        tok.actor.poseArms(
          burning ? 1 : windup,
          fighting, moving, atkProg, tok.atkCount,
          burning ? -1 : slamProg,
          burning ? 0 : healRaise,
          attackName
        );
      }
      // Enemy rig: idle bob when holding position, walk cycle while advancing, and a
      // forward strike lunge while trading blows — the lunge peaks at the attack's
      // damageTiming so its reach lands with the sim's hit (see EnemyActor).
      if (tok.enemyActor) {
        // The Ringmaster's direct hop travels slightly right from the circus car.
        // Using that delta as his facing mirrors the asymmetric rig, leaving his
        // body to the zombies' left and his long whip over the combat origin.
        if (u.sourceKey === CIRCUS_BOSS_KEY &&
            (u.state === "descending" || u.state === "hold" || u.state === "fight")) {
          tok.enemyActor.setFacingFromDelta(-1);
        } else if (Math.abs(u.vx) > 6) {
          tok.enemyActor.setFacingFromDelta(u.vx);
        }
        const enemyFighting = u.state === "fight" && u.alive;
        const atkProg = Math.max(0, Math.min(1, 1 - visualAttackMs / Math.max(1, u.cooldownMs)));
        let attack: EnemyAttackPose | null = enemyFighting
          ? { atkProg, damageTiming: u.attackDamageTiming, attackName: u.attackName }
          : null;
        // Perched boss: a simple throw swing — the arm cocks and swings forward as the
        // throw winds up, releasing (peak reach) as the projectile launches. Map the
        // sim's 0..1 wind-up onto the attack envelope's active window (past its rest
        // lead-in) so the arm animates over the whole wind-up.
        if (u.isBoss && u.state === "structure") {
          const summon = this.sim.bossWallSummonProgress();
          if (summon !== null) {
            // Slow raise/hold across the full authored (~3 s) wall summon.
            // `clip` names the authored animation for this state: a perched boss's
            // summon and throw are not swings, so EnemyActor cannot infer them from
            // atkProg alone (see raid/clipRuntime.ts). Ignored unless the rig has one.
            attack = { atkProg: 0.28 + 0.64 * summon, damageTiming: 0.98, clip: "ability" };
          } else {
            const sw = this.sim.bossThrowSwing(THROW_WINDUP_MS, visualLeadMs);
            attack = sw === null
              ? null
              : { atkProg: 0.28 + 0.72 * sw, damageTiming: 0.9, clip: "throw" };
          }
        }
        const jumpingFromPerch = u.state === "descending" && u.sourceKey === CIRCUS_BOSS_KEY;
        tok.enemyActor.update(dtSec, u.alive && simMoving && !jumpingFromPerch, attack);
      }
      if (tok.frameActor) {
        tok.frameActor.time += dtSec;
        const fighting = u.state === "fight" && u.alive && tok.frameActor.attack.length > 0;
        if (fighting) {
          const atkProg = Math.max(0, Math.min(1, 1 - visualAttackMs / Math.max(1, u.cooldownMs)));
          const recovery = 1 - u.attackDamageTiming;
          const sourceT = atkProg <= recovery
            ? u.attackDamageTiming + atkProg
            : atkProg - recovery;
          const index = Math.min(
            tok.frameActor.attack.length - 1,
            Math.floor(sourceT * tok.frameActor.attack.length)
          );
          tok.frameActor.sprite.texture = tok.frameActor.attack[index];
        } else {
          const index = Math.floor(tok.frameActor.time * 4) % tok.frameActor.idle.length;
          tok.frameActor.sprite.texture = tok.frameActor.idle[index];
        }
      }
      if (tok.epicActor) {
        // The attack strip is driven off the sim's attack clock, not off playback: it
        // is authored LONGER than the cycle it belongs to, so a one-shot that had to
        // finish before it could restart dropped most of the boss's swings and froze
        // on its last frame in between. See raid/epicBossAnimation.ts.
        const wanted = selectEpicBossAnimation({
          alive: u.alive,
          leaving: bossLeaving,
          state: u.state,
          has: (name) => !!this.bossFrames.get(name)?.length,
        });
        const wantedLoop = epicBossAnimationLoops(wanted);
        // Two strips are fitted to a beat of sim time rather than free-run: the attack
        // (the attack cycle) and the entrance (EPIC_BOSS_LAND_MS). Both beats are
        // shorter than the strips authored against them.
        const clockDriven = wanted === "attack" || wanted === "enter";
        if (tok.epicAnim !== wanted || tok.epicActor.loop !== wantedLoop) {
          tok.epicAnim = wanted;
          this.playEpic(tok.epicActor, wanted, wantedLoop);
          if (clockDriven) tok.epicActor.stop();
        }
        if (clockDriven) {
          // Indexed against the sprite's OWN frame count, so a strip that failed to
          // load degrades to a still rather than an out-of-range texture lookup.
          const index = wanted === "attack"
            ? epicAttackFrameIndex(
              visualAttackMs, u.cooldownMs, u.attackDamageTiming, tok.epicActor.totalFrames
            )
            : epicStripFrameIndex(
              1 - visualAttackMs / EPIC_BOSS_LAND_MS, tok.epicActor.totalFrames
            );
          if (tok.epicActor.currentFrame !== index) tok.epicActor.gotoAndStop(index);
        }
      }

      // Enemy bars remain visible for target readability. Owned-zombie bars stay
      // out of the way until that zombie has actually taken damage. Bars redraw
      // only when the drawn width changes (HP moves on 20 Hz sim ticks, not per
      // render frame), because clear()+redraw re-uploads geometry to the GPU.
      const frac = Math.max(0, u.hp / u.maxHp);
      const hpShown = u.alive && u.state !== "carried" && (u.team === "enemy" || frac < 1);
      const hpKey = hpShown ? Math.round(frac * 400) : -1;
      if (hpKey !== tok.hpKey) {
        tok.hpKey = hpKey;
        tok.hp.clear();
        // The number rides the same change key as the bar: HP moves on 20 Hz sim
        // ticks, so re-laying out the text every render frame would be pure waste.
        if (tok.hpText) {
          tok.hpText.visible = hpShown;
          if (hpShown) tok.hpText.text = formatHealthNumbers(u.hp, u.maxHp);
        }
        if (hpShown) {
          const halfW = u.team === "player" ? ZOMBIE_HP_HALF_W : tok.base;
          const w = halfW * 2;
          const fill = u.team === "enemy" ? ENEMY_COLOR : PLAYER_COLOR; // enemies red
          tok.hp
            .rect(-halfW, 0, w, 5).fill({ color: 0x000000, alpha: 0.55 })
            .rect(-halfW, 0, w * frac, 5).fill(fill);
        }
      }

      // Focus bar while charging (golden), or the activated-move wind-up (orange).
      const charging = this.phase === "fight" && !this.sim.finished && u.state === "charging";
      const chargeKey = charging
        ? 1000 + Math.round(Math.max(0, Math.min(1, u.charge)) * 400)
        : u.windupKey ? 2000 + Math.round(windup * 400) : -1;
      if (chargeKey !== tok.chargeKey) {
        tok.chargeKey = chargeKey;
        tok.charge.clear();
        if (charging) {
          const w = tok.base * 2;
          tok.charge
            .rect(-tok.base, 0, w, 4).fill(0x2a2410)
            .rect(-tok.base, 0, w * Math.max(0, Math.min(1, u.charge)), 4).fill(0xffcf5a);
        } else if (u.windupKey) {
          const w = tok.base * 2;
          tok.charge
            .rect(-tok.base, 0, w, 4).fill(0x3a1408)
            .rect(-tok.base, 0, w * windup, 4).fill(0xff6a2a);
        }
      }
    }

    // Focus bubble: hover it over the charging zombie while it's distracted (butterfly)
    // or fully charged and awaiting release (brain); hide it otherwise.
    const bub = this.phase === "fight" && !this.sim.finished ? this.sim.chargingBubble() : null;
    const thinking = this.phase === "fight" && !this.sim.finished
      ? this.sim.units.find((unit) => unit.team === "player" && unit.alive &&
          unit.state === "charging" && !unit.distracted && !unit.awaitRelease)
      : undefined;
    const bubbleId = bub?.id ?? thinking?.id;
    const bubTok = bubbleId ? this.tokens.get(bubbleId) : undefined;
    if (bubbleId && bubTok) {
      this.bubbleUnitId = bubbleId;
      this.bubble.visible = true;
      // Same bubble art in all three states — only what's inside it changes.
      const tex = !bub
        ? this.bubbleTexHmm
        : bub.kind === "brain" ? this.bubbleTexBrain : this.bubbleTexButterfly;
      if (tex) this.bubbleSprite.texture = tex;
      const szs = this.sizeScale();
      this.bubbleSprite.scale.set(-BUBBLE_SCALE * szs, BUBBLE_SCALE * szs); // track unit size
      this.bubbleSprite.visible = true;
      // Only a distracted / awaiting-release bubble can be popped. The thinking
      // bubble is pure feedback: leaving it interactive would show a tap affordance
      // that does nothing and would swallow taps meant for the zombie under it.
      this.setBubbleInteractive(!!bub);
      const bob = Math.sin(this.phaseT / 260) * 3 * szs;
      this.bubble.position.set(
        bubTok.root.x + BUBBLE_DX * szs,
        bubTok.root.y - (bubTok.base + 34) * szs + bob
      );
      const s = this.bubble.scale.x;
      this.bubble.scale.set(s + (1 - s) * Math.min(1, dtSec * 14)); // ease tap-feedback back
    } else {
      this.bubble.visible = false;
      this.bubbleSprite.visible = true;
      this.setBubbleInteractive(false);
      this.bubble.scale.set(1);
      this.bubbleUnitId = null;
    }

    // Team bars, top corners.
    const barW = hudLayout.barWidth;
    const barH = 17;
    const topY = hudLayout.topY;
    const topHudH = hudLayout.topHudHeight;
    if (resized) {
      this.topHudBack.clear()
        .rect(0, 0, W, topHudH).fill({ color: 0x15130f, alpha: 0.78 })
        .rect(0, topHudH - 4, W, 4).fill({ color: 0x090a08, alpha: 0.5 })
        .moveTo(0, topHudH - 1).lineTo(W, topHudH - 1)
        .stroke({ width: 2, color: 0xc7b78b, alpha: 0.48 });
      this.pWrap.position.set(hudLayout.leftBarX, topY);
      this.eWrap.position.set(hudLayout.rightBarX, topY);
      // Portraits stay inside side notches in landscape and disappear on cramped
      // mobile portrait raids; the health bars and counts remain available.
      this.pFace.position.set(hudLayout.leftFaceX, hudLayout.faceY);
      this.eFace.position.set(hudLayout.rightFaceX, hudLayout.faceY);
      this.pFace.visible = !hudLayout.hidePortraits;
      this.eFace.visible = !hudLayout.hidePortraits;
      this.roundLabel.position.set(W / 2, topY);
      this.retreatBtn.position.set(
        W - hudLayout.retreatRightMargin - this.retreatBtn.width,
        H - this.retreatBtn.height - hudLayout.retreatBottomMargin,
      );
      // Passive icons sit directly under the player's health bar; the button column
      // hangs below them (or takes their place when the army carries no passives).
      this.passiveAbilityStrip.position.set(
        hudLayout.abilityLeft + ABILITY_PASSIVE_R,
        topHudH + ABILITY_PASSIVE_GAP + ABILITY_PASSIVE_R,
      );
      const columnTop = topHudH + ABILITY_ACTIVE_R + (this.hasPassiveAbilities
        ? ABILITY_PASSIVE_GAP + 2 * ABILITY_PASSIVE_R + 10
        : ABILITY_ACTIVE_GAP);
      this.activeAbilityStrip.position.set(hudLayout.abilityLeft + ABILITY_ACTIVE_R, columnTop);
      // Four buttons is the worst case an army can ask for, and four at the authored
      // pitch overhang a landscape phone's home indicator — so the pitch, not the
      // column, gives way. Re-spaced only on a resize: slot INDEXES are fixed at build
      // time, so nothing here can slide a different move under a waiting thumb.
      const step = abilityColumnStep(
        this.activeAbilityCount,
        columnTop,
        H - safeArea.bottom - 8,
        ABILITY_ACTIVE_R,
        ABILITY_ACTIVE_STEP,
      );
      for (const c of this.abilityCells) if (c.activated) c.cell.y = c.slot * step;
    }
    // Both team bars read green when full (drain as the team loses HP).
    this.drawTeamBar(
      this.pBar, this.pFill, barW, barH,
      totals.playerHp / totals.playerMax, PLAYER_COLOR, this.pBarState,
    );
    this.drawTeamBar(
      this.eBar, this.eFill, barW, barH,
      totals.enemyHp / totals.enemyMax, PLAYER_COLOR, this.eBarState,
    );
    this.pLabel.text = `Zombies  ${totals.playerAlive}`;
    this.eLabel.text = `${this.raid.bossName || "Enemies"}  ${totals.enemyAlive}`;
    this.eLabel.x = barW - this.eLabel.width;

    // Round countdown → ENRAGED. Only meaningful for a raid with a boss timer.
    const remMs = this.sim.roundRemainingMs();
    if (this.sim.enraged) {
      this.roundLabel.text = "⚠ ENRAGED";
      this.roundLabel.style.fill = 0xff5a3c;
    } else if (remMs > 0) {
      const s = Math.ceil(remMs / 1000);
      this.roundLabel.text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      this.roundLabel.style.fill = s <= 15 ? 0xffcc33 : 0xffffff;
    } else {
      this.roundLabel.text = "";
    }

    // Retreat occupies the bottom-right action slot used by the farm quest control,
    // which is hidden while a battle owns the screen.
    this.retreatBtn.visible = (this.phase === "intro" || this.phase === "fight")
      && !this.sim.finished && !this.retreatRequested;

    // Activated buttons never move and never leave; they only darken. Three states,
    // read off the sim:
    //   armed       — a zombie can perform it this instant; a tap lands.
    //   recharging  — its zombie is in position, but is mid wind-up or cooling down.
    //   unavailable — nobody is in position to perform it at all.
    // `present` (in position) is deliberately steadier than `ready` (tap lands now):
    // driving the look off `ready` alone would strobe the column between swings and
    // leave nothing to time a wind-up into. Every button stays tappable in all three
    // states — a tap the sim refuses is simply a no-op.
    // Passive icons still appear only once a carrier has advanced onto the field;
    // they aren't tap targets, so re-packing that row is harmless.
    // All of it is throttled: this changes on sim events, not per render frame.
    this.abilityRefreshMs -= dtSec * 1000;
    if (this.abilityRefreshMs <= 0 || resized) {
      this.abilityRefreshMs = 150;
      // Keyed on the group's first (highest-tier) key, which is the cell's own `key` —
      // so a stacked button reads one status covering both of its moves.
      const status = new Map(this.sim.activatedGroupStatus().map((s) => [s.keys[0], s]));
      const teamStatus = new Map(this.sim.teamAbilityStatus().map((s) => [s.key, s.count]));
      let passiveSlot = 0;
      this.abilityCells.forEach((c) => {
        let count: number;
        if (c.activated) {
          const st = status.get(c.key);
          count = st?.ready ?? 0;
          c.cell.tint = count > 0
            ? ABILITY_TINT_ARMED
            : st?.present ? ABILITY_TINT_RECHARGING : ABILITY_TINT_UNAVAILABLE;
          // Show the move a tap would spend. A one-move button never changes face.
          if (st) this.setAbilityFace(c, st.key);
        } else {
          count = teamStatus.get(c.key) ?? 0;
          c.cell.visible = count > 0;
          if (!c.cell.visible) return;
          c.cell.x = passiveSlot++ * ABILITY_PASSIVE_STEP;
        }
        // One is the common case and needs no number; the badge is there to say
        // "more than one of these is available right now".
        //
        // Resurrect is the exception: its count is revives LEFT, a resource that counts
        // down and does not come back, so the last one is the number the player most
        // needs to see. It keeps its badge all the way down to 1.
        const showBadge = count > 1 || (c.key === "ressurect" && count > 0);
        if (c.badge) {
          c.badge.text = String(count);
          c.badge.visible = showBadge;
        }
        if (c.badgeDot) c.badgeDot.visible = showBadge;
      });
    }
    this.abilityCells.forEach((c) => {
      if (c.cell.scale.x < 1) c.cell.scale.set(Math.min(1, c.cell.scale.x + dtSec * 4)); // ease tap-press back
    });

    this.syncProjectiles();
    this.syncGrabbers();
    this.syncCrabs();
    this.syncFires(dtSec);
  }

  /** Mirror the burning zombies into tappable block flames. Runs after the token loop, so
   *  each token's screen position for THIS frame is already settled and the flame can be
   *  hung off it without re-deriving the projection.
   *
   *  Unlike the crab and the trapeze, this tap is TRANSCRIBED: the burn is fully simulated,
   *  so a fire the player smothered and the server did not would leave the two simulations
   *  disagreeing about how much HP that zombie has for the rest of the fight — exactly the
   *  wall desync of ruleset 14. */
  private syncFires(dtSec: number) {
    const live = new Set<string>();
    const szs = this.sizeScale();
    for (const u of this.sim.burningPlayers()) {
      const tok = this.tokens.get(u.id);
      if (!tok || !tok.root.visible) continue;
      live.add(u.id);
      let fire = this.fires.get(u.id);
      if (!fire) {
        fire = new PixelFire(() => {
          if (this.sim.finished || this.playback || !this.canRecordHazardTap()) return;
          if (this.sim.tapFire(u.id)) this.recordInput({ type: "fireTap", unitId: u.id });
        });
        this.fireLayer.addChild(fire.view);
        this.fires.set(u.id, fire);
      }
      // Sit the flame over the middle of the rig, its base a little inside the head so it
      // looks like the zombie is alight rather than wearing a hat.
      fire.view.position.set(
        tok.root.x + tok.hpCenterX * szs,
        tok.root.y + tok.topY * szs + FIRE_HEAD_OVERLAP * szs
      );
      // Fade over the last stretch of the burn so a fire about to go out reads as one, and
      // the player can see a tap is no longer worth spending.
      const fade = Math.min(1, u.burnMs / FIRE_FADE_MS);
      fire.update(dtSec, Math.max(2, Math.round(FIRE_CELL_PX * szs)), fade);
    }
    for (const [id, fire] of this.fires) {
      if (!live.has(id)) {
        fire.destroy();
        this.fires.delete(id);
      }
    }
  }

  /** Mirror the Beach crab hazards into tappable sprites. Seven taps kills one on touch
   *  and four with a mouse (see hazardTaps.ts), which frees any zombie it holds; an HP bar
   *  appears after the first tap so the player can see the rescue landing. Crabs walk the
   *  ground line, so they use mapY (not mapProjY). */
  private syncCrabs() {
    if (!this.crabTex) return;
    const live = new Set<string>();
    for (const c of this.sim.crabs) {
      if (c.state === "gone") continue;
      live.add(c.id);
      let entry = this.crabSprites.get(c.id);
      if (!entry) {
        const root = new Container();
        const body = new Sprite(this.crabTex);
        body.anchor.set(0.5, 1); // feet on the ground line
        const bar = new Graphics();
        root.addChild(body, bar);
        root.eventMode = "static";
        root.cursor = "pointer";
        // pointerDOWN, not pointertap: a tap only fires on RELEASE, and on a moving
        // target it does not fire at all if the crab has scuttled out from under the
        // cursor before the button comes back up. Both read as a click that did nothing.
        root.on("pointerdown", () => this.sim.tapCrab(c.id));
        this.crabLayer.addChild(root);
        entry = { root, body, bar };
        this.crabSprites.set(c.id, entry);
      }
      const { root, body, bar } = entry;
      root.position.set(this.mapX(c.x), this.mapY(c.y) + UNIT_GROUND_NUDGE * this.sizeScale());
      const h = CRAB_H * this.sizeScale();
      body.height = h;
      body.width = h * (this.crabTex.width / Math.max(1, this.crabTex.height));
      // Face its heading; the art faces left, so a rightward walk mirrors.
      body.scale.x = Math.abs(body.scale.x) * (c.state === "wander" && c.dir > 0 ? -1 : 1);
      body.tint = c.struckThisTick ? 0xff9a9a : 0xffffff;
      bar.clear();
      if (c.hp < c.maxHp) {
        const w = h * 1.4;
        const frac = Math.max(0, c.hp / c.maxHp);
        const by = -h - 10;
        bar.roundRect(-w / 2, by, w, 5, 3).fill({ color: 0x000000, alpha: 0.55 });
        bar.roundRect(-w / 2, by, w * frac, 5, 3).fill({ color: 0xff5252 });
      }
    }
    for (const [id, entry] of this.crabSprites) {
      if (!live.has(id)) {
        entry.root.destroy({ children: true });
        this.crabSprites.delete(id);
      }
    }
  }

  /** Mirror the Trapeze Artist grab hazards into tappable sprites (with an HP bar while
   *  they carry a zombie). Tapping one calls sim.tapGrabber to whittle it down. */
  private syncGrabbers() {
    if (!this.grabTex) return;
    const live = new Set<string>();
    const s = this.sizeScale();
    for (const g of this.sim.grabbers) {
      if (g.state === "gone") continue;
      live.add(g.id);
      let entry = this.grabSprites.get(g.id);
      if (!entry) {
        const root = new Container();
        const pendulum = new Container();
        const ropeExtension = new Graphics();
        const body = new Sprite(this.grabTex);
        // The two ropes terminate at x=0. Their midpoint is the real suspension point;
        // the artist occupies the far end of the long horizontal source texture.
        body.anchor.set(0, 31 / 70);
        const bar = new Graphics();
        pendulum.addChild(ropeExtension);
        pendulum.addChild(body);
        root.addChild(pendulum);
        root.addChild(bar);
        // Only the trapeze bitmap itself should be tappable.
        body.eventMode = "static";
        body.cursor = "pointer";
        // On press, not on release — see the crab above. The trapeze swings, so it is the
        // worse of the two for a click that lands and then has its target move away.
        body.on("pointerdown", () => this.sim.tapGrabber(g.id));
        this.grabLayer.addChild(root);
        entry = { root, pendulum, ropeExtension, body, bar, extensionLength: 0 };
        this.grabSprites.set(g.id, entry);
      }
      const { root, pendulum, ropeExtension, body, bar } = entry;
      let visualRot = g.rot;
      if (g.state === "swoop") {
        // Original staging: the suspension is dead-center and a quarter-screen above
        // the viewport. The endpoint remains hidden until the artist swings into view.
        const pivotX = this.app.screen.width / 2;
        const pivotY = -this.app.screen.height * 0.25;
        root.position.set(pivotX, pivotY);
        const target = g.targetId
          ? this.sim.units.find((unit) => unit.id === g.targetId)
          : null;
        if (target) {
          const targetX = this.mapX(target.x);
          const targetTok = this.tokens.get(target.id);
          const targetY = this.mapY(target.y) + UNIT_GROUND_NUDGE * s +
            (targetTok?.topY ?? -ZOMBIE_H) * 0.45 * s;
          const dx = targetX - pivotX;
          const dy = targetY - pivotY;
          // Preserve the artist at normal stage scale. Only lengthen the two ropes
          // between the suspension and the source bitmap when the lane is farther away.
          entry.extensionLength = Math.max(
            0,
            Math.hypot(dx, dy) - TRAPEZE_ARTIST_X * s
          );
          const contactRot = Math.atan2(dy, dx) * 180 / Math.PI;
          const progress = Math.max(0, Math.min(1, 1 - g.pauseMs / g.swingTotalMs));
          const eased = progress * progress * (3 - 2 * progress);
          visualRot = g.swingStartDeg + (contactRot - g.swingStartDeg) * eased;
        }
      } else {
        const z = g.grabbedId
          ? this.sim.units.find((unit) => unit.id === g.grabbedId)
          : null;
        // Once contact is made, put the suspension directly above the zombie. Derive
        // its screen y from the visible rope length so the artist barely moves while
        // the rig turns vertical and begins lifting.
        root.position.set(
          this.mapX(g.x),
          z
            ? this.mapProjY(z.y) +
              (this.tokens.get(z.id)?.topY ?? -ZOMBIE_H) * 0.45 * s -
              entry.extensionLength - TRAPEZE_ARTIST_X * s
            : this.mapProjY(g.y)
        );
      }
      // This source is a very wide 358x70 composition. Scaling both axes uniformly
      // preserves the authored trapeze/artist proportions; assigning a square width and
      // height here used to crush the art into a squat, barely recognizable sprite.
      ropeExtension.clear();
      if (entry.extensionLength > 0) {
        ropeExtension
          .moveTo(0, -16 * s).lineTo(entry.extensionLength, -16 * s)
          .moveTo(0, 16 * s).lineTo(entry.extensionLength, 16 * s)
          .stroke({ width: Math.max(1, 2 * s), color: 0x000000, alpha: 0.9 });
      }
      body.position.set(entry.extensionLength, 0);
      body.scale.set(s);
      body.rotation = 0;
      pendulum.rotation = (visualRot * Math.PI) / 180;
      body.tint = g.struckThisTick ? 0xff9a9a : 0xffffff; // flash on a landed tap
      // Health bar (shown once it has taken a tap), so the player sees rescue progress.
      bar.clear();
      if (g.hp < g.maxHp) {
        const w = 110 * s;
        const frac = Math.max(0, g.hp / g.maxHp);
        const by = -20 * s;
        bar.roundRect(-w / 2, by, w, 6, 3).fill({ color: 0x000000, alpha: 0.55 });
        bar.roundRect(-w / 2, by, w * frac, 6, 3).fill({ color: 0xff5252 });
      }
    }
    for (const [id, entry] of this.grabSprites) {
      if (!live.has(id)) {
        entry.root.destroy({ children: true });
        this.grabSprites.delete(id);
      }
    }
  }

  /** Mirror the sim's live projectiles into pooled sprites. */
  /** A dust puff at (x,y): a soft expanding disc that fades over ~0.45s. Zombies
   *  poof a pale green, enemies a neutral dust. Replaces the old lingering ghost. */
  private spawnPoof(x: number, y: number, color: number) {
    const g = new Graphics();
    g.position.set(x, y);
    this.fxLayer.addChild(g);
    this.fx.push({ g, t: 0, life: 0.45, color });
  }

  /** The Explode payoff: a big, loud, unmistakable fireball centred on the zombie that
   *  just sacrificed itself. Four layers land at once — sparks and smoke through the
   *  particle field, the fireball + shockwave as one additive Graphics, and a shake of
   *  the combat layers — because any one of them alone reads as another dust puff. */
  private spawnExplosion(x: number, y: number) {
    const g = new Graphics();
    g.position.set(x, y);
    g.blendMode = "add"; // fire glows through whatever it overlaps
    this.fxLayer.addChild(g);
    this.blastFx.push({ g, t: 0, scale: this.sizeScale() });
    this.particles.burst(BLAST_SPARKS, x, y, 1);
    if (this.smokeCfg) this.particles.burst(this.smokeCfg, x, y, 1.6);
    this.shakeT = BLAST_SHAKE_S;
  }

  /** Offset the combat layers (not the HUD, and not the stage art behind them) by a
   *  decaying random jitter. Written only while a shake is live, and zeroed once, so
   *  a still battlefield costs nothing. */
  private stepShake(dtSec: number) {
    if (this.shakeT <= 0) return;
    this.shakeT = Math.max(0, this.shakeT - dtSec);
    const k = this.shakeT / BLAST_SHAKE_S; // 1 → 0
    const amp = BLAST_SHAKE_PX * this.sizeScale() * k * k;
    const dx = amp * (Math.random() * 2 - 1);
    const dy = amp * 0.6 * (Math.random() * 2 - 1);
    for (const layer of [
      this.tokenLayer, this.projLayer, this.fxLayer, this.particles.container,
      this.brainLayer, this.grabLayer, this.crabLayer,
    ]) {
      layer.position.set(dx, dy);
    }
  }

  private stepBlasts(dtSec: number) {
    for (const b of this.blastFx) {
      b.t += dtSec;
      const k = Math.min(1, b.t / BLAST_LIFE_S);
      const s = b.scale;
      // Shockwave: outruns the fireball, thinning and fading as it goes.
      const ringK = 1 - (1 - k) ** 2.2; // ease out hard — fastest at the instant of the blast
      const ringR = (26 + BLAST_RING_R * ringK) * s;
      const ringW = Math.max(1, 18 * (1 - k) ** 1.4) * s;
      // Fireball: swells over the first 45% of the life, then collapses into the smoke.
      const ballK = Math.min(1, k / 0.45);
      const ballR = (24 + BLAST_BALL_R * (1 - (1 - ballK) ** 2)) * s;
      const ballA = k < 0.45 ? 1 : Math.max(0, 1 - (k - 0.45) / 0.55) ** 1.3;
      const coreA = Math.max(0, 1 - k / 0.28); // white-hot centre, gone almost at once
      b.g.clear()
        .circle(0, 0, ringR).stroke({ width: ringW, color: 0xffd489, alpha: (1 - k) ** 2 * 0.8 })
        .circle(0, 0, ballR).fill({ color: 0xff6a12, alpha: 0.5 * ballA })
        .circle(0, -8 * s * ballK, ballR * 0.7).fill({ color: 0xffb02e, alpha: 0.6 * ballA })
        .circle(0, -14 * s * ballK, ballR * 0.42).fill({ color: 0xfff3c4, alpha: 0.85 * coreA });
    }
    if (this.blastFx.some((b) => b.t >= BLAST_LIFE_S)) {
      for (const b of this.blastFx) if (b.t >= BLAST_LIFE_S) b.g.destroy();
      this.blastFx = this.blastFx.filter((b) => b.t < BLAST_LIFE_S);
    }
  }

  /** Sample one unit's damage-taken total after a simulation tick; float the increase as a
   *  number once it is worth printing (see combatNumbers.tallyDamage). The total counts the
   *  attack's post-mitigation damage, NOT the health removed, so overkill and the one-shot
   *  latch no longer shrink the figure a player reads. */
  private stepDamageNumber(u: SimUnit, dtSec: number) {
    const before = this.damageWatch.get(u.id);
    this.damageWatch.set(u.id, u.damageFxTaken);
    if (before === undefined) return; // first sighting: nothing to compare against
    let tally = this.damageTallies.get(u.id);
    if (!tally) {
      tally = newDamageTally();
      this.damageTallies.set(u.id, tally);
    }
    // The total only ever climbs, so heals and Resurrects need no guarding against here
    // (the max is belt-and-braces against a restored checkpoint resetting it). `!u.alive`
    // flushes whatever is still held back, because a dead unit gets no later flush.
    const shown = tallyDamage(tally, Math.max(0, u.damageFxTaken - before), dtSec, !u.alive);
    if (shown !== null) this.spawnDamageNumber(u, shown);
  }

  /** Float "-12" off a unit that has just been hit. Enemy damage is written in the
   *  team colours already used for the bars: the player's own losses in red, damage
   *  the army deals in the same pale gold as its rewards. */
  private spawnDamageNumber(u: SimUnit, amount: number) {
    const tok = this.tokens.get(u.id);
    if (!tok || !tok.root.visible) return; // off-field (queued, or a finished corpse)
    const szs = this.sizeScale();
    // The oldest float is recycled rather than letting a big brawl allocate without
    // bound. Losing the tail end of a number that is already fading is invisible.
    if (this.damageNumbers.length >= DAMAGE_NUMBER_MAX) {
      this.damageNumbers.shift()?.text.destroy();
    }
    const text = new Text({
      text: `-${amount}`,
      style: {
        fill: u.team === "player" ? 0xff8a7a : 0xffe6a2,
        fontSize: Math.max(11, Math.round((u.isBoss ? 21 : 17) * szs)),
        fontWeight: "bold",
        stroke: { color: 0x14181f, width: 4 },
      },
    });
    text.anchor.set(0.5, 1);
    // Spread the floats across the body so two hits in the same second do not stack
    // into one unreadable smudge.
    const x = tok.root.x + (Math.random() * 2 - 1) * 14 * szs;
    const y = tok.root.y + tok.topY * 0.75 * szs;
    text.position.set(x, y);
    this.fxLayer.addChild(text);
    this.damageNumbers.push({ text, t: 0, x, y });
  }

  /** Rise and fade every live damage number, then drop the spent ones. */
  private stepDamageNumbers(dtSec: number) {
    if (!this.damageNumbers.length) return;
    const rise = DAMAGE_NUMBER_RISE * this.sizeScale();
    for (const float of this.damageNumbers) {
      float.t += dtSec;
      const k = Math.min(1, float.t / DAMAGE_NUMBER_LIFE_S);
      float.text.position.set(float.x, float.y - rise * k);
      float.text.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    }
    if (this.damageNumbers.some((float) => float.t >= DAMAGE_NUMBER_LIFE_S)) {
      for (const float of this.damageNumbers) {
        if (float.t >= DAMAGE_NUMBER_LIFE_S) float.text.destroy();
      }
      this.damageNumbers = this.damageNumbers.filter((float) => float.t < DAMAGE_NUMBER_LIFE_S);
    }
  }

  private stepFx(dtSec: number) {
    this.stepBlasts(dtSec);
    this.stepDamageNumbers(dtSec);
    for (const e of this.fx) {
      e.t += dtSec;
      const k = Math.min(1, e.t / e.life);
      const r = 7 + 24 * k;
      const a = (1 - k) * 0.5;
      e.g.clear()
        .circle(0, -6 * k, r).fill({ color: e.color, alpha: a })
        .circle(7 * (1 - k), -20 * k, r * 0.55).fill({ color: e.color, alpha: a * 0.8 });
    }
    if (this.fx.some((e) => e.t >= e.life)) {
      for (const e of this.fx) if (e.t >= e.life) e.g.destroy();
      this.fx = this.fx.filter((e) => e.t < e.life);
    }
  }

  /** The beam-down pillar: a column of white light that opens, then closes in from both
   *  sides as it fades. Delivers a resurrected zombie and an abducted human alike.
   *
   *  GROUND TRUTH — `-[ZombieActorGarden ressurectZombie:]` (0x7d698) and
   *  `-[ZFFightMan summonBoss:]` (0x5f256) build it from the same parts with byte-identical
   *  numbers, so it really is one effect used twice:
   *
   *    CCColorLayer initWithColor:ccc4(255,255,255,255) width:100 height:320
   *      — opaque white, 100 of the 480-wide design space, and 320 is the WHOLE screen
   *        height (the iPad branch asks for 640, its own full height).
   *    setPosition:(actor.x - 50, 0), setScaleX:0
   *      — standing on the bottom edge, centred on the actor, starting closed. A CCLayer
   *        positions from its bottom-left but TRANSFORMS about its (0.5, 0.5) anchor, so
   *        the scale runs in from both sides rather than sliding one edge.
   *    CCSpawn of two sequences:
   *      scale: CCScaleTo 0.2s -> (1, 1), then CCScaleTo 1.3s -> (0, 1)
   *      alpha: CCDelayTime 0.2s, then CCFadeTo 1.3s -> opacity 0, then a cleanup callback
   *
   *  The two schedules line up exactly, which is why one ramp drives both here. 1.5 s
   *  total. Both sites also `playEffect: @"resurrect.wav"` — the abductee's arrival uses
   *  the resurrection cue too.
   *
   *  `x` is the DRAWN centre of the unit, not its token origin: an enemy rig is anchored at
   *  its model-space left edge, so callers pass `sx + hpCenterX * szs` (hpCenterX is 0 for
   *  a player rig, which is already centred). */
  private spawnLightPillar(x: number) {
    const r = this.bgRect();
    const w = PILLAR_DESIGN_W * r.scale;
    const g = new Graphics().rect(-w / 2, 0, w, r.h).fill(0xffffff);
    g.position.set(x, r.top);
    g.scale.x = 0;
    this.beamLayer.addChild(g);
    this.beams.push({ g, t: 0 });
  }

  private stepBeams(dtSec: number) {
    if (!this.beams.length) return;
    for (const b of this.beams) {
      b.t += dtSec;
      const open = Math.min(1, b.t / PILLAR_OPEN_S);
      const close = Math.max(0, 1 - Math.max(0, b.t - PILLAR_OPEN_S) / PILLAR_CLOSE_S);
      b.g.scale.x = Math.min(open, close);
      b.g.alpha = close; // the authored delay+fade is the same schedule as the close
    }
    if (this.beams.some((b) => b.t >= PILLAR_TOTAL_S)) {
      for (const b of this.beams) if (b.t >= PILLAR_TOTAL_S) b.g.destroy();
      this.beams = this.beams.filter((b) => b.t < PILLAR_TOTAL_S);
    }
  }

  /** Light (or re-arm) the Regular zombie's automatic T3/T4 eye beam. This is
   *  presentation-only: the replay-safe damage and cadence remain owned by
   *  BattleSim.stepLaser. Each sim tick lands here and extends the beam's hold by
   *  one firing interval plus a linger, so a zombie that keeps cycling shows one
   *  unbroken ray rather than a flash per tick. */
  private armZombieBeam(u: SimUnit) {
    const holdS = laserInterval(u.abilities, u.cooldownMs) / 1000 + BEAM_LINGER_S;
    const prev = this.zombieBeams.get(u.id);
    if (prev) {
      prev.holdS = holdS;
      prev.targetId = u.laserTargetId!;
      return;
    }
    const g = new Graphics();
    this.fxLayer.addChild(g);
    this.zombieBeams.set(u.id, {
      g, holdS, ageS: 0, targetId: u.laserTargetId!,
      upgraded: u.abilities.includes("zomBeam"),
      smokeS: 0,
    });
  }

  /** Redraw every live eye beam against this frame's token positions — called AFTER
   *  layout() has placed the tokens, so the beam pins to the eyes instead of trailing
   *  them by a frame while its owner walks. */
  private stepZombieBeams(dtSec: number) {
    if (!this.zombieBeams.size) return;
    const szs = this.sizeScale();
    for (const [id, beam] of this.zombieBeams) {
      beam.ageS += dtSec;
      beam.holdS -= dtSec;
      const src = this.tokens.get(id);
      const dst = this.tokens.get(beam.targetId);
      // A laser turning off is instant by nature: expire on the hold running dry, and
      // cut immediately when either end dies — a beam from (or into) a corpse is worse
      // than a hard stop.
      if (beam.holdS <= 0 || !src || !dst || src.deathAnim >= 0 || dst.deathAnim >= 0) {
        beam.g.destroy();
        this.zombieBeams.delete(id);
        continue;
      }
      // Origins: one beam per eye, and every beam runs PARALLEL TO THE GROUND — it
      // leaves the eye horizontally and strikes the enemy at that same height,
      // whatever the enemy's size. A face covered by a mutation (no eye sprites) or
      // a portrait-fallback token fires a single beam from the approximate eye line
      // the old flash used. `hpCenterX` / `base` / `topY` are TOKEN-LOCAL; the root
      // carries the size scale, so each is scaled before being added to a screen
      // position.
      const eyePts = src.actor?.eyePointsGlobal() ?? [];
      const origins = eyePts.length
        ? eyePts.map((p) => this.fxLayer.toLocal(p))
        : [{
            x: src.root.x + (src.hpCenterX + src.base * 0.16) * szs,
            y: src.root.y + src.topY * 0.72 * szs,
          }];
      const xHit = dst.root.x + (dst.hpCenterX - dst.base * 0.2) * szs;
      // Thin white core in a coloured sheath, the whole thing throbbing in width and
      // brightness together.
      const env = Math.min(beam.ageS / BEAM_FADE_IN_S, beam.holdS / BEAM_FADE_OUT_S, 1);
      const throb = 0.5 + 0.5 * Math.sin(beam.ageS * BEAM_PULSE_RAD_S);
      const a = env * (0.6 + 0.4 * throb);
      // Tier colours: green for the T3 laserBeam, blue for the T4 zomBeam upgrade.
      const color = beam.upgraded ? 0x4f9dff : 0x8dff45;
      const wCore = (beam.upgraded ? 1.6 : 1.3) * Math.max(0.7, szs) * (0.75 + 0.5 * throb);
      const wBody = wCore * 2.4;
      const wGlow = wCore * 5.5;
      beam.g.clear();
      for (const o of origins) {
        beam.g
          .moveTo(o.x, o.y).lineTo(xHit, o.y).stroke({ width: wGlow, color, alpha: 0.15 * a })
          .moveTo(o.x, o.y).lineTo(xHit, o.y).stroke({ width: wBody, color, alpha: 0.8 * a })
          .moveTo(o.x, o.y).lineTo(xHit, o.y).stroke({ width: wCore, color: 0xffffff, alpha: a })
          .circle(o.x, o.y, wBody * 1.3).fill({ color: 0xffffff, alpha: 0.75 * a })
          .circle(xHit, o.y, wGlow * (0.75 + 0.3 * throb)).fill({ color, alpha: 0.45 * a });
      }
      // The burn point smoulders: small wisps of the stage's smoke at the impact,
      // centred between the (near-coincident) per-eye strike heights.
      beam.smokeS -= dtSec;
      if (beam.smokeS <= 0 && this.smokeCfg) {
        beam.smokeS += BEAM_SMOKE_S;
        const yHit = origins.reduce((sum, o) => sum + o.y, 0) / origins.length;
        this.particles.burst(this.smokeCfg, xHit, yHit, BEAM_SMOKE_SCALE);
      }
    }
  }

  /** Yeet one visible brain per five awarded brains from the defeated boss into
   * midfield. The +5 badge makes the stack value explicit while keeping a 50-brain
   * jackpot to ten readable sprites rather than fifty tiny particles. */
  private spawnBrainDrop() {
    if (this.brainDropFired || !this.brainDrop || !this.brainTex) return;
    const boss = this.sim.units.find((unit) => unit.isBoss);
    const token = boss ? this.tokens.get(boss.id) : null;
    if (!boss || !token) return;
    this.brainDropFired = true;
    const count = Math.floor(this.brainDrop / 5);
    const targetX = this.mapX(FIELD_W * 0.52);
    const targetY = this.mapY(CENTER_Y) - 12 * this.sizeScale();
    for (let i = 0; i < count; i++) {
      const root = new Container();
      const icon = new Sprite(this.brainTex);
      icon.anchor.set(0.5);
      icon.width = icon.height = 30 * this.sizeScale();
      const badge = new Text({ text: "+5", style: { fill: 0xffffff, fontSize: 12, fontWeight: "bold", stroke: { color: 0x35134a, width: 3 } } });
      badge.anchor.set(0.5, 0);
      badge.position.set(0, 13 * this.sizeScale());
      root.addChild(icon, badge);
      root.position.copyFrom(token.root.position);
      this.brainLayer.addChild(root);
      const lane = i - (count - 1) / 2;
      this.brainSprites.push({
        root,
        t: 0,
        delay: i * 0.055,
        startX: token.root.x,
        startY: token.root.y + token.topY * 0.45,
        endX: targetX + lane * 25 * this.sizeScale(),
        endY: targetY + (Math.abs(i * 37) % 3) * 7 * this.sizeScale(),
      });
    }
  }

  private stepBrainDrops(dtSec: number) {
    const flight = 0.82;
    for (const brain of this.brainSprites) {
      brain.t += dtSec;
      const raw = brain.t - brain.delay;
      if (raw < 0) { brain.root.visible = false; continue; }
      brain.root.visible = true;
      const k = Math.min(1, raw / flight);
      brain.root.x = brain.startX + (brain.endX - brain.startX) * k;
      brain.root.y = brain.startY + (brain.endY - brain.startY) * k - Math.sin(Math.PI * k) * 115 * this.sizeScale();
      brain.root.rotation = k < 1 ? k * Math.PI * 3 : 0;
      const age = raw - flight - 0.75;
      brain.root.alpha = age > 0 ? Math.max(0, 1 - age / 0.45) : 1;
    }
    for (const brain of this.brainSprites.filter((entry) => entry.root.alpha <= 0)) brain.root.destroy({ children: true });
    this.brainSprites = this.brainSprites.filter((entry) => !entry.root.destroyed);
  }

  /** A round white texture (tinted at use) for hazards that ship no projectile art. */
  private hazardDotTex(): Texture {
    if (!this.dotTex) {
      const g = new Graphics().circle(16, 16, 15).fill(0xffffff);
      this.dotTex = this.app.renderer.generateTexture(g);
      g.destroy();
    }
    return this.dotTex;
  }

  /** Size a thrown mini to the SAME height it stands at on the field, rather than to
   *  the authored `spriteSize` — which is a sim number (it sets the collision radius,
   *  PROJ_HIT_FACTOR) and must not be retuned to fix a drawing. The mini is a real
   *  defender in this fight, so its token already carries the exact height the rig
   *  was scaled to; matching it is what makes the thrown copy read as the same
   *  zombie. Falls back to the authored sizing if either measurement is missing. */
  private planThrownZombie(sprite: string, url: string, key: string, tex: Texture): void {
    const owner = this.sim.units.find((u) => u.sourceKey === key && u.team === "enemy");
    const token = owner ? this.tokens.get(owner.id) : undefined;
    const fieldHeight = token ? -token.topY : 0;
    const box = opaqueBounds(url);
    if (!token || fieldHeight <= 0 || !box) return;
    // Anchor on the ZOMBIE's centre rather than the card's, so it flies along the arc
    // the sim computed AND tumbles about itself — a fixed position offset would put the
    // rotation centre back on the card and swing the zombie around it instead.
    this.projZombieDraw.set(sprite, {
      scale: fieldHeight / box.h,
      anchorX: (box.x + box.w / 2) / Math.max(1, tex.width),
      anchorY: (box.y + box.h / 2) / Math.max(1, tex.height),
    });
  }

  private syncProjectiles() {
    const live = new Set<string>();
    const s = this.scaleX();
    for (const pr of this.sim.projectiles) {
      live.add(pr.id);
      let sp = this.projSprites.get(pr.id);
      if (!sp) {
        const tex = this.projTex.get(pr.sprite) ?? null;
        // Hazards with no preloaded sprite (falling obstacles / grabs) render as a
        // round warning dot — NOT Texture.WHITE, which read as a spinning square.
        sp = new Sprite(tex ?? this.hazardDotTex());
        const plan = this.projZombieDraw.get(pr.sprite);
        if (plan) sp.anchor.set(plan.anchorX, plan.anchorY);
        else sp.anchor.set(0.5);
        if (!tex) sp.tint = 0xff7a3c;
        this.projLayer.addChild(sp);
        this.projSprites.set(pr.id, sp);
        // `AlienStageBullet init` plays alienLaser.wav as the bolt is created.
        if (pr.sprite === ALIEN_LASER_SPRITE) {
          this.onStrike?.({ team: "enemy", sfxFile: "alienLaser.wav" });
        }
      }
      // A thrown zombie draws at its own field size, keeping the portrait's aspect;
      // everything else keeps the authored square sizing, rendered ~2x the old size
      // (the collision radius in BattleSim is unchanged — that bump is purely a
      // visual-legibility one so thrown items read clearly).
      const zombieDraw = this.projZombieDraw.get(pr.sprite);
      if (zombieDraw) {
        sp.scale.set(zombieDraw.scale);
      } else {
        const size = Math.max(20, pr.spriteSize * s * 2.4);
        sp.width = size;
        sp.height = size;
      }
      sp.rotation = pr.rot;
      const visual = extrapolatePosition(pr.x, pr.y, pr.vx, pr.vy, this.simAccumulatorMs, RAID_TICK_MS);
      let px = this.mapX(visual.x);
      let py = this.mapProjY(visual.y);
      {
        // Boss throw/laser: re-anchor the ORIGIN to the boss's hand, fading the shift
        // to zero as the projectile nears the ground so the LANDING still tracks the
        // target zombie. (The raw sim origin maps to a point down-left of the boss.)
        const t = Math.max(0, Math.min(1, (visual.y - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y)));
        const fade = 1 - t;
        px += (this.bossHandX - this.mapX(BOSS_STRUCT_X)) * fade;
        py += (this.bossHandY - this.mapProjY(BOSS_STRUCT_Y)) * fade;
      }
      sp.position.set(px, py);
    }
    // Drop sprites whose projectile has landed.
    for (const [id, sp] of this.projSprites) {
      if (!live.has(id)) {
        sp.destroy();
        this.projSprites.delete(id);
      }
    }
  }

  // Last-drawn geometry per team bar, so the rounded frame (3 roundRects) is only
  // re-tessellated on resize and the fill only when the HP fraction moves.
  private pBarState = { w: -1, h: -1, f: -1 };
  private eBarState = { w: -1, h: -1, f: -1 };
  private drawTeamBar(
    bar: Graphics, fill: Graphics, w: number, h: number, frac: number, color: number,
    state: { w: number; h: number; f: number },
  ) {
    const f = Math.max(0, Math.min(1, frac));
    const fq = Math.round(f * 400); // ¼% steps — sub-pixel for a ≤350 px bar
    const sized = state.w !== w || state.h !== h;
    if (sized) {
      bar.clear()
        .roundRect(-5, -5, w + 10, h + 10, 7).fill({ color: 0x11130f, alpha: 0.94 })
        .roundRect(0, 0, w, h, 4).fill({ color: 0x050505, alpha: 0.82 })
        .roundRect(-5, -5, w + 10, h + 10, 7).stroke({ width: 2, color: 0xd9e2c4, alpha: 0.8 });
    }
    if (sized || state.f !== fq) {
      fill.clear();
      if (f > 0) fill.roundRect(0, 0, w * f, h, 4).fill(color);
    }
    state.w = w;
    state.h = h;
    state.f = fq;
  }

  /** Drive the scene forward. Called from the app ticker with seconds. */
  update(dtSec: number) {
    const dtMs = Math.min(dtSec * 1000, 250);
    this.phaseT += dtMs;
    this.stepFx(dtSec);
    this.stepBeams(dtSec);
    this.stepShake(dtSec);
    this.stepBrainDrops(dtSec);
    this.particles.update(dtSec);

    // Retreat is handled here (not in the tap handler) so nothing runs mid
    // event-dispatch on the button that triggered it.
    if (this.retreatRequested && !this.resultFired) {
      this.retreated = true;
      this.retreatRequested = false;
      this.retreatBtn.visible = false;
      this.activeAbilityStrip.interactiveChildren = false;
      this.bubble.visible = false;
      this.prepareArmyExit();
      this.setPhase("retreat");
    }

    if (this.bossFallsFromSky && (this.sim.escaped || this.phase === "retreat")) {
      this.bossExitMs += dtMs;
    }

    switch (this.phase) {
      case "intro":
        if (this.phaseT >= INTRO_MS) this.setPhase("fight");
        break;
      case "fight": {
        if (this.onCheckpoint && !this.sim.finished && this.simTick - this.lastCheckpointTick >= 300) {
          if (!this.checkpointing && performance.now() >= this.checkpointRetryAt) {
            this.checkpointing = true;
            // Checkpoints are transport work, not a simulation gate.  Pausing here
            // made a slow/failed request freeze combat at the 15-second boundary
            // while Pixi, particles, and music continued to animate.  Keep each
            // segment pinned to exactly 300 ticks so a retry remains valid even
            // though the local simulation has continued past the boundary.
            const tick = this.lastCheckpointTick + 300;
            const segment = this.replayInputs.filter((input) => input.tick > this.lastCheckpointTick && input.tick <= tick);
            void this.onCheckpoint(tick, segment).then(() => {
              this.lastCheckpointTick = tick;
              this.replayInputs = this.replayInputs.filter((input) => input.tick > tick);
            }).catch(() => {
              this.checkpointRetryAt = performance.now() + 1000;
            }).finally(() => { this.checkpointing = false; });
          }
        }
        this.simAccumulatorMs += dtMs;
        // Combat advances only in fixed ticks. Rendering remains free to interpolate
        // at the display cadence, but it can no longer change the outcome.
        let catchup = 0;
        let stepped = false;
        while (this.simAccumulatorMs >= RAID_TICK_MS && !this.sim.finished && catchup++ < 5) {
          // Playback: inject the recorded transcript exactly where the verifier does —
          // inputs stamped with this tick apply BEFORE this tick is stepped, and a
          // recorded retreat stops the stepping the same way a live one does.
          this.applyPlaybackInputs();
          if (this.retreatRequested) break;
          this.sim.step(RAID_TICK_MS);
          this.simAccumulatorMs -= RAID_TICK_MS;
          this.simTick++;
          stepped = true;
        }
        // `struckThisTick` remains set until the NEXT simulation step resets it. Only
        // consume it on a frame that actually advanced the sim; otherwise a 60/120 Hz
        // renderer would replay one strike several times, resetting the pulse and
        // flipping the attack-arm parity every display frame.
        if (stepped) {
          let strike: { unit: SimUnit; attackName: string } | null = null;
          for (const u of this.sim.units) {
            // Damage numbers are read off the HP the tick just wrote — no hook into
            // the fight itself, so the transcript the verifier replays is untouched.
            if (this.showDamageNumbers) this.stepDamageNumber(u, dtSec);
            if (u.struckThisTick) {
              const t = this.tokens.get(u.id);
              // Capture the move before incrementing atkCount so impact audio names
              // the exact Bite/Scratch animation that just connected.
              const attackName = u.team === "player" && t
                ? zombieBasicAttackName(u.distractSeed, t.atkCount)
                : u.attackName;
              // When both sides connect on one fixed tick, prefer the player's
              // authored zombie cue. This retains the one-cue-per-tick mix guard
              // while ensuring zombie bites cannot be masked by an enemy hit.
              if (!strike || (strike.unit.team === "enemy" && u.team === "player")) {
                strike = { unit: u, attackName };
              }
              if (t) {
                t.atkCount++; // next basic swing uses the other animation and cue
                // A small dust burst at the point of impact (victim's mid-body).
                const dust = u.team === "enemy" || SHOW_ZOMBIE_ATTACK_DUST;
                if (dust && this.bashCfg && u.alive) {
                  this.particles.burst(this.bashCfg, t.root.x, t.root.y + t.topY * 0.5, 0.28);
                }
              }
            }
          }
          // Collapse simultaneous hits to one cue so a large army does not stack
          // a painfully loud group of identical one-shots.
          if (this.sim.projectileImpactsThisTick > 0) {
            // `AlienStageBullet collidedWith:` plays stun.wav on the hit, not the generic
            // thrown-debris splat.
            const sfxFile = this.sim.lastProjectileImpactSprite === ALIEN_LASER_SPRITE
              ? "stun.wav"
              : undefined;
            this.onStrike?.({ team: "enemy", impact: "projectile", sfxFile });
          } else if (strike) {
            this.onStrike?.({
              team: strike.unit.team,
              attackName: strike.attackName,
              sfxFile: this.assets.raidAttacks[strike.attackName]?.sfxID,
            });
          }
        }
        if (this.sim.finished) {
          // Freeze outcome-relevant controls on the decisive tick, not after the
          // cinematic pause. Otherwise a last tap can enter the transcript at a tick
          // the verifier has already finished.
          this.activeAbilityStrip.interactiveChildren = false;
          this.bubble.visible = false;
          this.retreatBtn.visible = false;
          if (this.sim.playerWon) {
            this.prepareArmyExit();
            if (!this.victoryNotified) {
              this.victoryNotified = true;
              this.onVictory?.();
            }
          }
        }
        // Confetti pops the moment the players win (across the top of the field).
        if (this.sim.finished && this.sim.playerWon && !this.confettiFired && this.confettiCfg) {
          this.confettiFired = true;
          const r = this.bgRect();
          this.particles.burst(this.confettiCfg, r.left + r.w / 2, r.top + r.h * 0.12, 1.4, true);
        }
        if (this.sim.finished && this.sim.playerWon) this.spawnBrainDrop();
        if (this.sim.finished && this.phaseT >= END_PAUSE_MS) {
          this.setPhase(this.sim.playerWon ? "outro" : "defeat");
        } else if (!this.sim.finished) {
          this.phaseT = 0; // keep the end-pause clock fresh until the sim ends
        }
        break;
      }
      case "outro": {
        // Every visible survivor, including zombies that were still waiting at the
        // focus bar, keeps walking until it has cleared the right edge.
        advanceRaidArmy(this.sim.units, 1, OUTRO_WALK_SPEED, dtMs);
        if (!this.resultFired && this.phaseT >= OUTRO_RESULT_DELAY_MS) this.fireResult();
        if (this.resultFired && raidArmyHasExited(this.sim.units, 1)) this.phase = "done";
        break;
      }
      case "retreat": {
        // Living zombies turn around and keep walking until the whole visible army
        // has cleared the left edge. Combat and rescue hazards are already frozen.
        advanceRaidArmy(this.sim.units, -1, OUTRO_WALK_SPEED, dtMs);
        if (!this.resultFired && this.phaseT >= RETREAT_RESULT_DELAY_MS) this.fireResult();
        if (this.resultFired && raidArmyHasExited(this.sim.units, -1)) this.phase = "done";
        break;
      }
      case "defeat":
        if (this.phaseT >= END_PAUSE_MS) {
          this.fireResult();
          this.phase = "done";
        }
        break;
      case "done":
        break; // hold; the panel's finish button tears the scene down (via main)
    }

    this.layout(dtSec);
    // After layout: the beams pin to this frame's eye/target positions.
    this.stepZombieBeams(dtSec);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private prepareArmyExit() {
    if (this.armyExitPrepared) return;
    this.armyExitPrepared = true;
    this.sim.prepareArmyExit();
    this.bubble.visible = false;
    this.bubbleUnitId = null;
  }

  /** Emit the outcome once (the reward pipeline + results panel run in main).
   *  The scene keeps rendering behind the panel until main tears it down. */
  private fireResult() {
    if (this.resultFired) return;
    this.resultFired = true;
    const o = this.sim.outcome();
    // A retreat is a clean flee: survivors aren't credited (no veterancy), but the
    // tally still reflects what happened up to the retreat.
    const outcome = this.retreated ? { ...o, win: false, survivors: [] } : o;
    this.onFinish(outcome, this.simTick, this.replayInputs.slice());
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
