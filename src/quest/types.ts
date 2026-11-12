// TS mirror of public/assets/quests.json (produced by tools/prep_quests.py from
// the source Quests.plist). See docs: the quest engine is fully data-driven — each
// requirement listens to a game notification and counts up to `countTotal`.
import type { ObjectiveLine, QuestGauge, QuestSweep } from "./questProgress";

/** A single objective within a quest. */
export interface QuestRequirement {
  /** The game event this objective listens to (e.g. "kCropHarvestedNotification"). */
  notificationID: string;
  /** The specific subject to match (e.g. "Tomatoes"); "" = match any subject. */
  notificationObject: string;
  /** How many events complete this objective. */
  countTotal: number;
  /** Display text (e.g. "Harvest 10 Tomatoes"). */
  text: string;
  /** 1 = win/collect a specific item, 2 = cumulative count, 3 = defeat-boss-at-level. */
  type: number;
  /** Objective icon (atlas frame or loose PNG; optional in the rail). */
  sprite: string;
  /** A live reading rather than an event tally (see quest/questProgress.ts). */
  gauge?: QuestGauge;
  /** A member of the quest's `sweep` (see quest/questProgress.ts). */
  sweep?: boolean;
}

/** How a completed quest pays out.
 *
 * GROUND TRUTH (disassembled `-[GameState grantReward:withToolTip:withDelay:]` →
 * `addResource:amount:`, confirmed by `getRewardDescription:` display strings): the
 * rewardType selects a resource-array index — 0→XP (index 2), 1→Gold (index 0),
 * 2→Brains (index 1). XP is the DEFAULT quest reward (62 of ~96 quests are type 0).
 * An earlier build had 0/1 swapped (Gold=0, Xp=1); that was wrong. */
export const enum RewardType {
  Xp = 0,
  Gold = 1,
  Brains = 2,
  Item = 3, // grants rewardItemKey into storage (received)
  Zombie = 5, // spawns rewardItemKey as an owned zombie
}

/** A quest definition (immutable content). */
export interface QuestDef {
  id: string;
  title: string;
  messageComplete: string;
  tip: string;
  sprite: string;
  /** Player level needed to activate (-1 = none). */
  levelRequired: number;
  /** Quest id that must be completed first (-1 = none). */
  prerequisiteQuest: number;
  requirements: QuestRequirement[];
  rewardType: number;
  rewardValue: number;
  /** Brains paid ON TOP of the main reward. The original format has a single
   *  rewardType, so an imported quest can pay XP or brains but never both — which is
   *  exactly what the Reforged achievements want for their hardest rungs. Absent (the
   *  case for all 105 imported quests) means no bonus. */
  rewardBrains?: number;
  /** Judges the requirements flagged `sweep` together: each >= `each`, one >= `best`. */
  sweep?: QuestSweep & { eachText?: string; bestText?: string };
  /** Something completing the quest opens up, shown as an extra reward line. The quest
   *  grants nothing for it — the gated feature checks the completion itself. */
  rewardUnlock?: string;
  /** Items granted ON TOP of the main reward, by display name (resolved like a quest Item
   *  reward: a boost name lands in the boost inventory). `icon` is under assets/ui. */
  rewardItems?: { name: string; icon: string }[];
  rewardItem: string;
  rewardItemKey: string;
  tutorialQuest: boolean;
  epicEvent: boolean;
  seasonal: boolean;
  seasonalDate: string;
  removeQuest: boolean;
  ignoreCheckQuest: boolean;
}

/** Presentation-ready reward metadata shared by active and completed quest views. */
export interface QuestRewardInfo {
  /** Filename under assets/ui. */
  icon: string;
  label: string;
}

/** The brain bonus some Reforged achievements pay alongside their XP, or null. */
export function questBonusRewardInfo(def: Pick<QuestDef, "rewardBrains">): QuestRewardInfo | null {
  const brains = def.rewardBrains ?? 0;
  if (!brains) return null;
  return {
    icon: "topbar_brain_icon.png",
    label: `+${brains} ${brains === 1 ? "Brain" : "Brains"}`,
  };
}

/** The extra items a quest pays beside its main reward, as display lines. */
export function questItemRewardsInfo(def: Pick<QuestDef, "rewardItems">): QuestRewardInfo[] {
  return (def.rewardItems ?? []).map((item) => ({ icon: item.icon, label: item.name }));
}

/** The "unlocks X" line a quest shows beside its reward, or null. */
export function questUnlockInfo(def: Pick<QuestDef, "rewardUnlock">): QuestRewardInfo | null {
  return def.rewardUnlock ? { icon: "market/upgrade_farmsize.png", label: def.rewardUnlock } : null;
}

/** Convert a quest's encoded reward fields into the text and icon players see. */
export function questRewardInfo(def: Pick<
  QuestDef, "rewardType" | "rewardValue" | "rewardItem" | "sprite"
>): QuestRewardInfo | null {
  switch (def.rewardType) {
    case RewardType.Gold:
      return def.rewardValue
        ? { icon: "topbar_money_icon.png", label: `+${def.rewardValue} Gold` }
        : null;
    case RewardType.Xp:
      return def.rewardValue
        ? { icon: "topbar_level_icon.png", label: `+${def.rewardValue} XP` }
        : null;
    case RewardType.Brains:
      return def.rewardValue
        ? {
            icon: "topbar_brain_icon.png",
            label: `+${def.rewardValue} ${def.rewardValue === 1 ? "Brain" : "Brains"}`,
          }
        : null;
    case RewardType.Item:
    case RewardType.Zombie:
      return def.rewardItem ? { icon: def.sprite, label: def.rewardItem } : null;
    default:
      return null;
  }
}

/** Runtime progress for one active quest: a count per requirement. */
export interface QuestProgress {
  id: string;
  counts: number[];
}

/** A view of an active quest for the HUD rail. */
export interface QuestView {
  id: string;
  title: string;
  icon: string; // sprite filename
  tip: string;
  /** Reward shown before completion so players can judge whether to pursue it. */
  reward: QuestRewardInfo | null;
  /** Brain bonus paid alongside `reward` (Reforged achievements only). */
  bonus?: QuestRewardInfo | null;
  /** What completing it opens up (e.g. the 90x90 farm), if anything. */
  unlock?: QuestRewardInfo | null;
  /** Extra items it pays (e.g. the Green Flower Ticket). */
  items?: QuestRewardInfo[];
  /** Per-objective lines with current/target counts and done flag. `detail` is a
   *  breakdown the player taps to see (a sweep's per-crop list). */
  objectives: ObjectiveLine[];
}
