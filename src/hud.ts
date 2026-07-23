// DOM overlay HUD laid out like the iPad game: settings gear + currency bar +
// player name across the top, an ACTIVE-QUESTS column on the left (toggled by the
// bottom-left button), menu buttons on the right, and a farming-tool bar at the
// bottom-center. Resize-safe (fixed positioning).
import { GameState } from "./GameState";
import { CropConfig } from "./Field";
import { zombieSellValue } from "./economy";
import { PlaceableDef, BoostDef, FarmSizeUpgrade, ClimateUpgrade, upgradeIcon, placeablePurchaseLimit } from "./assets";
import type { FarmerBodyDef, FarmerCatalog, FarmerHeadDef, PetCatalog, PetDef } from "./assets";
import { EPIC_BOSS_FIGHT_BRAIN_COST, type EpicBossPayment } from "./epicBoss/tokens";
import { AudioManager } from "./audio";
import { MAX_ZOMBIE_NAME_LENGTH, RosterEntry } from "./zombie/types";
import { ALL_BITS, MUTATIONS, mutationLabel, mutationBonus } from "./zombie/mutations";
import { QuestView } from "./quest/types";
import type { RaidCardView, RaidPartyView, RaidResultView, RaidLaunchOpts, LootDrop } from "./raid/RaidManager";
import type { ProfileIndex } from "./save/profiles";
import { canGiftBrain, type Friend } from "./social/friends";
import { isMobile } from "./platform";
import { type FarmBackground } from "./prefs";
import { fmtCooldown, MCDONNELL_ID, VOUCHER_KEY } from "./raid/RaidCatalog";
import { marketPageSize } from "./marketPageSize";
import { STATS, veterancy, veterancyMultiplier, STAT_TILE, VALUE_FILL, VALUE_END, ABILITY_FRAME,
  ABILITY_POOL, unitAbilityAt, TIER_BOSS, MAX_ABILITY_TIER } from "./zombie/traits";
import { statBreakdown } from "./zombie/statDisplay";
import { classTierRank } from "./zombie/taxonomy";
import { BASE } from "./base";
import { compareCropMarketOrder } from "./marketOrder";
import { fillPartySelection, orderPartyRoster } from "./raid/partySelection";
import type {
  BlackMarketListResponse, BlackMarketMutationResponse, BlackMarketOrderKind,
  BlackMarketOrderView,
} from "./net/protocol";
import {
  blackMarketMutationRequirementLabel,
  blackMarketPurchaseLock,
  matchesBlackMarketMutation,
} from "./blackMarketRules";
// HUD styles live in a real stylesheet (src/ui/hud.css) so they get CSS tooling
// and hot-reload. Vite injects it at module load — no manual <style> element.
import "./ui/hud.css";
import { openModal } from "./ui/Modal";
import { renderLevelUp, renderQuestComplete, renderObjectActions, renderInfoPanel } from "./ui/panels/dialogs";
import {
  openSettings as openSettingsPanel, openDevMenu as openDevMenuPanel,
  buildAccountBlock, buildDevicesBlock,
} from "./ui/panels/settings";
import { openStorage as openStoragePanel } from "./ui/panels/storage";
// View-model types + the grave classifier live in hudTypes so panel modules can
// import them without depending on the whole Hud class. Re-exported below for the
// existing `from "./hud"` importers (main.ts).
import type {
  Mode, ObjCard, MenuCard, EpicBossMarketView, ZombieInfo, ObjectActions,
  LevelUpView, QuestCompleteView, ReceivedView,
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
  sell?: number; // harvest value (plants only)
  timeLabel?: string; // catalog grow time (crop/zombie cards)
  graveNeeded?: "Blue" | "Red" | "Silver"; // locked until this colored grave is owned
  ownedLimit?: boolean; // "1 per farm" limit reached (gift vouchers) — can't buy
  owned?: boolean;
  equipped?: boolean;
  description?: string; // "what does it do" blurb shown by the card's magnifier
  tint?: [number, number, number]; // multiplicative object tint from Market data
  onPick: () => void;
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
    return "A home for up to four cosmetic pets. Tap the Pet Pen on your farm to choose its occupants.";
  if (def.category !== "functional") return undefined;
  if (def.armyMax)
    return `Raises your zombie army limit by ${def.armyMax}, so you can send more zombies on each invasion.`;
  if (def.plowFree) return "Plowing soil costs no gold while this stands on your farm.";
  if (def.fastWork)
    return "Farming is instant — plow, plant, water and harvest finish with no waiting.";
  if (def.mutantMonolith)
    return "Nearby mutation crops always mutate harvested zombies. Mutant zombies also grow in half the time.";
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

const UI = (n: string) => `${BASE}assets/ui/${n}`;



export class Hud {
  mode: Mode = "walk";
  onModeChange: (() => void) | null = null;
  // Rotate tool tap: main handles it contextually (flip the placement ghost / the
  // carried object / enter the standalone rotate mode). Null falls back to setMode.
  onRotateTool: (() => void) | null = null;
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
  private nameEl!: HTMLElement;
  private questCol!: HTMLElement;
  private questViews: QuestView[] = [];
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
  private temporaryPanMode: Mode | null = null;
  onTemporaryPanChange: (() => void) | null = null;

  get planting(): CropConfig | null {
    return this.plantingCrop;
  }
  get placing(): PlaceableDef | null {
    return this.placingObj;
  }

  constructor(readonly state: GameState, readonly audio: AudioManager) {
    // Styles are injected by the `import "./ui/hud.css"` at the top of this module.
    this.el = document.getElementById("hud")!;
    this.el.innerHTML = "";
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
  // closes the top overlay or cancels the active tool. Holding Space temporarily
  // borrows Select/pan without discarding a crop, placement, or carried object.
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
  }

  // Full quest screen: every active quest as a card with its objectives, scrollable.
  private openQuestLog() {
    const { panel } = openModal({
      host: this.el, panelClass: "questlog", title: `Quests (${this.questViews.length})`,
    });
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
    panel.append(list);
  }

  // A quest's detail popup: title, tip, and each objective with its live count.
  private openQuestDetail(q: QuestView) {
    const { panel } = openModal({ host: this.el, panelClass: "qdetail", title: q.title });
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

  // Each button is a colored frame around a grey glossy button (dark label).
  private buildMenu() {
    const items = [
      { label: "Zombies", fill: "#55972a", light: "#79c247", dark: "#2f5f10", shortcut: "Z" },
      { label: "Boosts", fill: "#7a4bc9", light: "#9c74e0", dark: "#432379", shortcut: "B" },
      { label: "Storage", fill: "#2f74bb", light: "#4f9bd8", dark: "#143f66", shortcut: "R" },
      { label: "Market", fill: "#c9992e", light: "#e3bb52", dark: "#8a6512", shortcut: "M" },
      { label: "Social", fill: "#2f9c8a", light: "#4fd0b8", dark: "#12564b", shortcut: "" },
    ];
    const col = document.createElement("div");
    col.className = "menucol";
    this.menuCol = col;
    for (const m of items) {
      const btn = document.createElement("button");
      btn.className = "mbtn";
      btn.dataset.menu = m.label; // stable anchor for the tutorial arrow (menuButton())
      btn.title = m.shortcut ? `${m.label} (${m.shortcut})` : m.label;
      btn.style.background = `linear-gradient(${m.light}, ${m.fill})`;
      btn.style.borderColor = m.dark;
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
                  : m.label === "Social"
                    ? this.openSocial()
                    : this.openPanel(m.label, "Coming soon.");
      col.appendChild(btn);
    }
    this.el.appendChild(col);
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
      accept.onclick = () => { finish(true); close(); };
      buttons.append(cancel, accept);
      panel.append(copy, buttons);
    });
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
  collapse() {
    if (this.collapsed) return;
    this.collapsed = true;
    this.menuCol.style.display = "none";
    this.toolsBar.style.display = "none";
    this.fabImg.src = this.fabIconSrc();
    this.refreshBoostBadge(); // sync the fab's uses badge for the current mode
    this.fab.style.display = "block";
    this.refreshTouchCancel();
  }

  expand() {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.menuCol.style.display = "flex";
    this.toolsBar.style.display = "flex";
    this.fab.style.display = "none";
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
    // Permanent crops form the first unlock ladder; holiday crops form a second
    // ladder at the end. Stable ties retain authored order.
    this.plantCards = [...plants].sort(compareCropMarketOrder);
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
  /** Whether the total owned count (placed + stored) reached this item's limit. */
  objectLimitReached: ((def: PlaceableDef) => boolean) | null = null;
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
  /** Render one owned zombie with its complete individual mutation mask. */
  zombieMutationPortraitOf: ((key: string, mutation: number, color?: [number, number, number]) => Promise<string>) | null = null;
  /** Take a deployed zombie off the farm (into the Mausoleum). */
  onZombieStore: ((id: string) => void | Promise<void>) | null = null;
  /** Change an owned zombie's individual display name. */
  onZombieRename: ((id: string, name: string) => string | null) | null = null;
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
  getBlackMarketOrders: ((query: {
    kind: BlackMarketOrderKind; zombieKey?: string; mutated?: boolean;
    sort?: "newest" | "price_asc" | "price_desc"; mine?: boolean;
  }) => Promise<BlackMarketListResponse>) | null = null;
  onCreateBlackMarketOrder: ((input:
    | { kind: "SELL_ZOMBIE"; unitId: string; priceBrains: number }
    | { kind: "BUY_ZOMBIE"; zombieKey: string; mutated: boolean; mutationRequired?: number; priceBrains: number }
  ) => Promise<BlackMarketMutationResponse>) | null = null;
  onCancelBlackMarketOrder: ((orderId: string) => Promise<BlackMarketMutationResponse>) | null = null;
  onFulfillBlackMarketOrder: ((order: BlackMarketOrderView, unitId?: string) => Promise<BlackMarketMutationResponse>) | null = null;
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
        canCollect: boolean;
        pending: {
          keyA: string; keyB: string; maskA: number; maskB: number;
          colorA?: [number, number, number]; colorB?: [number, number, number];
        } | null;
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
  /** Claim a gift (credits a brain server-side). Returns whether it was credited. */
  onClaimGift: ((id: string) => Promise<true | string>) | null = null;
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
    if (!on) this.setTutorialMenuTarget(null);
  }
  /** Select the sole menu control allowed by the current tutorial beat. Invade
   *  intentionally uses the always-visible bottom-left shortcut. */
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

  openMarket(initialTab: string = "Crops") {
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
          timeLabel: c.timeLabel,
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Crops" && sub === "Zombies")
        return this.zombieCards.map((c) => ({
          name: c.name, portrait: c.portrait, cost: c.cost, level: c.level, brains: c.brains,
          timeLabel: c.timeLabel,
          graveNeeded: c.cfg.unlockGrave,
          description: c.description,
          onPick: () => { this.setPlanting(c.cfg); bg.remove(); },
        }));
      if (tab === "Items") {
        let cards = this.objectCards.filter((c) => c.category === ITEM_CAT[sub]);
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
          const others = cards.filter((c) => !c.def.storageSlots);
          const next = sheds
            .filter((c) => (c.def.storageSlots ?? 0) > cur)
            .sort((a, b) => (a.def.storageSlots ?? 0) - (b.def.storageSlots ?? 0))[0];
          cards = next ? [next, ...others] : others;
        }
        return cards.map((c) => {
          // The Zombie Pot flips to a flat 3 brains once the player has owned one
          // (see GameState.zombiePotBought); the market price must mirror the charge.
          const potPriced = !!c.def.zombiePot && this.state.zombiePotBought;
          return {
            name: c.name, portrait: c.portrait,
            cost: potPriced ? 3 : c.cost, level: c.level,
            brains: potPriced ? true : c.brainsNeeded,
            description: functionalDescription(c.def), tint: c.def.color,
            onPick: () => { if (this.onBuy) this.onBuy(c.def); bg.remove(); },
          };
        });
      }
      if (tab === "Boosts") {
        // Buying stays in the panel (buy several); the count owned shows in the name.
        return this.boosts.filter((b) => !tutorialBoostMarket || b.key === "insta_grow").map((b) => {
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
      return marketPageSize({
        mobile: isMobile(), columns: cols, rowHeight: rowH, gap, availableHeight: avail,
      });
    };

    const renderGrid = () => {
      grid.innerHTML = "";
      grid.scrollTop = 0;
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
    if (tutorialBoostMarket) {
      tabsEl.style.display = "none";
      subsEl.style.display = "none";
    }
    bg.appendChild(mkt);
    if (!tutorialBoostMarket) bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
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
    const party = this.getRaidParty?.();
    const { panel, close } = openModal({
      host: this.el, bgClass: "army-bg", replaceSelector: ".army-bg", backdropClose: false,
    });
    if (!party?.eligible.length) { panel.insertAdjacentHTML("beforeend", `<h2>Choose your army</h2><p>You have no deployed zombies.</p>`); return; }
    const order: string[] = [];
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
      head.innerHTML = `<h2>Send your army — ${bossName}</h2><span class="army-count">${order.length}/${party.cap} · min 1</span>`;
      start.textContent = order.length ? `Fight with ${order.length}` : "Choose a zombie";
      start.disabled = !order.length || !canPay;
      cards.querySelectorAll<HTMLElement>(".army-card").forEach((el) => { const at = order.indexOf(el.dataset.id!); el.classList.toggle("sel", at >= 0); const tick = el.querySelector<HTMLElement>(".tick"); if (tick) tick.textContent = at >= 0 ? String(at + 1) : ""; });
    };
    for (const z of eligible) {
      const card = document.createElement("div"); card.className = "army-card"; card.dataset.id = z.id;
      const tick = document.createElement("span"); tick.className = "tick";
      const portrait = document.createElement("div"); portrait.className = "army-por";
      if (z.portrait) portrait.style.backgroundImage = `url(${z.portrait})`;
      if (this.zombieMutationPortraitOf) {
        void this.zombieMutationPortraitOf(z.key, z.mutation, z.color)
          .then((image) => { if (portrait.isConnected) portrait.style.backgroundImage = `url(${image})`; })
          .catch(() => { /* retain the static species portrait */ });
      }
      const name = document.createElement("div"); name.className = "army-nm"; name.textContent = z.name;
      const type = document.createElement("div"); type.className = "army-ty"; type.textContent = z.typeName;
      card.append(tick, portrait, name, type);
      card.onclick = () => { const at = order.indexOf(z.id); if (at >= 0) order.splice(at, 1); else if (order.length < party.cap) order.push(z.id); refresh(); };
      cards.appendChild(card);
    }
    const pick = document.createElement("button"); pick.className = "raid-quick"; pick.textContent = "Pick for me";
    pay.onchange = () => { payment = pay.value as EpicBossPayment; refresh(); };
    pick.onclick = () => {
      order.splice(0, order.length, ...fillPartySelection(
        order, preferred, eligible.map((z) => z.id), party.cap
      ));
      refresh();
    };
    start.onclick = async () => {
      if (!order.length || !this.onLaunchEpicBoss) return;
      start.disabled = true;
      if (await this.onLaunchEpicBoss([...order], payment)) {
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
  // Storage panel (Items/Pets/Boosts/Received) lives in ui/panels/storage.ts.
  openStorage(initialTab: string = "Items", managePen = false) {
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
    card.className = `${locked ? "pm-card locked" : "pm-card"}${c.cfg.isZombie ? " zombie" : ""}`;

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
    const { panel } = openModal({
      host: this.el, bgClass: "prof-bg", panelClass: "profiles",
      title: "Account", replaceSelector: ".prof-bg",
    });

    const acctBlock = buildAccountBlock(this);
    if (acctBlock) {
      panel.append(acctBlock);
      const devices = buildDevicesBlock(this);
      if (devices) panel.append(devices);
    } else {
      // Offline build or signed out: nothing to manage here.
      const note = document.createElement("div");
      note.className = "fr-empty";
      note.textContent = "Playing offline.";
      panel.append(note);
    }
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
    const friends = document.createElement("button");
    friends.className = "social-choice";
    friends.append("Friends");
    const friendsNote = document.createElement("span");
    friendsNote.textContent = "Connect, gift brains, and visit farms";
    friends.appendChild(friendsNote);
    friends.onclick = () => { close(); this.openFriends(); };
    const market = document.createElement("button");
    market.className = "social-choice";
    market.append("Black Market");
    const marketNote = document.createElement("span");
    marketNote.textContent = "Post zombie sales and requests";
    market.appendChild(marketNote);
    market.onclick = () => { close(); this.openBlackMarket(); };
    choices.append(friends, market);
    panel.append(choices);
  }

  private openBlackMarket(initialKind: BlackMarketOrderKind = "BUY_ZOMBIE") {
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
    const refreshBalance = () => {
      balance.innerHTML = `<span><img src="${UI("topbar_brain_icon.png")}">${this.state.brains}</span>`;
    };
    refreshBalance();

    const tabs = document.createElement("div");
    tabs.className = "mkt-tabs";
    const requestTab = document.createElement("button");
    const salesTab = document.createElement("button");
    requestTab.className = salesTab.className = "mkt-tab";
    requestTab.textContent = "Requests";
    salesTab.textContent = "Zombie Sales";
    tabs.append(requestTab, salesTab);

    const toolbar = document.createElement("div");
    toolbar.className = "bm-toolbar";
    const typeFilter = document.createElement("select");
    typeFilter.setAttribute("aria-label", "Zombie type filter");
    typeFilter.append(new Option("All zombie types", ""));
    const catalog = [...new Map(this.blackMarketZombieCards.map((card) => [card.cfg.key, card])).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const card of catalog) typeFilter.append(new Option(card.name, card.cfg.key));
    const mutationFilter = document.createElement("select");
    mutationFilter.setAttribute("aria-label", "Mutation filter");
    mutationFilter.append(new Option("Any mutations", ""), new Option("Mutated: Yes", "true"),
      new Option("Mutated: No", "false"));
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
    toolbar.append(typeFilter, mutationFilter, sort, mineLabel, refresh);

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
    const mutationChecks = ALL_BITS.map((bit) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(bit);
      label.append(input, MUTATIONS[bit].name);
      mutationChoices.appendChild(label);
      return input;
    });
    mutationLabelEl.append(mutationMode, mutationChoices);
    const priceLabel = document.createElement("label");
    priceLabel.append("Price in brains");
    const price = document.createElement("input");
    price.type = "number"; price.min = "1"; price.max = "1000000"; price.step = "1";
    priceLabel.appendChild(price);
    const escrowNote = document.createElement("div");
    escrowNote.className = "bm-meta";
    const submit = document.createElement("button");
    submit.textContent = "Post Request";
    compose.append(composeTitle, composeKind, assetLabel, mutationLabelEl, priceLabel, escrowNote, submit);
    content.append(list, compose);

    let kind = initialKind;
    let renderGeneration = 0;
    const cardFor = (key: string) => catalog.find((entry) => entry.cfg.key === key);
    const purchaseLockFor = (key: string) => {
      const card = cardFor(key);
      if (!card) return null;
      return blackMarketPurchaseLock(
        { category: card.category, unlockGrave: card.cfg.unlockGrave },
        this.state.level,
        (grave) => this.hasGrave?.(grave) ?? false
      );
    };
    const selectedMutationMask = () => mutationChecks.reduce(
      (mask, input) => input.checked ? mask | Number(input.value) : mask,
      0
    );
    const refreshComposeStatus = () => {
      const selling = composeKind.value === "SELL_ZOMBIE";
      const purchaseLock = selling ? null : purchaseLockFor(asset.value);
      const missingMutation = !selling && mutationMode.value === "specific" &&
        selectedMutationMask() === 0;
      mutationChoices.hidden = selling || mutationMode.value !== "specific";
      escrowNote.textContent = selling
        ? "This zombie leaves your roster while the post is open."
        : purchaseLock?.label ??
          (missingMutation
            ? "Select at least one specific mutation."
            : mutationMode.value === "specific"
              ? "Same-slot choices are alternatives; choices in different slots are all required."
              : "The full brain offer is removed while the request is open.");
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
      mutationLabelEl.style.display = selling ? "none" : "flex";
      submit.textContent = selling ? "Post Zombie Sale" : "Post Request";
      refreshComposeStatus();
    };

    const setTabs = () => {
      requestTab.classList.toggle("sel", kind === "BUY_ZOMBIE");
      salesTab.classList.toggle("sel", kind === "SELL_ZOMBIE");
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
          kind, zombieKey: typeFilter.value || undefined,
          mutated: mutationFilter.value ? mutationFilter.value === "true" : undefined,
          sort: sort.value as "newest" | "price_asc" | "price_desc", mine: mine.checked,
        });
        if (generation !== renderGeneration || !bg.isConnected) return;
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
          const body = document.createElement("div");
          const name = document.createElement("div"); name.className = "bm-name";
          name.textContent = cardFor(order.zombieKey)?.name ?? order.zombieKey;
          const meta = document.createElement("div"); meta.className = "bm-meta";
          const mutationText = order.kind === "BUY_ZOMBIE"
            ? order.mutationRequired
              ? `Requested mutations: ${blackMarketMutationRequirementLabel(order.mutationRequired)}`
              : `Requested mutation: ${order.mutated ? "Any mutation" : "None"}`
            : `Mutated: ${order.mutated
              ? `Yes${order.mutation ? ` — ${mutationLabel(order.mutation)}` : ""}`
              : "No"}${order.invasions ? ` · ${veterancy(order.invasions)}` : ""}`;
          meta.textContent = `${mutationText}\n${order.mine ? "Your post" : order.creatorName}`;
          const cost = document.createElement("div"); cost.className = "bm-price";
          cost.append(String(order.priceBrains));
          const brain = document.createElement("img"); brain.src = UI("topbar_brain_icon.png"); cost.appendChild(brain);
          body.append(name, meta, cost); marketCard.append(portrait, body);
          const action = document.createElement("button");
          if (order.mine) {
            action.className = "cancel"; action.textContent = "Cancel Post";
            action.onclick = async () => {
              if (!await this.confirmInGame("Cancel this post?", "The escrowed zombie or brains will be returned.", "Cancel Post")) return;
              action.disabled = true;
              try { await this.onCancelBlackMarketOrder?.(order.id); refreshBalance(); await renderOrders(); }
              catch { this.showToast("Could not cancel that post. Refresh and try again."); action.disabled = false; }
            };
          } else {
            action.textContent = order.kind === "SELL_ZOMBIE" ? "Buy Zombie" : "Sell Matching Zombie";
            const purchaseLock = order.kind === "SELL_ZOMBIE" ? purchaseLockFor(order.zombieKey) : null;
            if (purchaseLock) {
              marketCard.classList.add("locked");
              const lockNote = document.createElement("div");
              lockNote.className = "bm-lock";
              lockNote.textContent = purchaseLock.label;
              body.appendChild(lockNote);
              action.textContent = purchaseLock.label;
              action.disabled = true;
            }
            action.onclick = async () => {
              if (purchaseLock) { this.showToast(purchaseLock.label); return; }
              let unitId: string | undefined;
              let detail = `Spend ${order.priceBrains} brains for this zombie?`;
              if (order.kind === "BUY_ZOMBIE") {
                const match = (this.getRoster?.() ?? []).find((zombie) => zombie.key === order.zombieKey &&
                  matchesBlackMarketMutation(zombie.mutation, order.mutated, order.mutationRequired));
                if (!match) { this.showToast("You do not own a matching available zombie."); return; }
                unitId = match.id; detail = `Trade ${match.name} for ${order.priceBrains} brains?`;
              }
              if (!await this.confirmInGame("Complete this trade?", detail, "Trade")) return;
              action.disabled = true;
              try { await this.onFulfillBlackMarketOrder?.(order, unitId); refreshBalance(); await renderOrders(); }
              catch (error) {
                const code = error instanceof Error ? error.message : "";
                if (code.startsWith("insufficient_brains"))
                  this.showToast(`You need ${order.priceBrains} brains to buy this zombie.`);
                else if (code.startsWith("black_market_level_locked"))
                  this.showToast("Special zombies can be purchased at level 20.");
                else if (code.startsWith("black_market_grave_required"))
                  this.showToast("Place this zombie's required gravestone on your farm first.");
                else if (code.startsWith("counterparty_busy"))
                  this.showToast("The seller is syncing. Try the trade again in a moment.");
                else this.showToast("That trade is no longer available. Market refreshed.");
                await renderOrders();
              }
            };
          }
          marketCard.appendChild(action); list.appendChild(marketCard);
        }
      } catch {
        if (generation === renderGeneration) list.innerHTML = `<div class="bm-empty">Black Market is unavailable right now.</div>`;
      }
    };

    requestTab.onclick = () => { kind = "BUY_ZOMBIE"; setTabs(); void renderOrders(); };
    salesTab.onclick = () => { kind = "SELL_ZOMBIE"; setTabs(); void renderOrders(); };
    for (const control of [typeFilter, mutationFilter, sort, mine]) control.onchange = () => void renderOrders();
    refresh.onclick = () => void renderOrders();
    composeKind.onchange = updateCompose;
    asset.onchange = refreshComposeStatus;
    mutationMode.onchange = refreshComposeStatus;
    for (const input of mutationChecks) input.onchange = refreshComposeStatus;
    submit.onclick = async () => {
      const priceBrains = Number(price.value);
      if (!Number.isSafeInteger(priceBrains) || priceBrains < 1 || priceBrains > 1_000_000) {
        this.showToast("Enter a whole brain price between 1 and 1,000,000."); return;
      }
      const selling = composeKind.value === "SELL_ZOMBIE";
      if (!selling) {
        const purchaseLock = purchaseLockFor(asset.value);
        if (purchaseLock) { this.showToast(purchaseLock.label); return; }
      }
      const warning = selling ? "The selected zombie will be held in escrow." : `${priceBrains} brains will be held in escrow.`;
      if (!await this.confirmInGame("Create Black Market post?", warning, "Create Post")) return;
      submit.disabled = true;
      try {
        const mutationRequired = mutationMode.value === "specific"
          ? selectedMutationMask()
          : undefined;
        await this.onCreateBlackMarketOrder?.(selling
          ? { kind: "SELL_ZOMBIE", unitId: asset.value, priceBrains }
          : {
              kind: "BUY_ZOMBIE",
              zombieKey: asset.value,
              mutated: mutationMode.value !== "false",
              ...(mutationRequired ? { mutationRequired } : {}),
              priceBrains,
            });
        kind = selling ? "SELL_ZOMBIE" : "BUY_ZOMBIE";
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
        else if (code.startsWith("black_market_level_locked"))
          this.showToast("Special zombies can be purchased at level 20.");
        else if (code.startsWith("black_market_grave_required"))
          this.showToast("Place this zombie's required gravestone on your farm first.");
        else this.showToast("Could not create that post. Refresh and try again.");
      }
      finally { refreshComposeStatus(); }
    };

    setTabs(); updateCompose();
    panel.append(title, close, balance, tabs, toolbar, content);
    bg.appendChild(panel);
    this.el.appendChild(bg);
    void renderOrders();
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
        : e === "daily_gift_limit" ? "You've sent both of today's gifts."
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
          const result = await (this.onClaimGift?.(g.id) ?? Promise.resolve("Couldn't claim that gift."));
          if (result === true) {
            this.showToast(`Claimed a brain from ${g.fromName}! 🧠`);
            await refresh();
          } else {
            this.showToast(result);
            claim.disabled = false;
          }
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
              this.showToast(`Sent a brain to ${f.name}! +5 XP`);
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
    const nailL = document.createElement("span");
    nailL.className = "zcard-nail tl";
    const nailR = document.createElement("span");
    nailR.className = "zcard-nail tr";
    const board = document.createElement("div");
    board.className = "zcard-board";
    board.textContent = info.name;
    card.append(nailL, nailR, board);
    if (info.id && this.onZombieRename) {
      board.classList.add("renameable");
      board.title = "Click to rename";
      board.tabIndex = 0;
      const edit = () => {
        if (!board.isConnected) return;
        const input = document.createElement("input");
        input.className = "zcard-name-input";
        input.value = info.name;
        input.maxLength = MAX_ZOMBIE_NAME_LENGTH;
        board.replaceWith(input);
        let active = true;
        const cancel = () => {
          if (!active) return;
          active = false;
          input.replaceWith(board);
        };
        const commit = () => {
          if (!active) return;
          active = false;
          const renamed = this.onZombieRename?.(info.id!, input.value);
          if (renamed) info.name = renamed;
          board.textContent = info.name;
          input.replaceWith(board);
        };
        input.onkeydown = (event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          else if (event.key === "Escape") { event.preventDefault(); cancel(); }
        };
        input.onblur = commit;
        input.focus();
        input.select();
      };
      board.onclick = edit;
      board.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); edit(); }
      };
    }
    const port = document.createElement("div");
    port.className = "zcard-port";
    port.style.backgroundImage = `url(${info.portrait})`;
    // Use the static catalog portrait immediately, then replace it with the cached
    // individual rig once its mutation-aware render is available.
    if (this.zombieMutationPortraitOf) {
      void this.zombieMutationPortraitOf(info.key, info.mutation, info.color)
        .then((portrait) => {
          if (port.isConnected) port.style.backgroundImage = `url(${portrait})`;
        })
        .catch(() => { /* retain the static species portrait if extraction fails */ });
    }
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
    // Each tile shows the stat's 0–100 bar with EVERY always-on bonus folded in
    // (mutation + veterancy + the zombie's own passive stat abilities); hovering opens
    // the per-modifier breakdown. See zombie/statDisplay.statBreakdown.
    const abilityUnlocked = (k: string) => this.state.abilityUnlocked(k);
    // Which stats a mutation is boosting — those tiles render green (permanent species bonus).
    const mutBonus = mutationBonus(info.mutation);
    for (const s of STATS) {
      const bd = statBreakdown(info, s.key, abilityUnlocked);
      const boosted = ((mutBonus as Record<string, number>)[s.key] ?? 0) > 0;
      const cell = document.createElement("button");
      cell.className = "zstat";
      cell.innerHTML =
        `<span class="zstat-tile" style="background-image:url(${STAT_TILE})">` +
        `<img src="${s.icon}" alt=""></span>` +
        `<span class="zstat-val${boosted ? " boosted" : ""}" style="background-image:url(${VALUE_END}),url(${VALUE_FILL})">` +
        `${bd.total}</span>`;
      cell.onclick = (e) => {
        e.stopPropagation();
        // desc, then Base → each modifier (dim if +0) → Total, as aligned rows.
        const rows = [`<span class="zbd-row"><span>Base</span><span>${bd.base}</span></span>`]
          .concat(
            bd.lines.map(
              (l) =>
                `<span class="zbd-row${l.zero ? " zbd-zero" : ""}"><span>${l.label}</span><span>${l.amount}</span></span>`
            )
          )
          .concat(`<span class="zbd-row zbd-total"><span>Total</span><span>${bd.total}</span></span>`)
          .join("");
        showTip(cell, s.label, `${s.desc}<span class="zbd">${rows}</span>`);
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
    const { panel, close } = openModal({ host: this.el, panelClass: "zpanel" });

    const wrap = this.buildZombieCard(info, panel);
    panel.append(wrap);

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
          close();
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
        close();
        this.confirmSellZombie(info, value, refresh);
      };
      btns.appendChild(sell);
      panel.append(btns);
    }
  }

  // Confirmation window for selling a zombie. Names the unit, shows the gold it
  // fetches, and warns that the sale is permanent — so a valuable zombie is not
  // sold by a single stray tap. Confirm sells; Cancel backs out to the roster.
  private confirmSellZombie(info: ZombieInfo, value: number, refresh?: () => void) {
    const { panel, close } = openModal({ host: this.el, panelClass: "confirm-panel", title: "Sell this zombie?" });

    const por = document.createElement("div");
    por.className = "obj-por";
    if (info.portrait) por.style.backgroundImage = `url(${info.portrait})`;
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.append("Sell ");
    const zombieName = document.createElement("b"); zombieName.textContent = info.name;
    const valueText = document.createElement("b"); valueText.textContent = `+${value}g`;
    msg.append(zombieName, ` (${info.typeName}) for `, valueText, "?", document.createElement("br"));
    const warning = document.createElement("span");
    warning.className = "confirm-warn";
    warning.textContent = "This is permanent — the zombie is gone for good.";
    msg.appendChild(warning);

    const btns = document.createElement("div");
    btns.className = "zbtns";
    const cancel = document.createElement("button");
    cancel.className = "zbtn locate";
    cancel.textContent = "Cancel";
    cancel.onclick = () => close();
    const confirm = document.createElement("button");
    confirm.className = "zbtn sell";
    confirm.textContent = `Sell +${value}g`;
    confirm.onclick = async () => {
      confirm.disabled = true;
      close();
      await this.onZombieSell?.(info.id!);
      refresh?.();
    };
    btns.append(cancel, confirm);

    panel.append(por, msg, btns);
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

  /** Convert a roster entry into the inspectable ZombieInfo shape. */
  private rosterInfo(z: RosterEntry): ZombieInfo {
    return {
      name: z.name, typeName: z.typeName, key: z.key, group: z.group,
      className: z.className, classColor: z.classColor,
      str: z.str * this.state.farmerZombieStrengthMult(), dex: z.dex,
      con: z.con * this.state.farmerZombieLifeMult(), focus: z.focus, mutation: z.mutation,
      invasions: z.invasions,
      portrait: this.zombiePortraitOf ? this.zombiePortraitOf(z.key) : "",
      color: z.color,
      id: z.id, stored: z.stored,
    };
  }

  // The "Zombies" tab (right bar): a scrollable list where every owned zombie is
  // represented by its full inspect card (the same one shown when tapping a zombie).
  openZombieList() {
    // position:relative host (zl-panel) for card tooltips
    const { panel } = openModal({
      host: this.el, bgClass: "zl-bg", panelClass: "zl-panel", replaceSelector: ".zl-bg",
    });

    const head = document.createElement("div");
    head.className = "zr-head";
    const list = document.createElement("div");
    list.className = "zl-list";
    panel.append(head, list);

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
    const { panel } = openModal({ host: this.el, bgClass: "zr-bg", replaceSelector: ".zr-bg" });

    const wrap = document.createElement("div");
    wrap.className = "zroster";
    const head = document.createElement("div");
    head.className = "zr-head";
    const grid = document.createElement("div");
    grid.className = "zr-grid";
    wrap.append(head, grid);
    panel.append(wrap);

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
        this.buildRosterCard(z, async () => {
          await this.onZombieStore?.(z.id);
          close();
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
    const showPortrait = (
      el: HTMLElement,
      key: string,
      mutation: number,
      color?: [number, number, number],
    ) => {
      const fallback = portraitOf(key);
      if (fallback) el.style.backgroundImage = `url(${fallback})`;
      if (!this.zombieMutationPortraitOf) return;
      void this.zombieMutationPortraitOf(key, mutation, color)
        .then((portrait) => {
          if (el.isConnected) el.style.backgroundImage = `url(${portrait})`;
        })
        .catch(() => { /* retain the static species portrait */ });
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
      const parent = (key: string, mask: number, color?: [number, number, number]) => {
        const d = document.createElement("div");
        d.className = "cmb-slot filled";
        const p = document.createElement("div");
        p.className = "cmb-por";
        showPortrait(p, key, mask, color);
        const mut = document.createElement("div");
        mut.className = "cmb-sm";
        mut.textContent = mutationLabel(mask) || "no mutations";
        d.append(p, mut);
        return d;
      };
      const plus = document.createElement("div");
      plus.className = "cmb-plus";
      plus.textContent = "+";
      slots.append(parent(st.pending!.keyA, st.pending!.maskA, st.pending!.colorA), plus,
        parent(st.pending!.keyB, st.pending!.maskB, st.pending!.colorB));

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
        if (s.ready && !s.canCollect) note.textContent = "Farm full — free a zombie slot to collect.";
        go.disabled = !s.ready || !s.canCollect;
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
          showPortrait(p, z.key, z.mutation, z.color);
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
          showPortrait(p, z.key, z.mutation, z.color);
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

  // Raid select: a list of invasions (left) + the selected raid's detail (right).
  // Only playable + level-met raids can be invaded; the rest show as locked cards
  // so the ladder reads as a real (mostly future) catalog.
  openRaids() {
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
    if (!tutorialRaid) bg.onclick = (e) => { if (e.target === bg) close(); };
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
    if (!tutorialRaid) bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
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
      if (this.zombieMutationPortraitOf) {
        void this.zombieMutationPortraitOf(z.key, z.mutation, z.color)
          .then((image) => { if (por.isConnected) por.style.backgroundImage = `url(${image})`; })
          .catch(() => { /* retain the static species portrait */ });
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
      order.splice(0, order.length, ...fillPartySelection(
        order, party.orderedSelectedIds, party.eligible.map((z) => z.id), cap,
      ));
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
   *  market items, boosts). Fired from GameState.onLevelUpCb via main.ts. */
  openLevelUp(view: LevelUpView) {
    renderLevelUp(this.el, view);
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
      this.cropHover.style.display = "none";
      return;
    }
    const time = info.ripe ? "Ready to harvest" : `Time remaining: ${fmtCooldown(info.remainingMs)}`;
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
    this.cropHover.style.left = `${Math.min(window.innerWidth - 170, x + 16)}px`;
    this.cropHover.style.top = `${Math.min(window.innerHeight - 92, y + 16)}px`;
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
