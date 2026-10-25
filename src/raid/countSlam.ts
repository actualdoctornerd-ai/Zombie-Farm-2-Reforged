// THE COUNT'S SLAM (raid 16, Halloween). Count von Uberbiss borrows the pirate captain's
// charge (raid 13, dualInvasion.ts): once he is down on the ground and fighting he winds up
// for COUNT_SLAM_WINDUP_MS, swelling and reddening as it fills, then slams the FRONT
// deployed zombie for COUNT_SLAM_MULT times his own hit. Stuns fill the same poise bar and
// break it, staggering him. Owner design, 2026-10-24 (3 s, 10x, front zombie only; briefly 8x).
//
// One target, not the captain's whole line: at 10x his hit the slam is 3,000 on night 1 and
// 6,000 on night 2, past the hit points of every deployed zombie from night 2, so the
// all-army version measured as "nothing, or a wipe" (level 20 wiped on night 2, an
// ordinary level-45 army on night 5). Aimed at the front it is a tank-buster: 3,000 x the
// night, so a maxed, mutated Plasmahead (5,438) takes night 1's and dies to night 2's unless
// another Protect carrier covers it (-20% each).
//
// The slam is priced off his OWN hit as composed, so whatever already scales that hit
// (level ramp, Brain Ticket, the night chain's damage step) scales the slam with it.
//
// PURE and shared: composeFight attaches it on the client, the Worker and the harness alike.
import { POWER_PER_STR, deriveHitDamage } from "./combatStats";
import { POISE_THRESHOLD, STAGGER_MS, type ChargeConfig } from "./dualInvasion";
import type { CombatUnit } from "./types";
import { HALLOWEEN_RAID_ID } from "./zombieDrops";

/** The Count's key in enemy_stats.json. */
export const COUNT_KEY = "HalloweenStageActorBoss";
/** Wind-up before the slam lands. */
export const COUNT_SLAM_WINDUP_MS = 3_000;
/** The slam, as a multiple of one of his ordinary hits. */
export const COUNT_SLAM_MULT = 10;
/** The pause after a slam or a broken charge before the next wind-up begins. */
export const COUNT_SLAM_RECOVERY_MS = 7_000;

/** One of the Count's ordinary hits, before armour: str x 10 x his attack's multiplier. */
export function countHitDamage(boss: CombatUnit): number {
  return deriveHitDamage(boss.str * POWER_PER_STR, boss.attacks[0]?.mult ?? 1);
}

/** The charge the Count carries, priced off his composed hit. */
export function countSlamFor(boss: CombatUnit): ChargeConfig {
  return {
    windupMs: COUNT_SLAM_WINDUP_MS,
    recoveryMs: COUNT_SLAM_RECOVERY_MS,
    damage: Math.round(COUNT_SLAM_MULT * countHitDamage(boss)),
    poiseThreshold: POISE_THRESHOLD,
    poiseDrainPerSec: 0,
    staggerMs: STAGGER_MS,
    target: "front-deployed",
  };
}

/** Give the Count his slam, in place. A no-op on every other invasion. */
export function attachCountSlam(raidId: number, units: CombatUnit[]): void {
  if (raidId !== HALLOWEEN_RAID_ID) return;
  for (const u of units) if (u.isBoss && u.sourceKey === COUNT_KEY) u.charge = countSlamFor(u);
}
