import { describe, expect, it } from "vitest";
import placeables from "../../public/assets/placeables.json";
import quests from "../../public/assets/quests.json";

const ITEM_BOUGHT = "kItemBoughtNotification";

describe("purchase quest catalog", () => {
  it("gives every buy objective an exact, purchasable Market item", () => {
    const marketNames = new Set(
      placeables
        .filter((item) => item.category !== "reward" && item.cost > 0)
        .map((item) => item.name)
    );

    for (const quest of Object.values(quests)) {
      for (const requirement of quest.requirements) {
        if (requirement.notificationID !== ITEM_BOUGHT) continue;
        expect(marketNames, `${quest.id} (${quest.title}): ${requirement.text}`)
          .toContain(requirement.notificationObject);
      }
    }
  });

  it("does not activate a buy quest before all of its required items unlock", () => {
    const marketByName = new Map(
      placeables
        .filter((item) => item.category !== "reward" && item.cost > 0)
        .map((item) => [item.name, item])
    );
    type QuestRow = (typeof quests)[keyof typeof quests];
    const rows = quests as Record<string, QuestRow>;
    const effectiveLevel = (quest: QuestRow): number => {
      const prerequisite = quest.prerequisiteQuest >= 0
        ? rows[String(quest.prerequisiteQuest)]
        : undefined;
      return Math.max(quest.levelRequired, prerequisite ? effectiveLevel(prerequisite) : -1);
    };

    for (const quest of Object.values(quests)) {
      if (quest.seasonal) continue;
      const unlockLevel = effectiveLevel(quest);
      for (const requirement of quest.requirements) {
        if (requirement.notificationID !== ITEM_BOUGHT) continue;
        const item = marketByName.get(requirement.notificationObject);
        expect(item, `${quest.id}: ${requirement.notificationObject}`).toBeDefined();
        expect(item!.level, `${quest.id}: ${requirement.notificationObject}`)
          .toBeLessThanOrEqual(unlockLevel);
      }
    }
  });
});
