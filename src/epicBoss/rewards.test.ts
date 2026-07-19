import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import questRows from "../../public/assets/quests.json";
import { purchasableZombies, type ZombieDef } from "../assets";
import {
  EPIC_QUEST_ZOMBIE_REWARDS,
  epicBossCurrencyReward,
  epicQuestZombieReward,
  shouldStoreEpicReward,
} from "./rewards";

describe("Epic Boss zombie rewards", () => {
  it("maps every recovered zombie quest to a dedicated reward-only actor", () => {
    const zombies = zombieRows as ZombieDef[];
    const byKey = new Map(zombies.map((zombie) => [zombie.key, zombie]));
    const purchasable = new Set(purchasableZombies(zombies).map((zombie) => zombie.key));
    expect(Object.keys(EPIC_QUEST_ZOMBIE_REWARDS)).toHaveLength(15);
    for (const [questId, key] of Object.entries(EPIC_QUEST_ZOMBIE_REWARDS)) {
      const quest = questRows[questId as keyof typeof questRows];
      const zombie = byKey.get(key);
      expect(quest.rewardType).toBe(5);
      expect(quest.rewardItemKey).toBe(key);
      expect(zombie?.rewardOnly).toBe(true);
      expect(zombie?.specialSprite).toMatch(/\.png$/);
      expect(purchasable.has(key)).toBe(false);
      expect(epicQuestZombieReward(questId)).toBe(key);
    }
  });

  it("delivers to the farm until its cap is full, then uses storage", () => {
    expect(shouldStoreEpicReward(15, 16)).toBe(false);
    expect(shouldStoreEpicReward(16, 16)).toBe(true);
  });
});

describe("Epic Boss currency rewards", () => {
  it("awards brains only on every 5th level, with a bonus at the top tier(s)", () => {
    // Non-milestone levels grant no brains (post-brainflation revert).
    expect(epicBossCurrencyReward(1).brains).toBe(0);
    expect(epicBossCurrencyReward(6).brains).toBe(0);
    expect(epicBossCurrencyReward(24).brains).toBe(0);
    // Every 5th level grants one brain.
    expect(epicBossCurrencyReward(5).brains).toBe(1);
    expect(epicBossCurrencyReward(20).brains).toBe(1); // full ladder: no top-tier bonus yet
    expect(epicBossCurrencyReward(25).brains).toBe(1);
    // Top tiers (30/35/40 on a 40-level ladder) grant a bonus brain.
    expect(epicBossCurrencyReward(30).brains).toBe(2);
    expect(epicBossCurrencyReward(35).brains).toBe(2);
    expect(epicBossCurrencyReward(40).brains).toBe(2);
  });

  it("gives Dr. Groundhog's short ladder its bonus brain at level 20", () => {
    // maxLevel 20 boss: the top-tier bonus lands on its final level.
    expect(epicBossCurrencyReward(20, 20).brains).toBe(2);
    expect(epicBossCurrencyReward(15, 20).brains).toBe(1);
    expect(epicBossCurrencyReward(30, 20).brains).toBe(1); // beyond its ladder: plain milestone, no bonus
  });

  it("leaves the gold reward at its pre-revert per-level curve", () => {
    expect(epicBossCurrencyReward(1).gold).toBe(100);
    expect(epicBossCurrencyReward(5).gold).toBe(100);
    expect(epicBossCurrencyReward(6).gold).toBe(200);
    expect(epicBossCurrencyReward(38).gold).toBe(1000);
    expect(epicBossCurrencyReward(40).gold).toBe(1000);
  });
});
