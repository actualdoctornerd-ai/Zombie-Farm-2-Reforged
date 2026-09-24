/** Player level at which ordinary Zombie Pot combinations can promote: to the
 * body type's silver (tier-4) for a matched pair, or — rarely — to its hidden
 * tier-5 special. */
export const COMBINE_SPECIAL_LEVEL = 25;

/** Chance that an eligible non-special pair promotes to its type's special. The
 *  server imports this same constant (server/src/v3/engine.ts), so the authoritative
 *  result can never disagree with the one the client previewed. */
export const COMBINE_SPECIAL_CHANCE = 0.25;

/** The combining-only tier-5 representative for each zombie body type. */
export const COMBINE_SPECIAL_BY_GROUP: Readonly<Record<string, string>> = {
  Garden: "ZombieActorGardenTier5",       // Zombutterfly
  Large: "ZombieActorLargeTier5",         // Zomviking
  Small: "ZombieActorSmallTier5",         // Zombricaun
  Female: "ZombieActorGirlTier5",         // Zombelly Dancer
  Regular: "ZombieActorRegularTier5",     // Zombotron
  Headless: "ZombieActorHeadlessTier5",   // Skull Head
};

/** The silver (tier-4) representative for each zombie body type — what a pair of
 * identical RED parents breeds up into at COMBINE_SPECIAL_LEVEL+. */
export const COMBINE_SILVER_BY_GROUP: Readonly<Record<string, string>> = {
  Garden: "ZombieActorGardenTier4",       // Zombee
  Large: "ZombieActorLargeTier4",         // Zombarian
  Small: "ZombieActorSmallTier4",         // Imp Zombie
  Female: "ZombieActorGirlTier4",         // Zombielocks
  Regular: "ZombieActorRegularTier4",     // Robo Zombie
  Headless: "ZombieActorHeadlessTier4",   // Party Zombie
};

/** The blue (tier-2) representative for each body type — what a matched pair of
 * GREEN parents breeds up into once the Blue Grave is owned. */
export const COMBINE_BLUE_BY_GROUP: Readonly<Record<string, string>> = {
  Garden: "ZombieActorGardenTier2",       // ZomBotanist
  Large: "ZombieActorLargeTier2",         // ZomBruiser
  Small: "ZombieActorSmallTier2",         // Zmurf
  Female: "ZombieActorGirlTier2",         // ZomBeauty
  Regular: "ZombieActorRegularTier2",     // Zyborg
  Headless: "ZombieActorHeadlessTier2",   // Kindlehead
};

/** The red (tier-3) representative for each body type — what a matched pair of
 * BLUE parents breeds up into once the Red Grave is owned. */
export const COMBINE_RED_BY_GROUP: Readonly<Record<string, string>> = {
  Garden: "ZombieActorGardenTier3",       // Flower Zombie
  Large: "ZombieActorLargeTier3",         // ZomBrute
  Small: "ZombieActorSmallTier3",         // ZomGoblin
  Female: "ZombieActorGirlTier3",         // Amazombie
  Regular: "ZombieActorRegularTier3",     // Zombot
  Headless: "ZombieActorHeadlessTier3",   // Flamehead
};

/** The colour ladder a matched pair climbs: the class one band up, and the
 *  representatives to breed into. Silver is deliberately absent — the Red -> Silver
 *  step is the level-gated one below, not a grave-gated one. */
const COMBINE_NEXT_CLASS: Readonly<Record<string, {
  color: "Blue" | "Red";
  byGroup: Readonly<Record<string, string>>;
}>> = {
  Green: { color: "Blue", byGroup: COMBINE_BLUE_BY_GROUP },
  Blue: { color: "Red", byGroup: COMBINE_RED_BY_GROUP },
};

/** Does the player own the coloured grave that unlocks a zombie class? Blue and Red
 *  graves gate the matched-pair ladder exactly as they gate planting that class, so a
 *  combine can never hand out a colour the farm has not unlocked. Injected because
 *  neither the pot nor the shared selector can see the farm: the client passes
 *  `Field.hasGrave`, the server reads its own placed objects. */
export type CombineGraveUnlock = (color: "Blue" | "Red" | "Silver" | "Obsidian") => boolean;

/** Already at the silver tier? Such a parent is its own "silver of the correct
 *  type", so a matched pair keeps it rather than flattening the mutant silvers
 *  (Eyebiscus / Heartichoke) down to the plain one for their group. Only consulted
 *  for a job persisted without `className` — the class is authoritative where it is
 *  known, because the mutant classes were deliberately re-banded away from the
 *  `Tier<n>` token in their key (Lima Beans is a silver under a Tier2 key). */
function isSilverKey(key: string): boolean {
  return /Tier4/.test(key);
}

/** An Obsidian parent — the gravestone tier ABOVE the Silvers (tools/obsidian_zombies.py).
 *  It sits above every rung the Pot can reach: the tier-5 roll would trade it for a
 *  weaker seasonal special and the silver step for a Silver, so slot 1 simply keeps
 *  it. Obsidians are bought from their own grave, never bred. The key test covers a
 *  job persisted without `className`, like isSilverKey. */
function isObsidian(parent: CombineSpeciesParent): boolean {
  return parent.className ? parent.className === "Obsidian" : /Tier6/.test(parent.key);
}

/**
 * Did the Pot produce a species that neither parent was? Only such a genuine
 * promotion — a matched pair breeding up to its silver, or the rare tier-5 roll
 * — counts for the "Combine for a <silver>" quests (21 / 22).
 *
 * Without this the objectives were self-serving: slot 1 wins by default, so a
 * player who already owned a Zombarian could re-cook it against anything (or
 * against a second Zombarian, which `isSilverKey` keeps at tier 4) and get the
 * same Zombarian back out — collecting it fired the harvest notification and
 * closed the requirement without breeding anything.
 */
export function isCombinePromotion(resultKey: string, keyA: string, keyB: string): boolean {
  return resultKey !== keyA && resultKey !== keyB;
}

export interface CombineSpeciesParent {
  key: string;
  /** Body type — the only trait besides `isSpecial` that still affects selection
   *  (it names the tier-5 the slot-1 parent can promote to). */
  group?: string;
  /** Colour class (Green / Blue / Red / Silver / Special / Yellow). Drives the
   *  matched-pair ladder. Absent on a job persisted before the ladder existed, which
   *  falls back to the old key-shaped silver test. */
  className?: string;
  isSpecial?: boolean;
  /** No longer read: slot 1 decides the output species, so combat tier and
   *  mutant-donor status cannot change it. Both remain on the interface because
   *  jobs persisted by an older client still carry them (see ZombiePotSave). */
  tier?: number;
  isMutant?: boolean;
}

/** Stable pseudorandom stream for one unordered parent pair. Both the timed
 * client pot and authoritative server use this so collection can never display a
 * different species from the one the server grants. */
export function createCombineRandom(parentAId: string, parentBId: string): () => number {
  const seedText = [parentAId, parentBId].sort().join("\u0000");
  let state = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) {
    state ^= seedText.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Choose the Zombie Pot's output species: slot 1's, except that a matched pair
 * climbs the colour ladder and any eligible pair can rarely promote to the tier-5
 * special. The result is null only for the prohibited special + special pairing.
 *
 * The matched-pair ladder (two parents of the SAME species) runs
 * Green -> Blue -> Red -> Silver:
 *   * two Greens breed into their body type's Blue once the Blue Grave is owned;
 *   * two Blues breed into its Red once the Red Grave is owned;
 *   * two Reds reach the top step — the body type's Silver at COMBINE_SPECIAL_LEVEL+,
 *     or, on the rare roll, its tier-5 Special.
 * A step whose grave is missing simply falls through to the ordinary rules, so it
 * takes nothing away from a farm that has not unlocked that colour yet.
 *
 * Event/reward-only eligibility is intentionally enforced by the caller because
 * that catalog flag is not part of a persisted combine job.
 */
export function selectCombineSpecies(
  a: CombineSpeciesParent,
  b: CombineSpeciesParent,
  playerLevel: number,
  random: () => number = Math.random,
  hasGrave: CombineGraveUnlock = () => false
): string | null {
  if (a.isSpecial && b.isSpecial) return null;
  // Named special species are permanent. New combines only allow them in slot 1,
  // but retaining this symmetric fallback lets an older persisted slot-2 job
  // finish without losing its special parent.
  if (a.isSpecial !== b.isSpecial) return a.isSpecial ? a.key : b.key;
  if (isObsidian(a)) return a.key;

  const matched = a.key === b.key;
  // Lower ladder steps are checked BEFORE the tier-5 roll: a Green or Blue pair
  // climbs one colour rather than leaping to a Special, so the ladder reads as a
  // ladder. (The roll still applies to every unmatched pair, and to the Red step.)
  const step = matched && a.className ? COMBINE_NEXT_CLASS[a.className] : undefined;
  if (step && hasGrave(step.color)) {
    const bred = a.group ? step.byGroup[a.group] : undefined;
    if (bred) return bred;
  }

  const specialA = a.group ? COMBINE_SPECIAL_BY_GROUP[a.group] : undefined;
  const specialB = b.group ? COMBINE_SPECIAL_BY_GROUP[b.group] : undefined;
  if (
    playerLevel >= COMBINE_SPECIAL_LEVEL &&
    specialA && specialB &&
    random() < COMBINE_SPECIAL_CHANCE
  ) {
    // Special evolution follows the output species in slot 1. For example, a
    // slot-1 Flamehead can promote to Skull Head even though its base species is
    // otherwise guaranteed.
    return specialA;
  }

  // Top of the ladder: a matched RED pair (two ZomBrutes, two Flameheads, ...)
  // breeds up to the body type's silver. The tier-5 roll above already had its
  // chance to override. A job persisted without a class keeps the original test —
  // any matched pair that is not already a silver — so it collects as previewed.
  const silverStep = matched && (a.className ? a.className === "Red" : !isSilverKey(a.key));
  if (playerLevel >= COMBINE_SPECIAL_LEVEL && silverStep) {
    const silver = a.group ? COMBINE_SILVER_BY_GROUP[a.group] : undefined;
    if (silver) return silver;
  }

  return a.key;
}
