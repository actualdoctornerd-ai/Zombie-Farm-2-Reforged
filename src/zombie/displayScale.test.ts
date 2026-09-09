import { describe, expect, it } from "vitest";
import {
  zombieFarmScale,
  zombieRaidHeightScale,
} from "./displayScale";

describe("zombie display sizing", () => {
  it("keeps regular, brute, and headless bodies on the same actor scale", () => {
    expect(zombieFarmScale("Regular", "Green", "ZombieActorRegularTier1")).toBe(0.9);
    expect(zombieFarmScale("Large", "Green", "ZombieActorLargeTier1")).toBe(0.9);
    expect(zombieFarmScale("Headless", "Green", "ZombieActorHeadlessTier1")).toBe(0.9);
  });

  it("steps female, garden, and small families down in order", () => {
    const female = zombieFarmScale("Female", "Green", "ZombieActorGirlTier1");
    const garden = zombieFarmScale("Garden", "Green", "ZombieActorGardenTier1");
    const small = zombieFarmScale("Small", "Green", "ZombieActorSmallTier1");
    expect(0.9).toBeGreaterThan(female);
    expect(female).toBeGreaterThan(garden);
    expect(garden).toBeGreaterThan(small);
  });

  it("defaults named specials to regular size while retaining known small transformations", () => {
    expect(zombieFarmScale("Female", "Special", "ZombieActorZomBetty")).toBe(0.9);
    expect(zombieFarmScale("Small", "Special", "ZombieActorSmallTier5")).toBe(0.6);
    // A Small-GROUP special is a Mini and takes the Mini scale by default (Proto Zombie,
    // Zombug, Zombozo); every other family's specials stay at Regular size.
    expect(zombieFarmScale("Small", "Special", "ZombieActorProto")).toBe(0.6);
    expect(zombieFarmScale("Large", "Special", "ZombieActorMerZombie")).toBe(0.9);
    expect(zombieFarmScale("Headless", "Special", "ZombieActorZombieBot")).toBe(0.9);
    expect(zombieRaidHeightScale("Garden", "Green", "ZombieActorGardenTier1", 70, 70))
      .toBeCloseTo(0.7 / 0.9);
  });

  it("uses each Headless rig's real farm silhouette instead of a family-wide guess", () => {
    const regularHeight = 82.18;
    expect(zombieRaidHeightScale(
      "Headless", "Green", "ZombieActorHeadlessTier1", 38.66, regularHeight,
    )).toBeCloseTo(38.66 / regularHeight);
    expect(zombieRaidHeightScale(
      "Headless", "Special", "ZombieActorHeadlessTier5", 77.8, regularHeight,
    )).toBeCloseTo((0.8 / 0.9) * (77.8 / regularHeight));
  });

  it("carries every farm family size into raids relative to the regular baseline", () => {
    const cases = [
      ["Regular", "Green", "ZombieActorRegularTier1"],
      ["Large", "Green", "ZombieActorLargeTier1"],
      ["Headless", "Green", "ZombieActorHeadlessTier1"],
      ["Female", "Green", "ZombieActorGirlTier1"],
      ["Garden", "Green", "ZombieActorGardenTier1"],
      ["Small", "Green", "ZombieActorSmallTier1"],
      ["Small", "Special", "ZombieActorSmallTier5"],
      ["Girl", "Special", "ZombieActorGirlTier5"],
      ["Headless", "Special", "ZombieActorHeadlessTier5"],
    ] as const;

    for (const [group, className, key] of cases) {
      const nativeHeight = group === "Headless" ? 40 : 80;
      expect(zombieRaidHeightScale(group, className, key, nativeHeight, 80))
        .toBeCloseTo((zombieFarmScale(group, className, key) / 0.9) * (nativeHeight / 80));
    }
  });
});
