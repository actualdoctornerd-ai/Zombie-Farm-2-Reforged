// DOM overlay HUD laid out like the iPad game: settings gear + currency bar +
// player name across the top, an ACTIVE-QUESTS column on the left (toggled by the
// bottom-left button), menu buttons on the right, and a farming-tool bar at the
// bottom-center. Resize-safe (fixed positioning).
import { GameState } from "./GameState";
import { CropConfig } from "./Field";
import { zombieSellValue } from "./economy";
import { PlaceableDef, BoostDef, FarmSizeUpgrade, ClimateUpgrade, upgradeIcon } from "./assets";
import { AudioManager } from "./audio";
import { RosterEntry } from "./zombie/types";
import { mutationLabel, mutationBonus } from "./zombie/mutations";
import { QuestView } from "./quest/types";
import type { RaidCardView, RaidPartyView, RaidResultView, RaidLaunchOpts } from "./raid/RaidManager";
import type { ProfileIndex } from "./save/profiles";
import { isMobile } from "./platform";
import { fmtCooldown } from "./raid/RaidCatalog";
import { STATS, veterancy, veterancyMultiplier, STAT_TILE, VALUE_FILL, VALUE_END, ABILITY_FRAME,
  ABILITY_POOL, unitAbilityAt, TIER_BOSS, MAX_ABILITY_TIER } from "./zombie/traits";
import { classTierRank } from "./zombie/taxonomy";
import { BASE } from "./base";

export type Mode = "walk" | "till" | "plant" | "move" | "place" | "remove" | "instagrow";

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
  onPick: () => void;
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
  portrait: string; // full image url
  category?: "normal" | "special" | "mutant"; // zombies only
  cfg: CropConfig;
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
  color: #fff; font-weight: 700; font-size: 14px; text-shadow: 0 1px 1px #000; }

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
#hud.raiding .questcol, #hud.raiding .fab { display: none !important; }
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
#hud .set-row { display: flex; align-items: center; justify-content: space-between;
  gap: 24px; min-width: 240px; padding: 8px 2px; font-size: 15px; font-weight: 700; }
#hud .set-row + .set-row { border-top: 1px solid rgba(255,255,255,.15); }
#hud .toggle { width: 62px; height: 28px; border-radius: 15px; border: 2px solid #1e1207;
  background: #5a3a1a; cursor: pointer; position: relative; padding: 0;
  font: 700 11px system-ui, sans-serif; color: #fff; }
#hud .toggle.on { background: #4f9b2f; }
#hud .toggle .knob { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px;
  border-radius: 50%; background: #f2ead0; transition: left .12s; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
#hud .toggle.on .knob { left: 36px; }
#hud .toggle .txt { position: absolute; top: 6px; width: 26px; text-align: center; text-shadow: 0 1px 1px #000; }
#hud .toggle .txt.l { left: 4px; } #hud .toggle .txt.r { right: 4px; }
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

/* ---- Market panel (authentic parchment + wood sprites) ---- */
#hud .mkt-bg { position: fixed; inset: 0; pointer-events: auto; z-index: 21;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
#hud .mkt { position: relative; box-sizing: border-box;
  width: min(770px, 94vw); height: min(440px, 88vh);
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
#hud .mkt-arrow { position: absolute; right: 4px; top: 82px; width: 30px; height: 40px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: linear-gradient(#8a5a2a, #6e4420); border: 2px solid #4a2c12;
  border-radius: 8px 0 0 8px; border-right: none; }
#hud .mkt-arrow img { width: 12px; height: 18px; filter: brightness(0) invert(1) opacity(.85); }
#hud .mkt-grid { flex: 1 1 auto; display: grid; grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: 122px; gap: 9px 10px; padding: 0 2px 2px; overflow: auto; min-height: 0;
  align-content: start; }
#hud .mkt-card { border-radius: 8px; overflow: hidden; background: #efe4bf; cursor: pointer;
  border: 2px solid #b98b4a; box-shadow: inset 0 -3px 0 rgba(90,52,19,.12);
  display: flex; flex-direction: column; }
#hud .mkt-card:hover { background: #f7efcd; }
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
/* Upgrade tab: a full-width status banner + Farm Size tier cards laid out as
   2 columns (each row = one tier: gold card | brains card). */
#hud .mkt-grid.mkt-grid--upgrade { grid-template-columns: repeat(2, 1fr);
  grid-auto-rows: 138px; max-width: 440px; margin: 0 auto; }
#hud .mkt-upgrade-status { grid-column: 1 / -1; text-align: center; color: #4f2f13;
  font-size: 14px; padding: 4px 0 8px; }
#hud .mkt-upgrade-status b { color: #2f7a1e; font-size: 16px; }
#hud .mkt-upgrade-size { font-size: 12px; font-weight: 700; color: #6e4a1e; }
#hud .mkt-card.owned { background: #dcecc4; border-color: #7fa957; cursor: default; }
#hud .mkt-card.owned:hover { background: #dcecc4; }
#hud .mkt-card.owned .mkt-cost { color: #2f7a1e; }

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
`;

export class Hud {
  mode: Mode = "walk";
  onModeChange: (() => void) | null = null;
  private el: HTMLElement;
  private goldEl!: HTMLElement;
  private brainsEl!: HTMLElement;
  private zombiesEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpFill!: HTMLElement;
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
    const name = document.createElement("div");
    name.className = "nameplate";
    name.textContent = "Zombie Farmer";
    bar.append(gear, chips, spacer, name);
    this.el.appendChild(bar);
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

  // Each button is a colored frame around a grey glossy button (dark label).
  private buildMenu() {
    const items = [
      { label: "Invade", fill: "#9c2135", light: "#c04155", dark: "#5a0f1c", ready: true },
      { label: "Zombies", fill: "#55972a", light: "#79c247", dark: "#2f5f10" },
      { label: "Boosts", fill: "#7a4bc9", light: "#9c74e0", dark: "#432379" },
      { label: "Storage", fill: "#2f74bb", light: "#4f9bd8", dark: "#143f66" },
      { label: "Market", fill: "#c9992e", light: "#e3bb52", dark: "#8a6512" },
    ];
    const col = document.createElement("div");
    col.className = "menucol";
    this.menuCol = col;
    for (const m of items) {
      const btn = document.createElement("button");
      btn.className = "mbtn";
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
                  : this.openPanel(m.label, "Coming soon.");
      col.appendChild(btn);
    }
    this.el.appendChild(col);
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
    this.plantCards = plants;
    this.zombieCards = zombies;
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
  onBuyClimate: ((c: ClimateUpgrade) => boolean) | null = null;
  /** Re-apply an already-owned ground skin for free. */
  onApplyClimate: ((c: ClimateUpgrade) => void) | null = null;

  // Consumable-boost catalog (Market Boosts tab + Storage Boosts inventory).
  private boosts: BoostDef[] = [];
  setBoosts(boosts: BoostDef[]) {
    this.boosts = boosts;
  }
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
  onBuyUpgrade: ((size: number, currency: "gold" | "brains") => boolean) | null = null;

  // ---- zombie management + storage hooks (set by main) ----
  /** The current owned-zombie roster (deployed + stored). */
  getRoster: (() => RosterEntry[]) | null = null;
  /** Portrait image URL for a zombie type key (per-type composite). */
  zombiePortraitOf: ((key: string) => string) | null = null;
  /** Take a deployed zombie off the farm (into the Mausoleum). */
  onZombieStore: ((id: string) => void) | null = null;
  /** Put a stored zombie back on the farm. */
  onZombieDeploy: ((id: string) => void) | null = null;
  /** Whether a Mausoleum exists to store zombies in (gates the Store action). */
  canStoreZombies: (() => boolean) | null = null;
  /** Mausoleum storage-slot capacity (shown as fixed slots; default 15). */
  mausoleumCap = 15;
  /** Whether the farm has a free army slot (gates the Deploy action). */
  canDeployZombie: (() => boolean) | null = null;
  /** Select a deployed zombie and center the camera on it. */
  onZombieLocate: ((id: string) => void) | null = null;
  /** Permanently sell an owned zombie for gold (after confirmation). */
  onZombieSell: ((id: string) => void) | null = null;
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
  onCombine: ((idA: string, idB: string) => boolean) | null = null;
  /** Collect a finished combine; returns the new zombie's name (or null). */
  onCollectCombine: (() => string | null) | null = null;

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
  onLaunchRaid: ((raidId: number, partyIds: string[], opts: RaidLaunchOpts) => boolean) | null = null;

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
  /** Current Fast Mode state (compressed wait clocks); defaults to ON. */
  getFastMode: (() => boolean) | null = null;
  /** Toggle Fast Mode: persist the choice, flush the game, and reload. */
  onSetFastMode: ((on: boolean) => void) | null = null;

  /** Hide/show the farm chrome (top bar, tools, menus) so the live battle scene
   *  can take over the screen. Raid panels stay visible. */
  setRaiding(on: boolean) {
    this.el.classList.toggle("raiding", on);
  }

  // The Market: authentic parchment panel with category tabs + real cards.
  // Picking a crop/zombie enters planting mode; picking an object enters
  // placement mode. Cards show cost, sell value, level locks, and affordability.
  openMarket(initialTab: string = "Crops") {
    document.querySelector("#hud .mkt-bg")?.remove();
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
    const grid = document.createElement("div");
    grid.className = "mkt-grid";

    const SUBTABS: Record<string, string[]> = {
      Crops: ["Plants", "Zombies"],
      Items: ["Functional", "Decors", "Fruit Trees"],
      Upgrade: ["Farm Size", "Ground"],
      Boosts: [],
      Brains: [],
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
        return cards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, brains: c.brainsNeeded,
          onPick: () => { if (this.onBuy) this.onBuy(c.def); bg.remove(); },
        }));
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
            ownedLimit,
            onPick: () => {
              if (this.onBuyBoost && this.onBuyBoost(b)) { refreshCur(); renderGrid(); }
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

    const renderGrid = () => {
      grid.innerHTML = "";
      grid.scrollTop = 0;
      // Farm Size lays out as 2 columns so each row is one tier (gold | brains);
      // Ground uses the normal card grid.
      grid.classList.toggle("mkt-grid--upgrade", tab === "Upgrade" && sub === "Farm Size");
      if (tab === "Upgrade") {
        if (sub === "Ground") this.renderGroundGrid(grid, refreshCur, renderGrid);
        else this.renderUpgradeGrid(grid, refreshCur, renderGrid);
        return;
      }
      const entries = entriesFor();
      if (!entries.length) {
        const e = document.createElement("div");
        e.className = "mkt-empty";
        // Brains are never sold for real money — earned through play only.
        e.textContent = tab === "Brains"
          ? "Brains can't be bought. Earn them from quests and invasions!"
          : "Coming soon.";
        grid.appendChild(e);
        return;
      }
      for (const en of entries) grid.appendChild(this.buildMarketCard(en));
    };

    const renderSubs = () => {
      subsEl.innerHTML = "";
      const list = SUBTABS[tab];
      subsEl.style.display = list.length ? "flex" : "none";
      for (const s of list) {
        const b = document.createElement("button");
        b.className = "mkt-subtab" + (s === sub ? " sel" : "");
        b.textContent = s;
        b.onclick = () => { this.audio.play("menuClick"); sub = s; renderSubs(); renderGrid(); };
        subsEl.appendChild(b);
      }
    };

    for (const name of ["Crops", "Items", "Upgrade", "Boosts", "Brains"]) {
      const b = document.createElement("button");
      b.className = "mkt-tab" + (name === tab ? " sel" : "");
      b.textContent = name;
      b.onclick = () => {
        this.audio.play("menuClick");
        tab = name;
        sub = SUBTABS[name][0] ?? "";
        tabsEl.querySelectorAll(".mkt-tab").forEach((e) => e.classList.remove("sel"));
        b.classList.add("sel");
        renderSubs();
        renderGrid();
      };
      tabsEl.appendChild(b);
    }

    const arrow = document.createElement("div");
    arrow.className = "mkt-arrow";
    const ai = document.createElement("img");
    ai.src = UI("market/arrow_right.png");
    arrow.appendChild(ai);

    mkt.append(title, close, cur, tabsEl, subsEl, arrow, grid);
    bg.appendChild(mkt);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
    renderSubs();
    renderGrid();
  }

  private buildMarketCard(en: MktEntry): HTMLElement {
    const locked = this.state.level < en.level;
    // Colored-grave gate: this zombie class can't be planted until you own it.
    const graveLock = !locked && !!en.graveNeeded && !!this.hasGrave && !this.hasGrave(en.graveNeeded);
    // "1 per farm" gift-voucher limit: already own that zombie (or hold the voucher).
    const limitLock = !locked && !graveLock && !!en.ownedLimit;
    const curAmt = en.brains ? this.state.brains : this.state.gold;
    const poor = !locked && !graveLock && !limitLock && curAmt < en.cost;
    const card = document.createElement("div");
    card.className = "mkt-card" + (locked || poor || graveLock || limitLock ? " locked" : "");

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
    cost.innerHTML = locked
      ? `🔒 Lvl ${en.level}`
      : graveLock
        ? `🔒 ${en.graveNeeded} Grave`
        : limitLock
          ? `✓ Owned`
          : `${en.cost}<img src="${UI(coin)}">`;
    body.appendChild(cost);

    card.append(hd, body);
    if (!locked && !poor && !graveLock && !limitLock) card.onclick = en.onPick;
    return card;
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
    // Each tier gets a gold card then a brains card, side by side.
    for (const u of this.farmUpgrades)
      for (const currency of ["gold", "brains"] as const)
        grid.appendChild(this.buildUpgradeCard(u, currency, current, next, refreshCur, rerender));
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
      card.onclick = () => {
        if (this.onBuyUpgrade && this.onBuyUpgrade(u.size, currency)) {
          refreshCur();
          rerender();
        }
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
      card.onclick = () => {
        if (this.onBuyClimate && this.onBuyClimate(c)) { refreshCur(); rerender(); }
      };
    }
    return card;
  }

  // The tool-shed Storage menu: parchment/wood panel, a red STORAGE banner with
  // grass/flower flanks, and tabs Items / Boosts / Received. Item capacity comes
  // from the placed shed's tier (8 per tier); received is unlimited (raid loot).
  // Opened by clicking the shed or the Storage button. (Pets are out of scope for
  // this rebuild — see docs/mechanics/PET_SYSTEM.md.)
  openStorage(initialTab: string = "Items") {
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

    let tab = ["Items", "Boosts", "Received"].includes(initialTab) ? initialTab : "Items";
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
    for (const name of ["Items", "Boosts", "Received"]) {
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
  openPlantMenu(onPick: (cfg: CropConfig) => void) {
    document.querySelector("#hud .pm-bg")?.remove(); // only one at a time
    const bg = document.createElement("div");
    bg.className = "pm-bg";
    const pm = document.createElement("div");
    pm.className = "pm";

    const close = document.createElement("button");
    close.className = "pm-close";
    const ci = document.createElement("img");
    ci.src = UI("button_close.png");
    close.appendChild(ci);
    close.onclick = () => bg.remove();

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
      for (const c of cards) list.appendChild(this.buildCard(c, pick));
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
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);

    // Open on the Plants screen.
    screenBtns["Plants"].classList.add("sel");
    showPlants();
  }

  private buildCard(c: MenuCard, onPick: (c: MenuCard) => void): HTMLElement {
    const levelLocked = this.state.level < c.level;
    // Colored-grave gate for zombie crops (Blue/Red/Silver need the grave placed).
    const graveLock = !levelLocked && !!c.cfg.unlockGrave && !!this.hasGrave &&
      !this.hasGrave(c.cfg.unlockGrave);
    const locked = levelLocked || graveLock;
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

  // Settings modal: Music + Sound Effects toggles, profile manager, and a
  // Developer section (Fast Mode toggle, level/gold/brains overrides, raid unlocks).
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

    const row = (label: string, on: boolean, set: (v: boolean) => void) => {
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
    };

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
    const devHead = document.createElement("div");
    devHead.className = "dev-head";
    devHead.textContent = "Developer";

    // Dev: mark a tier boss beaten so its abilities unlock across the roster
    // (each colour class shows its group's ability for that tier).
    const raidWrap = document.createElement("div");
    const raidStatus = document.createElement("div");
    raidStatus.className = "dev-status";
    raidStatus.textContent = "Beat a tier boss to unlock its abilities:";
    const raidBtns = document.createElement("div");
    raidBtns.className = "dev-raid-btns";
    for (let t = 1; t <= 4; t++) {
      const b = document.createElement("button");
      b.className = "dev-btn";
      b.textContent = `Win T${t} — ${TIER_BOSS[t]}`;
      b.onclick = () => {
        const already = this.state.abilityTierUnlocked(t);
        this.state.completeRaid(String(t));
        raidStatus.textContent = already
          ? `Tier ${t} was already unlocked.`
          : `Unlocked Tier ${t} abilities (beat ${TIER_BOSS[t]}).`;
      };
      raidBtns.appendChild(b);
    }
    raidWrap.append(raidStatus, raidBtns);

    // Profile UI is hidden: the game is one-save-per-account now. The underlying
    // per-profile save key still resolves to a single active slot (see profiles.ts),
    // which is the seam an account id will replace once sign-in lands. The profile
    // manager (openProfiles) and its hooks are kept but no longer reachable here.

    // Fast Mode: compresses all wait clocks (grow times, pot combine, raid
    // cooldown) to seconds for testing. Toggling flushes + reloads the game.
    const fastRow = row("Fast Mode", this.getFastMode?.() ?? true, (v) =>
      this.onSetFastMode?.(v)
    );
    const fastNote = document.createElement("div");
    fastNote.className = "dev-status";
    fastNote.textContent = "Speeds up grow times & cooldowns for testing (reloads).";

    panel.append(
      x, h,
      row("Music", this.audio.musicOn, (v) => this.audio.setMusic(v)),
      row("Sound Effects", this.audio.sfxOn, (v) => this.audio.setSfx(v)),
      row("Ambience", this.audio.ambienceOn, (v) => this.audio.setAmbience(v)),
      devHead,
      fastRow,
      fastNote,
      numRow("Level", this.state.level, (n) => this.state.setLevel(n)),
      numRow("Gold", this.state.gold, (n) => this.state.setGold(n)),
      numRow("Brains", this.state.brains, (n) => this.state.setBrains(n)),
      raidWrap
    );
    bg.appendChild(panel);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    this.el.appendChild(bg);
  }

  // Profile manager: list every save profile, switch to one (flushes + reloads),
  // create a fresh-game profile, or rename/delete profiles in place. Each profile
  // is a fully independent game.
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
    h.textContent = "Profiles";
    const list = document.createElement("div");
    list.className = "prof-list";
    panel.append(x, h, list);

    const render = () => {
      const idx = this.getProfiles?.();
      list.innerHTML = "";
      if (!idx) return;
      for (const p of idx.profiles) {
        const isActive = p.id === idx.activeId;
        const row = document.createElement("div");
        row.className = "prof-row" + (isActive ? " active" : "");

        const nm = document.createElement("div");
        nm.className = "prof-name";
        nm.textContent = p.name;
        if (isActive) {
          const b = document.createElement("span");
          b.className = "prof-badge";
          b.textContent = "Playing";
          nm.appendChild(b);
        }

        const acts = document.createElement("div");
        acts.className = "prof-actions";
        if (!isActive) {
          const play = document.createElement("button");
          play.className = "prof-btn play";
          play.textContent = "Play";
          play.onclick = () => this.onSwitchProfile?.(p.id); // reloads
          acts.appendChild(play);
        }
        const ren = document.createElement("button");
        ren.className = "prof-btn";
        ren.textContent = "Rename";
        ren.onclick = () => {
          nm.textContent = "";
          const inp = document.createElement("input");
          inp.className = "prof-input";
          inp.value = p.name;
          inp.maxLength = 24;
          const commit = () => { this.onRenameProfile?.(p.id, inp.value); render(); };
          inp.onkeydown = (e) => { if (e.key === "Enter") commit(); };
          inp.onblur = commit;
          nm.appendChild(inp);
          inp.focus();
          inp.select();
        };
        acts.appendChild(ren);
        const del = document.createElement("button");
        del.className = "prof-btn del";
        del.textContent = "Delete";
        del.disabled = isActive || idx.profiles.length <= 1;
        del.title = isActive ? "Switch to another profile first" : "Delete this profile";
        del.onclick = () => { this.onDeleteProfile?.(p.id); render(); };
        acts.appendChild(del);

        row.append(nm, acts);
        list.appendChild(row);
      }
      // "New profile" row.
      const newRow = document.createElement("div");
      newRow.className = "prof-row prof-new";
      const inp = document.createElement("input");
      inp.className = "prof-input";
      inp.placeholder = "New profile name";
      inp.maxLength = 24;
      const create = document.createElement("button");
      create.className = "prof-btn play";
      create.textContent = "New Game";
      create.onclick = () => this.onCreateProfile?.(inp.value); // reloads into a fresh farm
      newRow.append(inp, create);
      list.appendChild(newRow);
    };
    render();

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
    // A tier whose invasion boss is beaten shows the real icon; still-locked tiers
    // show a padlock naming the boss. Some groups (Small) have no ability at low
    // tiers, so their abilities only appear on higher-class units.
    const rank = Math.min(MAX_ABILITY_TIER, classTierRank(info.className));
    for (let t = 1; t <= rank; t++) {
      const key = unitAbilityAt(info.key, info.group, t);
      if (!key) continue; // no ability at this tier for this unit
      const meta = ABILITY_POOL[key];
      if (!meta) continue;
      const cell = document.createElement("button");
      cell.style.backgroundImage = `url(${ABILITY_FRAME})`;
      if (this.state.abilityTierUnlocked(t)) {
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
      const mk = (label: string, cls: string, enabled: boolean, fn: () => void) => {
        const b = document.createElement("button");
        b.className = `zbtn ${cls}`;
        b.textContent = label;
        b.disabled = !enabled;
        b.onclick = () => {
          bg.remove();
          fn();
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
    confirm.onclick = () => {
      bg.remove();
      this.onZombieSell?.(info.id!);
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
      str: z.str, dex: z.dex, con: z.con, focus: z.focus, mutation: z.mutation,
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

    // Only zombies deployed on the farm — stored ones live in the Mausoleum menu.
    const roster = (this.getRoster ? this.getRoster() : []).filter((r) => !r.stored);
    const title = document.createElement("h2");
    title.textContent = "Your Zombies";
    const cnt = document.createElement("span");
    cnt.className = "zr-total";
    cnt.textContent = `${roster.length} on farm`;
    head.append(title, cnt);

    if (!roster.length) {
      const e = document.createElement("div");
      e.className = "zr-empty";
      e.textContent = "No zombies on the farm — grow one, or deploy from the Mausoleum.";
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
      for (let i = 0; i < cap; i++) {
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
        this.buildRosterCard(z, () => {
          this.onZombieStore?.(z.id);
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
      go.onclick = () => {
        const name = this.onCollectCombine?.();
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
      const roster = this.getRoster?.() ?? [];
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
      go.onclick = () => {
        if (!pickA || !pickB) return;
        const ok = this.onCombine?.(pickA, pickB);
        if (ok) { pickA = pickB = null; renderBusy(); }
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
  // Raid select: a list of invasions (left) + the selected raid's detail (right).
  // Only playable + level-met raids can be invaded; the rest show as locked cards
  // so the ladder reads as a real (mostly future) catalog.
  openRaids() {
    document.querySelector("#hud .raid-bg")?.remove();
    const cards = this.getRaidCards ? this.getRaidCards() : [];
    const party = this.getRaidParty ? this.getRaidParty() : null;
    const haveN = party ? party.eligible.length : 0;
    const minN = party ? party.min : 8;

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
      const canFight = c.unlocked && haveN >= minN;
      info.innerHTML =
        `<div class="rd-title">${c.name}</div>` +
        (c.bossName ? `<div class="rd-boss">${c.bossName}</div>` : "") +
        `<div class="rd-meta">Recommended level ${c.recommendedLevel} · Reward ${c.xp} XP</div>`;
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
          go.textContent = `Ready in ${fmtCooldown(cd)}`;
          go.disabled = true;
          army.className = "rd-army short";
          army.textContent = "On cooldown — an Invasion Voucher skips the wait";
        }
      } else {
        go.textContent = "Invade";
        go.disabled = !canFight;
      }
      go.onclick = () => { close(); this.openRaidArmy(c, useVoucher); };
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
    const min = party.min;
    // Ordered selection: index in the array = attack position (first attacks
    // first). Seeded from the saved order (empty on a first-ever raid). Clicking a
    // card appends it; clicking a picked card removes it and renumbers the rest.
    const order: string[] = [...party.orderedSelectedIds];

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

    // "Pick for me": clear the order, then select cards in reading order
    // (left-to-right, top-to-bottom — the grid's visual order) up to the cap.
    const pick = document.createElement("button");
    pick.className = "raid-quick";
    pick.textContent = "Pick for me";
    pick.onclick = () => {
      order.length = 0;
      for (const z of party.eligible) {
        if (order.length >= cap) break;
        order.push(z.id);
      }
      refresh();
    };

    start.onclick = () => {
      if (order.length < min) return;
      // Always play the live battle scene — there is no instant/auto-resolve. If the
      // scene declines (cooldown, or a raid already running), leave this screen up so
      // the player can retry rather than closing into nothing.
      if (this.onLaunchRaid && this.onLaunchRaid(raid.id, [...order], launchOpts())) bg.remove();
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
  }
}
