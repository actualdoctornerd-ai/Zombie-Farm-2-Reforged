// PRACTICE MODE for the four dual invasions — the playable prototype (owner, 2026-09-27).
//
// While the tier ladders are being tuned, raids 12-15 are open to endgame players as a
// no-stakes test: every tier of every dual invasion is available from level 40, and a fight
// costs and pays nothing.
//
//   · no reward — no gold, XP, brains, loot, rare zombie, veterancy, quest or statistic
//     progress, and no tier clear recorded;
//   · no risk — nobody dies for real: every zombie comes home and there is no revival;
//   · no cost — no cooldown started or checked, no Invasion Voucher, no Golden Dice, no
//     Concentration, and no Brain Ticket (the dual invasions already refuse one).
//
// Self-contained on purpose (no imports), because RaidCatalog, the Worker's catalog and the
// HUD all read it and dualInvasion.ts already imports RaidCatalog. The Worker enforces all
// of it; the client mirrors it so the screens say the same thing.
//
// TO END THE PROTOTYPE: set DUAL_PRACTICE to false. Every gate below falls back to the
// ordinary rules (the raid's own unlock level, the climbed ladder, full settlement).

/** The switch. */
export const DUAL_PRACTICE = true;

/** Player level at which every dual invasion opens while practice is on. */
export const PRACTICE_UNLOCK_LEVEL = 40;

/** The dual invasions (mirrors dualInvasion.DUAL_INVASION_IDS; kept local to stay import-free). */
const PRACTICE_RAID_IDS: readonly number[] = [12, 13, 14, 15];

/** Whether this invasion is fought as practice right now. */
export function isPracticeRaid(raidId: number): boolean {
  return DUAL_PRACTICE && PRACTICE_RAID_IDS.includes(raidId);
}

/** The level an invasion opens at — practice lowers the dual invasions to 40. */
export function effectiveUnlockLevel(raid: { id: number; unlockLevel: number }): number {
  return isPracticeRaid(raid.id) ? PRACTICE_UNLOCK_LEVEL : raid.unlockLevel;
}
