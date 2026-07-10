// TS mirror of public/assets/quests.json (produced by tools/prep_quests.py from
// the source Quests.plist). See docs: the quest engine is fully data-driven — each
// requirement listens to a game notification and counts up to `countTotal`.

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
}

/** How a completed quest pays out. */
export const enum RewardType {
  Gold = 0,
  Xp = 1,
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
  rewardItem: string;
  rewardItemKey: string;
  tutorialQuest: boolean;
  epicEvent: boolean;
  seasonal: boolean;
  seasonalDate: string;
  removeQuest: boolean;
  ignoreCheckQuest: boolean;
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
  /** Per-objective lines with current/target counts and done flag. */
  objectives: { text: string; count: number; total: number; done: boolean }[];
}
