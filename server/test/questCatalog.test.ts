import { describe, it, expect } from "vitest";
import { QUEST_REWARDS, questReward, QUEST_REWARD } from "../src/questCatalog";

describe("questCatalog — mirror of quests.json rewards", () => {
  it("has all 96 quests with sane, bounded reward values", () => {
    const ids = Object.keys(QUEST_REWARDS);
    expect(ids.length).toBe(96);
    for (const [id, r] of Object.entries(QUEST_REWARDS)) {
      expect(Number.isInteger(r.rewardValue), id).toBe(true);
      expect(r.rewardValue, id).toBeGreaterThanOrEqual(0);
      expect(r.rewardValue, id).toBeLessThanOrEqual(1000); // catalog max is 700
      expect([0, 1, 2, 3, 5], id).toContain(r.rewardType);
    }
  });
  it("resolves known quest rewards and rejects unknown ids", () => {
    expect(questReward("0")).toEqual({ rewardType: QUEST_REWARD.Xp, rewardValue: 30, rewardItemKey: "" });
    expect(questReward("54")).toMatchObject({ rewardType: QUEST_REWARD.Gold, rewardValue: 20 });
    expect(questReward("99999")).toBeUndefined();
    expect(questReward("")).toBeUndefined();
  });
});
