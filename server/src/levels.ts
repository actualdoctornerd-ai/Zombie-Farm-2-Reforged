// Server mirror of the client XP→level curve (src/GameState.ts XP_THRESHOLDS,
// build-verified from PlayerLevels.plist). Because the balance's `xp` is now
// server-owned, level and the per-level reward are derived SERVER-SIDE and need no
// client assertion — a modified client can't grant itself level-up brains or unlock
// content early by claiming a level.
//
// KEEP IN SYNC with src/GameState.ts XP_THRESHOLDS (45 tiers → levels 1..45).

export const XP_THRESHOLDS = [
  0, 25, 75, 150, 250, 375, 550, 800, 1300, 1800, 2300, 2800, 3300, 3900, 4500,
  5500, 6500, 7500, 8500, 9500, 11500, 13500, 15500, 17500, 20500, 25000, 30000,
  35000, 40000, 46000, 53000, 61000, 69000, 78000, 87000, 97000, 107000, 117000,
  127000, 137000, 151000, 165000, 179000, 193000, 218000,
] as const;

/** The player level for a given total XP (level 1 at 0 XP; each threshold crossed is
 *  +1 level, capped at the top tier). Matches GameState.get level. */
export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) lvl = i + 1;
  }
  return lvl;
}

/** Brains granted when advancing from `fromLevel` to `toLevel`.
 *
 *  Post-brainflation revert: leveling up grants NO brains (mirrors GameState.onLevelUp).
 *  The old +1-brain-per-level drip was removed now that a brain is ~10x more valuable.
 *  Kept as a function (returning 0) so the v3 economy call sites stay stable and a future
 *  milestone-based grant, if wanted, has one place to live. */
export function levelUpBrains(_fromLevel: number, _toLevel: number): number {
  return 0;
}
