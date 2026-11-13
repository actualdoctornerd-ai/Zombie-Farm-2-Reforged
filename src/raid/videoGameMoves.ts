// THE VIDEO GAMES CREW'S MOVES (owner design, 2026-11-12; ruleset 92). Every Video Games
// enemy carries its move wherever it fights: Zombies vs Video Games (raid 9, ordinary and
// elite), the Circus & Video Games dual (raid 14) and Endless's video-game floors.
//
//   - The dragon (VideoGameStageMonsterActor) opens with a GOUT and repeats it every 12 s:
//     a 2 s charge-up (no swings), a gout of flame over the front area that takes 10% of
//     each zombie's own max hit points at once and burns another 15% over 6 s, then a 2 s
//     cool-down (no swings). Percent-based, so it hurts every army alike.
//   - The knight (VideoGameStageKnightActor) raises its shield for 1.5 s and SLAMS every
//     10 s: everyone in the front area is stunned for 2 s and takes twice its ordinary hit.
//   - Zedzox (VideoGameStageBossActor) keeps his turn, pixel fire and debris throws and adds
//     MAGIC while he is up on his perch: every 8 s, a 3 s charge and then either a beam that
//     sweeps from the front of the army to the Gardens at the back, or a fireball lobbed
//     onto the front group that sends it flying (BattleSim.stepBossMagic).
//
// TUNED AS SIDEGRADES (owner, 2026-11-12: "interesting side grades, not massive upgrades").
// Real elite armies rebuilt from prod and flown against the old crew and this one: the beam
// first stunned everyone it passed for 1 s, which alone cost an expert pilot a zombie in
// 12 of 16 runs (no swings, no heals, while the wave kept hitting), so it carries no stun;
// an elite-priced beam (a quarter of a veteran, mutated Nightshade, 800) overshot, so both
// modes price off the base Nightshade; and the crew's damage sits at 85% of the first cut
// (str 13/13/7), which brings a weak 8-zombie elite army flown competently back to the old
// crew's numbers while a well-flown one does a little better than before.
// Second pass (owner: knight no knockback, Zedzox no throws; and the moves now wait for
// contact so they always land): Zedzox's turn and pixel fire keep their old rate (their
// cooldowns stretched x1.37 now throws no longer share his budget), the crew's damage drops
// 10% more (11.7/11.7/6.3) and the magic a quarter (300/240).
//
// A stun landed during a knight's or dragon's wind-up cancels the move (ChargeConfig
// .interruptible): the counter-play, and why neither counts as a "charger" to the duel logic.
//
// PURE and shared: composeFight attaches the moves for invasions (client, Worker, harness),
// and endless.ts's scaleEndlessEnemy for Endless floors (both sides), so one definition
// drives every simulation.
import { countHitDamage } from "./countSlam";
import { POISE_THRESHOLD, type ChargeConfig } from "./dualInvasion";
import type { BossMagicConfig, CombatUnit } from "./types";

export const VG_DRAGON_KEY = "VideoGameStageMonsterActor";
export const VG_KNIGHT_KEY = "VideoGameStageKnightActor";
export const VG_BOSS_KEY = "VideoGameStageBossActor";

/** The dragon's gout. */
export const GOUT_WINDUP_MS = 2_000;
export const GOUT_COOLDOWN_MS = 2_000;
export const GOUT_PERIOD_MS = 12_000;
export const GOUT_BURST_PCT = 0.10;
export const GOUT_BURN_PCT = 0.15;
export const GOUT_BURN_MS = 6_000;

/** The knight's shield slam. */
export const SHIELD_SLAM_WINDUP_MS = 1_500;
export const SHIELD_SLAM_PERIOD_MS = 10_000;
export const SHIELD_SLAM_STUN_MS = 2_000;
/** The slam, as a multiple of the knight's own ordinary hit (so Brain Tickets, dual rungs and
 *  Endless depth all scale it the way they scale his swing). */
export const SHIELD_SLAM_HIT_MULT = 2;

/** Zedzox's magic. */
export const MAGIC_EVERY_MS = 8_000;
export const MAGIC_CAST_MS = 3_000;
export const MAGIC_BEAM_SWEEP_MS = 1_200;
/** The beam stuns nobody (see TUNED AS SIDEGRADES above); kept as a dial. */
export const MAGIC_BEAM_STUN_MS = 0;

/** A stage-appropriate Garden for raid 9: the Obsidian Nightshade Zombie (level 40), the
 *  Garden a level-43 army fields, as grown (con 16 → 1,600). The same price ordinary and
 *  elite: the elite-priced spells overshot (see TUNED AS SIDEGRADES). */
export const VG_STAGE_GARDEN_HP = 1_600;
/** The owner asked for a quarter of that Garden; the tune landed at three quarters of that
 *  (300) once the moves always connected, and the fireball at 240. */
export const MAGIC_BEAM_GARDEN_SHARE = 0.1875;
export const MAGIC_FIREBALL_GARDEN_SHARE = 0.15;
/** Endless prices both spells off Zedzox's own composed hit instead (so floor depth scales
 *  them): this many of his hits. Set so the ordinary raid-9 price comes out the same — his
 *  composed raid-9 hit is 190.8, so 1.575 hits is the 300 beam and 1.26 the 240 fireball. */
export const MAGIC_BEAM_HITS = 1.575;
export const MAGIC_FIREBALL_HITS = 1.26;

export function goutFor(): ChargeConfig {
  return {
    windupMs: GOUT_WINDUP_MS,
    recoveryMs: GOUT_PERIOD_MS - GOUT_WINDUP_MS,
    damage: 0,
    poiseThreshold: POISE_THRESHOLD,
    poiseDrainPerSec: 0,
    staggerMs: 0,
    target: "front-area",
    effect: "gout",
    burstPct: GOUT_BURST_PCT,
    burnPct: GOUT_BURN_PCT,
    burnMs: GOUT_BURN_MS,
    channel: true,
    lockoutMs: GOUT_COOLDOWN_MS,
    interruptible: true,
  };
}

export function shieldSlamFor(knight: CombatUnit): ChargeConfig {
  return {
    windupMs: SHIELD_SLAM_WINDUP_MS,
    recoveryMs: SHIELD_SLAM_PERIOD_MS - SHIELD_SLAM_WINDUP_MS,
    damage: Math.round(SHIELD_SLAM_HIT_MULT * countHitDamage(knight)),
    poiseThreshold: POISE_THRESHOLD,
    poiseDrainPerSec: 0,
    staggerMs: 0,
    target: "front-area",
    effect: "shieldSlam",
    stunMs: SHIELD_SLAM_STUN_MS,
    channel: true,
    interruptible: true,
  };
}

function magic(beamDamage: number, blastDamage: number): BossMagicConfig {
  return {
    everyMs: MAGIC_EVERY_MS,
    castMs: MAGIC_CAST_MS,
    beamSweepMs: MAGIC_BEAM_SWEEP_MS,
    beamDamage: Math.round(beamDamage),
    beamStunMs: MAGIC_BEAM_STUN_MS,
    blastDamage: Math.round(blastDamage),
  };
}

/** Zedzox's magic in an invasion, priced against the stage's Garden (ordinary or elite). */
export function raidMagicFor(): BossMagicConfig {
  return magic(VG_STAGE_GARDEN_HP * MAGIC_BEAM_GARDEN_SHARE, VG_STAGE_GARDEN_HP * MAGIC_FIREBALL_GARDEN_SHARE);
}

/** Zedzox's magic on an Endless floor, priced off his own (depth-scaled) hit. */
export function endlessMagicFor(boss: CombatUnit): BossMagicConfig {
  const hit = countHitDamage(boss);
  return magic(MAGIC_BEAM_HITS * hit, MAGIC_FIREBALL_HITS * hit);
}

/** Give one unit its Video Games move, in place. A no-op for every other unit. A unit that
 *  already carries a charge (Endless's perched killer has the Count's slam) keeps it. */
export function attachVideoGameMove(u: CombatUnit, opts: { elite?: boolean; endless?: boolean } = {}): void {
  if (u.sourceKey === VG_DRAGON_KEY && !u.charge) u.charge = goutFor();
  else if (u.sourceKey === VG_KNIGHT_KEY && !u.charge) u.charge = shieldSlamFor(u);
  else if (u.sourceKey === VG_BOSS_KEY && u.isBoss) {
    u.magic = opts.endless ? endlessMagicFor(u) : raidMagicFor();
  }
}

/** Every Video Games unit in an invasion's composed list (raid 9, raid 14). */
export function attachVideoGameMoves(units: CombatUnit[], opts: { elite?: boolean } = {}): void {
  for (const u of units) attachVideoGameMove(u, opts);
}
