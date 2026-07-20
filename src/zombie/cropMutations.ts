import { addMutation, slotOf } from "./mutations";

/** Mutation-bearing vegetable crops. Tier-4 visual variants intentionally share
 * the same mutation bit as their underlying Carrot/Cauliflower mutation. */
export const CROP_MUTATIONS: Readonly<Record<string, number>> = {
  tomato: 1,
  onion: 2,
  carrot: 4,
  eyebiscus: 4,
  turnip: 8,
  potato: 16,
  coffee: 32,
  celery: 64,
  broccoli: 128,
  garlic: 256,
  cauliflower: 512,
  heartichoke: 512,
  lima_beans: 1024,
  venus_flytrap: 2048,
  dragon_fruit: 4096,
};

export const CROP_MUTATION_CHANCE = 0.25;

export interface CropMutationOptions {
  guaranteed?: boolean;
  headless?: boolean;
  random?: () => number;
}

/** Resolve all crop-adjacency mutations for one harvested zombie.
 *
 * Each adjacent crop adds 25 percentage points to its mutation's chance, capped
 * at 100%. Different non-conflicting mutations roll independently. If multiple
 * successful crops target the same anatomical slot, the lowest random roll wins;
 * this prevents plot iteration order from deciding the conflict. */
export function resolveCropMutations(
  baseMask: number,
  adjacentCropKeys: readonly string[],
  options: CropMutationOptions = {}
): number {
  const counts = new Map<number, number>();
  for (const key of adjacentCropKeys) {
    const bit = CROP_MUTATIONS[key];
    if (bit) counts.set(bit, (counts.get(bit) ?? 0) + 1);
  }

  const random = options.random ?? Math.random;
  const successes: { bit: number; roll: number }[] = [];
  for (const [bit, count] of counts) {
    if (slotOf(bit) === null) continue;
    const roll = random();
    const chance = options.guaranteed ? 1 : Math.min(1, count * CROP_MUTATION_CHANCE);
    if (chance >= 1 || roll < chance) successes.push({ bit, roll });
  }

  successes.sort((a, b) => a.roll - b.roll || a.bit - b.bit);
  let mask = baseMask;
  for (const success of successes) mask = addMutation(mask, success.bit, !!options.headless);
  return mask;
}
