// Shared view-model types for the HUD and its panel modules. These are the data
// shapes main.ts builds and hands to Hud.* methods (it owns the asset/icon lookups
// and game-state reads); the HUD only renders them. Kept separate from hud.ts so
// panels can import the types without pulling in the whole Hud class.
import { PlaceableDef } from "../assets";
import { CropConfig } from "../Field";
import type { EpicBossRun } from "../epicBoss/types";

export type Mode = "walk" | "till" | "plant" | "move" | "place" | "remove" | "instagrow" | "rotate";

// A card in the object buy menu (tree / decor / functional).
export interface ObjCard {
  name: string;
  cost: number;
  level: number;
  brainsNeeded?: boolean;
  category: "tree" | "decor" | "functional" | "reward";
  portrait: string;
  def: PlaceableDef;
}

// A card in the plant/zombie picker: display fields + what planting it enqueues.
export interface MenuCard {
  name: string;
  cost: number;
  brains?: boolean; // cost is paid in brains, not gold (special zombies)
  sell?: number; // plants only (harvest value)
  timeLabel: string; // "15m", "4h", "1d"
  level: number; // player level required to unlock
  seasonal?: boolean; // holiday crops are grouped after the permanent catalog
  portrait: string; // full image url
  category?: "normal" | "special" | "mutant"; // zombies only
  description?: string; // optional Market magnifier copy
  cfg: CropConfig;
}

export interface EpicBossMarketView {
  id: string;
  name: string;
  portrait: string;
  questIcon: string;
  costBrains: number;
  maxLevel: number;
  reconstructed: boolean;
  blocked: boolean;
  run: EpicBossRun | null;
  active: boolean;
  expired: boolean;
  completed: boolean;
  eventRemainingMs: number;
  encounterRemainingMs: number;
  rewards: string[];
  zombieRewards: string[];
}

// An owned zombie's inspectable info (shown by openZombieInfo).
export interface ZombieInfo {
  name: string; // the zombie's individual (random) name
  typeName: string; // its species/type name, e.g. "Crazy Zombie"
  key: string; // unit type key (drives named-unique abilities, e.g. Crazy)
  group: string;
  className: string;
  classColor: string;
  str: number;
  dex: number;
  con: number;
  focus: number;
  mutation: number; // mutation bitmask — stats it boosts render green
  portrait: string;
  color?: [number, number, number]; // individual tint used by the generated portrait
  invasions: number; // lifetime invasions (drives veterancy)
  // Present when the panel should offer roster actions (store/deploy/locate).
  id?: string;
  stored?: boolean;
}

// Object-tap action popup (Move / Store / Sell) for a placed farm object.
export interface ObjectActions {
  name: string;
  portrait: string;
  canStore: boolean; // false when the shed is full or item can't be stored
  canSell: boolean; // functional items are permanent and cannot be sold
  sellRefund: number;
  sellBrains: boolean;
  onMove: () => void;
  onRotate: () => void; // flip the object on the vertical axis (Rotate)
  onStore: () => void;
  onSell: () => void;
}

/** One thing a new level opened up, shown as a framed tile in the level-up popup. */
export interface LevelUpUnlock {
  icon: string;
  name: string;
  kind: string; // "Invasion" | "Item" | "Boost" | …
}
export interface LevelUpView {
  level: number; // the new level reached
  unlocks: LevelUpUnlock[];
}

/** One reward line in the quest-complete popup (icon + label, e.g. "+30 XP"). */
export interface QuestReward {
  icon: string;
  label: string;
}
/** A completed quest to celebrate, mirroring the level-up popup. Built by main
 *  (which owns the asset/icon lookups) and shown via openQuestComplete. */
export interface QuestCompleteView {
  icon: string; // the quest's own sprite
  title: string;
  message: string; // the quest's completion message
  rewards: QuestReward[];
}

/** One entry in the Received tab (raid loot / quest item rewards). Resolved by
 *  main from the raw received-key list. `index` is its position in that list, so
 *  claiming/placing can address duplicates safely. */
export interface ReceivedView {
  index: number;
  name: string;
  icon: string; // image URL ("" = no art)
  kind: "placeable" | "boost" | "brains" | "trophy";
  actionLabel: string; // "Place" | "Claim" | "" (trophy: display only)
}

/** Colored grave a zombie class needs before it can be planted (null = none). */
export function graveNeededFor(className: string): "Blue" | "Red" | "Silver" | null {
  if (className === "Blue") return "Blue";
  if (className === "Red") return "Red";
  if (className === "Silver") return "Silver";
  return null; // Green (T1), Special, Yellow need no grave
}
