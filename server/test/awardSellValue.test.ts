import { describe, expect, it } from "vitest";
import { RAID_DROP_SELL, EPIC_PRIZE_SELL, QUEST_REWARD_SELL, BOSS_STATUE_SELL } from "../../src/awardSellValue";
import { BOSS_STATUES, EPIC_BOSS_STATUES } from "../../src/raid/bossStatues";
import { RAID_LOOT, DROPS } from "../src/raidLootCatalog";
import { objectEcon, objectSellGold } from "../src/objectCatalog";
import { EPIC_BOSSES } from "../../src/epicBoss/catalog";
import placeables from "../../public/assets/placeables.json";

const byKey = new Map((placeables as { key: string }[]).map((row) => [row.key, row]));

/** Every placeable an invasion can drop, with the raid + rarity tier it came from. */
const lootTiles = (): { raidId: number; tier: number; name: string; tile: string }[] => {
  const rows: { raidId: number; tier: number; name: string; tile: string }[] = [];
  for (const [id, tiers] of Object.entries(RAID_LOOT)) {
    tiers.forEach((names, tier) => {
      for (const name of names) {
        const tile = DROPS[name]?.tile;
        if (tile) rows.push({ raidId: Number(id), tier, name, tile });
      }
    });
  }
  return rows;
};

/** What one drop actually pays when sold, whichever rule prices it. */
const sellOf = (tile: string): number => {
  const econ = objectEcon(tile);
  return econ ? objectSellGold(tile, econ) : 0;
};

describe("award-only prize sell values", () => {
  it("names only real placeables, and only ones that cannot be bought", () => {
    for (const [key, value] of Object.entries({
      ...RAID_DROP_SELL, ...EPIC_PRIZE_SELL, ...QUEST_REWARD_SELL, ...BOSS_STATUE_SELL,
    })) {
      expect(byKey.has(key), `${key} is not in placeables.json`).toBe(true);
      // A purchasable item already has a price, and its sell-back is a fraction of
      // that price. Overriding one here would quietly change Market economics.
      expect(objectEcon(key)?.cost, `${key} is purchasable — do not override its sale`).toBe(0);
      expect(Number.isSafeInteger(value) && value > 1).toBe(true);
    }
  });

  it("leaves no invasion drop selling for the one-gold minimum", () => {
    const cheap = lootTiles()
      .filter((row) => sellOf(row.tile) <= 1)
      .map((row) => `raid ${row.raidId} T${row.tier} ${row.name}`);
    expect(cheap).toEqual([]);
  });

  it("pays more for a raid's rarest drop than for anything else it drops", () => {
    // The whole point of the table: within one invasion, the tier-5 signature piece
    // is worth more than its common loot. Raid 6 is exempt — its tier-4 Pyramid is a
    // 200,000-gold Market showpiece that happens to sit on a loot table, and matching
    // it would make the Aliens a gold faucet (see raidDropValue.ts).
    //
    // Raid 15 is exempt for exactly the same reason and no other: it is the dual invasion
    // STAGED as the Aliens, and it currently inherits their loot table verbatim, Pyramid
    // included. That inheritance is a PLACEHOLDER — the four dual invasions dropping the
    // same decor as invasions cleared thirty levels earlier is not a reward for the hardest
    // content in the game. When they get their own tables this exemption goes with it.
    const PYRAMID_EXEMPT = new Set([6, 15]);
    for (const [id, tiers] of Object.entries(RAID_LOOT)) {
      if (PYRAMID_EXEMPT.has(Number(id))) continue;
      const rows = lootTiles().filter((row) => row.raidId === Number(id));
      const rarest = Math.max(...rows.map((row) => row.tier));
      if (rarest === 0) continue;
      const top = Math.max(...rows.filter((row) => row.tier === rarest).map((row) => sellOf(row.tile)));
      for (const row of rows.filter((entry) => entry.tier < rarest)) {
        expect(sellOf(row.tile),
          `raid ${id}: T${row.tier} ${row.name} sells for more than the T${rarest} prize`)
          .toBeLessThanOrEqual(top);
      }
      expect(tiers.length).toBeGreaterThan(0);
    }
  });

  // The Epic Boss ladder's own rule, kept separate because these are earned from a
  // limited event rather than off a rarity table: a quarter of the prize's Reforged
  // brain price, at the game's 1,000-gold-per-brain rate. The source prices them at
  // 10/20/40 brains, which the brainflation retune divides by ten.
  const EPIC_LOOT_TILES = EPIC_BOSSES.flatMap((boss) => boss.loot.map((entry) => entry.tile))
    .filter((tile): tile is string => !!tile);

  it("prices every Epic Boss prize, and none of them at the one-gold floor", () => {
    expect(EPIC_LOOT_TILES.length).toBeGreaterThan(0);
    for (const tile of EPIC_LOOT_TILES) {
      const econ = objectEcon(tile);
      expect(econ, `${tile} is missing from objectCatalog`).toBeTruthy();
      expect(objectSellGold(tile, econ!), `${tile} still sells for the one-gold floor`)
        .toBeGreaterThan(1);
    }
  });

  it("pays a quarter of the prize's brain price, converted at 1,000 gold a brain", () => {
    // 1, 2 and 4 brains are the only Reforged prices in this set, so a quarter of each
    // at 1,000 gold per brain is the only ladder these may land on.
    const allowed = new Set([250, 500, 1_000]);
    for (const [tile, value] of Object.entries(EPIC_PRIZE_SELL)) {
      expect(allowed.has(value), `${tile} sells for ${value}, off the quarter-brain ladder`)
        .toBe(true);
    }
  });

  it("prices Epic Boss prizes and nothing else in that table", () => {
    expect(Object.keys(EPIC_PRIZE_SELL).sort()).toEqual([...EPIC_LOOT_TILES].sort());
  });

  // The three tables' shared contract, and the one the first two did not state: an
  // award-only placeable is exactly a `reward` row with no price, so "cost 0" and "no
  // authored value" together ARE the one-gold-floor bug. The raid and Epic tests above
  // each check their own family, which is why sixteen quest/seasonal prizes — the
  // reported Circus Popcorn among them — sat at 1 gold with every test green.
  it("leaves no award-only reward selling for the one-gold minimum", () => {
    const rewards = (placeables as { key: string; name: string; category: string; cost: number }[])
      .filter((row) => row.category === "reward" && row.cost === 0);
    expect(rewards.length).toBeGreaterThan(0);
    const cheap = rewards
      .filter((row) => sellOf(row.key) <= 1)
      .map((row) => `${row.key} (${row.name})`);
    expect(cheap).toEqual([]);
  });

  it("prices quest and seasonal prizes in the authored 500-1,000 band", () => {
    for (const [key, value] of Object.entries(QUEST_REWARD_SELL)) {
      expect(value, `${key} sells for ${value}, outside the 500-1,000 band`)
        .toBeGreaterThanOrEqual(500);
      expect(value).toBeLessThanOrEqual(1_000);
    }
  });

  it("prices every Boss Statue above every invasion's ordinary loot", () => {
    const statueTiles = new Set([...Object.values(BOSS_STATUES), ...Object.values(EPIC_BOSS_STATUES)]
      .flatMap((s) => [s.tile, s.goldenTile]));
    expect(Object.keys(BOSS_STATUE_SELL).sort()).toEqual([...statueTiles].sort());
    const dearestLoot = Math.max(...lootTiles().map((row) => sellOf(row.tile))
      .filter((gold) => gold < 40_000)); // the Pyramid outlier, see above
    for (const tile of statueTiles) expect(sellOf(tile)).toBeGreaterThan(dearestLoot);
  });

  it("still refunds an ordinary purchase as a fraction of its price", () => {
    // The override is scoped to award-only prizes; nothing else changed.
    const haystack = objectEcon("haystack")!;
    expect(objectSellGold("haystack", haystack)).toBe(Math.floor(haystack.cost * 0.2));
  });
});
