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
import { addMutation, MUTATION_LIST, SLOTS } from "../../zombie/mutations";
import { buildRoster, mutationTierAt, type Group, type RosterSpec } from "./roster";
import { MAX_VET_RANK } from "../../zombie/traits";
import { BASE_ARMY_MAX } from "../../armyCapacity";
import { effectiveBin, effectiveStrength } from "./effectiveLadder";
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

// ---------------------------------------------------------------------------
// WHAT AN ORDINARY ACCOUNT LOOKS LIKE AT A GIVEN LEVEL
// ---------------------------------------------------------------------------
//
// The purple mark used to be a FIXED archetype — at most two of any species, nothing from
// the Pot, Veteran 2 — applied unchanged at every level. That is a description of a new
// account, and using it at level 49 said an ordinary endgame player has never mutated a
// zombie and has survived two invasions. The visible symptom was the mark freezing solid
// from level 26: ability tiers top out there, the stat ramp ends at 25, and with mutations
// and veterancy pinned there was nothing left that could move.
//
// So the ordinary account now PROGRESSES on the two channels a real one does: veterancy,
// which saturates early, and the QUALITY of what the Pot has put in its mutation slots.

/** Bodies an account of this kind fields at `level`.
 *
 *  `BASE_ARMY_MAX` is 16 and that is what every farm starts with, but it is not the cap: a
 *  Zombie Monolith adds +4, so a finished account fields TWENTY. Owner, 2026-09-24: "the
 *  current harness is slightly underselling the players armies, since late game players can
 *  have up to 20 zombies."
 *
 *  The Monolith unlocks at level 0 and costs brains, which is the scarce currency, so when
 *  it arrives is a question of priorities rather than of level. A maxed account buys it as
 *  soon as it has the brains; an ordinary one gets there later. Both end at twenty.
 *
 *  The grid's COLUMNS are still sixteen-zombie rosters (SWEEP_SIZE), because a column has
 *  to mean one thing — so a late mark is a twenty-body army placed on a scale built from
 *  sixteen-body ones. The effective metric sums over units, so that lands correctly on
 *  score; what it cannot capture is that twenty bodies also means a longer deploy queue. */
export function armySizeAt(_kind: MarkKind, _level: number): number {
  // PINNED AT 16 FOR NOW, and this is a known understatement rather than a belief.
  //
  // Twenty was tried and reverted the same day. The marks went to twenty bodies and their
  // scores to 575-764, but the grid's COLUMNS are built from sixteen-body rosters and their
  // top edge is 580 — so every mark from level 35 up piled into the last column and the
  // blue and purple marks collapsed onto each other, which destroys the one thing the two
  // marks exist to show.
  //
  // The metric is not the problem; the size regime is. Doing this properly means letting
  // the SAMPLER produce twenty-body rosters for the late and endgame eras and re-deriving
  // EFFECTIVE_EDGES over the wider range — at which point a mark and the column it lands in
  // are the same kind of army again. Until then the late marks sit a little left of where a
  // real finished account stands, which makes the grid slightly PESSIMISTIC about the
  // endgame and is the safer direction to be wrong in.
  return BASE_ARMY_MAX;
}

/** Survived invasions an ordinary account has by `level`.
 *
 *  Veterancy saturates early for anyone who replays — Master is the fifth survived
 *  invasion and the ladder stops there — so this reaches the cap around level 20 and
 *  stays. It is the fast channel. */
export function moderateInvasions(level: number): number {
  return Math.max(0, Math.min(MAX_VET_RANK, Math.floor(level / 4)));
}

const statSum = (m: { stats: { str?: number; dex?: number; con?: number } }) =>
  (m.stats.str ?? 0) + (m.stats.dex ?? 0) + (m.stats.con ?? 0);

/** The best mutation TIER an ordinary account is pulling out of the Pot by `level`.
 *
 *  Owner, 2026-09-23: "players will typically fill their mutation slots relatively early.
 *  Mutation progression is via getting better mutations." So the slow channel is not how
 *  MANY slots are filled, it is what is in them — an account fills what it can almost at
 *  once and then spends the rest of the game replacing a Cornhead with a Garlichead with a
 *  Pumpking. An earlier version of this had it backwards and filled one slot per era.
 *
 *  Nothing before the Pot is worth using; tier 1 from then; and the top tier late, because
 *  a Pumpking or a Heartichoke is the sort of thing an account has a few of rather than
 *  sixteen. */
export function moderateMutationTier(level: number): number {
  const pace = level < 10 ? 0 : level < 20 ? 1 : level < 32 ? 2 : level < 42 ? 3 : 4;
  // Never past what the account could possibly have: the tiers are colour classes and
  // gate on level (roster.mutationTierAt — Green 1, Blue 8, Red 15, Silver 25). An
  // ordinary player is SLOWER than that gate, never faster.
  return Math.min(pace, mutationTierAt(level));
}

/** What the Pot has managed by `level`: EVERY slot filled, with the best mutation that slot
 *  offers at or below the account's tier.
 *
 *  A slot whose cheapest option is above that tier stays empty, which is not a modelling
 *  choice but the catalog: `body` starts at tier 2 and `neck` at tier 3, so an early
 *  account genuinely cannot fill them however keen it is. That is why this still climbs
 *  even though the slots "fill early" — early means the three slots that have tier-1
 *  options, and the other two arrive with the tiers. */
export function moderateMutation(level: number): "none" | number {
  const maxTier = moderateMutationTier(level);
  if (maxTier <= 0) return "none";
  let mask = 0;
  for (const slot of SLOTS) {
    const best = MUTATION_LIST
      .filter((m) => m.slot === slot && m.tier <= maxTier)
      .sort((a, b) => statSum(b) - statSum(a))[0];
    if (best) mask = addMutation(mask, best.bit, false);
  }
  return mask;
}

/** The roster one mark stands for, at one account level. */
export function markRoster(kind: MarkKind, level: number): RosterSpec {
  const base: RosterSpec = {
    pattern: kind === "minMaxed" ? MINMAX_SHAPE : MARK_SHAPE,
    size: armySizeAt(kind, level),
    catalogLevel: level,
    playerLevel: level,
    abilityTiers: abilityTiersAt(level),
  };
  return kind === "moderate"
    ? {
        ...base,
        mutation: moderateMutation(level),
        invasions: moderateInvasions(level),
        maxPerSpecies: 2,
        // A farmer head is cheap and near-universal once the player is raiding regularly.
        farmerLifeMult: level >= 26 ? 1.1 : undefined,
      }
    // The ceiling is the best an account at this level COULD field — which is not
    // best-in-slot at every level. Mutation tiers are colour classes and gate on level
    // like any other species; applying tier 4 at level 10 put Pumpkings on Greens and
    // made a maxed level-10 army beat every invasion up to level 43.
    : { ...base, mutation: "best", mutationTier: mutationTierAt(level), invasions: 5, farmerLifeMult: 1.1 };
}

export interface Mark {
  kind: MarkKind;
  level: number;
  strength: number;
  /** Which STRENGTH_EDGES column it lands in. */
  bin: number;
}



/** Every mark for an account at `level`. */
export function marksAt(level: number): Record<MarkKind, Mark> {
  const at = (kind: MarkKind): Mark => {
    const roster = buildRoster(markRoster(kind, level));
    // Marks bin on the same axis the columns do, or they would point at the wrong one.
    const strength = effectiveStrength(roster.units);
    return { kind, level, strength, bin: effectiveBin(strength) };
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
