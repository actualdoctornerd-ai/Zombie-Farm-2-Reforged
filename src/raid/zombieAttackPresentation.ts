export type ZombieBasicAttackName = "ZombieBite" | "ZombieScratch";

/**
 * Select the presentation for a zombie's current basic swing.
 *
 * Every zombie alternates after each completed attack. The stable per-unit seed
 * offsets its first swing, so a staggered horde does not all bite (or scratch)
 * together. This is presentation-only and does not alter combat damage or timing.
 */
export function zombieBasicAttackName(
  unitSeed: number,
  completedAttacks: number
): ZombieBasicAttackName {
  return ((unitSeed + completedAttacks) & 1) === 0
    ? "ZombieBite"
    : "ZombieScratch";
}

/** Where in each basic swing the blow connects, on the SOURCE animation's own timeline
 *  (recovered ZFAttackAnims). RaidActor.poseBite / poseScratch rotate their envelopes by
 *  exactly these numbers and the renderer measures the follow-through window from them,
 *  so the two must agree — they read this rather than each holding a copy, and
 *  raid/attackPhase.test.ts pins the pose at both ends against it. */
export const ZOMBIE_ATTACK_DAMAGE_TIMING: Readonly<Record<ZombieBasicAttackName, number>> = {
  ZombieBite: 0.75,
  ZombieScratch: 0.5,
};

export function zombieAttackDamageTiming(name: ZombieBasicAttackName): number {
  return ZOMBIE_ATTACK_DAMAGE_TIMING[name];
}

/** The authored clip a basic swing looks for, if the rig ships one. The Rig Studio names
 *  these "attack:bite" / "attack:scratch" rather than by the source's animation name, so
 *  this is the one place that mapping lives — RaidActor poses through it and the renderer
 *  asks through it which timeline the pose will run on. */
export function zombieAttackClipName(name: ZombieBasicAttackName): string {
  return name === "ZombieScratch" ? "attack:scratch" : "attack:bite";
}
