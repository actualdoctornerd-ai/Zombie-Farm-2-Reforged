import { describe, it, expect } from "vitest";
import { lootTierChances, rollLootTier } from "./LootTable";
import { formatOdds, itemLootTable, statueRule } from "./dropTable";

describe("lootTierChances", () => {
  // The closed form must be the SAME distribution rollLootTier samples: count a fine grid.
  for (const bonus of [0, 1, 2, 3, 4, 6, 9]) {
    it(`matches rollLootTier at ${bonus} dice`, () => {
      const N = 100_000;
      const seen = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < N; i++) seen[rollLootTier((i + 0.5) / N, bonus)]++;
      const odds = lootTierChances(bonus);
      expect(odds.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      odds.forEach((p, t) => expect(seen[t] / N).toBeCloseTo(p, 3));
    });
  }
});

const loot = [
  ["Bonus Gold"], ["Haystack"], ["Insta-Plow", "Insta-Harvest"], ["Farmer Banner"], ["Scarecrow"], ["Windmill"],
];
const base = { loot, dice: 0, extraRateOf: () => 0, bundleOf: () => 1, bonusGold: 500 };

describe("itemLootTable", () => {
  it("splits a tier's share evenly across its items and sums to 1", () => {
    const t = itemLootTable(base);
    const all = t.tiers.flatMap((x) => x.rows).reduce((a, r) => a + r.chance, 0);
    expect(all).toBeCloseTo(1, 9);
    const common = t.tiers.find((x) => x.tier === 2)!;
    expect(common.rows.map((r) => r.chance)).toEqual([0.3, 0.3]);
    expect(t.tiers.find((x) => x.tier === 5)).toBeUndefined(); // unreachable with no dice
  });

  it("hands an all-extra tier's share to the tier below and lists the extra on its own", () => {
    const t = itemLootTable({ ...base, extraRateOf: (n) => (n === "Farmer Banner" ? 0.1 : 0) });
    expect(t.extras).toEqual([{ name: "Farmer Banner", chance: 0.1, qty: 1 }]);
    expect(t.tiers.find((x) => x.tier === 3)).toBeUndefined();
    const common = t.tiers.find((x) => x.tier === 2)!;
    expect(common.chance).toBeCloseTo(0.68, 9); // 0.60 + the banner tier's 0.08
    expect(t.tiers.flatMap((x) => x.rows).reduce((a, r) => a + r.chance, 0)).toBeCloseTo(1, 9);
  });

  it("counts a name listed twice twice, and prices Bonus Gold and bundles", () => {
    const t = itemLootTable({
      ...base,
      loot: [["Bonus Gold"], ["Voucher", "Dice", "Voucher"], [], [], [], []],
      bundleOf: (n) => (n === "Voucher" ? 10 : 1),
    });
    const tier1 = t.tiers.find((x) => x.tier === 1)!;
    const v = tier1.rows.find((r) => r.name === "Voucher")!;
    expect(v.chance / tier1.chance).toBeCloseTo(2 / 3, 9);
    expect(v.qty).toBe(10);
    expect(t.tiers.find((x) => x.tier === 0)!.rows[0].qty).toBe(500);
  });
});

describe("statueRule / formatOdds", () => {
  it("names the statues for a story raid and none for a dual invasion", () => {
    expect(statueRule(1)).toMatchObject({ name: "Old McDonnell Statue", stoneWins: 15, goldenWins: 50 });
    expect(statueRule(12)).toBeNull();
  });
  it("keeps precision at the low end", () => {
    expect(formatOdds(0.008)).toBe("0.8%");
    expect(formatOdds(0.014)).toBe("1.4%");
    expect(formatOdds(0.63)).toBe("63%");
  });
});
