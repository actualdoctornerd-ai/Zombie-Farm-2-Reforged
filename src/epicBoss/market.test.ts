import { describe, expect, it } from "vitest";
import questRows from "../../public/assets/quests.json";
import {
  DR_GROUNDHOG,
  EPIC_BOSSES,
  SKUNKARELLA,
  epicBossUnlockLevel,
} from "./catalog";
import { epicZombieRewardNotes, visibleEpicBosses } from "./market";
import type { QuestDef } from "../quest/types";

describe("Epic Boss market", () => {
  it("shows every boss until an event is active, then only shows that boss", () => {
    expect(visibleEpicBosses(EPIC_BOSSES, null)).toHaveLength(8);
    expect(visibleEpicBosses(EPIC_BOSSES, "foul-owl").map((boss) => boss.id)).toEqual(["foul-owl"]);
  });

  it("unlocks Groundhog at level 24 and every other Epic Boss at level 32", () => {
    expect(epicBossUnlockLevel(DR_GROUNDHOG)).toBe(24);
    expect(EPIC_BOSSES.filter((boss) => boss !== DR_GROUNDHOG)
      .every((boss) => epicBossUnlockLevel(boss) === 32)).toBe(true);
  });

  it("describes special zombie rewards at their quest milestones", () => {
    const quests = questRows as Record<string, QuestDef>;
    const notes = epicZombieRewardNotes(SKUNKARELLA, quests);
    expect(notes).toEqual([
      "Levels 5, 10, 15, 20: Diva Zombie",
      "Level 40: Madame Zombie",
    ]);
    expect(EPIC_BOSSES.flatMap((boss) => epicZombieRewardNotes(boss, quests))).toHaveLength(15);
  });
});
