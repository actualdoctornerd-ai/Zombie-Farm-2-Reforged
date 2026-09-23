// What a player actually HAS when a fight opens.
//
// The strength grid answers "how hard is this fight for an army of size N". That is only
// half a difficulty reading: the other half is where the player is standing when they meet
// it. A fight that needs a 374-strength party is trivial at level 50 and impossible at
// level 20, and the grid cannot say which without knowing what level 20 can field.
//
// So this puts two marks on each row — the two ends of the same account:
//
//   · CEILING — the strongest party that could exist at that level. Best obtainable
//     species with no duplicate cap, best-in-slot mutations, Master veterancy, the
//     farmer's life head, and every ability tier whose boss is already reachable. Nobody
//     has quite this, and that is the point: it is the right-hand wall.
//   · MODERATE — the same shape, played normally. A mix rather than a stack (at most two
//     of any species, which is what an account earning prizes one at a time actually
//     owns), nothing from the Pot, Veteran 2 rather than Master, no farmer head.
//
// THREE THINGS ARE HELD THE SAME as the grid itself, so a mark lands on the column scale
// rather than beside it:
//
//   1. SIXTEEN BODIES. Not an assumption — `BASE_ARMY_MAX` is 16 and every farm starts
//      there; only a placed Monolith pushes it higher. So the grid's pinned sixteen is
//      what a player has at every level, and the marks need no size fudge.
//   2. THE PARTY FLOOR. Both marks field two healers and a body, like every roster in the
//      table. A mark that ignored it would drift right (the Garden and the Headless are
//      the two classes the Strength Ladder scores worst) and point at a column whose
//      armies are not parties — see composition.ts PARTY_FLOOR.
//   3. ONE SHAPE FOR BOTH. Blue against purple is meant to read as "maxed account vs
//      ordinary account", so the composition is held still and only the account moves.
//      Deploy order is not varied because it does not enter the Strength Ladder at all.
//
// What is NOT held the same, deliberately, is the level: these rosters are built at the
// unlock level, so the stat ramp (still climbing below 25) is in the number. That is the
// honest reading — an early army is weaker than the same species would be later — and it
// is why the early rows' marks sit further left than their species alone would suggest.
import raidsJson from "../../../public/assets/raids/raids.json";
import { buildRoster, type Group, type RosterSpec } from "./roster";
import { STRENGTH_EDGES, SWEEP_SIZE } from "./strengthSweep";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

/** The raid whose boss gates each ability tier, by id.
 *
 *  `traits.TIER_BOSS` names them as display text ("the Lawyers"), which is not something
 *  to match raid names against — so the mapping is explicit here and the levels come off
 *  raids.json, which means retuning an unlock level moves this with it. */
const TIER_RAID: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3, 4: 4 };

/** Ability tiers open to an account at `level`.
 *
 *  Keyed on the tier boss's raid being UNLOCKED rather than beaten, which is the
 *  optimistic reading and the right one for a ceiling: a player who can enter the fight
 *  beats it soon after. It costs the moderate mark a little accuracy right at each
 *  threshold and nothing anywhere else. */
export function abilityTiersAt(level: number): number {
  let tiers = 0;
  for (let tier = 1; tier <= 4; tier++) {
    const raid = raids.find((r) => r.id === TIER_RAID[tier]);
    const unlock = (raid as { unlockLevel?: number } | undefined)?.unlockLevel ?? 0;
    if (level >= unlock) tiers = tier;
  }
  return tiers;
}

/** The composition both marks are built on: the party floor plus ten damage, which is
 *  close to the middle of what the cohort samplers produce and satisfies the floor
 *  without leaning on it. Order is irrelevant — the Strength Ladder sums over units. */
const MARK_SHAPE: readonly Group[] = [
  "Headless", "Garden", "Regular", "Regular", "Headless", "Garden", "Regular", "Regular",
  "Headless", "Garden", "Regular", "Regular", "Large", "Large", "Small", "Female",
];

/** The shape that MAXIMISES the Strength Ladder rather than the fight: the party floor's
 *  bare minimum of support and everything else in the two classes the ladder scores
 *  highest. Not a recommendation and not drawn on the grid — it exists to answer "how far
 *  right can the axis be pushed at all", which turns out to be much further than a
 *  balanced party reaches: at level 50 this scores ~650 against the balanced ceiling's
 *  ~500, without being a better army. A Headless is the reason. The best one has
 *  constitution 46 and dexterity 1.0, so `str·dex·con` rates it at about a seventh of a
 *  Madame — the ladder cannot tell the difference between a tank and dead weight.
 *
 *  Reported alongside the marks so the page can say why no blue mark reaches the last
 *  column, instead of the reader assuming the column is unreachable. */
const MINMAX_SHAPE: readonly Group[] = [
  "Headless", "Garden", "Garden",
  ...Array<Group>(7).fill("Female"), ...Array<Group>(6).fill("Regular"),
];

export type MarkKind = "ceiling" | "moderate" | "minMaxed";

/** The roster one mark stands for, at one account level. */
export function markRoster(kind: MarkKind, level: number): RosterSpec {
  const base: RosterSpec = {
    pattern: kind === "minMaxed" ? MINMAX_SHAPE : MARK_SHAPE,
    size: SWEEP_SIZE,
    catalogLevel: level,
    playerLevel: level,
    abilityTiers: abilityTiersAt(level),
  };
  return kind === "moderate"
    ? { ...base, mutation: "none", invasions: 2, maxPerSpecies: 2 }
    : { ...base, mutation: "best", invasions: 5, farmerLifeMult: 1.1 };
}

export interface Mark {
  kind: MarkKind;
  level: number;
  strength: number;
  /** Which STRENGTH_EDGES column it lands in. */
  bin: number;
}

function binOf(strength: number): number {
  const bin = STRENGTH_EDGES.findIndex(
    (lo, i) => strength >= lo && strength < STRENGTH_EDGES[i + 1]
  );
  // A ladder score above the last edge is impossible (the top bin is open-ended), but a
  // future edge table could close it — pin to the last column rather than drop the mark.
  return bin < 0 ? STRENGTH_EDGES.length - 2 : bin;
}

/** Every mark for an account at `level`. */
export function marksAt(level: number): Record<MarkKind, Mark> {
  const at = (kind: MarkKind): Mark => {
    const strength = buildRoster(markRoster(kind, level)).strength;
    return { kind, level, strength, bin: binOf(strength) };
  };
  return { ceiling: at("ceiling"), moderate: at("moderate"), minMaxed: at("minMaxed") };
}

export interface FightMarks {
  label: string;
  unlock: number;
  /** The strongest BALANCED party at that level — the blue mark. */
  ceiling: Mark;
  /** An ordinary account's party at that level — the purple mark. */
  moderate: Mark;
  /** The highest ladder score reachable at all, balanced or not. Context, not a mark. */
  minMaxed: Mark;
}

/** Marks for every row of the strength grid, keyed the way the grid labels them.
 *
 *  Cheap — it builds two rosters per distinct level and flies nothing — so it is emitted
 *  by its own report rather than riding the 54,000-flight sweep. */
export function allMarks(fights: readonly { label: string; unlock: number }[]): FightMarks[] {
  const cache = new Map<number, Record<MarkKind, Mark>>();
  return fights.map((fight) => {
    // Dual-invasion rungs carry a fractional unlock purely to order the rows; the account
    // meeting them is at the raid's own level.
    const level = Math.floor(fight.unlock);
    if (!cache.has(level)) cache.set(level, marksAt(level));
    const marks = cache.get(level)!;
    return { label: fight.label, unlock: fight.unlock, ...marks };
  });
}
