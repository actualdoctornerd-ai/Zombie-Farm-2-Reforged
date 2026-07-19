// Server-side shop catalog for the non-boost purchases the server now owns: FARM SIZE
// (a scalar, upgraded in a fixed sequence) and GROUND/CLIMATE skins (an owned set).
// Mirrors public/assets/upgrades.json. Prices are exact so a client can't underpay,
// and the owned state (size / climate set) is server-authoritative + reconciled, so it
// can't be fabricated in the save blob.
//
// KEEP IN SYNC with upgrades.json (mapSize + climate).
//
// NOT covered here: placeable OBJECTS. Their "ownership" is farm-layout placement, not
// a scalar/set, so it can't be reconciled the way size/climates can — and blob-layout
// fabrication would stay open regardless — so objects remain client-authored (a
// one-time, largely cosmetic gap; the functional monoliths are QoL/time, not gold).

/** The base (starting) farm size — free, never purchased. */
export const BASE_FARM_SIZE = 30;

export interface SizeTier {
  size: number;
  gold: number;
  brains: number;
  level: number;
}

/** Farm-size upgrade tiers, in ascending order. Bought sequentially (30→40→50→60). */
export const SIZE_TIERS: readonly SizeTier[] = [
  { size: 40, gold: 10000, brains: 6, level: 11 },
  { size: 50, gold: 50000, brains: 8, level: 21 },
  { size: 60, gold: 250000, brains: 12, level: 31 },
];

/** Ground/climate skin prices (gold). "grass" is the free default (always owned). */
export const CLIMATE_COST: Readonly<Record<string, number>> = {
  stone: 1000,
  dirt: 2000,
  snow: 5000,
  sand: 5000,
  water: 10000,
};

/** The tier record for a target size, or undefined if it isn't a real tier. */
export function sizeTier(size: number): SizeTier | undefined {
  return SIZE_TIERS.find((t) => t.size === size);
}

/** The next buyable size above `current` (the only tier you may purchase), or
 *  undefined if the farm is already at max. */
export function nextSize(current: number): number | undefined {
  const larger = SIZE_TIERS.map((t) => t.size).filter((s) => s > current);
  return larger.length ? Math.min(...larger) : undefined;
}

/** Whether `size` is a valid farm size the server will accept as owned (base or a tier). */
export function isValidSize(size: number): boolean {
  return size === BASE_FARM_SIZE || !!sizeTier(size);
}

/** A climate terrain's cost, or undefined if it isn't a purchasable skin. "grass" is
 *  free/default and returns 0. */
export function climateCost(terrain: string): number | undefined {
  if (terrain === "grass") return 0;
  return Object.prototype.hasOwnProperty.call(CLIMATE_COST, terrain) ? CLIMATE_COST[terrain] : undefined;
}
