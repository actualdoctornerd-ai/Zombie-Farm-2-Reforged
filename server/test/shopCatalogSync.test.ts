// server/src/shopCatalog.ts is a HAND-MAINTAINED mirror of the `mapSize` and `climate`
// sections of public/assets/upgrades.json, and it is what the server charges.
//
// The last of the hand-typed catalogs to get a guard (the rest either derive from their
// asset at module load — rosterCatalog, zombieCropCatalog, questCatalog — or were already
// covered: CROPS by farm.test.ts, OBJECTS by objectCatalogSync, BOOSTS by boostCatalogSync).
//
// Two distinct failures live here. A wrong PRICE is the obvious one. The quieter one is a
// missing KEY: `climateCost` returning undefined makes the server answer `bad_climate` for
// a skin the Market is still offering, so the card is visible, costed, and unbuyable — and
// nothing logs it as a mismatch because from the server's side it is a well-formed refusal.
import { ENDLESS_EXPANSION_SIZE } from "../../src/raid/endlessPerks";
import { describe, expect, it } from "vitest";
import upgrades from "../../public/assets/upgrades.json";
import {
  BASE_FARM_SIZE, CLIMATE_COST, MAX_FARM_SIZE, SIZE_TIERS, climateCost, isValidSize,
} from "../src/shopCatalog";

interface UpgradeData {
  mapSize: { name: string; size: number; level: number; gold: number; brains: number }[];
  climate: { name: string; terrain: string; level: number; gold: number }[];
}
const data = upgrades as UpgradeData;

/** The starting terrain: free, always owned, and deliberately absent from CLIMATE_COST —
 *  it is never purchased, so it has no price to mirror. The asset marks it with a negative
 *  level rather than a flag, which is why this is matched on cost rather than name. */
const FREE_TERRAIN = "grass";

describe("shopCatalog mirrors upgrades.json", () => {
  it("carries every farm-size tier at the asset's price and level", () => {
    const asset = data.mapSize.map((t) => ({
      size: t.size, gold: t.gold, brains: t.brains, level: t.level,
    }));
    expect(SIZE_TIERS.map((t) => ({ size: t.size, gold: t.gold, brains: t.brains, level: t.level })))
      .toEqual(asset);
  });

  it("keeps the size ladder ascending and rooted at the base size", () => {
    // `nextSize` walks this in order, so an out-of-order tier would sell the wrong upgrade.
    expect(BASE_FARM_SIZE).toBeLessThan(SIZE_TIERS[0].size);
    for (let i = 1; i < SIZE_TIERS.length; i++) {
      expect(SIZE_TIERS[i].size, `tier ${i}`).toBeGreaterThan(SIZE_TIERS[i - 1].size);
      // The Endless farm size is gated by its unlock, at the level of the tier below.
      if (SIZE_TIERS[i].size === ENDLESS_EXPANSION_SIZE) {
        expect(SIZE_TIERS[i].level, `tier ${i}`).toBe(SIZE_TIERS[i - 1].level);
      } else {
        expect(SIZE_TIERS[i].level, `tier ${i}`).toBeGreaterThan(SIZE_TIERS[i - 1].level);
      }
    }
    expect(MAX_FARM_SIZE).toBe(SIZE_TIERS[SIZE_TIERS.length - 1].size);
    expect(isValidSize(BASE_FARM_SIZE)).toBe(true);
    expect(isValidSize(MAX_FARM_SIZE)).toBe(true);
    expect(isValidSize(MAX_FARM_SIZE + 10)).toBe(false);
  });

  it("prices every purchasable ground skin identically to the asset", () => {
    const mismatched: string[] = [];
    for (const skin of data.climate) {
      if (skin.terrain === FREE_TERRAIN) continue;
      const server = climateCost(skin.terrain);
      if (server === undefined) {
        mismatched.push(`${skin.terrain} (${skin.name}): offered by the Market, unknown to the server`);
      } else if (server !== skin.gold) {
        mismatched.push(`${skin.terrain}: asset ${skin.gold} vs server ${server}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("prices no skin the asset does not sell", () => {
    const assetTerrains = new Set(data.climate.map((c) => c.terrain));
    const orphans = Object.keys(CLIMATE_COST).filter((t) => !assetTerrains.has(t));
    expect(orphans).toEqual([]);
  });

  it("gives the free starting terrain a real price of zero, not 'unknown'", () => {
    // The distinction is load-bearing: `climateCost` special-cases grass to 0 rather than
    // leaving it out, because a skin the server does not recognise is refused `bad_climate`.
    // Grass is re-appliable for free, so it has to resolve — at 0 — while staying out of the
    // priced table above.
    expect(climateCost(FREE_TERRAIN)).toBe(0);
    expect(CLIMATE_COST[FREE_TERRAIN]).toBeUndefined();
    expect(data.climate.find((c) => c.terrain === FREE_TERRAIN)?.gold).toBe(0);
    expect(climateCost("not-a-terrain")).toBeUndefined();
  });
});
