import { describe, expect, it } from "vitest";
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../../src/epicBoss/rewards";
import { isKnownZombie } from "../src/rosterCatalog";
import { zombieCropEcon } from "../src/zombieCropCatalog";
import { questReward } from "../src/questCatalog";

describe("authoritative Epic zombie rewards", () => {
  it("recognizes all rewards without making any of them purchasable crops", () => {
    for (const [questId, key] of Object.entries(EPIC_QUEST_ZOMBIE_REWARDS)) {
      expect(questReward(questId)?.rewardItemKey).toBe(key);
      expect(isKnownZombie(key)).toBe(true);
      expect(zombieCropEcon(key)).toBeUndefined();
    }
  });
});
