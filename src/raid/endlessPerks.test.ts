// Endless's permanent unlocks and deep-tier brains (owner, 2026-11-08).
import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import upgrades from "../../public/assets/upgrades.json";
import type { ZombieDef } from "../assets";
import { buildPlayerUnits } from "./CombatEngine";
import { endlessMilestoneRewards, endlessVictoryRewards } from "./endlessLoot";
import {
  BASE_MAX_VET_RANK, ENDLESS_EXPANSION_SIZE, ENDLESS_PERK_TIER, endlessBestTierOf, endlessMaxVetRankOf,
  endlessPerksFor, endlessVictoryBrains,
} from "./endlessPerks";
import { MAX_VET_RANK, VET_RANKS, veterancy, veterancyLevel } from "../zombie/traits";
import { makeOwned } from "../zombie/types";

describe("Endless permanent unlocks", () => {
  it("open one per tier from T4 to T7", () => {
    expect(endlessPerksFor(3)).toEqual({ cryptSlots: 0, shedSlots: 0, expansion: false, vetRanks: 0 });
    expect(endlessPerksFor(4)).toEqual({ cryptSlots: 8, shedSlots: 0, expansion: false, vetRanks: 0 });
    expect(endlessPerksFor(5)).toEqual({ cryptSlots: 8, shedSlots: 16, expansion: false, vetRanks: 0 });
    expect(endlessPerksFor(6)).toEqual({ cryptSlots: 8, shedSlots: 16, expansion: true, vetRanks: 0 });
    expect(endlessPerksFor(7)).toEqual({ cryptSlots: 8, shedSlots: 16, expansion: true, vetRanks: 1 });
    expect(endlessPerksFor(30)).toEqual(endlessPerksFor(7));
  });

  it("each come as a first-clear reward at its own tier", () => {
    for (const [perk, tier] of Object.entries(ENDLESS_PERK_TIER)) {
      expect(endlessMilestoneRewards("endless", tier)).toEqual([expect.objectContaining({ kind: "perk", perk })]);
    }
  });

  it("read a missing or malformed best tier as none", () => {
    expect(endlessBestTierOf({})).toBe(0);
    expect(endlessBestTierOf(null)).toBe(0);
    expect(endlessBestTierOf({ endlessBestTier: "7" })).toBe(0);
    expect(endlessBestTierOf({ endlessBestTier: 7.9 })).toBe(7);
  });

  it("sell the 80x80 farm only behind its tier", () => {
    const tier = upgrades.mapSize.find((t) => t.size === ENDLESS_EXPANSION_SIZE) as { endlessTier?: number } | undefined;
    expect(tier?.endlessTier).toBe(ENDLESS_PERK_TIER.expansion);
  });
});

describe("Deep-tier brains", () => {
  it("pay 4 at T8 and one more each tier, on every boss win", () => {
    expect([7, 8, 9, 10, 11, 15].map(endlessVictoryBrains)).toEqual([0, 4, 5, 6, 7, 11]);
    expect(endlessVictoryRewards("endless", 9)).toEqual([{ kind: "brains", name: "Brains", quantity: 5 }]);
    expect(endlessVictoryRewards("endless", 7)).toEqual([]);
    expect(endlessVictoryRewards("nightmare", 9)).toEqual([]);
  });
});

describe("Legend veterancy", () => {
  const def = (zombiesJson as ZombieDef[]).find((z) => z.key === "ZombieActorRegularTier1")!;
  it("is a sixth rank only an account past T7 reaches", () => {
    expect(BASE_MAX_VET_RANK).toBe(MAX_VET_RANK);
    expect(VET_RANKS[MAX_VET_RANK + 1]).toBe("Legend");
    expect(veterancyLevel(9, MAX_VET_RANK)).toBe(5);
    expect(veterancyLevel(9, MAX_VET_RANK + 1)).toBe(6);
    expect(veterancy(6, 6)).toBe("Legend");
    expect(veterancyLevel(5, 6)).toBe(5);
    expect(endlessMaxVetRankOf({ endlessBestTier: 6 })).toBe(5);
    expect(endlessMaxVetRankOf({ endlessBestTier: 7 })).toBe(6);
  });

  it("adds another 5% in battle, and only where the fight says so", () => {
    const zombie = makeOwned("z", def, 0, 0, 9, 0);
    const opts = { abilitySlotUnlocked: () => false };
    const [master] = buildPlayerUnits([zombie], opts);
    const [legend] = buildPlayerUnits([zombie], { ...opts, maxVetRank: 6 });
    expect(legend.maxHp / master.maxHp).toBeCloseTo(1.30 / 1.25, 2);
  });
});
