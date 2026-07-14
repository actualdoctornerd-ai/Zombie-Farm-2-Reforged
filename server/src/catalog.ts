// Server-side economic catalog. Mirrors the CROP economics in
// public/assets/plants.json (cost/sell/xp/growMs/level) so the server can compute
// exact per-action rewards instead of trusting the client's claimed amount.
//
// KEEP IN SYNC with plants.json (12 veggie crops). Zombie crops (brains-cost,
// unit-yielding) live in zombies.json and involve roster state — not modelled here
// yet, so they stay on the bounds-validated economy path.

export interface CropEcon {
  /** Seed cost in gold. */
  cost: number;
  /** Base harvest value in gold (doubled if fertilized). */
  sell: number;
  /** XP awarded on harvest. */
  xp: number;
  /** Grow time in ms — the SERVER gates harvest by this against server plant time. */
  growMs: number;
  /** Player level required (informational; unlock gating stays client-side for now). */
  level: number;
}

export const CROPS: Readonly<Record<string, CropEcon>> = {
  carrot: { cost: 5, sell: 16, xp: 1, growMs: 900000, level: 1 },
  onion: { cost: 20, sell: 60, xp: 2, growMs: 86400000, level: 1 },
  breadfruit: { cost: 20, sell: 33, xp: 1, growMs: 3600000, level: 5 },
  potato: { cost: 50, sell: 100, xp: 1, growMs: 86400000, level: 6 },
  sampaguita: { cost: 25, sell: 38, xp: 1, growMs: 1800000, level: 8 },
  coffee: { cost: 20, sell: 52, xp: 1, growMs: 28800000, level: 9 },
  candycorn: { cost: 60, sell: 76, xp: 1, growMs: 7200000, level: 10 },
  Spineapple: { cost: 17, sell: 29, xp: 1, growMs: 900000, level: 14 },
  broccoli: { cost: 70, sell: 92, xp: 1, growMs: 14400000, level: 15 },
  garlic: { cost: 50, sell: 80, xp: 1, growMs: 28800000, level: 16 },
  Bloodberry: { cost: 55, sell: 70, xp: 1, growMs: 3600000, level: 17 },
  cauliflower: { cost: 90, sell: 132, xp: 1, growMs: 43200000, level: 18 },
};

export function cropEcon(key: string): CropEcon | undefined {
  return Object.prototype.hasOwnProperty.call(CROPS, key) ? CROPS[key] : undefined;
}
