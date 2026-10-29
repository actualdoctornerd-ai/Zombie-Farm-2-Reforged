import { describe, expect, it, vi } from "vitest";
import {
  COMBINE_BLUE_BY_GROUP,
  COMBINE_RED_BY_GROUP,
  COMBINE_SILVER_BY_GROUP,
  COMBINE_SPECIAL_BY_GROUP,
  COMBINE_SPECIAL_CHANCE,
  createCombineRandom,
  isCombinePromotion,
  selectCombineSpecies,
  type CombineSpeciesParent,
} from "./combineSpecies";

const parent = (
  key: string,
  extra: Partial<CombineSpeciesParent> = {}
): CombineSpeciesParent => ({ key, tier: 1, group: "Regular", ...extra });

// Derived from the tunable chance rather than hardcoded, so retuning the promotion
// rate cannot quietly turn a "does not promote" case into a promoting one.
/** A roll that clears the tier-5 promotion. */
const promotes = () => COMBINE_SPECIAL_CHANCE / 2;
/** A roll that misses it — the comparison is `<`, so the boundary itself fails. */
const missesPromotion = () => COMBINE_SPECIAL_CHANCE;

describe("Zombie Pot species selection", () => {
  it("uses the same stable roll regardless of parent id order", () => {
    const forward = createCombineRandom("parent-a", "parent-b");
    const reverse = createCombineRandom("parent-b", "parent-a");
    expect([forward(), forward(), forward()]).toEqual([reverse(), reverse(), reverse()]);
  });

  it("uses slot 1 as the output species", () => {
    const garden = parent("garden", { group: "Garden" });
    const large = parent("large", { group: "Large" });
    expect(selectCombineSpecies(garden, large, 24, missesPromotion)).toBe("garden");
    expect(selectCombineSpecies(large, garden, 24, missesPromotion)).toBe("large");
  });

  it("combines two specials into slot 1's", () => {
    expect(selectCombineSpecies(
      parent("special-a", { isSpecial: true }),
      parent("special-b", { isSpecial: true }),
      45,
      () => 0
    )).toBe("special-a");
    // A job started under the old rule still refuses the pair.
    expect(selectCombineSpecies(
      parent("special-a", { isSpecial: true }),
      parent("special-b", { isSpecial: true }),
      45,
      () => 0,
      () => false,
      true
    )).toBeNull();
  });

  it("always preserves a named special parent's species", () => {
    const evolutionRoll = vi.fn(() => 0);
    expect(selectCombineSpecies(
      parent("ZombieActorRegularCrazy", { tier: 5, group: "Regular", isSpecial: true }),
      parent("ordinary", { tier: 99 }),
      45,
      evolutionRoll
    )).toBe("ZombieActorRegularCrazy");
    expect(evolutionRoll).not.toHaveBeenCalled();
    // A special in slot 2 is only a donor: slot 1's species comes out.
    expect(selectCombineSpecies(
      parent("ordinary"),
      parent("ZombieActorBombie", { isSpecial: true, group: "Headless" }),
      45,
      missesPromotion
    )).toBe("ordinary");
    // A combine started before the slot-1 record keeps the old either-slot rule, so
    // its slot-2 special is not lost.
    expect(selectCombineSpecies(
      parent("ordinary"),
      parent("ZombieActorBombie", { isSpecial: true, group: "Headless" }),
      45,
      missesPromotion,
      () => false,
      true
    )).toBe("ZombieActorBombie");
  });

  it("keeps the named special edge cases", () => {
    expect(selectCombineSpecies(
      parent("ZombieActorBombie", { isSpecial: true, group: "Headless" }),
      parent("ordinary", { group: "Regular" }),
      45,
      () => 0
    )).toBe("ZombieActorBombie");
    expect(selectCombineSpecies(
      parent("ZombieActorHeadlessTier3", { group: "Headless", tier: 3 }),
      parent("ordinary", { group: "Regular" }),
      25,
      promotes
    )).toBe("ZombieActorHeadlessTier5");
  });

  it("does not make a combining special before level 25", () => {
    expect(selectCombineSpecies(
      parent("low", { tier: 1 }),
      parent("high", { tier: 4 }),
      24,
      promotes
    )).toBe("low");
  });

  it("maps every same-type eligible pair to its combining-only special", () => {
    for (const [group, specialKey] of Object.entries(COMBINE_SPECIAL_BY_GROUP)) {
      expect(selectCombineSpecies(
        parent(`${group}-a`, { group }),
        parent(`${group}-b`, { group }),
        25,
        promotes
      )).toBe(specialKey);
    }
  });

  it("promotes the slot-1 type after a successful mixed-type roll", () => {
    const garden = parent("garden", { group: "Garden" });
    const large = parent("large", { group: "Large" });
    expect(selectCombineSpecies(garden, large, 25, promotes))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Garden);
    expect(selectCombineSpecies(large, garden, 25, promotes))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Large);
  });

  it("breeds a matched pair up to its body type's silver", () => {
    for (const [group, silverKey] of Object.entries(COMBINE_SILVER_BY_GROUP)) {
      const same = parent(`${group}-same`, { group });
      expect(selectCombineSpecies(same, { ...same }, 25, missesPromotion)).toBe(silverKey);
    }
    // Two Flameheads -> Party Zombie, the Headless silver.
    const flamehead = parent("ZombieActorHeadlessTier3", { group: "Headless", tier: 3 });
    expect(selectCombineSpecies(flamehead, { ...flamehead }, 45, missesPromotion))
      .toBe("ZombieActorHeadlessTier4");
  });

  it("does not breed a matched pair up before level 25", () => {
    const brute = parent("ZombieActorLargeTier3", { group: "Large", tier: 3 });
    expect(selectCombineSpecies(brute, { ...brute }, 24, missesPromotion))
      .toBe("ZombieActorLargeTier3");
  });

  it("lets the tier-5 promotion override a matched pair's silver", () => {
    // Two Flameheads at level 25+ normally give a Party Zombie; the rare roll
    // upgrades that to Skull Head.
    const flamehead = parent("ZombieActorHeadlessTier3", { group: "Headless", tier: 3 });
    expect(selectCombineSpecies(flamehead, { ...flamehead }, 25, promotes))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Headless);
  });

  it("keeps a matched pair that is already silver", () => {
    // Mutant silvers must not flatten to the plain silver for their group.
    const eyebiscus = parent("ZombieActorRegularTier4Eyebiscus", { group: "Regular", tier: 4 });
    expect(selectCombineSpecies(eyebiscus, { ...eyebiscus }, 45, missesPromotion))
      .toBe("ZombieActorRegularTier4Eyebiscus");
  });

  it("re-cooks a matched special pair as itself", () => {
    const bombie = parent("ZombieActorBombie", { group: "Headless", isSpecial: true });
    expect(selectCombineSpecies(bombie, { ...bombie }, 45, () => 0)).toBe("ZombieActorBombie");
  });

  it("only breeds a matched pair up to silver from the RED step", () => {
    // The class is authoritative, not the key: Lima Beans is a silver under a Tier2
    // key, and re-cooking a pair of them must not flatten them to plain Robo Zombie.
    const lima = parent("ZombieActorRegularTier2LimaBeans", { group: "Regular", className: "Silver" });
    expect(selectCombineSpecies(lima, { ...lima }, 45, missesPromotion))
      .toBe("ZombieActorRegularTier2LimaBeans");
    // ...and a red mutant under a Tier2 key does breed up.
    const celery = parent("ZombieActorRegularTier2Celery", { group: "Regular", className: "Red" });
    expect(selectCombineSpecies(celery, { ...celery }, 45, missesPromotion))
      .toBe(COMBINE_SILVER_BY_GROUP.Regular);
  });

  it("uses the ordinary rules when the promotion roll fails", () => {
    expect(selectCombineSpecies(
      parent("mutant", { isMutant: true, tier: 5 }),
      parent("ordinary", { tier: 1 }),
      25,
      missesPromotion
    )).toBe("mutant");
  });
});

describe("matched-pair colour ladder", () => {
  /** Every coloured grave placed — the late-game farm. */
  const allGraves = () => true;
  const graves = (...owned: string[]) => (color: string) => owned.includes(color);

  it("breeds two greens up to their body type's blue once the Blue Grave is owned", () => {
    for (const [group, blueKey] of Object.entries(COMBINE_BLUE_BY_GROUP)) {
      const green = parent(`${group}-green`, { group, className: "Green" });
      expect(selectCombineSpecies(green, { ...green }, 1, missesPromotion, graves("Blue")))
        .toBe(blueKey);
    }
  });

  it("breeds two blues up to their body type's red once the Red Grave is owned", () => {
    for (const [group, redKey] of Object.entries(COMBINE_RED_BY_GROUP)) {
      const blue = parent(`${group}-blue`, { group, className: "Blue" });
      expect(selectCombineSpecies(blue, { ...blue }, 1, missesPromotion, graves("Red")))
        .toBe(redKey);
    }
  });

  it("holds a step back until its grave is owned", () => {
    const green = parent("ZombieActorRegularTier1", { group: "Regular", className: "Green" });
    // No Blue Grave: the pair stays green rather than leaping the lock.
    expect(selectCombineSpecies(green, { ...green }, 1, missesPromotion, graves("Red")))
      .toBe("ZombieActorRegularTier1");
    const blue = parent("ZombieActorRegularTier2", { group: "Regular", className: "Blue" });
    expect(selectCombineSpecies(blue, { ...blue }, 1, missesPromotion, graves("Blue")))
      .toBe("ZombieActorRegularTier2");
  });

  it("climbs one colour at a time — a green pair never lands on red or silver", () => {
    const green = parent("ZombieActorLargeTier1", { group: "Large", className: "Green" });
    // Level 45 with every grave: the silver breed-up and the tier-5 roll are both
    // available, and neither may short-circuit the ladder's first rung.
    expect(selectCombineSpecies(green, { ...green }, 45, promotes, allGraves))
      .toBe(COMBINE_BLUE_BY_GROUP.Large);
  });

  it("tops the ladder out at red -> silver, or the rare special", () => {
    const red = parent("ZombieActorHeadlessTier3", { group: "Headless", className: "Red" });
    expect(selectCombineSpecies(red, { ...red }, 25, missesPromotion, allGraves))
      .toBe(COMBINE_SILVER_BY_GROUP.Headless);
    expect(selectCombineSpecies(red, { ...red }, 25, promotes, allGraves))
      .toBe(COMBINE_SPECIAL_BY_GROUP.Headless);
    // Below the level gate the top step is closed, graves or not.
    expect(selectCombineSpecies(red, { ...red }, 24, promotes, allGraves))
      .toBe("ZombieActorHeadlessTier3");
  });

  it("leaves unmatched pairs and specials on the ordinary rules", () => {
    const green = parent("ZombieActorRegularTier1", { group: "Regular", className: "Green" });
    const other = parent("ZombieActorSmallTier1", { group: "Small", className: "Green" });
    expect(selectCombineSpecies(green, other, 1, missesPromotion, allGraves))
      .toBe("ZombieActorRegularTier1"); // slot 1 still wins
    const special = parent("ZombieActorBombie", { group: "Headless", className: "Special", isSpecial: true });
    expect(selectCombineSpecies(special, other, 45, missesPromotion, allGraves))
      .toBe("ZombieActorBombie");
  });

  it("counts a ladder step for the 'combine for' quests", () => {
    const green = parent("ZombieActorGirlTier1", { group: "Female", className: "Green" });
    const result = selectCombineSpecies(green, { ...green }, 1, missesPromotion, allGraves)!;
    expect(isCombinePromotion(result, green.key, green.key)).toBe(true);
  });
});

describe("combine promotion (what the 'combine for a <silver>' quests credit)", () => {
  const brute = parent("ZombieActorLargeTier3", { group: "Large", tier: 3 });

  it("counts a matched pair that breeds up to its silver", () => {
    const result = selectCombineSpecies(brute, { ...brute }, 25, missesPromotion)!;
    expect(isCombinePromotion(result, brute.key, brute.key)).toBe(true);
  });

  it("counts the rare tier-5 roll", () => {
    const result = selectCombineSpecies(brute, { ...brute }, 25, promotes)!;
    expect(isCombinePromotion(result, brute.key, brute.key)).toBe(true);
  });

  it("does not count a silver re-cooked in slot 1 against anything", () => {
    const zombarian = parent("ZombieActorLargeTier4", { group: "Large", tier: 4 });
    const filler = parent("ZombieActorRegularTier1");
    const result = selectCombineSpecies(zombarian, filler, 25, missesPromotion)!;
    expect(result).toBe(zombarian.key);
    expect(isCombinePromotion(result, zombarian.key, filler.key)).toBe(false);
  });

  it("does not count a matched silver pair that failed to promote", () => {
    const zombarian = parent("ZombieActorLargeTier4", { group: "Large", tier: 4 });
    const result = selectCombineSpecies(zombarian, { ...zombarian }, 25, missesPromotion)!;
    expect(isCombinePromotion(result, zombarian.key, zombarian.key)).toBe(false);
  });
});
