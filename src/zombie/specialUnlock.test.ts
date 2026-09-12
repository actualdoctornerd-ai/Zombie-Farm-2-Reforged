import { describe, expect, it } from "vitest";
import raidRows from "../../public/assets/raids/raids.json";
import zombieRows from "../../public/assets/zombies.json";
import {
  BLACK_MARKET_SPECIAL_FLOOR_LEVEL,
  BLACK_MARKET_SPECIAL_HEAD_START,
  blackMarketSpecialLevel,
} from "../blackMarketRules";
import { EPIC_BOSS_UNLOCK_LEVELS } from "../epicBoss/catalog";
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../epicBoss/rewards";
import { RAID_ZOMBIE_SOURCES } from "../raid/zombieDrops";
import { COMBINE_SPECIAL_BY_GROUP, COMBINE_SPECIAL_LEVEL } from "./combineSpecies";
import { SPECIAL_ZOMBIE_SOURCE_LEVELS, specialZombieSourceLevel } from "./specialUnlock";

const RAID_UNLOCK = new Map(
  (raidRows as Array<{ id: number; unlockLevel: number }>).map((raid) => [raid.id, raid.unlockLevel])
);

describe("special zombie source levels", () => {
  it("reads each invasion prize off its own raid, elite prizes included", () => {
    for (const source of RAID_ZOMBIE_SOURCES) {
      expect(specialZombieSourceLevel(source.drop.key))
        .toBe(RAID_UNLOCK.get(source.raidId));
    }
    // Spot-checks that would catch a silently emptied map.
    expect(specialZombieSourceLevel("ZombieActorZastronaut")).toBe(36);
    expect(specialZombieSourceLevel("ZombieActorRegularFinalBoss")).toBe(43);
  });

  it("reads each Epic prize off its event's unlock level", () => {
    for (const key of Object.values(EPIC_QUEST_ZOMBIE_REWARDS)) {
      expect(Object.values(EPIC_BOSS_UNLOCK_LEVELS)).toContain(specialZombieSourceLevel(key));
    }
    expect(specialZombieSourceLevel("ZombieActorVagabond")).toBe(42);   // Loco Locust
    expect(specialZombieSourceLevel("ZombieActorOmegaDrZombie")).toBe(24); // Dr. Groundhog
  });

  it("puts the Pot's tier-5 promotions at the combine level", () => {
    for (const key of Object.values(COMBINE_SPECIAL_BY_GROUP)) {
      expect(specialZombieSourceLevel(key)).toBe(COMBINE_SPECIAL_LEVEL);
    }
  });

  it("has no source for a zombie nothing grants", () => {
    expect(specialZombieSourceLevel("ZombieActorZomBetty")).toBeNull();
    expect(specialZombieSourceLevel("not-a-zombie")).toBeNull();
  });

  it("only ever names real catalog zombies", () => {
    const keys = new Set((zombieRows as Array<{ key: string }>).map((zombie) => zombie.key));
    for (const key of SPECIAL_ZOMBIE_SOURCE_LEVELS.keys()) expect(keys).toContain(key);
  });
});

describe("the Black Market special gate", () => {
  it("never lets a special be bought more than the head start before its source", () => {
    for (const [key, sourceLevel] of SPECIAL_ZOMBIE_SOURCE_LEVELS) {
      expect(blackMarketSpecialLevel(key))
        .toBeGreaterThanOrEqual(sourceLevel - BLACK_MARKET_SPECIAL_HEAD_START);
    }
  });

  it("hands the head start to every special whose source clears the floor", () => {
    // A gate that simply equalled the source would make the market the LAST place a
    // prize turns up; the three levels are the whole point of the rule.
    for (const [key, sourceLevel] of SPECIAL_ZOMBIE_SOURCE_LEVELS) {
      if (sourceLevel - BLACK_MARKET_SPECIAL_HEAD_START <= BLACK_MARKET_SPECIAL_FLOOR_LEVEL) continue;
      expect(blackMarketSpecialLevel(key)).toBe(sourceLevel - BLACK_MARKET_SPECIAL_HEAD_START);
    }
    expect(blackMarketSpecialLevel("ZombieActorZastronaut")).toBe(33); // Aliens at 36
    expect(blackMarketSpecialLevel("ZombieActorVagabond")).toBe(39);   // Loco Locust at 42
    expect(blackMarketSpecialLevel("ZombieActorRegularFinalBoss")).toBe(40); // Video Games at 43
  });

  it("never lets a special be bought below the floor", () => {
    for (const zombie of zombieRows as Array<{ key: string; category: string }>) {
      if (zombie.category !== "special") continue;
      expect(blackMarketSpecialLevel(zombie.key))
        .toBeGreaterThanOrEqual(BLACK_MARKET_SPECIAL_FLOOR_LEVEL);
    }
  });

  it("is never stricter than planting one of the specials the Market itself sells", () => {
    // The five brain-market specials (Bombie, Crazy, Cupid, Dapper, Granny) can be PLANTED
    // at their catalog level. A trade gate above that would make the Black Market the
    // harder of the two routes to a zombie anyone can simply grow, which is backwards.
    for (const zombie of zombieRows as Array<{ key: string; category: string; level: number; marketHidden?: boolean; rewardOnly?: boolean }>) {
      if (zombie.category !== "special" || zombie.marketHidden || zombie.rewardOnly) continue;
      expect(blackMarketSpecialLevel(zombie.key)).toBeLessThanOrEqual(zombie.level);
    }
  });
});
