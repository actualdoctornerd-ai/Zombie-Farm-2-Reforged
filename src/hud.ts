// DOM overlay HUD laid out like the iPad game: settings gear + currency bar +
// player name across the top, an ACTIVE-QUESTS column on the left (toggled by the
// bottom-left button), menu buttons on the right, and a farming-tool bar at the
// bottom-center. Resize-safe (fixed positioning).
import { GameState } from "./GameState";
import { farmerHeadHasEffect, farmerHeadXp } from "./farmer";
import { CropConfig } from "./Field";
import { harvestXp } from "./farmRewards";
import { buyXp } from "./economy";
import { PlaceableDef, BoostDef, FarmSizeUpgrade, ClimateUpgrade, upgradeIcon, placeablePurchaseLimit } from "./assets";
import type { FarmerBodyDef, FarmerCatalog, FarmerHeadDef, PetCatalog, PetDef } from "./assets";
import { EPIC_BOSS_FIGHT_BRAIN_COST, type EpicBossPayment } from "./epicBoss/tokens";
import { AudioManager } from "./audio";
import type { UsernameRefusal } from "./net/serviceStatus";
import { RosterEntry } from "./zombie/types";
import {
  bitAllowed, MUTATION_LIST, mutationBonus,
} from "./zombie/mutations";
// Species-aware: an Eyebiscus wears Carrot's bit but is never called a Carrot.
import { mutationLabelFor } from "./zombie/mutationDisplay";
import { maskHas } from "./zombie/mutationMask";
import { visibleMutations } from "./zombie/mutationVisibility";
import { QuestView } from "./quest/types";
import type { RaidCardView, RaidPartyView, RaidResultView, RaidLaunchOpts, LootDrop } from "./raid/RaidManager";
import { lootDropLabel } from "./raid/RaidManager";
import type { ProfileIndex } from "./save/profiles";
import { canGiftBrain, type Friend } from "./social/friends";
import { planGiftAll, type GiftAllPlan } from "./social/giftAll";
import { FRIEND_SORTS, isFriendSort, sortFriends } from "./social/friendSort";
import { isMobile } from "./platform";
import {
  getFriendSort, setFriendSort,
  type DayNightMode, type FarmBackground, type ZombieAppearancePrefs,
} from "./prefs";
import { fmtCooldown, MCDONNELL_ID, VOUCHER_KEY } from "./raid/RaidCatalog";
import { BRAIN_TICKET_KEY } from "./raid/eliteInvasion";
import { marketPageSize } from "./marketPageSize";
import { veterancy } from "./zombie/traits";
import { COMBINE_SPECIAL_LEVEL } from "./zombie/combineSpecies";
import type { AlmanacGuideTopic } from "./zombie/almanacGuide";
import type { MutationAlmanacEntry } from "./zombie/mutationAlmanac";
import { BASE } from "./base";
import {
  compareCropMarketOrder, compareItemMarketOrder, cropAvailableInMarket,
} from "./marketOrder";
import { decorAvailable, themeLabel, themeOf } from "./decorThemes";
import { orderPartyRoster } from "./raid/partySelection";
import {
  compactOrder, fillSlots, selectedCount, toggleSlot, type OrderSlots,
} from "./raid/attackOrderSlots";
import { PVP_ARMY_SIZE, PVP_MIN_LEVEL, PVP_UI_ENABLED } from "./raid/pvp";
import { openInvasionsPanel } from "./ui/panels/invasions";
import { openLeaderboardPanel } from "./ui/panels/leaderboard";
import type { FriendLeaderboardEntry } from "./net/api";
import type {
  PvpDefenseInfoView, PvpOverviewView, PvpRewardView, PvpScoutView,
} from "./ui/panels/invasions";
import { otherPlayMode, playModeDestinationLabel, type PlayMode } from "./playMode";
import type { UpdateCheckResult } from "./updateCheck";
import type {
  BlackMarketCurrency, BlackMarketFulfillmentView, BlackMarketHistoryResponse,
  BlackMarketListResponse,
  BlackMarketMutationResponse, BlackMarketOrderKind, BlackMarketOrderView, ClaimedUnit,
  FriendActivity, GiftReward,
} from "./net/protocol";
import { FREE_DAILY_GIFTS, GIFT_GOLD_COST, GIFT_XP_REWARD, MAX_FRIENDS } from "./net/protocol";
import {
  BLACK_MARKET_CLASS_FILTERS,
  BLACK_MARKET_GROUP_FILTERS,
  BLACK_MARKET_MIN_LEVEL,
  blackMarketComposeDefaults,
  blackMarketMutationRequirementLabel,
  blackMarketPurchaseLock,
  matchesBlackMarketMutation,
  REQUESTABLE_MUTATION_MASK,
} from "./blackMarketRules";
// HUD styles live in a real stylesheet (src/ui/hud.css) so they get CSS tooling
// and hot-reload. Vite injects it at module load — no manual <style> element.
import "./ui/hud.css";
import {
  bindBackdropDismiss, markPrimary, MENU_ACTIVATION_DELAY_MS, openModal,
  shouldBlockFreshMenuActivation,
} from "./ui/Modal";
import type { ModalHandle } from "./ui/Modal";
import { onFirstVisible } from "./ui/onFirstVisible";
import { keepScroll, recallNumber, recallOneOf, remember } from "./ui/viewState";
import { renderLevelUp, renderQuestComplete, renderObjectActions, renderInfoPanel } from "./ui/panels/dialogs";
import {
  openSettings as openSettingsPanel, openDevMenu as openDevMenuPanel,
  buildAccountBlock, buildDevicesBlock,
} from "./ui/panels/settings";
import { openStorage as openStoragePanel } from "./ui/panels/storage";
import {
  buildZombieCard, buildRosterCard, openCatalogZombieCard,
  openZombieInfo as openZombieInfoPanel,
  openZombiesPanel, rosterInfo, type ZombiesPanelTab,
} from "./ui/panels/zombies";
import { openMemorialPanel, type MemorialView } from "./ui/panels/memorial";
import { openTeamsPanel } from "./ui/panels/teams";
import type { TeamAssembleResult, ZombieTeam } from "./zombie/teams";
import {
  openPeriodicQuests, renderPeriodicQuests, type PeriodicQuestPanelView,
} from "./ui/panels/periodicQuests";
import type { PeriodicScope, PeriodicScopeView } from "./quest/periodic/types";
import { openFarmersGuide } from "./ui/panels/farmersGuide";
import { openStats } from "./ui/panels/stats";
import type { StatSection } from "./statsView";
import { showTimNotice } from "./ui/TimNotice";
// View-model types + the grave classifier live in hudTypes so panel modules can
// import them without depending on the whole Hud class. Re-exported below for the
// existing `from "./hud"` importers (main.ts).
import type {
  Mode, ObjCard, MenuCard, EpicBossMarketView, ZombieInfo, ObjectActions,
  AlmanacEntryView, LevelUpView, QuestCompleteView, ReceivedView,
} from "./ui/hudTypes";
export { graveNeededFor } from "./ui/hudTypes";
export type {
  Mode, ObjCard, MenuCard, EpicBossMarketView, ZombieInfo, ObjectActions,
  LevelUpUnlock, LevelUpView, QuestReward, QuestCompleteView, ReceivedView,
} from "./ui/hudTypes";

// A unified Market grid entry (crop, zombie, or object), with what to do on pick.
interface MktEntry {
  name: string;
  portrait: string;
  cost: number;
  level: number;
  brains?: boolean; // priced in brains rather than gold
  sell?: number; // harvest value (plants and fruit trees)
  // Experience the card is advertising. Two different things wear the same badge:
  // a crop's per-harvest XP and, for anything BOUGHT, the XP the purchase itself
  // pays out. `xpHint` is what tells them apart on hover.
  xp?: number;
  xpHint?: string;
  timeLabel?: string; // catalog grow/regrowth time
  qty?: number; // how many units the listed price buys (boost packs)
  graveNeeded?: "Blue" | "Red" | "Silver"; // locked until this colored grave is owned
  ownedLimit?: boolean; // "1 per farm" limit reached (gift vouchers) — can't buy
  owned?: boolean;
  equipped?: boolean;
  description?: string; // "what does it do" blurb shown by the card's magnifier
  /** Artist credit for contributed art, shown under the description on the same
   *  magnifier parchment. Decor has no description of its own, so a credit is on
   *  its own enough to earn the card a magnifier. */
  credit?: string;
  /** Zombies: the magnifier opens the species' full inspect card instead of the
   *  description parchment — stats and abilities are the thing worth reading before
   *  buying, and the blurb rides along under the card. */
  inspect?: () => void;
  tint?: [number, number, number]; // multiplicative object tint from Market data
  theme?: string; // seasonal badge ("Christmas"); "" or absent for evergreen
  onPick: () => void;
}

/** The little parchment magnifier a card carries in its corner (Market) or beside
 *  its name (plant menu). Clicking it never picks the card underneath. */
function magnifierButton(ariaLabel: string, title: string, onClick: () => void): HTMLButtonElement {
  const info = document.createElement("button");
  info.className = "mkt-info";
  info.type = "button";
  info.title = title;
  info.setAttribute("aria-label", ariaLabel);
  info.innerHTML =
    `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4.3"/>` +
    `<line x1="9.7" y1="9.7" x2="14" y2="14"/></svg>`;
  info.onclick = (e) => { e.stopPropagation(); onClick(); };
  return info;
}

/** Apply cocos2d/Pixi-style multiplicative RGB tinting to a DOM image. */
function tintMarketPortrait(img: HTMLImageElement, color?: [number, number, number]) {
  if (!color || color.every((channel) => channel === 255)) return;
  const apply = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width || !canvas.height) return;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Multiplication paints transparent pixels too; restore the source alpha.
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(img, 0, 0);
    img.src = canvas.toDataURL();
  };
  if (img.complete) apply();
  else img.addEventListener("load", apply, { once: true });
}

/** Player-facing "what does it do" blurb for a functional Market item, shown when the
 *  card's magnifier is tapped. Keyed off the effect flags assets.ts derives from the
 *  item key, so it always matches the item's real behaviour. */
function functionalDescription(def: PlaceableDef): string | undefined {
  if (def.petPen)
    return "A home for up to four cosmetic pets. Tap the Pet Pen on your farm and choose Pets to pick its occupants.";
  if (def.category !== "functional") return undefined;
  if (def.armyMax)
    return `Raises your zombie army limit by ${def.armyMax}, so you can send more zombies on each invasion.`;
  if (def.plowFree) return "Plowing soil costs no gold while this stands on your farm.";
  if (def.fastWork)
    return "Farming is instant — plowing, planting, and harvesting finish with no waiting.";
  if (def.mutantMonolith)
    return "Nearby mutation crops always mutate harvested zombies. Mutant zombies also grow in half the time.";
  if (def.combineFast)
    return "Speeds up the Zombie Pot: combining finishes in 15 minutes instead of an hour.";
  if (def.zombiePot)
    return "Combine two of your zombies into a brand-new one. Only one is needed; the first costs gold, later Pots cost brains.";
  if (def.zombieStorage)
    return `Stores up to ${def.zombieSlots ?? 0} spare zombies off the field, freeing up graves to plant more. Upgrade it for five more slots.`;
  if (def.zombiePatch) return "A cosy spot where your idle zombies gather to relax and nap.";
  if (def.graveColor)
    return `Unlocks planting ${def.graveColor}-class zombies — you must own this grave before you can grow them.`;
  if (def.storageSlots)
    return `A shed for objects you've packed away — holds up to ${def.storageSlots} items. Buy a bigger shed to store more.`;
  if (def.petPen)
    return "An enclosure your pets roam around in. Tap it and choose Pets to pick up to four of the pets you own — one pen is all you need.";
  if (def.key === "cameraNormal") return "A decorative camera to show off your farm.";
  return undefined;
}

const UI = (n: string) => `${BASE}assets/ui/${n}`;

/** Gift rows the inbox shows before collapsing the rest behind "Show all N". Four
 *  keeps the section shorter than a phone screen, so "Open all" and the friends list
 *  below it both stay reachable however many gifts are waiting. */
const INBOX_PREVIEW = 4;

/** Colour band for a friend's level chip, so the list is scannable without reading
 *  the numbers. Bands follow the game's own gates (15 = red gravestone, 25 = silver,
 *  40 = late game); an unknown level is styled as absent, never as level 0. */
function levelTier(level: number | undefined): string {
  if (level == null) return "fr-lvl-none";
  if (level >= 40) return "fr-lvl-high";
  if (level >= 15) return "fr-lvl-mid";
  return "fr-lvl-low";
}

/** Wording for the coarse activity bucket the server discloses. Kept short because
 *  it shares one ellipsising line with the gift count on a phone, and the count is
 *  the more useful half — the full phrasing lives in the row's title attribute. */
const ACTIVITY_LABEL: Record<FriendActivity, string> = {
  today: "seen today",
  week: "seen this week",
  away: "seen a while",
};

/** The Black Market prices each post in one currency, chosen by whoever created it, so
 *  every amount it shows has to carry which one it is. These three are the whole of it:
 *  the coin art, the wording ("500 gold" / "5 brains"), and the max the form accepts. */
const MARKET_COIN: Record<BlackMarketCurrency, string> = {
  BRAINS: "topbar_brain_icon.png",
  GOLD: "topbar_money_icon.png",
};
const MARKET_MAX_PRICE = 10_000_000;
/** Most boost packs one confirmation will buy. Online every pack is a separate
 *  atomic `inventory buy` command (the server prices and debits each one), so this
 *  also bounds a single tap's command burst against the Worker's rate budget. */
const BOOST_BUY_LIMIT = 10;
function marketPrice(amount: number, currency: BlackMarketCurrency): string {
  if (currency === "GOLD") return `${amount.toLocaleString()} gold`;
  return `${amount.toLocaleString()} brain${amount === 1 ? "" : "s"}`;
}

/** "2d 4h" / "5h 12m" / "18m" — how long until a Black Market post expires, or until
 *  its owner may bump it again. Deliberately coarser than fmtCooldown, which is built
 *  to tick down a two-hour raid timer and would render three days as "71h 59m". */
function fmtMarketWait(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A 0..1 chance as a short percentage. Drop rates run from 0.8% to ~15%, so keep enough
 *  precision at the low end to tell 0.8% from 1% without printing "6.30%" at the high end. */
function pctOdds(chance: number): string {
  const v = Math.max(0, chance) * 100;
  const s = v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
  return `${s.includes(".") ? s.replace(/\.?0+$/, "") : s}%`;
}

/** Player-facing wording for what a gift paid out ("a brain 🧠", "300 gold 💰"). */
function giftRewardLabel(reward: GiftReward): string {
  if (reward.kind === "brain") {
    return reward.amount === 1 ? "a brain 🧠" : `${reward.amount} brains 🧠`;
  }
  return `${reward.amount.toLocaleString()} gold 💰`;
}



export class Hud {
  mode: Mode = "walk";
  onModeChange: (() => void) | null = null;
  // Rotate tool tap: main handles it contextually (flip the placement ghost / the
  // carried object / enter the standalone rotate mode). Null falls back to setMode.
  onRotateTool: (() => void) | null = null;
  /** Extra lines for the diagnostics report — the online layer's live state, which is
   *  otherwise invisible in a paste. "Gameplay paused" and "a healthy pause" look
   *  identical without it. Null offline: there is nothing to say. */
  getDiagnosticExtras: (() => Record<string, string>) | null = null;
  // Public (not private) so the extracted panel modules in ui/panels/* can render
  // into the HUD root and read shared services. Treat as internal to the HUD.
  readonly el: HTMLElement;
  private writerLock: HTMLElement | null = null;
  private writerBanner: HTMLElement | null = null;
  private writerTakeover: (() => Promise<boolean>) | null = null;
  private tutorialMenuTarget: string | null = null;
  private visitExit: (() => void) | null = null;
  private goldEl!: HTMLElement;
  private brainsEl!: HTMLElement;
  private zombiesEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private levelChip!: HTMLElement;
  private xpDetails!: HTMLElement;
  private nameEl!: HTMLElement;
  private playStatusEl!: HTMLElement;
  private questCol!: HTMLElement;
  private questViews: QuestView[] = [];
  private questLogModal: ModalHandle | null = null;
  private questDetailModal: { id: string; handle: ModalHandle } | null = null;
  private periodicViews: PeriodicScopeView[] = [];
  private periodicModal: ModalHandle | null = null;
  private periodicButton: HTMLButtonElement | null = null;
  /** Set by main.ts. Collecting a finished daily/weekly quest. */
  onPeriodicQuestClaim: ((scope: PeriodicScope, questId: string) => void) | null = null;
  private tools: Record<string, HTMLButtonElement> = {};
  private menuCol!: HTMLElement;
  private toolsBar!: HTMLElement;
  private fab!: HTMLButtonElement;
  private fabImg!: HTMLImageElement;
  private fabCt?: HTMLElement; // count badge on the fab (Insta-Grow uses left)
  private touchCancel!: HTMLButtonElement;
  private collapsed = false;
  private plantCards: MenuCard[] = [];
  private zombieCards: MenuCard[] = [];
  private blackMarketZombieCards: MenuCard[] = [];
  objectCards: ObjCard[] = []; // shared with panel modules (ui/panels/*)
  private farmUpgrades: FarmSizeUpgrade[] = []; // Market Upgrade tab (Farm Size)
  private farmer: FarmerCatalog = { heads: [], bodies: [] };
  pets: PetCatalog = { version: 0, pets: [] }; // shared with panel modules
  private bossActive = false;
  private plantingCrop: CropConfig | null = null;
  private placingObj: PlaceableDef | null = null;
  private plantLabel!: HTMLElement;
  private cropHover!: HTMLElement;
  private cropHoverInfo: { name: string; ripe: boolean; remainingMs: number; fertilized: boolean } | null = null;
  private cropHoverShownAt = 0;
  private cropHoverX = 0;
  private cropHoverY = 0;
  private temporaryPanMode: Mode | null = null;
  private battleLoading: HTMLElement | null = null;
  onTemporaryPanChange: (() => void) | null = null;

  get planting(): CropConfig | null {
    return this.plantingCrop;
  }
  get placing(): PlaceableDef | null {
    return this.placingObj;
  }

  constructor(readonly state: GameState, readonly audio: AudioManager, playMode: PlayMode = "local") {
    // Styles are injected by the `import "./ui/hud.css"` at the top of this module.
    this.el = document.getElementById("hud")!;
    this.el.innerHTML = "";
    this.playMode = playMode;
    this.buildTopBar();
    this.buildQuests();
    this.buildMenu();
    this.buildTools();
    this.buildFab();
    this.buildTouchCancel();
    this.buildPlantLabel();
    this.buildInvadeShortcut();
    this.buildCropHover();
    this.wireMenuSounds();
    this.wireUiToggle();
    this.wireFullscreenToggle();
    this.wireActionHotkeys();
    state.onChange(() => this.update());
    this.update();
    // Mobile (esp. landscape) starts with the menu + tools tucked into the corner
    // fab. The capped quest rail remains visible on every farm view.
    // Desktop keeps the full chrome on screen.
    if (isMobile()) {
      this.collapse();
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
    let interactiveAt = 0;
    const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          // Arm every newly-added interactive HUD surface, including the shared
          // modal scaffold and hand-built storage/market/raid panels. This runs
          // before the browser dispatches the opening tap's compatibility click.
          if (n.matches("button, a, input, select, textarea, [role='button']") ||
              n.querySelector("button, a, input, select, textarea, [role='button']")) {
            interactiveAt = clock() + MENU_ACTIVATION_DELAY_MS;
          }
          if ([...n.classList].some((c) => BACKDROP.has(c))) this.audio.play("menuOpen");
        }
      }
    });
    mo.observe(this.el, { childList: true });
    this.el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const interactive = !!target?.closest("button, a, input, select, textarea, [role='button']");
      if (!shouldBlockFreshMenuActivation(interactiveAt, clock(), interactive)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      // X button (or its inner <img>), or a click on the backdrop itself.
      if (t.closest(CLOSE) || [...t.classList].some((c) => BACKDROP.has(c)))
        this.audio.play("menuClose");
    });
  }

  // "u" (when not typing) hides all farm chrome for a clean look at the farm; press
  // again to bring it back. Ignored while a panel/overlay is open, during a raid, or
  // when a friend's farm is being visited (that chrome is already managed elsewhere).
  private wireUiToggle() {
    window.addEventListener("keydown", (e) => {
      if (e.key !== "u" && e.key !== "U") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      if (this.el.classList.contains("raiding") || this.el.classList.contains("tutorial")) return;
      e.preventDefault();
      this.el.classList.toggle("ui-hidden");
    });
  }

  // "f" toggles fullscreen from anywhere in the game. Leave Escape alone so the
  // browser's native fullscreen exit continues to work, and ignore the shortcut
  // while the player is typing into a form field.
  private wireFullscreenToggle() {
    window.addEventListener("keydown", (e) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      if (
        this.el.classList.contains("tutorial") ||
        !document.fullscreenEnabled ||
        typeof document.documentElement.requestFullscreen !== "function"
      )
        return;
      e.preventDefault();
      void this.toggleFullscreen().catch(() => {
        // Some browsers can still reject fullscreen despite advertising support.
      });
    });
  }

  // Farm shortcuts. Menu keys only act from the unobstructed farm view; Escape
  // closes the top overlay, then opens Settings on an unobstructed desktop farm.
  // Holding Space temporarily borrows Select/pan without discarding a crop,
  // placement, or carried object.
  private wireActionHotkeys() {
    const typing = (target: EventTarget | null) => {
      const t = target as HTMLElement | null;
      return !!t && (t.isContentEditable || t.matches("input, textarea, select"));
    };
    const hasOverlay = () => !!this.el.querySelector(
      ".panelbg, .mkt-bg, .info-bg, .st-bg, .pm-bg, .raid-res-bg, .revive-bg"
    );
    const activate = (mode: Mode) => {
      if (this.mode !== mode) this.setMode(mode);
    };

    window.addEventListener("keydown", (e) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        if (this.el.classList.contains("tutorial")) { e.preventDefault(); return; }
        if (document.fullscreenElement) return; // preserve native fullscreen exit
        if (this.closeTopOverlay()) { e.preventDefault(); return; }
        if (!e.repeat && !isMobile() && !this.el.classList.contains("raiding") &&
            !this.el.classList.contains("visiting")) {
          e.preventDefault();
          this.openSettings();
          return;
        }
        this.endTemporaryPan();
        if (this.mode !== "walk") { e.preventDefault(); this.setMode("walk"); }
        return;
      }

      if (this.el.classList.contains("raiding") || this.el.classList.contains("visiting") ||
          this.el.classList.contains("tutorial")) return;

      if (e.code === "Space") {
        if (!hasOverlay()) {
          e.preventDefault();
          if (!e.repeat) this.beginTemporaryPan();
        }
        return;
      }
      if (e.repeat || hasOverlay()) return;

      const key = e.key.toLowerCase();
      if (!new Set(["1", "2", "3", "4", "5", "p", "m", "i", "z", "b", "r", "q"]).has(key)) return;
      this.endTemporaryPan();
      const handled = () => { e.preventDefault(); this.audio.play("menuClick"); };
      if (key === "1") { handled(); activate("walk"); }
      else if (key === "2") { handled(); activate("move"); }
      else if (key === "3") {
        handled();
        this.onRotateTool ? this.onRotateTool() : activate("rotate");
      }
      else if (key === "4") { handled(); activate("till"); }
      else if (key === "5") { handled(); activate("remove"); }
      else if (key === "p") {
        handled();
        this.openPlantMenu((cfg) => this.setPlanting(cfg));
      } else if (key === "m") { handled(); this.openMarket(); }
      else if (key === "i") { handled(); this.openRaids(); }
      else if (key === "z") { handled(); this.openZombieList(); }
      else if (key === "b") { handled(); this.openStorage("Boosts"); }
      else if (key === "r") { handled(); this.openStorage(); }
      else if (key === "q") { handled(); this.openQuestLog(); }
    });

    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.endTemporaryPan();
    });
    window.addEventListener("blur", () => this.endTemporaryPan());
  }

  private beginTemporaryPan() {
    if (this.temporaryPanMode !== null) return;
    this.temporaryPanMode = this.mode;
    this.mode = "walk";
    this.refreshTools();
    this.onTemporaryPanChange?.();
  }

  private endTemporaryPan() {
    if (this.temporaryPanMode === null) return;
    this.mode = this.temporaryPanMode;
    this.temporaryPanMode = null;
    this.refreshTools();
    this.onTemporaryPanChange?.();
  }

  get isTemporaryPanning(): boolean {
    return this.temporaryPanMode !== null;
  }

  async toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
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
    lv.className = "chip level-chip";
    lv.tabIndex = 0;
    lv.setAttribute("role", "button");
    lv.setAttribute("aria-expanded", "false");
    this.levelChip = lv;
    const star = document.createElement("img");
    star.src = UI("topbar_level_icon.png");
    star.style.height = "18px";
    this.levelEl = document.createElement("span");
    const track = document.createElement("div");
    track.className = "xpbar";
    this.xpFill = document.createElement("div");
    this.xpFill.className = "xpfill";
    track.appendChild(this.xpFill);
    this.xpDetails = document.createElement("div");
    this.xpDetails.className = "xp-details";
    this.xpDetails.setAttribute("role", "tooltip");
    lv.append(star, this.levelEl, track, this.xpDetails);
    const toggleXpDetails = () => {
      const open = lv.classList.toggle("xp-details-open");
      lv.setAttribute("aria-expanded", String(open));
    };
    lv.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleXpDetails();
    });
    lv.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleXpDetails();
    });
    document.addEventListener("click", () => {
      lv.classList.remove("xp-details-open");
      lv.setAttribute("aria-expanded", "false");
    });
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
    name.title = this.playMode === "local" ? "Local Farm" : "Account";
    name.setAttribute("role", "button");
    // Clicking your name opens the Account menu (who you're signed in as + Sign
    // out). Profile SWITCHING is intentionally not exposed here for now (see
    // openProfiles) — the friend code / add / gift / visit all live in Friends.
    name.onclick = () => this.openProfiles();
    this.nameEl = name;
    this.playStatusEl = document.createElement("button");
    this.playStatusEl.className = "play-status local";
    this.playStatusEl.textContent = "LOCAL FARM";
    this.playStatusEl.setAttribute("type", "button");
    this.playStatusEl.setAttribute("aria-label", "Current farm: Local Farm. Choose Local or Online.");
    this.playStatusEl.title = "Choose Local or Online";
    this.playStatusEl.onclick = () => this.openProfiles();

    // Account button: a person icon just right of the nameplate. Opens the same
    // Account menu; stays visible on mobile (where the nameplate is hidden), so
    // Sign out is reachable on every platform.
    const prof = document.createElement("button");
    prof.className = "profbtn";
    prof.title = this.playMode === "local" ? "Local Farm" : "Account";
    prof.setAttribute("aria-label", prof.title);
    const profImg = document.createElement("img");
    profImg.src = UI("Icon_Quest_Social.png");
    prof.appendChild(profImg);
    prof.onclick = () => this.openProfiles();

    bar.append(gear, chips, spacer, ...(devHot ? [devHot] : []), this.playStatusEl, name, prof);
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
    if (this.questLogModal) this.renderQuestLog(this.questLogModal.panel);
    if (this.questDetailModal) {
      const current = this.questViews.find((view) => view.id === this.questDetailModal!.id);
      if (current) this.renderQuestDetail(this.questDetailModal.handle.panel, current);
      else this.questDetailModal.handle.close();
    }
  }

  // The rail shows only the first RAIL_MAX active quests; the rest live in the quest
  // log (opened by the expand button). Activation itself is uncapped upstream.
  private static readonly RAIL_MAX = 4;

  private questCard(q: QuestView): HTMLButtonElement {
    const card = document.createElement("button");
    card.className = "quest quest-entry";
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
      more.title = "View all quests (Q)";
      more.innerHTML = `<span class="qmore-glyph">☰</span>`;
      const badge = document.createElement("span");
      badge.className = "qbadge";
      badge.textContent = String(this.questViews.length);
      more.appendChild(badge);
      more.onclick = () => this.openQuestLog();
      this.questCol.appendChild(more);
    }
    this.renderPeriodicButton();
  }

  /** Daily/weekly quests get their own rail button rather than a slot on the quest
   *  rail: they are a separate board with a separate lifecycle, and mixing them in
   *  would push the progression quests off a four-slot rail every day. */
  private renderPeriodicButton() {
    if (!this.questCol) return;
    this.periodicButton?.remove();
    this.periodicButton = null;
    if (!this.periodicViews.length) return;
    const claimable = this.periodicViews.reduce(
      (total, scope) => total + scope.quests.filter((q) => q.done && !q.claimed).length, 0);
    const button = document.createElement("button");
    button.className = "quest qperiodic" + (claimable ? " ready" : "");
    button.title = claimable ? `${claimable} quest reward${claimable === 1 ? "" : "s"} to collect`
      : "Daily & weekly quests";
    button.setAttribute("aria-label", button.title);
    const glyph = document.createElement("span");
    glyph.className = "qperiodic-glyph";
    glyph.textContent = "★";
    button.appendChild(glyph);
    // Only badge what needs COLLECTING. A count of open quests would sit there all day
    // saying five, which trains players to ignore it — the point of the badge is that
    // it means "there is XP waiting for you right now".
    if (claimable) {
      const badge = document.createElement("span");
      badge.className = "qbadge";
      badge.textContent = String(claimable);
      button.appendChild(badge);
    }
    button.onclick = () => this.openPeriodicQuests();
    this.questCol.appendChild(button);
    this.periodicButton = button;
  }

  /** Push authoritative (or locally generated) daily/weekly state into the HUD. */
  setPeriodicQuests(views: PeriodicScopeView[]) {
    this.periodicViews = views;
    this.renderPeriodicButton();
    if (this.periodicModal) renderPeriodicQuests(this.periodicModal.panel, this.periodicPanelView());
  }

  private periodicPanelView(): PeriodicQuestPanelView {
    return {
      scopes: this.periodicViews,
      onClaim: (scope, questId) => this.onPeriodicQuestClaim?.(scope, questId),
    };
  }

  private openPeriodicQuests() {
    this.periodicModal?.close();
    this.periodicModal = openPeriodicQuests(this.el, this.periodicPanelView(), () => {
      this.periodicModal = null;
    });
  }

  // Full quest screen: every active quest as a card with its objectives, scrollable.
  private openQuestLog() {
    this.questLogModal?.close();
    let handle!: ModalHandle;
    handle = openModal({
      host: this.el, panelClass: "questlog", title: "Quests",
      onClose: () => { if (this.questLogModal === handle) this.questLogModal = null; },
    });
    this.questLogModal = handle;
    this.renderQuestLog(handle.panel);
  }

  private renderQuestLog(panel: HTMLElement) {
    const heading = panel.querySelector("h2");
    if (heading) heading.textContent = `Quests (${this.questViews.length})`;
    panel.querySelector(".qlog-list")?.remove();
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
        row.textContent = `${o.done ? "✓" : "◆"} ${o.text}  (${Math.min(o.count, o.total)}/${o.total})`;
        body.appendChild(row);
      }
      if (q.reward) {
        const reward = document.createElement("div");
        reward.className = "qlog-reward";
        const rewardIcon = document.createElement("img");
        rewardIcon.src = UI(q.reward.icon);
        rewardIcon.alt = "";
        rewardIcon.onerror = () => { rewardIcon.style.visibility = "hidden"; };
        const rewardLabel = document.createElement("span");
        rewardLabel.textContent = `Reward: ${q.reward.label}`;
        reward.append(rewardIcon, rewardLabel);
        // A few achievements pay a brain ON TOP of their XP. Shown as a second chip so
        // the headline reward keeps its usual shape.
        if (q.bonus) {
          const bonusIcon = document.createElement("img");
          bonusIcon.src = UI(q.bonus.icon);
          bonusIcon.alt = "";
          bonusIcon.onerror = () => { bonusIcon.style.visibility = "hidden"; };
          const bonusLabel = document.createElement("span");
          bonusLabel.textContent = q.bonus.label;
          reward.append(bonusIcon, bonusLabel);
        }
        body.appendChild(reward);
      }
      item.append(img, body);
      list.appendChild(item);
    }
    panel.append(list);
  }

  // A quest's detail popup: title, tip, and each objective with its live count.
  private openQuestDetail(q: QuestView) {
    this.questDetailModal?.handle.close();
    let handle!: ModalHandle;
    handle = openModal({
      host: this.el,
      panelClass: "qdetail",
      title: q.title,
      onClose: () => {
        if (this.questDetailModal?.handle === handle) this.questDetailModal = null;
      },
    });
    this.questDetailModal = { id: q.id, handle };
    this.renderQuestDetail(handle.panel, q);
  }

  private renderQuestDetail(panel: HTMLElement, q: QuestView) {
    const heading = panel.querySelector("h2");
    if (heading) heading.textContent = q.title;
    panel.querySelectorAll(".qobj, .qtip, .qreward-title, .qreward").forEach((node) => node.remove());
    for (const o of q.objectives) {
      const row = document.createElement("div");
      row.className = "qobj" + (o.done ? " done" : "");
      const mark = o.done ? "✓" : "◆";
      row.textContent = `${mark} ${o.text}  (${Math.min(o.count, o.total)}/${o.total})`;
      panel.appendChild(row);
    }
    if (q.tip) {
      const tip = document.createElement("p");
      tip.className = "qtip";
      tip.textContent = q.tip;
      panel.appendChild(tip);
    }
    if (q.reward) {
      const heading = document.createElement("div");
      heading.className = "qreward-title";
      heading.textContent = "Reward";
      const reward = document.createElement("div");
      reward.className = "qreward";
      const icon = document.createElement("img");
      icon.src = UI(q.reward.icon);
      icon.alt = "";
      icon.onerror = () => { icon.style.visibility = "hidden"; };
      const label = document.createElement("span");
      label.textContent = q.reward.label;
      reward.append(icon, label);
      // The brain a few achievements pay alongside their XP (see questBonusRewardInfo).
      if (q.bonus) {
        const bonusIcon = document.createElement("img");
        bonusIcon.src = UI(q.bonus.icon);
        bonusIcon.alt = "";
        bonusIcon.onerror = () => { bonusIcon.style.visibility = "hidden"; };
        const bonusLabel = document.createElement("span");
        bonusLabel.textContent = q.bonus.label;
        reward.append(bonusIcon, bonusLabel);
      }
      panel.append(heading, reward);
    }
  }

  setPlayStatus(
    mode: PlayMode,
    state: "synced" | "saving" | "reconnecting" | "cached" = "synced",
    pending = 0,
  ) {
    const statusLabel = mode === "local"
      ? "Saved on this device"
      : state === "synced" ? "Everything synced"
      : state === "saving" ? `${pending || "Some"} change${pending === 1 ? "" : "s"} waiting to sync`
      : state === "reconnecting" ? "Reconnecting; changes may be waiting to sync"
      : "Offline view; changes may be waiting to sync";
    this.playStatusEl.className = `play-status ${mode} ${state}`;
    this.playStatusEl.textContent = mode === "local"
      ? "LOCAL FARM"
      : state === "cached" ? "ONLINE · OFFLINE VIEW"
      : state === "reconnecting" ? "ONLINE · RECONNECTING"
      : state === "saving" ? `ONLINE · SAVING${pending ? ` (${pending})` : ""}`
      : "ONLINE · SYNCED";
    this.playStatusEl.setAttribute(
      "aria-label",
      `${mode === "local" ? "Local Farm" : "Online Farm"}: ${statusLabel}. Choose Local or Online.`
    );
    this.playStatusEl.title = `${statusLabel}. Choose Local or Online.`;
  }

  // Brief top-center banner for quest completion (messageComplete).
  showToast(msg: string, durationMs = 2600) {
    const t = document.createElement("div");
    t.className = "qtoast";
    t.textContent = msg;
    this.el.appendChild(t);
    window.setTimeout(() => t.classList.add("show"), 10);
    window.setTimeout(() => {
      t.classList.remove("show");
      window.setTimeout(() => t.remove(), 400);
    }, durationMs);
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

  // Compact icon dock: keeps these secondary destinations visually grouped and
  // clears the middle-right playfield that the old stack of wide pills covered.
  private buildMenu() {
    const items = [
      { label: "Zombies", icon: UI("menu_zombies_icon.png"), shortcut: "Z" },
      { label: "Boosts", icon: `${BASE}assets/boosts/insta_grow.png`, shortcut: "B" },
      { label: "Storage", icon: UI("menu_storage_icon.png"), shortcut: "R" },
      { label: "Market", icon: UI("button_market.png"), shortcut: "M" },
      ...(this.playMode === "online"
        ? [{ label: "Social", icon: UI("button_friends.png"), shortcut: "" }]
        : []),
      { label: "Guide", icon: UI("button_menu.png"), shortcut: "" },
    ];
    const col = document.createElement("div");
    col.className = "menucol";
    this.menuCol = col;
    for (const m of items) {
      const btn = document.createElement("button");
      btn.className = "mbtn";
      btn.dataset.menu = m.label; // stable anchor for the tutorial arrow (menuButton())
      btn.title = m.shortcut ? `${m.label} (${m.shortcut})` : m.label;
      const icon = document.createElement("img");
      icon.className = "micon";
      icon.src = m.icon;
      icon.alt = "";
      const g = document.createElement("span");
      g.className = "gbtn";
      g.textContent = m.label;
      btn.append(icon, g);
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
                  : m.label === "Social"
                    ? this.openSocial()
                    : m.label === "Guide"
                      ? openFarmersGuide(this.el)
                    : this.openPanel(m.label, "Coming soon.");
      col.appendChild(btn);
    }
    this.el.appendChild(col);
  }

  /** Confirm a Market purchase that COMMITS on the tap. Crops and Items deliberately
   *  do not use this: buying one only arms a planting/placement step the player still
   *  has to finish (or cancel with a right-click), so the commitment is already
   *  explicit and a prompt there is pure friction. Everything else — farm size,
   *  ground, farmer parts, pets, an in-place shed/Mausoleum upgrade — spends the
   *  moment the card is tapped, so it asks first (boosts get the quantity dialog
   *  below instead). A free item needs no prompt. */
  private confirmPurchase(name: string, cost: number, brains = false): Promise<boolean> {
    if (cost <= 0) return Promise.resolve(true);
    return this.confirmInGame(
      `Buy ${name}?`,
      `This costs ${cost.toLocaleString()} ${brains ? "brains" : "gold"}.`,
      "Buy"
    );
  }

  /** Boost-purchase confirmation with a quantity stepper. Resolves the number of
   *  packs the player asked for (0 = cancelled); the caller performs the buy, which
   *  re-checks funds pack by pack. Gold and brains keep moving underneath an open
   *  dialog (zombies harvest, the farmer spends), so the affordability cap is
   *  re-read from live state on a short interval rather than captured once — and
   *  even the resolved quantity is only a request, not a reservation. */
  private confirmBoostQuantity(b: BoostDef): Promise<number> {
    if (b.cost <= 0) return Promise.resolve(1);
    return new Promise((resolve) => {
      let settled = false;
      let qty = 1;
      let ticker: ReturnType<typeof setInterval> | undefined;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        if (ticker !== undefined) clearInterval(ticker);
        resolve(value);
      };
      const { panel, close } = openModal({
        host: this.el, bgClass: "game-confirm-bg", panelClass: "confirm-panel",
        title: `Buy ${b.name}?`, replaceSelector: ".game-confirm-bg", onClose: () => finish(0),
      });
      const coin = b.brainsNeeded ? "brains" : "gold";
      const copy = document.createElement("p");
      copy.className = "confirm-msg";
      copy.textContent = b.perPurchase > 1
        ? `Each purchase gives ${b.perPurchase} uses and costs ${b.cost.toLocaleString()} ${coin}.`
        : `Each one costs ${b.cost.toLocaleString()} ${coin}.`;
      const row = document.createElement("div");
      row.className = "confirm-qty-row";
      const minus = document.createElement("button");
      minus.className = "zbtn";
      minus.textContent = "−";
      minus.setAttribute("aria-label", "Buy one fewer");
      const count = document.createElement("span");
      count.className = "confirm-qty";
      const plus = document.createElement("button");
      plus.className = "zbtn";
      plus.textContent = "+";
      plus.setAttribute("aria-label", "Buy one more");
      row.append(minus, count, plus);
      const total = document.createElement("p");
      total.className = "confirm-msg confirm-qty-total";
      const buttons = document.createElement("div");
      buttons.className = "zbtns";
      const cancel = document.createElement("button");
      cancel.className = "zbtn locate";
      cancel.textContent = "Cancel";
      cancel.onclick = () => close();
      const accept = document.createElement("button");
      accept.className = "zbtn sell";
      markPrimary(accept); // Enter confirms
      accept.onclick = () => { finish(qty); close(); };
      buttons.append(cancel, accept);
      panel.append(copy, row, total, buttons);
      const funds = () => (b.brainsNeeded ? this.state.brains : this.state.gold);
      // Capped well below the Worker's 120-commands-per-minute budget: online each
      // pack is its own atomic `buy` command (see main.ts onBuyBoost).
      const maxQty = () => Math.max(1, Math.min(BOOST_BUY_LIMIT, Math.floor(funds() / b.cost)));
      const refresh = () => {
        qty = Math.min(qty, maxQty());
        count.textContent = String(qty);
        minus.disabled = qty <= 1;
        plus.disabled = qty >= maxQty();
        total.textContent =
          `Total: ${(qty * b.cost).toLocaleString()} ${coin} — you have ${funds().toLocaleString()}.`;
        accept.disabled = funds() < qty * b.cost;
        accept.textContent = qty > 1 ? `Buy ${qty}` : "Buy";
      };
      minus.onclick = () => { if (qty > 1) { qty--; refresh(); } };
      plus.onclick = () => { if (qty < maxQty()) { qty++; refresh(); } };
      ticker = setInterval(refresh, 400);
      refresh();
    });
  }

  /** Game-styled confirmation. Native browser confirm/prompt dialogs are never used. */
  confirmInGame(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // Close button and backdrop resolve false; the singleton dedupe drops any
      // stale confirm still on screen before opening this one.
      const { panel, close } = openModal({
        host: this.el, bgClass: "game-confirm-bg", panelClass: "confirm-panel",
        title, replaceSelector: ".game-confirm-bg", onClose: () => finish(false),
      });
      const copy = document.createElement("p");
      copy.className = "confirm-msg";
      copy.textContent = message;
      const buttons = document.createElement("div");
      buttons.className = "zbtns";
      const cancel = document.createElement("button");
      cancel.className = "zbtn locate";
      cancel.textContent = "Cancel";
      cancel.onclick = () => close();
      const accept = document.createElement("button");
      accept.className = "zbtn sell";
      accept.textContent = confirmLabel;
      markPrimary(accept); // Enter confirms
      accept.onclick = () => { finish(true); close(); };
      buttons.append(cancel, accept);
      panel.append(copy, buttons);
    });
  }

  /** One-off guidance in Tim Buckwheat's voice, outside the first-run tutorial.
   *  Resolves once the player acknowledges it, so a caller can await it before
   *  moving on. See ui/TimNotice.ts. */
  timSays(message: string, buttonLabel = "OK"): Promise<void> {
    return showTimNotice(this.el, message, buttonLabel);
  }

  showWriterLock(onTakeover: () => Promise<boolean>): void {
    this.writerTakeover = onTakeover;
    this.writerLock?.remove();
    this.writerBanner?.remove();
    // A takeover gate, not a dismissible dialog: no close button, no backdrop close.
    const { bg, panel } = openModal({
      host: this.el, bgClass: "writer-lock-bg", panelClass: "writer-lock-panel",
      title: "Farm active elsewhere", closeButton: false, backdropClose: false,
    });
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
    panel.append(copy, buttons);
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
    this.bossActive = active;
    const invade = this.el.querySelector<HTMLButtonElement>(".invade-shortcut");
    if (invade) {
      if (active) invade.dataset.bossTitle = `${label} active — open raids for details (I)`;
      else delete invade.dataset.bossTitle;
      invade.title = invade.dataset.bossTitle ?? "Invade (I)";
    }
  }

  private toolBtn(id: string, icon: string, label: string, shortcut: string, onClick: () => void) {
    const btn = document.createElement("button");
    btn.className = "tool";
    btn.title = `${label} (${shortcut})`;
    const img = document.createElement("img");
    img.src = UI(icon);
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = label;
    btn.append(img, lbl);
    btn.onclick = () => {
      const previousMode = this.mode;
      this.audio.play("menuClick");
      onClick();
      // On the compact HUD, choosing a tool should finish the toolbar interaction.
      // Otherwise the next farm tap both closes the toolbar and performs the newly
      // selected action, which makes that first action easy to trigger by accident.
      if (isMobile() && this.mode !== previousMode) this.collapse();
    };
    this.tools[id] = btn;
    return btn;
  }

  private buildTools() {
    const bar = document.createElement("div");
    bar.className = "tools";
    this.toolsBar = bar;
    bar.append(
      this.toolBtn("select", "button_multitool.png", "Select", "1", () => this.setMode("walk")),
      this.toolBtn("move", "button_move.png", "Move", "2", () => this.setMode("move")),
      this.toolBtn("rotate", "button_rotate.png", "Rotate", "3", () =>
        this.onRotateTool ? this.onRotateTool() : this.setMode("rotate")),
      this.toolBtn("till", "button_plow.png", "Plow", "4", () => this.setMode("till")),
      this.toolBtn("remove", "button_sell.png", "Remove", "5", () => this.setMode("remove"))
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
    this.refreshTouchCancel();
    this.refreshBoostBadge();
  }

  private refreshTouchCancel() {
    if (this.touchCancel)
      this.touchCancel.classList.toggle("active", this.collapsed && this.mode !== "walk");
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

  /** Phones have no right-click, so expose an always-reachable way to abandon any
   * edit/carry mode and return to the Multi-tool. CSS keeps it off desktop. */
  private buildTouchCancel() {
    const b = document.createElement("button");
    b.className = "touch-cancel";
    b.type = "button";
    b.setAttribute("aria-label", "Cancel current tool and select the Multi-tool");
    b.title = "Cancel tool";
    b.textContent = "×";
    b.onclick = () => { this.audio.play("menuClick"); this.setMode("walk"); };
    this.touchCancel = b;
    this.el.appendChild(b);
    this.refreshTools();
  }

  // Hide the right menu + bottom tools into the single bottom-right fab.
  // `chrome-expanded` on #hud lets the stylesheet move the remaining corner chrome
  // out of the way of the two bars — on a portrait phone the bottom-left invasion
  // shortcut sits underneath the tool bar, so it steps aside while they are out.
  collapse() {
    if (this.collapsed) return;
    this.collapsed = true;
    this.menuCol.style.display = "none";
    this.toolsBar.style.display = "none";
    this.fabImg.src = this.fabIconSrc();
    this.refreshBoostBadge(); // sync the fab's uses badge for the current mode
    this.fab.style.display = "block";
    this.el.classList.remove("chrome-expanded");
    this.refreshTouchCancel();
  }

  expand() {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.menuCol.style.display = "grid";
    this.toolsBar.style.display = "flex";
    this.fab.style.display = "none";
    this.el.classList.add("chrome-expanded");
    this.refreshTouchCancel();
  }

  /** Consume one mobile Back action. The topmost closeable overlay wins, followed
   * by the expanded chrome and then the active farm tool. Returns false only when
   * the browser should perform its normal navigation. */
  private closeTopOverlay(): boolean {
    const overlays = Array.from(this.el.querySelectorAll<HTMLElement>(
      ".panelbg, .mkt-bg, .info-bg, .st-bg, .pm-bg, .raid-res-bg, .revive-bg"
    )).filter((el) => el.isConnected && getComputedStyle(el).display !== "none");
    if (!overlays.length) return false;
    const top = overlays.reduce((best, el) => {
      const z = Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
      const bz = Number.parseInt(getComputedStyle(best).zIndex, 10) || 0;
      return z > bz || (z === bz && (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
        ? el : best;
    });
    const close = top.querySelector<HTMLElement>(
      ".panelclose, .mkt-close, .info-close, .st-close, .pm-close"
    );
    if (!close) return true; // mandatory result/writer-lock screens stay mandatory
    close.click();
    return true;
  }

  handleMobileBack(): boolean {
    if (this.el.classList.contains("tutorial")) return true;
    if (this.el.classList.contains("visiting") && this.visitExit) {
      this.visitExit();
      return true;
    }
    if (this.closeTopOverlay()) return true;
    if (this.el.classList.contains("raiding")) return true;
    if (!this.collapsed) {
      this.collapse();
      return true;
    }
    if (this.mode !== "walk") {
      this.setMode("walk");
      return true;
    }
    return false;
  }

  // Catalog for the plant/zombie picker (built by main from the market data).
  setCatalog(plants: MenuCard[], zombies: MenuCard[]) {
    // This ONE list feeds Market → Crops → Plants and the picker opened from tilled
    // soil. The complete crop-config map in main still restores planted event crops.
    this.plantCards = plants.filter(cropAvailableInMarket).sort(compareCropMarketOrder);
    this.zombieCards = [...zombies].sort((a, b) => a.level - b.level);
  }

  /** Full zombie type catalog for player-to-player trading. Unlike the ordinary
   * crop market, this includes hidden and reward-only types. */
  setBlackMarketCatalog(zombies: MenuCard[]) {
    this.blackMarketZombieCards = [...zombies].sort((a, b) => a.name.localeCompare(b.name));
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
  boosts: BoostDef[] = []; // shared with panel modules
  setBoosts(boosts: BoostDef[]) {
    this.boosts = boosts;
  }
  setFarmerCatalog(catalog: FarmerCatalog) { this.farmer = catalog; }
  /** Catalog row for a head id reported by the server, for the friends list and the
   *  leaderboard panel. Returns null for an unknown or absent id — a head this build
   *  has no art for must draw nothing rather than silently show a different player's
   *  face. */
  friendHeadPart(headId: number | undefined): FarmerHeadDef | null {
    if (headId === undefined) return null;
    return this.farmer.heads.find((head) => head.id === headId) ?? null;
  }
  setPetCatalog(catalog: PetCatalog) { this.pets = catalog; }
  onBuyFarmerHead: ((head: FarmerHeadDef) => boolean) | null = null;
  onEquipFarmerHead: ((head: FarmerHeadDef) => void) | null = null;
  onEquipFarmerBody: ((body: FarmerBodyDef) => void) | null = null;
  /** Pin the head supplying bonuses, or null to follow the worn one. */
  onEquipFarmerBonusHead: ((headId: number | null) => void) | null = null;
  onBuyPet: ((pet: PetDef) => boolean) | null = null;
  onEquipPet: ((pet: PetDef | null) => void) | null = null;
  onSetPenPets: ((pets: PetDef[]) => void) | null = null;
  // Buy `qty` packs of a boost into inventory (default 1). Returns how many packs
  // were actually paid for — each pack re-checks funds, so a background spend or
  // harvest between confirm and buy shortens the run instead of overdrafting.
  onBuyBoost: ((def: BoostDef, qty?: number) => number) | null = null;
  onUseBoost: ((def: BoostDef) => void) | null = null;
  /** Whether a farm boost currently has a valid target. Used to prevent no-op uses. */
  canUseBoost: ((def: BoostDef) => boolean) | null = null;

  // Entering placement mode for a bought object (set by main).
  onBuy: ((def: PlaceableDef) => void) | null = null;
  /** Whether the total owned count (placed + stored) reached this item's limit. */
  objectLimitReached: ((def: PlaceableDef) => boolean) | null = null;
  // Storage slots of the currently-placed shed (0 = none). Drives which single
  // shed the Market offers: only the NEXT upgrade above the current tier.
  getShedSlots: (() => number) | null = null;
  /** Whether a colored grave is placed (gates planting that zombie class). */
  hasGrave: ((color: "Blue" | "Red" | "Silver") => boolean) | null = null;
  /** Whether the Plowing Monolith is placed — it moves the plow XP onto harvests,
   *  so the per-harvest XP quoted on crop cards has to account for it. */
  hasPlowFree: (() => boolean) | null = null;
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
  /** The Zombie Almanac's entry list (every obtainable species + discovery counts). */
  getAlmanac: (() => AlmanacEntryView[]) | null = null;
  /** The Almanac's field notes: the systems a one-line obtain hint cannot explain
   *  (the Zombie Pot, Brain Tickets, the Epic Boss events). Catalog prices and the
   *  event lineup are folded in by main, so the panel just renders what it gets. */
  getAlmanacGuide: (() => AlmanacGuideTopic[]) | null = null;
  /** The Mutation Almanac's entry list: every mutation + its discovery count. */
  getMutationAlmanac: (() => MutationAlmanacEntry[]) | null = null;
  /** The Statistics panel's rows, already resolved and formatted by main.ts (it owns
   *  the catalogs a crop key has to be read through). Null while the game is still
   *  booting, which is the one state in which the Account menu can be opened without
   *  a farm behind it. */
  getStats: (() => StatSection[]) | null = null;
  /** Portrait image URL for a zombie type key (per-type composite). */
  zombiePortraitOf: ((key: string) => string) | null = null;
  /** Render one owned zombie with its complete individual mutation mask. `wanted`
   *  reports whether the tile that asked still needs it: each render blocks the main
   *  thread on a GPU readback, and they are queued one per frame, so a panel the
   *  player closes mid-burst must not keep paying for portraits nobody can see. */
  zombieMutationPortraitOf: ((
    key: string,
    mutation: number,
    color?: [number, number, number],
    wanted?: () => boolean,
    /** Draw the mask even when the player has mutations hidden — the Mutation
     *  Almanac only, where suppressing them would empty the catalog. */
    forceMutation?: boolean,
  ) => Promise<string>) | null = null;
  /** One zombie's look changed on this device (its card hid or restored a
   *  mutation). Nothing about the unit itself moved, so the host only has to
   *  reassemble the rigs that are already on screen. */
  onZombieAppearanceChanged: ((id: string) => void) | null = null;
  /** Take a deployed zombie off the farm (into the Mausoleum). */
  onZombieStore: ((id: string) => void | Promise<void>) | null = null;
  /** Change an owned zombie's individual display name. */
  onZombieRename: ((id: string, name: string) => string | null) | null = null;
  /** Put a stored zombie back on the farm. */
  onZombieDeploy: ((id: string) => void | Promise<void>) | null = null;
  /** Whether a Mausoleum exists to store zombies in (gates the Store action). */
  canStoreZombies: (() => boolean) | null = null;
  /** Mausoleum storage-slot capacity (shown as fixed slots). The placed building's
   *  tier decides it, so it is read on every render, not cached. 0 = none placed. */
  getMausoleumCap: (() => number) | null = null;
  /** The next Mausoleum tier the placed building can be upgraded to, or null when
   *  none is placed / it is already the top tier. */
  getMausoleumUpgrade: (() => { name: string; cost: number; brains: boolean; slots: number } | null) | null = null;
  /** Pay for and apply that upgrade (charges, swaps the building in place). */
  onMausoleumUpgrade: (() => void | Promise<void>) | null = null;
  /** Whether the farm has a free army slot (gates the Deploy action). */
  canDeployZombie: (() => boolean) | null = null;
  // ---- saved line-ups ("Zombie Teams", opened from the Mausoleum) ----
  /** The saved teams, newest last. Read on every render — never cached. */
  getTeams: (() => ZombieTeam[]) | null = null;
  /** Persist an edited team list (create / rename / re-pick / delete). */
  onTeamsChange: ((teams: ZombieTeam[]) => void) | null = null;
  /** Put exactly these zombies on the farm and everyone else in the Mausoleum.
   *  Returns what actually moved, or null when the move was refused outright
   *  (offline gameplay gate) — in which case main.ts has already explained why. */
  onTeamAssemble: ((memberIds: string[]) => Promise<TeamAssembleResult | null>) | null = null;
  /** How many zombies the farm can field at once (the team picker's cap). */
  getArmyCap: (() => number) | null = null;
  /** Whether an incoming zombie has anywhere to land — a free army slot, or a free
   *  slot in a Mausoleum that is actually placed. Advisory only: the server decides
   *  for real when the delivery is claimed. */
  canTakeZombieDelivery: (() => boolean) | null = null;
  /** Select a deployed zombie and center the camera on it. */
  onZombieLocate: ((id: string) => void) | null = null;
  /** Permanently sell an owned zombie for gold (after confirmation). */
  onZombieSell: ((id: string) => void | Promise<void>) | null = null;
  /** Market pricing of a zombie type — drives the gold sell payout shown on the
   *  detail card (brain prices convert at 1,000 gold per brain). */
  zombieBaseCost: ((key: string) => number) | null = null;
  zombieCostsBrains: ((key: string) => boolean) | null = null;
  getBlackMarketOrders: ((query: {
    kind: BlackMarketOrderKind; zombieClass?: string; zombieGroup?: string;
    currency?: BlackMarketCurrency;
    sort?: "newest" | "price_asc" | "price_desc"; mine?: boolean;
  }) => Promise<BlackMarketListResponse>) | null = null;
  onCreateBlackMarketOrder: ((input:
    | { kind: "SELL_ZOMBIE"; unitId: string; price: number; currency: BlackMarketCurrency }
    | { kind: "BUY_ZOMBIE"; zombieKey: string; mutated: boolean; mutationRequired?: number;
        price: number; currency: BlackMarketCurrency }
  ) => Promise<BlackMarketMutationResponse>) | null = null;
  onCancelBlackMarketOrder: ((orderId: string) => Promise<BlackMarketMutationResponse>) | null = null;
  /** Bump one of the player's own open posts back to the top of "newest" and restart
   *  its three-day life. Rejects with `repost_cooldown` when it is bumped too soon. */
  onRepostBlackMarketOrder: ((orderId: string) => Promise<BlackMarketMutationResponse>) | null = null;
  onFulfillBlackMarketOrder: ((order: BlackMarketOrderView, unitId?: string) => Promise<BlackMarketMutationResponse>) | null = null;
  /** The caller's settled-but-uncollected trades (both sides). */
  getBlackMarketFulfillments: (() => Promise<BlackMarketFulfillmentView[]>) | null = null;
  /** Collect one settled trade: takes delivery of the zombie it owes (returning the
   *  unit that landed) and the payment the market held for it, and acknowledges it.
   *  `paid` is that payment, in the post's own currency (0 when there was none).
   *  Rejects with `no_room` when a delivery has nowhere to go. */
  onCollectBlackMarketOrder:
    ((orderId: string, awaitingClaim: boolean) =>
      Promise<{ claimed: ClaimedUnit | null; paid: number }>) | null = null;
  /** Completed-trade ledger (both roles) + lifetime aggregates. */
  getBlackMarketHistory: (() => Promise<BlackMarketHistoryResponse>) | null = null;
  /** The speed-grow (Insta-Grow) boost + a live owned-count getter, for the
   *  growing-crop info window. Null when no grow boost exists in the catalog. */
  getSpeedGrowBoost: (() => { name: string; icon: string; count: () => number } | null) | null = null;
  /** Take a stored item back out of the shed to place it (free). */
  onRetrieveItem: ((key: string) => void) | null = null;
  /** Permanently sell one stored placeable without placing it first. */
  onSellStoredItem: ((key: string) => Promise<boolean> | boolean) | null = null;

  // ---- Received rewards (raid loot / quest items) hooks (set by main) ----
  /** Resolve the current Received bucket into displayable reward cards. */
  getReceived: (() => ReceivedView[]) | null = null;
  /** Claim a boost/currency reward at `index` (adds it to inventory/currency). */
  onClaimReceived: ((index: number) => void) | null = null;
  /** Place a decoration reward at `index` on the farm (enters placement mode). */
  onPlaceReceived: ((index: number) => void) | null = null;
  /** Put a decoration reward at `index` straight into the shed, without placing it
   *  on the farm first. Returns false when the shed has no room for it. */
  onStoreReceived: ((index: number) => Promise<boolean> | boolean) | null = null;
  /** Permanently sell a sellable decoration directly from Received. */
  onSellReceived: ((index: number) => Promise<boolean> | boolean) | null = null;

  // ---- Zombie Pot (combiner) hooks (set by main) ----
  /** Current combine status for the combiner panel. */
  getPotStatus:
    | (() => {
        busy: boolean;
        ready: boolean;
        remainingMs: number;
        totalMs: number;
        monolith: boolean;
        canCollect: boolean;
        /** Is there a placed Mausoleum with a free slot to collect the child into? */
        canStore: boolean;
        pending: {
          keyA: string; keyB: string; maskA: number; maskB: number;
          colorA?: [number, number, number]; colorB?: [number, number, number];
        } | null;
        /** The finished zombie, set only once the combine is ready to collect. */
        result: {
          key: string; name: string; mutation: number;
          color?: [number, number, number];
        } | null;
      })
    | null = null;
  /** Start combining two owned zombies by id. */
  onCombine: ((idA: string, idB: string) => boolean | Promise<boolean>) | null = null;
  /** Reward-only actors cannot be consumed or cloned; specials only fit slot 1. */
  canCombineZombie: ((key: string, slot?: "A" | "B") => boolean) | null = null;
  /** Collect a finished combine; returns the new zombie's name (or null).
   *  `stored` sends the child straight to the Mausoleum instead of the farm. */
  onCollectCombine: ((stored?: boolean) => string | null | Promise<string | null>) | null = null;
  /** Spend one Insta-Grow on the open pot's running combine. The tool has always been
   *  able to do this by tapping the pot; this is the same action offered from the panel
   *  the player is already looking at. Returns false when nothing was spent. */
  onPotInstaGrow: (() => boolean) | null = null;
  /** Tears down the open combiner's countdown ticker. Held on the instance because
   *  openCombiner can replace a panel it did not build, and dropping that panel's
   *  DOM does not stop the interval its closure owns. */
  private combinerStop: (() => void) | null = null;
  /** Same contract as combinerStop, for the raid-select panel's cooldown ticker. */
  private raidSelectStop: (() => void) | null = null;

  // ---- raid hooks (set by main) ----
  /** All invasions as cards (unlock/lock state resolved against player level). */
  getRaidCards: (() => RaidCardView[]) | null = null;
  /** Eligible army + default selection for the Army screen. */
  getRaidParty: (() => RaidPartyView) | null = null;
  /** Live cooldown (ms left, 0 = ready) + Invasion Voucher and Brain Ticket counts. */
  getRaidStatus: (() => {
    cooldownMs: number;
    voucherCount: number;
    brainTicketCount: number;
  }) | null = null;
  /** Battle-consumable stock for a raid: owned Concentration + Golden Dice, the most
   *  dice worth spending on this raid (its rare-tier depth), and owned Brain Tickets. */
  getRaidBoosts: ((raidId: number) => {
    concentration: number;
    dice: number;
    maxDice: number;
    brainTickets: number;
  }) | null = null;
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
  /** Current independent farm mode and direct switch to the other farm. */
  playMode: PlayMode = "local";
  onSwitchFarm: ((mode: PlayMode) => void) | null = null;
  /** Download this farm's progress as a file. Set in BOTH modes: the file is a plain
   *  SaveGame either way, and Local Farm's Import is the only thing that reads one. */
  onExportSave: (() => void) | null = null;
  onImportLocal: ((raw: string) => boolean) | null = null;
  onResetLocal: (() => void) | null = null;
  /** Settings' "Check for Updates": poll the service worker on demand. Null where
   *  no service worker can exist (see main.ts / pwa.ts). */
  onCheckForUpdate: (() => Promise<UpdateCheckResult>) | null = null;
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
  /** Permanently delete this farm — the online account and all its rows, or the
   *  local save. Resolves to an error code, or null once the farm is gone (at
   *  which point the implementation reloads, so nothing after it runs). */
  onDeleteAccount: (() => Promise<string | null>) | null = null;
  /** Change the signed-in player's display name. Resolves to a refusal, or null.
   *  Carries the server's `reason` alongside the code because the two refusals need
   *  opposite advice — see `usernameRefusalMessage`, which both name-picking
   *  surfaces render through. */
  onSetUsername: ((name: string) => Promise<UsernameRefusal | null>) | null = null;
  /** Pull the latest friends list from the server into the cache. */
  refreshFriends: (() => Promise<void>) | null = null;
  /** Add a friend by their shared code. Resolves to an error code, or null on success. */
  onAddFriendCode: ((code: string) => Promise<string | null>) | null = null;
  /** Send a brain via the server. Resolves to an error code, or null on success. */
  onGiftBrainOnline: ((friendId: string) => Promise<string | null>) | null = null;
  /** Open a read-only view of this friend's farm (by account id + display name). */
  onVisitFriend: ((friendId: string, name: string) => void) | null = null;
  /** Launch a friend invasion against this friend (online only): opens the PvP army
   *  picker, then the battle. Nobody risks anything; the winner takes boosts. */
  onInvadeFriend: ((friendId: string, name: string) => void) | null = null;
  /** You + your accepted friends with the numbers the friend leaderboard ranks
   *  (Social → Leaderboard, ui/panels/leaderboard.ts). One server round trip. */
  getFriendLeaderboard: (() => Promise<FriendLeaderboardEntry[]>) | null = null;
  // ---- Invasions panel hooks (online only; see ui/panels/invasions.ts) ----
  /** Whether the deployed Worker accepts friend invasions (bootstrap capability).
   *  The Social hub shows the Invasions entry only when this is true, so the whole
   *  feature launches (and parks) with the Worker's PVP_ENABLED var alone. */
  pvpAvailable: (() => boolean) | null = null;
  /** The player's current level, for the invasion level gate's client-side face. */
  getPlayerLevel: (() => number) | null = null;
  /** History + stats + claim backlog, in one server round trip. */
  getPvpOverview: (() => Promise<PvpOverviewView | null>) | null = null;
  /** Scout one friend's defense before attacking (score, tier, line-up). */
  onScoutPvpDefense: ((friendId: string) => Promise<PvpScoutView | null>) | null = null;
  /** The player's own defense loadout + how attackers would meet it. */
  getPvpDefense: (() => Promise<PvpDefenseInfoView | null>) | null = null;
  /** Save (or clear, with []) the authored defense order. Error code or null. */
  onSavePvpDefense: ((unitIds: string[]) => Promise<string | null>) | null = null;
  /** Claim every outstanding defense reward. Null = nothing granted. */
  onClaimAllPvpDefense:
    | (() => Promise<{ claimed: number; rewards: PvpRewardView[] } | null>)
    | null = null;
  /** Open the replay viewer for one recorded fight. */
  onWatchPvpReplay: ((sessionId: string) => void) | null = null;
  /** Pull the gift inbox from the server into the cache. */
  refreshInbox: (() => Promise<void>) | null = null;
  /** Cached unclaimed gifts addressed to me. */
  getInbox: (() => { id: string; fromName: string }[]) | null = null;
  /** Claim a gift (credited server-side). Resolves to what it paid out, to null if
   *  it had already been opened (nothing credited, nothing to reveal), or to an
   *  error message to show the player. Contents are rolled when the gift is SENT, so
   *  they are unknown here until the claim comes back. `refreshInbox: false` skips
   *  the post-claim inbox pull so "Open all" costs one refresh, not one per gift. */
  onClaimGift:
    | ((id: string, opts?: { refreshInbox?: boolean }) => Promise<GiftReward | null | string>)
    | null = null;
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
  /** Player-facing lighting mode. Auto follows the device's local clock. */
  getDayNightMode: (() => DayNightMode) | null = null;
  onSetDayNightMode: ((mode: DayNightMode) => void) | null = null;
  /** The farmer's night lantern. Also toggled by tapping him after dark. */
  getFarmerLantern: (() => boolean) | null = null;
  onSetFarmerLantern: ((on: boolean) => void) | null = null;
  /** Whether tapping the farmer toggles that lantern at all. Off leaves the Settings
   *  row as the only switch, so the tap falls through to the ground under him. */
  getFarmerLanternTap: (() => boolean) | null = null;
  onSetFarmerLanternTap: ((on: boolean) => void) | null = null;
  /** Current farm-background (foliage density) choice. */
  getFarmBackground: (() => FarmBackground) | null = null;
  /** Change the farm background — rebuilds the foliage ring live. */
  onSetFarmBackground: ((bg: FarmBackground) => void) | null = null;
  /** How zombies are drawn on this device (body tint source + whether mutations show).
   *  Applies live, everywhere a zombie is visible: farm, raids, cards and menus. */
  getZombieAppearance: (() => ZombieAppearancePrefs) | null = null;
  onSetZombieAppearance: ((prefs: ZombieAppearancePrefs) => void) | null = null;

  /** Hide/show the farm chrome (top bar, tools, menus) so the live battle scene
   *  can take over the screen. Raid panels stay visible. */
  setRaiding(on: boolean) {
    this.el.classList.toggle("raiding", on);
    if (!on) this.setBattleLoading(false);
  }

  /** The screen between "the farm went away" and "the battle is on screen".
   *
   *  Entering a battle hides the farm and every piece of farm chrome, and the battle's
   *  own HUD — bars, timer, Retreat — is drawn INSIDE the scene. So for as long as the
   *  scene is loading there is nothing on screen at all: just the stage's clear colour,
   *  which is the farm's grass green. Reported as an Epic Boss "not loading" and taking
   *  the player to a green screen, and it was reported as a crash rather than as a wait
   *  because a blank screen does not look like loading. It says so now. */
  setBattleLoading(on: boolean, label = "Loading battle…") {
    if (!on) {
      this.battleLoading?.remove();
      this.battleLoading = null;
      return;
    }
    if (!this.battleLoading) {
      this.battleLoading = document.createElement("div");
      this.battleLoading.className = "battle-loading";
      const spinner = document.createElement("div");
      spinner.className = "battle-loading-spinner";
      const text = document.createElement("div");
      text.className = "battle-loading-label";
      text.setAttribute("aria-live", "polite");
      this.battleLoading.append(spinner, text);
      this.el.appendChild(this.battleLoading);
    }
    const text = this.battleLoading.querySelector(".battle-loading-label");
    if (text) text.textContent = label;
  }

  // ---- Tim Buckwheat guided tutorial seams (used by TutorialController) ----
  /** Mount the tutorial's DOM layer into the HUD (above all panels). */
  mountTutorial(el: HTMLElement) {
    this.el.appendChild(el);
  }
  /** Toggle the input-gating `.tutorial` class on #hud (enables the tap blocker). */
  setTutorialGating(on: boolean) {
    this.el.classList.toggle("tutorial", on);
    if (!on) {
      this.setTutorialMenuTarget(null);
      // The tutorial's menu beats expand the chrome, and nothing during the run can
      // collapse it again (the fab is pointer-events-gated). Return mobile to its
      // collapsed baseline so the player is not left with the tool bar out and — on
      // portrait — the invade shortcut the tutorial just taught hidden beneath it.
      if (isMobile()) this.collapse();
    }
  }
  /** Select the sole menu control allowed by the current tutorial beat. Invade
   *  uses the bottom-left shortcut — the portrait chrome-expanded hide rule is
   *  scoped to `:not(.tutorial)` so that beat's one allowed control stays visible. */
  setTutorialMenuTarget(label: string | null) {
    this.el.querySelectorAll(".tut-highlight").forEach((el) => el.classList.remove("tut-highlight"));
    this.tutorialMenuTarget = label;
    this.tutorialTarget(label)?.classList.add("tut-highlight");
  }
  tutorialTarget(label: string | null): HTMLElement | null {
    if (!label) return null;
    if (label === "Invade") return this.el.querySelector<HTMLElement>(".invade-shortcut");
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
    this.visitExit = on ? (onExit ?? null) : null;
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

  // `initialTab` is a deliberate destination (Storage's "Buy", an Epic Boss card, the
  // tutorial) and always wins; opening the Market with no argument returns to
  // whichever shelf it was last left on.
  openMarket(initialTab?: string) {
    this.closeMarket();
    const tutorialBoostMarket = this.el.classList.contains("tutorial") &&
      this.tutorialMenuTarget === "Market";
    if (tutorialBoostMarket) initialTab = "Boosts";
    const bg = document.createElement("div");
    bg.className = "mkt-bg" + (tutorialBoostMarket ? " tut-market" : "");
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
    if (tutorialBoostMarket) close.style.display = "none";

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
    const searchToggle = document.createElement("button");
    searchToggle.className = "mkt-search-toggle";
    searchToggle.type = "button";
    searchToggle.title = "Search the market";
    searchToggle.setAttribute("aria-label", "Search the market");
    searchToggle.setAttribute("aria-expanded", "false");
    searchToggle.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path></svg>';
    searchRow.append(searchInput, searchToggle);
    title.appendChild(searchRow);

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
    // Farmer grows a third sub-tab only once the player owns a head that DOES
    // something: with a wardrobe of pure cosmetics there is no bonus to assign, so
    // the choice never appears. Computed per render, so buying the first one right
    // here reveals it without reopening the Market.
    const subsFor = (name: string): string[] =>
      name === "Farmer" && this.state.hasBonusHead()
        ? [...SUBTABS.Farmer, "Bonus"]
        : SUBTABS[name];
    let tab = initialTab && SUBTABS[initialTab]
      ? initialTab
      : recallOneOf("market.tab", Object.keys(SUBTABS), "Crops");
    const firstSub = subsFor(tab);
    let sub = firstSub.length ? recallOneOf(`market.sub.${tab}`, firstSub, firstSub[0]) : "";

    // One key per (tab, sub-tab, search) view: the page the player was on and how far
    // that page was scrolled are remembered per shelf, so page 15 of Decors is still
    // page 15 of Decors after a trip through Boosts. The tutorial's single-card
    // Market is a scripted view, never a place to come back to, so it records nothing.
    const viewKey = () => `${tab}|${sub}|${search.trim().toLowerCase()}`;
    const pageKey = () => `market.page.${viewKey()}`;
    const scrollKey = () => `market.scroll.${viewKey()}|${page}`;
    const recordView = tutorialBoostMarket ? () => {} : () => {
      remember("market.tab", tab);
      if (sub) remember(`market.sub.${tab}`, sub);
      remember(pageKey(), page);
    };
    if (!tutorialBoostMarket) page = recallNumber(pageKey(), 0);

    const entriesFor = (): MktEntry[] => {
      if (tab === "Crops" && sub === "Plants")
        return this.plantCards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, sell: c.sell,
          xp: this.cropXp(c.cfg), xpHint: "Experience each time you harvest it",
          timeLabel: c.timeLabel,
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Crops" && sub === "Zombies")
        return this.zombieCards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, brains: c.brains,
          timeLabel: c.timeLabel,
          graveNeeded: c.cfg.unlockGrave,
          description: c.description,
          inspect: () => openCatalogZombieCard(this, c),
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Items") {
        let cards = this.objectCards.filter((c) => c.category === ITEM_CAT[sub]);
        // Seasonal decor is sold only while its theme is on the allow-list. The
        // server enforces the same rule on the buy, so a hidden card cannot be
        // bought by other means either. Owning one is never affected.
        cards = cards.filter((c) => decorAvailable(c.def));
        if (sub === "Decors")
          cards = [...cards].sort((a, b) => compareItemMarketOrder(a.def, b.def));
        // Limited functional items leave the Market once the player owns the
        // allowed number. The callback counts both placed and shed-stored copies.
        cards = cards.filter((c) => placeablePurchaseLimit(c.def) === undefined ||
          !this.objectLimitReached?.(c.def));
        // Storage sheds are a single upgradeable object: show only the NEXT tier
        // above the placed shed (all other sheds hidden). Non-shed functional
        // items are unaffected.
        if (sub === "Functional") {
          const cur = this.getShedSlots ? this.getShedSlots() : 0;
          const sheds = cards.filter((c) => c.def.storageSlots);
          const others = cards.filter((c) => !c.def.storageSlots && !c.def.zombieStorage);
          const next = sheds
            .filter((c) => (c.def.storageSlots ?? 0) > cur)
            .sort((a, b) => (a.def.storageSlots ?? 0) - (b.def.storageSlots ?? 0))[0];
          // The Mausoleum upgrades the same way: with one placed, offer only the next
          // tier above its capacity; with none placed, only the base building (never
          // an upgrade tier, which has nothing to upgrade).
          const capacity = this.getMausoleumCap ? this.getMausoleumCap() : 0;
          const base = Math.min(...this.objectCards
            .filter((c) => c.def.zombieStorage)
            .map((c) => c.def.zombieSlots ?? 0));
          const nextTomb = cards
            .filter((c) => c.def.zombieStorage && (c.def.zombieSlots ?? 0) > capacity &&
              (capacity > 0 || c.def.zombieSlots === base))
            .sort((a, b) => (a.def.zombieSlots ?? 0) - (b.def.zombieSlots ?? 0))[0];
          cards = [...(next ? [next] : []), ...(nextTomb ? [nextTomb] : []), ...others];
        }
        return cards.map((c) => {
          // The Zombie Pot flips to a flat 3 brains once the player has owned one
          // (see GameState.zombiePotBought); the market price must mirror the charge.
          const potPriced = !!c.def.zombiePot && this.state.zombiePotBought;
          return {
            name: c.name, portrait: c.portrait,
            cost: potPriced ? 3 : c.cost, level: c.level,
            brains: potPriced ? true : c.brainsNeeded,
            sell: c.category === "tree" ? c.def.harvestValue : undefined,
            // Buying an item pays XP, and until now the only way to find out how much
            // was to buy one. Deliberately the same call the PURCHASE makes (main.ts
            // tryPlaceObject), against the price actually shown — so a repeat Zombie
            // Pot advertises what its 3-brain charge really pays, not the first one's.
            xp: buyXp(
              potPriced ? 3 : c.cost,
              c.def.xp,
              potPriced ? true : !!c.brainsNeeded,
              c.def.category,
            ) || undefined,
            xpHint: "Experience for buying it",
            timeLabel: c.category === "tree" && c.def.growMs
              ? fmtCooldown(c.def.growMs)
              : undefined,
            description: functionalDescription(c.def), credit: c.def.credit,
            tint: c.def.color,
            theme: themeLabel(themeOf(c.def)),
            onPick: async () => {
              // A shed or Mausoleum with one already placed UPGRADES IN PLACE the
              // moment the card is tapped (main.ts onBuy) — no placement step to
              // back out of — so it confirms like the other commit-on-tap
              // purchases. Every other item only arms placement here; money moves
              // when the object is actually set down, which is its own commitment.
              // The Mausoleum branch mirrors main.ts's own condition: a tier at or
              // below the placed one is a deliberate no-op there, and a confirm the
              // purchase never honours is worse than the silent nothing it replaced.
              const mausoleumCap = this.getMausoleumCap?.() ?? 0;
              const upgradesInPlace =
                (!!c.def.storageSlots && (this.getShedSlots?.() ?? 0) > 0) ||
                (!!c.def.zombieStorage && mausoleumCap > 0 &&
                  (c.def.zombieSlots ?? 0) > mausoleumCap);
              if (upgradesInPlace &&
                  !await this.confirmPurchase(c.name, c.cost, !!c.brainsNeeded)) return;
              if (this.onBuy) this.onBuy(c.def);
              bg.remove();
            },
          };
        });
      }
      if (tab === "Boosts") {
        // Buying stays in the panel (buy several). The card advertises the PACK SIZE
        // — how many uses the listed price buys — not how many you already own; the
        // owned count lives in Storage's Boosts tab, and appending it to the name
        // only put it under the magnifier button.
        return this.boosts.filter((b) => !tutorialBoostMarket || b.key === "insta_grow").map((b) => {
          // Gift vouchers are "1 per farm": lock once you own that zombie or hold
          // the voucher (main supplies the predicate; it spans both Cupid vouchers).
          const ownedLimit = b.effect === "gift" && !!this.giftLimitReached?.(b.key);
          return {
            name: b.name,
            qty: b.perPurchase,
            portrait: `${BASE}assets/boosts/${b.icon}`, cost: b.cost, level: b.level, brains: b.brainsNeeded,
            description: [b.info, b.flavorText].filter(Boolean).join(" ") || undefined,
            ownedLimit,
            onPick: async () => {
              // Gift vouchers are 1-per-farm, so they keep the plain yes/no confirm;
              // everything else gets the quantity dialog.
              const qty = b.effect === "gift"
                ? (await this.confirmPurchase(b.name, b.cost, b.brainsNeeded) ? 1 : 0)
                : await this.confirmBoostQuantity(b);
              if (!qty) return;
              const bought = this.onBuyBoost ? this.onBuyBoost(b, qty) : 0;
              if (bought) { refreshCur(); renderGrid(); }
              // Funds moved while the dialog was up and the run came up short — say
              // so, since the player asked for a specific number.
              if (bought < qty) {
                this.showToast(`Bought ${bought} of ${qty} — not enough ${b.brainsNeeded ? "brains" : "gold"}.`);
              }
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
            // A head with a bonus can be WORN and USED separately, so its blurb says
            // where the bonus comes from rather than implying wearing it is required.
            description: head.description
              ? `${head.description} (assign it under Bonus)`
              : undefined,
            // Unowned heads advertise the XP the purchase itself pays out, the same
            // way a crop card advertises its harvest XP.
            xp: owned ? undefined : farmerHeadXp(head) || undefined,
            xpHint: "Experience for buying it",
            owned,
            equipped: this.state.farmerHeadId === head.id,
            onPick: async () => {
              if (owned) this.onEquipFarmerHead?.(head);
              else {
                if (!await this.confirmPurchase(head.name, head.cost ?? 0, head.brains)) return;
                if (!this.onBuyFarmerHead || !this.onBuyFarmerHead(head)) return;
                // A first bonus-carrying head brings the Bonus sub-tab into being.
                renderSubs();
              }
              refreshCur();
              renderGrid();
            },
          };
        });
      }
      if (tab === "Farmer" && sub === "Bonus") {
        // The FUNCTION slot: which owned head's bonus is live, independent of the
        // one being worn. Only heads that carry a bonus are listed — a cosmetic
        // here would just be a differently-spelled "no bonus".
        const worn = this.farmer.heads.find((head) => head.id === this.state.farmerHeadId);
        const follow: MktEntry = {
          name: "Worn Head",
          portrait: `${BASE}assets/player/${worn?.part ?? "malehead1.png"}`,
          cost: 0,
          level: 1,
          owned: true,
          description: farmerHeadHasEffect(this.state.farmerHeadId)
            ? `Use whichever head you are wearing. Right now: ${worn?.description ?? "no bonus"}.`
            : "Use whichever head you are wearing. The one you have on has no bonus.",
          equipped: this.state.farmerBonusHeadId === null,
          onPick: () => { this.onEquipFarmerBonusHead?.(null); renderGrid(); },
        };
        const pinned = this.farmer.heads
          .filter((head) => farmerHeadHasEffect(head.id) && this.state.ownedFarmerHeads.includes(head.id))
          .map((head): MktEntry => ({
            name: head.name,
            portrait: `${BASE}assets/player/${head.part}`,
            cost: 0,
            level: 1,
            owned: true,
            description: head.description,
            equipped: this.state.farmerBonusHeadId === head.id,
            onPick: () => { this.onEquipFarmerBonusHead?.(head.id); renderGrid(); },
          }));
        return [follow, ...pinned];
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
            // What buying it pays out, on the card rather than after the fact. An
            // owned pet has nothing left to earn, so it shows none (same rule the
            // Farmer heads use).
            xp: owned ? undefined : pet.xp || undefined,
            xpHint: "Experience for buying it",
            owned,
            equipped: this.state.activePet === pet.key,
            onPick: async () => {
              if (owned) this.onEquipPet?.(pet);
              else {
                if (!await this.confirmPurchase(pet.name, pet.cost, pet.brains)) return;
                if (!this.onBuyPet || !this.onBuyPet(pet)) return;
              }
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
      return marketPageSize({
        mobile: isMobile(), columns: cols, rowHeight: rowH, gap, availableHeight: avail,
      });
    };

    const renderGrid = () => {
      grid.innerHTML = "";
      // Farm Size lays out as 2 columns so each row is one tier (gold | brains);
      // Ground uses the normal card grid.
      grid.classList.toggle("mkt-grid--upgrade", tab === "Upgrade" && sub === "Farm Size");
      grid.classList.toggle("mkt-grid--epic", tab === "Epic Boss");
      // Search + pager only ride the card-list tabs.
      const canSearch = searchable() && !tutorialBoostMarket;
      searchRow.style.display = canSearch ? "flex" : "none";
      if (tab === "Upgrade") {
        pager.style.display = "none";
        if (sub === "Ground") this.renderGroundGrid(grid, refreshCur, renderGrid);
        else this.renderUpgradeGrid(grid, refreshCur, renderGrid);
        recordView();
        keepScroll(grid, scrollKey());
        return;
      }
      if (tab === "Epic Boss") {
        pager.style.display = "none";
        this.renderEpicBossGrid(grid, refreshCur, renderGrid);
        recordView();
        keepScroll(grid, scrollKey());
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
      // Recorded after the clamp above, so a remembered page that no longer exists
      // (a narrower window, a shorter catalog) is corrected rather than kept.
      recordView();
      keepScroll(grid, scrollKey());
    };

    prevBtn.onclick = () => { if (page > 0) { page--; this.audio.play("menuClick"); renderGrid(); } };
    nextBtn.onclick = () => { page++; this.audio.play("menuClick"); renderGrid(); };
    // Desktop wheel navigation mirrors the pager arrows. Trackpads can emit many
    // tiny events, so require a deliberate accumulated gesture before changing one
    // page and reset the gesture immediately afterward.
    let wheelDelta = 0;
    mkt.addEventListener("wheel", (event) => {
      if (isMobile() || pager.style.display === "none") return;
      const target = event.target as HTMLElement;
      if (target.closest("input,select,textarea,.bm-list,.bm-mutation-choices")) return;
      wheelDelta += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(wheelDelta) < 45) return;
      event.preventDefault();
      if (wheelDelta > 0 && !nextBtn.disabled) nextBtn.click();
      else if (wheelDelta < 0 && !prevBtn.disabled) prevBtn.click();
      wheelDelta = 0;
    }, { passive: false });
    // Live-filter as the player types; every keystroke returns to the first page.
    const collapseSearch = () => {
      searchRow.classList.remove("expanded");
      mkt.classList.remove("search-expanded");
      searchToggle.setAttribute("aria-expanded", "false");
    };
    searchToggle.onclick = () => {
      searchRow.classList.add("expanded");
      mkt.classList.add("search-expanded");
      searchToggle.setAttribute("aria-expanded", "true");
      searchInput.focus();
    };
    searchInput.onblur = () => collapseSearch();
    searchInput.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      if (searchInput.value) {
        searchInput.value = "";
        search = "";
        // Back to the unfiltered shelf — and to the page it was left on.
        page = recallNumber(pageKey(), 0);
        searchRow.classList.remove("has-query");
        renderGrid();
      } else {
        collapseSearch();
        searchToggle.focus();
      }
    };
    searchInput.oninput = () => {
      search = searchInput.value;
      page = 0;
      searchRow.classList.toggle("has-query", !!search);
      renderGrid();
    };

    const renderSubs = () => {
      subsEl.innerHTML = "";
      const list = subsFor(tab);
      subsEl.style.display = list.length ? "flex" : "none";
      for (const s of list) {
        const b = document.createElement("button");
        b.className = "mkt-subtab" + (s === sub ? " sel" : "");
        b.textContent = s;
        b.onclick = () => {
          this.audio.play("menuClick");
          sub = s;
          page = recallNumber(pageKey(), 0);
          renderSubs();
          renderGrid();
        };
        subsEl.appendChild(b);
      }
    };

    let selectedTabButton: HTMLButtonElement | null = null;
    for (const name of ["Crops", "Items", "Upgrade", "Boosts", "Farmer", "Pets", "Epic Boss"]) {
      const b = document.createElement("button");
      b.className = "mkt-tab" + (name === tab ? " sel" : "");
      if (name === tab) selectedTabButton = b;
      b.textContent = name;
      b.onclick = () => {
        this.audio.play("menuClick");
        tab = name;
        // Each category reopens on the sub-tab and page it was last browsing.
        const subs = subsFor(name);
        sub = subs.length ? recallOneOf(`market.sub.${name}`, subs, subs[0]) : "";
        // A new category starts a fresh search.
        search = "";
        searchInput.value = "";
        page = recallNumber(pageKey(), 0);
        searchRow.classList.remove("has-query");
        tabsEl.querySelectorAll(".mkt-tab").forEach((e) => e.classList.remove("sel"));
        b.classList.add("sel");
        renderSubs();
        renderGrid();
      };
      tabsEl.appendChild(b);
    }

    mkt.append(title, close, cur, tabsEl, subsEl, grid, pager);
    if (tutorialBoostMarket) {
      tabsEl.style.display = "none";
      subsEl.style.display = "none";
    }
    bg.appendChild(mkt);
    if (!tutorialBoostMarket) bindBackdropDismiss(bg, () => bg.remove());
    this.el.appendChild(bg);
    renderSubs();
    renderGrid();
    // An initially selected category can be beyond the edge of the compact,
    // horizontally scrollable phone tab rail (for example, Epic Boss).
    requestAnimationFrame(() => selectedTabButton?.scrollIntoView({
      behavior: "instant", block: "nearest", inline: "center",
    }));
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
          `<p class="${view.levelLocked ? "epic-wait" : ""}">Available at player level ${view.unlockLevel}.</p>` +
          (view.reconstructed ? `<p class="epic-wait">Recovered static battle art.</p>` : "") +
          (view.completed ? "<p>Previous run completed!</p>" : view.expired ? "<p>Previous run expired.</p>" : "")) +
      // Every boss has one crop it cannot leave alone (epicBoss/favoriteCrops.ts). Shown
      // on the active card too — during the event that crop is where the extra Boss
      // Tokens come from, which is exactly when the player wants to be told.
      (view.favoriteCrop
        ? `<p class="epic-market-favorite">Favourite crop: <b>${view.favoriteCrop}</b>` +
          (view.active
            ? " — harvest it during the event for more Boss Tokens.</p>"
            : " — harvesting it may lure this boss to the farm.</p>")
        : "") +
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
        view.levelLocked ? `Requires Level ${view.unlockLevel}` :
        `Start Event · ${view.costBrains} <img src="${UI("topbar_brain_icon.png")}" alt="brains">`;
      action.disabled = view.blocked || view.levelLocked || this.state.brains < view.costBrains;
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
    const party = this.getRaidParty?.();
    const { panel, close } = openModal({
      host: this.el, bgClass: "army-bg", replaceSelector: ".army-bg", backdropClose: false,
    });
    if (!party?.eligible.length) { panel.insertAdjacentHTML("beforeend", `<h2>Choose your army</h2><p>You have no deployed zombies.</p>`); return; }
    // Slotted attack order, same as the invasion picker: un-picking leaves the slot
    // empty and the next tap fills the lowest one (see raid/attackOrderSlots).
    let order: OrderSlots = [];
    const preferred = this.getEpicBossView?.().find((view) => view.active)?.run?.attackOrder ?? [];
    const eligible = orderPartyRoster(party.eligible, preferred);
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
      const n = selectedCount(order);
      head.innerHTML = `<h2>Send your army — ${bossName}</h2><span class="army-count">${n}/${party.cap} · min 1</span>`;
      start.textContent = n ? `Fight with ${n}` : "Choose a zombie";
      start.disabled = !n || !canPay;
      cards.querySelectorAll<HTMLElement>(".army-card").forEach((el) => { const at = order.indexOf(el.dataset.id!); el.classList.toggle("sel", at >= 0); const tick = el.querySelector<HTMLElement>(".tick"); if (tick) tick.textContent = at >= 0 ? String(at + 1) : ""; });
    };
    for (const z of eligible) {
      const card = document.createElement("div"); card.className = "army-card"; card.dataset.id = z.id;
      const tick = document.createElement("span"); tick.className = "tick";
      const portrait = document.createElement("div"); portrait.className = "army-por";
      if (z.portrait) portrait.style.backgroundImage = `url(${z.portrait})`;
      if (this.zombieMutationPortraitOf) {
        onFirstVisible(portrait, () => {
          void this.zombieMutationPortraitOf?.(
            z.key, visibleMutations(z.id, z.mutation), z.color, () => portrait.isConnected,
          )
            .then((image) => { if (portrait.isConnected) portrait.style.backgroundImage = `url(${image})`; })
            .catch(() => { /* retain the static species portrait */ });
        });
      }
      const name = document.createElement("div"); name.className = "army-nm"; name.textContent = z.name;
      const type = document.createElement("div"); type.className = "army-ty"; type.textContent = z.typeName;
      card.append(tick, portrait, name, type);
      card.onclick = () => { order = toggleSlot(order, z.id, party.cap); refresh(); };
      cards.appendChild(card);
    }
    const pick = document.createElement("button"); pick.className = "raid-quick"; pick.textContent = "Pick for me";
    pay.onchange = () => { payment = pay.value as EpicBossPayment; refresh(); };
    pick.onclick = () => {
      order = fillSlots(order, preferred, eligible.map((z) => z.id), party.cap);
      refresh();
    };
    start.onclick = async () => {
      // Any gaps left while picking are closed here: the fight gets a continuous order.
      const attackOrder = compactOrder(order);
      if (!attackOrder.length || !this.onLaunchEpicBoss) return;
      start.disabled = true;
      if (await this.onLaunchEpicBoss(attackOrder, payment)) {
        close();
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
    // Seasonal decor is only on the shelf while its theme is active — say which,
    // so a card the player will not find again next week reads as limited.
    if (en.theme) {
      const badge = document.createElement("div");
      badge.className = "mkt-theme";
      badge.textContent = en.theme;
      body.appendChild(badge);
    }
    const img = document.createElement("img");
    img.className = "mkt-portrait";
    img.loading = "lazy"; // only fetch portraits as cards scroll into view
    img.decoding = "async";
    img.src = en.portrait;
    tintMarketPortrait(img, en.tint);
    body.appendChild(img);
    if (en.sell !== undefined) {
      const s = document.createElement("div");
      s.className = "mkt-sell";
      s.innerHTML = `<img src="${UI("topbar_money_icon.png")}">+${en.sell}`;
      body.appendChild(s);
    }
    // XP, so a card's payoff can be judged on level progress and not just gold: a
    // crop's per-harvest award, or what BUYING the item pays out. Zombie crops
    // deliberately don't set it (see the Crops/Zombies entries).
    if (en.xp) {
      const x = document.createElement("div");
      x.className = "mkt-xp";
      x.innerHTML = `<img src="${UI("topbar_exp_icon.png")}">+${en.xp}`;
      x.title = en.xpHint ?? "Experience";
      body.appendChild(x);
    }
    // Pack size: how many uses the price below buys (Insta-Grow sells 20 at a time).
    if (en.qty !== undefined) {
      const q = document.createElement("div");
      q.className = "mkt-qty";
      q.textContent = `x${en.qty}`;
      q.title = `${en.qty} per purchase`;
      body.appendChild(q);
    }
    if (en.timeLabel) {
      const t = document.createElement("div");
      t.className = "mkt-time";
      t.innerHTML = `<img src="${UI("icon_time.png")}">${en.timeLabel}`;
      body.appendChild(t);
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
    // Magnifier: a small "what is this?" button. Zombies open their inspect card;
    // everything else pops the description parchment. Present even on locked cards so
    // players can study an item — or a zombie's stats — before they unlock it.
    if (en.inspect) {
      card.appendChild(magnifierButton(
        `See ${en.name}'s card`, "See this zombie's card", en.inspect));
    } else if (en.description || en.credit) {
      // A credited item may have no description at all (decor never does), so the
      // label asks about the item rather than about what it does.
      card.appendChild(en.description
        ? magnifierButton(`What does ${en.name} do?`, "What does this do?",
          () => this.showItemInfo(en))
        : magnifierButton(`About ${en.name}`, "About this item",
          () => this.showItemInfo(en)));
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
    box.append(close, img, name);
    // Decor carries a credit but no blurb; an empty .info-desc would still spend a
    // row of the box's flex gap, so it is only added when there is something in it.
    if (en.description) {
      const desc = document.createElement("div");
      desc.className = "info-desc";
      desc.textContent = en.description;
      box.appendChild(desc);
    }
    // Artist credit for contributed art. Its own line under the blurb rather than
    // appended to it: it is about who drew the thing, not about the thing.
    if (en.credit) {
      const credit = document.createElement("div");
      credit.className = "info-credit";
      credit.textContent = en.credit;
      box.appendChild(credit);
    }
    bg.appendChild(box);
    bindBackdropDismiss(bg, () => bg.remove());
    this.el.appendChild(bg);
    this.audio.play("menuClick");
  }

  // The Market Upgrade tab: for each Farm Size tier, a gold card AND a brains card
  // (six cards for three tiers). Tiers are bought in order (30 -> 40 -> 50 -> 60);
  // buying either currency's card grows the farm, which makes both of that tier's
  // cards read as owned. The cards carry the sizes, so there is no current-size
  // banner — only the maxed-out farm still needs a line of its own.
  private renderUpgradeGrid(grid: HTMLElement, refreshCur: () => void, rerender: () => void) {
    const current = this.getMapSize ? this.getMapSize() : 30;
    const maxed = this.farmUpgrades.every((u) => u.size <= current);
    if (maxed) {
      const status = document.createElement("div");
      status.className = "mkt-upgrade-status";
      status.textContent = "Your farm is as big as it gets!";
      grid.appendChild(status);
    }
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
        if (!await this.confirmPurchase(`${u.name} (${u.size}×${u.size})`, price, currency === "brains")) return;
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
        if (!await this.confirmPurchase(c.name, price)) return;
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
  // Storage panel (Items/Pets/Boosts/Received) lives in ui/panels/storage.ts.
  openStorage(initialTab?: string, managePen = false) {
    openStoragePanel(this, initialTab, managePen);
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

    // The tutorial's constrained menu is a scripted view, so it neither reads nor
    // writes the remembered screen/category.
    const CATS = ["normal", "special", "mutant"] as const;
    let zcat: "normal" | "special" | "mutant" =
      onlyKey ? "normal" : recallOneOf("plantmenu.cat", CATS, "normal");

    const pick = (card: MenuCard) => {
      onPick(card.cfg);
      bg.remove();
    };
    const renderList = (cards: MenuCard[], view: string) => {
      list.innerHTML = "";
      // In tutorial mode, lock every card except the target so only it is tappable.
      for (const c of cards)
        list.appendChild(this.buildCard(c, pick, !!onlyKey && c.cfg.key !== onlyKey));
      if (onlyKey) list.scrollTop = 0;
      else keepScroll(list, `plantmenu.scroll.${view}`);
    };
    const showZombieTabs = (on: boolean) => (subtabs.style.display = on ? "flex" : "none");

    const showPlants = () => {
      showZombieTabs(false);
      if (!onlyKey) remember("plantmenu.screen", "Plants");
      renderList(this.plantCards, "Plants");
    };
    const showZombies = () => {
      showZombieTabs(true);
      subtabs.querySelectorAll(".pm-subtab").forEach((e) =>
        e.classList.toggle("sel", (e as HTMLElement).dataset.cat === zcat)
      );
      if (!onlyKey) {
        remember("plantmenu.screen", "Zombies");
        remember("plantmenu.cat", zcat);
      }
      renderList(this.zombieCards.filter((z) => z.category === zcat), `Zombies.${zcat}`);
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
    if (!onlyKey) bindBackdropDismiss(bg, () => bg.remove());
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
    // Open on whichever screen was last used (Plants the first time).
    const screen = recallOneOf("plantmenu.screen", ["Plants", "Zombies"] as const, "Plants");
    screenBtns[screen].classList.add("sel");
    if (screen === "Zombies") showZombies();
    else showPlants();
  }

  /** XP one harvest of this crop pays out — the same number JobSystem awards, so a
   *  placed Plowing Monolith (which moves the plow XP onto the harvest) is included. */
  private cropXp(cfg: CropConfig): number {
    return harvestXp(cfg.xp ?? 0, !!this.hasPlowFree?.());
  }

  private buildCard(c: MenuCard, onPick: (c: MenuCard) => void, forceLock = false): HTMLElement {
    const levelLocked = this.state.level < c.level;
    // Colored-grave gate for zombie crops (Blue/Red/Silver need the grave placed).
    const graveLock = !levelLocked && !!c.cfg.unlockGrave && !!this.hasGrave &&
      !this.hasGrave(c.cfg.unlockGrave);
    const locked = levelLocked || graveLock || forceLock;
    const card = document.createElement("div");
    card.className = `${locked ? "pm-card locked" : "pm-card"}${c.cfg.isZombie ? " zombie" : ""}`;

    const name = document.createElement("div");
    name.className = "pm-name";
    name.textContent = c.name;
    // Zombies carry the same magnifier as their Market cards, so the picker opened
    // from a plot can show what a gravestone grows into before it is planted. It sits
    // beside the name here: this card's corners already hold the time/cost readouts.
    if (c.cfg.isZombie && c.zombie) {
      const info = magnifierButton(`See ${c.name}'s card`, "See this zombie's card",
        () => openCatalogZombieCard(this, c));
      info.classList.add("pm-info");
      name.appendChild(info);
    }

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
    // Plants only: zombie crops earn XP too, but growing one is about the unit you
    // dig up, so quoting a yield on those cards points at the wrong thing.
    const cardXp = c.cfg.isZombie ? 0 : this.cropXp(c.cfg);
    if (cardXp) {
      const x = document.createElement("span");
      x.className = "pm-xp";
      x.innerHTML = `<img src="${UI("topbar_exp_icon.png")}">+${cardXp}`;
      right.appendChild(x);
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

  // Settings + Developer menus live in ui/panels/settings.ts; these forward the
  // Hud instance. buildAccountBlock/buildDevicesBlock are called by openProfiles.
  private openSettings() { openSettingsPanel(this); }
  private openDevMenu() { openDevMenuPanel(this); }

  // Account menu: who you're signed in as + Sign out — and Sign out lives ONLY
  // here. Profile SWITCHING (multiple independent save slots — Play / New Game /
  // Rename / Delete) is intentionally not exposed for now; that UX needs a rework.
  // The hooks (onSwitchProfile/onCreateProfile/onRenameProfile/onDeleteProfile)
  // and save/profiles.ts are kept intact so it can be re-added here later. The
  // friend code, adding friends, and gifting/visiting all live in the Friends panel.
  // Opened by clicking the top-right nameplate / person icon.
  openProfiles() {
    const { panel, close } = openModal({
      host: this.el, bgClass: "prof-bg", panelClass: "profiles",
      title: this.playMode === "local" ? "Local Farm" : "Account", replaceSelector: ".prof-bg",
    });

    const acctBlock = buildAccountBlock(this);
    if (acctBlock) {
      panel.append(acctBlock);
      const devices = buildDevicesBlock(this);
      if (devices) panel.append(devices);
    } else {
      // Local Farm has no account or social state.
      const note = document.createElement("div");
      note.className = "fr-empty";
      note.textContent = "Local Farm is saved on this device. Online Farm has separate progress.";
      panel.append(note);
    }

    const switchActions = document.createElement("div");
    switchActions.className = "zbtns";
    // The lifetime tally belongs to the farm this menu is about, so it opens from
    // here rather than from Settings (which is device preferences).
    if (this.getStats) {
      const stats = document.createElement("button");
      stats.className = "zbtn locate";
      stats.textContent = "Statistics";
      stats.onclick = () => {
        close();
        openStats(this.el, this.getStats!());
      };
      switchActions.appendChild(stats);
    }
    const switchFarm = document.createElement("button");
    switchFarm.className = "zbtn locate";
    const destination = otherPlayMode(this.playMode);
    switchFarm.textContent = playModeDestinationLabel(this.playMode);
    switchFarm.onclick = () => {
      close();
      this.onSwitchFarm?.(destination);
    };
    switchActions.appendChild(switchFarm);
    panel.appendChild(switchActions);

    // Deletion is last, visually separated, and labelled for the farm it will
    // actually destroy — "Delete Account" over a Local Farm would be a lie, since
    // a Local Farm has no account.
    if (this.onDeleteAccount) {
      const dangerRow = document.createElement("div");
      dangerRow.className = "zbtns acct-danger";
      const del = document.createElement("button");
      del.className = "zbtn sell";
      del.textContent = this.playMode === "local" ? "Delete Local Farm" : "Delete Account";
      del.onclick = () => {
        close();
        this.confirmDeleteAccount();
      };
      dangerRow.appendChild(del);
      panel.appendChild(dangerRow);
    }
  }

  /** The two-step confirmation in front of deletion.
   *
   *  Two steps, not one, because this is the only irreversible action in the game
   *  and a single dialog is one mis-tap from a deleted farm. They are deliberately
   *  NOT the same dialog twice: the first states the consequences, and the second
   *  asks for a different, explicit sentence ("Yes, delete my account") in a button
   *  that is not where the first dialog's confirm button was — so the second tap
   *  cannot land on muscle memory from the first.
   *
   *  Neither step is skippable and there is no "don't ask again". */
  private confirmDeleteAccount(): void {
    const online = this.playMode !== "local";
    const noun = online ? "account" : "local farm";

    const { panel, close } = openModal({
      host: this.el, bgClass: "fr-confirm-bg", panelClass: "confirm-panel",
      title: online ? "Delete your account?" : "Delete this farm?",
      replaceSelector: ".fr-confirm-bg",
    });

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.append(online
      ? "This deletes your account and everything on it — your farm, your zombies, your gold and brains, your quests and invasion progress, your friends and your Almanacs."
      : "This deletes this farm and everything on it — your zombies, your gold and brains, your quests and invasion progress, and your Almanacs.");

    const warn = document.createElement("span");
    warn.className = "confirm-warn";
    warn.textContent = "This cannot be undone. There is no backup and no way to recover it.";
    msg.append(document.createElement("br"), warn);

    const after = document.createElement("span");
    after.className = "confirm-warn";
    after.textContent = online
      ? "Signing in again will start you a brand-new farm from the beginning."
      : "Playing again will start you a brand-new farm from the beginning.";
    msg.append(document.createElement("br"), after);

    // Only worth saying while there is still something to export.
    const escape = document.createElement("span");
    escape.className = "confirm-warn";
    escape.textContent = "If you only want a copy, cancel and use Settings → Export first.";
    msg.append(document.createElement("br"), escape);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => close();
    const next = document.createElement("button");
    next.className = "zbtn sell";
    next.textContent = "Continue";
    // Deliberately NOT markPrimary: Enter should not confirm a step whose only
    // purpose is to make the player stop and read.
    next.onclick = () => {
      close();
      this.confirmDeleteAccountFinal(noun);
    };
    btns.append(cancel, next);
    panel.append(msg, btns);
  }

  /** Step two: the explicit sentence, and the actual call. */
  private confirmDeleteAccountFinal(noun: string): void {
    const { panel, close } = openModal({
      host: this.el, bgClass: "fr-confirm-bg", panelClass: "confirm-panel",
      title: "Are you sure?", replaceSelector: ".fr-confirm-bg",
    });

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.append(`Last chance — deleting your ${noun} is permanent.`);
    panel.appendChild(msg);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Keep my farm";
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = `Yes, delete my ${noun}`;
    // No markPrimary here either — the confirming button must be pressed on
    // purpose, never by an Enter left over from another dialog.

    cancel.onclick = () => close();
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = "Deleting…";
      const error = await this.onDeleteAccount?.().catch(() => "failed");
      if (!error) return; // the farm is gone; the implementation is reloading
      close();
      this.showToast(
        error === "market_unsettled"
          ? "Finish your Black Market trades first, then try again."
          : error === "operation_in_progress"
            ? "Something is still saving. Try again in a moment."
            : "Couldn't delete the farm. Try again in a moment.");
    };
    btns.append(cancel, confirm);
    panel.appendChild(btns);
  }

  /** Confirm a bulk friends-panel action ("Gift all", "Open all") before it runs.
   *  `lines` is the breakdown shown under the question — for gifting that is what it
   *  will cost, so the player never spends gold on a number they didn't see first.
   *  Shares the confirm-panel styling with confirmFriendAction. */
  private confirmBulkAction(opts: {
    title: string;
    lead: string;
    lines: string[];
    confirmLabel: string;
    failToast: string;
    onConfirm: () => void | Promise<void>;
  }) {
    const { panel, close } = openModal({
      host: this.el, bgClass: "fr-confirm-bg", panelClass: "confirm-panel",
      title: opts.title, replaceSelector: ".fr-confirm-bg",
    });

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.append(opts.lead);
    for (const line of opts.lines) {
      const detail = document.createElement("span");
      detail.className = "confirm-warn";
      detail.textContent = line;
      msg.append(document.createElement("br"), detail);
    }

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => close();
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = opts.confirmLabel;
    markPrimary(confirm); // Enter confirms
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      // Close first: the action below is a sequence of network calls, and leaving a
      // dead modal over the panel while they run reads as a hang.
      close();
      try { await opts.onConfirm(); }
      catch { this.showToast(opts.failToast); }
    };
    btns.append(cancel, confirm);
    panel.append(msg, btns);
  }

  /** Confirm a destructive social action before touching local or server state. */
  private confirmFriendAction(
    friend: Friend,
    action: "remove" | "block",
    onConfirm: () => void | Promise<void>
  ) {
    const { panel, close } = openModal({
      host: this.el, bgClass: "fr-confirm-bg", panelClass: "confirm-panel",
      title: action === "block" ? "Block this friend?" : "Remove this friend?",
      replaceSelector: ".fr-confirm-bg",
    });

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
    cancel.onclick = () => close();
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = action === "block" ? "Block" : "Remove";
    markPrimary(confirm); // Enter confirms
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await onConfirm();
        close();
      } catch {
        confirm.disabled = false;
        cancel.disabled = false;
        this.showToast(action === "block" ? "Couldn't block that friend." : "Couldn't remove that friend.");
      }
    };
    btns.append(cancel, confirm);
    panel.append(msg, btns);
  }

  private openSocial() {
    const { panel, close } = openModal({
      host: this.el, bgClass: "social-bg", panelClass: "social-hub",
      title: "Social", replaceSelector: ".social-bg",
    });
    const choices = document.createElement("div");
    choices.className = "social-choices";
    const level = this.getPlayerLevel?.() ?? 0;
    // Both trading surfaces open partway into the game. A locked entry is SHOWN
    // rather than hidden — it is the only place the player learns the feature is
    // coming and what it costs to get there — but it does not open, so the panel
    // behind it never has to explain itself to someone who cannot use it yet.
    const choice = (
      title: string,
      note: string,
      minLevel: number,
      open: () => void,
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.className = "social-choice";
      btn.append(title);
      const sub = document.createElement("span");
      const locked = level < minLevel;
      sub.textContent = locked ? `Unlocks at level ${minLevel}` : note;
      btn.appendChild(sub);
      if (locked) {
        btn.classList.add("locked");
        btn.disabled = true;
        btn.title = `${title} opens at level ${minLevel}.`;
      } else btn.onclick = () => { close(); open(); };
      return btn;
    };
    choices.append(
      choice("Friends", "Connect, gift brains, and visit farms", 0,
        () => this.openFriends()),
      choice("Black Market", "Post zombie sales and requests", BLACK_MARKET_MIN_LEVEL,
        () => this.openBlackMarket()),
    );
    // Friend invasions — shown only when the deployed Worker accepts them, so the
    // feature launches with a single Worker-var flip (PVP_ENABLED) and no client
    // redeploy. PVP_UI_ENABLED stays as the hard client-side kill switch. The level
    // floor is the same PVP_MIN_LEVEL both the panel and the server already enforce.
    if (PVP_UI_ENABLED && (this.pvpAvailable?.() ?? false)) {
      choices.appendChild(choice(
        "Invasions", "Raid friends' farms, arrange your defense", PVP_MIN_LEVEL,
        () => openInvasionsPanel(this),
      ));
    }
    // No level gate: the board is readable from level 1 (it ranks Level itself),
    // and the panel handles the signed-out state with the same sign-in prompt the
    // Friends panel uses.
    choices.appendChild(choice(
      "Leaderboard", "See how you rank among your friends", 0,
      () => openLeaderboardPanel(this),
    ));
    panel.append(choices);
  }

  openBlackMarket(initialKind: BlackMarketOrderKind = "BUY_ZOMBIE", selectedUnitId?: string) {
    this.closeMarket();
    const bg = document.createElement("div");
    bg.className = "mkt-bg bm-bg";
    const panel = document.createElement("div");
    panel.className = "mkt bm";
    const title = document.createElement("div");
    title.className = "mkt-title";
    title.textContent = "Black Market";
    const close = document.createElement("button");
    close.className = "mkt-close";
    close.innerHTML = `<img src="${UI("button_close.png")}">`;
    close.onclick = () => bg.remove();
    const balance = document.createElement("div");
    balance.className = "mkt-cur";
    // What the market is holding: settled sales this player has not collected yet, per
    // currency. Shown beside the matching balance so the money is visibly SOMEWHERE
    // while it waits.
    const held: Record<BlackMarketCurrency, number> = { BRAINS: 0, GOLD: 0 };
    const refreshBalance = () => {
      balance.replaceChildren();
      // Both wallets are always shown: a post can be priced in either, so "can I afford
      // this?" is a question about whichever one the listing in front of them uses.
      for (const currency of ["GOLD", "BRAINS"] as const) {
        const span = document.createElement("span");
        const coin = document.createElement("img");
        coin.src = UI(MARKET_COIN[currency]);
        span.append(coin, (currency === "GOLD" ? this.state.gold : this.state.brains).toLocaleString());
        balance.appendChild(span);
        if (held[currency] <= 0) continue;
        const waiting = document.createElement("span");
        waiting.className = "bm-held";
        waiting.textContent = `+${held[currency].toLocaleString()} held`;
        waiting.title = `${currency === "GOLD" ? "Gold" : "Brains"} your settled sales are holding. Collect them above.`;
        balance.appendChild(waiting);
      }
    };
    refreshBalance();

    const tabs = document.createElement("div");
    tabs.className = "mkt-tabs";
    const requestTab = document.createElement("button");
    const salesTab = document.createElement("button");
    const historyTab = document.createElement("button");
    requestTab.className = salesTab.className = historyTab.className = "mkt-tab";
    requestTab.textContent = "Requests";
    salesTab.textContent = "Zombie Sales";
    historyTab.textContent = "History";
    // Compact screens cannot show the browse list AND the compose form at once —
    // side by side they leave the list about three cards tall. There the form
    // becomes a third tab; on a roomy screen this button is hidden by CSS and the
    // form stays permanently docked beside the list.
    const composeTab = document.createElement("button");
    composeTab.className = "mkt-tab bm-tab-compose";
    composeTab.textContent = "Create Post";
    tabs.append(requestTab, salesTab, historyTab, composeTab);

    const toolbar = document.createElement("div");
    toolbar.className = "bm-toolbar";
    const catalog = [...new Map(this.blackMarketZombieCards.map((card) => [card.cfg.key, card])).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    // Browsing cuts the catalog along its two axes rather than by single type: the
    // colour class (shown as "category") and the body family (shown as "class").
    const categoryFilter = document.createElement("select");
    categoryFilter.setAttribute("aria-label", "Zombie category filter");
    categoryFilter.append(new Option("All categories", ""));
    for (const option of BLACK_MARKET_CLASS_FILTERS) {
      categoryFilter.append(new Option(option.label, option.value));
    }
    const classFilter = document.createElement("select");
    classFilter.setAttribute("aria-label", "Zombie class filter");
    classFilter.append(new Option("All classes", ""));
    for (const option of BLACK_MARKET_GROUP_FILTERS) {
      classFilter.append(new Option(option.label, option.value));
    }
    // Prices in gold and prices in brains are not comparable, so "Lowest price" over a
    // mixed board would be meaningless — this narrows it to one currency.
    const currencyFilter = document.createElement("select");
    currencyFilter.setAttribute("aria-label", "Currency filter");
    currencyFilter.append(new Option("Gold & brains", ""), new Option("Gold only", "GOLD"),
      new Option("Brains only", "BRAINS"));
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "Sort orders");
    sort.append(new Option("Newest", "newest"), new Option("Lowest price", "price_asc"),
      new Option("Highest price", "price_desc"));
    const mineLabel = document.createElement("label");
    const mine = document.createElement("input");
    mine.type = "checkbox";
    mineLabel.append(mine, " My Posts");
    const refresh = document.createElement("button");
    refresh.className = "prof-btn play";
    refresh.textContent = "Refresh";
    toolbar.append(categoryFilter, classFilter, currencyFilter, sort, mineLabel, refresh);

    // Fulfilled posts awaiting collection. The trade already settled server-side
    // (brains/zombie landed when the counterparty accepted); this strip is where
    // the post's creator finally hears about it and dismisses the notice.
    const fulfillStrip = document.createElement("div");
    fulfillStrip.className = "bm-fulfillments";
    fulfillStrip.hidden = true;

    // The trade ledger. Replaces the browse content while the History tab is
    // selected; the toolbar's filters only apply to open orders, so it hides too.
    const historyView = document.createElement("div");
    historyView.className = "bm-history";
    historyView.hidden = true;

    const content = document.createElement("div");
    content.className = "bm-content";
    const list = document.createElement("div");
    list.className = "bm-list";
    const compose = document.createElement("div");
    compose.className = "bm-compose";
    const composeTitle = document.createElement("h3");
    composeTitle.textContent = "Create Post";
    const composeKind = document.createElement("select");
    composeKind.append(new Option("Request a Zombie", "BUY_ZOMBIE"), new Option("Sell a Zombie", "SELL_ZOMBIE"));
    const composeDefaults = blackMarketComposeDefaults(
      initialKind,
      selectedUnitId,
      (this.getRoster?.() ?? []).map((zombie) => zombie.id),
    );
    composeKind.value = composeDefaults.kind;
    const assetLabel = document.createElement("label");
    const assetCaption = document.createElement("span");
    const asset = document.createElement("select");
    assetLabel.append(assetCaption, asset);
    const mutationLabelEl = document.createElement("label");
    mutationLabelEl.append("Mutation requirement");
    const mutationMode = document.createElement("select");
    mutationMode.append(
      new Option("No mutation", "false"),
      new Option("Any mutation", "true"),
      new Option("Specific mutations…", "specific")
    );
    const mutationChoices = document.createElement("div");
    mutationChoices.className = "bm-mutation-choices";
    mutationChoices.hidden = true;
    const mutationChecks = MUTATION_LIST.map((mutation) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      // The bit rides on the checkbox because that is what the order stores; the form
      // itself is built from the catalog, so a new mutation appears here for free.
      input.value = String(mutation.bit);
      label.append(input, mutation.name);
      mutationChoices.appendChild(label);
      return input;
    });
    mutationLabelEl.append(mutationMode, mutationChoices);
    const priceLabel = document.createElement("label");
    const priceCaption = document.createElement("span");
    priceLabel.appendChild(priceCaption);
    const priceRow = document.createElement("div");
    priceRow.className = "bm-price-row";
    const price = document.createElement("input");
    price.type = "number"; price.min = "1"; price.max = String(MARKET_MAX_PRICE); price.step = "1";
    // Gold first, and the default: it is the currency players actually hold in quantity,
    // and the one this ceiling is scaled for. Brains posts stay available for anyone
    // who wants to trade in the scarce currency instead.
    const currencyPicker = document.createElement("select");
    currencyPicker.setAttribute("aria-label", "Price currency");
    currencyPicker.append(new Option("Gold", "GOLD"), new Option("Brains", "BRAINS"));
    priceRow.append(price, currencyPicker);
    priceLabel.appendChild(priceRow);
    const composeCurrency = (): BlackMarketCurrency =>
      currencyPicker.value === "BRAINS" ? "BRAINS" : "GOLD";
    const escrowNote = document.createElement("div");
    escrowNote.className = "bm-meta";
    const submit = document.createElement("button");
    submit.textContent = "Post Request";
    compose.append(composeTitle, composeKind, assetLabel, mutationLabelEl, priceLabel, escrowNote, submit);
    content.append(list, compose);

    let kind = initialKind;
    let composing = false;
    let viewingHistory = false;
    let renderGeneration = 0;
    const cardFor = (key: string) => catalog.find((entry) => entry.cfg.key === key);
    const purchaseLockFor = (key: string) => {
      const card = cardFor(key);
      if (!card) return null;
      return blackMarketPurchaseLock(
        { category: card.category, unlockGrave: card.cfg.unlockGrave },
        this.state.level
      );
    };
    const selectedMutationMask = () => mutationChecks.reduce(
      (mask, input) => input.checked ? mask | Number(input.value) : mask,
      0
    );
    // A request nobody could ever fill is worth blocking before the player escrows
    // brains on it: a headless zombie has no head to wear a head or hair mutation on,
    // and a mutation added after the orders table was built can't be stored at all.
    const syncMutationChoices = (selling: boolean) => {
      const headless = cardFor(asset.value)?.zombie?.group === "Headless";
      for (const input of mutationChecks) {
        const bit = Number(input.value);
        const wearable = selling || bitAllowed(bit, headless);
        const storable = maskHas(REQUESTABLE_MUTATION_MASK, bit);
        const blocked = !wearable || !storable;
        if (blocked) input.checked = false;
        input.disabled = blocked;
        const label = input.parentElement as HTMLLabelElement | null;
        label?.classList.toggle("bm-choice-off", blocked);
        if (!label) continue;
        label.title = wearable
          ? (storable ? "" : "This mutation can't be requested on the Black Market yet.")
          : "A headless zombie can't wear this mutation.";
      }
    };
    const refreshComposeStatus = () => {
      const selling = composeKind.value === "SELL_ZOMBIE";
      const purchaseLock = selling ? null : purchaseLockFor(asset.value);
      syncMutationChoices(selling); // before the mask is read below
      const missingMutation = !selling && mutationMode.value === "specific" &&
        selectedMutationMask() === 0;
      mutationChoices.hidden = selling || mutationMode.value !== "specific";
      priceCaption.textContent = composeCurrency() === "GOLD" ? "Price in gold" : "Price in brains";
      escrowNote.textContent = selling
        ? "This zombie leaves your roster while the post is open."
        : purchaseLock?.label ??
          (missingMutation
            ? "Select at least one specific mutation."
            : mutationMode.value === "specific"
              ? "Same-slot choices are alternatives; choices in different slots are all required."
              : `The full ${composeCurrency() === "GOLD" ? "gold" : "brain"} offer is removed while the request is open.`);
      escrowNote.classList.toggle("bm-lock", !!purchaseLock || missingMutation);
      submit.disabled = !asset.value || !!purchaseLock || missingMutation || !this.socialOnline?.();
    };
    const updateCompose = () => {
      const selling = composeKind.value === "SELL_ZOMBIE";
      asset.replaceChildren();
      assetCaption.textContent = selling ? "Owned zombie" : "Zombie type";
      if (selling) {
        for (const zombie of this.getRoster?.() ?? []) {
          const option = new Option(`${zombie.name} — ${zombie.typeName}${zombie.mutation ? " (Mutated)" : ""}`, zombie.id);
          asset.appendChild(option);
        }
      } else {
        for (const card of catalog) {
          const lock = purchaseLockFor(card.cfg.key);
          const option = new Option(lock ? `${card.name} — ${lock.label}` : card.name, card.cfg.key);
          asset.append(option);
        }
      }
      if (selling && composeDefaults.assetId &&
          [...asset.options].some((option) => option.value === composeDefaults.assetId)) {
        asset.value = composeDefaults.assetId;
      }
      mutationLabelEl.style.display = selling ? "none" : "flex";
      submit.textContent = selling ? "Post Zombie Sale" : "Post Request";
      refreshComposeStatus();
    };

    const setTabs = () => {
      requestTab.classList.toggle("sel", !composing && !viewingHistory && kind === "BUY_ZOMBIE");
      salesTab.classList.toggle("sel", !composing && !viewingHistory && kind === "SELL_ZOMBIE");
      historyTab.classList.toggle("sel", !composing && viewingHistory);
      composeTab.classList.toggle("sel", composing);
      // Only the compact layout acts on this; the wide one shows both halves.
      panel.classList.toggle("bm-composing", composing);
      toolbar.hidden = viewingHistory && !composing;
      content.hidden = viewingHistory && !composing;
      historyView.hidden = !(viewingHistory && !composing);
    };
    const renderFulfillments = async () => {
      if (!this.socialOnline?.() || !this.getBlackMarketFulfillments) return;
      let rows: BlackMarketFulfillmentView[];
      try { rows = await this.getBlackMarketFulfillments(); }
      catch { return; /* best-effort: on any failure the strip just stays hidden */ }
      if (!bg.isConnected) return;
      fulfillStrip.replaceChildren();
      fulfillStrip.hidden = !rows.length;
      for (const currency of ["GOLD", "BRAINS"] as const) {
        held[currency] = rows.reduce((total, row) =>
          total + (row.awaitingPayout && row.currency === currency ? row.price : 0), 0);
      }
      refreshBalance();
      if (!rows.length) return;
      // A player can be owed both currencies at once, so the headline names whichever
      // is actually waiting rather than assuming one.
      const waiting = (["GOLD", "BRAINS"] as const)
        .filter((currency) => held[currency] > 0)
        .map((currency) => marketPrice(held[currency], currency));
      const header = document.createElement("div");
      header.className = "bm-fulfill-title";
      header.textContent = waiting.length
        ? `Trades settled! The market is holding ${waiting.join(" and ")} for you — collect it.`
        : rows.some((row) => row.awaitingClaim)
          ? "Trades settled! Collect to take delivery."
          : "Your posts went through! Collect to dismiss.";
      const rail = document.createElement("div");
      rail.className = "bm-fulfill-rail";
      fulfillStrip.append(header, rail);
      for (const entry of rows) {
        // A card either owes this player a zombie (they bought it, or their request was
        // filled) or reports brains that already landed. The zombie is minted by the
        // Collect below — until then it lives on the order, so nothing can strand it in
        // a Mausoleum the farm does not have.
        const claiming = !!entry.awaitingClaim;
        const paying = !!entry.awaitingPayout;
        const sold = entry.kind === "SELL_ZOMBIE" && !claiming;
        const zombieName = cardFor(entry.zombieKey)?.name ?? entry.zombieKey;
        const card = document.createElement("div");
        card.className = "bm-card bm-fulfilled";
        const portrait = document.createElement("img");
        portrait.src = this.zombiePortraitOf?.(entry.zombieKey) ?? cardFor(entry.zombieKey)?.portrait ?? "";
        // Both directions describe one concrete unit — the sale's escrowed zombie, or
        // the one the fulfiller handed over for a request — so both get that unit's
        // mutated portrait. Trades too old to have recorded it keep the neutral
        // species portrait and say nothing about mutations.
        if (entry.mutation !== undefined && this.zombieMutationPortraitOf) {
          onFirstVisible(portrait, () => {
            void this.zombieMutationPortraitOf?.(entry.zombieKey, entry.mutation!, entry.color,
              () => card.isConnected)
              .then((source) => { if (card.isConnected) portrait.src = source; })
              .catch(() => { /* retain the static species portrait */ });
          });
        }
        const body = document.createElement("div");
        const name = document.createElement("div");
        name.className = "bm-name";
        name.textContent = sold ? `${zombieName} — Sold!`
          : entry.kind === "SELL_ZOMBIE" ? `${zombieName} — Purchased!`
          : `${zombieName} — Request filled!`;
        const traits = document.createElement("div");
        traits.className = "bm-fulfill-traits";
        if (entry.mutation !== undefined) {
          const bits = [mutationLabelFor(entry.zombieKey, entry.mutation) || "No mutations"];
          if (entry.invasions) bits.push(veterancy(entry.invasions));
          traits.textContent = bits.join(" · ");
        } else {
          traits.hidden = true;
        }
        const meta = document.createElement("div");
        meta.className = "bm-meta";
        const when = new Date(entry.fulfilledAt).toLocaleDateString();
        const room = this.canTakeZombieDelivery?.() ?? true;
        meta.textContent = sold
          ? `Bought by ${entry.fulfilledBy} · ${when}\n${paying
            ? `The market is holding ${marketPrice(entry.price, entry.currency)} — collect to bank it.`
            : `${entry.currency === "GOLD" ? "The gold is" : "The brains are"} already in your balance.`}`
          : claiming
            ? `From ${entry.fulfilledBy} · ${when}\n${room
              ? "Waiting for you — collect to bring it home."
              : "Your farm and Mausoleum are full. Free a slot, then collect."}`
            : `Delivered by ${entry.fulfilledBy} · ${when}\nThe zombie is already on your farm.`;
        const cost = document.createElement("div");
        cost.className = "bm-price";
        cost.append(entry.price.toLocaleString());
        const coin = document.createElement("img");
        coin.src = UI(MARKET_COIN[entry.currency]);
        cost.appendChild(coin);
        body.append(name, traits, meta, cost);
        const action = document.createElement("button");
        action.textContent = "Collect";
        action.onclick = async () => {
          action.disabled = true;
          try {
            const result = await this.onCollectBlackMarketOrder?.(entry.id, claiming);
            const claimed = result?.claimed ?? null;
            card.remove();
            if (!rail.childElementCount) fulfillStrip.hidden = true;
            held[entry.currency] = Math.max(0, held[entry.currency] - (result?.paid ?? 0));
            refreshBalance();
            const coinEmoji = entry.currency === "GOLD" ? "💰" : "🧠";
            this.showToast(sold
              ? result?.paid
                ? `Cha-ching! ${marketPrice(result.paid, entry.currency)} collected — ${zombieName} sold to ${entry.fulfilledBy}. ${coinEmoji}`
                : `Cha-ching! ${zombieName} sold to ${entry.fulfilledBy} for ${marketPrice(entry.price, entry.currency)}. ${coinEmoji}`
              : claimed?.stored
                ? `${zombieName} is resting in your Mausoleum — deploy it when there's room. 🧟`
                : `${zombieName} has joined your horde! 🧟`);
          } catch (error) {
            // The delivery is never lost: refused for room, it keeps waiting on the
            // card, so say what to do instead of the generic retry line.
            const code = error instanceof Error ? error.message : "";
            this.showToast(code.startsWith("no_room")
              ? "No room! Free a farm slot (or a Mausoleum slot) and collect again."
              : "Could not collect that just now. Try again in a moment.");
            action.disabled = false;
          }
        };
        card.append(portrait, body, action);
        rail.appendChild(card);
      }
    };

    const renderHistory = async () => {
      historyView.innerHTML = `<div class="bm-empty">Opening the ledger…</div>`;
      if (!this.socialOnline?.() || !this.getBlackMarketHistory) {
        historyView.innerHTML = `<div class="bm-empty">Sign in to see your trade history.</div>`;
        return;
      }
      let result: BlackMarketHistoryResponse;
      try { result = await this.getBlackMarketHistory(); }
      catch {
        historyView.innerHTML = `<div class="bm-empty">The ledger is unavailable right now.</div>`;
        return;
      }
      if (!bg.isConnected) return;
      historyView.replaceChildren();
      const nameOf = (key: string) => cardFor(key)?.name ?? key;

      const statsRow = document.createElement("div");
      statsRow.className = "bm-stats";
      const stat = (text: string) => {
        const chip = document.createElement("div");
        chip.className = "bm-stat";
        chip.textContent = text;
        statsRow.appendChild(chip);
      };
      const { sold, bought, mostTraded } = result.stats;
      // Gold and brains never sum, so each total lists whichever currencies it actually
      // contains — a brains-only trader's chips read exactly as they did before gold.
      const earnings = (totals: { brains: number; gold: number }) => {
        const parts: string[] = [];
        if (totals.gold) parts.push(`${totals.gold.toLocaleString()} 💰`);
        if (totals.brains || !totals.gold) parts.push(`${totals.brains.toLocaleString()} 🧠`);
        return parts.join(" · ");
      };
      stat(`🧟 Sold ${sold.count} · earned ${earnings(sold)}`);
      stat(`🛒 Bought ${bought.count} · spent ${earnings(bought)}`);
      for (const best of [sold.best, sold.bestGold]) {
        if (!best) continue;
        stat(`🏆 Best sale: ${nameOf(best.zombieKey)} for ${best.price.toLocaleString()} ${best.currency === "GOLD" ? "💰" : "🧠"}`);
      }
      if (mostTraded) stat(`⭐ Most traded: ${nameOf(mostTraded.zombieKey)} ×${mostTraded.count}`);
      historyView.appendChild(statsRow);

      if (!result.entries.length) {
        const empty = document.createElement("div");
        empty.className = "bm-empty";
        empty.textContent = "No completed trades yet. Post something on the market!";
        historyView.appendChild(empty);
        return;
      }
      const ledger = document.createElement("div");
      ledger.className = "bm-ledger";
      historyView.appendChild(ledger);
      for (const entry of result.entries) {
        const row = document.createElement("div");
        row.className = "bm-ledger-row";
        const portrait = document.createElement("img");
        portrait.src = this.zombiePortraitOf?.(entry.zombieKey) ?? cardFor(entry.zombieKey)?.portrait ?? "";
        if (entry.mutation && this.zombieMutationPortraitOf) {
          onFirstVisible(portrait, () => {
            void this.zombieMutationPortraitOf?.(entry.zombieKey, entry.mutation!, entry.color,
              () => row.isConnected)
              .then((source) => { if (row.isConnected) portrait.src = source; })
              .catch(() => { /* retain the static species portrait */ });
          });
        }
        const body = document.createElement("div");
        body.className = "bm-meta";
        const title = document.createElement("div");
        title.className = "bm-name";
        // Four trade shapes: my sale sold / I bought their sale / my request was
        // filled / I filled their request.
        title.textContent = entry.earned
          ? entry.mine
            ? `Sold ${nameOf(entry.zombieKey)} to ${entry.counterparty}`
            : `Filled ${entry.counterparty}'s request — ${nameOf(entry.zombieKey)}`
          : entry.mine
            ? `${entry.counterparty} filled your request — ${nameOf(entry.zombieKey)}`
            : `Bought ${nameOf(entry.zombieKey)} from ${entry.counterparty}`;
        const detailBits = [new Date(entry.fulfilledAt).toLocaleDateString()];
        if (entry.mutation) detailBits.push(mutationLabelFor(entry.zombieKey, entry.mutation));
        if (entry.invasions) detailBits.push(veterancy(entry.invasions));
        const detail = document.createElement("div");
        detail.textContent = detailBits.join(" · ");
        body.append(title, detail);
        const delta = document.createElement("div");
        delta.className = entry.earned ? "bm-ledger-gain" : "bm-ledger-loss";
        delta.append(`${entry.earned ? "+" : "−"}${entry.price.toLocaleString()}`);
        const coin = document.createElement("img");
        coin.src = UI(MARKET_COIN[entry.currency]);
        delta.appendChild(coin);
        row.append(portrait, body, delta);
        ledger.appendChild(row);
      }
    };

    const renderOrders = async () => {
      const generation = ++renderGeneration;
      list.innerHTML = `<div class="bm-empty">Refreshing market…</div>`;
      if (!this.socialOnline?.() || !this.getBlackMarketOrders) {
        list.innerHTML = `<div class="bm-empty">Sign in to use the Black Market.</div>`;
        return;
      }
      try {
        const result = await this.getBlackMarketOrders({
          kind, zombieClass: categoryFilter.value || undefined,
          zombieGroup: classFilter.value || undefined,
          currency: (currencyFilter.value || undefined) as BlackMarketCurrency | undefined,
          sort: sort.value as "newest" | "price_asc" | "price_desc", mine: mine.checked,
        });
        if (generation !== renderGeneration || !bg.isConnected) return;
        // Both countdowns are differences between two SERVER timestamps, so they are
        // measured against the server's clock. Reading the device's would let a
        // skewed phone report a fresh post as expired (or the reverse).
        const serverNow = result.summary?.serverTime ?? Date.now();
        list.replaceChildren();
        if (!result.orders.length) {
          const empty = document.createElement("div"); empty.className = "bm-empty";
          empty.textContent = "No matching posts yet."; list.appendChild(empty); return;
        }
        for (const order of result.orders) {
          const marketCard = document.createElement("div");
          marketCard.className = `bm-card${order.mine ? " mine" : ""}`;
          const portrait = document.createElement("img");
          portrait.src = this.zombiePortraitOf?.(order.zombieKey) ?? cardFor(order.zombieKey)?.portrait ?? "";
          // A sale represents one concrete owned zombie, so its portrait should use
          // that unit's complete mutation mask. Keep the catalog image as an
          // immediate/failure fallback; wanted orders can describe alternatives and
          // therefore deliberately retain the neutral species portrait.
          if (order.kind === "SELL_ZOMBIE" && this.zombieMutationPortraitOf) {
            onFirstVisible(portrait, () => {
              void this.zombieMutationPortraitOf?.(order.zombieKey, order.mutation ?? 0, order.color,
                // A refreshed board or a closed panel both retire this card, and both
                // happen constantly here (every filter, sort and trade rebuilds the list).
                () => generation === renderGeneration && marketCard.isConnected)
                .then((source) => {
                  if (generation === renderGeneration && marketCard.isConnected) portrait.src = source;
                })
                .catch(() => { /* retain the static species portrait */ });
            });
          }
          const body = document.createElement("div");
          const name = document.createElement("div"); name.className = "bm-name";
          name.textContent = cardFor(order.zombieKey)?.name ?? order.zombieKey;
          const meta = document.createElement("div"); meta.className = "bm-meta";
          const mutationText = order.kind === "BUY_ZOMBIE"
            ? order.mutationRequired
              ? `Requested mutations: ${blackMarketMutationRequirementLabel(order.mutationRequired)}`
              : `Requested mutation: ${order.mutated ? "Any mutation" : "None"}`
            : `Mutated: ${order.mutated
              ? `Yes${order.mutation ? ` — ${mutationLabelFor(order.zombieKey, order.mutation)}` : ""}`
              : "No"}${order.invasions ? ` · ${veterancy(order.invasions)}` : ""}`;
          // Every post now has a shelf life, so every card says how much of it is
          // left — a listing quietly vanishing three days on would otherwise look
          // like it had been taken down. An older Worker sends no `expiresAt`, and
          // then the line is simply omitted.
          //
          // An EXPIRED post can only reach this board one way: it is the caller's own
          // sale, and the sweep could not hand the zombie back because their farm and
          // Mausoleum are both full (see blackMarket.list). Say exactly that, because
          // the fix is theirs to make and Cancel Post is the button that finishes it.
          const expiresIn = order.expiresAt === undefined
            ? ""
            : order.expiresAt <= serverNow
              ? " · EXPIRED — free a farm or Mausoleum slot to take this zombie back"
              : ` · expires in ${fmtMarketWait(order.expiresAt - serverNow)}`;
          marketCard.classList.toggle(
            "bm-expired", order.expiresAt !== undefined && order.expiresAt <= serverNow
          );
          meta.textContent =
            `${mutationText}\n${order.mine ? "Your post" : order.creatorName}${expiresIn}`;
          const cost = document.createElement("div"); cost.className = "bm-price";
          cost.append(order.price.toLocaleString());
          const coin = document.createElement("img"); coin.src = UI(MARKET_COIN[order.currency]); cost.appendChild(coin);
          body.append(name, meta, cost); marketCard.append(portrait, body);
          // Filled in for other players' listings: inspecting one offers the trade.
          let inspectLock: string | undefined;
          let inspectTrade: (() => Promise<void>) | undefined;
          if (order.mine) {
            // Bump: re-dates the post so it leads "newest" again and its three days
            // start over. Offered only once the cooldown has passed — a disabled
            // button that names the wait is clearer than hiding it and leaving the
            // player to guess whether the feature exists. An already-expired post is
            // NOT bumpable (the server refuses it): it is waiting to be cancelled,
            // not to be put back on the front page.
            const expired = order.expiresAt !== undefined && order.expiresAt <= serverNow;
            if (this.onRepostBlackMarketOrder && order.repostableAt !== undefined && !expired) {
              const wait = order.repostableAt - serverNow;
              const bump = document.createElement("button");
              bump.className = "bm-repost";
              bump.textContent = wait > 0 ? `Bump in ${fmtMarketWait(wait)}` : "Bump to Top";
              bump.disabled = wait > 0;
              bump.title = "Move this post back to the top of Newest and restart its three days.";
              bump.onclick = async (event) => {
                event.stopPropagation();
                bump.disabled = true;
                try {
                  await this.onRepostBlackMarketOrder?.(order.id);
                  this.showToast("Post bumped to the top — it has three more days.");
                  await renderOrders();
                } catch (error) {
                  const code = error instanceof Error ? error.message : "";
                  this.showToast(code.startsWith("repost_cooldown")
                    ? "That post was bumped too recently — try again later."
                    : "Could not bump that post. Refresh and try again.");
                  await renderOrders();
                }
              };
              marketCard.appendChild(bump);
            }
            const action = document.createElement("button");
            action.className = "cancel"; action.textContent = "Cancel Post";
            action.onclick = async (event) => {
              event.stopPropagation();
              if (!await this.confirmInGame("Cancel this post?", "The escrowed zombie or payment will be returned.", "Cancel Post")) return;
              action.disabled = true;
              try {
                await this.onCancelBlackMarketOrder?.(order.id);
                refreshBalance();
                this.showToast("Post cancelled — your escrow was returned.");
                await renderOrders();
              }
              catch (error) {
                // A cancel hands the escrowed zombie straight back — there is no waiting
                // card to hold it — so it is refused outright when there is nowhere to
                // put it. The post survives, so say what to free rather than "try again".
                const code = error instanceof Error ? error.message : "";
                this.showToast(code.startsWith("no_room")
                  ? "Your farm and Mausoleum are full — free a slot before taking this zombie back."
                  : "Could not cancel that post. Refresh and try again.");
                action.disabled = false;
              }
            };
            marketCard.appendChild(action);
          } else {
            const purchaseLock = order.kind === "SELL_ZOMBIE" ? purchaseLockFor(order.zombieKey) : null;
            if (purchaseLock) {
              marketCard.classList.add("locked");
              const lockNote = document.createElement("div");
              lockNote.className = "bm-lock";
              lockNote.textContent = purchaseLock.label;
              body.appendChild(lockNote);
            }
            const completeTrade = async (rowAction?: HTMLButtonElement) => {
              if (purchaseLock) { this.showToast(purchaseLock.label); return; }
              let unitId: string | undefined;
              const asking = marketPrice(order.price, order.currency);
              let detail = `Spend ${asking} for this zombie?`;
              // Buying with nowhere to put it is allowed — the zombie waits on the
              // Collect card rather than being forced somewhere — but say so up front
              // instead of letting it look like the purchase went nowhere.
              if (order.kind === "SELL_ZOMBIE" && this.canTakeZombieDelivery?.() === false) {
                detail += "\n\nYour farm and Mausoleum are full, so it will wait to be collected until you free a slot.";
              }
              if (order.kind === "BUY_ZOMBIE") {
                const match = await this.chooseBlackMarketZombie(order);
                if (!match) { this.showToast("You do not own a matching available zombie."); return; }
                unitId = match.id; detail = `Trade ${match.name} for ${asking}?`;
              }
              if (!await this.confirmInGame("Complete this trade?", detail, "Trade")) return;
              if (rowAction) rowAction.disabled = true;
              try {
                await this.onFulfillBlackMarketOrder?.(order, unitId);
                refreshBalance();
                const zombieName = cardFor(order.zombieKey)?.name ?? order.zombieKey;
                this.showToast(order.kind === "SELL_ZOMBIE"
                  ? `Bought ${zombieName} for ${asking} — collect it above! 🧟`
                  : `Sold your ${zombieName} for ${asking}! ${order.currency === "GOLD" ? "💰" : "🧠"}`);
                await renderOrders();
                // The purchase now waits as a collectable delivery, so surface its card
                // straight away rather than at the next time the panel opens.
                await renderFulfillments();
              }
              catch (error) {
                const code = error instanceof Error ? error.message : "";
                if (code.startsWith("insufficient_brains") || code.startsWith("insufficient_gold"))
                  this.showToast(`You need ${asking} to buy this zombie.`);
                else if (code.startsWith("black_market_locked"))
                  this.showToast(`The Black Market opens at level ${BLACK_MARKET_MIN_LEVEL}.`);
                else if (code.startsWith("black_market_level_locked"))
                  this.showToast("Reach the required level before purchasing this zombie.");
                else if (code.startsWith("counterparty_busy"))
                  this.showToast("The seller is syncing. Try the trade again in a moment.");
                else this.showToast("That trade is no longer available. Market refreshed.");
                await renderOrders();
              }
            };
            // Sale listings carry no row-level Buy button: tapping the listing opens
            // the zombie card, and the purchase happens from there. Wanted posts keep
            // their row action.
            if (order.kind === "BUY_ZOMBIE") {
              const action = document.createElement("button");
              action.textContent = "Sell Matching Zombie";
              action.onclick = (event) => { event.stopPropagation(); void completeTrade(action); };
              marketCard.appendChild(action);
            }
            inspectLock = purchaseLock?.label;
            inspectTrade = completeTrade;
          }
          // Only a listing whose species is in the trading catalog can be inspected;
          // the rest must not advertise a tap that would do nothing.
          if (this.blackMarketCardFor(order.zombieKey)) {
            const inspect = () => this.openBlackMarketZombie(order, inspectLock, inspectTrade);
            marketCard.classList.add("inspect");
            marketCard.tabIndex = 0;
            marketCard.onclick = inspect;
            marketCard.onkeydown = (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              inspect();
            };
          }
          list.appendChild(marketCard);
        }
      } catch {
        if (generation === renderGeneration) list.innerHTML = `<div class="bm-empty">Black Market is unavailable right now.</div>`;
      }
    };

    requestTab.onclick = () => { composing = false; viewingHistory = false; kind = "BUY_ZOMBIE"; setTabs(); void renderOrders(); };
    salesTab.onclick = () => { composing = false; viewingHistory = false; kind = "SELL_ZOMBIE"; setTabs(); void renderOrders(); };
    historyTab.onclick = () => { composing = false; viewingHistory = true; setTabs(); void renderHistory(); };
    composeTab.onclick = () => { composing = true; setTabs(); };
    for (const control of [categoryFilter, classFilter, currencyFilter, sort, mine]) control.onchange = () => void renderOrders();
    refresh.onclick = () => { void renderOrders(); void renderFulfillments(); };
    composeKind.onchange = updateCompose;
    asset.onchange = refreshComposeStatus;
    currencyPicker.onchange = refreshComposeStatus;
    mutationMode.onchange = refreshComposeStatus;
    for (const input of mutationChecks) input.onchange = refreshComposeStatus;
    submit.onclick = async () => {
      const amount = Number(price.value);
      const currency = composeCurrency();
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > MARKET_MAX_PRICE) {
        this.showToast(`Enter a whole ${currency === "GOLD" ? "gold" : "brain"} price between 1 and ${MARKET_MAX_PRICE.toLocaleString()}.`);
        return;
      }
      const selling = composeKind.value === "SELL_ZOMBIE";
      if (!selling) {
        const purchaseLock = purchaseLockFor(asset.value);
        if (purchaseLock) { this.showToast(purchaseLock.label); return; }
      }
      const warning = selling
        ? "The selected zombie will be held in escrow."
        : `${marketPrice(amount, currency)} will be held in escrow.`;
      if (!await this.confirmInGame("Create Black Market post?", warning, "Create Post")) return;
      submit.disabled = true;
      try {
        const mutationRequired = mutationMode.value === "specific"
          ? selectedMutationMask()
          : undefined;
        await this.onCreateBlackMarketOrder?.(selling
          ? { kind: "SELL_ZOMBIE", unitId: asset.value, price: amount, currency }
          : {
              kind: "BUY_ZOMBIE",
              zombieKey: asset.value,
              mutated: mutationMode.value !== "false",
              ...(mutationRequired ? { mutationRequired } : {}),
              price: amount,
              currency,
            });
        // Land the player back on the board the new post just joined, so on a
        // compact layout the post they created is what they see next.
        composing = false;
        viewingHistory = false;
        kind = selling ? "SELL_ZOMBIE" : "BUY_ZOMBIE";
        this.showToast(selling ? "Sale posted to the Black Market!" : "Request posted to the Black Market!");
        setTabs(); updateCompose(); refreshBalance(); price.value = ""; await renderOrders();
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code.startsWith("zombie_not_tradable"))
          this.showToast("That zombie type cannot be traded.");
        else if (code.startsWith("zombie_unavailable"))
          this.showToast("That zombie is no longer available or is busy.");
        else if (code.startsWith("active_post_limit"))
          this.showToast("You can't have more than 10 active Black Market posts.");
        else if (code.startsWith("daily_post_limit"))
          this.showToast("You have reached today's limit of 50 Black Market posts.");
        else if (code.startsWith("insufficient_brains"))
          this.showToast("You do not have enough brains for that request.");
        else if (code.startsWith("insufficient_gold"))
          this.showToast("You do not have enough gold for that request.");
        else if (code.startsWith("black_market_locked"))
          this.showToast(`The Black Market opens at level ${BLACK_MARKET_MIN_LEVEL}.`);
        else if (code.startsWith("black_market_level_locked"))
          this.showToast("Reach the required level before requesting this zombie.");
        else this.showToast("Could not create that post. Refresh and try again.");
      }
      finally { refreshComposeStatus(); }
    };

    setTabs(); updateCompose();
    panel.append(title, close, balance, tabs, toolbar, fulfillStrip, content, historyView);
    bg.appendChild(panel);
    this.el.appendChild(bg);
    void renderOrders();
    void renderFulfillments();
  }

  /** Show every owned unit that satisfies a wanted order and return the one the
   * player explicitly chooses. */
  private chooseBlackMarketZombie(order: BlackMarketOrderView): Promise<RosterEntry | null> {
    const matches = (this.getRoster?.() ?? []).filter((zombie) => zombie.key === order.zombieKey &&
      matchesBlackMarketMutation(zombie.mutation, order.mutated, order.mutationRequired));
    if (!matches.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let closeModal = () => {};
      const finish = (value: RosterEntry | null) => {
        if (settled) return;
        settled = true;
        closeModal();
        resolve(value);
      };
      const modal = openModal({
        host: this.el, bgClass: "bm-pick-bg", panelClass: "zl-panel",
        title: "Choose a zombie to sell", onClose: () => finish(null),
      });
      closeModal = modal.close;
      const list = document.createElement("div");
      list.className = "zl-list";
      for (const zombie of matches) {
        const row = document.createElement("div");
        row.className = "zl-row";
        row.appendChild(buildZombieCard(this, rosterInfo(this, zombie), modal.panel));
        const choose = document.createElement("button");
        choose.className = "zbtn sell";
        choose.textContent = `Sell this zombie for ${marketPrice(order.price, order.currency)}`;
        choose.onclick = () => finish(zombie);
        row.appendChild(choose);
        list.appendChild(row);
      }
      modal.panel.appendChild(list);
    });
  }

  /** The trading-catalog card backing a listing's species, or undefined when that
   * species carries no inspectable stats (the listing is then display-only). */
  private blackMarketCardFor(zombieKey: string): MenuCard | undefined {
    const card = this.blackMarketZombieCards.find((entry) => entry.cfg.key === zombieKey);
    return card?.zombie ? card : undefined;
  }

  /** Inspect market zombies with the viewing player's own unlocked abilities and
   * purchase requirements. Locked listings remain inspectable. */
  private openBlackMarketZombie(
    order: BlackMarketOrderView,
    lockLabel?: string,
    trade?: () => Promise<void>,
  ) {
    const card = this.blackMarketCardFor(order.zombieKey);
    const zombie = card?.zombie;
    if (!card || !zombie) return;
    const mask = order.kind === "SELL_ZOMBIE" ? order.mutation ?? 0 : order.mutationRequired ?? 0;
    const bonus = mutationBonus(mask);
    const info: ZombieInfo = {
      name: card.name, typeName: card.name, key: card.cfg.key,
      group: zombie.group, className: zombie.className, classColor: zombie.classColor,
      str: (zombie.str + bonus.str) * this.state.farmerZombieStrengthMult(),
      dex: zombie.dex + bonus.dex,
      con: (zombie.con + bonus.con) * this.state.farmerZombieLifeMult(),
      focus: zombie.focus, mutation: mask, invasions: order.invasions ?? 0,
      portrait: card.portrait,
    };
    const { panel, close } = openModal({
      host: this.el, bgClass: "bm-zombie-bg", panelClass: "zpanel",
    });
    panel.appendChild(buildZombieCard(this, info, panel));
    const note = document.createElement("div");
    note.className = lockLabel ? "bm-lock" : "bm-meta";
    note.textContent = lockLabel ?? `${marketPrice(order.price, order.currency)} · ${order.creatorName}`;
    panel.appendChild(note);
    if (!order.mine && trade) {
      const action = document.createElement("button");
      action.className = "zbtn sell";
      action.textContent = order.kind === "SELL_ZOMBIE" ? "Buy this zombie" : "Sell a matching zombie";
      action.disabled = !!lockLabel;
      action.onclick = () => { close(); void trade(); };
      panel.appendChild(action);
    }
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
    // One note, not two: the old pair overlapped and one of them still promised a
    // brain per gift, which stopped being true when contents became a roll.
    const note = document.createElement("div");
    note.className = "fr-note";
    const acctBar = document.createElement("div");
    acctBar.className = "fr-acct";
    const requestsWrap = document.createElement("div");
    const inboxWrap = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.className = "fr-toolbar";
    const list = document.createElement("div");
    list.className = "prof-list";
    panel.append(x, h, note, acctBar, requestsWrap, inboxWrap, toolbar, list);

    const canOnline = this.onlineAvailable?.() ?? false;
    const online = () => this.socialOnline?.() ?? false;
    let sort = getFriendSort();
    // Gift rows previewed before the "Show all" expander. Deliberately session-only:
    // an expanded inbox is a momentary "let me look", not a setting worth persisting.
    let inboxExpanded = false;

    const giftErr = (e: string | null): string | null =>
      e === null ? null
        : e === "already_gifted_today" ? "You already gifted them today."
        : e === "gift_pending" ? "They haven't opened your last gift yet."
        : e === "insufficient_gold" ? `You need ${GIFT_GOLD_COST} gold to send another gift today.`
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

    // ---- bulk actions --------------------------------------------------
    // Both are just the single-gift path in a loop: every send and every claim is
    // still validated, charged, and fenced individually server-side. Sequential on
    // purpose — claims contend for the account fence, and serial sends keep the
    // gold check honest instead of racing ten of them at the balance.

    /** True while a batch is running: blocks a second batch from interleaving. */
    let bulkBusy = false;
    const runBatch = async (batch: () => Promise<void>) => {
      if (bulkBusy) return;
      bulkBusy = true;
      renderAll();
      try { await batch(); }
      finally { bulkBusy = false; renderAll(); }
    };

    /** Whether this friend can receive a gift right now. Online the server owns the
     *  window (giftOnCooldown); offline it's the local 24h timer. */
    const canGiftNow = (f: Friend) =>
      online() ? !f.giftOnCooldown : canGiftBrain(f, Date.now());

    /** Friends who can still receive a gift from me today, in display order. */
    const giftableFriends = () => (this.getFriends?.() ?? []).filter(canGiftNow);

    /** Error codes that mean "stop the whole batch", not "skip this one friend".
     *  gift_pending and recipient_inbox_full are per-recipient, so the batch skips
     *  past them and keeps going. */
    const batchStopping = new Set([
      "insufficient_gold", "rate_limited",
      "offline", "not_configured", "no_session", "unauthorized",
    ]);

    const runGiftAll = async (plan: GiftAllPlan) => {
      const goldBefore = this.state.gold;
      let sent = 0;
      let failure: string | null = null;
      for (const id of plan.targets) {
        const err = online()
          ? await (this.onGiftBrainOnline?.(id) ?? Promise.resolve("offline"))
          : (this.onGiftBrain?.(id) ? null : "already_gifted_today");
        if (err) {
          failure ??= err;
          if (batchStopping.has(err)) break;
          continue; // a per-recipient problem (full inbox) must not end the batch
        }
        sent++;
      }
      await refresh();
      if (!sent) {
        this.showToast(giftErr(failure) ?? "Nobody could receive a gift right now.");
        return;
      }
      // Report the gold the balance ACTUALLY moved by, not the quoted estimate.
      const spent = Math.max(0, goldBefore - this.state.gold);
      const parts = [`Sent ${sent} gift${sent === 1 ? "" : "s"}!`];
      if (online()) parts.push(`+${sent * GIFT_XP_REWARD} XP`);
      if (spent > 0) parts.push(`−${spent.toLocaleString()} gold`);
      const missed = plan.targets.length - sent;
      if (missed > 0) parts.push(`${missed} couldn't be delivered`);
      this.showToast(parts.join(" · "));
    };

    const confirmGiftAll = () => {
      const eligible = giftableFriends();
      if (!eligible.length) {
        this.showToast("Every friend has already had a gift from you today.");
        return;
      }
      if (!online()) {
        // The local list has no economy behind it: gifting costs the player nothing.
        this.confirmBulkAction({
          title: "Gift all friends?",
          lead: `Send a gift to ${eligible.length} friend${eligible.length === 1 ? "" : "s"}?`,
          lines: [],
          confirmLabel: "Send",
          failToast: "Couldn't send those gifts.",
          onConfirm: () => runBatch(() => runGiftAll({
            targets: eligible.map((f) => f.id), freeCount: eligible.length,
            paidCount: 0, goldCost: 0, skippedForGold: 0,
          })),
        });
        return;
      }
      // Only the free tier depends on today's send count, and a friend blocked by an
      // UNOPENED gift wasn't necessarily gifted today — so count the ones actually on
      // today's cooldown rather than every ineligible friend.
      const sentToday = (this.getFriends?.() ?? [])
        .filter((f) => f.giftOnCooldown && !f.giftPending).length;
      const plan = planGiftAll({
        eligibleIds: eligible.map((f) => f.id), sentToday, gold: this.state.gold,
      });
      if (!plan.targets.length) {
        this.showToast(`You need ${GIFT_GOLD_COST} gold to send another gift today.`);
        return;
      }
      const cost = plan.paidCount === 0
        ? `All ${plan.freeCount === 1 ? "of it is" : "free"} — no gold.`
        : plan.freeCount > 0
          ? `${plan.freeCount} free + ${plan.paidCount} × ${GIFT_GOLD_COST} gold = ${plan.goldCost.toLocaleString()} gold.`
          : `${plan.paidCount} × ${GIFT_GOLD_COST} gold = ${plan.goldCost.toLocaleString()} gold.`;
      const lines = [cost, `You have ${this.state.gold.toLocaleString()} gold. Each gift earns you ${GIFT_XP_REWARD} XP.`];
      if (plan.skippedForGold > 0) {
        lines.push(`${plan.skippedForGold} friend${plan.skippedForGold === 1 ? "" : "s"} left out — not enough gold for them.`);
      }
      this.confirmBulkAction({
        title: "Gift all friends?",
        lead: `Send a gift to ${plan.targets.length} friend${plan.targets.length === 1 ? "" : "s"}?`,
        lines,
        confirmLabel: plan.goldCost > 0 ? `Send (${plan.goldCost.toLocaleString()} gold)` : "Send",
        failToast: "Couldn't send those gifts.",
        onConfirm: () => runBatch(() => runGiftAll(plan)),
      });
    };

    const runOpenAll = async () => {
      const gifts = [...(this.getInbox?.() ?? [])];
      let brains = 0;
      let gold = 0;
      let opened = 0;
      let emptied = 0; // already opened elsewhere — nothing credited
      let failure: string | null = null;
      for (const g of gifts) {
        // refreshInbox:false — one pull at the end instead of one per gift.
        const result = await (this.onClaimGift?.(g.id, { refreshInbox: false })
          ?? Promise.resolve("You're offline right now."));
        if (typeof result === "string") { failure = result; break; }
        if (!result) { emptied++; continue; }
        opened++;
        if (result.kind === "brain") brains += result.amount;
        else gold += result.amount;
      }
      await refresh();
      if (!opened) {
        this.showToast(failure ?? (emptied ? "Those gifts had already been opened." : "No gifts to open."));
        return;
      }
      const haul = [
        brains > 0 ? `${brains} brain${brains === 1 ? "" : "s"} 🧠` : null,
        gold > 0 ? `${gold.toLocaleString()} gold 💰` : null,
      ].filter(Boolean).join(" and ");
      this.showToast(`Opened ${opened} gift${opened === 1 ? "" : "s"}: ${haul}!`);
      // A stopped batch leaves the rest in the inbox; say so rather than going quiet.
      if (failure) this.showToast(failure);
    };

    const confirmOpenAll = () => {
      const gifts = this.getInbox?.() ?? [];
      if (!gifts.length) return;
      this.confirmBulkAction({
        title: "Open all gifts?",
        lead: `Open all ${gifts.length} gift${gifts.length === 1 ? "" : "s"} in your inbox?`,
        // Deliberately no preview of the haul: contents stay sealed until opened.
        lines: ["You'll see what each one held once they're open."],
        confirmLabel: "Open all",
        failToast: "Couldn't open those gifts.",
        onConfirm: () => runBatch(runOpenAll),
      });
    };

    /** A bulk button. `busyLabel` shows while a batch is in flight; both buttons are
     *  disabled for the duration so a second press can't interleave with the first. */
    const bulkButton = (label: string, busyLabel: string, run: () => void) => {
      const btn = document.createElement("button");
      btn.className = "prof-btn play fr-bulk";
      btn.textContent = bulkBusy ? busyLabel : label;
      btn.disabled = bulkBusy;
      btn.onclick = run;
      return btn;
    };

    const renderInbox = () => {
      inboxWrap.innerHTML = "";
      if (!online()) return;
      const gifts = this.getInbox?.() ?? [];
      if (!gifts.length) return;
      // Every row reads "🎁 Gift from ‹name›" — near-identical, and one per friend once
      // the pending rule is in force. Rendering all of them buried "Open all" and the
      // friends list under a wall of them, so preview a few and let the player ask for
      // the rest. Collapse again whenever the inbox shrinks back under the limit.
      if (gifts.length <= INBOX_PREVIEW) inboxExpanded = false;
      const shown = inboxExpanded ? gifts : gifts.slice(0, INBOX_PREVIEW);
      const hd = document.createElement("div");
      hd.className = "fr-inbox-h fr-sticky-h";
      hd.textContent = `🎁 Gifts for you (${gifts.length})`;
      if (gifts.length > 1) {
        hd.appendChild(bulkButton("Open all", "Opening…", confirmOpenAll));
      }
      inboxWrap.appendChild(hd);
      for (const g of shown) {
        const row = document.createElement("div");
        row.className = "prof-row fr-inbox-row";
        const nm = document.createElement("div");
        nm.className = "prof-name";
        // The contents were fixed when the gift was sent, but they stay sealed until
        // it's opened — the inbox never says what's inside.
        nm.append("🎁 Gift from ");
        const bfrom = document.createElement("b");
        bfrom.textContent = g.fromName; // textContent: no markup from account strings
        nm.appendChild(bfrom);
        const claim = document.createElement("button");
        claim.className = "prof-btn play";
        claim.textContent = "Open";
        claim.onclick = async () => {
          claim.disabled = true;
          const result = await (this.onClaimGift?.(g.id) ?? Promise.resolve("Couldn't claim that gift."));
          if (typeof result === "string") {
            this.showToast(result);
            claim.disabled = false;
          } else {
            // null = already opened elsewhere: drop it from the inbox, but don't
            // pretend it paid out something the player never received.
            this.showToast(result
              ? `${g.fromName} sent you ${giftRewardLabel(result)}!`
              : "That gift had already been opened.");
            await refresh();
          }
        };
        row.append(nm, claim);
        inboxWrap.appendChild(row);
      }
      if (gifts.length > INBOX_PREVIEW) {
        const more = document.createElement("div");
        more.className = "prof-row fr-inbox-row fr-inbox-more";
        const toggle = document.createElement("button");
        toggle.className = "prof-btn fr-inbox-toggle";
        toggle.textContent = inboxExpanded
          ? "Show fewer"
          : `Show all ${gifts.length} gifts`;
        toggle.onclick = () => { inboxExpanded = !inboxExpanded; renderInbox(); };
        more.appendChild(toggle);
        inboxWrap.appendChild(more);
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
          // A full list still RECEIVES requests, so a refusal here needs to say which
          // side is full — otherwise the request just sits there looking broken.
          if (err) {
            this.showToast(
              err === "friends_full"
                ? `Your friends list is full (${MAX_FRIENDS}). Remove someone to accept.`
                : err === "requester_full" ? `${r.name}'s friends list is full.`
                : "Couldn't accept that request."
            );
            accept.disabled = false;
          }
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

    const renderToolbar = () => {
      toolbar.innerHTML = "";
      const friends = this.getFriends?.() ?? [];
      if (friends.length < 2) return; // one friend — nothing to sort or batch
      const label = document.createElement("label");
      label.className = "fr-sort";
      label.append("Sort");
      const select = document.createElement("select");
      select.className = "prof-input fr-sort-select";
      for (const option of FRIEND_SORTS) {
        // "Gifts to you" is meaningless for the local list — nobody sends to it.
        if (option.id === "giftsReceived" && !online()) continue;
        const item = document.createElement("option");
        item.value = option.id;
        item.textContent = option.label;
        item.selected = option.id === sort;
        select.appendChild(item);
      }
      select.onchange = () => {
        if (!isFriendSort(select.value)) return;
        sort = select.value;
        setFriendSort(sort);
        renderList();
      };
      label.appendChild(select);
      const ready = giftableFriends().length;
      const btn = bulkButton(`Gift all 🎁${ready ? ` (${ready})` : ""}`, "Sending…", confirmGiftAll);
      btn.classList.add("fr-gift");
      btn.disabled = btn.disabled || !ready;
      btn.title = ready
        ? "Send a gift to every friend who can still receive one today"
        : "Everyone has already had a gift from you today.";
      toolbar.append(label, btn);
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
      for (const f of sortFriends(friends, sort, canGiftNow)) {
        const row = document.createElement("div");
        row.className = "prof-row fr-friend-row";
        const head = document.createElement("div");
        head.className = "fr-friend-head";
        const summary = document.createElement("button");
        summary.className = "fr-friend-summary";
        summary.type = "button";
        summary.setAttribute("aria-expanded", "false");
        // Level rides at the FRONT of the row rather than inside the drawer: it is
        // the stat players scan the list by, and hiding it behind a tap meant
        // opening every friend in turn to compare.
        const lvl = document.createElement("span");
        lvl.className = `fr-lvl ${levelTier(f.level)}`;
        lvl.textContent = f.level == null ? "–" : String(f.level);
        lvl.title = f.level == null ? "Level unavailable" : `Level ${f.level}`;
        // The head they're wearing, beside their name — the list is how players
        // recognise each other, and a chosen face does that faster than a name does.
        // Absent for local entries and for anyone on an older Worker: the row simply
        // renders without a face rather than falling back to someone else's.
        const face = this.friendHeadPart(f.headId);
        const facePic = document.createElement("img");
        if (face) {
          facePic.className = "fr-friend-face";
          facePic.src = `${BASE}assets/player/${face.part}`;
          facePic.alt = "";
          // Eager, unlike the Market's portrait grid: the list is capped at 50 rows of
          // head sprites already in the bundle, so deferring them saves nothing and
          // only risks a row rendering face-less.
          facePic.decoding = "async";
          facePic.title = `Wearing: ${face.name}`;
        }
        const nm = document.createElement("span");
        nm.className = "fr-friend-name-wrap";
        const nameText = document.createElement("span");
        nameText.className = "fr-friend-name";
        nameText.textContent = f.name?.trim() || "Unnamed friend";
        const meta = document.createElement("span");
        meta.className = "fr-friend-meta";
        // Online: how generous they've been to me + how recently they played.
        // Offline: the local list only knows what I've sent them.
        // A phone row has room for roughly one of the two halves spelled out, so the
        // gift count drops to its badge form there — it's the half players asked to
        // see, and the title attribute keeps the full reading available.
        const sentToYou = isMobile() ? "" : " sent to you";
        const bits = online()
          ? [
            f.giftsReceived ? `🎁 ${f.giftsReceived}${sentToYou}` : null,
            f.activity ? ACTIVITY_LABEL[f.activity] : null,
          ]
          : [f.giftsSent ? `🎁 ${f.giftsSent}${isMobile() ? "" : " sent"}` : null];
        meta.textContent = bits.filter(Boolean).join(" · ");
        // The line ellipsises on a narrow phone, so keep the unabbreviated reading
        // available on the row itself.
        if (meta.textContent) {
          meta.title = online()
            ? `${f.giftsReceived ?? 0} gift${f.giftsReceived === 1 ? "" : "s"} sent to you`
              + (f.activity ? ` · ${ACTIVITY_LABEL[f.activity]}` : "")
            : `${f.giftsSent} gift${f.giftsSent === 1 ? "" : "s"} sent`;
        }
        nm.append(nameText);
        if (meta.textContent) nm.appendChild(meta);
        const more = document.createElement("button");
        more.className = "fr-friend-more";
        more.type = "button";
        more.textContent = "⋯";
        more.setAttribute("aria-label", `More actions for ${f.name}`);
        more.setAttribute("aria-expanded", "false");
        const menu = document.createElement("div");
        menu.className = "fr-friend-menu";
        menu.hidden = true;
        const menuId = `friend-actions-${f.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
        menu.id = menuId;
        summary.setAttribute("aria-controls", menuId);
        more.setAttribute("aria-controls", menuId);
        const acts = document.createElement("div");
        acts.className = "prof-actions";
        // Gifting is the whole point of the panel, so it stays on the row itself;
        // only visit/remove/block live behind the drawer.
        const gift = document.createElement("button");
        gift.className = "prof-btn play fr-gift fr-gift-inline";
        const giftCoolingDown = !canGiftNow(f);
        gift.disabled = giftCoolingDown;
        // Two different reasons to be blocked, and the player can act on one of them
        // (wait for tomorrow) but not the other (wait for THEM), so name which it is.
        gift.textContent = giftCoolingDown ? (f.giftPending ? "Waiting 🎁" : "Gifted 🎁") : "Gift 🎁";
        gift.title = !giftCoolingDown
          ? "Send this friend a gift"
          : f.giftPending
            ? "They haven't opened your last gift yet — you can send another once they do."
            : "You already gifted this friend today.";
        gift.onclick = async () => {
          if (online()) {
            gift.disabled = true;
            const err = giftErr(await (this.onGiftBrainOnline?.(f.id) ?? Promise.resolve("offline")));
            if (err) { this.showToast(err); gift.disabled = false; }
            else {
              f.giftOnCooldown = true;
              this.showToast(`Sent a gift to ${f.name}! +5 XP`);
              renderFriends();
            }
          } else {
            if (this.onGiftBrain?.(f.id)) {
              this.showToast(`Sent a gift to ${f.name}! 🎁`);
              renderFriends();
            }
          }
        };
        // Visit (online only): open a read-only view of this friend's farm. f.id
        // is the friend's account id server-side, which the visit fetch needs.
        if (online()) {
          const visit = document.createElement("button");
          visit.className = "prof-btn play fr-visit";
          visit.textContent = "Visit 👁";
          visit.title = `Look around ${f.name}'s farm (read-only)`;
          visit.onclick = () => this.onVisitFriend?.(f.id, f.name);
          acts.appendChild(visit);
          // Friend invasions launch from the Invasions panel (Social → Invasions),
          // not from this drawer — see ui/panels/invasions.ts.
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
            renderFriends();
          });
          acts.appendChild(del);
        }
        menu.append(acts);
        summary.append(lvl, ...(face ? [facePic] : []), nm);
        const toggle = () => {
          const opening = !row.classList.contains("is-open");
          row.classList.toggle("is-open", opening);
          summary.setAttribute("aria-expanded", String(opening));
          more.setAttribute("aria-expanded", String(opening));
          menu.hidden = !opening;
        };
        summary.onclick = toggle;
        more.onclick = toggle;
        head.append(summary, gift, more);
        row.append(head, menu);
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
          renderFriends();
        }
      };
      add.onclick = commit;
      inp.onkeydown = (e) => { if (e.key === "Enter") void commit(); };
      newRow.append(inp, add);
      list.appendChild(newRow);
    };

    const renderNote = () => {
      note.textContent = !canOnline
        ? "Send each friend a gift a day. (Local list — sign-in isn't set up on this build.)"
        : online()
          ? `One gift per friend a day (once they've opened the last one). ${FREE_DAILY_GIFTS} free, then ${GIFT_GOLD_COST} gold each — and ${GIFT_XP_REWARD} XP every time.`
          : "Sign in to connect with friends online. You can still keep a local list below.";
    };

    // (Friend-invasion history and defense claims moved to the Invasions panel —
    // Social → Invasions, ui/panels/invasions.ts.)

    // The toolbar's "Gift all (N)" count and the rows both read the same cooldown
    // state, so gifting one friend has to repaint BOTH — repainting only the list
    // left the count one gift stale.
    const renderFriends = () => { renderToolbar(); renderList(); };
    const renderAll = () => {
      renderNote(); renderAcct(); renderRequests(); renderInbox(); renderFriends();
    };
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
    bindBackdropDismiss(bg, () => bg.remove());
    this.el.appendChild(bg);
  }

  /** Single-zombie inspect modal (used by main.ts taps and the Mausoleum). */
  openZombieInfo(info: ZombieInfo, refresh?: () => void) {
    openZombieInfoPanel(this, info, refresh);
  }

  /** A tapped Memorial Statue: its occupant's read-only card, or the graveyard to
   *  pick one from. */
  openMemorial(view: MemorialView) {
    openMemorialPanel(this, view);
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
    let timer: number | undefined;
    // The live countdown timer is cleared via onClose so it stops on the close
    // button, a backdrop click, or a programmatic close() below.
    const { panel, close } = openModal({
      host: this.el, panelClass: "crop-info", title: first.name,
      onClose: () => { if (timer !== undefined) clearInterval(timer); },
    });

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

    panel.append(kind, time);
    if (boost) panel.append(grow);
  }

  // The "Zombies" tab (right bar): the My Zombies roster + the Zombie Almanac
  // collection, both rendered by ui/panels/zombies.ts.
  openZombieList(tab?: ZombiesPanelTab) {
    openZombiesPanel(this, tab);
  }

  // The Mausoleum (tap the building): a fixed set of storage slots. Filled slots
  // hold stored zombies (tap to inspect / deploy back); empty slots are tapped to
  // move a zombie in off the farm. On-farm zombies do NOT appear here.
  openMausoleum() {
    const { panel } = openModal({ host: this.el, bgClass: "zr-bg", replaceSelector: ".zr-bg" });

    const wrap = document.createElement("div");
    wrap.className = "zroster";
    const head = document.createElement("div");
    head.className = "zr-head";
    const grid = document.createElement("div");
    grid.className = "zr-grid";
    const foot = document.createElement("div");
    foot.className = "zbtns";
    wrap.append(head, grid, foot);
    panel.append(wrap);

    const render = () => {
      const roster = this.getRoster ? this.getRoster() : [];
      const stored = roster.filter((r) => r.stored);
      const cap = this.getMausoleumCap?.() ?? 0;
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
          grid.appendChild(buildRosterCard(this, z, () => this.openZombieInfo(rosterInfo(this, z), render)));
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

      // Saved line-ups live with the building that holds the zombies they swap in
      // and out. Offered even with no teams yet — this is the only door to them.
      foot.innerHTML = "";
      const teams = document.createElement("button");
      teams.className = "zbtn store";
      const savedTeams = this.getTeams?.().length ?? 0;
      teams.textContent = savedTeams ? `Teams (${savedTeams})` : "Teams";
      teams.title = "Save and swap farm line-ups";
      teams.onclick = () => openTeamsPanel(this, render);
      foot.appendChild(teams);

      // Upgrade the building in place: each tier adds five slots for brains.
      const next = this.getMausoleumUpgrade?.() ?? null;
      if (next) {
        const button = document.createElement("button");
        button.className = "zbtn deploy";
        button.textContent = `Upgrade to ${next.slots} slots — ${next.cost}${next.brains ? "b" : "g"}`;
        button.onclick = async () => {
          button.disabled = true;
          if (await this.confirmPurchase(next.name, next.cost, next.brains)) {
            await this.onMausoleumUpgrade?.();
          }
          render();
        };
        foot.appendChild(button);
      }
      // Deploying or inspecting a zombie rebuilds every slot; an upgraded crypt is
      // dozens of tiles long, so hold the player's place in it.
      keepScroll(grid, "mausoleum.grid");
    };
    render();
  }

  // Empty-slot picker: choose an on-farm zombie to move into the Mausoleum.
  private pickZombieToStore(afterStore: () => void) {
    const roster = this.getRoster ? this.getRoster() : [];
    const onFarm = roster.filter((r) => !r.stored);
    const { panel, close } = openModal({ host: this.el, bgClass: "zpick-bg", replaceSelector: ".zpick-bg" });

    const wrap = document.createElement("div");
    wrap.className = "zroster";
    const head = document.createElement("div");
    head.className = "zr-head";
    head.innerHTML = `<h2>Store a Zombie</h2><span class="zr-total">Tap one to store</span>`;
    const grid = document.createElement("div");
    grid.className = "zr-grid";
    wrap.append(head, grid);
    panel.append(wrap);

    if (!onFarm.length) {
      const e = document.createElement("div");
      e.className = "zr-empty";
      e.textContent = "No zombies on the farm to store.";
      grid.appendChild(e);
      return;
    }
    for (const z of onFarm) {
      grid.appendChild(
        buildRosterCard(this, z, async () => {
          await this.onZombieStore?.(z.id);
          close();
          afterStore();
        })
      );
    }
  }

  // ---- Zombie Pot: combine two zombies (tap the placed Zombie Pot) ----
  openCombiner() {
    // Stop the outgoing panel's ticker before its DOM goes: removing the element
    // leaves its 250ms interval alive on a detached tree for the rest of the session,
    // and each reopen used to add another.
    this.combinerStop?.();
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
    bindBackdropDismiss(bg, () => { stop(); bg.remove(); });
    this.el.appendChild(bg);

    const portraitOf = (key: string) => this.zombiePortraitOf?.(key) ?? "";
    // A heavily mutated zombie can be unrecognisable — a pumpkin head and a celery
    // arm hide most of the body. Every tile in this panel names the SPECIES as well,
    // so the player can tell what they are actually putting in (tester request).
    const typeNameOf = (key: string) =>
      this.blackMarketZombieCards.find((card) => card.cfg.key === key)?.name
      ?? this.zombieCards.find((card) => card.cfg.key === key)?.name
      ?? key;
    const typeLine = (text: string) => {
      const el = document.createElement("div");
      el.className = "cmb-sty";
      el.textContent = text;
      return el;
    };
    // Marks a tile whose zombie is resting in the Mausoleum rather than on the farm.
    // Both can be combined, so the badge is the only thing telling them apart.
    const storedTag = () => {
      const el = document.createElement("div");
      el.className = "cmb-zstored";
      el.textContent = "Stored";
      el.title = "Resting in the Mausoleum";
      return el;
    };
    // The same corner magnifier the Market cards carry: it opens this individual's
    // inspect card so its class, stats, mutations and abilities can be read before it
    // goes in the pot. Deliberately WITHOUT the card's Store/Sell/Deploy row (`id`
    // omitted) — acting on a zombie from inside the picker would leave it selected in
    // a slot while it left the roster.
    const inspectButton = (z: RosterEntry) =>
      magnifierButton(`See ${z.name}'s card`, "See this zombie's card",
        () => this.openZombieInfo({ ...rosterInfo(this, z), id: undefined }));
    const showPortrait = (
      el: HTMLElement,
      key: string,
      mutation: number,
      color?: [number, number, number],
    ) => {
      const fallback = portraitOf(key) || portraitOf("ZombieActorRegularTier1");
      if (fallback) el.style.backgroundImage = `url(${fallback})`;
      if (!this.zombieMutationPortraitOf) return;
      // Only the tiles the player scrolls to pay for a portrait: the picker lists the
      // whole roster (farm + Mausoleum) but shows about a fifth of it at a time.
      onFirstVisible(el, () => {
        void this.zombieMutationPortraitOf?.(key, mutation, color, () => el.isConnected)
          .then((portrait) => {
            if (el.isConnected) el.style.backgroundImage = `url(${portrait})`;
          })
          .catch(() => { /* retain the static species portrait */ });
      });
    };
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
    // Registered once for the panel's lifetime, NOT cleared inside stop(): the views
    // call stop() themselves before installing a fresh interval, so clearing the
    // handle there would leave the newest ticker unreachable — which is the leak this
    // is here to prevent. A stale handle is harmless; stop() is idempotent.
    this.combinerStop = stop;

    // --- BUSY view: the two parents + a progress bar while the combine runs,
    //     then the finished zombie on its own once it is ready to collect. ---
    const renderBusy = () => {
      const st = this.getPotStatus?.();
      if (!st || !st.busy) { stop(); renderIdle(); return; }
      // Which of the two layouts is on screen. The combine can finish under the
      // ticking timer, so tick() rebuilds when this flips.
      const done = !!st.result;
      wrap.innerHTML = "";
      const head = document.createElement("div");
      head.className = "cmb-head";
      head.innerHTML = `<h2>Zombie Pot</h2>`;
      const t = document.createElement("span");
      t.className = "cmb-time";
      head.appendChild(t);

      const note = document.createElement("div");
      note.className = "cmb-note";

      // Latched across the async collect so the 250ms tick can't re-enable the
      // button under an in-flight hand-off and collect the same job twice. Shared by
      // both destinations so the crypt button cannot double-collect the farm's job.
      let collecting = false;
      const collect = async (button: HTMLButtonElement, toCrypt: boolean) => {
        if (collecting) return;
        collecting = true;
        button.disabled = true;
        const name = await this.onCollectCombine?.(toCrypt);
        // Collected: the pot is empty again, so go back to the pick-two view.
        if (name) { stop(); renderIdle(); return; }
        collecting = false;
      };
      const go = document.createElement("button");
      go.className = "cmb-go";
      go.textContent = "Collect";
      go.onclick = () => void collect(go, false);
      // The Mausoleum is a real destination for the child, so a full farm no longer
      // strands a finished combine. Only shown while a crypt slot is actually free.
      const toCrypt = document.createElement("button");
      toCrypt.className = "cmb-go cmb-store";
      toCrypt.textContent = "To Mausoleum";
      toCrypt.onclick = () => void collect(toCrypt, true);

      // Finish the wait from the panel you are already looking at. The Insta-Grow tool
      // has always worked on a running pot, but only by closing this panel, equipping
      // the tool and tapping the building. Only offered while the combine is still
      // RUNNING and the player owns a use — there is nothing to hurry once it is ready.
      const growBoost = this.getSpeedGrowBoost?.();
      const hurry = document.createElement("button");
      hurry.className = "cmb-go cmb-hurry";
      hurry.onclick = () => {
        if (!this.onPotInstaGrow?.()) return;
        renderBusy(); // the job is ready now: swap straight to the collect layout
      };

      let fill: HTMLElement | null = null;
      if (done) {
        // Nothing goes in the pot any more — show only what came out of it.
        const result = document.createElement("div");
        result.className = "cmb-result";
        const p = document.createElement("div");
        p.className = "cmb-rpor";
        showPortrait(p, st.result!.key, st.result!.mutation, st.result!.color);
        const n = document.createElement("div");
        n.className = "cmb-rn";
        n.textContent = st.result!.name;
        const mut = document.createElement("div");
        mut.className = "cmb-rm";
        mut.textContent = mutationLabelFor(st.result!.key, st.result!.mutation) || "no mutations";
        result.append(p, n, typeLine(typeNameOf(st.result!.key)), mut);
        const buttons = document.createElement("div");
        buttons.className = "cmb-actions";
        buttons.append(go, toCrypt);
        wrap.append(head, result, note, buttons);
      } else {
        // Show the two parents going in (from the pending job's keys + masks).
        const slots = document.createElement("div");
        slots.className = "cmb-slots";
        const parent = (key: string, mask: number, color?: [number, number, number]) => {
          const d = document.createElement("div");
          d.className = "cmb-slot filled";
          const p = document.createElement("div");
          p.className = "cmb-por";
          showPortrait(p, key, mask, color);
          const mut = document.createElement("div");
          mut.className = "cmb-sm";
          mut.textContent = mutationLabelFor(key, mask) || "no mutations";
          d.append(p, typeLine(typeNameOf(key)), mut);
          return d;
        };
        const plus = document.createElement("div");
        plus.className = "cmb-plus";
        plus.textContent = "+";
        slots.append(parent(st.pending!.keyA, st.pending!.maskA, st.pending!.colorA), plus,
          parent(st.pending!.keyB, st.pending!.maskB, st.pending!.colorB));

        const bar = document.createElement("div");
        bar.className = "cmb-prog";
        fill = document.createElement("i");
        bar.appendChild(fill);
        const buttons = document.createElement("div");
        buttons.className = "cmb-actions";
        buttons.append(go, toCrypt);
        if (growBoost && this.onPotInstaGrow) buttons.appendChild(hurry);
        wrap.append(head, slots, bar, note, buttons);
      }

      const tick = () => {
        const s = this.getPotStatus?.();
        if (!s || !s.busy) { stop(); renderIdle(); return; }
        // The combine finished while this view was up: swap in the result layout.
        if (!!s.result !== done) { renderBusy(); return; }
        if (fill) {
          const prog = s.totalMs > 0 ? (s.totalMs - s.remainingMs) / s.totalMs : 1;
          fill.style.width = `${Math.min(100, prog * 100)}%`;
        }
        t.textContent = s.ready ? "Ready!" : fmt(s.remainingMs);
        note.textContent = s.ready
          ? "The combine is done — collect your new zombie."
          : `Combining… ${fmt(s.remainingMs)} left` + (s.monolith ? " (Monolith: ×½)" : "");
        if (s.ready && !s.canCollect) {
          note.textContent = s.canStore
            ? "Farm full — send your new zombie to the Mausoleum."
            : "Farm and Mausoleum full — free a zombie slot to collect.";
        }
        go.disabled = collecting || !s.ready || !s.canCollect;
        // Hidden rather than disabled with no Mausoleum: an always-dead second button
        // reads as a bug, and the crypt is a real choice only once one is placed.
        toCrypt.style.display = s.canStore ? "" : "none";
        toCrypt.disabled = collecting || !s.ready;
        if (growBoost) {
          // The count is live: spending the last one elsewhere (or here) retires the
          // button rather than leaving an offer the player can no longer take.
          const held = growBoost.count();
          hurry.innerHTML =
            `<img class="cmb-hurry-i" src="${growBoost.icon}" alt=""> ${growBoost.name}` +
            `<span class="cmb-hurry-ct">x${held}</span>`;
          hurry.title = `Finish this combine now for one ${growBoost.name}.`;
          hurry.style.display = held > 0 && !s.ready ? "" : "none";
        }
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
      // The Mausoleum feeds the Pot directly: a stored zombie can go in without being
      // deployed first (it is consumed either way, and deploying it just to combine it
      // needed a free army slot the player often did not have). Each stored tile is
      // badged so it is clear where the zombie is coming from.
      const roster = (this.getRoster?.() ?? []).filter((zombie) =>
        this.canCombineZombie?.(zombie.key) ?? true
      );
      const canUseInSlot = (key: string, slot: "A" | "B") =>
        this.canCombineZombie?.(key, slot) ?? true;
      const head = document.createElement("div");
      head.className = "cmb-head";
      head.innerHTML = `<h2>Zombie Pot</h2>`;
      const time = document.createElement("span");
      time.className = "cmb-time";
      time.textContent = st?.monolith ? "15 min · Monolith ×¼" : "1 hour";
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
          showPortrait(p, z.key, z.mutation, z.color);
          const n = document.createElement("div");
          n.className = "cmb-sn";
          n.textContent = z.name;
          const mut = document.createElement("div");
          mut.className = "cmb-sm";
          mut.textContent = mutationLabelFor(z.key, z.mutation) || "no mutations";
          d.append(p, n, typeLine(z.typeName), mut, inspectButton(z));
          if (z.stored) d.appendChild(storedTag());
          d.title = "Tap to remove";
          d.onclick = () => { if (which === "A") pickA = null; else pickB = null; renderIdle(); };
        } else {
          const h = document.createElement("div");
          h.className = "cmb-hint";
          h.textContent = which === "A" ? "Slot 1 (output type)" : "Slot 2";
          d.appendChild(h);
        }
        return d;
      };
      const plus = document.createElement("div");
      plus.className = "cmb-plus";
      plus.textContent = "+";
      slots.append(slotEl("A"), plus, slotEl("B"));

      const ruleNote = document.createElement("div");
      ruleNote.className = "cmb-rule-note";
      ruleNote.textContent = `Slot 1 sets the zombie type; mutations can come from both. Two zombies of the same type breed up a colour: Green to Blue, then Blue to Red, once you own that grave — and two Reds become a Silver at level ${COMBINE_SPECIAL_LEVEL}+. Special zombies only fit Slot 1 and always remain the same species.`;

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
          const nextSlot: "A" | "B" = pickA ? "B" : "A";
          const eligible = canUseInSlot(z.key, nextSlot);
          const c = document.createElement("div");
          c.className = "cmb-z" + (chosen ? " chosen" : "") + (!chosen && !eligible ? " disabled" : "");
          const p = document.createElement("div");
          p.className = "cmb-zpor";
          showPortrait(p, z.key, z.mutation, z.color);
          const n = document.createElement("div");
          n.className = "cmb-zn";
          n.textContent = z.name;
          const ty = document.createElement("div");
          ty.className = "cmb-zty";
          ty.textContent = z.typeName;
          c.append(p, n, ty, inspectButton(z));
          if (z.stored) c.appendChild(storedTag());
          if (z.mutation) {
            const m = document.createElement("div");
            m.className = "cmb-zmut";
            m.textContent = "M";
            m.title = mutationLabelFor(z.key, z.mutation);
            c.appendChild(m);
          }
          if (!chosen && eligible) {
            c.onclick = () => {
              if (!pickA) pickA = z.id;
              else if (!pickB) pickB = z.id;
              renderIdle();
            };
          } else if (!chosen && !eligible) {
            c.title = "Special zombies can only be placed in Slot 1.";
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
      wrap.append(head, slots, ruleNote, list, go);
      // Picking a zombie re-renders this whole view, and the picker is as long as the
      // roster — without this, every tap threw a player scrolled deep into their army
      // back to the first tile. Restored after the list is in the document: an
      // unattached element cannot be scrolled.
      keepScroll(list, "pot.picker");
    };

    const st0 = this.getPotStatus?.();
    if (st0?.busy) renderBusy(); else renderIdle();
  }

  /** A framed zombie tile (storage-shed slot style). `onClick` is the tap action. */
  // ---- Raids / Invasions ----
  /** In-game confirmation for purchasing the cooldown-bypass ticket. The purchase
   *  remains a normal catalog buy; `onBought` advances to army ordering only after
   *  the optimistic/server-backed purchase was accepted. */
  private openRaidTicketPrompt(cooldownMs: number, voucher: BoostDef, onBought: () => void) {
    const { panel, close } = openModal({
      host: this.el, bgClass: "raid-ticket-bg", panelClass: "confirm-panel",
      title: "Skip the invasion wait?", replaceSelector: ".raid-ticket-bg",
    });

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
    cancel.onclick = () => close();
    const buy = document.createElement("button");
    buy.className = "zbtn sell";
    buy.textContent = `Buy Ticket · ${voucher.cost.toLocaleString()} Gold`;
    markPrimary(buy); // Enter buys
    buy.onclick = () => {
      if (!this.onBuyBoost?.(voucher)) {
        this.showToast(`You need ${voucher.cost.toLocaleString()} gold for an Invasion Voucher.`);
        return;
      }
      close();
      onBought();
    };
    btns.append(cancel, buy);
    panel.append(msg, btns);
  }

  /** Buy a Brain Ticket from the Army screen, with what it costs AND what it does to
   *  the fight stated before the gold leaves. The elite warning belongs here as well as
   *  in Tim's one-off notice: Tim speaks once ever, and this is the screen where the
   *  choice is actually made. */
  private openBrainTicketPrompt(onBought: () => void) {
    const ticket = this.boosts.find((boost) => boost.key === BRAIN_TICKET_KEY);
    if (!ticket) {
      this.showToast("Brain Tickets are unavailable right now.");
      return;
    }
    const { panel, close } = openModal({
      host: this.el, bgClass: "raid-ticket-bg", panelClass: "confirm-panel",
      title: "Buy a Brain Ticket?", replaceSelector: ".raid-ticket-bg",
    });

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent =
      "Quadruples this invasion's brain and rare-zombie odds, and skips the wait.";
    const warning = document.createElement("span");
    warning.className = "confirm-warn";
    warning.textContent =
      "It also makes the invasion ELITE — far stronger than usual. Zombies lost are gone for good.";
    msg.append(document.createElement("br"), warning);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => close();
    const buy = document.createElement("button");
    buy.className = "zbtn sell";
    buy.textContent = `Buy Ticket · ${ticket.cost.toLocaleString()} Gold`;
    markPrimary(buy); // Enter buys
    buy.onclick = () => {
      if (!this.onBuyBoost?.(ticket)) {
        this.showToast(`You need ${ticket.cost.toLocaleString()} gold for a Brain Ticket.`);
        return;
      }
      close();
      onBought();
    };
    btns.append(cancel, buy);
    panel.append(msg, btns);
  }

  // Raid select: a list of invasions (left) + the selected raid's detail (right).
  // Only playable + level-met raids can be invaded; the rest show as locked cards
  // so the ladder reads as a real (mostly future) catalog.
  openRaids() {
    // Stop the outgoing panel's cooldown ticker before its DOM goes — reopening
    // (the "i" hotkey, the Invade shortcut) otherwise leaves it running detached.
    this.raidSelectStop?.();
    document.querySelector("#hud .raid-bg")?.remove();
    const tutorialRaid = this.el.classList.contains("tutorial") && this.tutorialMenuTarget === "Invade";
    const allCards = this.getRaidCards ? this.getRaidCards() : [];
    const cards = tutorialRaid ? allCards.filter((card) => card.id === MCDONNELL_ID) : allCards;
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
    this.raidSelectStop = stop;
    const close = () => { stop(); bg.remove(); };
    x.onclick = close;
    if (tutorialRaid) x.style.display = "none";

    const wrap = document.createElement("div");
    wrap.className = "raidsel";
    const list = document.createElement("div");
    list.className = "raid-list";
    const detail = document.createElement("div");
    detail.className = "rd-detail";
    wrap.append(list, detail);
    panel.append(x, wrap);
    bg.appendChild(panel);
    if (!tutorialRaid) bindBackdropDismiss(bg, close);
    this.el.appendChild(bg);

    // Default selection: first unlocked raid, else the first card.
    let selId = (cards.find((c) => c.unlocked) ?? cards[0])?.id ?? -1;

    // Whether to advertise each raid's ELITE recommended level. Same visibility rule as
    // the Brain Ticket button on the army screen: a player who cannot buy one and holds
    // none has no elite invasion to be advised about, and the number would only be one
    // more unexplained figure on the card. (`brainTickets` is a global count — the raid
    // id passed here only picks the dice cap, which this call ignores.)
    const ticketLevel = this.boosts.find((b) => b.key === BRAIN_TICKET_KEY)?.level ?? 0;
    const showElite = this.state.level >= ticketLevel ||
      (this.getRaidBoosts?.(selId)?.brainTickets ?? 0) > 0;
    /** The elite advice as a card/detail suffix — empty when it should stay hidden. */
    const eliteAdvice = (c: RaidCardView, long: boolean): string => {
      if (!showElite) return "";
      // Past roughly level 30 the figure stands in for a GEARED roster rather than for a
      // level (player level stops buying army strength there — see raids.json
      // `eliteRecommendedLevel`), so say so instead of quoting a level the player may
      // already have.
      const geared = c.eliteRecommendedLevel > 30;
      const title = geared
        ? `A Brain Ticket run here is fitted for level ${c.eliteRecommendedLevel} — and at ` +
          "this end of the ladder that means a mutated, veteran army as much as a level."
        : `A Brain Ticket run here is fitted for level ${c.eliteRecommendedLevel}.`;
      const text = long
        ? `Elite level ${c.eliteRecommendedLevel}${geared ? "+" : ""}`
        : `Elite ${c.eliteRecommendedLevel}${geared ? "+" : ""}`;
      return ` <span class="rd-elite-lv" title="${title}">· ${text}</span>`;
    };

    /** Redraw ONLY the cooldown-dependent footer of the mounted detail pane.
     *
     *  The 1s ticker used to call renderDetail, which wipes and rebuilds the whole pane.
     *  Everything above the footer is static for a given raid, so that was a full
     *  relayout once a second: the drop-rate lines (`.rd-drop`, flex-wrap) re-wrapped,
     *  which changed the pane's height, which toggled its own overflow-y scrollbar,
     *  which changed the available width and re-wrapped them again — text visibly
     *  pulsing while an invasion cooled down. It also reset the scroll position every
     *  second, so a long drop list could not be read at all. Set by renderDetail. */
    let refreshFoot: (() => void) | null = null;

    const renderDetail = () => {
      const c = cards.find((r) => r.id === selId);
      detail.innerHTML = "";
      refreshFoot = null;
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
        eliteAdvice(c, true) +
        // The XP the NEXT win pays: the big one-time first-clear bonus while it is still
        // unclaimed, then the per-raid repeat trickle from then on. Only ever one of the
        // two — they never stack, so advertising both would overstate the reward.
        (c.firstClearXp > 0
          ? ` · First clear: ${c.firstClearXp} XP`
          : c.repeatXp > 0
            ? ` · ${c.repeatXp} XP per win`
            : "") +
        `</div>`;
      hero.append(por, info);

      const intro = document.createElement("p");
      intro.className = "rd-intro";
      intro.textContent = c.lockReason && !c.unlocked
        ? (c.lockReason === "Coming soon"
            ? "This invasion isn't available yet — its battlefield is still being built."
            : `${c.introText}`)
        : c.introText;

      // What a win here is actually worth, in numbers: the brain odds, this raid's own
      // rare zombie, and the boosts on its loot table. The old one-of-each-tier item
      // preview is gone — a list of decorations told the player nothing about which
      // invasion to pick. NOTE: the brain/zombie pity floors stay unmentioned by design.
      const rewards = document.createElement("div");
      rewards.className = "rd-drops";
      const dropRow = (label: string): HTMLElement => {
        const row = document.createElement("div");
        row.className = "rd-drop";
        const k = document.createElement("span");
        k.className = "rd-drop-k";
        k.textContent = label;
        const v = document.createElement("span");
        v.className = "rd-drop-v";
        row.append(k, v);
        rewards.appendChild(row);
        return v;
      };

      const tiers = c.brainOdds.tiers
        .map((t) => `${t.amount} ${t.amount === 1 ? "brain" : "brains"} ${pctOdds(t.chance)}`)
        .join(" · ");
      dropRow("Brains").textContent =
        `${pctOdds(c.brainOdds.chance)} per boss win (${tiers})` +
        ` · ${pctOdds(c.eliteBrainOdds.chance)} on a Brain Ticket`;
      if (c.zombieDrop) {
        dropRow(c.zombieDrop.name).textContent =
          `${pctOdds(c.zombieDrop.rate)} per win · ${pctOdds(c.zombieDrop.eliteRate)} on a` +
          " Brain Ticket · Golden Dice raise it";
      }
      const boostVal = dropRow("Boosts");
      if (!c.boostDrops.length) {
        boostVal.textContent = "None";
      } else {
        for (const b of c.boostDrops) {
          const chip = document.createElement("span");
          chip.className = "rd-chip";
          chip.textContent = b.qty > 1 ? `${b.name} ×${b.qty}` : b.name;
          boostVal.appendChild(chip);
        }
      }

      const foot = document.createElement("div");
      foot.className = "rd-foot";

      // Everything below is cooldown-dependent, so it — and only it — is what the 1s
      // ticker redraws. See `refreshFoot`.
      const renderFoot = () => {
        foot.innerHTML = "";
        const st = this.getRaidStatus
          ? this.getRaidStatus()
          : { cooldownMs: 0, voucherCount: 0, brainTicketCount: 0 };
        const cd = st.cooldownMs;
        if (cd <= 0) stop(); // ready again — no need to keep ticking

        const army = document.createElement("span");
        army.className = "rd-army" + (haveN < minN ? " short" : "");
        army.textContent = `Zombies ready: ${haveN} (need ${minN})`;
        const go = document.createElement("button");
        go.className = "raid-go";

        // Button state: lock reason > cooldown (with optional voucher bypass) > ready.
        let useVoucher = false;
        let buyVoucher = false;
        // A Brain Ticket skips the wait too, so owning one has to open the same door a
        // voucher does. Without this branch a player holding tickets but no voucher was
        // pushed into buying a voucher to reach the Army screen — the only screen the
        // ticket can be spent from.
        let armElite = false;
        // ...but the ticket must not become the ONLY door either: holding one used to
        // hide the 2,000g voucher entirely, so a player who bought a ticket and backed
        // out of the elite confirm could never again skip a wait without fighting ELITE.
        // When the ticket branch owns the main button, the voucher stays offered beside it.
        let offerVoucherBuy = false;
        const voucherCost = this.boosts.find((b) => b.key === VOUCHER_KEY)?.cost ?? 2000;
        if (!c.unlocked) {
          go.textContent = c.lockReason || "Locked";
          go.disabled = true;
        } else if (cd > 0) {
          if (st.brainTicketCount > 0 && st.voucherCount <= 0) {
            go.textContent = "Use Brain Ticket & Invade";
            go.disabled = !canFight;
            armElite = true;
            offerVoucherBuy = true;
            army.textContent =
              `${st.brainTicketCount} Brain Ticket${st.brainTicketCount > 1 ? "s" : ""}` +
              ` · skips the ${fmtCooldown(cd)} wait, but the invasion turns ELITE`;
          } else if (st.voucherCount > 0) {
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
            army.textContent =
              `Ready in ${fmtCooldown(cd)} · raid ticket: ${voucherCost.toLocaleString()} gold`;
          }
        } else {
          go.textContent = "Invade";
          go.disabled = !canFight;
        }
        // Buy an Invasion Voucher, then straight on to the Army screen with it armed.
        const beginVoucherBuy = () => {
          const voucher = this.boosts.find((boost) => boost.key === VOUCHER_KEY);
          if (!voucher) {
            this.showToast("Invasion Vouchers are unavailable right now.");
            return;
          }
          this.openRaidTicketPrompt(cd, voucher, () => {
            close();
            this.openRaidArmy(c, true);
          });
        };
        go.onclick = () => {
          if (buyVoucher) {
            beginVoucherBuy();
            return;
          }
          close();
          this.openRaidArmy(c, useVoucher, armElite);
        };
        const acts = document.createElement("div");
        acts.className = "rd-acts";
        if (offerVoucherBuy) {
          const alt = document.createElement("button");
          alt.className = "raid-quick";
          alt.textContent = `Buy Voucher · ${voucherCost.toLocaleString()}g`;
          alt.title = "Skip the wait the normal way — no elite wave.";
          alt.onclick = beginVoucherBuy;
          acts.appendChild(alt);
        }
        acts.appendChild(go);
        foot.append(army, acts);
      };
      refreshFoot = renderFoot;
      renderFoot();

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
        ? `<div class="rd-cl">Rec. Lv ${c.recommendedLevel}${eliteAdvice(c, false)}</div>`
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
    if (!tutorialRaid && this.bossActive) {
      const epic = this.getEpicBossView?.().find((view) => view.active);
      if (epic) {
        const card = document.createElement("button");
        card.className = "rd-card";
        const thumb = document.createElement("div");
        thumb.className = "rd-thumb";
        thumb.style.backgroundImage = `url(${epic.portrait})`;
        const txt = document.createElement("div");
        const name = document.createElement("div"); name.className = "rd-cn"; name.textContent = epic.name;
        const sub = document.createElement("div"); sub.className = "rd-cl"; sub.textContent = "Epic Boss Active";
        txt.append(name, sub); card.append(thumb, txt);
        card.onclick = () => { close(); this.openMarket("Epic Boss"); };
        list.prepend(card);
      }
    }
    renderDetail();
    // Live-update the countdown only if a cooldown is currently active. The ticker
    // touches the FOOTER only — rebuilding the whole pane once a second is what made
    // the drop-rate text pulse (see refreshFoot).
    if ((this.getRaidStatus?.().cooldownMs ?? 0) > 0) {
      tick = window.setInterval(() => refreshFoot?.(), 1000);
    }
  }

  // Army select: pick which owned zombies go on the raid. Auto-selects the
  // strongest up to the cap; toggle individual zombies; Start gated at the min.
  // `useVoucher` carries a cooldown-bypass intent from the Raid Select screen, and
  // `armElite` pre-arms the Brain Ticket when that screen's only way past the cooldown
  // was a ticket — so the choice the player already made is not silently forgotten here.
  openRaidArmy(raid: RaidCardView, useVoucher = false, armElite = false) {
    document.querySelector("#hud .army-bg")?.remove();
    const tutorialRaid = this.el.classList.contains("tutorial") && this.tutorialMenuTarget === "Invade";
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
    if (tutorialRaid) x.style.display = "none";
    panel.appendChild(x);
    bg.appendChild(panel);
    if (!tutorialRaid) bindBackdropDismiss(bg, () => bg.remove());
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
    // last raid's order. Un-picking a card leaves its slot EMPTY and the next card
    // tapped drops into the lowest empty slot, so swapping out whoever leads the charge
    // doesn't renumber (or mean re-picking) the whole line. Gaps are closed on launch —
    // see raid/attackOrderSlots.
    let order: OrderSlots = [];

    // Battle consumables for this raid: Concentration (skip the focus minigame) +
    // Golden Dice (each raises the loot to a rarer tier, capped by the raid's tier depth)
    // + the Brain Ticket (elite invasion, quadrupled brain odds).
    const boosts = this.getRaidBoosts
      ? this.getRaidBoosts(raid.id)
      : { concentration: 0, dice: 0, maxDice: 0, brainTickets: 0 };
    const diceMax = Math.min(boosts.dice, boosts.maxDice);
    let useConcentration = false;
    let diceChosen = 0;
    let useBrainTicket = armElite && boosts.brainTickets > 0;
    const launchOpts = (): RaidLaunchOpts => ({
      useVoucher,
      concentration: useConcentration,
      dice: diceChosen,
      brainTicket: useBrainTicket,
    });

    const start = document.createElement("button");
    start.className = "raid-go";

    const refresh = () => {
      const n = selectedCount(order);
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
      if (this.zombieMutationPortraitOf) {
        onFirstVisible(por, () => {
          void this.zombieMutationPortraitOf?.(
            z.key, visibleMutations(z.id, z.mutation), z.color, () => por.isConnected,
          )
            .then((image) => { if (por.isConnected) por.style.backgroundImage = `url(${image})`; })
            .catch(() => { /* retain the static species portrait */ });
        });
      }
      const nm = document.createElement("div");
      nm.className = "army-nm";
      nm.textContent = z.name;
      const ty = document.createElement("div");
      ty.className = "army-ty";
      ty.textContent = z.typeName;
      const st = document.createElement("div");
      st.className = "army-st";
      // Normalized 0–100 bars with all bonuses folded in: P(ower)/S(peed)/L(ife),
      // matching the detail card's tiles (see statDisplay.displayTotals).
      st.textContent = `P${z.dispPower} S${z.dispSpeed} L${z.dispLife}`;
      const tick = document.createElement("span");
      tick.className = "tick"; // order number, filled in by refresh()
      card.append(tick, por, nm, ty, st);
      card.onclick = () => {
        order = toggleSlot(order, z.id, cap);
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
    // Brain Ticket. Unlike the other two this is always offered, owned or not: it is the
    // only route to an elite invasion, and hiding it behind "buy one first" would leave
    // the whole feature undiscoverable from the screen it is used on. Buying happens
    // through the same confirm prompt as the raid ticket, so the 10,000 gold is never
    // spent on a stray tap.
    // …but only once the Brain Ticket is unlocked. Below its catalog level the server
    // refuses the buy outright ("locked"), so an ungated button here is a dead end: the
    // prompt opens, the player agrees to spend 10,000 gold, and nothing happens. The
    // elite ladder's bottom rung is well above what a fresh farm can field, which is why
    // the gate exists at all — see the catalog level in boosts.json.
    const ticketDef = this.boosts.find((b) => b.key === BRAIN_TICKET_KEY);
    const ticketUnlocked = this.state.level >= (ticketDef?.level ?? 0);
    let ticketsHeld = boosts.brainTickets;
    const eliteBtn = document.createElement("button");
    eliteBtn.className = "raid-boost-btn raid-elite-btn";
    const eliteNote = document.createElement("p");
    eliteNote.className = "raid-elite-note";
    const drawElite = () => {
      eliteBtn.innerHTML = ticketsHeld > 0
        ? `🎟 Brain Ticket <span class="rb-ct">x${ticketsHeld}</span>`
        : `🎟 Brain Ticket <span class="rb-ct">buy · ${(this.boosts.find((b) => b.key === BRAIN_TICKET_KEY)?.cost ?? 0).toLocaleString()}g</span>`;
      eliteBtn.classList.toggle("on", useBrainTicket);
      eliteNote.textContent = useBrainTicket
        ? "ELITE invasion: 4x brain and rare-zombie odds — and enemies far above this " +
          `invasion's usual strength. Fitted for level ${raid.eliteRecommendedLevel}` +
          `${raid.eliteRecommendedLevel > 30 ? " and a mutated, veteran army" : ""}.`
        : "";
    };
    eliteBtn.title =
      "Spend a Brain Ticket: skips the wait and quadruples the brain and rare-zombie " +
      "odds, but the invasion turns ELITE and hits much harder.";
    eliteBtn.onclick = () => {
      if (useBrainTicket) { useBrainTicket = false; drawElite(); return; }
      if (ticketsHeld > 0) { useBrainTicket = true; drawElite(); return; }
      this.openBrainTicketPrompt(() => {
        ticketsHeld++;
        useBrainTicket = true;
        drawElite();
      });
    };
    drawElite();
    // A held ticket still works below the gate (it may have been bought before a
    // rollback, or gifted): hide the button only when there is nothing to spend and
    // nothing that could be bought.
    if (ticketUnlocked || ticketsHeld > 0) boostRow.append(eliteBtn, eliteNote);
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
      order = fillSlots(
        order, party.orderedSelectedIds, party.eligible.map((z) => z.id), cap,
      );
      refresh();
    };

    start.onclick = async () => {
      // Gaps are a picking convenience only: the invasion is launched with a
      // continuous attack order.
      const attackOrder = compactOrder(order);
      if (attackOrder.length < min) return;
      // Always play the live battle scene — there is no instant/auto-resolve. Launch
      // may be async (an online server cooldown gate). Guard against a double-tap
      // while the gate is in flight. If it declines (cooldown, or a raid already
      // running), leave this screen up so the player can retry.
      if (!this.onLaunchRaid || start.disabled) return;
      // ELITE is the one launch the player can't back out of once it starts: the
      // ticket is charged, the wave is scaled several rungs above the card, and the
      // casualties are permanent. Ask HERE — before onLaunchRaid opens a server
      // session — so the warning is a decision rather than an announcement. (It used
      // to be a post-launch Tim notice with an OK button: by the time it was read the
      // army was already on the field. See main.ts.)
      if (useBrainTicket && !await this.confirmInGame(
        "Start an ELITE invasion?",
        `This spends a Brain Ticket. ${raid.name} will be fought at ELITE strength — ` +
        "far above its usual line — for 4x brain and rare-zombie odds. Zombies lost " +
        "are gone for good.",
        "Invade (Elite)"
      )) return;
      start.disabled = true;
      const launched = await this.onLaunchRaid(raid.id, attackOrder, launchOpts());
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
  /** Friend-invasion lineup: pick EXACTLY eight zombies, in attack order, then launch.
   *  A trimmed cousin of openRaidArmy — no cooldown, no vouchers, no battle boosts
   *  (PvP always fights at full focus), and the min IS the cap. */
  openPvpArmy(friendName: string, onLaunch: (orderedIds: string[]) => void) {
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
    bindBackdropDismiss(bg, () => bg.remove());
    this.el.appendChild(bg);

    const cap = PVP_ARMY_SIZE;
    if (!party || party.eligible.length < cap) {
      panel.insertAdjacentHTML("beforeend",
        `<h2>Invade ${friendName}'s farm</h2><p class="rd-intro">A friend invasion needs ` +
        `${cap} zombies on your farm. Grow a bigger army first.</p>`);
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

    let order: OrderSlots = [];
    const start = document.createElement("button");
    start.className = "raid-go";

    const refresh = () => {
      const n = selectedCount(order);
      head.innerHTML =
        `<h2>Invade ${friendName}'s farm</h2>` +
        `<span class="army-count${n < cap ? " short" : ""}">${n}/${cap}</span>`;
      start.textContent = n < cap ? `Pick ${cap - n} more` : `Invade with ${cap}`;
      start.disabled = n < cap;
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
      if (this.zombieMutationPortraitOf) {
        onFirstVisible(por, () => {
          void this.zombieMutationPortraitOf?.(
            z.key, visibleMutations(z.id, z.mutation), z.color, () => por.isConnected,
          )
            .then((image) => { if (por.isConnected) por.style.backgroundImage = `url(${image})`; })
            .catch(() => { /* retain the static species portrait */ });
        });
      }
      const nm = document.createElement("div");
      nm.className = "army-nm";
      nm.textContent = z.name;
      const ty = document.createElement("div");
      ty.className = "army-ty";
      ty.textContent = z.typeName;
      const st = document.createElement("div");
      st.className = "army-st";
      st.textContent = `P${z.dispPower} S${z.dispSpeed} L${z.dispLife}`;
      const tick = document.createElement("span");
      tick.className = "tick";
      card.append(tick, por, nm, ty, st);
      card.onclick = () => {
        order = toggleSlot(order, z.id, cap);
        refresh();
      };
      grid.appendChild(card);
    }

    const pick = document.createElement("button");
    pick.className = "raid-quick";
    pick.textContent = "Pick for me";
    pick.onclick = () => {
      order = fillSlots(
        order, party.orderedSelectedIds, party.eligible.map((z) => z.id), cap,
      );
      refresh();
    };

    start.onclick = () => {
      const attackOrder = compactOrder(order);
      if (attackOrder.length !== cap) return;
      bg.remove();
      onLaunch(attackOrder);
    };

    const note = document.createElement("p");
    note.className = "rd-intro";
    note.textContent =
      "Friendly fight — nobody loses zombies, no cooldown. " +
      "Stronger defenders give more boosts.";
    foot.append(note, pick, start);
    refresh();
  }

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
    // XP, under whichever of the two rules paid it: the one-time first-clear bonus
    // ("You earned Nxp for beating this enemy for the first time.") or the per-raid
    // trickle every later win pays. Labelled apart because the amounts overlap — the
    // panel must never make a routine repeat look like a first clear.
    if (view.xp > 0) rows.push([view.firstClear ? "First-Time XP" : "XP Earned", String(view.xp), ""]);
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
            .map((l) => {
              const note = l.note ? `<em class="rr-loot-note">${l.note}</em>` : "";
              const title = l.note ? `${lootDropLabel(l)} — ${l.note}` : lootDropLabel(l);
              return l.icon
                ? `<span class="rr-loot-i" title="${title}"><img src="${l.icon}"><span>${lootDropLabel(l)}</span>${note}</span>`
                : `<span class="rr-loot-i rr-loot-noimg" title="${title}">${lootDropLabel(l)}${note}</span>`;
            })
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
    zombies: {
      id: string;
      key: string;
      name: string;
      typeName: string;
      portrait: string;
      mutation: number;
      color?: [number, number, number];
    }[],
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
      if (this.zombieMutationPortraitOf) {
        onFirstVisible(portrait, () => {
          void this.zombieMutationPortraitOf?.(
            zombie.key, visibleMutations(zombie.id, zombie.mutation), zombie.color,
            () => portrait.isConnected)
            .then((image) => { if (portrait.isConnected) portrait.src = image; })
            .catch(() => { /* retain the static species portrait */ });
        });
      }
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
          ? `<span class="rr-loot-i" title="${lootDropLabel(l)}"><img src="${l.icon}"><span>${lootDropLabel(l)}</span></span>`
          : `<span class="rr-loot-i rr-loot-noimg">${lootDropLabel(l)}</span>`
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

  /** Explain a settlement that does not match the fight the player just watched. The
   *  reward rows are already zero when this fires (the server's stored result is the
   *  truth about what was PAID), and a silent zero on a won invasion is exactly how this
   *  went unreported for days. No-op if the panel is gone. */
  setRaidResultNotice(message: string) {
    const body = this.el.querySelector(".raid-res-panel .rr-body");
    if (!body || body.querySelector(".rr-notice")) return;
    const notice = document.createElement("div");
    notice.className = "rr-notice";
    notice.textContent = message;
    body.appendChild(notice);
  }

  /** Patch the server-authoritative brain award into an already-open victory panel. */
  setRaidResultBrains(brains: number) {
    const panel = this.el.querySelector(".raid-res-panel");
    if (!panel) return;
    const brainRow = panel.querySelectorAll(".rr-row")[3]?.querySelector(".rr-v");
    if (brainRow) {
      brainRow.innerHTML =
        `${brains}<img class="rr-i" src="${UI("topbar_brain_icon.png")}">`;
    }
  }

  /** Celebratory "LEVEL UP" popup listing what the new level unlocked (invasions,
   *  market items, boosts). Fired from GameState.onLevelUpCb via main.ts.
   *  `onClose` fires when the celebration is dismissed (see renderLevelUp). */
  openLevelUp(view: LevelUpView, onClose?: () => void) {
    renderLevelUp(this.el, view, onClose);
  }

  /** Celebratory "QUEST COMPLETE" popup showing the finished quest + its reward,
   *  styled like the level-up popup. Fired from the QuestSystem via main.ts. Only
   *  one shows at a time; a queued list (main.ts) feeds them in one after another. */
  openQuestComplete(view: QuestCompleteView) {
    renderQuestComplete(this.el, view, () => this.onQuestCompleteClosed?.());
  }

  /** Called when a quest-complete popup is dismissed, so main can show the next
   *  queued one (quests can complete in bursts — e.g. several on a raid return). */
  onQuestCompleteClosed: (() => void) | null = null;

  // A compact Move / Store / Sell action popup for a placed farm object, shown
  // when it's tapped in Select mode.
  openObjectActions(o: ObjectActions) {
    renderObjectActions(this.el, o);
  }

  private openPanel(title: string, body: string) {
    renderInfoPanel(this.el, title, body);
  }

  private buildInvadeShortcut() {
    const btn = document.createElement("button");
    btn.className = "invade-shortcut";
    const img = document.createElement("img");
    img.src = UI("button_invade.png");
    const label = document.createElement("span");
    label.className = "invade-label";
    label.textContent = "Invade";
    const timer = document.createElement("span");
    timer.className = "invade-timer";
    const refresh = () => {
      const ms = this.getRaidStatus?.().cooldownMs ?? 0;
      timer.hidden = ms <= 0;
      timer.textContent = ms > 0 ? fmtCooldown(ms) : "";
      btn.title = btn.dataset.bossTitle
        ?? (ms > 0 ? `Next invasion in ${fmtCooldown(ms)} (I)` : "Invade now (I)");
    };
    refresh();
    window.setInterval(refresh, 1000);
    btn.append(timer, img, label);
    btn.onclick = () => this.openRaids();
    this.el.appendChild(btn);
  }

  private buildCropHover() {
    this.cropHover = document.createElement("div");
    this.cropHover.className = "crop-hover";
    this.el.appendChild(this.cropHover);
  }

  showCropHover(
    info: { name: string; ripe: boolean; remainingMs: number; fertilized: boolean } | null,
    x = 0, y = 0,
  ) {
    if (!info) {
      this.cropHoverInfo = null;
      this.cropHover.style.display = "none";
      return;
    }
    this.cropHoverInfo = info;
    this.cropHoverShownAt = Date.now();
    this.cropHoverX = x;
    this.cropHoverY = y;
    this.renderCropHover();
  }

  private renderCropHover() {
    const info = this.cropHoverInfo;
    if (!info) return;
    const remainingMs = Math.max(0, info.remainingMs - (Date.now() - this.cropHoverShownAt));
    const ripe = info.ripe || remainingMs <= 0;
    const time = ripe ? "Ready to harvest" : `Time remaining: ${fmtCooldown(remainingMs)}`;
    this.cropHover.replaceChildren();
    const name = document.createElement("strong");
    name.textContent = info.name;
    const remaining = document.createElement("span");
    remaining.textContent = time;
    this.cropHover.append(name, remaining);
    if (info.fertilized) {
      const fertilized = document.createElement("span");
      fertilized.className = "fertilized";
      fertilized.textContent = "🍃 Fertilized";
      this.cropHover.append(fertilized);
    }
    this.cropHover.style.left = `${Math.min(window.innerWidth - 170, this.cropHoverX + 16)}px`;
    this.cropHover.style.top = `${Math.min(window.innerHeight - 92, this.cropHoverY + 16)}px`;
    this.cropHover.style.display = "flex";
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
    const levelXp = this.state.levelXp;
    const xpText = levelXp
      ? `${levelXp.current.toLocaleString()} / ${levelXp.required.toLocaleString()} XP`
      : "Max level";
    this.xpDetails.textContent = xpText;
    this.levelChip.setAttribute("aria-label", `Level ${this.state.level}: ${xpText}`);
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
