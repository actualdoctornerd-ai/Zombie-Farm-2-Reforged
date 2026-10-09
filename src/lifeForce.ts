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
export const LIFE_FORCE_THRESHOLDS: readonly number[] = [20, 45, 75, 110, 155, 250, 300, 350, 400, 450];

/** The highest level. The raw total keeps counting past it; nothing more happens. */
export const MAX_LIFE_FORCE_LEVEL = LIFE_FORCE_THRESHOLDS.length;

/** Mutation chance per adjacent crop at level 0, and what each level adds. Level 9
 *  reaches 100%; level 10 would be 110%, capped. */
export const MUTATION_BASE_CHANCE = 0.1;
export const MUTATION_CHANCE_PER_LEVEL = 0.1;

/** A zombie comes out lifeless 10 points more often for every colour tier above Green,
 *  and 10 points less often for every Life Force level. Green is never lifeless. */
export const HARVEST_FAIL_PER_LEVEL = 0.1;

/** Reaching Life Force level n adds n x this to a Garden zombie's fertilize multiplier
 *  (+1% at level 1, +2% at level 2 ... +10% at level 10), and the bonuses stack: the
 *  multiplier is 1 + 1% x (1 + 2 + ... + level), so x1.55 at level 10. It scales the
 *  zombie's chance (a 4% Garden becomes 6.2%), it is not points added to it. */
export const FERTILIZE_BOOST_STEP = 0.01;

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

/** Chance a harvest of a `tier` zombie comes out lifeless at a Life Force level: 10% for
 *  every tier above Green, less 10% for every level. Green (tier 1) is never lifeless;
 *  tier t is safe from level t - 1, so Blue needs level 1 and Obsidian level 4. */
export function harvestFailureChance(tier: number, level: number): number {
  const gap = Math.floor(tier) - 1 - Math.floor(level);
  return Math.min(1, Math.max(0, HARVEST_FAIL_PER_LEVEL * gap));
}

/** Multiplier on a Garden zombie's fertilize chance at a Life Force level: 1 + 1% x the triangle number of the level. */
export function fertilizeMultiplier(level: number): number {
  const l = Math.min(MAX_LIFE_FORCE_LEVEL, Math.max(0, Math.floor(level)));
  return 1 + FERTILIZE_BOOST_STEP * (l * (l + 1)) / 2;
}

/** Roll a harvest failure. `random` is [0, 1), so a chance of 1 always fails and 0 never. */
export function harvestFails(tier: number, level: number, random: () => number): boolean {
  const chance = harvestFailureChance(tier, level);
  return chance > 0 && random() < chance;
}

/** Display names for harvest tiers 1..5, in order. */
export const HARVEST_TIER_NAMES: readonly string[] = ["Green", "Blue", "Red", "Silver", "Obsidian and special"];

/** One level of the ladder as the Life Force panel lists it. */
export interface LifeForceLevelRow {
  level: number;
  /** Total Life Force needed to reach this level. */
  need: number;
  mutationChance: number;
  /** Multiplier on Garden zombies' fertilize chance. */
  fertilizeMultiplier: number;
  /** The tier whose harvests stop failing at this level (levels 1..4), else null. */
  safeTierGained: number | null;
  /** The ability slot that starts working at this level (levels 1..4), else null. */
  abilitySlotGained: number | null;
}

/** Levels 1..10, each with what it adds. */
export function lifeForceLevelRows(): LifeForceLevelRow[] {
  return LIFE_FORCE_THRESHOLDS.map((need, i) => {
    const level = i + 1;
    return {
      level,
      need,
      mutationChance: cropMutationChance(level),
      fertilizeMultiplier: fertilizeMultiplier(level),
      safeTierGained: level < MAX_HARVEST_TIER ? level + 1 : null,
      abilitySlotGained: level <= MAX_ABILITY_SLOTS ? level : null,
    };
  });
}

/** What a Life Force level currently gives, for the HUD panel. */
export interface LifeForceEffects {
  /** Mutation chance per adjacent crop. */
  mutationChance: number;
  /** Multiplier on Garden zombies' fertilize chance. */
  fertilizeMultiplier: number;
  /** Highest tier whose harvests never fail (1 = Green only, 5 = every zombie). */
  safeTier: number;
  /** Ability slots that work (0..4). */
  abilitySlots: number;
}

export function lifeForceEffects(level: number): LifeForceEffects {
  const l = Math.min(MAX_LIFE_FORCE_LEVEL, Math.max(0, Math.floor(level)));
  return {
    mutationChance: cropMutationChance(l),
    fertilizeMultiplier: fertilizeMultiplier(l),
    safeTier: Math.min(MAX_HARVEST_TIER, l + 1),
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
