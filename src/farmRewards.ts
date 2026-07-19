export const BASE_PLOW_XP = 1;
export const PLOWING_MONOLITH_HARVEST_XP = 1;

/** The Plowing Monolith moves the repeatable plow XP onto time-gated harvests. */
export function plowXp(hasPlowingMonolith: boolean): number {
  return hasPlowingMonolith ? 0 : BASE_PLOW_XP;
}

export function harvestXp(baseXp: number, hasPlowingMonolith: boolean): number {
  return baseXp + (hasPlowingMonolith ? PLOWING_MONOLITH_HARVEST_XP : 0);
}
