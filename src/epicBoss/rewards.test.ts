import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import questRows from "../../public/assets/quests.json";
import { purchasableZombies, type ZombieDef } from "../assets";
import {
  EPIC_QUEST_ZOMBIE_REWARDS,
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
