import { describe, expect, it } from "vitest";
import {
  LIFE_FORCE_THRESHOLDS, MAX_LIFE_FORCE_LEVEL, abilitySlotRequirement, abilitySlotUnlocked,
  cropMutationChance, farmLifeForce, fertilizeMultiplier, harvestFailureChance, harvestFails, lifeForceLevel,
  lifeForceEffects, lifeForceLevelRows, lifeForceProgress, zombieHarvestTier, HARVEST_TIER_NAMES,
} from "./lifeForce";
import zombies from "../public/assets/zombies.json";

describe("lifeForceLevel", () => {
  it("steps up exactly at each threshold", () => {
    expect(LIFE_FORCE_THRESHOLDS).toEqual([20, 45, 75, 110, 155, 250, 300, 350, 400, 450]);
    expect(lifeForceLevel(0)).toBe(0);
    expect(lifeForceLevel(19)).toBe(0);
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
    expect(lifeForceProgress(0)).toMatchObject({ level: 0, floor: 0, next: 20, toNext: 20, progress: 0 });
    expect(lifeForceProgress(10).progress).toBeCloseTo(0.5);
    const p = lifeForceProgress(60); // level 2 is 45..75
    expect(p).toMatchObject({ level: 2, floor: 45, next: 75, toNext: 15 });
    expect(p.progress).toBeCloseTo(0.5);
  });

  it("is full with nothing to go at the cap", () => {
    expect(lifeForceProgress(450)).toMatchObject({ level: 10, next: null, toNext: null, progress: 1 });
    expect(lifeForceProgress(900)).toMatchObject({ level: 10, next: null, progress: 1 });
  });

  it("treats a negative or fractional total sensibly", () => {
    expect(lifeForceProgress(-5).total).toBe(0);
    expect(lifeForceProgress(19.9).level).toBe(0);
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
  it("is 10% at level 0 and gains 10 points a level", () => {
    expect(cropMutationChance(0)).toBeCloseTo(0.1);
    expect(cropMutationChance(1)).toBeCloseTo(0.2);
    expect(cropMutationChance(5)).toBeCloseTo(0.6);
    expect(cropMutationChance(8)).toBeCloseTo(0.9);
  });
  it("reaches 100% at level 9 and never exceeds it", () => {
    expect(cropMutationChance(9)).toBe(1);
    expect(cropMutationChance(10)).toBe(1);
    expect(cropMutationChance(50)).toBe(1);
    expect(cropMutationChance(-3)).toBeCloseTo(0.1);
  });
});

describe("harvestFailureChance", () => {
  it("is 10 points per tier above Green, less 10 per level", () => {
    expect(harvestFailureChance(2, 0)).toBeCloseTo(0.1);
    expect(harvestFailureChance(3, 0)).toBeCloseTo(0.2);
    expect(harvestFailureChance(4, 1)).toBeCloseTo(0.2);
    expect(harvestFailureChance(5, 0)).toBeCloseTo(0.4);
  });
  it("never makes a Green zombie lifeless, at any level", () => {
    for (let level = 0; level <= 10; level++) expect(harvestFailureChance(1, level)).toBe(0);
  });
  it("makes a tier-5 zombie safe from level 4", () => {
    expect(harvestFailureChance(5, 3)).toBeCloseTo(0.1);
    expect(harvestFailureChance(5, 4)).toBe(0);
  });
  it("is safe once the level reaches tier - 1, and never goes negative or above 1", () => {
    for (let tier = 1; tier <= 5; tier++) {
      for (let level = 0; level <= 10; level++) {
        const c = harvestFailureChance(tier, level);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        if (level >= tier - 1) expect(c).toBe(0);
      }
    }
  });
});

describe("fertilizeMultiplier", () => {
  it("adds n% at level n, stacking: x1 at level 0, x1.55 at level 10", () => {
    expect(fertilizeMultiplier(0)).toBe(1);
    expect(fertilizeMultiplier(1)).toBeCloseTo(1.01);
    expect(fertilizeMultiplier(2)).toBeCloseTo(1.03);
    expect(fertilizeMultiplier(5)).toBeCloseTo(1.15);
    expect(fertilizeMultiplier(10)).toBeCloseTo(1.55);
    expect(fertilizeMultiplier(99)).toBeCloseTo(1.55);
  });
});

describe("harvestFails", () => {
  it("never fails at chance 0 and always fails at chance 1", () => {
    expect(harvestFails(1, 0, () => 0)).toBe(false);
    expect(harvestFails(5, 0, () => 0.399999)).toBe(true);
  });
  it("fails exactly when the roll is under the chance", () => {
    expect(harvestFails(2, 0, () => 0.09)).toBe(true); // chance 0.1
    expect(harvestFails(2, 0, () => 0.1)).toBe(false);
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
    expect([1, 2, 3, 4].map(abilitySlotRequirement)).toEqual([20, 45, 75, 110]);
  });
});

describe("lifeForceEffects", () => {
  it("summarises what a level gives, for the popover", () => {
    expect(lifeForceEffects(0)).toEqual({ mutationChance: 0.1, fertilizeMultiplier: 1, safeTier: 1, abilitySlots: 0 });
    expect(lifeForceEffects(3)).toMatchObject({ safeTier: 4, abilitySlots: 3 });
    expect(lifeForceEffects(3).mutationChance).toBeCloseTo(0.4);
  });
  it("caps safe tiers at 5, ability slots at 4 and mutation at 100%", () => {
    expect(lifeForceEffects(7)).toMatchObject({ safeTier: 5, abilitySlots: 4 });
    expect(lifeForceEffects(10)).toMatchObject({ mutationChance: 1, safeTier: 5, abilitySlots: 4 });
    expect(lifeForceEffects(99)).toMatchObject({ mutationChance: 1, safeTier: 5, abilitySlots: 4 });
  });
});

describe("lifeForceLevelRows", () => {
  const rows = lifeForceLevelRows();
  it("lists levels 1 to 10 with their thresholds", () => {
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.map((r) => r.need)).toEqual([20, 45, 75, 110, 155, 250, 300, 350, 400, 450]);
  });
  it("says what each level adds", () => {
    expect(rows[0]).toMatchObject({ safeTierGained: 2, abilitySlotGained: 1 });
    expect(rows[3]).toMatchObject({ safeTierGained: 5, abilitySlotGained: 4 });
    expect(rows[4]).toMatchObject({ safeTierGained: null, abilitySlotGained: null });
    expect(rows[9].mutationChance).toBe(1);
  });
  it("names every harvest tier", () => {
    expect(HARVEST_TIER_NAMES).toHaveLength(5);
  });
});
