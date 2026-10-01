// Life Force: the Zombie Farm 1 farm stat, restored.
//
// Every placed object adds its catalog `lifeForce` (tools/life_force.json) to the farm's
// total. The total maps to a LEVEL, 0..10, and the level drives three things:
//   - how likely a crop is to grow its mutation       (cropMutationChance)
//   - how likely a zombie harvest is to fail          (harvestFailureChance)
//   - which of a zombie's four ability slots work     (abilitySlotUnlocked)
//
// Pure logic, no state: the server (harvest and mutation rolls, raid verification), the
// offline build and the HUD all call these, so the rules live in exactly one place.
// The numbers are the owner's design, decided 2026-10-01.

/** Total Life Force needed for level 1, 2, ... 10. Level 0 is anything below the first. */
export const LIFE_FORCE_THRESHOLDS: readonly number[] = [30, 65, 105, 150, 200, 250, 300, 350, 400, 450];

/** The highest level. The raw total keeps counting past it; nothing more happens. */
export const MAX_LIFE_FORCE_LEVEL = LIFE_FORCE_THRESHOLDS.length;

/** Mutation chance per adjacent crop at level 0, and what each level adds. Level 10
 *  reaches 105%, capped at 100%. */
export const MUTATION_BASE_CHANCE = 0.05;
export const MUTATION_CHANCE_PER_LEVEL = 0.1;

/** A zombie fails its harvest 20 points more often for every level its tier is above the
 *  farm's Life Force level. */
export const HARVEST_FAIL_PER_LEVEL = 0.2;

/** The highest tier a zombie counts as, whatever its catalog tier (Obsidian is tier 6). */
export const MAX_HARVEST_TIER = 5;

/** A zombie has at most four ability slots (its colour-class tiers 1..4). */
export const MAX_ABILITY_SLOTS = 4;

/** The farm's Life Force level for a total. */
export function lifeForceLevel(total: number): number {
  let level = 0;
  for (const need of LIFE_FORCE_THRESHOLDS) {
    if (total >= need) level++;
    else break;
  }
  return level;
}

export interface LifeForceProgress {
  total: number;
  level: number;
  /** Total at which the current level began (0 at level 0). */
  floor: number;
  /** Total needed for the next level; null at the cap. */
  next: number | null;
  /** Life Force still needed for the next level; null at the cap. */
  toNext: number | null;
  /** 0..1 progress through the current level; 1 at the cap. */
  progress: number;
}

/** Everything the HUD bar and popover show for a total. */
export function lifeForceProgress(total: number): LifeForceProgress {
  const safe = Math.max(0, Math.floor(total));
  const level = lifeForceLevel(safe);
  const floor = level === 0 ? 0 : LIFE_FORCE_THRESHOLDS[level - 1];
  const next = level >= MAX_LIFE_FORCE_LEVEL ? null : LIFE_FORCE_THRESHOLDS[level];
  return {
    total: safe,
    level,
    floor,
    next,
    toNext: next === null ? null : next - safe,
    progress: next === null ? 1 : (safe - floor) / (next - floor),
  };
}

/** The farm's total: the sum of `lifeForceOf` over the catalog keys of every PLACED
 *  object (stored objects do not count). Unknown keys count as 0. */
export function farmLifeForce(
  placedKeys: Iterable<string>,
  lifeForceOf: (key: string) => number
): number {
  let total = 0;
  for (const key of placedKeys) {
    const v = lifeForceOf(key);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/** Chance that one adjacent crop grows its mutation, at a Life Force level. */
export function cropMutationChance(level: number): number {
  const l = Math.min(MAX_LIFE_FORCE_LEVEL, Math.max(0, Math.floor(level)));
  return Math.min(1, MUTATION_BASE_CHANCE + MUTATION_CHANCE_PER_LEVEL * l);
}

/** The tier a zombie counts as for harvest failure: its colour class rank (Green 1,
 *  Blue 2, Red 3, Silver 4) with Obsidian and every special zombie at 5. */
export function zombieHarvestTier(def: { category?: string; tier?: number }): number {
  if (def.category === "special") return MAX_HARVEST_TIER;
  return Math.min(MAX_HARVEST_TIER, Math.max(1, def.tier ?? 1));
}

/** Chance a harvest of a `tier` zombie fails at a Life Force level: 20% per level the
 *  tier is above the level. A tier-1 zombie is safe from level 1; a tier-5 zombie
 *  always fails at level 0 and is safe from level 5. */
export function harvestFailureChance(tier: number, level: number): number {
  const gap = Math.floor(tier) - Math.floor(level);
  return Math.min(1, Math.max(0, HARVEST_FAIL_PER_LEVEL * gap));
}

/** Roll a harvest failure. `random` is [0, 1), so a chance of 1 always fails and 0 never. */
export function harvestFails(tier: number, level: number, random: () => number): boolean {
  const chance = harvestFailureChance(tier, level);
  return chance > 0 && random() < chance;
}

/** What a Life Force level currently gives, for the HUD popover. */
export interface LifeForceEffects {
  /** Mutation chance per adjacent crop. */
  mutationChance: number;
  /** Highest tier whose harvests never fail (0 = none yet, 5 = every zombie). */
  safeTier: number;
  /** Ability slots that work (0..4). */
  abilitySlots: number;
}

export function lifeForceEffects(level: number): LifeForceEffects {
  const l = Math.min(MAX_LIFE_FORCE_LEVEL, Math.max(0, Math.floor(level)));
  return {
    mutationChance: cropMutationChance(l),
    safeTier: Math.min(MAX_HARVEST_TIER, l),
    abilitySlots: Math.min(MAX_ABILITY_SLOTS, l),
  };
}

/** Ability slot `slot` (1..4: the zombie's colour-class tiers) works from Life Force
 *  level `slot`. The gate is the SLOT, not the ability's own tier, so a tier-4 ability
 *  sitting in slot 3 unlocks with slot 3. It replaces the old "beat the tier's boss" gate. */
export function abilitySlotUnlocked(slot: number, level: number): boolean {
  return level >= slot;
}

/** Total Life Force a farm needs before ability slot `slot` works. */
export function abilitySlotRequirement(slot: number): number {
  return LIFE_FORCE_THRESHOLDS[Math.min(MAX_LIFE_FORCE_LEVEL, Math.max(1, slot)) - 1];
}
