// Repeat-invasion XP — what a win pays AFTER the first clear.
//
// A DELIBERATE DIVERGENCE from the binary. ZF2 pays XP for an invasion exactly once,
// on the first-ever win (`firstTimeBeatingEnemy`; see RaidManager.finishRaid and the
// reward-xp ground truth). That stays: the first clear still pays the enemy's big
// authored `xp`. This adds a small, permanent trickle on top of every LATER win, so
// invading is never worth literally zero XP.
//
// PRICED FROM THE UNLOCK LEVEL, NOT THE PLAYER'S. Each raid's value is 1% of the XP
// required to advance from the level at which that raid UNLOCKS, floored at 10:
//
//   raid                    unlocks   XP to next level there   1%    pays
//   Old McDonnell's Farm       1                 25            0.25   10  (floor)
//   Valentine's Day            6                175            1.75   12  (set)
//   Tree World                 8                500            5      12  (set)
//   Summer Break              10                500            5      12  (set)
//   Zombies vs Circus         12                500            5      14  (set)
//   Zombies vs Lawyers        16              1,000           10      16  (set)
//   Zombies vs Pirates        21              2,000           20      20
//   Zombies vs Ninjas         26              5,000           50      50
//   Zombies vs Robots         31              8,000           80      80
//   Zombies vs Aliens         36             10,000          100     100
//   Zombies vs Video Games    43             14,000          140     140
//
// The four "set" values are hand-placed, not derived. Below level 20 the 1% formula
// collapses onto the 10 floor — levels 8 through 19 all cost 500-1,000 XP, so five
// different raids would price identically — and a later raid paying the same as an
// earlier one reads as a bug. 12 / 14 / 16 restores a rising ladder across the four
// rungs the floor flattened. The table is monotonic in unlock level BY DESIGN and
// repeatXp.test.ts holds it that way.
//
// WHY UNLOCK LEVEL RATHER THAN CURRENT LEVEL. This is the whole anti-farming design.
// A fixed per-raid value means grinding an easy old invasion is permanently worth
// what that invasion was worth — a level-45 player farming McDonnell's earns 10 a
// win, forever. Pricing on the PLAYER's level instead would have paid that same
// player 250 for the same trivial fight. Do not "improve" this into a level-scaled
// formula; the flatness is the point.
//
// NOT A RULESET CHANGE. This is a reward, not a fight rule — it is priced from the
// raid id and the elite flag, both of which the server already owns, and it changes
// no deterministic transcript. Editing the table does NOT require a
// RAID_RULESET_VERSION bump (unlike eliteInvasion.ts, which does).

import { ELITE_BRAIN_LUCK } from "./eliteInvasion";

/** Per-raid XP for a repeat win, keyed by raids.json `id`. See the table above. */
export const REPEAT_INVASION_XP: Readonly<Record<number, number>> = {
  1: 10,  // Old McDonnell's Farm — unlock 1
  2: 16,  // Zombies vs Lawyers — unlock 16
  3: 20,  // Zombies vs Pirates — unlock 21
  4: 50,  // Zombies vs Ninjas — unlock 26
  5: 80,  // Zombies vs Robots — unlock 31
  6: 100, // Zombies vs Aliens — unlock 36
  7: 12,  // Summer Break — unlock 10
  8: 14,  // Zombies vs Circus — unlock 12
  9: 140, // Zombies vs Video Games — unlock 43
  10: 12, // Tree World — unlock 8
  11: 12, // Valentine's Day — unlock 6
};

/** What a Brain Ticket multiplies the repeat XP by.
 *
 *  Deliberately the same figure as ELITE_BRAIN_LUCK — an elite invasion already pays
 *  4x on brains and rare zombies, and XP riding the same multiplier keeps the ticket a
 *  single legible promise ("everything, four times") instead of a third rate to learn.
 *  Imported rather than re-typed so the two can never drift apart. */
export const ELITE_REPEAT_XP_MULTIPLIER = ELITE_BRAIN_LUCK;

/** The floor every raid's value is priced against (see the header table). Exported for
 *  the derivation test, which re-derives the un-set rungs from XP_THRESHOLDS. */
export const REPEAT_XP_FLOOR = 10;

/** XP for a win that is NOT the first clear of this raid. Returns 0 for an unknown
 *  raid id, so a new invasion added without a table entry pays nothing rather than
 *  falling back to some other raid's figure. */
export function repeatInvasionXp(raidId: number, elite = false): number {
  const base = Object.prototype.hasOwnProperty.call(REPEAT_INVASION_XP, raidId)
    ? REPEAT_INVASION_XP[raidId]
    : 0;
  return elite ? base * ELITE_REPEAT_XP_MULTIPLIER : base;
}

/** The XP a win pays, first clear or not: the authored first-clear bonus on the very
 *  first win, the repeat trickle on every one after. The two never stack — a first
 *  clear pays its (far larger) authored figure and nothing else.
 *
 *  ONE definition, called by both the offline client (RaidManager.finishRaid) and the
 *  authoritative server (v3/raid.ts finishRaid), so the two builds cannot disagree
 *  about what a win was worth. */
export function invasionWinXp(
  raidId: number,
  firstClearXp: number,
  firstClear: boolean,
  elite = false
): number {
  return firstClear ? Math.max(0, firstClearXp) : repeatInvasionXp(raidId, elite);
}
