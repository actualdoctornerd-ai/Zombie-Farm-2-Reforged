// Server-side economic catalog. Mirrors the CROP economics in
// public/assets/plants.json (cost/sell/xp/growMs/level) so the server can compute
// exact per-action rewards instead of trusting the client's claimed amount.
//
// KEEP IN SYNC with plants.json — server/test/farm.test.ts asserts the two are
// equal, so a drifted entry fails the suite rather than paying the wrong reward.
// The 25 regular crops carry the Reforged rebalance (levels 1-45, curve-derived
// profit and XP); its source of truth is tools/reforge_economy.py, which
// prep_market.py applies when regenerating plants.json. Zombie crops (brains-cost,
// unit-yielding) live in zombies.json and involve roster state — not modelled here
// yet, so they stay on the bounds-validated economy path.
//
// The table below is GENERATED from that asset: `npm run catalogs` (server/
// scripts/gen-catalogs.mjs) rewrites the `#region generated:` block, and
// `npm run catalogs:check` fails CI and the deploy:prod gate when the two drift.
// Edit the ASSET, not the region. Everything outside the region is hand-written
// and is not touched.

export interface CropEcon {
  /** Seed cost in gold. */
  cost: number;
  /** Base harvest value in gold (doubled if fertilized). */
  sell: number;
  /** XP awarded on harvest. */
  xp: number;
  /** Grow time in ms — the SERVER gates harvest by this against server plant time. */
  growMs: number;
  /** Player level required. ENFORCED server-side — v3 `farm.plant` rejects a crop
   *  above the account's derived level with `locked` (see v3/engine.ts). */
  level: number;
}

export const CROPS: Readonly<Record<string, CropEcon>> = {
  // #region generated:CROPS
  // Source: public/assets/plants.json — regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit
  carrot: { cost: 5, sell: 16, xp: 1, growMs: 900000, level: 1 },
  onion: { cost: 20, sell: 60, xp: 4, growMs: 86400000, level: 1 },
  tomato: { cost: 10, sell: 31, xp: 2, growMs: 14400000, level: 3 },
  turnip: { cost: 30, sell: 62, xp: 3, growMs: 43200000, level: 5 },
  breadfruit: { cost: 20, sell: 35, xp: 2, growMs: 3600000, level: 9 },
  potato: { cost: 50, sell: 99, xp: 5, growMs: 86400000, level: 10 },
  sampaguita: { cost: 25, sell: 38, xp: 2, growMs: 1800000, level: 14 },
  coffee: { cost: 20, sell: 53, xp: 4, growMs: 28800000, level: 15 },
  candycorn: { cost: 60, sell: 79, xp: 2, growMs: 7200000, level: 16 },
  venus_flytrap: { cost: 80, sell: 111, xp: 3, growMs: 21600000, level: 19 },
  celery: { cost: 40, sell: 56, xp: 2, growMs: 3600000, level: 20 },
  Spineapple: { cost: 17, sell: 29, xp: 1, growMs: 900000, level: 21 },
  broccoli: { cost: 70, sell: 97, xp: 3, growMs: 14400000, level: 23 },
  garlic: { cost: 50, sell: 88, xp: 4, growMs: 28800000, level: 25 },
  Bloodberry: { cost: 55, sell: 72, xp: 2, growMs: 3600000, level: 27 },
  cauliflower: { cost: 90, sell: 138, xp: 5, growMs: 43200000, level: 29 },
  skellyberry: { cost: 40, sell: 54, xp: 2, growMs: 1800000, level: 31 },
  lima_beans: { cost: 120, sell: 191, xp: 6, growMs: 86400000, level: 33 },
  sun_glower: { cost: 150, sell: 181, xp: 4, growMs: 14400000, level: 35 },
  dragon_fruit: { cost: 120, sell: 195, xp: 7, growMs: 86400000, level: 37 },
  pumpking: { cost: 380, sell: 425, xp: 5, growMs: 28800000, level: 39 },
  corpse_flower: { cost: 200, sell: 240, xp: 5, growMs: 21600000, level: 41 },
  meat_flower: { cost: 26, sell: 38, xp: 2, growMs: 900000, level: 43 },
  eyebiscus: { cost: 100, sell: 158, xp: 6, growMs: 43200000, level: 44 },
  heartichoke: { cost: 125, sell: 213, xp: 8, growMs: 86400000, level: 45 },
  golden_carrot: { cost: 90, sell: 108, xp: 4, growMs: 1800000, level: 45 },
  golden_turnip: { cost: 230, sell: 375, xp: 11, growMs: 86400000, level: 45 },
  obsidibeans: { cost: 330, sell: 530, xp: 13, growMs: 172800000, level: 45 },
  cauliglower: { cost: 190, sell: 315, xp: 11, growMs: 86400000, level: 45 },
  cosmic_potato: { cost: 320, sell: 520, xp: 15, growMs: 172800000, level: 45 },
  brainato: { cost: 90, sell: 152, xp: 10, growMs: 28800000, level: 45 },
  firecracker: { cost: 50, sell: 75, xp: 1, growMs: 1200000, level: -4 },
  water_lily: { cost: 75, sell: 150, xp: 1, growMs: 3600000, level: -4 },
  cupcakes: { cost: 10, sell: 45, xp: 1, growMs: 14400000, level: 1 },
  eggplant: { cost: 10, sell: 24, xp: 1, growMs: 3600000, level: 1 },
  rainbow: { cost: 500, sell: 600, xp: 1, growMs: 28800000, level: 1 },
  starfruit: { cost: 10, sell: 45, xp: 1, growMs: 14400000, level: 1 },
  kelp: { cost: 75, sell: 100, xp: 1, growMs: 1800000, level: 1 },
  marigold: { cost: 90, sell: 140, xp: 1, growMs: 43200000, level: 3 },
  hollyberry: { cost: 30, sell: 43, xp: 1, growMs: 3600000, level: 5 },
  candy_corn: { cost: 124, sell: 142, xp: 1, growMs: 7200000, level: 13 },
  // #endregion generated:CROPS
};

export function cropEcon(key: string): CropEcon | undefined {
  return Object.prototype.hasOwnProperty.call(CROPS, key) ? CROPS[key] : undefined;
}
