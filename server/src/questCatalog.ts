import questData from "../../public/assets/quests.json";
import reforgedQuestData from "../../public/assets/quests_reforged.json";

// Server mirror of public/assets/quests.json reward payouts. GENERATED from that
// file (96 quests) — KEEP IN SYNC. Only the fields that decide VALUE are mirrored:
// the reward type + amount/item. The server grants a completed quest its reward from
// THIS table (never a client-sent amount), at most once per (account, quest).
//
// rewardType: 0=Xp, 1=Gold, 2=Brains, 3=Item, 5=Zombie. Epic type-5 rewards
// resolve through src/epicBoss/rewards.ts to dedicated reward-only catalog keys
// and are inserted into the authoritative roster exactly once.

export interface QuestReward {
  rewardType: number;
  rewardValue: number;
  rewardItemKey: string;
  /** Brains paid on top of the main reward (Reforged achievements). See
   *  src/quest/types.ts — the imported format cannot express "XP and a brain". */
  rewardBrains?: number;
}

export interface QuestRequirement {
  notificationID: string;
  notificationObject: string;
  countTotal: number;
  type: number;
}

export interface QuestDefinition extends QuestReward {
  id: string;
  levelRequired: number;
  prerequisiteQuest: number;
  requirements: QuestRequirement[];
  tutorialQuest: boolean;
  epicEvent: boolean;
  seasonal: boolean;
}

// The imported catalog plus the Reforged-original achievements. Kept as two files
// because quests.json is regenerated from the source Quests.plist by
// tools/prep_quests.py and would drop anything hand-added to it. Ids are disjoint.
const RAW_QUESTS = {
  ...(questData as Record<string, unknown>),
  ...(reforgedQuestData as Record<string, unknown>),
} as Record<string, Omit<QuestDefinition, "rewardItemKey"> & { rewardItemKey?: string; rewardBrains?: number }>;

/** Full server-owned quest rules. Content categories without a trusted event producer
 * remain dormant even though their definitions are present. */
export const QUEST_DEFINITIONS: Readonly<Record<string, QuestDefinition>> = Object.fromEntries(
  Object.entries(RAW_QUESTS).map(([id, q]) => [
    id,
    {
      id,
      levelRequired: q.levelRequired,
      prerequisiteQuest: q.prerequisiteQuest,
      requirements: q.requirements,
      rewardType: q.rewardType,
      rewardValue: q.rewardValue,
      rewardItemKey: q.rewardItemKey ?? "",
      rewardBrains: q.rewardBrains ?? 0,
      tutorialQuest: q.tutorialQuest,
      epicEvent: q.epicEvent,
      seasonal: q.seasonal,
    },
  ])
);

export function questDefinition(id: string): QuestDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(QUEST_DEFINITIONS, id) ? QUEST_DEFINITIONS[id] : undefined;
}

export const QUEST_REWARDS: Readonly<Record<string, QuestReward>> = {
  "0": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "1": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "2": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "3": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "4": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "5": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "6": { rewardType: 0, rewardValue: 75, rewardItemKey: "" },
  "7": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "8": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "9": { rewardType: 0, rewardValue: 40, rewardItemKey: "" },
  "10": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "11": { rewardType: 0, rewardValue: 75, rewardItemKey: "" },
  "12": { rewardType: 0, rewardValue: 25, rewardItemKey: "" },
  "13": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "14": { rewardType: 0, rewardValue: 400, rewardItemKey: "" },
  "15": { rewardType: 0, rewardValue: 800, rewardItemKey: "" },
  "16": { rewardType: 0, rewardValue: 2000, rewardItemKey: "" },
  "17": { rewardType: 0, rewardValue: 75, rewardItemKey: "" },
  "18": { rewardType: 0, rewardValue: 150, rewardItemKey: "" },
  "19": { rewardType: 0, rewardValue: 300, rewardItemKey: "" },
  "20": { rewardType: 0, rewardValue: 750, rewardItemKey: "" },
  "21": { rewardType: 0, rewardValue: 675, rewardItemKey: "" },
  "22": { rewardType: 0, rewardValue: 750, rewardItemKey: "" },
  "23": { rewardType: 0, rewardValue: 90, rewardItemKey: "" },
  "24": { rewardType: 0, rewardValue: 150, rewardItemKey: "" },
  "25": { rewardType: 0, rewardValue: 300, rewardItemKey: "" },
  "26": { rewardType: 0, rewardValue: 750, rewardItemKey: "" },
  "27": { rewardType: 0, rewardValue: 300, rewardItemKey: "" },
  "28": { rewardType: 0, rewardValue: 90, rewardItemKey: "" },
  "29": { rewardType: 0, rewardValue: 150, rewardItemKey: "" },
  "30": { rewardType: 0, rewardValue: 300, rewardItemKey: "" },
  "31": { rewardType: 0, rewardValue: 2100, rewardItemKey: "" },
  "32": { rewardType: 0, rewardValue: 900, rewardItemKey: "" },
  "33": { rewardType: 0, rewardValue: 300, rewardItemKey: "" },
  "34": { rewardType: 0, rewardValue: 1350, rewardItemKey: "" },
  "35": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "36": { rewardType: 3, rewardValue: 0, rewardItemKey: "Valentine Gift" },
  "37": { rewardType: 0, rewardValue: 3200, rewardItemKey: "" },
  "38": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "39": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "40": { rewardType: 3, rewardValue: 0, rewardItemKey: "White Bunny" },
  "41": { rewardType: 0, rewardValue: 4000, rewardItemKey: "" },
  "42": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "43": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "44": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "45": { rewardType: 3, rewardValue: 0, rewardItemKey: "Circus Popcorn" },
  "46": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "47": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "48": { rewardType: 3, rewardValue: 0, rewardItemKey: "Spooky Tree" },
  "49": { rewardType: 0, rewardValue: 800, rewardItemKey: "" },
  "50": { rewardType: 0, rewardValue: 800, rewardItemKey: "" },
  "51": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "52": { rewardType: 3, rewardValue: 0, rewardItemKey: "Poppy" },
  "53": { rewardType: 0, rewardValue: 200, rewardItemKey: "" },
  "54": { rewardType: 1, rewardValue: 20, rewardItemKey: "" },
  "55": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "56": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "57": { rewardType: 0, rewardValue: 3750, rewardItemKey: "" },
  "58": { rewardType: 0, rewardValue: 3750, rewardItemKey: "" },
  "59": { rewardType: 0, rewardValue: 3750, rewardItemKey: "" },
  "60": { rewardType: 0, rewardValue: 3750, rewardItemKey: "" },
  "61": { rewardType: 0, rewardValue: 3750, rewardItemKey: "" },
  "62": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "63": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "64": { rewardType: 0, rewardValue: 150, rewardItemKey: "" },
  "65": { rewardType: 0, rewardValue: 75, rewardItemKey: "" },
  "67": { rewardType: 0, rewardValue: 25, rewardItemKey: "" },
  "68": { rewardType: 0, rewardValue: 25, rewardItemKey: "" },
  "69": { rewardType: 0, rewardValue: 25, rewardItemKey: "" },
  "70": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "71": { rewardType: 0, rewardValue: 20, rewardItemKey: "" },
  "1000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorDrZombie" },
  "1001": { rewardType: 3, rewardValue: 0, rewardItemKey: "Invasion Voucher" },
  "1002": { rewardType: 2, rewardValue: 1, rewardItemKey: "" },
  "1003": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "1010": { rewardType: 2, rewardValue: 5, rewardItemKey: "" },
  "1011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorOmegaDrZombie" },
  "2000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorBandido" },
  "2001": { rewardType: 3, rewardValue: 0, rewardItemKey: "Invasion Voucher" },
  "2002": { rewardType: 2, rewardValue: 1, rewardItemKey: "" },
  "2003": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "2004": { rewardType: 2, rewardValue: 2, rewardItemKey: "" },
  "2005": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "2006": { rewardType: 2, rewardValue: 5, rewardItemKey: "" },
  "2010": { rewardType: 2, rewardValue: 5, rewardItemKey: "" },
  "2011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorVagabond" },
  "3000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorCaptain" },
  "3010": { rewardType: 3, rewardValue: 0, rewardItemKey: "Invasion Voucher" },
  "3011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorAdmiral" },
  "4000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorChristmasGhost" },
  "4001": { rewardType: 3, rewardValue: 0, rewardItemKey: "Invasion Voucher" },
  "4002": { rewardType: 2, rewardValue: 1, rewardItemKey: "" },
  "4003": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "4004": { rewardType: 2, rewardValue: 2, rewardItemKey: "" },
  "4005": { rewardType: 3, rewardValue: 0, rewardItemKey: "Golden Dice" },
  "4006": { rewardType: 2, rewardValue: 5, rewardItemKey: "" },
  "4010": { rewardType: 2, rewardValue: 5, rewardItemKey: "" },
  "4011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorScrooge" },
  "5000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorDiva" },
  "5011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorMadame" },
  "8000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorBrockColey" },
  "8011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorBrockColey" },
  "9000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorProto" },
  "9011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorZombug" },
  "10000": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorZomdini" },
  "10011": { rewardType: 5, rewardValue: 0, rewardItemKey: "ZombieActorZomtar" },
};

/** The reward for a quest id, or undefined if the id is not a real catalog quest. */
export function questReward(id: string): QuestReward | undefined {
  return Object.prototype.hasOwnProperty.call(QUEST_REWARDS, id) ? QUEST_REWARDS[id] : undefined;
}

/** Reward-type constants (mirror src/quest/types.ts RewardType). */
export const QUEST_REWARD = { Xp: 0, Gold: 1, Brains: 2, Item: 3, Zombie: 5 } as const;
