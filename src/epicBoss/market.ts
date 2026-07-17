import { RewardType, type QuestDef } from "../quest/types";
import { QuestEvent } from "../quest/events";
import type { EpicBossDef } from "./types";

/** Keep the event picker focused on the one boss the player has already activated. */
export function visibleEpicBosses(
  bosses: readonly EpicBossDef[], activeBossId: string | null
): readonly EpicBossDef[] {
  return activeBossId ? bosses.filter((boss) => boss.id === activeBossId) : bosses;
}

/** Player-facing milestone notes for the special zombies in a boss's quest chain. */
export function epicZombieRewardNotes(
  boss: EpicBossDef, quests: Readonly<Record<string, QuestDef>>
): string[] {
  return boss.questIds.flatMap((id) => {
    const quest = quests[id];
    if (!quest || quest.rewardType !== RewardType.Zombie || !quest.rewardItem) return [];
    const levels = quest.requirements
      .filter((requirement) => requirement.notificationID === QuestEvent.EpicStageEnemyDefeated)
      .map((requirement) => Number(requirement.notificationObject))
      .filter((level) => Number.isFinite(level));
    if (!levels.length) return [quest.rewardItem];
    const label = levels.length === 1 ? `Level ${levels[0]}` : `Levels ${levels.join(", ")}`;
    return [`${label}: ${quest.rewardItem}`];
  });
}
