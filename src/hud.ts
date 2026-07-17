// DOM overlay HUD laid out like the iPad game: settings gear + currency bar +
// player name across the top, an ACTIVE-QUESTS column on the left (toggled by the
// bottom-left button), menu buttons on the right, and a farming-tool bar at the
// bottom-center. Resize-safe (fixed positioning).
import { GameState } from "./GameState";
import { CropConfig } from "./Field";
import { zombieSellValue } from "./economy";
import { PlaceableDef, BoostDef, FarmSizeUpgrade, ClimateUpgrade, upgradeIcon } from "./assets";
import type { FarmerBodyDef, FarmerCatalog, FarmerHeadDef, PetCatalog, PetDef } from "./assets";
import type { EpicBossRun } from "./epicBoss/types";
import { EPIC_BOSS_FIGHT_BRAIN_COST, type EpicBossPayment } from "./epicBoss/tokens";
import { AudioManager } from "./audio";
import { RosterEntry } from "./zombie/types";
import { mutationLabel, mutationBonus } from "./zombie/mutations";
import { QuestView } from "./quest/types";
import type { RaidCardView, RaidPartyView, RaidResultView, RaidLaunchOpts, LootDrop } from "./raid/RaidManager";
import type { ProfileIndex } from "./save/profiles";
import { APP_VERSION } from "./version";
import { canGiftBrain, type Friend } from "./social/friends";
import { isMobile } from "./platform";
import { getSpriteSet, setSpriteSet, getEdition, setEdition,
  FarmBackground, FARM_BACKGROUNDS } from "./prefs";
import { fmtCooldown, VOUCHER_KEY } from "./raid/RaidCatalog";
import { STATS, veterancy, veterancyMultiplier, STAT_TILE, VALUE_FILL, VALUE_END, ABILITY_FRAME,
  ABILITY_POOL, ABILITY_TIER, unitAbilityAt, TIER_BOSS, MAX_ABILITY_TIER } from "./zombie/traits";
import { classTierRank } from "./zombie/taxonomy";
import { BASE } from "./base";
import { compareCropMarketOrder } from "./marketOrder";
import { fillPartySelection } from "./raid/partySelection";

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

// A unified Market grid entry (crop, zombie, or object), with what to do on pick.
interface MktEntry {
  name: string;
  portrait: string;
  cost: number;
  level: number;
  brains?: boolean; // priced in brains rather than gold
  sell?: number; // harvest value (plants only)
  graveNeeded?: "Blue" | "Red" | "Silver"; // locked until this colored grave is owned
  ownedLimit?: boolean; // "1 per farm" limit reached (gift vouchers) — can't buy
  owned?: boolean;
  equipped?: boolean;
  description?: string; // "what does it do" blurb shown by the card's magnifier
  onPick: () => void;
}

/** Player-facing "what does it do" blurb for a functional Market item, shown when the
 *  card's magnifier is tapped. Keyed off the effect flags assets.ts derives from the
 *  item key, so it always matches the item's real behaviour. */
function functionalDescription(def: PlaceableDef): string | undefined {
  if (def.petPen)
    return "A home for up to four cosmetic pets. Tap the Pet Pen on your farm to choose its occupants.";
  if (def.category !== "functional") return undefined;
  if (def.armyMax)
    return `Raises your zombie army limit by ${def.armyMax}, so you can send more zombies on each invasion.`;
  if (def.plowFree) return "Plowing soil costs no gold while this stands on your farm.";
  if (def.fastWork)
    return "Farming is instant — plow, plant, water and harvest finish with no waiting.";
  if (def.mutantMonolith) return "Halves the grow time of mutant zombies.";
  if (def.combineFast)
    return "Speeds up the Zombie Pot: combining finishes in 15 minutes instead of an hour.";
  if (def.zombiePot)
    return "Combine two of your zombies into a brand-new one. Only one is needed; the first costs gold, later Pots cost brains.";
  if (def.zombieStorage)
    return "Stores your spare zombies off the field with no limit, freeing up graves to plant more.";
  if (def.zombiePatch) return "A cosy spot where your idle zombies gather to relax and nap.";
  if (def.graveColor)
    return `Unlocks planting ${def.graveColor}-class zombies — you must own this grave before you can grow them.`;
  if (def.storageSlots)
    return `A shed for objects you've packed away — holds up to ${def.storageSlots} items. Buy a bigger shed to store more.`;
  if (def.key === "cameraNormal") return "A decorative camera to show off your farm.";
  return undefined;
}

/** Colored grave a zombie class needs before it can be planted (null = none). */
export function graveNeededFor(className: string): "Blue" | "Red" | "Silver" | null {
  if (className === "Blue") return "Blue";
  if (className === "Red") return "Red";
  if (className === "Silver") return "Silver";
  return null; // Green (T1), Special, Yellow need no grave
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
  brains: number; // brains granted by the level-up(s)
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

const UI = (n: string) => `${BASE}assets/ui/${n}`;


const STYLE = `
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: system-ui, sans-serif; user-select: none; }

/* top: brown wood bar with recessed slots + gear + name plate */
#hud .topbar { position: fixed; top: 6px; left: 6px; right: 6px; display: flex;
  align-items: center; gap: 8px; pointer-events: none;
  background: linear-gradient(#6e4425, #492b16); border: 2px solid #2f1d0d;
  border-radius: 16px; padding: 5px 8px; box-shadow: 0 3px 6px rgba(0,0,0,.4); }
#hud .gear { pointer-events: auto; width: 44px; height: 44px; border: none;
  background: none; cursor: pointer; flex: 0 0 auto;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
#hud .gear img { width: 100%; height: 100%; object-fit: contain; }
#hud .chips { display: flex; gap: 6px; align-items: center; }
#hud .chip { display: flex; align-items: center; gap: 3px;
  border-style: solid; border-width: 9px 13px;
  border-image: url(${BASE}assets/ui/button_bg.png) 14 fill / 9px 13px stretch;
  color: #fff; font-weight: 700; font-size: 14px; text-shadow: 0 1px 1px #000;
  min-height: 22px; margin: 0 -2px; }
#hud .chip img { height: 20px; width: auto; }
#hud .chip .xpbar { width: 60px; height: 8px; background: rgba(0,0,0,.55);
  border: 1px solid #2f1d0d; border-radius: 5px; overflow: hidden; margin-left: 2px; }
#hud .chip .xpfill { height: 100%; width: 0%; background: linear-gradient(#b6f36a,#5fbf2f); }
#hud .spacer { flex: 1 1 auto; }
#hud .nameplate { border-style: solid; border-width: 9px 16px;
  border-image: url(${BASE}assets/ui/button_bg.png) 14 fill / 9px 16px stretch;
  color: #fff; font-weight: 700; font-size: 14px; text-shadow: 0 1px 1px #000;
  pointer-events: auto; cursor: pointer; user-select: none; }
#hud .nameplate:hover { filter: brightness(1.12); }
/* profile button: a person icon just right of the nameplate; opens the Profile menu.
   Stays visible on mobile (where the nameplate is hidden) so the menu is reachable. */
#hud .profbtn { pointer-events: auto; flex: 0 0 auto; width: 36px; height: 36px; padding: 3px;
  border: none; background: none; cursor: pointer;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
#hud .profbtn img { width: 100%; height: 100%; object-fit: contain; }
#hud .profbtn:hover { filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)) brightness(1.1); }
/* invisible developer hotspot: a transparent hit-target just left of the nameplate */
#hud .devhot { width: 34px; height: 34px; padding: 0; margin: 0; border: none;
  background: transparent; cursor: default; pointer-events: auto; -webkit-appearance: none;
  appearance: none; flex: 0 0 auto; }

/* left: active quests (dark recessed slots) */
#hud .questcol { position: fixed; left: 8px; top: 66px; display: flex;
  flex-direction: column; gap: 6px; pointer-events: auto; }
#hud .quest { width: 48px; height: 48px; cursor: pointer; padding: 0;
  border-style: solid; border-width: 10px;
  border-image: url(${BASE}assets/ui/button_bg.png) 13 fill / 10px stretch;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.4)); }
#hud .quest img { width: 100%; height: 100%; object-fit: contain; }
#hud .quest .qbadge { position: absolute; bottom: -4px; right: -4px;
  min-width: 15px; height: 15px; padding: 0 3px; box-sizing: border-box;
  background: #70a91e; color: #fff; font-size: 10px; font-weight: 700;
  line-height: 15px; text-align: center; border-radius: 8px;
  border: 1px solid #3c5a10; text-shadow: 0 1px 1px rgba(0,0,0,.5); }
/* rail expand button (opens the full quest log) */
#hud .quest.qmore { display: flex; align-items: center; justify-content: center; }
#hud .quest.qmore .qmore-glyph { font-size: 22px; line-height: 1; color: #f4e9cf;
  text-shadow: 0 1px 2px rgba(0,0,0,.6); }
#hud .quest.qmore .qbadge { background: #d8bc40; color: #3a2c07; border-color: #7a5f10; }
/* quest detail popup */
#hud .panel.qdetail { text-align: left; }
#hud .qobj { font-size: 14px; color: #f4e9cf; margin: 4px 0; }
#hud .qobj.done { color: #8fdc5a; }
#hud .qtip { margin-top: 10px; font-size: 12px; font-style: italic; color: #cbb98f; }
/* full quest log */
#hud .panel.questlog { text-align: left; width: min(460px, 92vw); }
#hud .qlog-list { margin-top: 8px; max-height: 64vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
#hud .qlog-item { display: flex; gap: 10px; padding: 8px 10px; border-radius: 10px;
  background: rgba(0,0,0,.22); }
#hud .qlog-item img { width: 40px; height: 40px; object-fit: contain; flex: 0 0 auto; }
#hud .qlog-body { flex: 1 1 auto; min-width: 0; }
#hud .qlog-title { display: flex; justify-content: space-between; gap: 8px;
  font-weight: 700; color: #f4e9cf; font-size: 14px; }
#hud .qlog-title .qlog-prog { color: #8fdc5a; font-size: 12px; flex: 0 0 auto; }
#hud .qlog-obj { font-size: 12px; color: #d8ccaa; margin-top: 2px; }
#hud .qlog-obj.done { color: #8fdc5a; }
#hud .qlog-empty { color: #cbb98f; font-style: italic; padding: 8px; }
/* profile manager */
#hud .panel.profiles { width: min(440px, 92vw); text-align: left; }
#hud .prof-list { margin-top: 8px; display: flex; flex-direction: column; gap: 8px;
  max-height: 62vh; overflow-y: auto; padding-right: 2px; }
#hud .prof-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px;
  border-radius: 10px; background: rgba(0,0,0,.22); }
#hud .prof-row.active { background: rgba(112,169,30,.22); box-shadow: inset 0 0 0 1px rgba(142,199,79,.5); }
#hud .prof-row.prof-new { background: rgba(255,255,255,.06); }
#hud .prof-name { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 15px; color: #f4e9cf;
  display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .prof-badge { font-size: 10px; font-weight: 800; color: #16110a; background: #8ec74f;
  padding: 1px 7px; border-radius: 8px; text-shadow: none; }
#hud .prof-actions { display: flex; gap: 6px; flex: 0 0 auto; }
#hud .prof-btn { border: 2px solid #1e1207; border-radius: 8px; padding: 5px 11px; cursor: pointer;
  font: 700 12px system-ui, sans-serif; color: #fff; text-shadow: 0 1px 1px #000;
  background: linear-gradient(#7a5220, #5e3d15); }
#hud .prof-btn:hover { filter: brightness(1.12); }
#hud .prof-btn.play { background: linear-gradient(#79c247, #55972a); }
#hud .prof-btn.del { background: linear-gradient(#c0553f, #9c3320); }
#hud .prof-btn:disabled { opacity: .4; cursor: not-allowed; filter: none; }
#hud .prof-input { flex: 1 1 auto; min-width: 0; padding: 6px 9px; border-radius: 7px; border: 2px solid #1e1207;
  background: #2a1c0c; color: #ffe9a8; font: 700 14px system-ui, sans-serif; }
/* friends panel */
#hud .fr-note { margin-top: 6px; font-size: 12px; line-height: 1.4; color: #c9b98f; }
#hud .fr-empty { padding: 10px 4px; font-size: 13px; color: #b6a986; font-style: italic; }
#hud .prof-badge.fr-gifts { background: #7a4bc9; color: #f0e8ff; }
#hud .prof-btn.fr-gift { background: linear-gradient(#4fd0b8, #2f9c8a); }
#hud .fr-acct { margin-top: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 11px; border-radius: 10px; background: rgba(47,156,138,.16);
  box-shadow: inset 0 0 0 1px rgba(79,208,184,.35); min-height: 20px; }
#hud .fr-who { flex: 1 1 auto; font-size: 13px; color: #e9ffd8; display: flex; align-items: center; gap: 8px; }
#hud .fr-code { font: 800 12px ui-monospace, monospace; letter-spacing: .5px; color: #16110a;
  background: #4fd0b8; padding: 2px 8px; border-radius: 8px; text-shadow: none; }
/* click-to-copy code (re-enables selection, which #hud disables globally) */
#hud .copyable { cursor: pointer; user-select: all; -webkit-user-select: all;
  transition: filter .1s, box-shadow .1s; }
#hud .copyable:hover { filter: brightness(1.08); box-shadow: 0 0 0 2px rgba(255,255,255,.35); }
#hud .copyable:active { filter: brightness(.92); }
#hud .fr-gsi { flex: 0 0 auto; }
#hud .fr-inbox-h { margin-top: 12px; margin-bottom: 4px; font-weight: 800; font-size: 13px; color: #ffd98a; }
#hud .fr-inbox-row { background: rgba(255,193,60,.12); box-shadow: inset 0 0 0 1px rgba(255,193,60,.3); }
/* quest-complete toast */
#hud .qtoast { position: fixed; top: 72px; left: 50%; transform: translate(-50%, -12px);
  pointer-events: none; background: linear-gradient(#3c5a10, #2a3f0b);
  color: #eaffd8; font-weight: 700; font-size: 15px; padding: 8px 18px;
  border-radius: 12px; border: 2px solid #8fdc5a; box-shadow: 0 3px 10px rgba(0,0,0,.5);
  opacity: 0; transition: opacity .35s, transform .35s; z-index: 50; }
#hud .qtoast.show { opacity: 1; transform: translate(-50%, 0); }

/* right: identical grey glossy pills, each with a colored tab + label (no icons) */
#hud .menucol { position: fixed; right: 8px; top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 8px; pointer-events: auto; align-items: flex-end; }
/* each button: a COLORED frame wrapping a grey glossy button with a dark label */
#hud .mbtn { position: relative; width: 140px; box-sizing: border-box; cursor: pointer;
  padding: 5px; border-radius: 15px; border: 2px solid #333;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.4)); }
#hud .mbtn .gbtn { display: block; text-align: center; color: #383838; font-weight: 700;
  font-size: 15px; padding: 5px 0; text-shadow: 0 1px 0 rgba(255,255,255,.45);
  border-style: solid; border-width: 6px 13px 8px 13px;
  border-image: url(${BASE}assets/ui/nav_grey.png) 5 13 7 13 fill / 6px 13px 8px 13px stretch; }
#hud .mbtn .ready { position: absolute; top: -15px; left: 10px; z-index: -1;
  padding: 2px 14px 6px; background: linear-gradient(#a3213a,#6c1122);
  border: 2px solid #490c17; border-radius: 10px 10px 0 0; color: #fff;
  font-weight: 700; font-size: 12px; text-shadow: 0 1px 1px #000; }

/* bottom-center: farming tools */
#hud .tools { position: fixed; left: 50%; transform: translateX(-50%); bottom: 10px;
  display: flex; gap: 10px; pointer-events: auto;
  background: rgba(30,45,20,.55); padding: 6px 10px; border-radius: 16px; }
/* During a live raid the battle scene owns the screen: hide the farm chrome but
   keep raid panels (.panelbg) visible. */
#hud.raiding .topbar, #hud.raiding .tools, #hud.raiding .menucol,
#hud.raiding .questcol, #hud.raiding .qtoggle, #hud.raiding .fab { display: none !important; }
/* Visiting a friend's farm: a strictly read-only view. Hide every farm-editing
   surface (tools, menu, quests, fab, top bar) so nothing can be mutated; only the
   camera, zombie inspect, and the visit banner remain. */
#hud.visiting .topbar, #hud.visiting .tools, #hud.visiting .menucol,
#hud.visiting .questcol, #hud.visiting .qtoggle, #hud.visiting .fab { display: none !important; }
#hud .visit-banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; display: flex; align-items: center; gap: 12px;
  background: rgba(30,45,20,.82); color: #fff; padding: 8px 12px 8px 16px;
  border-radius: 14px; box-shadow: 0 3px 8px rgba(0,0,0,.5);
  font-weight: 700; font-size: 15px; text-shadow: 0 1px 2px #000; max-width: 92vw; }
#hud .visit-banner .vb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .visit-banner .vb-eye { opacity: .85; font-weight: 400; font-size: 13px; }
#hud .visit-banner .vb-exit { border: none; cursor: pointer; color: #fff; font-weight: 700;
  font-size: 14px; padding: 6px 14px; border-radius: 10px;
  background: linear-gradient(#c0432f,#8f2a1c); box-shadow: 0 2px 0 #5c1a12; }
#hud .visit-banner .vb-exit:active { transform: translateY(1px); box-shadow: 0 1px 0 #5c1a12; }
#hud .tool { width: 48px; height: 48px; border: none; background: transparent;
  cursor: pointer; padding: 0; position: relative;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.4)); }
#hud .tool img { width: 100%; height: 100%; object-fit: contain; }
#hud .tool.sel { outline: 3px solid #ffe066; outline-offset: -2px; border-radius: 12px;
  background: rgba(255,224,102,.2); }
#hud .tool .lbl { position: absolute; bottom: -12px; left: 0; right: 0; text-align: center;
  font-size: 10px; color: #fff; font-weight: 700; text-shadow: 0 1px 2px #000; }

/* bottom-left: quests toggle */
#hud .qtoggle { position: fixed; left: 10px; bottom: 10px; pointer-events: auto;
  border: none; background: none; cursor: pointer;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
#hud .qtoggle img { height: 56px; }

/* bottom-right: collapsed HUD -> single button showing the active tool */
#hud .fab { position: fixed; right: 14px; bottom: 12px; width: 62px; height: 62px;
  pointer-events: auto; cursor: pointer; padding: 9px; border: none; display: none;
  border-radius: 50%; background: rgba(30,45,20,.6); box-shadow: 0 3px 7px rgba(0,0,0,.5); }
#hud .fab img { width: 100%; height: 100%; object-fit: contain;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
/* remaining-uses badge on the collapsed fab while the Insta-Grow tool is equipped */
#hud .fab .fab-ct { position: absolute; top: -2px; right: -2px; min-width: 22px; height: 22px;
  padding: 0 5px; box-sizing: border-box; border-radius: 11px; display: none; align-items: center;
  justify-content: center; font: 800 12px system-ui, sans-serif; color: #16110a; background: #8ec74f;
  border: 2px solid #16110a; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
/* label next to the active tool showing what's currently being planted */
#hud .plant-label { position: fixed; right: 84px; bottom: 24px; pointer-events: none;
  display: none; align-items: center; gap: 6px; padding: 6px 13px; border-radius: 14px;
  background: rgba(30,45,20,.85); color: #fff; font: 700 14px system-ui, sans-serif;
  text-shadow: 0 1px 2px #000; white-space: nowrap; box-shadow: 0 2px 5px rgba(0,0,0,.4); }

/* modal panel with an X close in the top-right (used by all closeable menus) */
#hud .panelbg { position: fixed; inset: 0; pointer-events: auto; z-index: 20;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
#hud .army-bg { z-index: 25; }
#hud .game-confirm-bg { z-index: 26; }
#hud .writer-lock-bg { z-index: 60; }
#hud .writer-lock-panel { max-width: 420px; text-align: center; }
#hud .writer-lock-panel .zbtns { margin-top: 18px; justify-content: center; }
#hud .writer-lock-banner { position: fixed; z-index: 60; top: 8px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; border: 2px solid #2f1d0d; border-radius: 12px; padding: 8px 14px;
  color: #fff; background: linear-gradient(#9c4c31,#71301f); font: 800 13px system-ui,sans-serif;
  box-shadow: 0 3px 10px rgba(0,0,0,.5); cursor: pointer; }
#hud .panel { position: relative; min-width: 260px; max-width: 80vw; padding: 20px 24px;
  background: linear-gradient(#6e4425, #492b16); border: 3px solid #2f1d0d;
  border-radius: 18px; box-shadow: 0 6px 22px rgba(0,0,0,.6); color: #fff;
  text-shadow: 0 1px 2px #000; }
#hud .panel h2 { margin: 0 0 8px; font-size: 20px; }
#hud .panel p { margin: 0; font-size: 14px; opacity: .92; }
#hud .panelclose { position: absolute; top: -16px; right: -16px; width: 42px; height: 42px;
  border: none; background: none; cursor: pointer; padding: 0;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
#hud .panelclose img { width: 100%; height: 100%; }
/* settings rows: label + on/off toggle */
#hud .set-acct { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin: 6px 0 4px; padding: 10px 12px; border-radius: 10px; background: rgba(47,156,138,.16);
  box-shadow: inset 0 0 0 1px rgba(79,208,184,.35); }
#hud .set-acct-who { font-size: 14px; color: #eaffd8; }
#hud .set-acct-code { margin-top: 4px; font: 700 11px ui-monospace, monospace; color: #9ad3c4;
  display: flex; align-items: center; gap: 6px; }
#hud .set-acct-code-val { font: 800 12px ui-monospace, monospace; color: #16110a;
  background: #4fd0b8; padding: 1px 8px; border-radius: 7px; }
#hud .set-signout { flex: 0 0 auto; border: 2px solid #14240a; border-radius: 8px; padding: 7px 14px;
  cursor: pointer; color: #fff; font: 800 13px system-ui, sans-serif; text-shadow: 0 1px 1px #000;
  background: linear-gradient(#c0553f, #9c3320); }
#hud .set-signout:hover { filter: brightness(1.1); }
#hud .set-devices { margin: 10px 0 2px; }
#hud .set-devices h3 { margin: 0 0 6px; font: 800 13px system-ui, sans-serif; color: #cbe6a0;
  text-transform: uppercase; letter-spacing: .04em; }
#hud .set-dev-list { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #b6a986; }
#hud .set-dev-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; border-radius: 9px; background: rgba(47,156,138,.10);
  box-shadow: inset 0 0 0 1px rgba(79,208,184,.22); }
#hud .set-dev-name { font-size: 14px; font-weight: 700; color: #eaffd8; }
#hud .set-dev-when { font-size: 12px; color: #9ad3c4; margin-top: 2px; }
#hud .set-dev-revoke { flex: 0 0 auto; border: 2px solid #14240a; border-radius: 8px; padding: 5px 12px;
  cursor: pointer; color: #fff; font: 800 12px system-ui, sans-serif; text-shadow: 0 1px 1px #000;
  background: linear-gradient(#c0553f, #9c3320); }
#hud .set-dev-revoke:hover { filter: brightness(1.1); }
#hud .set-dev-revoke:disabled { opacity: .5; cursor: default; }
#hud .set-row { display: flex; align-items: center; justify-content: space-between;
  gap: 24px; min-width: 240px; padding: 8px 2px; font-size: 15px; font-weight: 700; }
#hud .set-row + .set-row { border-top: 1px solid rgba(255,255,255,.15); }
#hud .set-note { margin: 2px 2px 4px; font-size: 12px; color: #cbe6a0; opacity: .85; }
#hud .set-username { margin: 4px 0 8px; }
#hud .set-username-controls { display: flex; gap: 7px; }
#hud .set-username-input { width: 150px; box-sizing: border-box; padding: 6px 8px;
  border: 2px solid #1e1207; border-radius: 7px; background: #2a1c0c; color: #ffe9a8;
  font: 700 14px system-ui, sans-serif; outline: none; }
#hud .set-username-input:focus { border-color: #86b94b; }
#hud .set-username-save { padding: 6px 12px; border: 2px solid #14240a; border-radius: 8px;
  cursor: pointer; color: #fff; font: 800 12px system-ui, sans-serif; text-shadow: 0 1px 1px #000;
  background: linear-gradient(#7ea63a, #55972a); }
#hud .set-username-save:disabled { opacity: .5; cursor: default; }
#hud .set-username-status { min-height: 15px; margin: 3px 2px 0; font-size: 12px; color: #cbe6a0; }
#hud .set-username-status.error { color: #ffb09f; }
#hud .set-version { margin-top: 12px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.15);
  color: #b6a986; font: 700 11px system-ui, sans-serif; text-align: center; text-shadow: none; }
#hud .toggle { width: 62px; height: 28px; border-radius: 15px; border: 2px solid #1e1207;
  background: #5a3a1a; cursor: pointer; position: relative; padding: 0;
  font: 700 11px system-ui, sans-serif; color: #fff; }
#hud .toggle.on { background: #4f9b2f; }
#hud .toggle .knob { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px;
  border-radius: 50%; background: #f2ead0; transition: left .12s; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
#hud .toggle.on .knob { left: 36px; }
#hud .toggle .txt { position: absolute; top: 6px; width: 26px; text-align: center; text-shadow: 0 1px 1px #000; }
#hud .toggle .txt.l { left: 4px; } #hud .toggle .txt.r { right: 4px; }
#hud .set-row-choice { flex-wrap: wrap; gap: 10px 24px; }
#hud .set-choice { display: flex; gap: 6px; }
#hud .choice { padding: 6px 12px; border-radius: 13px; border: 2px solid #1e1207;
  background: #5a3a1a; color: #f2ead0; cursor: pointer; font: 700 12px system-ui, sans-serif;
  text-shadow: 0 1px 1px #000; }
#hud .choice:hover { filter: brightness(1.12); }
#hud .choice.on { background: #4f9b2f; color: #fff; }
#hud .dev-head { margin: 12px 0 2px; font-weight: 700; color: #d8b45e;
  border-top: 1px solid #5b4a2a; padding-top: 10px; }
#hud .dev-input { width: 96px; padding: 5px 8px; border-radius: 6px; border: 2px solid #1e1207;
  background: #2a1c0c; color: #ffe9a8; font-weight: 700; font-size: 14px; text-align: right; }
#hud .dev-status { margin: 10px 0 6px; font-size: 12px; color: #cbe6a0; min-height: 15px; }
#hud .dev-raid-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
#hud .dev-btn { padding: 7px 8px; border-radius: 6px; border: 2px solid #1e1207; cursor: pointer;
  background: linear-gradient(#7ea63a, #55972a); color: #fff; font-weight: 700; font-size: 12px;
  text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .dev-btn:hover { filter: brightness(1.08); }
#hud .dev-btn:active { filter: brightness(.92); }

/* ---- Zombie detail page: card (left) + stats/abilities (right) ---- */
#hud .zpanel { padding: 18px 20px; }
#hud .zdetail { display: flex; gap: 20px; align-items: stretch; }
/* the trading card */
#hud .zcard { position: relative; width: 172px; flex: 0 0 auto; box-sizing: border-box;
  padding: 16px 12px 12px; border-radius: 10px; border: 3px solid #5e381f;
  background: linear-gradient(#c79a5e, #a9743d); box-shadow: inset 0 0 0 2px rgba(255,255,255,.12),
  0 3px 8px rgba(0,0,0,.5); text-align: center; }
#hud .zcard-nail { position: absolute; top: 7px; width: 12px; height: 12px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #f4f1e6 0%, #9a9484 45%, #4a463c 100%);
  box-shadow: 0 1px 2px rgba(0,0,0,.6), inset 0 0 1px #2a271f; }
#hud .zcard-nail.tl { left: 8px; } #hud .zcard-nail.tr { right: 8px; }
#hud .zcard-board { margin: 0 auto 10px; width: 132px; height: 34px; line-height: 34px;
  background: url(${BASE}assets/ui/market/title_board.png) center/100% 100% no-repeat;
  color: #f4e6c2; font-weight: 800; font-size: 14px; text-shadow: 0 2px 2px #000;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px; box-sizing: border-box; }
/* the lighter portrait rectangle (~10% wider than tall) */
#hud .zcard-port { width: 132px; height: 120px; margin: 0 auto 10px; border-radius: 8px;
  border: 2px solid #5e381f; background: #efe4bf center/contain no-repeat;
  box-shadow: inset 0 0 6px rgba(94,56,31,.4); }
#hud .zcard-meta { color: #3a2410; text-shadow: 0 1px 0 rgba(255,255,255,.25); }
#hud .zcard-meta .zvet { font-size: 16px; font-weight: 800; color: #4a2c10; letter-spacing: .3px; }
#hud .zcard-meta .zvet-b { font-size: 11px; font-weight: 800; color: #2f7d1e; letter-spacing: 0; }
#hud .zcard-meta .ztype { font-size: 12px; font-weight: 700; opacity: .9; margin-top: 1px; }
#hud .zcard-meta .zinv { font-size: 12px; font-weight: 700; margin-top: 3px; }
/* right column */
#hud .zright { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 210px; }
#hud .zsec-h { font-size: 12px; font-weight: 800; letter-spacing: .6px; text-transform: uppercase;
  color: #d8b45e; border-bottom: 1px solid #5b4a2a; padding-bottom: 3px; margin: 2px 0 8px; }
#hud .zright .zsec-h + .zrow { margin-bottom: 16px; }
#hud .zrow { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
#hud .zstats { gap: 8px; }
/* a stat cell: purple glyph tile + black value box (authentic game art) */
#hud .zstat { display: flex; align-items: center; gap: 0; cursor: pointer; border: none;
  background: none; padding: 0; }
#hud .zstat-tile { width: 40px; height: 40px; flex: 0 0 auto; display: flex;
  align-items: center; justify-content: center; background: center/100% 100% no-repeat;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
#hud .zstat-tile img { width: 26px; height: 26px; object-fit: contain;
  image-rendering: pixelated; }
#hud .zstat-val { min-width: 34px; height: 28px; margin-left: -2px; padding: 0 8px 0 6px;
  display: flex; align-items: center; justify-content: center;
  background-repeat: no-repeat, repeat-x; background-position: right center, left center;
  background-size: auto 100%, auto 100%; image-rendering: pixelated;
  color: #eaffd8; font-weight: 800; font-size: 14px; text-shadow: 0 1px 1px #000; }
/* a stat boosted by a mutation renders green */
#hud .zstat-val.boosted { color: #67e83f; text-shadow: 0 1px 1px #000, 0 0 4px rgba(103,232,63,.5); }
/* an ability cell: real icon inside the game's brown frame */
#hud .zabils { gap: 8px; }
#hud .zabil { width: 40px; height: 40px; padding: 0; border: none; cursor: pointer;
  background: center/100% 100% no-repeat; display: flex; align-items: center; justify-content: center;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
#hud .zabil img { width: 30px; height: 30px; object-fit: contain; image-rendering: pixelated; }
#hud .zabil:hover, #hud .zstat:hover { filter: brightness(1.1) drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
#hud .zabil.locked { filter: grayscale(1) brightness(.72) drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
#hud .zabil.locked:hover { filter: grayscale(.6) brightness(.9) drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
#hud .zabil .zlock { font-size: 18px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,.6)); }
#hud .zabil-none { font-size: 12px; font-style: italic; color: #d8c6a0; opacity: .8; padding: 8px 2px; }
/* small tooltip popup for a stat/ability */
#hud .ztip { position: absolute; transform: translate(-50%, -100%); z-index: 5;
  max-width: 180px; min-width: 96px; padding: 7px 10px; border-radius: 8px;
  background: #1c130a; border: 2px solid #d8b45e; box-shadow: 0 4px 12px rgba(0,0,0,.6);
  color: #fff; text-shadow: none; pointer-events: none; text-align: left; }
#hud .ztip b { display: block; font-size: 13px; color: #ffe08a; margin-bottom: 2px; }
#hud .ztip span { display: block; font-size: 12px; line-height: 1.3; opacity: .95; }
#hud .ztip .zeff { display: inline; color: #eaffd8; font-weight: 800; }
/* action buttons (zombie panel + object popup) */
#hud .zbtns { display: flex; gap: 8px; margin-top: 14px; justify-content: center; flex-wrap: wrap; }
#hud .zbtn { border: 2px solid #1e1207; border-radius: 9px; padding: 7px 14px; cursor: pointer;
  font: 700 13px system-ui, sans-serif; color: #fff; text-shadow: 0 1px 1px #000;
  background: linear-gradient(#7a5220, #5e3d15); }
#hud .zbtn:hover { filter: brightness(1.12); }
#hud .zbtn:disabled { opacity: .5; cursor: not-allowed; filter: none; }
#hud .zbtn.store { background: linear-gradient(#4f9bd8, #2f74bb); }
#hud .zbtn.deploy { background: linear-gradient(#79c247, #55972a); }
#hud .zbtn.sell { background: linear-gradient(#e3a24a, #c47a1e); }

/* ---- Zombie roster (Zombies menu) ---- */
#hud .zroster { display: flex; flex-direction: column; gap: 10px; width: min(560px, 88vw); }
#hud .zr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
#hud .zr-head h2 { margin: 0; font-size: 20px; }
#hud .zr-total { font-size: 15px; font-weight: 800; color: #b6f36a; }
#hud .zr-total .zr-sub { color: #9fd3e8; font-weight: 700; }
#hud .zr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 8px; max-height: 54vh; overflow: auto; padding: 2px; }
/* Zombie tiles reuse the storage-shed slot frame so the Mausoleum matches the shed. */
#hud .zr-card { position: relative; background: transparent; border: none; border-radius: 0;
  padding: 4px 2px 5px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;
  box-shadow: none; }
#hud .zr-card:hover .zr-por { filter: brightness(1.08) drop-shadow(0 0 3px rgba(255,220,120,.8)); }
#hud .zr-por { width: 66px; height: 66px; box-shadow: none; border-radius: 0;
  background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center; }
#hud .zr-por-img { max-width: 48px; max-height: 48px; object-fit: contain; }
#hud .zr-name { font-size: 11px; font-weight: 700; text-align: center; max-width: 80px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .zr-cls { font-size: 10px; font-weight: 800; padding: 1px 7px; border-radius: 8px; color: #16110a;
  border: 1px solid rgba(0,0,0,.5); }
#hud .zr-stored { position: absolute; top: 3px; right: 3px; font-size: 9px; font-weight: 700;
  background: #2f74bb; color: #fff; padding: 1px 5px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
#hud .zr-empty { grid-column: 1 / -1; text-align: center; opacity: .85; font-style: italic; padding: 26px 12px; }
/* Mausoleum empty slots (tap to store a farm zombie) */
#hud .zr-por-empty { background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat; }
#hud .zr-plus { font-size: 30px; font-weight: 900; color: #6f5330; opacity: .55; }
#hud .zr-slot-empty { opacity: .82; }
#hud .zr-slot-empty:hover { opacity: 1; }
#hud .zr-slot-empty:hover .zr-por { filter: brightness(1.1) drop-shadow(0 0 3px rgba(255,220,120,.7)); }
/* Zombies tab: scrollable list of full inspect cards */
#hud .zl-panel { position: relative; width: min(640px, 92vw); display: flex; flex-direction: column; gap: 10px; }
#hud .zl-list { display: flex; flex-direction: column; gap: 10px; max-height: 66vh; overflow: auto; padding: 2px 2px 4px;
  scrollbar-width: none; -ms-overflow-style: none; }
#hud .zl-list::-webkit-scrollbar { width: 0; height: 0; display: none; }
#hud .zl-row { background: #2b1a0c; border: 2px solid #14100a; border-radius: 12px; padding: 12px;
  box-shadow: inset 0 -3px 0 rgba(0,0,0,.25); }
#hud .zl-row .zdetail { flex-wrap: wrap; }

/* ---- Zombie Pot (combiner) ---- */
#hud .cmb { display: flex; flex-direction: column; gap: 12px; width: min(560px, 90vw); }
#hud .cmb-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
#hud .cmb-head h2 { margin: 0; font-size: 20px; }
#hud .cmb-time { font-size: 13px; font-weight: 800; color: #b6f36a; }
#hud .cmb-slots { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; }
#hud .cmb-slot { min-height: 108px; border-radius: 12px; border: 2px dashed #6b4a24; background: #2c1c0e;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 8px; }
#hud .cmb-slot.filled { border-style: solid; border-color: #8ad14a; background: #34240f; cursor: pointer; }
#hud .cmb-slot .cmb-por { width: 56px; height: 56px; border-radius: 8px; background: #24160a center/contain no-repeat;
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.06); }
#hud .cmb-slot .cmb-sn { font-size: 12px; font-weight: 700; max-width: 120px; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .cmb-slot .cmb-sm { font-size: 10px; color: #c9a24a; text-align: center; max-width: 130px; line-height: 1.2; }
#hud .cmb-slot .cmb-hint { font-size: 12px; color: #a98a5f; font-style: italic; }
#hud .cmb-plus { font-size: 26px; font-weight: 900; color: #d8bc40; }
#hud .cmb-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
  gap: 7px; max-height: 34vh; overflow: auto; padding: 2px;
  border-top: 1px solid rgba(255,255,255,.08); padding-top: 10px; }
#hud .cmb-z { position: relative; background: #3a2612; border: 2px solid #1e1207; border-radius: 9px;
  padding: 6px 3px 5px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px; }
#hud .cmb-z:hover { background: #4a3117; }
#hud .cmb-z.chosen { border-color: #8ad14a; box-shadow: 0 0 0 2px rgba(138,209,74,.4); opacity: .55; cursor: default; }
#hud .cmb-z .cmb-zpor { width: 50px; height: 50px; border-radius: 7px; background: #24160a center/contain no-repeat; }
#hud .cmb-z .cmb-zn { font-size: 10px; font-weight: 700; max-width: 72px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .cmb-z .cmb-zmut { position: absolute; top: 2px; left: 2px; font-size: 8px; font-weight: 800;
  background: #7d3ad1; color: #fff; padding: 0 4px; border-radius: 5px; }
#hud .cmb-go { align-self: center; border: none; border-radius: 10px; padding: 10px 30px; cursor: pointer;
  font: 800 15px/1 inherit; color: #16110a; background: linear-gradient(#79c247, #55972a);
  box-shadow: inset 0 -3px 0 rgba(0,0,0,.28); }
#hud .cmb-go:disabled { opacity: .45; cursor: not-allowed; filter: grayscale(.5); }
#hud .cmb-empty { text-align: center; opacity: .85; font-style: italic; padding: 22px 12px; }
/* busy / progress view */
#hud .cmb-prog { height: 22px; border-radius: 8px; background: #24160a; overflow: hidden;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.5); }
#hud .cmb-prog > i { display: block; height: 100%; width: 0;
  background: linear-gradient(#8ad14a, #5c9a2c); transition: width .25s linear; }
#hud .cmb-note { text-align: center; font-size: 13px; color: #d8c9a0; }

/* ---- Object action popup (Move / Store / Sell) ---- */
#hud .obj-actions { text-align: center; min-width: 240px; }
#hud .obj-actions h2 { margin: 0 0 10px; }
#hud .obj-por { width: 92px; height: 92px; margin: 0 auto; border-radius: 12px; border: 2px solid #2f1d0d;
  background: #24160a center/contain no-repeat; box-shadow: inset 0 0 0 2px rgba(255,255,255,.06); }

/* ---- Sell-zombie confirmation window ---- */
#hud .confirm-panel { text-align: center; min-width: 260px; max-width: 340px; }
#hud .confirm-panel h2 { margin: 0 0 12px; }
#hud .confirm-panel .obj-por { margin-bottom: 12px; }
#hud .confirm-msg { margin: 0 0 6px; font-size: 14px; line-height: 1.4; }
#hud .confirm-warn { display: inline-block; margin-top: 6px; font-size: 12px; color: #f6c76a; font-style: italic; }

/* ---- Growing crop/zombie info popup ---- */
#hud .crop-info { text-align: center; min-width: 220px; }
#hud .crop-info h2 { margin: 0 0 4px; }
#hud .crop-kind { margin: 0 0 10px; font-size: 13px; color: #d8bc84; font-style: italic; }
#hud .crop-time { margin: 0; font-size: 17px; font-weight: 700; color: #f4e9cf; }
#hud .crop-time.ripe { color: #8fdc5a; }
#hud .crop-grow { display: flex; align-items: center; gap: 8px; margin-top: 14px;
  padding: 8px 10px; background: rgba(0,0,0,.22); border-radius: 10px; }
#hud .crop-grow img { width: 34px; height: 34px; object-fit: contain; flex: 0 0 auto; }
#hud .crop-grow-label { flex: 1 1 auto; text-align: left; font-size: 13px; line-height: 1.2; }
#hud .crop-grow-label .nm { font-weight: 700; }
#hud .crop-grow-label .ct { margin-left: 5px; color: #d8bc84; }
#hud .crop-grow-btn { flex: 0 0 auto; padding: 6px 14px; }

/* storage: hint line + filled-slot affordance */
#hud .st-hint { text-align: center; color: #6e4a1e; font-size: 12px; font-style: italic; margin: 0 0 8px; }
#hud .st-slot.filled { cursor: pointer; }
#hud .st-slot.filled:hover { filter: brightness(1.08) drop-shadow(0 0 3px rgba(255,220,120,.8)); }

/* ---- Raid / Invasion panels ---- */
#hud .raidsel { display: flex; gap: 14px; width: min(700px, 92vw); }
#hud .raid-list { display: flex; flex-direction: column; gap: 6px; width: 210px; flex: 0 0 auto;
  max-height: 62vh; overflow: auto; padding: 2px; }
#hud .rd-card { display: flex; gap: 8px; align-items: center; text-align: left; cursor: pointer;
  background: #3a2612; border: 2px solid #1e1207; border-radius: 10px; padding: 6px 8px; color: #fff;
  box-shadow: inset 0 -3px 0 rgba(0,0,0,.25); }
#hud .rd-card:hover { background: #4a3117; }
#hud .rd-card.sel { border-color: #ffcf5a; box-shadow: 0 0 0 2px rgba(255,207,90,.5); }
#hud .rd-card.locked { opacity: .62; }
#hud .rd-thumb { width: 40px; height: 40px; border-radius: 7px; flex: 0 0 auto;
  background: #24160a center/contain no-repeat; box-shadow: inset 0 0 0 2px rgba(255,255,255,.06); }
#hud .rd-cn { font-size: 12px; font-weight: 800; line-height: 1.2; }
#hud .rd-cl { font-size: 10px; font-weight: 700; opacity: .8; }
#hud .rd-cl.lock { color: #ffb0a0; opacity: 1; }
#hud .rd-detail { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
#hud .rd-hero { display: flex; gap: 12px; align-items: center; }
#hud .rd-hero > div { min-width: 0; } /* let the title/boss/meta column wrap instead of overflowing */
#hud .rd-portrait { width: 92px; height: 92px; flex: 0 0 auto; border-radius: 12px; border: 2px solid #2f1d0d;
  background: #24160a center/contain no-repeat; box-shadow: inset 0 0 0 2px rgba(255,255,255,.06); }
#hud .rd-title { font-size: 19px; font-weight: 800; margin: 0; overflow-wrap: anywhere; }
#hud .rd-boss { font-size: 13px; font-weight: 700; color: #ffcf5a; }
#hud .rd-meta { font-size: 12px; opacity: .9; }
#hud .rd-intro { font-size: 12.5px; line-height: 1.35; opacity: .92; white-space: pre-wrap;
  max-height: 16vh; overflow: auto; margin: 0; }
#hud .rd-rewards { display: flex; flex-wrap: wrap; gap: 5px; }
#hud .rd-chip { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px;
  background: #24160a; border: 1px solid rgba(255,255,255,.12); }
#hud .rd-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  flex-wrap: wrap; margin-top: auto; border-top: 1px solid rgba(255,255,255,.15); padding-top: 8px; }
#hud .rd-army { font-size: 12px; font-weight: 700; color: #b6f36a; min-width: 0; overflow-wrap: anywhere; }
#hud .rd-army.short { color: #ffb0a0; }
#hud .raid-go { border: 2px solid #1e1207; border-radius: 9px; padding: 8px 18px; cursor: pointer;
  background: linear-gradient(#c04155, #9c2135); color: #fff; font-weight: 800; font-size: 14px;
  text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .raid-go:hover { filter: brightness(1.1); }
#hud .raid-go:disabled { opacity: .5; cursor: not-allowed; filter: none; }
#hud .raid-quick { border: 2px solid #1e1207; border-radius: 9px; padding: 8px 14px; cursor: pointer;
  background: #3a2612; color: #e8d5b0; font-weight: 700; font-size: 12.5px; }
#hud .raid-quick:hover { filter: brightness(1.15); }
/* army select */
#hud .army-wrap { display: flex; flex-direction: column; gap: 10px; width: min(600px, 90vw); }
#hud .army-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  flex-wrap: wrap; }
#hud .army-head h2 { margin: 0; font-size: 19px; min-width: 0; overflow-wrap: anywhere; }
#hud .army-count { font-size: 14px; font-weight: 800; color: #b6f36a; flex: 0 0 auto; white-space: nowrap; }
#hud .army-count.short { color: #ffb0a0; }
#hud .army-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(94px, 1fr)); gap: 8px;
  max-height: 52vh; overflow: auto; padding: 2px; }
#hud .army-card { position: relative; background: #3a2612; border: 2px solid #1e1207; border-radius: 10px;
  padding: 6px 4px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px;
  box-shadow: inset 0 -3px 0 rgba(0,0,0,.25); }
#hud .army-card.sel { border-color: #ffcf5a; background: #4a3117; box-shadow: 0 0 0 2px rgba(255,207,90,.5); }
#hud .army-card .tick { position: absolute; top: 3px; right: 4px; min-width: 18px; height: 18px;
  padding: 0 3px; box-sizing: border-box; border-radius: 9px; display: flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 800; color: #16110a; background: #ffcf5a;
  box-shadow: 0 1px 2px rgba(0,0,0,.5); opacity: 0; }
#hud .army-card.sel .tick { opacity: 1; }
#hud .army-por { width: 52px; height: 52px; border-radius: 8px; background: #24160a center/contain no-repeat;
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.06); }
#hud .army-nm { font-size: 10.5px; font-weight: 700; max-width: 84px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
#hud .army-ty { font-size: 9px; font-weight: 700; opacity: .6; max-width: 84px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
#hud .army-st { font-size: 10px; font-weight: 700; opacity: .85; }
#hud .army-foot { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
/* battle-consumable controls (Concentration toggle + Golden Dice stepper) */
#hud .raid-boosts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 2px 2px; border-top: 1px solid rgba(255,255,255,.15); }
#hud .raid-boost-btn { display: flex; align-items: center; gap: 5px; cursor: pointer;
  border: 2px solid #1e1207; border-radius: 9px; padding: 6px 12px; font: 700 13px system-ui, sans-serif;
  color: #e8d5b0; background: #3a2612; text-shadow: 0 1px 1px #000; }
#hud .raid-boost-btn:hover { filter: brightness(1.12); }
#hud .raid-boost-btn.on { color: #16110a; background: linear-gradient(#8ec74f, #5c9a2e);
  border-color: #3c5a10; text-shadow: none; box-shadow: 0 0 0 2px rgba(142,199,79,.4); }
#hud .raid-boost-btn .rb-ct { font-size: 11px; opacity: .8; }
#hud .raid-dice { display: flex; align-items: center; gap: 6px; }
#hud .raid-dice .rd-lbl { font: 700 13px system-ui, sans-serif; color: #e8d5b0; text-shadow: 0 1px 1px #000; }
#hud .raid-dice .rd-lbl b { color: #ffcf5a; font-size: 15px; }
#hud .raid-dice .rd-step { width: 26px; height: 26px; cursor: pointer; border: 2px solid #1e1207;
  border-radius: 7px; background: linear-gradient(#7a5220, #5e3d15); color: #fff; font: 900 16px/1 system-ui;
  display: flex; align-items: center; justify-content: center; }
#hud .raid-dice .rd-step:hover { filter: brightness(1.15); }
/* result tally — a panel that slides in from the RIGHT as the zombies march off */
#hud .raid-res-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 22;
  display: flex; align-items: stretch; justify-content: flex-end; }
#hud .raid-res-panel { width: min(340px, 82vw); display: flex; flex-direction: column;
  background: linear-gradient(#f3e2bd, #e6cf9c); border-left: 4px solid #8a6a34;
  box-shadow: -4px 0 22px rgba(0,0,0,.5); color: #3a2a12; padding: 0 0 14px;
  transform: translateX(105%); transition: transform .45s cubic-bezier(.2,.8,.25,1); }
#hud .raid-res-panel.in { transform: translateX(0); }
#hud .rr-title { font-size: 26px; font-weight: 900; text-align: center; letter-spacing: 1px;
  padding: 16px 10px 12px; color: #fff; text-shadow: 0 2px 2px rgba(0,0,0,.4);
  background: linear-gradient(#8a5a2c, #6f4420); border-bottom: 3px solid #4a2d12; }
#hud .rr-title.lose { background: linear-gradient(#7a3030, #5a2020); }
#hud .rr-body { flex: 1; padding: 14px 20px; display: flex; flex-direction: column; gap: 2px; }
#hud .rr-row { display: flex; align-items: center; justify-content: space-between;
  padding: 9px 2px; border-bottom: 1px solid rgba(90,60,20,.25); }
#hud .rr-l { font-size: 16px; font-weight: 700; }
#hud .rr-v { font-size: 18px; font-weight: 900; display: inline-flex; align-items: center; gap: 6px; }
#hud .rr-v .rr-i { width: 20px; height: 20px; object-fit: contain; }
#hud .rr-loot { border-bottom: none; padding-bottom: 2px; }
#hud .rr-loot-items { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px 2px; }
#hud .rr-loot-i { display: flex; flex-direction: column; align-items: center; gap: 3px; width: 92px; }
#hud .rr-loot-i img { width: 82px; height: 82px; object-fit: contain;
  background: rgba(74,49,23,.12); border: 2px solid #8a6a34; border-radius: 12px; padding: 4px; }
#hud .rr-loot-i span { font-size: 10px; font-weight: 700; text-align: center; line-height: 1.1; }
#hud .rr-loot-i.rr-loot-noimg { width: auto; font-size: 12px; font-weight: 800; background: #4a3117;
  color: #ffe9a8; padding: 4px 9px; border-radius: 8px; }
#hud .rr-loot-none { font-size: 14px; opacity: .5; padding: 2px; }
#hud .rr-unlock { margin-top: 8px; font-size: 13px; font-weight: 800; color: #2f7a2f; }
#hud .rr-go { margin: 6px 20px 0; border: 2px solid #1e1207; border-radius: 10px; padding: 12px;
  background: linear-gradient(#8ec74f, #5c9a2e); color: #fff; font-weight: 900; font-size: 16px;
  cursor: pointer; text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .rr-go:hover { filter: brightness(1.08); }
#hud .revive-bg { position: fixed; inset: 0; z-index: 28; pointer-events: auto;
  background: rgba(20,8,4,.76); display: grid; place-items: center; padding: 18px; }
#hud .revive-panel { width: min(520px, 94vw); max-height: min(680px, 90vh); overflow: hidden;
  display: flex; flex-direction: column; border: 4px solid #2b170b; border-radius: 18px;
  background: linear-gradient(#f5e5b8, #d6b873); color: #28170c; box-shadow: 0 12px 40px #000b; }
#hud .revive-title { padding: 14px 18px; text-align: center; color: #fff; font-size: 25px;
  font-weight: 900; background: linear-gradient(#6b2631, #42141c); text-shadow: 0 2px 2px #000; }
#hud .revive-warning { margin: 12px 16px 7px; padding: 9px 11px; border: 2px solid #913a31;
  border-radius: 9px; background: #fff1d0; color: #74251f; font-size: 13px; font-weight: 900; text-align: center; }
#hud .revive-balance { text-align: center; font-size: 14px; font-weight: 800; }
#hud .revive-balance img, #hud .revive-cost img { width: 20px; height: 20px; object-fit: contain; vertical-align: middle; }
#hud .revive-list { overflow-y: auto; display: grid; gap: 8px; padding: 10px 16px; }
#hud .revive-zombie { display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 10px;
  min-height: 66px; padding: 6px 9px; border: 2px solid #69451f; border-radius: 10px; background: #f9edca; }
#hud .revive-zombie.selected { border-color: #367436; background: #e1f0c4; }
#hud .revive-zombie img { width: 56px; height: 56px; object-fit: contain; }
#hud .revive-name { font-size: 15px; font-weight: 900; }
#hud .revive-type { font-size: 11px; opacity: .72; }
#hud .revive-pick { min-width: 100px; padding: 8px; border: 2px solid #2b170b; border-radius: 8px;
  background: linear-gradient(#79b44a,#4d852d); color: #fff; font-weight: 900; }
#hud .revive-pick.selected { background: linear-gradient(#b56b54,#843f32); }
#hud .revive-pick:disabled { filter: grayscale(1); opacity: .48; }
#hud .revive-foot { padding: 8px 16px 15px; }
#hud .revive-confirm { width: 100%; padding: 12px; border: 2px solid #241307; border-radius: 10px;
  background: linear-gradient(#f2b341,#c87a18); color: #301b08; font-size: 16px; font-weight: 900; }
#hud .revive-error { min-height: 18px; color: #8b211b; text-align: center; font-size: 12px; font-weight: 800; }

/* ---- Level-up popup ---- */
#hud .lvl-bg { z-index: 24; }
#hud .lvlup { width: min(460px, 90vw); display: flex; flex-direction: column; align-items: center;
  gap: 8px; text-align: center; }
#hud .lvl-burst { font-size: 30px; font-weight: 900; letter-spacing: 1px; color: #ffdf5a;
  text-shadow: 0 2px 0 #a5661a, 0 0 12px rgba(255,209,90,.6); transform: scale(.6); opacity: 0;
  transition: transform .32s cubic-bezier(.2,1.5,.4,1), opacity .32s ease; }
#hud .lvlup.in .lvl-burst { transform: scale(1); opacity: 1; }
#hud .lvl-num { font-size: 19px; font-weight: 800; color: #eafff0; margin-top: -2px; }
#hud .lvl-reward { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 800;
  color: #ff9db0; }
#hud .lvl-reward img { width: 22px; height: 22px; }
#hud .lvl-sub { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
  color: #b6f36a; margin-top: 4px; opacity: .95; }
#hud .lvl-unlocks { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  max-height: 42vh; overflow: auto; padding: 4px 2px; }
#hud .lvl-slot { display: flex; flex-direction: column; align-items: center; gap: 3px; width: 76px; }
#hud .lvl-frame { width: 60px; height: 60px;
  background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center; }
#hud .lvl-frame img { max-width: 46px; max-height: 46px; object-fit: contain; }
#hud .lvl-nm { font-size: 10px; font-weight: 700; line-height: 1.1; max-width: 76px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .lvl-tag { font-size: 9px; font-weight: 800; color: #ffd98a; opacity: .85; }
#hud .lvl-none { font-size: 14px; opacity: .8; font-style: italic; padding: 10px; }
#hud .lvl-go { margin: 8px 20px 0; border: 2px solid #1e1207; border-radius: 10px; padding: 12px 40px;
  background: linear-gradient(#8ec74f, #5c9a2e); color: #fff; font-weight: 900; font-size: 16px;
  cursor: pointer; text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .lvl-go:hover { filter: brightness(1.08); }

/* ---- Quest-complete popup (mirrors the level-up celebration) ---- */
#hud .qc-bg { z-index: 24; }
#hud .questdone { width: min(420px, 90vw); display: flex; flex-direction: column; align-items: center;
  gap: 8px; text-align: center; }
#hud .qc-icon { width: 72px; height: 72px;
  background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center;
  transform: scale(.6); opacity: 0; transition: transform .32s cubic-bezier(.2,1.5,.4,1), opacity .32s ease; }
#hud .questdone.in .qc-icon { transform: scale(1); opacity: 1; }
#hud .qc-icon img { max-width: 54px; max-height: 54px; object-fit: contain; }
#hud .qc-burst { font-size: 26px; font-weight: 900; letter-spacing: 1px; color: #b6f36a;
  text-shadow: 0 2px 0 #2d5a12, 0 0 12px rgba(120,220,90,.55); }
#hud .qc-title { font-size: 18px; font-weight: 800; color: #eafff0; margin-top: -2px; }
#hud .qc-msg { font-size: 14px; font-weight: 600; color: #d8ecc6; opacity: .9; max-width: 340px; }
#hud .qc-sub { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
  color: #ffd98a; margin-top: 4px; opacity: .95; }
#hud .qc-rewards { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; padding: 2px; }
#hud .qc-reward { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 800;
  color: #ffe9a8; border: 2px solid #1e1207; border-radius: 10px; padding: 6px 12px;
  background: rgba(0,0,0,.25); }
#hud .qc-reward img { width: 24px; height: 24px; object-fit: contain; }

/* ---- Market panel (authentic parchment + wood sprites) ---- */
#hud .mkt-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 21;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
#hud .mkt { position: relative; box-sizing: border-box;
  width: min(770px, 94vw); height: min(500px, 90vh);
  border-style: solid; border-width: 32px 11px 12px 11px;
  border-image: url(${BASE}assets/ui/market/paper_market.png) 32 11 12 11 fill / 32px 11px 12px 11px stretch;
  padding: 4px 16px 8px; font-family: Georgia, "Times New Roman", serif;
  display: flex; flex-direction: column; }
#hud .mkt-title { position: absolute; top: -30px; left: 50%; transform: translateX(-50%);
  width: 226px; height: 58px; background: url(${BASE}assets/ui/market/title_board.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center;
  color: #f4e6c2; font-weight: 700; font-size: 23px; text-shadow: 0 2px 2px #000; letter-spacing: .5px; }
#hud .mkt-close { position: absolute; top: -16px; right: -16px; width: 44px; height: 44px;
  border: none; background: none; cursor: pointer; padding: 0;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
#hud .mkt-close img { width: 100%; height: 100%; }
#hud .mkt-cur { display: flex; gap: 18px; align-items: center; margin: 2px 0 8px 2px;
  font-weight: 700; font-size: 17px; color: #48300f; text-shadow: 0 1px 0 rgba(255,255,255,.4); }
#hud .mkt-cur span { display: flex; align-items: center; gap: 4px; }
#hud .mkt-cur img { height: 21px; }
#hud .mkt-tabs { display: flex; gap: 7px; justify-content: center; margin-bottom: 7px; }
#hud .mkt-tab { border-style: solid; border-width: 7px 20px;
  border-image: url(${BASE}assets/ui/market/tab.png) 16 fill / 7px 20px stretch;
  color: #f6ecc8; font-weight: 700; font-size: 15px; cursor: pointer; min-width: 58px;
  text-shadow: 0 1px 1px rgba(0,0,0,.45); }
#hud .mkt-tab.sel { border-image-source: url(${BASE}assets/ui/market/tab_sel.png);
  color: #5a3a12; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
#hud .mkt-subtabs { display: flex; gap: 6px; justify-content: center; margin-bottom: 9px; }
#hud .mkt-subtab { border-style: solid; border-width: 6px 16px;
  border-image: url(${BASE}assets/ui/market/subtab.png) 12 fill / 6px 16px stretch;
  color: #f6ecc8; font-weight: 700; font-size: 13px; cursor: pointer; min-width: 46px;
  text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .mkt-subtab.sel { border-image-source: url(${BASE}assets/ui/market/subtab_sel.png);
  color: #5a3a12; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
/* Search box: filters the current tab's cards by name. */
#hud .mkt-search-row { display: flex; justify-content: center; margin-bottom: 8px; flex: 0 0 auto; }
#hud .mkt-search { width: min(280px, 70%); box-sizing: border-box;
  padding: 5px 12px; font-family: inherit; font-size: 13px; font-weight: 700;
  color: #48300f; background: rgba(255,248,230,.72);
  border: 2px solid #b98b4a; border-radius: 14px; outline: none;
  box-shadow: inset 0 1px 3px rgba(90,52,19,.25); }
#hud .mkt-search::placeholder { color: #9a7a4a; font-weight: 400; font-style: italic; }
#hud .mkt-search:focus { border-color: #8a5a2a; background: rgba(255,250,238,.92); }
/* Pager: prev / "page x / y" / next, reusing the market's own arrow art. */
#hud .mkt-pager { display: flex; align-items: center; justify-content: center; gap: 14px;
  margin-top: 7px; flex: 0 0 auto; }
#hud .mkt-pageinfo { font-weight: 700; font-size: 14px; color: #48300f;
  min-width: 52px; text-align: center; text-shadow: 0 1px 0 rgba(255,255,255,.4); }
#hud .mkt-page-arrow { width: 34px; height: 30px; padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(#8a5a2a, #6e4420); border: 2px solid #4a2c12; border-radius: 8px;
  box-shadow: 0 1px 0 #3c2410; }
#hud .mkt-page-arrow img { width: 11px; height: 16px; filter: brightness(0) invert(1) opacity(.9); }
#hud .mkt-page-arrow.left img { transform: scaleX(-1); }
#hud .mkt-page-arrow:disabled { opacity: .4; cursor: default; box-shadow: none; }
#hud .mkt-page-arrow:not(:disabled):hover { background: linear-gradient(#9a6a34, #7a4d22); }
#hud .mkt-grid { flex: 1 1 auto; display: grid; grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: 122px; gap: 9px 10px; padding: 0 2px 2px; overflow-y: auto; overflow-x: hidden;
  min-height: 0; align-content: start;
  /* Slim, parchment-toned scrollbar so a paged grid that still overflows on small
     screens matches the wood/paper chrome instead of the stark OS default. */
  scrollbar-width: thin; scrollbar-color: #a5763c transparent; }
#hud .mkt-grid::-webkit-scrollbar { width: 8px; }
#hud .mkt-grid::-webkit-scrollbar-track { background: transparent; margin: 2px 0; }
#hud .mkt-grid::-webkit-scrollbar-thumb { background: linear-gradient(#a5763c, #6e4420);
  border-radius: 6px; border: 1px solid #4f2f13; }
#hud .mkt-grid::-webkit-scrollbar-thumb:hover { background: linear-gradient(#b98b4a, #7a4d22); }
#hud .mkt-card { position: relative; border-radius: 8px; overflow: hidden; background: #efe4bf;
  cursor: pointer; border: 2px solid #b98b4a; box-shadow: inset 0 -3px 0 rgba(90,52,19,.12);
  display: flex; flex-direction: column; }
#hud .mkt-card:hover { background: #f7efcd; }
/* Magnifier "what does it do?" button, tucked into the card's top-right corner. */
#hud .mkt-info { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0;
  display: flex; align-items: center; justify-content: center; z-index: 2; cursor: pointer;
  border: 1px solid #4f2f13; border-radius: 50%; color: #4f2f13;
  background: linear-gradient(#f0e0af, #d0b678); box-shadow: 0 1px 1px rgba(0,0,0,.35); }
#hud .mkt-info:hover { background: linear-gradient(#fbf1cd, #e0c98a); }
#hud .mkt-info svg { display: block; }
#hud .mkt-card .hd { height: 22px; background: linear-gradient(#956733, #6e4420);
  border-bottom: 2px solid #4f2f13; color: #f4e6c2; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; padding: 0 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 1px #000; }
#hud .mkt-body { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center;
  justify-content: space-between; padding: 4px 4px 5px; gap: 2px; min-height: 0; }
#hud .mkt-body img { flex: 1 1 auto; max-height: 52px; max-width: 100%; object-fit: contain;
  image-rendering: auto; }
#hud .mkt-sell { font-size: 11px; font-weight: 700; color: #3f7a1e; display: flex;
  align-items: center; gap: 2px; }
#hud .mkt-sell img { height: 12px; max-height: 12px; }
#hud .mkt-cost { display: flex; align-items: center; justify-content: center; gap: 3px;
  font-size: 13px; font-weight: 700; color: #452c0c; }
#hud .mkt-cost img { height: 15px; max-height: 15px; }
#hud .mkt-card.locked { opacity: .55; filter: grayscale(.6); cursor: not-allowed; }
#hud .mkt-card.locked:hover { background: #efe4bf; }
#hud .mkt-empty { grid-column: 1 / -1; text-align: center; color: #6e4a1e; font-style: italic;
  padding: 30px 0; font-size: 15px; }
/* Upgrade tab: a full-width status banner above the single next-buyable Farm Size
   tier, shown as two centered payment cards (gold | brains) at the same card size
   as every other tab. */
#hud .mkt-grid.mkt-grid--upgrade { grid-template-columns: repeat(2, 150px);
  grid-auto-rows: 122px; justify-content: center; }
#hud .mkt-upgrade-status { grid-column: 1 / -1; text-align: center; color: #4f2f13;
  font-size: 14px; padding: 4px 0 8px; }
#hud .mkt-upgrade-status b { color: #2f7a1e; font-size: 16px; }
#hud .mkt-upgrade-size { font-size: 12px; font-weight: 700; color: #6e4a1e; }
#hud .mkt-card.owned { background: #dcecc4; border-color: #7fa957; cursor: default; }
#hud .mkt-card.owned:hover { background: #dcecc4; }
#hud .mkt-card.owned .mkt-cost { color: #2f7a1e; }
#hud .mkt-card.owned:not(.equipped) { cursor: pointer; }
#hud .mkt-card.owned:not(.equipped):hover { filter: brightness(1.05); }
#hud .mkt-card.equipped { box-shadow: inset 0 0 0 3px #75a947; }
#hud .mkt-grid--epic { display: block; overflow: auto; }
#hud .epic-market-card { min-height: 280px; display: grid; grid-template-columns: minmax(120px, 34%) 1fr;
  gap: 14px; padding: 14px; border: 3px solid #63377d; border-radius: 14px; background: rgba(238,221,177,.94); color: #3d2516; }
#hud .epic-market-portrait { width: 100%; max-height: 210px; object-fit: contain; align-self: center; image-rendering: pixelated; }
#hud .epic-market-copy h2 { margin: 0 0 6px; color: #5c286e; }
#hud .epic-market-copy details { margin-top: 10px; }
#hud .epic-hp { height: 18px; margin: 8px 0 3px; border: 2px solid #4d271d; border-radius: 9px; overflow: hidden; background: #441d22; }
#hud .epic-hp span { display: block; height: 100%; background: linear-gradient(#ec4b55,#a41526); }
#hud .epic-wait { color: #9a2c25; font-weight: 800; }
#hud .epic-market-actions { grid-column: 1 / -1; display: flex; justify-content: center;
  align-items: center; flex-wrap: wrap; gap: 8px; }
#hud .epic-market-action { min-width: 210px; }
#hud .epic-market-action img { width: 20px; height: 20px; vertical-align: middle; }

/* ---- Item info popup (opened by a Market card's magnifier) ---- */
#hud .info-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 24;
  background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
#hud .info-box { position: relative; box-sizing: border-box; width: min(330px, 86vw);
  border-style: solid; border-width: 32px 11px 12px 11px;
  border-image: url(${BASE}assets/ui/market/paper_market.png) 32 11 12 11 fill / 32px 11px 12px 11px stretch;
  padding: 4px 18px 16px; font-family: Georgia, "Times New Roman", serif; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 8px; }
#hud .info-close { position: absolute; top: -16px; right: -16px; width: 40px; height: 40px;
  border: none; background: none; cursor: pointer; padding: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
#hud .info-close img { width: 100%; height: 100%; }
#hud .info-img { max-height: 80px; max-width: 58%; object-fit: contain; margin-top: 2px; }
#hud .info-name { font-weight: 700; font-size: 18px; color: #4f2f13;
  text-shadow: 0 1px 0 rgba(255,255,255,.4); }
#hud .info-desc { font-size: 14px; line-height: 1.42; color: #48300f; }

/* ---- Storage menu (the tool shed) ---- */
#hud .st-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 21;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
#hud .st { position: relative; box-sizing: border-box; width: min(600px, 94vw); height: min(430px, 88vh);
  border-style: solid; border-width: 32px 11px 12px 11px;
  border-image: url(${BASE}assets/ui/market/paper_market.png) 32 11 12 11 fill / 32px 11px 12px 11px stretch;
  padding: 30px 16px 10px; font-family: Georgia, "Times New Roman", serif;
  display: flex; flex-direction: column; }
#hud .st-close { position: absolute; top: -16px; right: -16px; width: 44px; height: 44px;
  border: none; background: none; cursor: pointer; padding: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
#hud .st-close img { width: 100%; height: 100%; }
#hud .st-header { position: absolute; top: -30px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; pointer-events: none; }
#hud .st-header img.flank { height: 44px; }
#hud .st-banner { width: 176px; height: 52px; margin: 0 -10px; z-index: 1;
  background: url(${BASE}assets/ui/storage/board_storage.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center;
  color: #ffe9c2; font-weight: 700; font-size: 20px; text-shadow: 0 2px 2px #000; letter-spacing: .5px; }
#hud .st-tabs { display: flex; gap: 7px; justify-content: center; margin-bottom: 8px; }
#hud .st-tab { border-style: solid; border-width: 7px 18px;
  border-image: url(${BASE}assets/ui/market/tab.png) 16 fill / 7px 18px stretch;
  color: #f6ecc8; font-weight: 700; font-size: 14px; cursor: pointer; min-width: 64px;
  text-shadow: 0 1px 1px rgba(0,0,0,.45); }
#hud .st-tab.sel { border-image-source: url(${BASE}assets/ui/market/tab_sel.png);
  color: #5a3a12; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
#hud .st-count { text-align: center; color: #5a3a12; font-weight: 700; font-size: 13px; margin-bottom: 6px; }
#hud .st-body { flex: 1 1 auto; overflow: auto; min-height: 0; }
#hud .st-grid { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; padding: 4px 2px; }
#hud .st-slot { width: 54px; height: 54px; flex: 0 0 auto;
  background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center; }
#hud .st-slot img { max-width: 42px; max-height: 42px; object-fit: contain; }
#hud .st-empty { text-align: center; color: #6e4a1e; font-style: italic; padding: 34px 12px; font-size: 15px; }
/* boost inventory rows (Storage -> Boosts) */
#hud .st-boostlist { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
#hud .st-boost { display: flex; align-items: center; gap: 10px; padding: 6px 8px;
  background: rgba(94,56,31,.14); border: 1px solid #b9945a; border-radius: 8px; }
#hud .st-boost img { width: 40px; height: 40px; image-rendering: pixelated; flex: 0 0 auto; }
#hud .st-boost-info { flex: 1 1 auto; min-width: 0; }
#hud .st-boost-info .nm { font-weight: 700; color: #4a2f14; font-size: 14px; }
#hud .st-boost-info .nm .ct { color: #7a5a2a; font-weight: 700; }
#hud .st-boost-info .ds { color: #6e4a1e; font-size: 11px; }
#hud .st-use { flex: 0 0 auto; border: none; cursor: pointer; color: #fff; font-weight: 700;
  font-size: 13px; padding: 6px 14px; border-radius: 8px; background: linear-gradient(#70a91e,#527d13);
  box-shadow: 0 1px 0 #3c5a10; }
#hud .st-use:disabled { background: #9a9a8a; cursor: default; box-shadow: none; opacity: .8; }
/* Received rewards grid (raid loot + quest items) */
#hud .rcv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px; padding: 4px 2px; }
#hud .rcv-card { display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px 4px 7px; background: rgba(94,56,31,.14); border: 1px solid #b9945a;
  border-radius: 10px; }
#hud .rcv-card.trophy { opacity: .9; }
#hud .rcv-por { width: 58px; height: 58px;
  background: url(${BASE}assets/ui/storage/storage_frame.png) center/100% 100% no-repeat;
  display: flex; align-items: center; justify-content: center; }
#hud .rcv-por img { max-width: 44px; max-height: 44px; object-fit: contain; image-rendering: pixelated; }
#hud .rcv-nm { font-size: 11px; font-weight: 700; color: #4a2f14; text-align: center;
  line-height: 1.15; max-width: 88px; }
#hud .rcv-act { padding: 4px 12px; font-size: 12px; }
#hud .rcv-trophy { font-size: 10px; font-weight: 800; color: #7a5a2a; letter-spacing: .5px;
  text-transform: uppercase; opacity: .8; }

/* ---- Plant/Zombie picker (slides in from the left on select+tilled) ---- */
#hud .pm-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 19; }
#hud .pm { position: fixed; left: 6px; top: 64px; bottom: 8px; width: 258px; box-sizing: border-box;
  border-style: solid; border-width: 32px 11px 12px 11px;
  border-image: url(${BASE}assets/ui/market/paper_market.png) 32 11 12 11 fill / 32px 11px 12px 11px stretch;
  display: flex; flex-direction: column; font-family: Georgia, "Times New Roman", serif;
  animation: pmslide .18s ease-out; }
@keyframes pmslide { from { transform: translateX(-112%); } to { transform: none; } }
#hud .pm-close { position: absolute; top: -14px; right: -14px; width: 40px; height: 40px;
  border: none; background: none; cursor: pointer; padding: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
#hud .pm-close img { width: 100%; height: 100%; }
#hud .pm-screens { display: flex; gap: 6px; justify-content: center; margin: 0 0 8px; }
#hud .pm-screen { border-style: solid; border-width: 6px 16px;
  border-image: url(${BASE}assets/ui/market/tab.png) 16 fill / 6px 16px stretch;
  color: #f6ecc8; font-weight: 700; font-size: 14px; cursor: pointer; min-width: 60px;
  text-shadow: 0 1px 1px rgba(0,0,0,.45); }
#hud .pm-screen.sel { border-image-source: url(${BASE}assets/ui/market/tab_sel.png);
  color: #5a3a12; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
#hud .pm-subtabs { display: flex; gap: 4px; justify-content: center; margin-bottom: 8px; }
#hud .pm-subtab { border-style: solid; border-width: 5px 11px;
  border-image: url(${BASE}assets/ui/market/subtab.png) 12 fill / 5px 11px stretch;
  color: #f6ecc8; font-weight: 700; font-size: 11px; cursor: pointer; letter-spacing: .3px;
  text-shadow: 0 1px 1px rgba(0,0,0,.4); }
#hud .pm-subtab.sel { border-image-source: url(${BASE}assets/ui/market/subtab_sel.png);
  color: #5a3a12; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
#hud .pm-list { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column;
  gap: 8px; padding: 2px; min-height: 0; }
#hud .pm-card { display: grid; grid-template-columns: 1fr auto;
  grid-template-rows: auto 1fr auto; grid-template-areas: "name right" "port right" "cost cost";
  gap: 2px 6px; background: #efe4bf; border: 2px solid #b98b4a; border-radius: 8px;
  padding: 6px 8px; cursor: pointer; box-shadow: inset 0 -3px 0 rgba(90,52,19,.12); }
#hud .pm-card:hover { background: #f7efcd; }
#hud .pm-card.locked { opacity: .55; filter: grayscale(.7); cursor: not-allowed; }
#hud .pm-card.locked:hover { background: #efe4bf; }
#hud .pm-card.locked .pm-cost { background: linear-gradient(#6a6a6a, #4a4a4a); }
#hud .pm-lock { display: flex; align-items: center; gap: 4px; }
#hud .pm-name { grid-area: name; font-weight: 700; font-size: 14px; color: #452c0c; }
#hud .pm-port { grid-area: port; display: flex; align-items: center; }
#hud .pm-port img { height: 46px; max-width: 76px; width: auto; object-fit: contain;
  image-rendering: auto; }
#hud .pm-right { grid-area: right; display: flex; flex-direction: column; justify-content: center;
  align-items: flex-end; gap: 5px; color: #452c0c; font-weight: 700; font-size: 13px; }
#hud .pm-right span { display: flex; align-items: center; gap: 3px; }
#hud .pm-right img { height: 15px; }
#hud .pm-cost { grid-area: cost; margin-top: 5px; display: flex; align-items: center;
  justify-content: center; gap: 3px; background: linear-gradient(#7a5220, #5e3d15);
  border-radius: 6px; color: #ffe9a8; font-weight: 700; font-size: 14px; padding: 3px 0;
  text-shadow: 0 1px 1px rgba(0,0,0,.5); }
#hud .pm-cost img { height: 16px; }

/* ========================================================================
   RESPONSIVE / TOUCH LAYOUT
   Driven by viewport width (so a small desktop window reflows too), with
   safe-area insets for notched phones. The 760px breakpoint matches
   COMPACT_MAX_WIDTH in platform.ts; <html data-platform> is also set there. */

/* Keep the corner chrome clear of the notch / home indicator. */
@supports (padding: env(safe-area-inset-top)) {
  #hud .topbar { top: calc(6px + env(safe-area-inset-top));
    left: calc(6px + env(safe-area-inset-left)); right: calc(6px + env(safe-area-inset-right)); }
  #hud .questcol { left: calc(8px + env(safe-area-inset-left)); }
  #hud .menucol { right: calc(8px + env(safe-area-inset-right)); }
  #hud .tools { bottom: calc(10px + env(safe-area-inset-bottom)); }
  #hud .fab { bottom: calc(12px + env(safe-area-inset-bottom));
    right: calc(14px + env(safe-area-inset-right)); }
  #hud .qtoggle { bottom: calc(10px + env(safe-area-inset-bottom));
    left: calc(10px + env(safe-area-inset-left)); }
}

/* Compact layout for touch devices (any width, so LANDSCAPE phones count) OR any
   narrow viewport (a small desktop window). Landscape phones are ~700-930px wide,
   above a pure width breakpoint, so the coarse-pointer clause is what catches them. */
@media (pointer: coarse), (max-width: 760px) {
  /* top bar: shrink chips + drop the name plate so currencies fit a phone. */
  #hud .topbar { gap: 5px; padding: 4px 6px; border-radius: 13px; }
  #hud .chip { font-size: 12px; border-width: 8px 10px; }
  #hud .chip img { height: 17px; }
  #hud .chip .xpbar { width: 42px; }
  #hud .nameplate { display: none; }
  #hud .gear { width: 40px; height: 40px; }

  /* right menu column: narrower pills. */
  #hud .menucol { gap: 6px; }
  #hud .mbtn { width: 118px; }
  #hud .mbtn .gbtn { font-size: 13px; }

  /* market: 3 roomy columns instead of 5 cramped ones. */
  #hud .mkt-grid { grid-template-columns: repeat(3, 1fr); grid-auto-rows: 116px; }
  #hud .mkt-title { font-size: 19px; width: 190px; height: 50px; top: -26px; }
  #hud .mkt-tabs { flex-wrap: wrap; }
  #hud .mkt-tab { font-size: 13px; border-width: 6px 13px; }

  /* zombie detail: stack the card above the stats instead of side-by-side. */
  #hud .zdetail { flex-direction: column; gap: 14px; }
  #hud .zcard { width: 100%; max-width: 220px; margin: 0 auto; }
  #hud .zright { min-width: 0; }
}

/* Narrow portrait phones: market down to 2 columns. */
@media (max-width: 430px) {
  #hud .mkt-grid { grid-template-columns: repeat(2, 1fr); }
}

/* ---- Tim Buckwheat guided tutorial ---- */
/* The layer that hosts Tim, the arrow, the blocker and the skip button. Sits
   above every panel (level-up/quest-complete are z-index 24). It is itself
   pointer-events:none; children opt in. */
#hud .tut-layer { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
/* Tutorial tools use the same compact selected-tool button as the normal collapsed
   HUD. Keep the active Multi/Plow/Insta-Grow icon at bottom-right without showing
   the full bottom bar; refreshTools() already keeps this icon and boost count live. */
#hud.tutorial .tools { display: none !important; }
#hud.tutorial .fab { display: block !important; }
#hud.tutorial .qtoggle { display: none !important; }
/* Full-screen tap blocker: only present while a step gates input. It swallows
   every DOM tap so nothing but the highlighted element is reachable. */
#hud.tutorial .tut-blocker { position: fixed; inset: 0; pointer-events: auto;
  background: transparent; }
/* The single element a gating step allows through: raised above the blocker with
   its own stacking context + a pulsing glow ring. */
#hud .tut-highlight { position: relative; z-index: 41 !important; pointer-events: auto !important;
  border-radius: 12px; box-shadow: 0 0 0 3px #ffe27a, 0 0 16px 4px rgba(255,210,80,.9);
  animation: tutGlow 1s ease-in-out infinite; }
@keyframes tutGlow { 0%,100% { box-shadow: 0 0 0 3px #ffe27a, 0 0 12px 3px rgba(255,210,80,.7); }
  50% { box-shadow: 0 0 0 4px #fff0a8, 0 0 22px 7px rgba(255,210,80,1); } }
/* Tim's slide-up popup: anchored at bottom-left. The right-side width reserve keeps
   even a wrapped speech bubble clear of the selected-tool button. */
#hud .tut-tim { position: fixed; left: max(12px, env(safe-area-inset-left)); bottom: 0;
  pointer-events: auto; display: flex; align-items: flex-end; gap: 10px;
  transform: translateY(110%); transition: transform .45s cubic-bezier(.2,.9,.25,1.1);
  max-width: calc(100vw - 100px); z-index: 42; }
#hud .tut-tim.in { transform: translateY(0); }
#hud .tut-tim-sprite { width: 150px; height: auto; flex: 0 0 auto;
  filter: drop-shadow(0 3px 6px rgba(0,0,0,.5)); pointer-events: none;
  transform: translateY(6px); }
#hud .tut-bubble { position: relative; margin-bottom: 40px; background: #fffdf3;
  color: #3a2410; border: 3px solid #7a4a1e; border-radius: 14px; padding: 14px 18px;
  font-weight: 700; font-size: 16px; line-height: 1.35; white-space: pre-line;
  box-shadow: 0 4px 12px rgba(0,0,0,.45); max-width: min(420px, 70vw); min-width: 0;
  cursor: pointer; }
/* Little tail pointing at Tim. */
#hud .tut-bubble::after { content: ""; position: absolute; left: -14px; bottom: 22px;
  border: 8px solid transparent; border-right-color: #7a4a1e; }
#hud .tut-hint { display: block; margin-top: 8px; font-size: 12px; font-weight: 700;
  color: #9a7038; opacity: .85; }
/* Pulsing arrow that points at the current target. */
#hud .tut-arrow { position: fixed; width: 27px; height: 27px; pointer-events: none;
  z-index: 41; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5));
  animation: tutBob 0.9s ease-in-out infinite; transform-origin: center; }
@keyframes tutBob { 0%,100% { translate: 0 0; } 50% { translate: 0 -10px; } }
@media (pointer: coarse), (max-width: 760px) {
  #hud .tut-tim-sprite { width: 104px; }
  #hud .tut-bubble { font-size: 14px; padding: 11px 14px; max-width: 66vw; }
}
`;

export class Hud {
  mode: Mode = "walk";
  onModeChange: (() => void) | null = null;
  // Rotate tool tap: main handles it contextually (flip the placement ghost / the
  // carried object / enter the standalone rotate mode). Null falls back to setMode.
  onRotateTool: (() => void) | null = null;
  private el: HTMLElement;
  private writerLock: HTMLElement | null = null;
  private writerBanner: HTMLElement | null = null;
  private writerTakeover: (() => Promise<boolean>) | null = null;
  private goldEl!: HTMLElement;
  private brainsEl!: HTMLElement;
  private zombiesEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private nameEl!: HTMLElement;
  private questCol!: HTMLElement;
  private questViews: QuestView[] = [];
  private questsShown = true;
  private tools: Record<string, HTMLButtonElement> = {};
  private menuCol!: HTMLElement;
  private toolsBar!: HTMLElement;
  private fab!: HTMLButtonElement;
  private fabImg!: HTMLImageElement;
  private fabCt?: HTMLElement; // count badge on the fab (Insta-Grow uses left)
  private collapsed = false;
  private plantCards: MenuCard[] = [];
  private zombieCards: MenuCard[] = [];
  private objectCards: ObjCard[] = [];
  private farmUpgrades: FarmSizeUpgrade[] = []; // Market Upgrade tab (Farm Size)
  private farmer: FarmerCatalog = { heads: [], bodies: [] };
  private pets: PetCatalog = { version: 0, pets: [] };
  private bossMenu: HTMLButtonElement | null = null;
  private plantingCrop: CropConfig | null = null;
  private placingObj: PlaceableDef | null = null;
  private plantLabel!: HTMLElement;

  get planting(): CropConfig | null {
    return this.plantingCrop;
  }
  get placing(): PlaceableDef | null {
    return this.placingObj;
  }

  constructor(private state: GameState, private audio: AudioManager) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    this.el = document.getElementById("hud")!;
    this.el.innerHTML = "";
    this.buildTopBar();
    this.buildQuests();
    this.buildMenu();
    this.buildTools();
    this.buildFab();
    this.buildPlantLabel();
    this.buildQuestToggle();
    this.wireMenuSounds();
    state.onChange(() => this.update());
    this.update();
    // Mobile (esp. landscape) has little room: start with the menu + tools tucked
    // into the corner fab and the quest rail hidden, so the default view is the
    // farm plus a compact top bar. Everything is one tap away (fab / quest button).
    // Desktop keeps the full chrome on screen.
    if (isMobile()) {
      this.collapse();
      this.questsShown = false;
      this.questCol.style.display = "none";
    }
  }

  // Centralized menu audio: every overlay opens with a whoosh and closes with a
  // click. Panels share a small set of backdrop / close-button classes, so a
  // MutationObserver (open) plus one delegated listener (close) cover them all
  // without touching each panel builder. Raid overlays are intentionally left
  // out (farm-only audio scope).
  private wireMenuSounds() {
    const BACKDROP = new Set(["panelbg", "mkt-bg", "st-bg", "pm-bg"]);
    const CLOSE = ".panelclose, .mkt-close, .st-close, .pm-close";
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement && [...n.classList].some((c) => BACKDROP.has(c))) {
            this.audio.play("menuOpen");
            return;
          }
        }
      }
    });
    mo.observe(this.el, { childList: true });
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      // X button (or its inner <img>), or a click on the backdrop itself.
      if (t.closest(CLOSE) || [...t.classList].some((c) => BACKDROP.has(c)))
        this.audio.play("menuClose");
    });
  }

  private chip(icon: string): [HTMLElement, HTMLElement] {
    const c = document.createElement("div");
    c.className = "chip";
    const img = document.createElement("img");
    img.src = UI(icon);
    const val = document.createElement("span");
    c.append(img, val);
    return [c, val];
  }

  private buildTopBar() {
    const bar = document.createElement("div");
    bar.className = "topbar";
    const gear = document.createElement("button");
    gear.className = "gear";
    const gimg = document.createElement("img");
    gimg.src = UI("menu_settings_icon.png");
    gear.appendChild(gimg);
    gear.onclick = () => this.openSettings();

    const chips = document.createElement("div");
    chips.className = "chips";
    const [g, gv] = this.chip("topbar_money_icon.png");
    const [b, bv] = this.chip("topbar_brain_icon.png");
    const [z, zv] = this.chip("topbar_zombie_icon.png");
    this.goldEl = gv;
    this.brainsEl = bv;
    this.zombiesEl = zv;
    const lv = document.createElement("div");
    lv.className = "chip";
    const star = document.createElement("img");
    star.src = UI("topbar_level_icon.png");
    star.style.height = "18px";
    this.levelEl = document.createElement("span");
    const track = document.createElement("div");
    track.className = "xpbar";
    this.xpFill = document.createElement("div");
    this.xpFill.className = "xpfill";
    track.appendChild(this.xpFill);
    lv.append(star, this.levelEl, track);
    chips.append(g, b, z, lv);

    const spacer = document.createElement("div");
    spacer.className = "spacer";
    // Invisible developer hotspot: a transparent button tucked just to the left of
    // the nameplate. Clicking it opens the (otherwise hidden) Developer menu.
    // DEV BUILDS ONLY: `import.meta.env.DEV` is statically false in production, so
    // Vite tree-shakes this branch (and the openDevMenu it references) out of the
    // shipped bundle. The dev menu is a convenience, never a security boundary —
    // gameplay authority is being moved server-side — but it must not ship.
    const devHot = import.meta.env.DEV ? document.createElement("button") : null;
    if (devHot) {
      devHot.className = "devhot";
      devHot.title = ""; // stays invisible / unlabelled
      devHot.onclick = () => this.openDevMenu();
    }
    const name = document.createElement("div");
    name.className = "nameplate";
    name.textContent = "Zombie Farmer";
    name.title = "Account";
    name.setAttribute("role", "button");
    // Clicking your name opens the Account menu (who you're signed in as + Sign
    // out). Profile SWITCHING is intentionally not exposed here for now (see
    // openProfiles) — the friend code / add / gift / visit all live in Friends.
    name.onclick = () => this.openProfiles();
    this.nameEl = name;

    // Account button: a person icon just right of the nameplate. Opens the same
    // Account menu; stays visible on mobile (where the nameplate is hidden), so
    // Sign out is reachable on every platform.
    const prof = document.createElement("button");
    prof.className = "profbtn";
    prof.title = "Account";
    prof.setAttribute("aria-label", "Account");
    const profImg = document.createElement("img");
    profImg.src = UI("Icon_Quest_Social.png");
    prof.appendChild(profImg);
    prof.onclick = () => this.openProfiles();

    bar.append(gear, chips, spacer, ...(devHot ? [devHot] : []), name, prof);
    this.el.appendChild(bar);
    this.refreshName();
  }

  private buildQuests() {
    this.questCol = document.createElement("div");
    this.questCol.className = "questcol";
    this.el.appendChild(this.questCol);
    this.renderQuests();
  }

  // Push the current active quests into the left rail. Called by the QuestSystem
  // whenever progress changes; actionable quests are sorted first upstream.
  setQuests(views: QuestView[]) {
    this.questViews = views;
    this.renderQuests();
  }

  // The rail shows only the first RAIL_MAX active quests; the rest live in the quest
  // log (opened by the expand button). Activation itself is uncapped upstream.
  private static readonly RAIL_MAX = 4;

  private questCard(q: QuestView): HTMLButtonElement {
    const card = document.createElement("button");
    card.className = "quest";
    const done = q.objectives.filter((o) => o.done).length;
    card.title = `${q.title} (${done}/${q.objectives.length})`; // hover summary
    const img = document.createElement("img");
    img.src = UI(q.icon);
    img.onerror = () => { img.style.visibility = "hidden"; }; // tolerate missing art
    card.appendChild(img);
    // Progress badge: completed objectives out of total.
    const badge = document.createElement("span");
    badge.className = "qbadge";
    badge.textContent = `${done}/${q.objectives.length}`;
    card.appendChild(badge);
    card.onclick = () => this.openQuestDetail(q);
    return card;
  }

  private renderQuests() {
    if (!this.questCol) return;
    this.questCol.replaceChildren();
    for (const q of this.questViews.slice(0, Hud.RAIL_MAX)) {
      this.questCol.appendChild(this.questCard(q));
    }
    // Expand button → full quest log (all active quests). Shown whenever there are
    // any quests; its badge is the total active count.
    if (this.questViews.length) {
      const more = document.createElement("button");
      more.className = "quest qmore";
      more.title = "View all quests";
      more.innerHTML = `<span class="qmore-glyph">☰</span>`;
      const badge = document.createElement("span");
      badge.className = "qbadge";
      badge.textContent = String(this.questViews.length);
      more.appendChild(badge);
      more.onclick = () => this.openQuestLog();
      this.questCol.appendChild(more);
    }
  }

  // Full quest screen: every active quest as a card with its objectives, scrollable.
  private openQuestLog() {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel questlog";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = `Quests (${this.questViews.length})`;
    const list = document.createElement("div");
    list.className = "qlog-list";
    if (!this.questViews.length) {
      const empty = document.createElement("div");
      empty.className = "qlog-empty";
      empty.textContent = "No active quests right now.";
      list.appendChild(empty);
    }
    for (const q of this.questViews) {
      const done = q.objectives.filter((o) => o.done).length;
      const item = document.createElement("div");
      item.className = "qlog-item";
      const img = document.createElement("img");
      img.src = UI(q.icon);
      img.onerror = () => { img.style.visibility = "hidden"; };
      const body = document.createElement("div");
      body.className = "qlog-body";
      const title = document.createElement("div");
      title.className = "qlog-title";
      title.innerHTML = `<span>${q.title}</span><span class="qlog-prog">${done}/${q.objectives.length}</span>`;
      body.appendChild(title);
      for (const o of q.objectives) {
        const row = document.createElement("div");
        row.className = "qlog-obj" + (o.done ? " done" : "");
        row.textContent = `${o.done ? "✔" : "○"} ${o.text}  (${Math.min(o.count, o.total)}/${o.total})`;
        body.appendChild(row);
      }
      item.append(img, body);
      list.appendChild(item);
    }
    panel.append(x, h, list);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // A quest's detail popup: title, tip, and each objective with its live count.
  private openQuestDetail(q: QuestView) {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel qdetail";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = q.title;
    panel.append(x, h);
    for (const o of q.objectives) {
      const row = document.createElement("div");
      row.className = "qobj" + (o.done ? " done" : "");
      const mark = o.done ? "✔" : "○";
      row.textContent = `${mark} ${o.text}  (${Math.min(o.count, o.total)}/${o.total})`;
      panel.appendChild(row);
    }
    if (q.tip) {
      const tip = document.createElement("p");
      tip.className = "qtip";
      tip.textContent = q.tip;
      panel.appendChild(tip);
    }
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Brief top-center banner for quest completion (messageComplete).
  showToast(msg: string) {
    const t = document.createElement("div");
    t.className = "qtoast";
    t.textContent = msg;
    this.el.appendChild(t);
    window.setTimeout(() => t.classList.add("show"), 10);
    window.setTimeout(() => {
      t.classList.remove("show");
      window.setTimeout(() => t.remove(), 400);
    }, 2600);
  }

  // Turn `el` (holding a friend code) into a click-to-copy control. Clicking
  // highlights the text (the HUD disables selection globally, so the `copyable`
  // class re-enables it here) and copies it to the clipboard, with a brief toast.
  // Falls back to just highlighting if the clipboard API is unavailable/blocked.
  private makeCopyable(el: HTMLElement, text: string) {
    el.classList.add("copyable");
    el.title = "Click to copy";
    el.onclick = async () => {
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      try {
        await navigator.clipboard.writeText(text);
        this.showToast("Friend code copied! 📋");
      } catch {
        this.showToast("Highlighted — press Ctrl+C to copy");
      }
    };
  }

  // Each button is a colored frame around a grey glossy button (dark label).
  private buildMenu() {
    const items = [
      { label: "Invade", fill: "#9c2135", light: "#c04155", dark: "#5a0f1c", ready: true },
      { label: "Boss", fill: "#6c318f", light: "#9c58bc", dark: "#3e1659" },
      { label: "Zombies", fill: "#55972a", light: "#79c247", dark: "#2f5f10" },
      { label: "Boosts", fill: "#7a4bc9", light: "#9c74e0", dark: "#432379" },
      { label: "Storage", fill: "#2f74bb", light: "#4f9bd8", dark: "#143f66" },
      { label: "Market", fill: "#c9992e", light: "#e3bb52", dark: "#8a6512" },
      { label: "Friends", fill: "#2f9c8a", light: "#4fd0b8", dark: "#12564b" },
    ];
    const col = document.createElement("div");
    col.className = "menucol";
    this.menuCol = col;
    for (const m of items) {
      const btn = document.createElement("button");
      btn.className = "mbtn";
      btn.dataset.menu = m.label; // stable anchor for the tutorial arrow (menuButton())
      if (m.label === "Boss") { btn.style.display = "none"; this.bossMenu = btn; }
      btn.style.background = `linear-gradient(${m.light}, ${m.fill})`;
      btn.style.borderColor = m.dark;
      if (m.ready) {
        const r = document.createElement("span");
        r.className = "ready";
        r.textContent = "Ready";
        btn.appendChild(r);
      }
      const g = document.createElement("span");
      g.className = "gbtn";
      g.textContent = m.label === "Boosts" ? "⚡ Boosts" : m.label;
      btn.appendChild(g);
      btn.onclick = () =>
        m.label === "Market"
          ? this.openMarket()
          : m.label === "Storage"
            ? this.openStorage()
            : m.label === "Boosts"
              ? this.openStorage("Boosts") // the boost inventory (Storage's Boosts tab)
              : m.label === "Zombies"
                ? this.openZombieList()
                : m.label === "Invade"
                  ? this.openRaids()
                  : m.label === "Boss"
                    ? this.openMarket("Epic Boss")
                  : m.label === "Friends"
                    ? this.openFriends()
                    : this.openPanel(m.label, "Coming soon.");
      col.appendChild(btn);
    }
    this.el.appendChild(col);
  }

  /** Game-styled confirmation. Native browser confirm/prompt dialogs are never used. */
  confirmInGame(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
    document.querySelector("#hud .game-confirm-bg")?.remove();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        bg.remove();
        resolve(value);
      };
      const bg = document.createElement("div");
      bg.className = "panelbg game-confirm-bg";
      const panel = document.createElement("div");
      panel.className = "panel confirm-panel";
      const close = document.createElement("button");
      close.className = "panelclose";
      close.innerHTML = `<img src="${UI("button_close.png")}">`;
      close.onclick = () => finish(false);
      const heading = document.createElement("h2");
      heading.textContent = title;
      const copy = document.createElement("p");
      copy.className = "confirm-msg";
      copy.textContent = message;
      const buttons = document.createElement("div");
      buttons.className = "zbtns";
      const cancel = document.createElement("button");
      cancel.className = "zbtn locate";
      cancel.textContent = "Cancel";
      cancel.onclick = () => finish(false);
      const accept = document.createElement("button");
      accept.className = "zbtn sell";
      accept.textContent = confirmLabel;
      accept.onclick = () => finish(true);
      buttons.append(cancel, accept);
      panel.append(close, heading, copy, buttons);
      bg.appendChild(panel);
      bg.onclick = (event) => { if (event.target === bg) finish(false); };
      this.el.appendChild(bg);
    });
  }

  showWriterLock(onTakeover: () => Promise<boolean>): void {
    this.writerTakeover = onTakeover;
    this.writerLock?.remove();
    this.writerBanner?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg writer-lock-bg";
    const panel = document.createElement("div");
    panel.className = "panel writer-lock-panel";
    const heading = document.createElement("h2");
    heading.textContent = "Farm active elsewhere";
    const copy = document.createElement("p");
    copy.textContent = "This farm is controlled by another browser or device. You can view it here, or take over and make this the active game.";
    const buttons = document.createElement("div");
    buttons.className = "zbtns";
    const view = document.createElement("button");
    view.className = "zbtn locate";
    view.textContent = "View only";
    view.onclick = () => {
      bg.remove();
      this.writerLock = null;
      const banner = document.createElement("button");
      banner.className = "writer-lock-banner";
      banner.textContent = "Read-only — tap to take control";
      banner.onclick = () => this.writerTakeover && this.showWriterLock(this.writerTakeover);
      this.el.appendChild(banner);
      this.writerBanner = banner;
    };
    const take = document.createElement("button");
    take.className = "zbtn sell";
    take.textContent = "Take over here";
    take.onclick = async () => {
      take.disabled = true;
      take.textContent = "Taking over…";
      const ok = await onTakeover();
      if (!ok) {
        take.disabled = false;
        take.textContent = "Try again";
      }
    };
    buttons.append(view, take);
    panel.append(heading, copy, buttons);
    bg.appendChild(panel);
    this.el.appendChild(bg);
    this.writerLock = bg;
  }

  hideWriterLock(): void {
    this.writerLock?.remove();
    this.writerBanner?.remove();
    this.writerLock = null;
    this.writerBanner = null;
    this.writerTakeover = null;
  }

  setBossShortcut(active: boolean, label = "Boss") {
    if (!this.bossMenu) return;
    this.bossMenu.style.display = active ? "" : "none";
    const text = this.bossMenu.querySelector<HTMLElement>(".gbtn");
    if (text) text.textContent = label;
  }

  private toolBtn(id: string, icon: string, label: string, onClick: () => void) {
    const btn = document.createElement("button");
    btn.className = "tool";
    const img = document.createElement("img");
    img.src = UI(icon);
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = label;
    btn.append(img, lbl);
    btn.onclick = () => { this.audio.play("menuClick"); onClick(); };
    this.tools[id] = btn;
    return btn;
  }

  private buildTools() {
    const bar = document.createElement("div");
    bar.className = "tools";
    this.toolsBar = bar;
    bar.append(
      this.toolBtn("select", "button_multitool.png", "Select", () => this.setMode("walk")),
      this.toolBtn("move", "button_move.png", "Move", () => this.setMode("move")),
      this.toolBtn("rotate", "button_rotate.png", "Rotate", () =>
        this.onRotateTool ? this.onRotateTool() : this.setMode("rotate")),
      this.toolBtn("till", "button_plow.png", "Plow", () => this.setMode("till")),
      this.toolBtn("remove", "button_sell.png", "Remove", () => this.setMode("remove"))
    );
    this.el.appendChild(bar);
    this.refreshTools();
  }

  // While a time-taking boost tool (Insta-Grow) is equipped, the collapsed fab
  // shows that boost's remaining-uses badge; every other mode hides it. Called on
  // mode changes (refreshTools) and state changes (update) so the count stays live.
  private refreshBoostBadge() {
    if (!this.fabCt) return;
    const b = this.mode === "instagrow" ? (this.getSpeedGrowBoost?.() ?? null) : null;
    if (!b) { this.fabCt.style.display = "none"; return; }
    this.fabCt.textContent = `${b.count()}x`;
    this.fabCt.style.display = "flex";
  }

  private refreshTools() {
    for (const [id, btn] of Object.entries(this.tools)) {
      const active = (id === "select" && this.mode === "walk") || id === this.mode;
      btn.classList.toggle("sel", active);
    }
    if (this.fabImg) this.fabImg.src = this.fabIconSrc();
    this.refreshBoostBadge();
  }

  // Icon that represents the currently-active tool (shown on the collapsed fab).
  private toolIcon(m: Mode): string {
    return m === "till" ? "button_plow.png"
      : m === "plant" ? "button_plant.png"
      : m === "remove" ? "button_sell.png"
      : m === "rotate" ? "button_rotate.png"
      : m === "move" || m === "place" ? "button_move.png"
      : "button_multitool.png";
  }

  // Full src for the fab icon. Insta-Grow uses the boost's own art (already a full
  // path); every other tool uses a UI-atlas button icon.
  private fabIconSrc(): string {
    if (this.mode === "instagrow") {
      const b = this.getSpeedGrowBoost?.();
      if (b) return b.icon;
    }
    return UI(this.toolIcon(this.mode));
  }

  // Collapsed-HUD button in the bottom-right: tap to bring the bars back.
  private buildFab() {
    const b = document.createElement("button");
    b.className = "fab";
    const img = document.createElement("img");
    img.src = this.fabIconSrc();
    const ct = document.createElement("span");
    ct.className = "fab-ct";
    b.append(img, ct);
    b.onclick = () => this.expand();
    this.fab = b;
    this.fabImg = img;
    this.fabCt = ct;
    this.el.appendChild(b);
  }

  // Hide the right menu + bottom tools into the single bottom-right fab.
  collapse() {
    if (this.collapsed) return;
    this.collapsed = true;
    this.menuCol.style.display = "none";
    this.toolsBar.style.display = "none";
    this.fabImg.src = this.fabIconSrc();
    this.refreshBoostBadge(); // sync the fab's uses badge for the current mode
    this.fab.style.display = "block";
  }

  expand() {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.menuCol.style.display = "flex";
    this.toolsBar.style.display = "flex";
    this.fab.style.display = "none";
  }

  // Catalog for the plant/zombie picker (built by main from the market data).
  setCatalog(plants: MenuCard[], zombies: MenuCard[]) {
    // Permanent crops form the first unlock ladder; holiday crops form a second
    // ladder at the end. Stable ties retain authored order.
    this.plantCards = [...plants].sort(compareCropMarketOrder);
    this.zombieCards = [...zombies].sort((a, b) => a.level - b.level);
  }

  // Catalog for the object buy menu (trees / decor).
  setPlaceables(objects: ObjCard[]) {
    this.objectCards = objects;
  }

  // Farm Size upgrade catalog (Market Upgrade tab).
  setUpgrades(mapSize: FarmSizeUpgrade[]) {
    this.farmUpgrades = [...mapSize].sort((a, b) => a.size - b.size);
  }

  // Ground/climate skin catalog (Market Upgrade → Ground).
  private climates: ClimateUpgrade[] = [];
  setClimates(climate: ClimateUpgrade[]) {
    this.climates = [...climate];
  }
  /** The farm's currently-applied ground terrain key (e.g. "grass"). */
  getClimate: (() => string) | null = null;
  /** Whether a ground skin (by terrain key) has already been purchased. */
  ownsClimate: ((terrain: string) => boolean) | null = null;
  /** Buy a ground skin (charges gold, applies it). Returns true if it went through. */
  onBuyClimate: ((c: ClimateUpgrade) => boolean | Promise<boolean>) | null = null;
  /** Re-apply an already-owned ground skin for free. */
  onApplyClimate: ((c: ClimateUpgrade) => void) | null = null;

  // Consumable-boost catalog (Market Boosts tab + Storage Boosts inventory).
  private boosts: BoostDef[] = [];
  setBoosts(boosts: BoostDef[]) {
    this.boosts = boosts;
  }
  setFarmerCatalog(catalog: FarmerCatalog) { this.farmer = catalog; }
  setPetCatalog(catalog: PetCatalog) { this.pets = catalog; }
  onBuyFarmerHead: ((head: FarmerHeadDef) => boolean) | null = null;
  onEquipFarmerHead: ((head: FarmerHeadDef) => void) | null = null;
  onEquipFarmerBody: ((body: FarmerBodyDef) => void) | null = null;
  onBuyPet: ((pet: PetDef) => boolean) | null = null;
  onEquipPet: ((pet: PetDef | null) => void) | null = null;
  onSetPenPets: ((pets: PetDef[]) => void) | null = null;
  // Buy a boost into inventory (returns true if paid); use one from inventory.
  onBuyBoost: ((def: BoostDef) => boolean) | null = null;
  onUseBoost: ((def: BoostDef) => void) | null = null;

  // Entering placement mode for a bought object (set by main).
  onBuy: ((def: PlaceableDef) => void) | null = null;
  // Storage slots of the currently-placed shed (0 = none). Drives which single
  // shed the Market offers: only the NEXT upgrade above the current tier.
  getShedSlots: (() => number) | null = null;
  /** Whether a colored grave is placed (gates planting that zombie class). */
  hasGrave: ((color: "Blue" | "Red" | "Silver") => boolean) | null = null;
  /** Whether a gift voucher has hit its "1 per farm" limit — you already own that
   *  zombie, or hold an (unused) voucher for it (set by main; spans both Cupid
   *  vouchers, which grant the same zombie). Keyed by the boost key. */
  giftLimitReached: ((boostKey: string) => boolean) | null = null;

  // ---- Market Upgrade tab: Farm Size (set by main) ----
  /** The farm's current NxN dimension (drives owned/next/locked card states). */
  getMapSize: (() => number) | null = null;
  /** Buy the farm-size expansion to `size`, paying in the given currency. Returns
   *  true if the purchase went through (charged + field grown); false if gated
   *  (level/funds/out of order). Buying either currency's card grows the farm, which
   *  makes BOTH currency cards for that tier read as owned. */
  onBuyUpgrade: ((size: number, currency: "gold" | "brains") => boolean | Promise<boolean>) | null = null;

  // ---- zombie management + storage hooks (set by main) ----
  /** The current owned-zombie roster (deployed + stored). */
  getRoster: (() => RosterEntry[]) | null = null;
  /** Portrait image URL for a zombie type key (per-type composite). */
  zombiePortraitOf: ((key: string) => string) | null = null;
  /** Take a deployed zombie off the farm (into the Mausoleum). */
  onZombieStore: ((id: string) => void | Promise<void>) | null = null;
  /** Put a stored zombie back on the farm. */
  onZombieDeploy: ((id: string) => void | Promise<void>) | null = null;
  /** Whether a Mausoleum exists to store zombies in (gates the Store action). */
  canStoreZombies: (() => boolean) | null = null;
  /** Mausoleum storage-slot capacity (shown as fixed slots; default 15). */
  mausoleumCap = 15;
  /** Whether the farm has a free army slot (gates the Deploy action). */
  canDeployZombie: (() => boolean) | null = null;
  /** Select a deployed zombie and center the camera on it. */
  onZombieLocate: ((id: string) => void) | null = null;
  /** Permanently sell an owned zombie for gold (after confirmation). */
  onZombieSell: ((id: string) => void | Promise<void>) | null = null;
  /** Base market cost of a zombie type by key — drives the sell payout shown on
   *  the detail card (sell = floor(baseCost/2), binary ground truth). */
  zombieBaseCost: ((key: string) => number) | null = null;
  /** The speed-grow (Insta-Grow) boost + a live owned-count getter, for the
   *  growing-crop info window. Null when no grow boost exists in the catalog. */
  getSpeedGrowBoost: (() => { name: string; icon: string; count: () => number } | null) | null = null;
  /** Take a stored item back out of the shed to place it (free). */
  onRetrieveItem: ((key: string) => void) | null = null;

  // ---- Received rewards (raid loot / quest items) hooks (set by main) ----
  /** Resolve the current Received bucket into displayable reward cards. */
  getReceived: (() => ReceivedView[]) | null = null;
  /** Claim a boost/currency reward at `index` (adds it to inventory/currency). */
  onClaimReceived: ((index: number) => void) | null = null;
  /** Place a decoration reward at `index` on the farm (enters placement mode). */
  onPlaceReceived: ((index: number) => void) | null = null;

  // ---- Zombie Pot (combiner) hooks (set by main) ----
  /** Current combine status for the combiner panel. */
  getPotStatus:
    | (() => {
        busy: boolean;
        ready: boolean;
        remainingMs: number;
        totalMs: number;
        monolith: boolean;
        pending: { keyA: string; keyB: string; maskA: number; maskB: number } | null;
      })
    | null = null;
  /** Start combining two owned zombies by id. */
  onCombine: ((idA: string, idB: string) => boolean | Promise<boolean>) | null = null;
  /** Reward-only actors cannot be consumed or cloned by the Zombie Pot. */
  canCombineZombie: ((key: string) => boolean) | null = null;
  /** Collect a finished combine; returns the new zombie's name (or null). */
  onCollectCombine: (() => string | null | Promise<string | null>) | null = null;

  // ---- raid hooks (set by main) ----
  /** All invasions as cards (unlock/lock state resolved against player level). */
  getRaidCards: (() => RaidCardView[]) | null = null;
  /** Eligible army + default selection for the Army screen. */
  getRaidParty: (() => RaidPartyView) | null = null;
  /** Live cooldown (ms left, 0 = ready) + Invasion Voucher count. */
  getRaidStatus: (() => { cooldownMs: number; voucherCount: number }) | null = null;
  /** Battle-consumable stock for a raid: owned Concentration + Golden Dice, and the
   *  most dice worth spending on this raid (its rare-tier depth). */
  getRaidBoosts: ((raidId: number) => { concentration: number; dice: number; maxDice: number }) | null = null;
  /** Launch the live battle scene for the chosen party. Returns true if it took over
   *  (it will show the result itself on finish); false means it declined (cooldown /
   *  a raid already running). There is no instant/auto-resolve fallback. `opts` carries
   *  the voucher/concentration/dice choices. */
  onLaunchRaid: ((raidId: number, partyIds: string[], opts: RaidLaunchOpts) => boolean | Promise<boolean>) | null = null;
  // ---- limited Epic Boss hooks ----
  getEpicBossView: (() => EpicBossMarketView[]) | null = null;
  onActivateEpicBoss: ((bossId: string) => boolean | Promise<boolean>) | null = null;
  onEndEpicBoss: (() => boolean | Promise<boolean>) | null = null;
  onLaunchEpicBoss: ((partyIds: string[], payment: EpicBossPayment) => boolean | Promise<boolean>) | null = null;

  // ---- save profiles (set by main) ----
  /** Current profile index (active id + all profiles). */
  getProfiles: (() => ProfileIndex) | null = null;
  /** Switch to a profile: flush the current game, point the index, reload. */
  onSwitchProfile: ((id: string) => void) | null = null;
  /** Create a new (fresh-game) profile and switch to it. */
  onCreateProfile: ((name: string) => void) | null = null;
  /** Rename a profile in place (no reload). */
  onRenameProfile: ((id: string, name: string) => void) | null = null;
  /** Delete a non-active profile and its save (no reload). */
  onDeleteProfile: ((id: string) => void) | null = null;
  // ---- friends (offline stub; set by main) ----
  /** The current friends list. */
  getFriends: (() => Friend[]) | null = null;
  /** Add a local friend by name (no reload). */
  onAddFriend: ((name: string) => void) | null = null;
  /** Remove a friend by id (no reload). */
  onRemoveFriend: ((id: string) => void | Promise<void>) | null = null;
  /** Gift one brain to a friend. Returns true if the gift was sent (false if
   *  gated — e.g. once the daily limit lands). */
  onGiftBrain: ((id: string) => boolean) | null = null;

  // ---- online social layer (set by main; all null = offline-only) ----
  /** Whether a game server is configured at all (enables the sign-in UI). */
  onlineAvailable: (() => boolean) | null = null;
  /** Whether the player is signed in to the server (online friends + gifts). */
  socialOnline: (() => boolean) | null = null;
  /** The signed-in player's name + shareable friend code (null when signed out). */
  myAccount: (() => { name: string; friendCode: string } | null) | null = null;
  /** Render Google's sign-in button into the given element. */
  renderAuthButton: ((el: HTMLElement) => void) | null = null;
  /** Sign out (flushes + reloads into offline mode). */
  onSignOut: (() => void) | null = null;
  /** Change the signed-in player's display name. Resolves to an error code, or null. */
  onSetUsername: ((name: string) => Promise<string | null>) | null = null;
  /** Pull the latest friends list from the server into the cache. */
  refreshFriends: (() => Promise<void>) | null = null;
  /** Add a friend by their shared code. Resolves to an error code, or null on success. */
  onAddFriendCode: ((code: string) => Promise<string | null>) | null = null;
  /** Send a brain via the server. Resolves to an error code, or null on success. */
  onGiftBrainOnline: ((friendId: string) => Promise<string | null>) | null = null;
  /** Open a read-only view of this friend's farm (by account id + display name). */
  onVisitFriend: ((friendId: string, name: string) => void) | null = null;
  /** Pull the gift inbox from the server into the cache. */
  refreshInbox: (() => Promise<void>) | null = null;
  /** Cached unclaimed gifts addressed to me. */
  getInbox: (() => { id: string; fromName: string }[]) | null = null;
  /** Claim a gift (credits a brain server-side). */
  onClaimGift: ((id: string) => Promise<void>) | null = null;
  /** Pull pending incoming friend requests into the cache. */
  refreshRequests: (() => Promise<void>) | null = null;
  /** Cached pending incoming friend requests (people asking to befriend me). */
  getRequests: (() => { fromAccountId: string; name: string }[]) | null = null;
  /** Accept a pending request. Resolves to an error code, or null on success. */
  onAcceptRequest: ((fromAccountId: string) => Promise<string | null>) | null = null;
  /** Reject / withdraw a pending request. */
  onRejectRequest: ((accountId: string) => Promise<void>) | null = null;
  /** Block an account (tears down any edge + request). */
  onBlockFriend: ((accountId: string) => Promise<void>) | null = null;
  /** Rotate my friend code. Resolves to the new code, or null on failure. */
  onRotateCode: (() => Promise<string | null>) | null = null;
  /** List this account's live devices/sessions for the Account menu. */
  onListSessions:
    | (() => Promise<{ id: string; label: string | null; lastUsedAt: number; current: boolean }[]>)
    | null = null;
  /** Revoke one other device by id. Resolves true on success. */
  onRevokeSession: ((id: string) => Promise<boolean>) | null = null;

  /** Current night-lighting state (set by main; null = feature absent). */
  getNight: (() => boolean) | null = null;
  /** Toggle the night lighting layer (dev-only). */
  onSetNight: ((on: boolean) => void) | null = null;

  /** Current farm-background (foliage density) choice. */
  getFarmBackground: (() => FarmBackground) | null = null;
  /** Change the farm background — rebuilds the foliage ring live. */
  onSetFarmBackground: ((bg: FarmBackground) => void) | null = null;

  /** Hide/show the farm chrome (top bar, tools, menus) so the live battle scene
   *  can take over the screen. Raid panels stay visible. */
  setRaiding(on: boolean) {
    this.el.classList.toggle("raiding", on);
  }

  // ---- Tim Buckwheat guided tutorial seams (used by TutorialController) ----
  /** Mount the tutorial's DOM layer into the HUD (above all panels). */
  mountTutorial(el: HTMLElement) {
    this.el.appendChild(el);
  }
  /** Toggle the input-gating `.tutorial` class on #hud (enables the tap blocker). */
  setTutorialGating(on: boolean) {
    this.el.classList.toggle("tutorial", on);
  }
  /** Resolve a right-menu button by its label (Invade/Zombies/Boosts/Storage/
   *  Market/Friends) so the tutorial arrow can anchor to it. */
  menuButton(label: string): HTMLElement | null {
    return this.menuCol?.querySelector<HTMLElement>(`[data-menu="${label}"]`) ?? null;
  }
  /** Whether the mobile FAB currently hides the menu column (arrow needs expand). */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  // Enter/leave the read-only "visiting a friend's farm" view. Hides all
  // farm-editing chrome (via the .visiting class) and shows a banner naming whose
  // farm this is with an Exit button (onExit returns to the player's own farm).
  setVisiting(on: boolean, name?: string, onExit?: () => void) {
    this.el.classList.toggle("visiting", on);
    this.el.querySelector(".visit-banner")?.remove();
    if (!on) return;
    const banner = document.createElement("div");
    banner.className = "visit-banner";
    const eye = document.createElement("span");
    eye.className = "vb-eye";
    eye.textContent = "👁 Visiting";
    const who = document.createElement("span");
    who.className = "vb-name";
    who.textContent = name ? `${name}'s farm` : "a friend's farm";
    const exit = document.createElement("button");
    exit.className = "vb-exit";
    exit.textContent = "Exit";
    exit.onclick = () => onExit?.();
    banner.append(eye, who, exit);
    this.el.appendChild(banner);
  }

  // The Market: authentic parchment panel with category tabs + real cards.
  // Picking a crop/zombie enters planting mode; picking an object enters
  // placement mode. Cards show cost, sell value, level locks, and affordability.
  closeMarket() {
    document.querySelector("#hud .mkt-bg")?.remove();
  }

  openMarket(initialTab: string = "Crops") {
    this.closeMarket();
    const bg = document.createElement("div");
    bg.className = "mkt-bg";
    const mkt = document.createElement("div");
    mkt.className = "mkt";

    const title = document.createElement("div");
    title.className = "mkt-title";
    title.textContent = "Market";

    const close = document.createElement("button");
    close.className = "mkt-close";
    const ci = document.createElement("img");
    ci.src = UI("button_close.png");
    close.appendChild(ci);
    close.onclick = () => bg.remove();

    const cur = document.createElement("div");
    cur.className = "mkt-cur";
    cur.innerHTML =
      `<span><img src="${UI("topbar_money_icon.png")}">${this.state.gold}</span>` +
      `<span><img src="${UI("topbar_brain_icon.png")}">${this.state.brains}</span>`;

    const tabsEl = document.createElement("div");
    tabsEl.className = "mkt-tabs";
    const subsEl = document.createElement("div");
    subsEl.className = "mkt-subtabs";

    // Search row: filters the current tab/sub's cards by name (esp. the big decor
    // list). Hidden on tabs with a bespoke layout.
    const searchRow = document.createElement("div");
    searchRow.className = "mkt-search-row";
    const searchInput = document.createElement("input");
    searchInput.className = "mkt-search";
    searchInput.type = "search";
    searchInput.placeholder = "Search…";
    searchInput.setAttribute("aria-label", "Search the market");
    searchRow.appendChild(searchInput);

    const grid = document.createElement("div");
    grid.className = "mkt-grid";

    // Pager: pages the grid so a category never needs a long scroll. Reuses the
    // market's own arrow art (the right arrow is mirrored for "previous").
    let search = "";
    let page = 0;
    const pager = document.createElement("div");
    pager.className = "mkt-pager";
    const prevBtn = document.createElement("button");
    prevBtn.className = "mkt-page-arrow left";
    prevBtn.innerHTML = `<img src="${UI("market/arrow_right.png")}" alt="Previous">`;
    const nextBtn = document.createElement("button");
    nextBtn.className = "mkt-page-arrow";
    nextBtn.innerHTML = `<img src="${UI("market/arrow_right.png")}" alt="Next">`;
    const pageInfo = document.createElement("span");
    pageInfo.className = "mkt-pageinfo";
    pager.append(prevBtn, pageInfo, nextBtn);

    const SUBTABS: Record<string, string[]> = {
      Crops: ["Plants", "Zombies"],
      Items: ["Functional", "Decors", "Fruit Trees"],
      Upgrade: ["Farm Size", "Ground"],
      Boosts: [],
      Farmer: ["Heads", "Bodies"],
      Pets: [],
      "Epic Boss": [],
    };
    const ITEM_CAT: Record<string, ObjCard["category"]> = {
      Functional: "functional", Decors: "decor", "Fruit Trees": "tree",
    };
    let tab = SUBTABS[initialTab] ? initialTab : "Crops";
    let sub = SUBTABS[tab][0] ?? "";

    const entriesFor = (): MktEntry[] => {
      if (tab === "Crops" && sub === "Plants")
        return this.plantCards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, sell: c.sell,
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Crops" && sub === "Zombies")
        return this.zombieCards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, brains: c.brains,
          graveNeeded: c.cfg.unlockGrave,
          description: c.description,
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Items") {
        let cards = this.objectCards.filter((c) => c.category === ITEM_CAT[sub]);
        // Storage sheds are a single upgradeable object: show only the NEXT tier
        // above the placed shed (all other sheds hidden). Non-shed functional
        // items are unaffected.
        if (sub === "Functional") {
          const cur = this.getShedSlots ? this.getShedSlots() : 0;
          const sheds = cards.filter((c) => c.def.storageSlots);
          const others = cards.filter((c) => !c.def.storageSlots);
          const next = sheds
            .filter((c) => (c.def.storageSlots ?? 0) > cur)
            .sort((a, b) => (a.def.storageSlots ?? 0) - (b.def.storageSlots ?? 0))[0];
          cards = next ? [next, ...others] : others;
        }
        return cards.map((c) => {
          // The Zombie Pot flips to a flat 30 brains once the player has owned one
          // (see GameState.zombiePotBought); the market price must mirror the charge.
          const potPriced = !!c.def.zombiePot && this.state.zombiePotBought;
          return {
            name: c.name, portrait: c.portrait,
            cost: potPriced ? 30 : c.cost, level: c.level,
            brains: potPriced ? true : c.brainsNeeded,
            description: functionalDescription(c.def),
            onPick: () => { if (this.onBuy) this.onBuy(c.def); bg.remove(); },
          };
        });
      }
      if (tab === "Boosts") {
        // Buying stays in the panel (buy several); the count owned shows in the name.
        return this.boosts.map((b) => {
          const owned = this.state.boostCount(b.key);
          // Gift vouchers are "1 per farm": lock once you own that zombie or hold
          // the voucher (main supplies the predicate; it spans both Cupid vouchers).
          const ownedLimit = b.effect === "gift" && !!this.giftLimitReached?.(b.key);
          return {
            name: owned ? `${b.name} (x${owned})` : b.name,
            portrait: `${BASE}assets/boosts/${b.icon}`, cost: b.cost, level: b.level, brains: b.brainsNeeded,
            description: [b.info, b.flavorText].filter(Boolean).join(" ") || undefined,
            ownedLimit,
            onPick: () => {
              if (this.onBuyBoost && this.onBuyBoost(b)) { refreshCur(); renderGrid(); }
            },
          };
        });
      }
      if (tab === "Farmer" && sub === "Heads") {
        return this.farmer.heads.map((head) => {
          const owned = this.state.ownedFarmerHeads.includes(head.id) || !head.cost;
          return {
            name: head.name,
            portrait: `${BASE}assets/player/${head.part}`,
            cost: head.cost ?? 0,
            level: 1,
            brains: head.brains,
            description: head.description,
            owned,
            equipped: this.state.farmerHeadId === head.id,
            onPick: () => {
              if (owned) this.onEquipFarmerHead?.(head);
              else if (!this.onBuyFarmerHead || !this.onBuyFarmerHead(head)) return;
              refreshCur();
              renderGrid();
            },
          };
        });
      }
      if (tab === "Farmer" && sub === "Bodies") {
        return this.farmer.bodies.map((body) => ({
          name: body.name,
          portrait: `${BASE}assets/player/${body.body}`,
          cost: body.cost ?? 0,
          level: 1,
          brains: body.brains,
          owned: this.state.ownedFarmerBodies.includes(body.id) || !body.cost,
          equipped: this.state.farmerBodyId === body.id,
          onPick: () => { this.onEquipFarmerBody?.(body); renderGrid(); },
        }));
      }
      if (tab === "Pets") {
        return this.pets.pets.filter((pet) => !pet.hidden).map((pet) => {
          const owned = this.state.ownedPets.includes(pet.key);
          return {
            name: pet.name,
            portrait: `${BASE}assets/pets/${pet.portrait}`,
            cost: pet.cost,
            level: pet.level,
            brains: pet.brains,
            description: pet.description,
            owned,
            equipped: this.state.activePet === pet.key,
            onPick: () => {
              if (owned) this.onEquipPet?.(pet);
              else if (!this.onBuyPet || !this.onBuyPet(pet)) return;
              refreshCur();
              renderGrid();
            },
          };
        });
      }
      return [];
    };

    // Keep the currency line in sync after an in-panel purchase.
    const refreshCur = () => {
      cur.innerHTML =
        `<span><img src="${UI("topbar_money_icon.png")}">${this.state.gold}</span>` +
        `<span><img src="${UI("topbar_brain_icon.png")}">${this.state.brains}</span>`;
    };

    // Search + pagination apply only to the card-list tabs; Upgrade and Epic Boss
    // have bespoke layouts.
    const searchable = () => tab !== "Upgrade" && tab !== "Epic Boss";

    // How many cards a page holds. Read from the laid-out grid so it tracks the
    // responsive column count + row height. Roomy layouts (desktop/tablet, ≥3
    // columns) page to exactly the rows that fit, so the grid never scrolls. Narrow
    // phone layouts (1–2 columns) fit too few per row, so they instead get a small
    // touch-scrollable minimum rather than exploding into dozens of near-empty pages
    // — natural on touch, and the themed thin scrollbar keeps it tidy.
    const pageSize = (): number => {
      const cs = getComputedStyle(grid);
      const cols = Math.max(1, cs.gridTemplateColumns.split(" ").filter(Boolean).length);
      const rowH = parseFloat(cs.gridAutoRows) || 122;
      const gap = parseFloat(cs.rowGap || "9") || 9;
      const avail = grid.clientHeight;
      if (avail < rowH) return 10; // not laid out yet (or absurdly short) → sane default
      const rows = Math.max(1, Math.floor((avail + gap) / (rowH + gap)));
      const fit = cols * rows;
      return cols >= 3 ? fit : Math.max(fit, 8);
    };

    const renderGrid = () => {
      grid.innerHTML = "";
      grid.scrollTop = 0;
      // Farm Size lays out as 2 columns so each row is one tier (gold | brains);
      // Ground uses the normal card grid.
      grid.classList.toggle("mkt-grid--upgrade", tab === "Upgrade" && sub === "Farm Size");
      grid.classList.toggle("mkt-grid--epic", tab === "Epic Boss");
      // Search + pager only ride the card-list tabs.
      const canSearch = searchable();
      searchRow.style.display = canSearch ? "flex" : "none";
      if (tab === "Upgrade") {
        pager.style.display = "none";
        if (sub === "Ground") this.renderGroundGrid(grid, refreshCur, renderGrid);
        else this.renderUpgradeGrid(grid, refreshCur, renderGrid);
        return;
      }
      if (tab === "Epic Boss") {
        pager.style.display = "none";
        this.renderEpicBossGrid(grid, refreshCur, renderGrid);
        return;
      }
      const all = entriesFor();
      const q = search.trim().toLowerCase();
      const entries = q ? all.filter((en) => en.name.toLowerCase().includes(q)) : all;

      // Size each page to exactly the rows that fit the visible grid, so the grid
      // itself never has to scroll (the whole point of paginating). Measured from the
      // laid-out grid: column count + fixed row height come from the responsive CSS,
      // so this adapts to desktop/tablet/phone breakpoints automatically. Falls back
      // to a full 2-desktop-rows page if the grid isn't measurable yet.
      const perPage = pageSize();
      const pages = Math.max(1, Math.ceil(entries.length / perPage));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const shown = entries.slice(page * perPage, page * perPage + perPage);

      if (!entries.length) {
        const e = document.createElement("div");
        e.className = "mkt-empty";
        // Distinguish "no search hits" from a genuinely empty tab.
        e.textContent = q
          ? `No items match “${search.trim()}”.`
          : "Coming soon.";
        grid.appendChild(e);
      } else {
        for (const en of shown) grid.appendChild(this.buildMarketCard(en));
      }

      // Pager: only when this tab is paged AND there's more than one page.
      const showPager = canSearch && pages > 1;
      pager.style.display = showPager ? "flex" : "none";
      if (showPager) {
        pageInfo.textContent = `${page + 1} / ${pages}`;
        prevBtn.disabled = page <= 0;
        nextBtn.disabled = page >= pages - 1;
      }
    };

    prevBtn.onclick = () => { if (page > 0) { page--; this.audio.play("menuClick"); renderGrid(); } };
    nextBtn.onclick = () => { page++; this.audio.play("menuClick"); renderGrid(); };
    // Live-filter as the player types; every keystroke returns to the first page.
    searchInput.oninput = () => { search = searchInput.value; page = 0; renderGrid(); };

    const renderSubs = () => {
      subsEl.innerHTML = "";
      const list = SUBTABS[tab];
      subsEl.style.display = list.length ? "flex" : "none";
      for (const s of list) {
        const b = document.createElement("button");
        b.className = "mkt-subtab" + (s === sub ? " sel" : "");
        b.textContent = s;
        b.onclick = () => { this.audio.play("menuClick"); sub = s; page = 0; renderSubs(); renderGrid(); };
        subsEl.appendChild(b);
      }
    };

    for (const name of ["Crops", "Items", "Upgrade", "Boosts", "Farmer", "Pets", "Epic Boss"]) {
      const b = document.createElement("button");
      b.className = "mkt-tab" + (name === tab ? " sel" : "");
      b.textContent = name;
      b.onclick = () => {
        this.audio.play("menuClick");
        tab = name;
        sub = SUBTABS[name][0] ?? "";
        page = 0;
        // A new category starts a fresh search.
        search = "";
        searchInput.value = "";
        tabsEl.querySelectorAll(".mkt-tab").forEach((e) => e.classList.remove("sel"));
        b.classList.add("sel");
        renderSubs();
        renderGrid();
      };
      tabsEl.appendChild(b);
    }

    mkt.append(title, close, cur, tabsEl, subsEl, searchRow, grid, pager);
    bg.appendChild(mkt);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
    renderSubs();
    renderGrid();
  }

  private renderEpicBossGrid(grid: HTMLElement, refreshCur: () => void, rerender: () => void) {
    const views = this.getEpicBossView?.() ?? [];
    if (!views.length) { grid.innerHTML = `<div class="mkt-empty">Coming soon.</div>`; return; }
    const fmt = (ms: number) => {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600);
      const mins = Math.floor(total % 3600 / 60), secs = total % 60;
      return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}:${String(secs).padStart(2, "0")}`;
    };
    for (const view of views) {
    const run = view.run;
    const card = document.createElement("div");
    card.className = "epic-market-card";
    card.innerHTML = `<img class="epic-market-portrait" src="${view.portrait}" alt="">` +
      `<div class="epic-market-copy"><h2><img src="${view.questIcon}" alt=""> ${view.name}</h2>` +
      (view.active && run
        ? `<b>Level ${run.level}/${view.maxLevel}</b><div>Event: ${fmt(view.eventRemainingMs)}</div>` +
          `<div class="epic-hp"><span style="width:${Math.max(0, Math.min(100, run.currentHp / Math.max(1, run.maxHp) * 100))}%"></span></div>` +
          `<div>${run.currentHp.toLocaleString()} / ${run.maxHp.toLocaleString()} life</div>` +
          `<div><b>${run.tokenCount}</b> Boss Token${run.tokenCount === 1 ? "" : "s"}</div>` +
          (view.encounterRemainingMs ? `<div>HP resets in ${fmt(view.encounterRemainingMs)}</div>` : "")
        : `<p>Start a 14-day, ${view.maxLevel}-level Epic Boss event.</p>` +
          (view.reconstructed ? `<p class="epic-wait">Recovered static battle art.</p>` : "") +
          (view.completed ? "<p>Previous run completed!</p>" : view.expired ? "<p>Previous run expired.</p>" : "")) +
      `<details><summary>Possible rewards</summary><div>${view.rewards.join("<br>")}</div>` +
        (view.zombieRewards.length
          ? `<p class="epic-zombie-rewards"><b>Special zombie milestones</b><br>${view.zombieRewards.join("<br>")}</p>`
          : "") +
      `</details></div>`;
    const action = document.createElement("button");
    action.className = "raid-go epic-market-action";
    if (view.active) {
      action.textContent = `Fight · 1 Token or ${EPIC_BOSS_FIGHT_BRAIN_COST} Brains`;
      action.disabled = !(run?.tokenCount) && this.state.brains < EPIC_BOSS_FIGHT_BRAIN_COST;
      action.onclick = () => this.openEpicBossArmy();
    } else {
      action.innerHTML = view.blocked ? "Another boss event is active" :
        `Start Event · ${view.costBrains} <img src="${UI("topbar_brain_icon.png")}" alt="brains">`;
      action.disabled = view.blocked || this.state.brains < view.costBrains;
      action.onclick = async () => {
        if (!await this.confirmInGame(
          `Start ${view.name}?`,
          `Spend ${view.costBrains} brains to start ${view.name} for 14 days?`,
          "Start Event"
        )) return;
        if (await this.onActivateEpicBoss?.(view.id)) { refreshCur(); rerender(); }
      };
    }
    const actions = document.createElement("div");
    actions.className = "epic-market-actions";
    actions.appendChild(action);
    if (view.active) {
      const end = document.createElement("button");
      end.className = "raid-quick";
      end.textContent = "End Event";
      end.onclick = async () => {
        if (!await this.confirmInGame(
          `End ${view.name}?`,
          "This ends the event immediately. Current boss progress will be lost and the activation cost will not be refunded.",
          "End Event"
        )) return;
        action.disabled = true;
        end.disabled = true;
        if (await this.onEndEpicBoss?.()) { refreshCur(); rerender(); }
        else { action.disabled = false; end.disabled = false; }
      };
      actions.appendChild(end);
    }
    card.appendChild(actions);
    grid.appendChild(card);
    }
  }

  private openEpicBossArmy() {
    document.querySelector("#hud .army-bg")?.remove();
    const party = this.getRaidParty?.();
    const bg = document.createElement("div"); bg.className = "panelbg army-bg";
    const panel = document.createElement("div"); panel.className = "panel";
    const close = document.createElement("button"); close.className = "panelclose";
    close.innerHTML = `<img src="${UI("button_close.png")}">`; close.onclick = () => bg.remove();
    panel.appendChild(close); bg.appendChild(panel); this.el.appendChild(bg);
    if (!party?.eligible.length) { panel.insertAdjacentHTML("beforeend", `<h2>Choose your army</h2><p>You have no deployed zombies.</p>`); return; }
    const order: string[] = [];
    const wrap = document.createElement("div"); wrap.className = "army-wrap";
    const head = document.createElement("div"); head.className = "army-head";
    const cards = document.createElement("div"); cards.className = "army-grid";
    const foot = document.createElement("div"); foot.className = "army-foot";
    const start = document.createElement("button"); start.className = "raid-go";
    const pay = document.createElement("select"); pay.className = "raid-quick";
    let payment: EpicBossPayment = (this.getEpicBossView?.().find((view) => view.active)?.run?.tokenCount ?? 0) > 0
      ? "token" : "brains";
    const refresh = () => {
      const bossName = this.getEpicBossView?.().find((view) => view.active)?.name ?? "Epic Boss";
      const tokens = this.getEpicBossView?.().find((view) => view.active)?.run?.tokenCount ?? 0;
      pay.innerHTML = `<option value="token"${tokens < 1 ? " disabled" : ""}>Use Boss Token (${tokens})</option>` +
        `<option value="brains"${this.state.brains < EPIC_BOSS_FIGHT_BRAIN_COST ? " disabled" : ""}>Use ${EPIC_BOSS_FIGHT_BRAIN_COST} Brains (${this.state.brains})</option>`;
      if (payment === "token" && tokens < 1) payment = "brains";
      if (payment === "brains" && this.state.brains < EPIC_BOSS_FIGHT_BRAIN_COST && tokens > 0) payment = "token";
      pay.value = payment;
      const canPay = payment === "token" ? tokens > 0 : this.state.brains >= EPIC_BOSS_FIGHT_BRAIN_COST;
      head.innerHTML = `<h2>Send your army — ${bossName}</h2><span class="army-count">${order.length}/${party.cap} · min 1</span>`;
      start.textContent = order.length ? `Fight with ${order.length}` : "Choose a zombie";
      start.disabled = !order.length || !canPay;
      cards.querySelectorAll<HTMLElement>(".army-card").forEach((el) => { const at = order.indexOf(el.dataset.id!); el.classList.toggle("sel", at >= 0); const tick = el.querySelector<HTMLElement>(".tick"); if (tick) tick.textContent = at >= 0 ? String(at + 1) : ""; });
    };
    for (const z of party.eligible) {
      const card = document.createElement("div"); card.className = "army-card"; card.dataset.id = z.id;
      card.innerHTML = `<span class="tick"></span><div class="army-por" style="background-image:url(${z.portrait})"></div><div class="army-nm">${z.name}</div><div class="army-ty">${z.typeName}</div>`;
      card.onclick = () => { const at = order.indexOf(z.id); if (at >= 0) order.splice(at, 1); else if (order.length < party.cap) order.push(z.id); refresh(); };
      cards.appendChild(card);
    }
    const pick = document.createElement("button"); pick.className = "raid-quick"; pick.textContent = "Pick for me";
    pay.onchange = () => { payment = pay.value as EpicBossPayment; refresh(); };
    pick.onclick = () => {
      const preferred = this.getEpicBossView?.().find((view) => view.active)?.run?.attackOrder ?? [];
      order.splice(0, order.length, ...fillPartySelection(
        order, preferred, party.eligible.map((z) => z.id), party.cap
      ));
      refresh();
    };
    start.onclick = async () => {
      if (!order.length || !this.onLaunchEpicBoss) return;
      start.disabled = true;
      if (await this.onLaunchEpicBoss([...order], payment)) {
        bg.remove();
        this.closeMarket();
      } else start.disabled = false;
    };
    foot.append(pick, pay, start); wrap.append(head, cards, foot); panel.appendChild(wrap); refresh();
  }

  /** Rebuild an open Epic Boss picker after authoritative roster settlement. */
  refreshEpicBossArmy() {
    if (document.querySelector("#hud .army-bg")) this.openEpicBossArmy();
  }

  private buildMarketCard(en: MktEntry): HTMLElement {
    const locked = this.state.level < en.level;
    // Colored-grave gate: this zombie class can't be planted until you own it.
    const graveLock = !locked && !!en.graveNeeded && !!this.hasGrave && !this.hasGrave(en.graveNeeded);
    // "1 per farm" gift-voucher limit: already own that zombie (or hold the voucher).
    const limitLock = !locked && !graveLock && !!en.ownedLimit;
    const curAmt = en.brains ? this.state.brains : this.state.gold;
    const poor = !en.owned && !locked && !graveLock && !limitLock && curAmt < en.cost;
    const card = document.createElement("div");
    card.className = "mkt-card" + (en.owned ? " owned" : "") + (en.equipped ? " equipped" : "") +
      (locked || poor || graveLock || limitLock ? " locked" : "");

    const hd = document.createElement("div");
    hd.className = "hd";
    hd.textContent = en.name;

    const body = document.createElement("div");
    body.className = "mkt-body";
    const img = document.createElement("img");
    img.loading = "lazy"; // only fetch portraits as cards scroll into view
    img.decoding = "async";
    img.src = en.portrait;
    body.appendChild(img);
    if (en.sell !== undefined) {
      const s = document.createElement("div");
      s.className = "mkt-sell";
      s.innerHTML = `<img src="${UI("topbar_money_icon.png")}">+${en.sell}`;
      body.appendChild(s);
    }
    const cost = document.createElement("div");
    cost.className = "mkt-cost";
    const coin = en.brains ? "topbar_brain_icon.png" : "topbar_money_icon.png";
    cost.innerHTML = en.equipped
      ? `✓ Equipped`
      : en.owned
        ? `Equip`
      : locked
      ? `🔒 Lvl ${en.level}`
      : graveLock
        ? `🔒 ${en.graveNeeded} Grave`
        : limitLock
          ? `✓ Owned`
          : `${en.cost}<img src="${UI(coin)}">`;
    body.appendChild(cost);

    card.append(hd, body);
    // Magnifier: a small "what does it do?" button that pops the item's description.
    // Present even on locked cards so players can learn about items before they unlock.
    if (en.description) {
      const info = document.createElement("button");
      info.className = "mkt-info";
      info.type = "button";
      info.title = "What does this do?";
      info.setAttribute("aria-label", `What does ${en.name} do?`);
      info.innerHTML =
        `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4.3"/>` +
        `<line x1="9.7" y1="9.7" x2="14" y2="14"/></svg>`;
      info.onclick = (e) => { e.stopPropagation(); this.showItemInfo(en); };
      card.appendChild(info);
    }
    if (!en.equipped && !locked && !poor && !graveLock && !limitLock) card.onclick = en.onPick;
    return card;
  }

  // Small parchment popup describing a Market item, opened from a card's magnifier.
  private showItemInfo(en: MktEntry) {
    document.querySelector("#hud .info-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "info-bg";
    const box = document.createElement("div");
    box.className = "info-box";
    const close = document.createElement("button");
    close.className = "info-close";
    const ci = document.createElement("img");
    ci.src = UI("button_close.png");
    close.appendChild(ci);
    close.onclick = () => bg.remove();
    const img = document.createElement("img");
    img.className = "info-img";
    img.src = en.portrait;
    const name = document.createElement("div");
    name.className = "info-name";
    name.textContent = en.name;
    const desc = document.createElement("div");
    desc.className = "info-desc";
    desc.textContent = en.description ?? "";
    box.append(close, img, name, desc);
    bg.appendChild(box);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
    this.audio.play("menuClick");
  }

  // The Market Upgrade tab: a current-size banner plus, for each Farm Size tier, a
  // gold card AND a brains card (six cards for three tiers). Tiers are bought in
  // order (30 -> 40 -> 50 -> 60); buying either currency's card grows the farm, which
  // makes both of that tier's cards read as owned.
  private renderUpgradeGrid(grid: HTMLElement, refreshCur: () => void, rerender: () => void) {
    const current = this.getMapSize ? this.getMapSize() : 30;
    const maxed = this.farmUpgrades.every((u) => u.size <= current);
    const status = document.createElement("div");
    status.className = "mkt-upgrade-status";
    status.innerHTML = `Current farm size <b>${current}×${current}</b>` +
      (maxed ? " — the biggest there is!" : "");
    grid.appendChild(status);
    // Next buyable tier = smallest size still larger than the current farm.
    const next = this.farmUpgrades.filter((u) => u.size > current)
      .sort((a, b) => a.size - b.size)[0];
    // Show ONLY that next tier, as a gold card + a brains card side by side.
    // Already-owned smaller farms and not-yet-reachable larger tiers are omitted
    // (when maxed, `next` is undefined and just the status banner shows).
    if (next)
      for (const currency of ["gold", "brains"] as const)
        grid.appendChild(this.buildUpgradeCard(next, currency, current, next, refreshCur, rerender));
  }

  private buildUpgradeCard(
    u: FarmSizeUpgrade, currency: "gold" | "brains", current: number,
    next: FarmSizeUpgrade | undefined, refreshCur: () => void, rerender: () => void
  ): HTMLElement {
    const price = currency === "gold" ? u.gold : u.brains;
    const coin = currency === "gold" ? "topbar_money_icon.png" : "topbar_brain_icon.png";
    const funds = currency === "gold" ? this.state.gold : this.state.brains;
    const owned = u.size <= current;
    const isNext = !!next && u.size === next.size;
    const levelOk = this.state.level >= u.level;
    const buyable = isNext && levelOk && funds >= price; // next tier, this currency affordable
    const locked = !owned && !buyable;

    const card = document.createElement("div");
    card.className = "mkt-card" + (owned ? " owned" : locked ? " locked" : "");

    const hd = document.createElement("div");
    hd.className = "hd";
    hd.textContent = u.name;

    const body = document.createElement("div");
    body.className = "mkt-body";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = upgradeIcon(u.icon);
    const size = document.createElement("div");
    size.className = "mkt-upgrade-size";
    size.textContent = `${u.size}×${u.size}`;
    body.append(img, size);

    const cost = document.createElement("div");
    cost.className = "mkt-cost";
    if (owned) {
      cost.textContent = "✓ Owned";
    } else if (!levelOk) {
      cost.innerHTML = `🔒 Lvl ${u.level}`;
    } else if (!isNext) {
      cost.innerHTML = `🔒 Get ${next?.info ?? "previous"} first`;
    } else {
      cost.innerHTML = `${price.toLocaleString()}<img src="${UI(coin)}">`;
    }
    body.appendChild(cost);

    card.append(hd, body);
    if (buyable)
      card.onclick = async () => {
        card.style.pointerEvents = "none";
        if (this.onBuyUpgrade && await this.onBuyUpgrade(u.size, currency)) {
          refreshCur();
          rerender();
        } else card.style.pointerEvents = "";
      };
    return card;
  }

  // The Market Upgrade → Ground tab: one card per ground/climate skin. Grassy is
  // the free default; others cost gold and, once bought, can be re-applied for free.
  private renderGroundGrid(grid: HTMLElement, refreshCur: () => void, rerender: () => void) {
    const current = this.getClimate ? this.getClimate() : "grass";
    const status = document.createElement("div");
    status.className = "mkt-upgrade-status";
    const cur = this.climates.find((c) => c.terrain === current);
    status.innerHTML = `Current ground <b>${cur?.name ?? "Grassy Ground"}</b>`;
    grid.appendChild(status);
    for (const c of this.climates) grid.appendChild(this.buildClimateCard(c, refreshCur, rerender));
  }

  private buildClimateCard(
    c: ClimateUpgrade, refreshCur: () => void, rerender: () => void
  ): HTMLElement {
    const current = this.getClimate ? this.getClimate() : "grass";
    const owned = c.terrain === "grass" || (this.ownsClimate?.(c.terrain) ?? false);
    const applied = current === c.terrain;
    const levelOk = this.state.level >= c.level;
    const price = c.gold;
    const buyable = !owned && levelOk && this.state.gold >= price;
    const locked = !owned && !buyable;

    const card = document.createElement("div");
    card.className = "mkt-card" + (applied ? " owned" : locked ? " locked" : "");

    const hd = document.createElement("div");
    hd.className = "hd";
    hd.textContent = c.name;

    const body = document.createElement("div");
    body.className = "mkt-body";
    // Preview = the actual iso ground tile (always present under /assets/ground).
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = `${BASE}assets/ground/${c.terrain}_0.png`;
    img.style.width = "72px";
    img.style.imageRendering = "pixelated";
    body.appendChild(img);

    const cost = document.createElement("div");
    cost.className = "mkt-cost";
    if (applied) {
      cost.textContent = "✓ In Use";
    } else if (owned) {
      cost.textContent = "Apply";
    } else if (!levelOk) {
      cost.innerHTML = `🔒 Lvl ${c.level}`;
    } else {
      cost.innerHTML = `${price.toLocaleString()}<img src="${UI("topbar_money_icon.png")}">`;
    }
    body.appendChild(cost);

    card.append(hd, body);
    if (applied) {
      // no-op: already the active ground
    } else if (owned) {
      card.onclick = () => { this.onApplyClimate?.(c); refreshCur(); rerender(); };
    } else if (buyable) {
      card.onclick = async () => {
        card.style.pointerEvents = "none";
        if (this.onBuyClimate && await this.onBuyClimate(c)) { refreshCur(); rerender(); }
        else card.style.pointerEvents = "";
      };
    }
    return card;
  }

  // The tool-shed Storage menu: parchment/wood panel, a red STORAGE banner with
  // grass/flower flanks, and tabs Items / Pets / Boosts / Received. Item capacity
  // comes from the placed shed's tier; pets and received are unlimited.
  // Opened by clicking the shed, Pet Pen, or the Storage button.
  openStorage(initialTab: string = "Items", managePen = false) {
    document.querySelector("#hud .st-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "st-bg";
    const st = document.createElement("div");
    st.className = "st";

    const close = document.createElement("button");
    close.className = "st-close";
    const ci = document.createElement("img");
    ci.src = UI("button_close.png");
    close.appendChild(ci);
    close.onclick = () => bg.remove();

    const header = document.createElement("div");
    header.className = "st-header";
    const fl = document.createElement("img");
    fl.className = "flank";
    fl.src = BASE + "assets/ui/storage/board_items_left.png";
    const banner = document.createElement("div");
    banner.className = "st-banner";
    banner.textContent = "Storage";
    const fr = document.createElement("img");
    fr.className = "flank";
    fr.src = BASE + "assets/ui/storage/board_item_right.png";
    header.append(fl, banner, fr);

    const tabsEl = document.createElement("div");
    tabsEl.className = "st-tabs";
    const count = document.createElement("div");
    count.className = "st-count";
    const body = document.createElement("div");
    body.className = "st-body";

    const portraitOf = (key: string) =>
      this.objectCards.find((c) => c.def.key === key)?.portrait;

    let tab = ["Items", "Pets", "Boosts", "Received"].includes(initialTab) ? initialTab : "Items";
    const render = () => {
      body.innerHTML = "";
      body.scrollTop = 0;
      if (tab === "Items") {
        const used = this.state.storedItemTotal();
        count.textContent = `${used} / ${this.state.storageItemCap} slots`;
        const hint = document.createElement("div");
        hint.className = "st-hint";
        hint.textContent = used
          ? "Tap a stored item to place it back on the farm."
          : "Store decorations by tapping them on the farm.";
        body.appendChild(hint);
        const grid = document.createElement("div");
        grid.className = "st-grid";
        // One slot per stored stack (repeated by count), padded to capacity.
        const flat: string[] = [];
        for (const it of this.state.storedItems)
          for (let k = 0; k < it.count; k++) flat.push(it.key);
        for (let i = 0; i < this.state.storageItemCap; i++) {
          const slot = document.createElement("div");
          slot.className = "st-slot";
          const key = flat[i];
          if (key) {
            const img = document.createElement("img");
            const p = portraitOf(key);
            if (p) img.src = p;
            slot.appendChild(img);
            slot.classList.add("filled");
            slot.title = "Place on farm";
            slot.onclick = () => {
              bg.remove();
              this.onRetrieveItem?.(key);
            };
          }
          grid.appendChild(slot);
        }
        body.appendChild(grid);
      } else if (tab === "Pets") {
        count.textContent = managePen
          ? `${this.state.penPets.length} / 4 in pen`
          : `${this.state.ownedPets.length} pet${this.state.ownedPets.length === 1 ? "" : "s"}`;
        const hint = document.createElement("div");
        hint.className = "st-hint";
        hint.textContent = this.state.ownedPets.length
          ? managePen
            ? "Choose up to four pets to wander inside this pen."
            : "Tap a pet to make it your active companion."
          : "Adopt pets from the Market's Pets tab.";
        body.appendChild(hint);
        if (!managePen && this.state.activePet) {
          const hide = document.createElement("button");
          hide.className = "st-use";
          hide.textContent = "Hide Active Pet";
          hide.onclick = () => { this.onEquipPet?.(null); render(); };
          body.appendChild(hide);
        }
        const grid = document.createElement("div");
        grid.className = "st-grid";
        for (const key of this.state.ownedPets) {
          const pet = this.pets.pets.find((candidate) => candidate.key === key);
          if (!pet) continue;
          const slot = document.createElement("button");
          const selected = managePen ? this.state.penPets.includes(key) : this.state.activePet === key;
          slot.className = "st-slot st-petslot" + (selected ? " filled" : "");
          slot.title = managePen
            ? selected ? `Remove ${pet.name} from pen` : `Deploy ${pet.name} in pen`
            : selected ? `${pet.name} (active)` : `Activate ${pet.name}`;
          const img = document.createElement("img");
          img.src = `${BASE}assets/pets/${pet.portrait}`;
          img.alt = pet.name;
          slot.appendChild(img);
          slot.onclick = () => {
            if (managePen) {
              const next = selected
                ? this.state.penPets.filter((candidate) => candidate !== key)
                : this.state.penPets.length < 4 ? [...this.state.penPets, key] : null;
              if (!next) return;
              this.onSetPenPets?.(next.flatMap((petKey) => {
                const found = this.pets.pets.find((candidate) => candidate.key === petKey);
                return found ? [found] : [];
              }));
            } else this.onEquipPet?.(pet);
            render();
          };
          grid.appendChild(slot);
        }
        body.appendChild(grid);
      } else if (tab === "Boosts") {
        const total = this.state.boostInv.reduce((a, b) => a + b.count, 0);
        count.textContent = `${total} boosts`;
        if (!total) {
          const e = document.createElement("div");
          e.className = "st-empty";
          e.textContent = "Buy boosts from the Market's Boosts tab.";
          body.appendChild(e);
        } else {
          const list = document.createElement("div");
          list.className = "st-boostlist";
          for (const inv of this.state.boostInv) {
            const def = this.boosts.find((b) => b.key === inv.key);
            if (!def) continue;
            const row = document.createElement("div");
            row.className = "st-boost";
            const img = document.createElement("img");
            img.src = `${BASE}assets/boosts/${def.icon}`;
            const info = document.createElement("div");
            info.className = "st-boost-info";
            info.innerHTML =
              `<div class="nm">${def.name} <span class="ct">x${inv.count}</span></div>` +
              `<div class="ds">${def.info || def.flavorText}</div>`;
            const btn = document.createElement("button");
            btn.className = "st-use";
            if (def.effect === "grow") {
              // Insta-Grow is a manual tool, not an auto-apply: equip it so the
              // player taps each crop to ripen (rather than auto-growing nearby ones).
              btn.textContent = "Equip";
              btn.onclick = () => { bg.remove(); this.setMode("instagrow"); };
            } else if (def.usableOnFarm) {
              btn.textContent = "Use";
              btn.onclick = () => { this.onUseBoost?.(def); render(); };
            } else {
              // Battle boosts (Invasion Voucher / Concentration / Golden Dice) are all
              // chosen on the Invade screens, not from Storage — so just label them.
              btn.textContent = "At Invade";
              btn.disabled = true;
            }
            row.append(img, info, btn);
            list.appendChild(row);
          }
          body.appendChild(list);
        }
      } else {
        const views = this.getReceived?.() ?? [];
        count.textContent = `${views.length} item${views.length === 1 ? "" : "s"}`;
        if (!views.length) {
          const e = document.createElement("div");
          e.className = "st-empty";
          e.textContent = "Rewards from raids and quests appear here.";
          body.appendChild(e);
        } else {
          const hint = document.createElement("div");
          hint.className = "st-hint";
          hint.textContent = "Claim rewards, or place decorations on your farm.";
          body.appendChild(hint);
          const grid = document.createElement("div");
          grid.className = "rcv-grid";
          for (const v of views) grid.appendChild(this.receivedCard(v, bg, render));
          body.appendChild(grid);
        }
      }
    };

    const tabBtns: Record<string, HTMLButtonElement> = {};
    for (const name of ["Items", "Pets", "Boosts", "Received"]) {
      const b = document.createElement("button");
      b.className = "st-tab" + (name === tab ? " sel" : "");
      b.textContent = name;
      b.onclick = () => {
        this.audio.play("menuClick");
        tab = name;
        Object.values(tabBtns).forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        render();
      };
      tabBtns[name] = b;
      tabsEl.appendChild(b);
    }

    st.append(close, header, tabsEl, count, body);
    bg.appendChild(st);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
    render();
  }

  // Build one Received-tab reward card. Placeables enter placement (closing the
  // panel); boosts/currency claim in place (re-rendering the tab); trophies —
  // loot decor with no placeable form in this build — are display-only.
  private receivedCard(v: ReceivedView, bg: HTMLElement, rerender: () => void): HTMLElement {
    const card = document.createElement("div");
    card.className = "rcv-card" + (v.actionLabel ? "" : " trophy");
    const por = document.createElement("div");
    por.className = "rcv-por";
    if (v.icon) {
      const img = document.createElement("img");
      img.src = v.icon;
      por.appendChild(img);
    }
    const nm = document.createElement("div");
    nm.className = "rcv-nm";
    nm.textContent = v.name;
    card.append(por, nm);
    if (v.actionLabel) {
      const btn = document.createElement("button");
      btn.className = "st-use rcv-act";
      btn.textContent = v.actionLabel;
      if (v.kind === "placeable") {
        btn.onclick = () => { bg.remove(); this.onPlaceReceived?.(v.index); };
      } else {
        btn.onclick = () => { this.onClaimReceived?.(v.index); rerender(); };
      }
      card.appendChild(btn);
    } else {
      const tag = document.createElement("div");
      tag.className = "rcv-trophy";
      tag.textContent = "Trophy";
      card.appendChild(tag);
    }
    return card;
  }

  // Slide-in picker from the left (opened by the select tool on tilled ground).
  // Two screens (Plants / Zombies); the Zombies screen has NORMAL/SPECIAL/MUTANT
  // tabs. Picking a card calls onPick(cfg) and closes the menu.
  openPlantMenu(onPick: (cfg: CropConfig) => void, opts?: { onlyKey?: string }) {
    document.querySelector("#hud .pm-bg")?.remove(); // only one at a time
    const bg = document.createElement("div");
    bg.className = "pm-bg";
    const pm = document.createElement("div");
    pm.className = "pm";
    // Guided-tutorial mode: constrain the menu to a single plantable (the base
    // Zombie) — the screen/subtab toggles are hidden and every other card is
    // locked, so the player can only pick the tutorial's target.
    const onlyKey = opts?.onlyKey;

    const close = document.createElement("button");
    close.className = "pm-close";
    const ci = document.createElement("img");
    ci.src = UI("button_close.png");
    close.appendChild(ci);
    close.onclick = () => bg.remove();
    if (onlyKey) close.style.display = "none"; // no bailing out of the tutorial pick

    // Plants / Zombies screen toggle.
    const screens = document.createElement("div");
    screens.className = "pm-screens";
    const subtabs = document.createElement("div");
    subtabs.className = "pm-subtabs";
    const list = document.createElement("div");
    list.className = "pm-list";

    let zcat: "normal" | "special" | "mutant" = "normal";

    const pick = (card: MenuCard) => {
      onPick(card.cfg);
      bg.remove();
    };
    const renderList = (cards: MenuCard[]) => {
      list.innerHTML = "";
      list.scrollTop = 0;
      // In tutorial mode, lock every card except the target so only it is tappable.
      for (const c of cards)
        list.appendChild(this.buildCard(c, pick, !!onlyKey && c.cfg.key !== onlyKey));
    };
    const showZombieTabs = (on: boolean) => (subtabs.style.display = on ? "flex" : "none");

    const showPlants = () => {
      showZombieTabs(false);
      renderList(this.plantCards);
    };
    const showZombies = () => {
      showZombieTabs(true);
      subtabs.querySelectorAll(".pm-subtab").forEach((e) =>
        e.classList.toggle("sel", (e as HTMLElement).dataset.cat === zcat)
      );
      renderList(this.zombieCards.filter((z) => z.category === zcat));
    };

    const screenBtns: Record<string, HTMLButtonElement> = {};
    const mkScreen = (label: string, on: () => void) => {
      const b = document.createElement("button");
      b.className = "pm-screen";
      b.textContent = label;
      b.onclick = () => {
        Object.values(screenBtns).forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        on();
      };
      screenBtns[label] = b;
      screens.appendChild(b);
    };
    mkScreen("Plants", showPlants);
    mkScreen("Zombies", showZombies);

    (["normal", "special", "mutant"] as const).forEach((cat) => {
      const b = document.createElement("button");
      b.className = "pm-subtab";
      b.dataset.cat = cat;
      b.textContent = cat.toUpperCase();
      b.onclick = () => { zcat = cat; showZombies(); };
      subtabs.appendChild(b);
    });

    pm.append(close, screens, subtabs, list);
    bg.appendChild(pm);
    // In tutorial mode the backdrop tap must NOT dismiss (there's no other way
    // to reopen the constrained menu); otherwise tapping outside closes it.
    if (!onlyKey) bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    if (onlyKey) {
      // Tutorial: skip the Plants/Zombies chrome — show only the Zombies list
      // (with everything but the target locked) and hide the toggles/subtabs.
      screens.style.display = "none";
      zcat = "normal";
      showZombies();
      subtabs.style.display = "none";
      return;
    }
    // Open on the Plants screen.
    screenBtns["Plants"].classList.add("sel");
    showPlants();
  }

  private buildCard(c: MenuCard, onPick: (c: MenuCard) => void, forceLock = false): HTMLElement {
    const levelLocked = this.state.level < c.level;
    // Colored-grave gate for zombie crops (Blue/Red/Silver need the grave placed).
    const graveLock = !levelLocked && !!c.cfg.unlockGrave && !!this.hasGrave &&
      !this.hasGrave(c.cfg.unlockGrave);
    const locked = levelLocked || graveLock || forceLock;
    const card = document.createElement("div");
    card.className = locked ? "pm-card locked" : "pm-card";

    const name = document.createElement("div");
    name.className = "pm-name";
    name.textContent = c.name;

    const port = document.createElement("div");
    port.className = "pm-port";
    const pimg = document.createElement("img");
    pimg.src = c.portrait;
    port.appendChild(pimg);

    const right = document.createElement("div");
    right.className = "pm-right";
    if (c.sell !== undefined) {
      const s = document.createElement("span");
      s.innerHTML = `<img src="${UI("topbar_money_icon.png")}">+${c.sell}`;
      right.appendChild(s);
    }
    const t = document.createElement("span");
    t.innerHTML = `<img src="${UI("icon_time.png")}">${c.timeLabel}`;
    right.appendChild(t);

    const cost = document.createElement("div");
    cost.className = "pm-cost";
    // Locked cards show the requirement (level or grave) instead of a buyable cost.
    cost.innerHTML = levelLocked
      ? `<span class="pm-lock">🔒 Lvl ${c.level}</span>`
      : graveLock
        ? `<span class="pm-lock">🔒 ${c.cfg.unlockGrave} Grave</span>`
        : `${c.cost}<img src="${UI(c.brains ? "topbar_brain_icon.png" : "topbar_money_icon.png")}">`;

    card.append(name, port, right, cost);
    if (!locked) card.onclick = () => onPick(c);
    return card;
  }

  // Reusable label + on/off toggle row (shared by Settings and the Developer menu).
  private settingRow(label: string, on: boolean, set: (v: boolean) => void) {
    const r = document.createElement("div");
    r.className = "set-row";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const t = document.createElement("button");
    t.className = "toggle" + (on ? " on" : "");
    t.innerHTML = `<span class="txt l">ON</span><span class="txt r">OFF</span><span class="knob"></span>`;
    t.onclick = () => {
      const now = !t.classList.contains("on");
      t.classList.toggle("on", now);
      set(now);
    };
    r.append(lbl, t);
    return r;
  }

  // Reusable label + segmented multi-choice row (a small pill button per option).
  private settingChoiceRow<T extends string>(
    label: string,
    options: { id: T; label: string }[],
    current: T,
    set: (v: T) => void
  ) {
    const r = document.createElement("div");
    r.className = "set-row set-row-choice";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const seg = document.createElement("div");
    seg.className = "set-choice";
    const btns = options.map((o) => {
      const b = document.createElement("button");
      b.className = "choice" + (o.id === current ? " on" : "");
      b.textContent = o.label;
      b.onclick = () => {
        if (b.classList.contains("on")) return;
        for (const other of btns) other.classList.remove("on");
        b.classList.add("on");
        set(o.id);
      };
      return b;
    });
    seg.append(...btns);
    r.append(lbl, seg);
    return r;
  }

  // Settings modal: Music / Sound Effects / Ambience toggles plus the account
  // block. The Developer section now lives in its own menu (openDevMenu), reached
  // via the invisible hotspot beside the nameplate.
  private openSettings() {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = "Settings";

    const row = (label: string, on: boolean, set: (v: boolean) => void) =>
      this.settingRow(label, on, set);

    // (Account + Sign out moved to the Profile menu — opened by the top-right
    // nameplate. See openProfiles / buildAccountBlock.)

    // A toggle row followed by a small explanatory note underneath it.
    const noteEl = (text: string) => {
      const n = document.createElement("div");
      n.className = "set-note";
      n.textContent = text;
      return n;
    };

    // Sprite set: original Zombie Farm (ZF1) vs the sequel's art (ZF2). Persisted
    // only — nothing swaps art on it yet (see prefs.ts / README "Current Gaps").
    // ON = ZF2 (the pack wired today), OFF = ZF1.
    const spriteRow = row("ZF2 Sprites", getSpriteSet() === "zf2", (v) =>
      setSpriteSet(v ? "zf2" : "zf1")
    );
    const spriteNote = noteEl("Original (ZF1) vs sequel (ZF2) art. Art swapping isn't wired yet.");

    // Edition: Reforged (all modern additions — online account, brain gifting) vs
    // Traditional (the OG single-player experience). Persisted only for now — the
    // feature gates it will drive aren't wired yet (see prefs.isReforged).
    const editionRow = row("Reforged", getEdition() === "reforged", (v) =>
      setEdition(v ? "reforged" : "traditional")
    );
    const editionNote = noteEl("Reforged adds brain gifting & online features; Traditional is the OG experience. (Gating not wired yet.)");

    // Signed-in players can change the same display name they chose on first login.
    // The server remains the source of truth for normalization and validation.
    const accountBlock: HTMLElement[] = [];
    const acct = this.myAccount?.();
    if (this.socialOnline?.() && acct && this.onSetUsername) {
      const wrap = document.createElement("div");
      wrap.className = "set-username";
      const r = document.createElement("div");
      r.className = "set-row";
      const label = document.createElement("span");
      label.textContent = "Username";
      const controls = document.createElement("div");
      controls.className = "set-username-controls";
      const input = document.createElement("input");
      input.className = "set-username-input";
      input.type = "text";
      input.maxLength = 20;
      input.autocomplete = "off";
      input.value = acct.name;
      input.setAttribute("aria-label", "Username");
      const save = document.createElement("button");
      save.className = "set-username-save";
      save.textContent = "Save";
      const status = document.createElement("div");
      status.className = "set-username-status";
      const submit = async () => {
        const name = input.value.trim();
        if (!name || save.disabled) return;
        save.disabled = true;
        input.disabled = true;
        status.classList.remove("error");
        status.textContent = "Saving…";
        const error = await this.onSetUsername!(name).catch(() => "error");
        save.disabled = false;
        input.disabled = false;
        if (error) {
          status.classList.add("error");
          status.textContent = error === "bad_username"
            ? "Use 2–20 letters, numbers, spaces or _ - . '"
            : "Couldn't save that. Try again.";
          return;
        }
        input.value = this.myAccount?.()?.name ?? name;
        status.textContent = "Username updated.";
      };
      save.onclick = () => void submit();
      input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
      controls.append(input, save);
      r.append(label, controls);
      wrap.append(r, status);
      accountBlock.push(wrap);
    }

    // Farm background: how lush the trees ringing the farm are. All three fill the
    // view to the zoom-out edge; they differ in density (Deep Forest → Light Meadow).
    const bgBlock: HTMLElement[] = [];
    if (this.getFarmBackground && this.onSetFarmBackground) {
      bgBlock.push(
        this.settingChoiceRow("Farm Background", FARM_BACKGROUNDS, this.getFarmBackground(),
          (v) => this.onSetFarmBackground?.(v)),
        noteEl("How many trees surround your farm.")
      );
    }

    panel.append(
      x, h,
      row("Music", this.audio.musicOn, (v) => this.audio.setMusic(v)),
      row("Sound Effects", this.audio.sfxOn, (v) => this.audio.setSfx(v)),
      row("Ambience", this.audio.ambienceOn, (v) => this.audio.setAmbience(v)),
      row("Mute When Unfocused", this.audio.muteWhenUnfocused,
        (v) => this.audio.setMuteWhenUnfocused(v)),
      noteEl("Silence the game while its tab or window is in the background."),
      ...accountBlock,
      ...bgBlock,
      spriteRow, spriteNote,
      editionRow, editionNote
    );
    const version = document.createElement("div");
    version.className = "set-version";
    version.textContent = `Version ${APP_VERSION}`;
    panel.append(version);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Developer menu: hidden from normal play, opened only via the invisible hotspot
  // beside the nameplate. Holds the Night-lighting toggle,
  // level/gold/brains overrides, and the per-tier raid ability unlocks.
  private openDevMenu() {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = "Developer";

    const row = (label: string, on: boolean, set: (v: boolean) => void) =>
      this.settingRow(label, on, set);

    // Developer number field: label + numeric input applied on change.
    const numRow = (label: string, value: number, apply: (n: number) => void) => {
      const r = document.createElement("div");
      r.className = "set-row";
      const lbl = document.createElement("span");
      lbl.textContent = label;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "dev-input";
      inp.value = String(value);
      inp.onchange = () => {
        const n = parseInt(inp.value, 10);
        if (!Number.isNaN(n)) {
          apply(n);
          this.update();
        }
      };
      r.append(lbl, inp);
      return r;
    };

    // Night lighting: toggles the dark overlay + carved lights (was the N key).
    const nightRow = row("Night", this.getNight?.() ?? false, (v) =>
      this.onSetNight?.(v)
    );

    // Dev: beat a tier boss once — each win unlocks the NEXT still-locked ability of
    // that tier across the roster (not the whole tier at once).
    const raidWrap = document.createElement("div");
    const raidStatus = document.createElement("div");
    raidStatus.className = "dev-status";
    raidStatus.textContent = "Beat a tier boss to unlock its next ability:";
    const raidBtns = document.createElement("div");
    raidBtns.className = "dev-raid-btns";
    for (let t = 1; t <= 4; t++) {
      const b = document.createElement("button");
      b.className = "dev-btn";
      b.textContent = `Win T${t} — ${TIER_BOSS[t]}`;
      b.onclick = () => {
        const pool = ABILITY_TIER[t] ?? [];
        const before = this.state.tierAbilitiesUnlocked(t);
        this.state.completeRaid(String(t));
        const after = this.state.tierAbilitiesUnlocked(t);
        if (after > before) {
          const label = ABILITY_POOL[pool[after - 1]]?.label ?? pool[after - 1];
          raidStatus.textContent =
            `Unlocked ${label} — Tier ${t} ${after}/${pool.length} (beat ${TIER_BOSS[t]}).`;
        } else {
          raidStatus.textContent = `All Tier ${t} abilities already unlocked.`;
        }
      };
      raidBtns.appendChild(b);
    }
    raidWrap.append(raidStatus, raidBtns);

    panel.append(
      x, h,
      nightRow,
      numRow("Level", this.state.level, (n) => this.state.setLevel(n)),
      numRow("Gold", this.state.gold, (n) => this.state.setGold(n)),
      numRow("Brains", this.state.brains, (n) => this.state.setBrains(n)),
      raidWrap
    );
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  /** Account block for the Account menu: who you're signed in as and a Sign out
   *  button — this is the ONE place Sign out lives. Returns null when there's no
   *  online account (offline build or signed out) so the caller can omit it. The
   *  friend code lives in the Friends panel now, not here. Sign out flushes the
   *  save and returns to the sign-in gate (see hud.onSignOut / main.ts). */
  private buildAccountBlock(): HTMLElement | null {
    const acct = this.myAccount?.();
    if (!this.socialOnline?.() || !acct) return null;
    const block = document.createElement("div");
    block.className = "set-acct";
    const info = document.createElement("div");
    info.className = "set-acct-info";
    const who = document.createElement("div");
    who.className = "set-acct-who";
    who.innerHTML = `Signed in as <b>${acct.name}</b>`;
    info.append(who);
    const out = document.createElement("button");
    out.className = "set-signout";
    out.textContent = "Sign out";
    out.onclick = () => this.onSignOut?.();
    block.append(info, out);
    return block;
  }

  /** Short "active N ago" for the device list. Coarse on purpose. */
  private static relTime(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 90) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** Devices block for the Account menu: this account's live sessions, each with a
   *  device label + last-active time, and a Revoke button for every device EXCEPT
   *  the current one (that's what Sign out is for). Loads asynchronously — returns
   *  the container immediately and fills it in. Null when there's no online account. */
  private buildDevicesBlock(): HTMLElement | null {
    if (!this.socialOnline?.() || !this.onListSessions) return null;
    const block = document.createElement("div");
    block.className = "set-devices";
    const h = document.createElement("h3");
    h.textContent = "Devices";
    const list = document.createElement("div");
    list.className = "set-dev-list";
    list.textContent = "Loading…";
    block.append(h, list);

    const render = async () => {
      let rows: { id: string; label: string | null; lastUsedAt: number; current: boolean }[];
      try {
        rows = await this.onListSessions!();
      } catch {
        list.textContent = "Couldn't load your devices.";
        return;
      }
      list.innerHTML = "";
      if (!rows.length) { list.textContent = "No active devices."; return; }
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "set-dev-row";
        const meta = document.createElement("div");
        meta.className = "set-dev-meta";
        const name = document.createElement("div");
        name.className = "set-dev-name";
        // textContent — the label is server-derived, but never build markup from it.
        name.textContent = r.label ?? "Unknown device";
        const when = document.createElement("div");
        when.className = "set-dev-when";
        when.textContent = r.current ? "This device" : `Active ${Hud.relTime(r.lastUsedAt)}`;
        meta.append(name, when);
        row.append(meta);
        if (!r.current) {
          const rev = document.createElement("button");
          rev.className = "set-dev-revoke";
          rev.textContent = "Sign out";
          rev.onclick = async () => {
            rev.disabled = true;
            const ok = await this.onRevokeSession?.(r.id).catch(() => false);
            if (ok) row.remove();
            else { rev.disabled = false; this.showToast("Couldn't sign that device out."); }
          };
          row.append(rev);
        }
        list.append(row);
      }
    };
    void render();
    return block;
  }

  // Account menu: who you're signed in as + Sign out — and Sign out lives ONLY
  // here. Profile SWITCHING (multiple independent save slots — Play / New Game /
  // Rename / Delete) is intentionally not exposed for now; that UX needs a rework.
  // The hooks (onSwitchProfile/onCreateProfile/onRenameProfile/onDeleteProfile)
  // and save/profiles.ts are kept intact so it can be re-added here later. The
  // friend code, adding friends, and gifting/visiting all live in the Friends panel.
  // Opened by clicking the top-right nameplate / person icon.
  openProfiles() {
    document.querySelector("#hud .prof-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg prof-bg";
    const panel = document.createElement("div");
    panel.className = "panel profiles";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = "Account";
    panel.append(x, h);

    const acctBlock = this.buildAccountBlock();
    if (acctBlock) {
      panel.append(acctBlock);
      const devices = this.buildDevicesBlock();
      if (devices) panel.append(devices);
    } else {
      // Offline build or signed out: nothing to manage here.
      const note = document.createElement("div");
      note.className = "fr-empty";
      note.textContent = "Playing offline.";
      panel.append(note);
    }

    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  /** Confirm a destructive social action before touching local or server state. */
  private confirmFriendAction(
    friend: Friend,
    action: "remove" | "block",
    onConfirm: () => void | Promise<void>
  ) {
    document.querySelector("#hud .fr-confirm-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg fr-confirm-bg";
    const panel = document.createElement("div");
    panel.className = "panel confirm-panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const h = document.createElement("h2");
    h.textContent = action === "block" ? "Block this friend?" : "Remove this friend?";
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    const name = document.createElement("b");
    name.textContent = friend.name;
    msg.append(action === "block" ? "Block " : "Remove ", name, "?");
    const warning = document.createElement("span");
    warning.className = "confirm-warn";
    warning.textContent = action === "block"
      ? "They will be removed and prevented from sending future friend requests or gifts."
      : "They will be removed from your friends list.";
    msg.append(document.createElement("br"), warning);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => bg.remove();
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = action === "block" ? "Block" : "Remove";
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await onConfirm();
        bg.remove();
      } catch {
        confirm.disabled = false;
        cancel.disabled = false;
        this.showToast(action === "block" ? "Couldn't block that friend." : "Couldn't remove that friend.");
      }
    };
    btns.append(cancel, confirm);
    panel.append(x, h, msg, btns);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Friends panel. Two modes, chosen at open time:
  //   • Offline (no server configured, or signed out): the local friends stub —
  //     add by NAME, gift locally, remove. Same as before online landed.
  //   • Online (signed in): server-backed — your shareable code up top, a gift
  //     inbox to claim, friends synced from the server, add by CODE, gift via the
  //     server (which owns the once-per-day limit).
  // Reuses the prof-* / fr-* styles.
  private openFriends() {
    document.querySelector("#hud .fr-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg fr-bg";
    const panel = document.createElement("div");
    panel.className = "panel profiles";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = "Friends";
    const note = document.createElement("div");
    note.className = "fr-note";
    const acctBar = document.createElement("div");
    acctBar.className = "fr-acct";
    const requestsWrap = document.createElement("div");
    const inboxWrap = document.createElement("div");
    const list = document.createElement("div");
    list.className = "prof-list";
    panel.append(x, h, note, acctBar, requestsWrap, inboxWrap, list);

    const canOnline = this.onlineAvailable?.() ?? false;
    const online = () => this.socialOnline?.() ?? false;

    const giftErr = (e: string | null): string | null =>
      e === null ? null
        : e === "already_gifted_today" ? "You already gifted them today."
        : e === "not_friends" ? "You're not friends yet."
        : e === "recipient_inbox_full" ? "Their gift inbox is full right now."
        : e === "rate_limited" ? "Slow down a moment, then try again."
        : /offline|not_configured|no_session/.test(e) ? "You're offline right now."
        : "Couldn't send the gift.";
    // Add-by-code is consent-based and non-oracle: a well-formed call always
    // succeeds ("request sent") whether or not the code exists, so there's no
    // "no such player" message to leak. Only local/transport problems surface.
    const addErr = (e: string | null): string | null =>
      e === null ? null
        : e === "bad_code" ? "Enter a code like ZF-ABCDEFGHIJ."
        : e === "rate_limited" ? "Slow down a moment, then try again."
        : /offline|not_configured|no_session/.test(e) ? "You're offline right now."
        : "Couldn't send that request.";

    const renderAcct = () => {
      acctBar.innerHTML = "";
      if (!canOnline) return; // no server → no account UI at all
      if (online()) {
        const acct = this.myAccount?.();
        const who = document.createElement("div");
        who.className = "fr-who";
        // textContent (not innerHTML) for the display name: never build markup from
        // account-controlled strings, even though usernames are server-validated to
        // exclude markup chars. Defense in depth (see SECURITY.md A9).
        who.append("Signed in as ");
        const b = document.createElement("b");
        b.textContent = acct?.name ?? "Player";
        who.appendChild(b);
        const code = document.createElement("span");
        code.className = "fr-code";
        code.textContent = acct?.friendCode ?? "";
        this.makeCopyable(code, acct?.friendCode ?? "");
        who.appendChild(code);
        // Rotate the friend code (invalidate an over-shared/leaked one).
        if (this.onRotateCode) {
          const rot = document.createElement("button");
          rot.className = "prof-btn fr-rotate";
          rot.textContent = "New code";
          rot.title = "Get a fresh friend code (your old one stops working)";
          rot.onclick = async () => {
            rot.disabled = true;
            const nc = await this.onRotateCode?.();
            if (nc) { this.showToast("New friend code generated."); renderAcct(); }
            else { this.showToast("Couldn't rotate your code."); rot.disabled = false; }
          };
          who.appendChild(rot);
        }
        // Sign out lives in the Profile menu now (top-right profile icon); the
        // friend code stays here for the friends flow.
        acctBar.append(who);
      } else {
        const prompt = document.createElement("div");
        prompt.className = "fr-who";
        prompt.textContent = "Sign in to add friends and send brains online:";
        const mount = document.createElement("div");
        mount.className = "fr-gsi";
        acctBar.append(prompt, mount);
        this.renderAuthButton?.(mount);
      }
    };

    const renderInbox = () => {
      inboxWrap.innerHTML = "";
      if (!online()) return;
      const gifts = this.getInbox?.() ?? [];
      if (!gifts.length) return;
      const hd = document.createElement("div");
      hd.className = "fr-inbox-h";
      hd.textContent = `🎁 Gifts for you (${gifts.length})`;
      inboxWrap.appendChild(hd);
      for (const g of gifts) {
        const row = document.createElement("div");
        row.className = "prof-row fr-inbox-row";
        const nm = document.createElement("div");
        nm.className = "prof-name";
        nm.append("🧠 Brain from ");
        const bfrom = document.createElement("b");
        bfrom.textContent = g.fromName; // textContent: no markup from account strings
        nm.appendChild(bfrom);
        const claim = document.createElement("button");
        claim.className = "prof-btn play";
        claim.textContent = "Claim";
        claim.onclick = async () => {
          claim.disabled = true;
          await this.onClaimGift?.(g.id);
          this.showToast(`Claimed a brain from ${g.fromName}! 🧠`);
          await refresh();
        };
        row.append(nm, claim);
        inboxWrap.appendChild(row);
      }
    };

    const renderRequests = () => {
      requestsWrap.innerHTML = "";
      if (!online()) return;
      const reqs = this.getRequests?.() ?? [];
      if (!reqs.length) return;
      const hd = document.createElement("div");
      hd.className = "fr-inbox-h";
      hd.textContent = `👋 Friend requests (${reqs.length})`;
      requestsWrap.appendChild(hd);
      for (const r of reqs) {
        const row = document.createElement("div");
        row.className = "prof-row fr-req-row";
        const nm = document.createElement("div");
        nm.className = "prof-name";
        nm.textContent = r.name; // account-controlled → textContent, never innerHTML
        const acts = document.createElement("div");
        acts.className = "prof-actions";
        const accept = document.createElement("button");
        accept.className = "prof-btn play";
        accept.textContent = "Accept";
        accept.onclick = async () => {
          accept.disabled = true;
          const err = await (this.onAcceptRequest?.(r.fromAccountId) ?? Promise.resolve("offline"));
          if (err) { this.showToast("Couldn't accept that request."); accept.disabled = false; }
          else { this.showToast(`You and ${r.name} are now friends! 🧟`); await refresh(); }
        };
        const reject = document.createElement("button");
        reject.className = "prof-btn del";
        reject.textContent = "Ignore";
        reject.onclick = async () => {
          reject.disabled = true;
          await this.onRejectRequest?.(r.fromAccountId);
          await refresh();
        };
        acts.append(accept, reject);
        row.append(nm, acts);
        requestsWrap.appendChild(row);
      }
    };

    const renderList = () => {
      const friends = this.getFriends?.() ?? [];
      list.innerHTML = "";
      if (!friends.length) {
        const empty = document.createElement("div");
        empty.className = "fr-empty";
        empty.textContent = online()
          ? "No friends yet. Add one by their code below."
          : "No friends yet. Add one below to get started.";
        list.appendChild(empty);
      }
      for (const f of friends) {
        const row = document.createElement("div");
        row.className = "prof-row";
        const nm = document.createElement("div");
        nm.className = "prof-name";
        nm.textContent = f.name;
        if (!online() && f.giftsSent > 0) {
          const b = document.createElement("span");
          b.className = "prof-badge fr-gifts";
          b.textContent = `🧠 ${f.giftsSent}`;
          b.title = `${f.giftsSent} brain${f.giftsSent === 1 ? "" : "s"} gifted`;
          nm.appendChild(b);
        }
        const acts = document.createElement("div");
        acts.className = "prof-actions";
        const gift = document.createElement("button");
        gift.className = "prof-btn play fr-gift";
        const giftCoolingDown = online()
          ? !!f.giftOnCooldown
          : !canGiftBrain(f, Date.now());
        gift.disabled = giftCoolingDown;
        gift.textContent = giftCoolingDown ? "Gifted 🧠" : "Gift 🧠";
        gift.title = giftCoolingDown
          ? "You already gifted this friend during the current cooldown."
          : "Send this friend a brain";
        gift.onclick = async () => {
          if (online()) {
            gift.disabled = true;
            const err = giftErr(await (this.onGiftBrainOnline?.(f.id) ?? Promise.resolve("offline")));
            if (err) { this.showToast(err); gift.disabled = false; }
            else {
              f.giftOnCooldown = true;
              this.showToast(`Sent a brain to ${f.name}! 🧠`);
              renderList();
            }
          } else {
            if (this.onGiftBrain?.(f.id)) {
              this.showToast(`Sent a brain to ${f.name}! 🧠`);
              renderList();
            }
          }
        };
        acts.appendChild(gift);
        // Visit (online only): open a read-only view of this friend's farm. f.id
        // is the friend's account id server-side, which the visit fetch needs.
        if (online()) {
          const visit = document.createElement("button");
          visit.className = "prof-btn play fr-visit";
          visit.textContent = "Visit 👁";
          visit.title = `Look around ${f.name}'s farm (read-only)`;
          visit.onclick = () => this.onVisitFriend?.(f.id, f.name);
          acts.appendChild(visit);
          // Unfriend / block (online). Remove tears down the edge; Block also
          // prevents re-adding and future gifts.
          const del = document.createElement("button");
          del.className = "prof-btn del";
          del.textContent = "Remove";
          del.onclick = () => this.confirmFriendAction(f, "remove", async () => {
            await this.onRemoveFriend?.(f.id);
            await refresh();
          });
          const block = document.createElement("button");
          block.className = "prof-btn del fr-block";
          block.textContent = "Block";
          block.title = `Block ${f.name} (removes them and stops future requests/gifts)`;
          block.onclick = () => this.confirmFriendAction(f, "block", async () => {
            await this.onBlockFriend?.(f.id);
            this.showToast(`Blocked ${f.name}.`);
            await refresh();
          });
          acts.append(del, block);
        }
        if (!online()) {
          const del = document.createElement("button");
          del.className = "prof-btn del";
          del.textContent = "Remove";
          del.onclick = () => this.confirmFriendAction(f, "remove", async () => {
            await this.onRemoveFriend?.(f.id);
            renderList();
          });
          acts.appendChild(del);
        }
        row.append(nm, acts);
        list.appendChild(row);
      }
      // Add-friend row: by code online, by name offline.
      const newRow = document.createElement("div");
      newRow.className = "prof-row prof-new";
      const inp = document.createElement("input");
      inp.className = "prof-input";
      inp.placeholder = online() ? "Friend code (ZF-XXXX)" : "Friend name";
      inp.maxLength = 24;
      const add = document.createElement("button");
      add.className = "prof-btn play";
      add.textContent = "Add";
      const commit = async () => {
        const v = inp.value.trim();
        if (!v) return;
        if (online()) {
          add.disabled = true;
          const err = addErr(await (this.onAddFriendCode?.(v) ?? Promise.resolve("offline")));
          if (err) { this.showToast(err); add.disabled = false; return; }
          // Consent-based: this sends a request they must accept (or, if they'd
          // already requested you, you become friends immediately).
          this.showToast("Friend request sent!");
          inp.value = "";
          add.disabled = false;
          await refresh();
        } else {
          this.onAddFriend?.(v);
          renderList();
        }
      };
      add.onclick = commit;
      inp.onkeydown = (e) => { if (e.key === "Enter") void commit(); };
      newRow.append(inp, add);
      list.appendChild(newRow);
    };

    const renderNote = () => {
      note.textContent = !canOnline
        ? "Send a friend a brain each day. (Local list — sign-in isn't set up on this build.)"
        : online()
          ? "Share your code so friends can add you, then send each friend a brain a day."
          : "Sign in to connect with friends online. You can still keep a local list below.";
    };

    const renderAll = () => { renderNote(); renderAcct(); renderRequests(); renderInbox(); renderList(); };
    const refresh = async () => {
      if (online()) {
        try {
          await this.refreshFriends?.();
          await this.refreshRequests?.();
          await this.refreshInbox?.();
        } catch { /* stay on cached data */ }
      }
      renderAll();
    };

    renderAll();      // paint immediately from cache
    void refresh();   // then pull fresh server data (online only)

    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // A closeable modal: the zombie's trading-card (portrait, name board, veterancy /
  // type / invasions) on the LEFT, and its stats (icon row) over abilities (icon
  // row) on the RIGHT. Tapping a stat or ability icon shows a small tooltip that
  // any further interaction dismisses.
  /** Build the inspect "card" (trading card + stats + abilities) for one zombie.
   *  Stat/ability tooltips attach to `host` (a position:relative, non-clipped
   *  container). Shared by the single-zombie modal and the Zombies list. */
  private buildZombieCard(info: ZombieInfo, host: HTMLElement): HTMLElement {
    // --- tooltip: one small popup at a time; any interaction dismisses it ---
    let tip: HTMLElement | null = null;
    const closeTip = () => { tip?.remove(); tip = null; };
    const showTip = (anchor: HTMLElement, title: string, body: string) => {
      closeTip();
      tip = document.createElement("div");
      tip.className = "ztip";
      tip.innerHTML = `<b>${title}</b><span>${body}</span>`;
      host.appendChild(tip);
      const ar = anchor.getBoundingClientRect();
      const pr = host.getBoundingClientRect();
      tip.style.left = `${ar.left - pr.left + ar.width / 2}px`;
      tip.style.top = `${ar.top - pr.top - 8}px`;
      // The NEXT pointer-down anywhere closes it (this click's down already fired).
      document.addEventListener("pointerdown", closeTip, { capture: true, once: true });
    };

    const wrap = document.createElement("div");
    wrap.className = "zdetail";

    // ---- LEFT: the card ----
    const card = document.createElement("div");
    card.className = "zcard";
    card.innerHTML =
      `<span class="zcard-nail tl"></span><span class="zcard-nail tr"></span>` +
      `<div class="zcard-board">${info.name}</div>`;
    const port = document.createElement("div");
    port.className = "zcard-port";
    port.style.backgroundImage = `url(${info.portrait})`;
    const meta = document.createElement("div");
    meta.className = "zcard-meta";
    const vetPct = Math.round((veterancyMultiplier(info.invasions) - 1) * 100);
    meta.innerHTML =
      `<div class="zvet">${veterancy(info.invasions)}` +
      (vetPct > 0 ? ` <span class="zvet-b">+${vetPct}% stats</span>` : "") +
      `</div>` +
      `<div class="ztype">${info.typeName}</div>` +
      `<div class="zinv">Invasions: ${info.invasions}</div>`;
    card.append(port, meta);

    // ---- RIGHT: stats (top) + abilities (bottom), both horizontal ----
    const right = document.createElement("div");
    right.className = "zright";

    const statsHdr = document.createElement("div");
    statsHdr.className = "zsec-h";
    statsHdr.textContent = "Stats";
    const statsRow = document.createElement("div");
    statsRow.className = "zrow zstats";
    // Stats are always shown as whole numbers (species base stats can be fractional).
    const statVal: Record<string, number> = {
      str: Math.round(info.str), dex: Math.round(info.dex),
      con: Math.round(info.con), focus: Math.round(info.focus),
    };
    // Which stats a mutation is boosting — those numbers render green.
    const mutBonus = mutationBonus(info.mutation);
    for (const s of STATS) {
      // authentic layout: white glyph on the purple tile + value in the black box
      const boosted = (mutBonus as Record<string, number>)[s.key] > 0;
      const cell = document.createElement("button");
      cell.className = "zstat";
      cell.innerHTML =
        `<span class="zstat-tile" style="background-image:url(${STAT_TILE})">` +
        `<img src="${s.icon}" alt=""></span>` +
        `<span class="zstat-val${boosted ? " boosted" : ""}" style="background-image:url(${VALUE_END}),url(${VALUE_FILL})">` +
        `${statVal[s.key]}</span>`;
      cell.onclick = (e) => {
        e.stopPropagation();
        const body = boosted ? `${s.desc}<br><span class="zeff">Boosted by mutation (+${mutBonus[s.key as "str" | "con" | "dex"]}).</span>` : s.desc;
        showTip(cell, s.label, body);
      };
      statsRow.appendChild(cell);
    }

    const abilHdr = document.createElement("div");
    abilHdr.className = "zsec-h";
    abilHdr.textContent = "Abilities";
    const abilRow = document.createElement("div");
    abilRow.className = "zrow zabils";
    // A zombie shows its GROUP's one ability per tier, for tiers 1..(colour-class
    // rank): Green=t1, Blue=t1-2, Red=t1-3, Silver+ = t1-4 (so never more than 4).
    // An ability that's been unlocked shows the real icon; still-locked ones show a
    // padlock naming the boss. Some groups (Small) have no ability at low tiers, so
    // their abilities only appear on higher-class units.
    const rank = Math.min(MAX_ABILITY_TIER, classTierRank(info.className));
    for (let t = 1; t <= rank; t++) {
      const key = unitAbilityAt(info.key, info.group, t);
      if (!key) continue; // no ability at this tier for this unit
      const meta = ABILITY_POOL[key];
      if (!meta) continue;
      const cell = document.createElement("button");
      cell.style.backgroundImage = `url(${ABILITY_FRAME})`;
      if (this.state.abilityUnlocked(key)) {
        cell.className = "zabil";
        cell.innerHTML = `<img src="${meta.icon}" alt="">`;
        cell.onclick = (e) => {
          e.stopPropagation();
          // Skip the effect line when it just repeats the name (stat buffs).
          const body = meta.effect && meta.effect !== meta.label
            ? `<span class="zeff">${meta.effect}</span> ${meta.desc}`
            : meta.desc;
          showTip(cell, meta.label, body);
        };
      } else {
        cell.className = "zabil locked";
        cell.innerHTML = `<span class="zlock">🔒</span>`;
        const boss = TIER_BOSS[t];
        cell.onclick = (e) => {
          e.stopPropagation();
          showTip(cell, meta.label, `Defeat ${boss} to unlock this ability.`);
        };
      }
      abilRow.appendChild(cell);
    }
    if (!abilRow.childElementCount) {
      const none = document.createElement("div");
      none.className = "zabil-none";
      none.textContent = "No abilities at this rank.";
      abilRow.appendChild(none);
    }

    right.append(statsHdr, statsRow, abilHdr, abilRow);
    wrap.append(card, right);
    return wrap;
  }

  openZombieInfo(info: ZombieInfo, refresh?: () => void) {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel zpanel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const wrap = this.buildZombieCard(info, panel);
    panel.append(x, wrap);

    // Roster actions (only when this is an owned, id'd unit).
    if (info.id) {
      const btns = document.createElement("div");
      btns.className = "zbtns";
      const mk = (label: string, cls: string, enabled: boolean, fn: () => void | Promise<void>) => {
        const b = document.createElement("button");
        b.className = `zbtn ${cls}`;
        b.textContent = label;
        b.disabled = !enabled;
        b.onclick = async () => {
          b.disabled = true;
          bg.remove();
          await fn();
          refresh?.();
        };
        return b;
      };
      if (info.stored) {
        const canDeploy = this.canDeployZombie ? this.canDeployZombie() : true;
        btns.appendChild(mk(canDeploy ? "Deploy to farm" : "Farm full", "deploy", canDeploy,
          () => this.onZombieDeploy?.(info.id!)));
      } else {
        const canStore = this.canStoreZombies ? this.canStoreZombies() : true;
        btns.appendChild(mk("Locate", "locate", true, () => this.onZombieLocate?.(info.id!)));
        btns.appendChild(mk(canStore ? "Store" : "Need Mausoleum", "store", canStore,
          () => this.onZombieStore?.(info.id!)));
      }
      // Selling is permanent, so it routes through a confirmation window (guards
      // against dumping a rare/veteran unit by mistake). The value is shown up
      // front on the button so the player sees what the zombie is worth.
      const value = zombieSellValue(this.zombieBaseCost?.(info.key) ?? 0);
      const sell = document.createElement("button");
      sell.className = "zbtn sell";
      sell.textContent = `Sell +${value}g`;
      sell.onclick = () => {
        bg.remove();
        this.confirmSellZombie(info, value, refresh);
      };
      btns.appendChild(sell);
      panel.append(btns);
    }

    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Confirmation window for selling a zombie. Names the unit, shows the gold it
  // fetches, and warns that the sale is permanent — so a valuable zombie is not
  // sold by a single stray tap. Confirm sells; Cancel backs out to the roster.
  private confirmSellZombie(info: ZombieInfo, value: number, refresh?: () => void) {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel confirm-panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const h = document.createElement("h2");
    h.textContent = "Sell this zombie?";
    const por = document.createElement("div");
    por.className = "obj-por";
    if (info.portrait) por.style.backgroundImage = `url(${info.portrait})`;
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.innerHTML =
      `Sell <b>${info.name}</b> (${info.typeName}) for <b>+${value}g</b>?` +
      `<br><span class="confirm-warn">This is permanent — the zombie is gone for good.</span>`;

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => bg.remove();
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = `Sell +${value}g`;
    confirm.onclick = async () => {
      confirm.disabled = true;
      bg.remove();
      await this.onZombieSell?.(info.id!);
      refresh?.();
    };
    btns.append(cancel, confirm);

    panel.append(x, h, por, msg, btns);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Info popup for the crop/zombie still growing in the plot at (col,row): its
  // type, the time left until harvest, and an Insta-Grow button that ripens it on
  // the spot. `getInfo` is re-read on a timer so the countdown ticks live and
  // flips to "Ready to harvest!" the moment it ripens (whether by the boost or by
  // waiting it out).
  openCropInfo(
    getInfo: () => { name: string; isZombie: boolean; ripe: boolean; remainingMs: number } | null) {
    const first = getInfo();
    if (!first) return;
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel crop-info";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    let timer: number | undefined;
    const close = () => { if (timer !== undefined) clearInterval(timer); bg.remove(); };
    x.onclick = close;

    const h = document.createElement("h2");
    h.textContent = first.name;
    const kind = document.createElement("p");
    kind.className = "crop-kind";
    kind.textContent = first.isZombie ? "Growing zombie" : "Growing crop";
    const time = document.createElement("p");
    time.className = "crop-time";

    // Insta-Grow row: icon + "Insta-Grow (xN)" + Use button. Using it consumes one
    // stacked use (the rest stay available) and ripens this crop immediately. The
    // row hides once ripe (nothing left to speed up) and disables at 0 uses.
    const boost = this.getSpeedGrowBoost?.() ?? null;
    const grow = document.createElement("div");
    grow.className = "crop-grow";
    let growCount: HTMLSpanElement | undefined;
    let growBtn: HTMLButtonElement | undefined;
    if (boost) {
      const icon = document.createElement("img");
      icon.src = boost.icon;
      const label = document.createElement("div");
      label.className = "crop-grow-label";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = boost.name;
      growCount = document.createElement("span");
      growCount.className = "ct";
      label.append(nm, growCount);
      growBtn = document.createElement("button");
      growBtn.className = "zbtn deploy crop-grow-btn";
      growBtn.textContent = "Equip";
      growBtn.onclick = () => {
        close();
        // None owned -> Market's Boosts tab to buy; otherwise equip the Insta-Grow
        // tool so the player can tap each crop they want to ripen.
        if (boost.count() <= 0) { this.openMarket("Boosts"); return; }
        this.setMode("instagrow");
      };
      grow.append(icon, label, growBtn);
    }

    const fmt = (ms: number) => {
      const s = Math.ceil(ms / 1000);
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
      return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    };
    const tick = () => {
      const cur = getInfo();
      if (!cur) { close(); return; } // crop harvested/removed elsewhere
      if (cur.ripe) {
        time.textContent = "Ready to harvest!";
        time.classList.add("ripe");
      } else {
        time.textContent = `Ready in ${fmt(cur.remainingMs)}`;
        time.classList.remove("ripe");
      }
      if (boost && growCount && growBtn) {
        const n = boost.count();
        growCount.textContent = `x${n}`;
        // Nothing to speed up once ripe; no uses left -> point to the Market.
        grow.style.display = cur.ripe ? "none" : "flex";
        // At 0 uses the button becomes a "Buy" shortcut to the Market's Boosts tab;
        // otherwise it equips the Insta-Grow tool.
        growBtn.disabled = false;
        growBtn.textContent = n <= 0 ? "Buy" : "Equip";
        growBtn.title = n <= 0
          ? "Buy Insta-Grow in the Market's Boosts tab"
          : "Equip the Insta-Grow tool, then tap crops to ripen them";
      }
    };
    tick();
    timer = window.setInterval(tick, 500);

    panel.append(x, h, kind, time);
    if (boost) panel.append(grow);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) close(); };
    this.el.appendChild(bg);
  }

  /** Convert a roster entry into the inspectable ZombieInfo shape. */
  private rosterInfo(z: RosterEntry): ZombieInfo {
    return {
      name: z.name, typeName: z.typeName, key: z.key, group: z.group,
      className: z.className, classColor: z.classColor,
      str: z.str * this.state.farmerZombieStrengthMult(), dex: z.dex,
      con: z.con * this.state.farmerZombieLifeMult(), focus: z.focus, mutation: z.mutation,
      invasions: z.invasions,
      portrait: this.zombiePortraitOf ? this.zombiePortraitOf(z.key) : "",
      id: z.id, stored: z.stored,
    };
  }

  // The "Zombies" tab (right bar): a scrollable list where every owned zombie is
  // represented by its full inspect card (the same one shown when tapping a zombie).
  openZombieList() {
    document.querySelector("#hud .zl-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg zl-bg";
    const panel = document.createElement("div");
    panel.className = "panel zl-panel"; // position:relative host for card tooltips
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const head = document.createElement("div");
    head.className = "zr-head";
    const list = document.createElement("div");
    list.className = "zl-list";
    panel.append(x, head, list);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    // Show the complete owned roster here as a safety net for earned zombies. A boss
    // reward sent to storage remains visible and deployable even before the player
    // opens (or has room in) the physical Mausoleum panel.
    const roster = this.getRoster ? this.getRoster() : [];
    const onFarm = roster.filter((r) => !r.stored).length;
    const stored = roster.length - onFarm;
    const title = document.createElement("h2");
    title.textContent = "Your Zombies";
    const cnt = document.createElement("span");
    cnt.className = "zr-total";
    cnt.textContent = `${onFarm} on farm${stored ? ` · ${stored} stored` : ""}`;
    head.append(title, cnt);

    if (!roster.length) {
      const e = document.createElement("div");
      e.className = "zr-empty";
      e.textContent = "You do not own any zombies yet.";
      list.appendChild(e);
      return;
    }
    for (const z of roster) {
      const row = document.createElement("div");
      row.className = "zl-row";
      row.appendChild(this.buildZombieCard(this.rosterInfo(z), panel));
      list.appendChild(row);
    }
  }

  // The Mausoleum (tap the building): a fixed set of storage slots. Filled slots
  // hold stored zombies (tap to inspect / deploy back); empty slots are tapped to
  // move a zombie in off the farm. On-farm zombies do NOT appear here.
  openMausoleum() {
    document.querySelector("#hud .zr-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg zr-bg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const wrap = document.createElement("div");
    wrap.className = "zroster";
    const head = document.createElement("div");
    head.className = "zr-head";
    const grid = document.createElement("div");
    grid.className = "zr-grid";
    wrap.append(head, grid);
    panel.append(x, wrap);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    const render = () => {
      const roster = this.getRoster ? this.getRoster() : [];
      const stored = roster.filter((r) => r.stored);
      const cap = this.mausoleumCap;
      head.innerHTML = "";
      const title = document.createElement("h2");
      title.textContent = "Mausoleum";
      const cnt = document.createElement("span");
      cnt.className = "zr-total";
      cnt.textContent = `${stored.length} / ${cap} stored`;
      head.append(title, cnt);

      grid.innerHTML = "";
      // Reward grants are never discarded. If a full Mausoleum receives an Epic
      // reward, expose the protected overflow slot instead of hiding the zombie.
      for (let i = 0; i < Math.max(cap, stored.length); i++) {
        const z = stored[i];
        if (z) {
          grid.appendChild(this.buildRosterCard(z, () => this.openZombieInfo(this.rosterInfo(z), render)));
        } else {
          const slot = document.createElement("div");
          slot.className = "zr-card zr-slot-empty";
          slot.innerHTML =
            `<div class="zr-por zr-por-empty"><span class="zr-plus">+</span></div>` +
            `<div class="zr-name">Empty</div>`;
          slot.title = "Store a zombie from the farm";
          slot.onclick = () => this.pickZombieToStore(render);
          grid.appendChild(slot);
        }
      }
    };
    render();
  }

  // Empty-slot picker: choose an on-farm zombie to move into the Mausoleum.
  private pickZombieToStore(afterStore: () => void) {
    document.querySelector("#hud .zpick-bg")?.remove();
    const roster = this.getRoster ? this.getRoster() : [];
    const onFarm = roster.filter((r) => !r.stored);
    const bg = document.createElement("div");
    bg.className = "panelbg zpick-bg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const wrap = document.createElement("div");
    wrap.className = "zroster";
    const head = document.createElement("div");
    head.className = "zr-head";
    head.innerHTML = `<h2>Store a Zombie</h2><span class="zr-total">Tap one to store</span>`;
    const grid = document.createElement("div");
    grid.className = "zr-grid";
    wrap.append(head, grid);
    panel.append(x, wrap);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    if (!onFarm.length) {
      const e = document.createElement("div");
      e.className = "zr-empty";
      e.textContent = "No zombies on the farm to store.";
      grid.appendChild(e);
      return;
    }
    for (const z of onFarm) {
      grid.appendChild(
        this.buildRosterCard(z, async () => {
          await this.onZombieStore?.(z.id);
          bg.remove();
          afterStore();
        })
      );
    }
  }

  // ---- Zombie Pot: combine two zombies (tap the placed Zombie Pot) ----
  openCombiner() {
    document.querySelector("#hud .cmb-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg cmb-bg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => { stop(); bg.remove(); };
    const wrap = document.createElement("div");
    wrap.className = "cmb";
    panel.append(x, wrap);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) { stop(); bg.remove(); } };
    this.el.appendChild(bg);

    const portraitOf = (key: string) => this.zombiePortraitOf?.(key) ?? "";
    const fmt = (ms: number) => {
      const s = Math.ceil(ms / 1000);
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
      return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    };

    // Selection state for the idle (pick-two) view.
    let pickA: string | null = null;
    let pickB: string | null = null;
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };

    // --- BUSY / READY view: progress bar + Collect ---
    const renderBusy = () => {
      const st = this.getPotStatus?.();
      if (!st || !st.busy) { stop(); renderIdle(); return; }
      wrap.innerHTML = "";
      const head = document.createElement("div");
      head.className = "cmb-head";
      head.innerHTML = `<h2>Zombie Pot</h2>`;
      const t = document.createElement("span");
      t.className = "cmb-time";
      head.appendChild(t);

      // Show the two parents going in (from the pending job's keys + masks).
      const slots = document.createElement("div");
      slots.className = "cmb-slots";
      const parent = (key: string, mask: number) => {
        const d = document.createElement("div");
        d.className = "cmb-slot filled";
        const p = document.createElement("div");
        p.className = "cmb-por";
        p.style.backgroundImage = `url(${portraitOf(key)})`;
        const mut = document.createElement("div");
        mut.className = "cmb-sm";
        mut.textContent = mutationLabel(mask) || "no mutations";
        d.append(p, mut);
        return d;
      };
      const plus = document.createElement("div");
      plus.className = "cmb-plus";
      plus.textContent = "+";
      slots.append(parent(st.pending!.keyA, st.pending!.maskA), plus,
        parent(st.pending!.keyB, st.pending!.maskB));

      const bar = document.createElement("div");
      bar.className = "cmb-prog";
      const fill = document.createElement("i");
      bar.appendChild(fill);
      const note = document.createElement("div");
      note.className = "cmb-note";

      const go = document.createElement("button");
      go.className = "cmb-go";
      go.textContent = "Collect";
      go.onclick = async () => {
        go.disabled = true;
        const name = await this.onCollectCombine?.();
        if (name) { stop(); renderIdle(); }
      };
      wrap.append(head, slots, bar, note, go);

      const tick = () => {
        const s = this.getPotStatus?.();
        if (!s || !s.busy) { stop(); renderIdle(); return; }
        const prog = s.totalMs > 0 ? (s.totalMs - s.remainingMs) / s.totalMs : 1;
        fill.style.width = `${Math.min(100, prog * 100)}%`;
        t.textContent = s.ready ? "Ready!" : fmt(s.remainingMs);
        note.textContent = s.ready
          ? "The combine is done — collect your new zombie."
          : `Combining… ${fmt(s.remainingMs)} left` + (s.monolith ? " (Monolith: ×½)" : "");
        go.disabled = !s.ready;
      };
      tick();
      stop();
      timer = window.setInterval(tick, 250);
    };

    // --- IDLE view: pick two zombies, then Combine ---
    const renderIdle = () => {
      stop();
      const st = this.getPotStatus?.();
      if (st?.busy) { renderBusy(); return; }
      wrap.innerHTML = "";
      const roster = (this.getRoster?.() ?? []).filter((zombie) =>
        this.canCombineZombie?.(zombie.key) ?? true
      );
      const head = document.createElement("div");
      head.className = "cmb-head";
      head.innerHTML = `<h2>Zombie Pot</h2>`;
      const time = document.createElement("span");
      time.className = "cmb-time";
      time.textContent = st?.monolith ? "30 min · Monolith ×½" : "1 hour";
      head.appendChild(time);

      const slots = document.createElement("div");
      slots.className = "cmb-slots";
      const slotEl = (which: "A" | "B") => {
        const id = which === "A" ? pickA : pickB;
        const d = document.createElement("div");
        d.className = "cmb-slot" + (id ? " filled" : "");
        const z = roster.find((r) => r.id === id);
        if (z) {
          const p = document.createElement("div");
          p.className = "cmb-por";
          p.style.backgroundImage = `url(${portraitOf(z.key)})`;
          const n = document.createElement("div");
          n.className = "cmb-sn";
          n.textContent = z.name;
          const mut = document.createElement("div");
          mut.className = "cmb-sm";
          mut.textContent = mutationLabel(z.mutation) || "no mutations";
          d.append(p, n, mut);
          d.title = "Tap to remove";
          d.onclick = () => { if (which === "A") pickA = null; else pickB = null; renderIdle(); };
        } else {
          const h = document.createElement("div");
          h.className = "cmb-hint";
          h.textContent = which === "A" ? "Pick zombie 1" : "Pick zombie 2";
          d.appendChild(h);
        }
        return d;
      };
      const plus = document.createElement("div");
      plus.className = "cmb-plus";
      plus.textContent = "+";
      slots.append(slotEl("A"), plus, slotEl("B"));

      const list = document.createElement("div");
      list.className = "cmb-list";
      if (roster.length < 2) {
        const e = document.createElement("div");
        e.className = "cmb-empty";
        e.textContent = "You need at least two zombies to combine. Grow more first!";
        list.appendChild(e);
      } else {
        for (const z of roster) {
          const chosen = z.id === pickA || z.id === pickB;
          const c = document.createElement("div");
          c.className = "cmb-z" + (chosen ? " chosen" : "");
          const p = document.createElement("div");
          p.className = "cmb-zpor";
          p.style.backgroundImage = `url(${portraitOf(z.key)})`;
          const n = document.createElement("div");
          n.className = "cmb-zn";
          n.textContent = z.name;
          c.append(p, n);
          if (z.mutation) {
            const m = document.createElement("div");
            m.className = "cmb-zmut";
            m.textContent = "M";
            m.title = mutationLabel(z.mutation);
            c.appendChild(m);
          }
          if (!chosen) {
            c.onclick = () => {
              if (!pickA) pickA = z.id;
              else if (!pickB) pickB = z.id;
              renderIdle();
            };
          }
          list.appendChild(c);
        }
      }

      const go = document.createElement("button");
      go.className = "cmb-go";
      go.textContent = "Combine";
      go.disabled = !(pickA && pickB);
      go.onclick = async () => {
        if (!pickA || !pickB) return;
        go.disabled = true;
        const ok = await this.onCombine?.(pickA, pickB);
        if (ok) { pickA = pickB = null; renderBusy(); }
        else renderIdle();
      };
      wrap.append(head, slots, list, go);
    };

    const st0 = this.getPotStatus?.();
    if (st0?.busy) renderBusy(); else renderIdle();
  }

  /** A framed zombie tile (storage-shed slot style). `onClick` is the tap action. */
  private buildRosterCard(z: RosterEntry, onClick: () => void): HTMLElement {
    const card = document.createElement("div");
    card.className = "zr-card";
    const por = document.createElement("div");
    por.className = "zr-por"; // framed slot (matches the storage-shed item tiles)
    const portrait = this.zombiePortraitOf ? this.zombiePortraitOf(z.key) : "";
    const pim = document.createElement("img");
    pim.className = "zr-por-img";
    if (portrait) pim.src = portrait;
    por.appendChild(pim);
    const name = document.createElement("div");
    name.className = "zr-name";
    name.textContent = z.name;
    const cls = document.createElement("span");
    cls.className = "zr-cls";
    cls.textContent = z.className;
    cls.style.background = z.classColor;
    card.append(por, name, cls);
    card.onclick = onClick;
    return card;
  }

  // ---- Raids / Invasions ----
  /** In-game confirmation for purchasing the cooldown-bypass ticket. The purchase
   *  remains a normal catalog buy; `onBought` advances to army ordering only after
   *  the optimistic/server-backed purchase was accepted. */
  private openRaidTicketPrompt(cooldownMs: number, voucher: BoostDef, onBought: () => void) {
    document.querySelector("#hud .raid-ticket-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg raid-ticket-bg";
    const panel = document.createElement("div");
    panel.className = "panel confirm-panel";

    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const h = document.createElement("h2");
    h.textContent = "Skip the invasion wait?";
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = `This invasion is ready in ${fmtCooldown(cooldownMs)}.`;
    const warning = document.createElement("span");
    warning.className = "confirm-warn";
    warning.textContent = `Buy an Invasion Voucher for ${voucher.cost.toLocaleString()} gold to invade now?`;
    msg.append(document.createElement("br"), warning);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => bg.remove();
    const buy = document.createElement("button");
    buy.className = "zbtn sell";
    buy.textContent = `Buy Ticket · ${voucher.cost.toLocaleString()} Gold`;
    buy.onclick = () => {
      if (!this.onBuyBoost?.(voucher)) {
        this.showToast(`You need ${voucher.cost.toLocaleString()} gold for an Invasion Voucher.`);
        return;
      }
      bg.remove();
      onBought();
    };
    btns.append(cancel, buy);
    panel.append(x, h, msg, btns);
    bg.appendChild(panel);
    bg.onclick = (event) => { if (event.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Raid select: a list of invasions (left) + the selected raid's detail (right).
  // Only playable + level-met raids can be invaded; the rest show as locked cards
  // so the ladder reads as a real (mostly future) catalog.
  openRaids() {
    document.querySelector("#hud .raid-bg")?.remove();
    const cards = this.getRaidCards ? this.getRaidCards() : [];
    const party = this.getRaidParty ? this.getRaidParty() : null;
    const haveN = party ? party.eligible.length : 0;

    const bg = document.createElement("div");
    bg.className = "panelbg raid-bg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    // A 1s ticker refreshes the live cooldown countdown while the panel is open.
    let tick = 0;
    const stop = () => { if (tick) { clearInterval(tick); tick = 0; } };
    const close = () => { stop(); bg.remove(); };
    x.onclick = close;

    const wrap = document.createElement("div");
    wrap.className = "raidsel";
    const list = document.createElement("div");
    list.className = "raid-list";
    const detail = document.createElement("div");
    detail.className = "rd-detail";
    wrap.append(list, detail);
    panel.append(x, wrap);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) close(); };
    this.el.appendChild(bg);

    // Default selection: first unlocked raid, else the first card.
    let selId = (cards.find((c) => c.unlocked) ?? cards[0])?.id ?? -1;

    const renderDetail = () => {
      const c = cards.find((r) => r.id === selId);
      detail.innerHTML = "";
      if (!c) {
        detail.innerHTML = `<p class="rd-intro">No invasions available.</p>`;
        return;
      }
      const hero = document.createElement("div");
      hero.className = "rd-hero";
      const por = document.createElement("div");
      por.className = "rd-portrait";
      if (c.portrait) por.style.backgroundImage = `url(${c.portrait})`;
      const info = document.createElement("div");
      const minN = c.minArmy; // per-raid: eased for the first McDonnell clears
      const canFight = c.unlocked && haveN >= minN;
      info.innerHTML =
        `<div class="rd-title">${c.name}</div>` +
        (c.bossName ? `<div class="rd-boss">${c.bossName}</div>` : "") +
        `<div class="rd-meta">Recommended level ${c.recommendedLevel}` +
        (c.firstClearXp > 0 ? ` · First clear: ${c.firstClearXp} XP` : "") +
        `</div>`;
      hero.append(por, info);

      const intro = document.createElement("p");
      intro.className = "rd-intro";
      intro.textContent = c.lockReason && !c.unlocked
        ? (c.lockReason === "Coming soon"
            ? "This invasion isn't available yet — its battlefield is still being built."
            : `${c.introText}`)
        : c.introText;

      const rewards = document.createElement("div");
      rewards.className = "rd-rewards";
      for (const r of c.rewardPreview.slice(0, 6)) {
        const chip = document.createElement("span");
        chip.className = "rd-chip";
        chip.textContent = r;
        rewards.appendChild(chip);
      }

      const st = this.getRaidStatus
        ? this.getRaidStatus()
        : { cooldownMs: 0, voucherCount: 0 };
      const cd = st.cooldownMs;
      if (cd <= 0) stop(); // ready again — no need to keep ticking

      const foot = document.createElement("div");
      foot.className = "rd-foot";
      const army = document.createElement("span");
      army.className = "rd-army" + (haveN < minN ? " short" : "");
      army.textContent = `Zombies ready: ${haveN} (need ${minN})`;
      const go = document.createElement("button");
      go.className = "raid-go";

      // Button state: lock reason > cooldown (with optional voucher bypass) > ready.
      let useVoucher = false;
      let buyVoucher = false;
      if (!c.unlocked) {
        go.textContent = c.lockReason || "Locked";
        go.disabled = true;
      } else if (cd > 0) {
        if (st.voucherCount > 0) {
          go.textContent = "Use Voucher & Invade";
          go.disabled = !canFight;
          useVoucher = true;
          army.textContent = `${st.voucherCount} voucher${st.voucherCount > 1 ? "s" : ""} · skips the ${fmtCooldown(cd)} wait`;
        } else {
          // Buying a voucher is available from every unlocked invasion. Do not gate
          // the purchase on army size: McDonnell's eased minimum (1/4 zombies) made
          // this look tutorial-only while every other invasion normally needs 8.
          // The Army screen still enforces the selected raid's real launch minimum.
          go.textContent = "Buy Ticket & Invade";
          go.disabled = false;
          buyVoucher = true;
          army.className = "rd-army short";
          army.textContent = `Ready in ${fmtCooldown(cd)} · raid ticket: 2,000 gold`;
        }
      } else {
        go.textContent = "Invade";
        go.disabled = !canFight;
      }
      go.onclick = () => {
        if (buyVoucher) {
          const voucher = this.boosts.find((boost) => boost.key === VOUCHER_KEY);
          if (!voucher) {
            this.showToast("Invasion Vouchers are unavailable right now.");
            return;
          }
          this.openRaidTicketPrompt(cd, voucher, () => {
            close();
            this.openRaidArmy(c, true);
          });
          return;
        }
        close();
        this.openRaidArmy(c, useVoucher);
      };
      foot.append(army, go);

      detail.append(hero, intro, rewards, foot);
    };

    for (const c of cards) {
      const card = document.createElement("button");
      card.className = "rd-card" + (c.unlocked ? "" : " locked");
      const thumb = document.createElement("div");
      thumb.className = "rd-thumb";
      if (c.portrait) thumb.style.backgroundImage = `url(${c.portrait})`;
      const txt = document.createElement("div");
      const sub = c.unlocked
        ? `<div class="rd-cl">Rec. Lv ${c.recommendedLevel}</div>`
        : `<div class="rd-cl lock">${c.lockReason}</div>`;
      txt.innerHTML = `<div class="rd-cn">${c.name}</div>${sub}`;
      card.append(thumb, txt);
      card.onclick = () => {
        selId = c.id;
        for (const el of list.querySelectorAll(".rd-card")) el.classList.remove("sel");
        card.classList.add("sel");
        renderDetail();
      };
      if (c.id === selId) card.classList.add("sel");
      list.appendChild(card);
    }
    renderDetail();
    // Live-update the countdown only if a cooldown is currently active.
    if ((this.getRaidStatus?.().cooldownMs ?? 0) > 0) {
      tick = window.setInterval(renderDetail, 1000);
    }
  }

  // Army select: pick which owned zombies go on the raid. Auto-selects the
  // strongest up to the cap; toggle individual zombies; Start gated at the min.
  // `useVoucher` carries a cooldown-bypass intent from the Raid Select screen.
  openRaidArmy(raid: RaidCardView, useVoucher = false) {
    document.querySelector("#hud .army-bg")?.remove();
    const party = this.getRaidParty ? this.getRaidParty() : null;
    const bg = document.createElement("div");
    bg.className = "panelbg army-bg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    panel.appendChild(x);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    if (!party || !party.eligible.length) {
      panel.insertAdjacentHTML("beforeend",
        `<h2>Choose your army</h2><p class="rd-intro">You have no zombies to send. Grow some from zombie crops first.</p>`);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "army-wrap";
    const head = document.createElement("div");
    head.className = "army-head";
    const grid = document.createElement("div");
    grid.className = "army-grid";
    const foot = document.createElement("div");
    foot.className = "army-foot";
    wrap.append(head, grid, foot);
    panel.appendChild(wrap);

    const cap = party.cap;
    const min = raid.minArmy; // per-raid: eased for the first McDonnell clears
    // Ordered selection: index in the array = attack position (first attacks first).
    // Starts EMPTY so any cards the player clicks land at the FRONT of the order — e.g.
    // click two new headless zombies to lead, then "Pick for me" fills the rest from
    // last raid's order. Clicking a card appends it; clicking a picked card removes it
    // and renumbers the rest.
    const order: string[] = [];

    // Battle consumables for this raid: Concentration (skip the focus minigame) +
    // Golden Dice (each raises the loot to a rarer tier, capped by the raid's tier depth).
    const boosts = this.getRaidBoosts
      ? this.getRaidBoosts(raid.id)
      : { concentration: 0, dice: 0, maxDice: 0 };
    const diceMax = Math.min(boosts.dice, boosts.maxDice);
    let useConcentration = false;
    let diceChosen = 0;
    const launchOpts = (): RaidLaunchOpts => ({
      useVoucher,
      concentration: useConcentration,
      dice: diceChosen,
    });

    const start = document.createElement("button");
    start.className = "raid-go";

    const refresh = () => {
      const n = order.length;
      head.innerHTML =
        `<h2>Send your army — ${raid.name}</h2>` +
        `<span class="army-count${n < min ? " short" : ""}">${n}/${cap} · min ${min}</span>`;
      start.textContent = n < min ? `Need ${min - n} more` : `Invade with ${n}`;
      start.disabled = n < min;
      for (const el of grid.querySelectorAll<HTMLElement>(".army-card")) {
        const pos = order.indexOf(el.dataset.id!);
        el.classList.toggle("sel", pos >= 0);
        const tick = el.querySelector<HTMLElement>(".tick");
        if (tick) tick.textContent = pos >= 0 ? String(pos + 1) : "";
      }
    };

    for (const z of party.eligible) {
      const card = document.createElement("div");
      card.className = "army-card";
      card.dataset.id = z.id;
      const por = document.createElement("div");
      por.className = "army-por";
      if (z.portrait) por.style.backgroundImage = `url(${z.portrait})`;
      const nm = document.createElement("div");
      nm.className = "army-nm";
      nm.textContent = z.name;
      const ty = document.createElement("div");
      ty.className = "army-ty";
      ty.textContent = z.typeName;
      const st = document.createElement("div");
      st.className = "army-st";
      st.textContent = `S${Math.round(z.str)} D${Math.round(z.dex)} C${Math.round(z.con)}`;
      const tick = document.createElement("span");
      tick.className = "tick"; // order number, filled in by refresh()
      card.append(tick, por, nm, ty, st);
      card.onclick = () => {
        const at = order.indexOf(z.id);
        if (at >= 0) order.splice(at, 1);
        else if (order.length < cap) order.push(z.id);
        refresh();
      };
      grid.appendChild(card);
    }

    // Battle-consumable controls row (only shown when the player owns something
    // usable): a Concentration toggle and a Golden Dice stepper.
    const boostRow = document.createElement("div");
    boostRow.className = "raid-boosts";
    if (boosts.concentration > 0) {
      const cBtn = document.createElement("button");
      cBtn.className = "raid-boost-btn";
      cBtn.innerHTML = `🧠 Concentrate <span class="rb-ct">x${boosts.concentration}</span>`;
      cBtn.title = "Skip the focus minigame: zombies charge and advance on their own.";
      cBtn.onclick = () => {
        useConcentration = !useConcentration;
        cBtn.classList.toggle("on", useConcentration);
      };
      boostRow.appendChild(cBtn);
    }
    if (diceMax > 0) {
      const stepper = document.createElement("div");
      stepper.className = "raid-dice";
      const lbl = document.createElement("span");
      lbl.className = "rd-lbl";
      const dec = document.createElement("button");
      dec.className = "rd-step";
      dec.textContent = "−";
      const inc = document.createElement("button");
      inc.className = "rd-step";
      inc.textContent = "+";
      const drawDice = () => { lbl.innerHTML = `🎲 Golden Dice <b>${diceChosen}</b>/${diceMax}`; };
      dec.onclick = () => { diceChosen = Math.max(0, diceChosen - 1); drawDice(); };
      inc.onclick = () => { diceChosen = Math.min(diceMax, diceChosen + 1); drawDice(); };
      drawDice();
      stepper.append(lbl, dec, inc);
      boostRow.appendChild(stepper);
    }
    if (boostRow.childElementCount) wrap.insertBefore(boostRow, foot);

    // "Pick for me": KEEP whatever the player has already selected (in the order they
    // chose), then fill the remaining slots — first by their saved attack order from
    // last raid, then any other eligible zombies — up to the cap. So leading with a few
    // hand-picked zombies and then tapping this preserves those picks at the front and
    // reproduces the previous order behind them, instead of wiping the selection.
    const pick = document.createElement("button");
    pick.className = "raid-quick";
    pick.textContent = "Pick for me";
    pick.onclick = () => {
      for (const id of [...party.orderedSelectedIds, ...party.eligible.map((z) => z.id)]) {
        if (order.length >= cap) break;
        if (!order.includes(id)) order.push(id);
      }
      refresh();
    };

    start.onclick = async () => {
      if (order.length < min) return;
      // Always play the live battle scene — there is no instant/auto-resolve. Launch
      // may be async (an online server cooldown gate). Guard against a double-tap
      // while the gate is in flight. If it declines (cooldown, or a raid already
      // running), leave this screen up so the player can retry.
      if (!this.onLaunchRaid || start.disabled) return;
      start.disabled = true;
      const launched = await this.onLaunchRaid(raid.id, [...order], launchOpts());
      if (launched) bg.remove();
      else start.disabled = false;
    };
    foot.append(pick, start);
    refresh();
  }

  // The end-of-raid results tally (matches the real "ZOMBIES WIN" panel): it
  // slides in from the RIGHT while the survivors march off, listing the outcome
  // top-to-bottom with a finish button. `onClose` runs when the button is pressed
  // (the live scene uses it to tear itself down and return to the farm).
  openRaidResult(view: RaidResultView, onClose?: () => void) {
    const bg = document.createElement("div");
    bg.className = "raid-res-bg";
    const panel = document.createElement("div");
    panel.className = "raid-res-panel";

    const GOLD_ICON = `<img class="rr-i" src="${UI("topbar_money_icon.png")}">`;
    const BRAIN_ICON = `<img class="rr-i" src="${UI("topbar_brain_icon.png")}">`;
    const rows: [string, string, string][] = [
      ["Enemies Beaten", String(view.enemiesBeaten), ""],
      ["Zombies Lost", String(view.zombiesLost), ""],
      ["Gold Plundered", String(view.gold), GOLD_ICON],
      ["Brains Plundered", String(view.brains), BRAIN_ICON],
    ];
    // First-time XP bonus ("You earned Nxp for beating this enemy for the first
    // time.") — only shown when it was actually granted (first clear of this raid).
    if (view.xp > 0) rows.push(["First-Time XP", String(view.xp), ""]);
    const rowHtml = rows
      .map(
        ([label, val, icon]) =>
          `<div class="rr-row"><span class="rr-l">${label}</span>` +
          `<span class="rr-v">${val}${icon}</span></div>`
      )
      .join("");
    const lootHtml =
      `<div class="rr-row rr-loot"><span class="rr-l">Loot</span></div>` +
      (view.loot.length
        ? `<div class="rr-loot-items">${view.loot
            .map((l) =>
              l.icon
                ? `<span class="rr-loot-i" title="${l.name}"><img src="${l.icon}"><span>${l.name}</span></span>`
                : `<span class="rr-loot-i rr-loot-noimg">${l.name}</span>`
            )
            .join("")}</div>`
        : `<div class="rr-loot-none">—</div>`);
    const extra = view.abilityUnlock ? `<div class="rr-unlock">${view.abilityUnlock}</div>` : "";

    panel.innerHTML =
      `<div class="rr-title ${view.win ? "win" : "lose"}">${view.title}</div>` +
      `<div class="rr-body">${rowHtml}${lootHtml}${extra}</div>`;

    const done = document.createElement("button");
    done.className = "rr-go";
    done.textContent = "Finish";
    done.onclick = () => { bg.remove(); onClose?.(); };
    panel.appendChild(done);
    bg.appendChild(panel);
    this.el.appendChild(bg);
    // Trigger the slide-in on the next frame.
    requestAnimationFrame(() => panel.classList.add("in"));
  }

  /** One-time farm-return casualty event. The modal cannot be dismissed without
   * resolving it because every unselected zombie is permanently lost. */
  openZombieRevival(
    zombies: { id: string; name: string; typeName: string; portrait: string }[],
    brains: number,
    onResolve: (reviveIds: string[]) => Promise<boolean> | boolean
  ) {
    if (!zombies.length) return;
    this.el.querySelector(".revive-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "revive-bg";
    const panel = document.createElement("div");
    panel.className = "revive-panel";
    panel.innerHTML =
      `<div class="revive-title">Revive Your Zombies</div>` +
      `<div class="revive-warning">Warning: zombies you do not revive will be permanently lost.</div>` +
      `<div class="revive-balance">Available: ${brains} <img src="${UI("topbar_brain_icon.png")}" alt="brains"> · Each revival costs 1 brain.</div>`;
    const selected = new Set<string>();
    const list = document.createElement("div");
    list.className = "revive-list";
    const buttons = new Map<string, HTMLButtonElement>();
    const rows = new Map<string, HTMLElement>();
    const refresh = () => {
      for (const zombie of zombies) {
        const chosen = selected.has(zombie.id);
        rows.get(zombie.id)?.classList.toggle("selected", chosen);
        const button = buttons.get(zombie.id)!;
        button.classList.toggle("selected", chosen);
        button.textContent = chosen ? "Undo" : "Revive · 1";
        button.disabled = !chosen && selected.size >= brains;
      }
      confirm.textContent = selected.size
        ? `Revive ${selected.size} · Spend ${selected.size} Brain${selected.size === 1 ? "" : "s"}`
        : `Leave All ${zombies.length} Behind`;
    };
    for (const zombie of zombies) {
      const row = document.createElement("div");
      row.className = "revive-zombie";
      const portrait = document.createElement("img");
      portrait.src = zombie.portrait;
      portrait.alt = "";
      const label = document.createElement("div");
      const name = document.createElement("div");
      name.className = "revive-name";
      name.textContent = zombie.name;
      const type = document.createElement("div");
      type.className = "revive-type";
      type.textContent = zombie.typeName;
      label.append(name, type);
      const pick = document.createElement("button");
      pick.className = "revive-pick";
      pick.onclick = () => {
        if (selected.has(zombie.id)) selected.delete(zombie.id);
        else if (selected.size < brains) selected.add(zombie.id);
        refresh();
      };
      rows.set(zombie.id, row);
      buttons.set(zombie.id, pick);
      row.append(portrait, label, pick);
      list.appendChild(row);
    }
    const foot = document.createElement("div");
    foot.className = "revive-foot";
    const error = document.createElement("div");
    error.className = "revive-error";
    const confirm = document.createElement("button");
    confirm.className = "revive-confirm";
    confirm.onclick = async () => {
      confirm.disabled = true;
      error.textContent = "";
      try {
        if (await onResolve([...selected])) bg.remove();
        else error.textContent = "The revival could not be completed. Please try again.";
      } catch {
        error.textContent = "The revival could not be completed. Please try again.";
      } finally {
        confirm.disabled = false;
      }
    };
    foot.append(error, confirm);
    panel.append(list, foot);
    bg.appendChild(panel);
    this.el.appendChild(bg);
    refresh();
  }

  /** Fill in the loot row of an ALREADY-OPEN result panel. ONLINE the server rolls the
   *  drop (it's real value), so it lands a beat after the panel opens — the same shape as
   *  the reward reconcile. Also bumps the gold row, since a "Bonus Gold" drop pays gold
   *  rather than an item. No-op if the panel is gone (player already hit Finish). */
  setRaidResultLoot(loot: LootDrop[], gold: number) {
    const panel = this.el.querySelector(".raid-res-panel");
    if (!panel) return;
    const goldRow = panel.querySelectorAll(".rr-row")[2]?.querySelector(".rr-v");
    if (goldRow) {
      goldRow.innerHTML =
        `${gold}<img class="rr-i" src="${UI("topbar_money_icon.png")}">`;
    }
    const items = panel.querySelector(".rr-loot-items");
    const none = panel.querySelector(".rr-loot-none");
    if (!loot.length) return;
    const html = loot
      .map((l) =>
        l.icon
          ? `<span class="rr-loot-i" title="${l.name}"><img src="${l.icon}"><span>${l.name}</span></span>`
          : `<span class="rr-loot-i rr-loot-noimg">${l.name}</span>`
      )
      .join("");
    if (items) items.innerHTML = html;
    else if (none) {
      const div = document.createElement("div");
      div.className = "rr-loot-items";
      div.innerHTML = html;
      none.replaceWith(div);
    }
  }

  /** Celebratory "LEVEL UP" popup listing what the new level unlocked (invasions,
   *  market items, boosts). Fired from GameState.onLevelUpCb via main.ts. */
  openLevelUp(view: LevelUpView) {
    document.querySelector("#hud .lvl-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg lvl-bg";
    const panel = document.createElement("div");
    panel.className = "panel lvlup";

    const brainRow = view.brains
      ? `<div class="lvl-reward"><img src="${UI("topbar_brain_icon.png")}"> +${view.brains} ` +
        `${view.brains === 1 ? "brain" : "brains"}</div>`
      : "";
    const unlockHtml = view.unlocks.length
      ? `<div class="lvl-sub">Unlocked</div><div class="lvl-unlocks">${view.unlocks
          .map(
            (u) =>
              `<span class="lvl-slot" title="${u.name}"><span class="lvl-frame">` +
              `<img src="${u.icon}" onerror="this.style.visibility='hidden'"></span>` +
              `<span class="lvl-nm">${u.name}</span><span class="lvl-tag">${u.kind}</span></span>`
          )
          .join("")}</div>`
      : `<div class="lvl-none">Nothing new this level — keep going!</div>`;

    panel.innerHTML =
      `<div class="lvl-burst">LEVEL UP!</div>` +
      `<div class="lvl-num">You reached level ${view.level}</div>` +
      brainRow +
      unlockHtml;

    const done = document.createElement("button");
    done.className = "lvl-go";
    done.textContent = "Continue";
    done.onclick = () => bg.remove();
    panel.appendChild(done);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
    requestAnimationFrame(() => panel.classList.add("in"));
  }

  /** Celebratory "QUEST COMPLETE" popup showing the finished quest + its reward,
   *  styled like the level-up popup. Fired from the QuestSystem via main.ts. Only
   *  one shows at a time; a queued list (main.ts) feeds them in one after another. */
  openQuestComplete(view: QuestCompleteView) {
    document.querySelector("#hud .qc-bg")?.remove();
    const bg = document.createElement("div");
    bg.className = "panelbg qc-bg";
    const panel = document.createElement("div");
    panel.className = "panel questdone";

    const rewardHtml = view.rewards.length
      ? `<div class="qc-sub">Reward</div><div class="qc-rewards">${view.rewards
          .map(
            (r) =>
              `<span class="qc-reward"><img src="${r.icon}" onerror="this.style.visibility='hidden'">` +
              `${r.label}</span>`
          )
          .join("")}</div>`
      : "";

    panel.innerHTML =
      `<div class="qc-icon"><img src="${UI(view.icon)}" onerror="this.style.visibility='hidden'"></div>` +
      `<div class="qc-burst">QUEST COMPLETE!</div>` +
      `<div class="qc-title">${view.title}</div>` +
      (view.message ? `<div class="qc-msg">${view.message}</div>` : "") +
      rewardHtml;

    const done = document.createElement("button");
    done.className = "lvl-go";
    done.textContent = "OK";
    const close = () => { bg.remove(); this.onQuestCompleteClosed?.(); };
    done.onclick = close;
    panel.appendChild(done);
    bg.appendChild(panel);
    // Quest completions may appear while the player is mid-action. Keep the modal
    // open through stray/backdrop taps so its explicit OK button is the only way to
    // acknowledge it (and advance to the next queued completion).
    this.el.appendChild(bg);
    requestAnimationFrame(() => panel.classList.add("in"));
  }

  /** Called when a quest-complete popup is dismissed, so main can show the next
   *  queued one (quests can complete in bursts — e.g. several on a raid return). */
  onQuestCompleteClosed: (() => void) | null = null;

  // A compact Move / Store / Sell action popup for a placed farm object, shown
  // when it's tapped in Select mode.
  openObjectActions(o: ObjectActions) {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel obj-actions";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();

    const h = document.createElement("h2");
    h.textContent = o.name;
    const por = document.createElement("div");
    por.className = "obj-por";
    if (o.portrait) por.style.backgroundImage = `url(${o.portrait})`;

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const mk = (label: string, cls: string, enabled: boolean, fn: () => void) => {
      const b = document.createElement("button");
      b.className = `zbtn ${cls}`;
      b.textContent = label;
      b.disabled = !enabled;
      b.onclick = () => { bg.remove(); fn(); };
      return b;
    };
    btns.append(
      mk("Move", "locate", true, o.onMove),
      mk("Rotate", "locate", true, o.onRotate),
      mk(o.canStore ? "Store" : "Storage full", "store", o.canStore, o.onStore),
      mk(`Sell +${o.sellRefund}${o.sellBrains ? "b" : "g"}`, "sell", true, o.onSell)
    );
    panel.append(x, h, por, btns);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  private openPanel(title: string, body: string) {
    const bg = document.createElement("div");
    bg.className = "panelbg";
    const panel = document.createElement("div");
    panel.className = "panel";
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => bg.remove();
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = body;
    panel.append(x, h, p);
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); }; // click backdrop closes
    this.el.appendChild(bg);
  }

  private buildQuestToggle() {
    const btn = document.createElement("button");
    btn.className = "qtoggle";
    const img = document.createElement("img");
    img.src = UI("menu_profile_icon.png");
    btn.appendChild(img);
    btn.onclick = () => {
      this.questsShown = !this.questsShown;
      this.questCol.style.display = this.questsShown ? "flex" : "none";
    };
    this.el.appendChild(btn);
  }

  setMode(m: Mode) {
    this.plantingCrop = null; // switching tools exits crop-planting mode
    this.placingObj = null; // ...and object-placement mode
    this.plantLabel.style.display = "none";
    this.mode = this.mode === m ? "walk" : m;
    this.refreshTools();
    if (this.onModeChange) this.onModeChange();
  }

  private buildPlantLabel() {
    this.plantLabel = document.createElement("div");
    this.plantLabel.className = "plant-label";
    this.el.appendChild(this.plantLabel);
  }

  // Enter (def) or leave (null) "placing an object" mode: a label says what's
  // being placed; persists across taps so you can place several, until cleared.
  setPlacing(def: PlaceableDef | null) {
    this.placingObj = def;
    if (def) {
      this.plantingCrop = null;
      this.mode = "place";
      this.plantLabel.textContent = `Placing: ${def.name}`;
      this.plantLabel.style.display = "flex";
    } else {
      if (this.mode === "place") this.mode = "walk";
      this.plantLabel.style.display = "none";
    }
    this.refreshTools();
    if (this.onModeChange) this.onModeChange();
  }

  // Enter (cfg) or leave (null) "planting a specific crop" mode: the Plant tool
  // shows as active and a label says what's being planted. Persists across taps on
  // tilled plots until the caller clears it (e.g. tapping non-tilled ground).
  setPlanting(cfg: CropConfig | null) {
    // Defense: refuse a zombie crop whose colored grave isn't owned (cards are
    // already locked in the picker/market, so this only guards stray callers).
    if (cfg?.unlockGrave && this.hasGrave && !this.hasGrave(cfg.unlockGrave)) return;
    this.plantingCrop = cfg;
    if (cfg) {
      this.mode = "plant";
      this.plantLabel.textContent = `Planting: ${cfg.name}`;
      this.plantLabel.style.display = "flex";
    } else {
      if (this.mode === "plant") this.mode = "walk";
      this.plantLabel.style.display = "none";
    }
    this.refreshTools();
    if (this.onModeChange) this.onModeChange();
  }

  update() {
    this.goldEl.textContent = String(this.state.gold);
    this.brainsEl.textContent = String(this.state.brains);
    this.zombiesEl.textContent = `${this.state.zombieCount}/${this.state.zombieMax}`;
    this.levelEl.textContent = String(this.state.level);
    this.xpFill.style.width = `${Math.round(this.state.levelProgress * 100)}%`;
    this.refreshBoostBadge(); // keep the equipped-boost uses badge in sync
    this.refreshName();
  }

  /** Re-read the signed-in account name into the nameplate. Called by main once the
   *  account wiring (myAccount) is in place, since the nameplate is otherwise only
   *  refreshed on the next HUD update tick — so right after sign-in it would briefly
   *  show the default name. The nameplate is the entry point to the Profile menu, so
   *  it should show the real name immediately. */
  refreshAccount() {
    this.refreshName();
  }

  // The top-right nameplate shows the signed-in account name (falling back to the
  // default "Zombie Farmer" when offline / signed out).
  private refreshName() {
    if (!this.nameEl) return;
    const acct = this.myAccount?.();
    this.nameEl.textContent = acct?.name || "Zombie Farmer";
  }
}
