import { describe, expect, it } from "vitest";
import {
  LIFE_FORCE_THRESHOLDS, MAX_LIFE_FORCE_LEVEL, abilitySlotRequirement, abilitySlotUnlocked,
  cropMutationChance, farmLifeForce, harvestFailureChance, harvestFails, lifeForceLevel,
  lifeForceProgress, zombieHarvestTier,
} from "./lifeForce";
import zombies from "../public/assets/zombies.json";

describe("lifeForceLevel", () => {
  it("steps up exactly at each threshold", () => {
    expect(LIFE_FORCE_THRESHOLDS).toEqual([30, 65, 105, 150, 200, 250, 300, 350, 400, 450]);
    expect(lifeForceLevel(0)).toBe(0);
    expect(lifeForceLevel(29)).toBe(0);
    LIFE_FORCE_THRESHOLDS.forEach((need, i) => {
      expect(lifeForceLevel(need - 1)).toBe(i);
      expect(lifeForceLevel(need)).toBe(i + 1);
    });
  });

  it("caps at level 10 however much Life Force there is", () => {
    expect(MAX_LIFE_FORCE_LEVEL).toBe(10);
    expect(lifeForceLevel(450)).toBe(10);
    expect(lifeForceLevel(5_000)).toBe(10);
  });
});

describe("lifeForceProgress", () => {
  it("reports progress through the current level", () => {
    expect(lifeForceProgress(0)).toMatchObject({ level: 0, floor: 0, next: 30, toNext: 30, progress: 0 });
    expect(lifeForceProgress(15).progress).toBeCloseTo(0.5);
    const p = lifeForceProgress(85); // level 2 is 65..105
    expect(p).toMatchObject({ level: 2, floor: 65, next: 105, toNext: 20 });
    expect(p.progress).toBeCloseTo(0.5);
  });

  it("is full with nothing to go at the cap", () => {
    expect(lifeForceProgress(450)).toMatchObject({ level: 10, next: null, toNext: null, progress: 1 });
    expect(lifeForceProgress(900)).toMatchObject({ level: 10, next: null, progress: 1 });
  });

  it("treats a negative or fractional total sensibly", () => {
    expect(lifeForceProgress(-5).total).toBe(0);
    expect(lifeForceProgress(29.9).level).toBe(0);
  });
});

describe("farmLifeForce", () => {
  const table: Record<string, number> = { crate: 1, gazeboNormal: 16, rocks: 0 };
  const of = (k: string) => table[k] ?? 0;
  it("sums the placed objects, counting repeats and ignoring unknown keys", () => {
    expect(farmLifeForce(["crate", "crate", "gazeboNormal", "rocks", "mystery"], of)).toBe(18);
    expect(farmLifeForce([], of)).toBe(0);
  });
  it("ignores a bad value rather than poisoning the total", () => {
    expect(farmLifeForce(["crate", "bad"], (k) => (k === "bad" ? Number.NaN : 1))).toBe(1);
  });
});

describe("cropMutationChance", () => {
  it("is 5% at level 0 and gains 10 points a level", () => {
    expect(cropMutationChance(0)).toBeCloseTo(0.05);
    expect(cropMutationChance(1)).toBeCloseTo(0.15);
    expect(cropMutationChance(5)).toBeCloseTo(0.55);
    expect(cropMutationChance(9)).toBeCloseTo(0.95);
  });
  it("reaches 100% at level 10 and never exceeds it", () => {
    expect(cropMutationChance(10)).toBe(1);
    expect(cropMutationChance(50)).toBe(1);
    expect(cropMutationChance(-3)).toBeCloseTo(0.05);
  });
});

describe("harvestFailureChance", () => {
  it("is 20 points per level the tier is above the level", () => {
    expect(harvestFailureChance(1, 0)).toBeCloseTo(0.2);
    expect(harvestFailureChance(3, 1)).toBeCloseTo(0.4);
    expect(harvestFailureChance(4, 0)).toBeCloseTo(0.8);
  });
  it("makes a tier-1 zombie safe from level 1", () => {
    for (let level = 1; level <= 10; level++) expect(harvestFailureChance(1, level)).toBe(0);
  });
  it("makes a tier-5 zombie fail always at level 0 and be safe from level 5", () => {
    expect(harvestFailureChance(5, 0)).toBe(1);
    expect(harvestFailureChance(5, 4)).toBeCloseTo(0.2);
    expect(harvestFailureChance(5, 5)).toBe(0);
  });
  it("is safe whenever the level reaches the tier, and never goes negative or above 1", () => {
    for (let tier = 1; tier <= 5; tier++) {
      for (let level = 0; level <= 10; level++) {
        const c = harvestFailureChance(tier, level);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        if (level >= tier) expect(c).toBe(0);
      }
    }
  });
});

describe("harvestFails", () => {
  it("never fails at chance 0 and always fails at chance 1", () => {
    expect(harvestFails(1, 1, () => 0)).toBe(false);
    expect(harvestFails(5, 0, () => 0.999999)).toBe(true);
  });
  it("fails exactly when the roll is under the chance", () => {
    expect(harvestFails(2, 0, () => 0.39)).toBe(true); // chance 0.4
    expect(harvestFails(2, 0, () => 0.4)).toBe(false);
  });
});

describe("zombieHarvestTier", () => {
  it("follows the colour class rank, with Obsidian and specials at 5", () => {
    expect(zombieHarvestTier({ category: "normal", tier: 1 })).toBe(1);
    expect(zombieHarvestTier({ category: "normal", tier: 4 })).toBe(4);
    expect(zombieHarvestTier({ category: "normal", tier: 6 })).toBe(5); // Obsidian
    expect(zombieHarvestTier({ category: "special", tier: 1 })).toBe(5);
    expect(zombieHarvestTier({ category: "special", tier: 3 })).toBe(5);
    expect(zombieHarvestTier({})).toBe(1);
  });

  it("puts every real zombie in 1..5, with the six Obsidians and all specials at 5", () => {
    const defs = zombies as { key: string; category: string; className: string; tier: number }[];
    for (const z of defs) {
      const t = zombieHarvestTier(z);
      expect(t, z.key).toBeGreaterThanOrEqual(1);
      expect(t, z.key).toBeLessThanOrEqual(5);
      if (z.className === "Obsidian" || z.category === "special") expect(t, z.key).toBe(5);
    }
  });
});

describe("ability slots", () => {
  it("slot k works from level k", () => {
    expect(abilitySlotUnlocked(1, 0)).toBe(false);
    expect(abilitySlotUnlocked(1, 1)).toBe(true);
    expect(abilitySlotUnlocked(4, 3)).toBe(false);
    expect(abilitySlotUnlocked(4, 4)).toBe(true);
  });
  it("names the Life Force each slot needs", () => {
    expect([1, 2, 3, 4].map(abilitySlotRequirement)).toEqual([30, 65, 105, 150]);
  });
});
