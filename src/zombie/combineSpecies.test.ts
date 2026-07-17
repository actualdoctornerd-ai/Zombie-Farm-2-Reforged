import { describe, expect, it } from "vitest";
import {
  COMBINE_SPECIAL_BY_GROUP,
  createCombineRandom,
  selectCombineSpecies,
  type CombineSpeciesParent,
} from "./combineSpecies";

const parent = (
  key: string,
  extra: Partial<CombineSpeciesParent> = {}
): CombineSpeciesParent => ({ key, tier: 1, group: "Regular", ...extra });

const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 0;
};

describe("Zombie Pot species selection", () => {
  it("uses the same stable roll regardless of parent slot order", () => {
    const forward = createCombineRandom("parent-a", "parent-b");
    const reverse = createCombineRandom("parent-b", "parent-a");
    expect([forward(), forward(), forward()]).toEqual([reverse(), reverse(), reverse()]);

    const garden = parent("garden", { group: "Garden" });
    const large = parent("large", { group: "Large" });
    expect(selectCombineSpecies(garden, large, 25, sequence(0.05, 0.25)))
      .toBe(selectCombineSpecies(large, garden, 25, sequence(0.05, 0.25)));
  });

  it("rejects two specials", () => {
    expect(selectCombineSpecies(
      parent("special-a", { isSpecial: true }),
      parent("special-b", { isSpecial: true }),
      45,
      () => 0
    )).toBeNull();
  });

  it("always preserves the one special parent's species", () => {
    expect(selectCombineSpecies(
      parent("ZombieActorRegularCrazy", { tier: 5, isSpecial: true }),
      parent("ordinary", { tier: 99 }),
      45,
      () => 0
    )).toBe("ZombieActorRegularCrazy");
  });

  it("does not make a combining special before level 25", () => {
    expect(selectCombineSpecies(
      parent("low", { tier: 1 }),
      parent("high", { tier: 4 }),
      24,
      () => 0.05
    )).toBe("high");
  });

  it("maps every same-type eligible pair to its combining-only special", () => {
    for (const [group, specialKey] of Object.entries(COMBINE_SPECIAL_BY_GROUP)) {
      expect(selectCombineSpecies(
        parent(`${group}-a`, { group }),
        parent(`${group}-b`, { group }),
        25,
        () => 0.099
      )).toBe(specialKey);
    }
  });

  it("chooses either input type evenly after a successful mixed-type roll", () => {
    const garden = parent("garden", { group: "Garden" });
    const large = parent("large", { group: "Large" });
    expect(selectCombineSpecies(garden, large, 25, sequence(0.05, 0.49)))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Garden);
    expect(selectCombineSpecies(garden, large, 25, sequence(0.05, 0.50)))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Large);
  });

  it("uses the ordinary rules when the 10% roll fails", () => {
    expect(selectCombineSpecies(
      parent("mutant", { isMutant: true, tier: 5 }),
      parent("ordinary", { tier: 1 }),
      25,
      () => 0.10
    )).toBe("ordinary");
  });
});
