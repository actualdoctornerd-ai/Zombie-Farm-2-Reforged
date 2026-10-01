import { cropMutationChance } from "../lifeForce";
import { addMutation, bitGrowable, resolveMutationBit, type MutationRef } from "./mutations";

/** A crop table: which mutations each crop key grows. One name, or a list of them. */
export type CropMutationTable =
  Readonly<Record<string, MutationRef | readonly MutationRef[]>>;

/** Which mutations a vegetable crop grows on a zombie planted beside it.
 *
 * Keys are crop keys from public/assets/plants.json; values name mutations from the
 * catalog in mutations.ts — by key, which is what new entries should use. A crop may
 * grant SEVERAL mutations by listing them: each one rolls on its own (see
 * resolveCropMutations), so a crop naming a head and an arm mutation can produce
 * either, both, or neither. Two crops may also name the SAME mutation, and adjacency
 * counts then pool into a single roll, exactly as two plots of one crop would. (The
 * Tier-4 pair used to do that — eyebiscus grew carrot's mutation and heartichoke grew
 * cauli's — which made the game's two priciest mutation crops grant a Tier-1 bonus.
 * They grow their own now; nothing shipped shares a mutation any more.) */
export const CROP_MUTATIONS: CropMutationTable = {
  tomato: "tomato",
  onion: "onion",
  carrot: "carrot",
  eyebiscus: "eyebiscus",
  turnip: "turnip",
  potato: "potato",
  coffee: "coffee",
  celery: "celery",
  broccoli: "broccoli",
  garlic: "garlic",
  cauliflower: "cauli",
  heartichoke: "heartichoke",
  lima_beans: "limabean",
  venus_flytrap: "flytrap",
  dragon_fruit: "dragon",
  // Grows on the headless family ONLY (bitGrowable): a zombie that already has a head
  // never grows a pumpkin, however many are planted beside it. It can still inherit
  // one in the Zombie Pot — that is the only route to a Regular wearing it.
  pumpking: "pumpking",
};

/** The mutations one crop grows, resolved to bits. Unknown names are dropped, so a
 *  typo costs that crop its mutation rather than mutating the wrong slot. */
export function cropMutationBits(
  cropKey: string,
  crops: CropMutationTable = CROP_MUTATIONS,
): number[] {
  const refs = crops[cropKey];
  if (refs === undefined) return [];
  const list: readonly MutationRef[] = Array.isArray(refs) ? refs : [refs as MutationRef];
  const out: number[] = [];
  for (const ref of list) {
    const bit = resolveMutationBit(ref);
    if (bit !== null && !out.includes(bit)) out.push(bit);
  }
  return out;
}

/** Chance one adjacent crop grows its mutation at Life Force level 0. The live value is
 *  `cropMutationChance(level)` (src/lifeForce.ts), passed in as `chancePerCrop`: 5% +
 *  10% per level, so a farm with no Life Force grows mutations rarely. */
const DEFAULT_CHANCE_PER_CROP = cropMutationChance(0);

/** Do two plot footprints of `plotSize` tiles square touch along an edge or a corner?
 *
 * Plots are free-placed: a plow stroke snaps to the lattice its own anchor tile
 * establishes (see plowSelection.snapPlowOrigin), so a plot laid down in a second
 * stroke can sit flush against the first without its origin being a whole plot away.
 * Testing the eight exact ±plotSize offsets — which is what this used to do — missed
 * every one of those neighbours, and crops beside an off-grid zombie plot never
 * mutated it. Footprints never overlap (Field.areaFree / engine.overlapsExistingPlot),
 * so "within one plot on both axes" is exactly "sharing an edge or a corner", and the
 * eight-neighbour maximum still holds: nine 4x4 footprints is all that fits in the
 * 12x12 span an origin this close can occupy. */
export function plotsTouch(
  ac: number, ar: number, bc: number, br: number, plotSize: number
): boolean {
  if (ac === bc && ar === br) return false; // the plot itself
  return Math.abs(bc - ac) <= plotSize && Math.abs(br - ar) <= plotSize;
}

export interface CropMutationOptions {
  guaranteed?: boolean;
  headless?: boolean;
  /** Chance each adjacent crop adds to its mutation, from the farm's Life Force level
   *  (`cropMutationChance`). Defaults to the level-0 chance. */
  chancePerCrop?: number;
  random?: () => number;
  /** Crop table to roll against. Defaults to CROP_MUTATIONS; overridden by tests and
   *  by anything that wants to try a table without editing the shipped one. */
  crops?: CropMutationTable;
}

/** Resolve all crop-adjacency mutations for one harvested zombie.
 *
 * Each adjacent crop adds `chancePerCrop` (5% + 10% per Life Force level) to its mutation's chance, capped
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
    // Counting per BIT, not per crop, is what makes eyebiscus stack with carrot: two
    // crops naming one mutation pool their adjacency into a single roll.
    for (const bit of cropMutationBits(key, options.crops)) {
      counts.set(bit, (counts.get(bit) ?? 0) + 1);
    }
  }

  const random = options.random ?? Math.random;
  const perCrop = options.chancePerCrop ?? DEFAULT_CHANCE_PER_CROP;
  const successes: { bit: number; roll: number }[] = [];
  for (const [bit, count] of counts) {
    // cropMutationBits has already dropped anything the catalog doesn't know, so every
    // bit here has a slot. A mutation this body type can't grow never even rolls — no
    // wasted roll, and no dependence on addMutation to refuse it further down.
    if (!bitGrowable(bit, !!options.headless)) continue;
    const roll = random();
    const chance = options.guaranteed ? 1 : Math.min(1, count * perCrop);
    if (chance >= 1 || roll < chance) successes.push({ bit, roll });
  }

  successes.sort((a, b) => a.roll - b.roll || a.bit - b.bit);
  let mask = baseMask;
  for (const success of successes) mask = addMutation(mask, success.bit, !!options.headless);
  return mask;
}
