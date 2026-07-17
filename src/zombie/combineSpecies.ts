/** Player level at which ordinary Zombie Pot combinations can promote to a
 * hidden tier-5 special. */
export const COMBINE_SPECIAL_LEVEL = 25;

/** Chance that an eligible non-special pair promotes to its type's special. */
export const COMBINE_SPECIAL_CHANCE = 0.10;

/** The combining-only tier-5 representative for each zombie body type. */
export const COMBINE_SPECIAL_BY_GROUP: Readonly<Record<string, string>> = {
  Garden: "ZombieActorGardenTier5",       // Zombutterfly
  Large: "ZombieActorLargeTier5",         // Zomviking
  Small: "ZombieActorSmallTier5",         // Zombricaun
  Female: "ZombieActorGirlTier5",         // Zombelly Dancer
  Regular: "ZombieActorRegularTier5",     // Zombotron
  Headless: "ZombieActorHeadlessTier5",   // Skull Head
};

export interface CombineSpeciesParent {
  key: string;
  tier?: number;
  group?: string;
  isMutant?: boolean;
  isSpecial?: boolean;
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
 * Choose the Zombie Pot's output species. The result is null only for the
 * prohibited special + special pairing.
 *
 * Event/reward-only eligibility is intentionally enforced by the caller because
 * that catalog flag is not part of a persisted combine job.
 */
export function selectCombineSpecies(
  a: CombineSpeciesParent,
  b: CombineSpeciesParent,
  playerLevel: number,
  random: () => number = Math.random
): string | null {
  // Canonicalize candidates so swapping the two pot slots cannot change which
  // species wins a deterministic coin flip.
  [a, b] = a.key <= b.key ? [a, b] : [b, a];
  if (a.isSpecial && b.isSpecial) return null;
  if (a.isSpecial !== b.isSpecial) return a.isSpecial ? a.key : b.key;

  const specialA = a.group ? COMBINE_SPECIAL_BY_GROUP[a.group] : undefined;
  const specialB = b.group ? COMBINE_SPECIAL_BY_GROUP[b.group] : undefined;
  if (
    playerLevel >= COMBINE_SPECIAL_LEVEL &&
    specialA && specialB &&
    random() < COMBINE_SPECIAL_CHANCE
  ) {
    if (specialA === specialB) return specialA;
    return random() < 0.5 ? specialA : specialB;
  }

  if (!!a.isMutant !== !!b.isMutant) return a.isMutant ? b.key : a.key;
  if (!a.isMutant && !b.isMutant) {
    const tierA = a.tier ?? 0;
    const tierB = b.tier ?? 0;
    if (tierA !== tierB) return tierA > tierB ? a.key : b.key;
  }
  return random() < 0.5 ? a.key : b.key;
}
