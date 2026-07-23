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
