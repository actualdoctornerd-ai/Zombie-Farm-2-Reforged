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
  /** Zombie catalog data used to inspect a Black Market listing through the
   * current player's own ability unlocks. */
  zombie?: {
    group: string; className: string; classColor: string;
    str: number; dex: number; con: number; focus: number; mutation: number;
  };
}

export interface EpicBossMarketView {
  id: string;
  name: string;
  portrait: string;
  questIcon: string;
  costBrains: number;
  unlockLevel: number;
  levelLocked: boolean;
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
  /** Display name of this boss's favourite crop, or null for an event with no pairing. */
  favoriteCrop: string | null;
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

// One species entry in the Zombie Almanac (the Zombies menu's collection tab).
export interface AlmanacEntryView {
  key: string;
  name: string;
  portrait: string;
  group: string;
  className: string;
  classColor: string;
  category: "normal" | "special" | "mutant";
  // BASE stats straight from the catalog — no farmer/veterancy/mutation modifiers.
  str: number;
  dex: number;
  con: number;
  focus: number;
  /** Lifetime obtained count. 0 = undiscovered (rendered as a silhouette). */
  obtained: number;
  /** How to acquire this species — the only detail an undiscovered entry reveals. */
  hint: string;
  /** True on Epic Boss exclusives. `category` alone cannot tell them apart (they are
   *  all "special"), so this is what files them under the Almanac's Epic group. */
  epic?: boolean;
}

// Object-tap action popup (Move / Store / Sell) for a placed farm object.
export interface ObjectActions {
  name: string;
  portrait: string;
  /** Packed RGB the farm multiplies this object's sprite by (monoliths share one
   *  greyscale PNG). Omitted/white leaves the portrait as authored. */
  tint?: number;
  canStore: boolean; // false when the shed is full or item can't be stored
  /** Why Store is unavailable, when the reason is not "the shed is full" — a busy
   *  Zombie Pot, for one, refuses because packing it away would throw the combine
   *  running inside it. Labels the disabled button so it explains itself. */
  storeBlockedLabel?: string;
  canSell: boolean; // functional items are permanent and cannot be sold
  sellRefund: number;
  sellBrains: boolean;
  onMove: () => void;
  onRotate: () => void; // flip the object on the vertical axis (Rotate)
  onStore: () => void;
  onSell: () => void;
  /** A building whose tap USED to go straight to its own panel (the Pet Pen's pet
   *  collection) keeps that panel one tap away here — otherwise routing the tap to
   *  this sheet would be the only way to store it and the only way to lose the panel. */
  manageLabel?: string;
  onManage?: () => void;
}

/** One thing a new level opened up, shown as a framed tile in the level-up popup. */
export interface LevelUpUnlock {
  icon: string;
  tint?: number; // packed placeable tint, so the card matches the farm
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
  tint?: number; // packed placeable tint, so the card matches the farm
  kind: "placeable" | "boost" | "brains" | "zombie" | "trophy";
  actionLabel: string; // "Place" | "Claim" | "" (trophy: display only)
  sellable?: boolean;
  /** Can this reward go straight into the shed, skipping the farm? False when the
   *  shed is full or the item is a building that can't be shelved — the same rule a
   *  placed object's Store action follows, asked before the object exists. */
  storable?: boolean;
}

/** Colored grave a zombie class needs before it can be planted (null = none). */
export function graveNeededFor(className: string): "Blue" | "Red" | "Silver" | null {
  if (className === "Blue") return "Blue";
  if (className === "Red") return "Red";
  if (className === "Silver") return "Silver";
  return null; // Green (T1), Special, Yellow need no grave
}

/** One appearance the placed storage shed can wear, as the picker draws it. */
export interface ShedAppearanceOption {
  key: string;         // catalog key of the shed whose ART this is
  name: string;        // that shed's Market name ("Wood Hut")
  portrait: string;    // image URL
  tint?: number;       // packed placeable tint, so the card matches the farm
  slots: number;       // that tier's capacity, shown only to order the list in words
}

/** The shed appearance picker's whole view model. Null (rather than an empty list)
 *  whenever no shed is placed, which is what hides the button. */
export interface ShedAppearanceView {
  /** Unlocked looks, earliest tier first. Always contains `current`. */
  options: ShedAppearanceOption[];
  /** Catalog key of the look the shed is wearing now. */
  current: string;
  /** The shed's real tier name, for the line that explains the split between what
   *  it looks like and what it holds. */
  realName: string;
  slots: number;
}
