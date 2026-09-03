import { Application, Assets, Container, FederatedPointerEvent, Graphics, Point, Sprite, Text, TextStyle, Texture, TilingSprite } from "pixi.js";
import { choosePlowOrigin } from "./plowSelection";
// Patch Pixi's renderer to use no-eval polyfills for its shader/UBO/uniform/particle
// codegen (it otherwise uses `new Function`, which the production CSP's script-src
// blocks — no 'unsafe-eval'). Side-effect import; must run before `new Application()`.
// pixi.js lists ./lib/unsafe-eval/init.* under "sideEffects", so it survives bundling.
import "pixi.js/unsafe-eval";
import { loadAssets, canMirrorObject, turnCount, turnFlip, ensureBackgroundTexture, ensureObjectTexture, ensureObjectTextures, objectAnimFiles, objectSpriteFiles, PlaceableDef, BoostDef, SEED_FILE, ZombieDef, zombiePortrait, ZOMBIE_STAGES, raidRewardImage, purchasableZombies, placeablePurchaseLimit, objectTint } from "./assets";
import { pickPiece, type PathSpec, type RoadSpec, type SceneryPiece, type SkylineSpec, type SpringSpec, surroundingsTheme, themeObjectFiles } from "./surroundings";
import { MAX_ZOMBIE_POTS, noRoomForAnother } from "./placementLimit";
import { armingSurvives } from "./placementArming";
import { armyCapacityOf, BASE_ARMY_MAX } from "./armyCapacity";
import { shedCapacityOf } from "./shedCapacity";
import { Field, CARROT, CropConfig, objectFootprint, PLOT, savedTurn } from "./Field";
import { Actor } from "./Actor";
import { PetActor } from "./PetActor";
import { SPEED_PX, WalkController } from "./WalkController";
import { ZombieField } from "./zombie/ZombieField";
import { makeOwned, type OwnedZombie } from "./zombie/types";
import { encodeReceivedZombie, parseReceivedZombie } from "./zombie/receivedReward";
import { almanacEntries, isEpicZombie, obtainHint } from "./zombie/almanac";
import { buildStatsView } from "./statsView";
import { mutationAlmanacEntries } from "./zombie/mutationAlmanac";
import { almanacGuide } from "./zombie/almanacGuide";
import { RAID_ZOMBIE_DROPS } from "./raid/zombieDrops";
import { fallenToInfo, snapshotFallen } from "./zombie/memorial";
import { POT_DURATION_MS } from "./zombie/ZombiePot";
import { isCombinePromotion } from "./zombie/combineSpecies";
import { GameState } from "./GameState";
import { ensureLocalStoredIds, takeStoredObject } from "./storedObjectOwnership";
import { Hud, graveNeededFor, LevelUpUnlock, ReceivedView, QuestCompleteView, QuestReward, type Mode } from "./hud";
import { JobSystem } from "./JobSystem";
import { AudioManager } from "./audio";
import { SaveManager } from "./save/SaveManager";
import * as profiles from "./save/profiles";
import * as api from "./net/api";
import * as auth from "./net/auth";
import { requireAuth } from "./net/gate";
import { getVisitTarget, enterVisit, exitVisit, clearVisitTarget } from "./net/visit";
import { EconomyClient } from "./net/economy";
import { epicBossRunToClient, serverTimestampToClient } from "./net/clock";
import { QuestBus, QuestEvent } from "./quest/events";
import { objectQuestAliases } from "./quest/objectVariants";
import { QuestSystem } from "./quest/QuestSystem";
import { PeriodicQuestSystem } from "./quest/periodic/PeriodicQuestSystem";
import { QuestDef, questBonusRewardInfo, questRewardInfo } from "./quest/types";
import { RaidManager, RaidResultView, type LootDrop } from "./raid/RaidManager";
import { LaunchGate } from "./raid/launchGate";
import { RaidScene } from "./raid/RaidScene";
import { RAID_COOLDOWN_MS, MCDONNELL_ID } from "./raid/RaidCatalog";
import { PVP_ARMY_SIZE, PVP_UI_ENABLED, buildPvpRaidDef } from "./raid/pvp";
import { reconcilePartySelection } from "./raid/partySelection";
import { planTeamAssembly, sanitizeTeams, settleTeamMembers } from "./zombie/teams";
import { postRaidWinQuests } from "./raid/questEvents";
import { invasionSettlementNotice } from "./raid/settlementNotice";
import {
  invasionExpiryMessage,
  invasionExpiryState,
  type InvasionExpiryState,
} from "./raid/sessionExpiry";
import { gridToScreen, screenToGrid, tileCenter, TILE_H, TILE_W, HW, HH } from "./iso";
import { setFootprint } from "./depthSort";
import { NightLayer, makeLight, OBJECT_GLOWS } from "./lighting";
import { buyXp, sellBack, zombieSellValue } from "./economy";
import { awardedSellValue } from "./awardSellValue";
import { farmerHeadXp } from "./farmer";
import { purchaseXpFeedback } from "./purchaseFeedback";
import { harvestXp, plowXp } from "./farmRewards";
import {
  DEFAULT_FARM_BACKGROUND, getFarmBackground, isFarmBackground, setFarmBackground,
  FARM_BG_DENSITY, type FarmBackground, getDayNightMode, setDayNightMode,
  isLocalNight, isLocalDusk, type DayNightMode, getFarmerLantern, setFarmerLantern,
  getFarmerLanternTap, setFarmerLanternTap, getRightClickMode,
  hasSeenHazardTip, markHazardTipSeen,
  hasSeenRaidTip, markRaidTipSeen,
  zombieAppearancePrefs, setZombieBodyColorMode, setShowZombieMutations,
  setPrefStorageErrorHandler,
} from "./prefs";
import { requestPersistentStorage } from "./storagePersistence";
import { raidTip } from "./raid/raidTips";
import { BASE } from "./base";
import { TutorialController } from "./tutorial/TutorialController";
import { reconcileTutorialCompletion, TutStep, TUTORIAL_ZOMBIE_KEY } from "./tutorial/steps";
import { timUnlockNoticesFor } from "./tutorial/unlockNotices";
import { initPlatform, isMobile, isTouch } from "./platform";
import { initPwa, promptReload, checkForUpdate } from "./pwa";
import { initDiagnostics, recordDiagnostic } from "./diagnostics";
import { crumb } from "./breadcrumbs";
import { BUILD_ID } from "./version";
import {
  captureTouchPointer, gestureMoved, isDeferredTouchMode, isOutsideFarmPanGesture, isTouchPointer,
  isSelectTapGesture, isZombieHold, plotOwnsObjectTap, shouldRecoverTouchPointerUp, TOUCH_ZOMBIE_HOLD_MS,
} from "./touchInput";
import {
  appendHarvestTarget, harvestTargetKey, sampleStrokeSegment, type HarvestTarget,
} from "./harvestStroke";
import { appendInstaGrowTarget, type InstaGrowTarget } from "./instaGrowStroke";
import { appendCancelTarget, cancelTargetKey, type CancelTarget } from "./cancelStroke";
import { mutationMarketDescription } from "./zombie/statDisplay";
import {
  combineSubject, combineSubjectAliases, mutantSubjectIndex, unitQuestSubjects,
  unitSubjectAliases,
} from "./quest/mutantSubjects";
import { resolveCropMutations } from "./zombie/cropMutations";
import { MutationPortraits } from "./zombie/mutationPortrait";
import { configureMutationVisibilityScope } from "./zombie/mutationVisibility";
import {
  DR_GROUNDHOG,
  EPIC_BOSSES,
  epicBossById,
  epicBossUnlockLevel,
} from "./epicBoss/catalog";
import { EpicBossManager } from "./epicBoss/EpicBossManager";
import { buildEpicBossSetup, rollEpicBossDrops } from "./epicBoss/combat";
import { epicBossCurrencyReward, epicBrainTicketChance } from "./epicBoss/rewards";
import { BRAIN_TICKET_KEY } from "./raid/eliteInvasion";
import { epicZombieRewardNotes, visibleEpicBosses } from "./epicBoss/market";
import { dropsEpicBossToken, EPIC_BOSS_FIGHT_BRAIN_COST } from "./epicBoss/tokens";
import {
  bossForFavoriteCrop, favoriteCropOf, isFavoriteCrop, luresEpicBoss,
} from "./epicBoss/favoriteCrops";
import { epicAsset, epicLootImage, epicLootImageByName } from "./epicBoss/lootImage";
import { offerFullscreenPrompt } from "./ui/panels/fullscreenPrompt";
import { shouldAnnounceEpicBossStart, showEpicBossStart } from "./ui/panels/epicBossStart";
import {
  openToolWheel, heldObjectName, rotateRowFor,
  type ToolWheelHandle, type ToolWheelItem,
} from "./ui/toolWheel";
import {
  choosePlayMode, getPreferredPlayMode, setPreferredPlayMode, showOnlineUnavailable,
  showLocalUnavailable, usesOnlineGameplay, type PlayMode,
} from "./playMode";
import { fetchServiceStatus, isExportOnly, OPEN_STATUS } from "./net/serviceStatus";
import { showExportOnly } from "./exportOnly";

// The boot / start screen lives in index.html and paints on the first frame (no
// empty-farm flash). We report load milestones to it and, once the game is fully
// built, tell it to finish — it then shows "Click to Start" and a tap dismisses it.
const boot = (window as unknown as {
  __ZFBoot?: {
    progress(p: number): void;
    ready(onDismiss?: () => void): void;
    /** Retire the overlay because a full-screen flow other than the game takes over. */
    close(): void;
    fail(): void;
  };
}).__ZFBoot;

// Export writes the same kind of file from either farm — a plain SaveGame — and only
// Local Farm's Import reads one, so an export never travels back online. Module scope
// because the closedown export screen runs long before the Settings wiring exists.
function downloadSaveFile(raw: string, name: string): void {
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `zombie-farm-${name}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function main() {
  // Capture crashes before anything else runs, so a failure during boot (asset load,
  // save decode, mode chooser) still lands in the diagnostics buffer. Local-only.
  initDiagnostics();
  // Ask the browser to stop treating this origin as evictable. Best-effort storage is
  // swept whole-origin under pressure — Cache Storage, localStorage and IndexedDB
  // together — and this game runtime-caches tens of megabytes of artwork, which makes it
  // a strong candidate for exactly that. An online player only notices the device-local
  // half going (settings, preferences), because the farm itself comes back from the
  // server: "my settings don't save and I never cleared anything". Fire-and-forget; the
  // answer is recorded for the diagnostics report and nothing waits on it.
  void requestPersistentStorage();
  // Detect device up front so <html data-platform> is set before the HUD's CSS
  // renders (drives the compact/desktop layout; re-evaluates on resize/rotate).
  initPlatform();
  // Local Farm and Online Farm are deliberately independent save domains. Choose
  // before touching auth so Local Farm never makes account/gameplay server calls,
  // even when this browser still has a valid Online Farm session.
  //
  // Ask the server what it currently permits BEFORE offering the choice. During the
  // beta→release closedown this is what lets the chooser say "Online Farm is closed,
  // export it" instead of sending the player through a sign-in that ends in an error.
  // It fails open, so a flaky connection never fakes a closure.
  //
  // Skipped outright for a player who has already chosen Local Farm: no service mode
  // can change anything for them, and making them wait on a network round trip — or
  // on its timeout, offline — before their own device's farm opens would be a
  // regression for the one group the closedown is meant not to touch.
  const service = getPreferredPlayMode() === "local" ? OPEN_STATUS : await fetchServiceStatus();
  const playMode: PlayMode = await choosePlayMode(auth.isOnlineAvailable(), service);
  const onlineFarm = usesOnlineGameplay(playMode);
  // The trail outlives a reload (see breadcrumbs.ts), so mark where each session begins —
  // otherwise a report reads as one continuous run across the reload the player did to
  // escape whatever they are reporting.
  crumb("boot", `${playMode} ${BUILD_ID}`);
  // Quest restoration can synchronously pay an already-satisfied Local Farm quest.
  // Its reward hook reads this binding while SaveManager is still hydrating, so the
  // binding must exist before QuestSystem is constructed (and long before the online
  // client itself can be created after hydration). Keeping the declaration beside the
  // mode decision also makes the Local Farm value unambiguously null during restore.
  let economy: EconomyClient | null = null;
  // Online Farm chosen while the service is read-only: sign in and load the farm, then
  // hand it over instead of entering the game (see the export handoff below).
  const exportOnlyFarm = onlineFarm && isExportOnly(service);
  initPwa(playMode);
  if (onlineFarm) {
    await auth.refreshIfSignedIn();
    await requireAuth();
  }
  configureMutationVisibilityScope(onlineFarm
    ? `online:${api.getSession()?.accountId ?? "signed-out"}`
    : `local:${profiles.activeSaveKey()}`);
  // Remote revocation (including another device taking over) is surfaced by the
  // API auth bridge. Reloading re-enters requireAuth before any game state is built.
  auth.onAuthChange(() => {
    if (onlineFarm && !auth.isSignedIn()) location.reload();
  });
  // Read-only visit: don't claim the exclusive writer lease. Nothing will be written,
  // and taking it would show the player's other device a spurious "Farm active
  // elsewhere" takeover prompt for a session that is only here to export.
  if (onlineFarm && !exportOnlyFarm) await api.prepareWriterAccess();
  boot?.progress(0.35); // signed in — start filling the plate bar
  const app = new Application();
  await app.init({
    // Viewport filler beyond the backdrop: the grass-green of the default hills.
    // Re-set per ground skin by applySurroundings (see surroundings.ts).
    background: "#67bb4e",
    resizeTo: window,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  // The game is designed around a 60 Hz cadence; without a cap Pixi redraws the
  // whole scene at the monitor's refresh rate (165+ Hz on gaming displays), which
  // saturates the GPU and starves other applications even while the farm idles.
  app.ticker.maxFPS = 60;
  document.getElementById("app")!.appendChild(app.canvas);

  const assets = await loadAssets();
  boot?.progress(0.8); // heaviest step done — art is in
  const state = new GameState();
  let epicBoss = new EpicBossManager(DR_GROUNDHOG);
  state.seedFarmerCatalog(assets.farmer);
  const audio = new AudioManager(); // music/SFX default off (toggled in Settings)
  const hud = new Hud(state, audio, playMode);
  hud.setPlayStatus(playMode, playMode === "online" ? "reconnecting" : "synced");
  const mutationPortraits = new MutationPortraits(app.renderer, assets);
  hud.zombieMutationPortraitOf = (key, mutation, color, wanted, forceMutation) =>
    mutationPortraits.get(key, mutation, color, wanted, forceMutation);
  hud.setFarmerCatalog(assets.farmer);
  hud.setPetCatalog(assets.pets);
  // Give Android/browser Back an in-app dismissal layer. One guard entry keeps the
  // URL unchanged; if the HUD has nothing to close, the second back continues to
  // the page that preceded the game instead of trapping the player here.
  if (isMobile()) {
    const armMobileBack = () => history.pushState(
      { ...(history.state ?? {}), zfMobileBackGuard: true }, "", location.href
    );
    let leavingViaBack = false;
    armMobileBack();
    window.addEventListener("popstate", () => {
      if (leavingViaBack) return;
      if (hud.handleMobileBack()) armMobileBack();
      else {
        leavingViaBack = true;
        history.back();
      }
    });
  }

  // Build the plant/zombie picker catalog from the market data. Cards show the
  // real grow time, but actual growth is scaled down so crops finish while playing.
  const fmtTime = (ms: number) => {
    const s = ms / 1000;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };
  // Catalog: crop key -> config, shared by the picker (hud) and save/load (to
  // rebuild planted crops from their saved key). Seed it with the quick-plant CARROT.
  const catalog = new Map<string, CropConfig>();
  catalog.set(CARROT.key, CARROT);
  const plantCards = assets.plants.map((p) => {
    const cfg: CropConfig = {
      key: p.key, name: p.name, stages: [SEED_FILE, p.stage1, p.stage2],
      growMs: p.growMs, cost: p.cost, sell: p.sell, xp: p.xp,
      unlockLevel: p.level, harvestIcon: p.icon,
    };
    catalog.set(cfg.key, cfg);
    return {
      name: p.name, cost: p.cost, sell: p.sell, timeLabel: fmtTime(p.growMs),
      level: p.level, seasonal: p.seasonal,
      portrait: `${BASE}assets/crop-icons/${p.icon}`, cfg,
    };
  });
  // Zombie type catalog by key, so a harvested zombie crop can look up its full
  // def (stats + taxonomy) to spawn the matching owned unit.
  const zombieDefs = new Map<string, ZombieDef>();
  for (const z of assets.zombies) zombieDefs.set(z.key, z);
  // Mutation bit -> Market mutant species name. A zombie that grew its mutation next
  // to crops answers to the bought mutant's name for quest purposes (quest 55/56).
  const mutantSubjects = mutantSubjectIndex(assets.zombies);
  /** The extra quest subjects an owned unit's mutations make it equivalent to.
   *  Spawns hand back either the live actor or a stored record, so read whichever. */
  const unitSubjectAliasesOf = (
    unit: { getData(): { key: string; mutation: number } } | { key: string; mutation: number } | null | undefined
  ): readonly string[] => {
    if (!unit) return [];
    const data = "getData" in unit ? unit.getData() : unit;
    return unitSubjectAliases(
      zombieDefs.get(data.key)?.name ?? data.key, data.mutation ?? 0, mutantSubjects
    );
  };
  /** The Zombie Pot's "combined" subject plus every pairing the parents' mutations
   *  also stand for, so quest 56 accepts two field-mutated Regular Zombies. */
  const combinedPotSubjects = (pot: { keyA: string; keyB: string; maskA: number; maskB: number }) => {
    const subjectsOf = (key: string, mask: number) =>
      unitQuestSubjects(zombieDefs.get(key)?.name ?? "", mask, mutantSubjects).filter(Boolean);
    const a = subjectsOf(pot.keyA, pot.maskA);
    const b = subjectsOf(pot.keyB, pot.maskB);
    return { subject: combineSubject(a[0] ?? "", b[0] ?? ""), aliases: combineSubjectAliases(a, b) };
  };
  const offlineHarvestMutation = (key: string, context: { cropKeys: string[]; guaranteed: boolean }): number | undefined => {
    if (state.onFarm) return undefined; // online mutation rolls are server-owned
    const def = zombieDefs.get(key);
    if (!def) return undefined;
    return resolveCropMutations(def.mutation ?? 0, context.cropKeys, {
      guaranteed: context.guaranteed,
      headless: def.group === "Headless",
    });
  };
  const allZombieCards = assets.zombies.map((z) => {
    const cfg: CropConfig = {
      key: z.key, name: z.name,
      // Zombie crop growth: wooden cross -> hand -> clawing up -> risen (thumb up).
      stages: ZOMBIE_STAGES,
      growMs: z.growMs, cost: z.cost, brainsNeeded: z.brainsNeeded, sell: 0, xp: z.xp,
      unlockLevel: z.level, isZombie: true, isMutant: z.category === "mutant",
      unlockGrave: graveNeededFor(z.className) ?? undefined, // Blue/Red/Silver graves gate planting
    };
    catalog.set(cfg.key, cfg);
    return {
      name: z.name, cost: z.cost, brains: z.brainsNeeded, timeLabel: fmtTime(z.growMs), level: z.level,
      category: z.category,
      // Catalog stats are pre-mutation (makeOwned folds the bonus in), so this is the
      // exact displayed gain the grown unit's stat tile will show.
      description: mutationMarketDescription(z, z.mutation ?? 0),
      portrait: zombiePortrait(z.key), // per-type composited portrait
      zombie: {
        group: z.group, className: z.className, classColor: z.classColor,
        str: z.str, dex: z.dex, con: z.con, focus: z.focus, mutation: z.mutation ?? 0,
      },
      cfg,
    };
  });
  const purchasableZombieKeys = new Set(purchasableZombies(assets.zombies).map((zombie) => zombie.key));
  const zombieCards = allZombieCards.filter((card) => purchasableZombieKeys.has(card.cfg.key));
  hud.setCatalog(plantCards, zombieCards);
  hud.setBlackMarketCatalog(allZombieCards);

  // Placeable-object catalog: key -> def, for the buy menu and save/load. Apply
  // the same debug grow-scaling to fruit-tree regrow timers as crops use.
  const placeCatalog = new Map<string, PlaceableDef>();
  const placeByName = new Map<string, PlaceableDef>();
  for (const o of assets.placeables) {
    placeCatalog.set(o.key, o);
    // Loot/quest rewards are keyed by display name. A recolour family repeats a
    // name (both Fence Gate states are "Fence Gate"), so the FIRST row wins and a
    // variant never displaces the base a reward looks up.
    if (!placeByName.has(o.name)) placeByName.set(o.name, o);
  }
  // "Buy a Fence" counts the Blue Fence the player actually bought.
  const objectAliases = objectQuestAliases(assets.placeables);
  hud.setPlaceables(
    assets.placeables.map((o) => ({
      name: o.name, cost: o.cost, level: o.level, brainsNeeded: o.brainsNeeded,
      category: o.category, portrait: `${BASE}assets/objects/${o.sprite}`, def: o,
    }))
  );

  // Consumable boosts (Market Boosts tab + the boost inventory in Storage).
  const boostCatalog = new Map<string, BoostDef>();
  for (const b of assets.boosts) boostCatalog.set(b.key, b);
  hud.setBoosts(assets.boosts);

  // Level-up popup: gather everything the new level(s) opened up — invasions,
  // market items, boosts — and show the celebratory unlock screen.
  const raidImg = (f: string) => `${BASE}assets/raids/images/${f}`;
  const presentLevelUp = (from: number, to: number) => {
    const unlocks: LevelUpUnlock[] = [];
    for (const r of assets.raids) {
      if (r.unlockLevel > from && r.unlockLevel <= to) {
        const f = r.bossPortrait || r.enemyIcon;
        unlocks.push({ icon: f ? raidImg(f) : "", name: r.name, kind: "Invasion" });
      }
    }
    for (const o of assets.placeables) {
      if (o.level > from && o.level <= to)
        unlocks.push({
          icon: `${BASE}assets/objects/${o.sprite}`, tint: objectTint(o.color),
          name: o.name, kind: "Item",
        });
    }
    for (const b of assets.boosts) {
      if (b.level > from && b.level <= to)
        unlocks.push({ icon: `${BASE}assets/boosts/${b.icon}`, name: b.name, kind: "Boost" });
    }
    if (from < 20 && to >= 20) {
      unlocks.push({
        icon: zombiePortrait("ZombieActorZomBetty"),
        name: "Special zombies can now be purchased on the Black Market",
        kind: "Black Market",
      });
    }
    // Levels that open a whole SYSTEM (the Zombie Pot, daily quests, the Black
    // Market) get a Tim Buckwheat explanation once the celebration is dismissed —
    // the popup lists what appeared; Tim says what it means. Chained off onClose
    // so he never covers the popup, and sequentially so two crossings in one jump
    // cannot stack two Tims (showTimNotice replaces rather than stacks).
    const timNotices = timUnlockNoticesFor(from, to, onlineFarm);
    hud.openLevelUp(
      { level: to, unlocks },
      timNotices.length
        ? () => {
            void (async () => {
              for (const message of timNotices) await hud.timSays(message, "Got it!");
            })();
          }
        : undefined
    );
    audio.play("levelUp");
  };

  /** A level-up earned mid-battle, held until the player is back on the farm.
   *
   *  Invasions pay XP on every win now (repeatXp.ts), not just the first clear, so any
   *  fight can cross a threshold — and the popup used to land on top of the victory
   *  panel, interrupting the result the player was still reading. It also announced
   *  something they could not verify: `.raiding` hides the whole topbar (hud.css), so
   *  the XP bar and level are invisible from the moment the battle starts until the
   *  result panel closes. Holding the celebration until the farm is back makes the
   *  reward land where the player can actually see it happen.
   *
   *  Coalesced rather than queued: two crossings in one fight (a win plus the quest it
   *  completed) become ONE popup spanning `from`..`to`, which is what the unlock list is
   *  already built to describe. A stack of popups to dismiss is not a bigger celebration.
   *
   *  This defers the PRESENTATION only. The XP itself is credited when it is earned and
   *  saved with the rest of the win — deferring the credit would put it at risk of being
   *  lost if the tab closed over the result panel, and would buy nothing the player
   *  could see. */
  let pendingLevelUp: { from: number; to: number } | null = null;
  state.onLevelUpCb = (from, to) => {
    if (raidActive) {
      pendingLevelUp = pendingLevelUp
        ? { from: Math.min(pendingLevelUp.from, from), to: Math.max(pendingLevelUp.to, to) }
        : { from, to };
      return;
    }
    presentLevelUp(from, to);
  };
  /** Show anything held back by the battle. Safe to call when nothing is pending, so
   *  every path that hands the farm back can call it unconditionally. */
  const flushLevelUps = () => {
    const pending = pendingLevelUp;
    pendingLevelUp = null;
    if (pending) presentLevelUp(pending.from, pending.to);
  };

  // World container = camera. Field + entity layer live inside it.
  const world = new Container();
  app.stage.addChild(world);

  // Static hills-and-sky backdrop. The farm's top corner (tile 0,0) sits at world
  // y=0 and the land is centered on x=0, so anchor the backdrop bottom-center and
  // lift it a few tiles above y=0 — its hill bases stay just above the top tiles,
  // never overlapping the field. It lives at the back of the world so it pans and
  // zooms with the farm.
  const BG_GAP_TILES = 3; // hill bases stay this many tiles above the top tile
  // SKY_EXTENSION. A short band of the backdrop's own top-row colour, sitting directly
  // on top of the art.
  //
  // The backdrop is 2800x560 and beyond the top of that art there is nothing but the
  // renderer's filler colour, which above a horizon reads as a hole. The camera is
  // therefore capped at the top edge of the drawn art (see cameraFloor) and this band
  // never has to be somewhere players can GO — it only has to cover the seam. The art
  // is scaled by a fractional factor to span the farm, so its top edge lands on a
  // fraction of a pixel, and coming up half a pixel short is a filler-coloured line
  // across the sky. Every shipped backdrop has a perfectly uniform top row, so a few
  // tiles of that colour overlapping the edge closes it invisibly.
  const skyExtension = new Sprite(Texture.WHITE);
  skyExtension.anchor.set(0.5, 1);
  world.addChild(skyExtension);
  const background = new Sprite(assets.background);
  background.anchor.set(0.5, 1);
  background.position.set(0, -BG_GAP_TILES * TILE_H);
  world.addChild(background);

  // GROUND FILL. Only the farm is built out of ground tiles; the land around it is
  // just the renderer's flat `filler` colour showing through. That passes unnoticed
  // while a terrain is a flat wash, and stops passing the moment one has texture —
  // the stony Sakura farm otherwise sits as a detailed diamond on an unbroken sheet
  // of pink. A theme with a `groundFill` tiles that terrain over the land instead.
  //
  // Sits directly on the backdrop's lower edge and runs down from there, so it
  // covers everything below the horizon and nothing above it. Themes without a fill
  // leave it hidden and keep the flat colour, which is all the untextured ones need.
  const groundFill = new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 });
  groundFill.visible = false;
  world.addChild(groundFill);

  const field = new Field(assets);
  world.addChild(field.container);

  /** The army base the server last reported. Offline nothing ever reports one, so it
   *  stays at the shipped default — the same number the server derives from. */
  let serverArmyBase = BASE_ARMY_MAX;
  /** Re-derive the army cap from the objects actually standing on the farm. Every path
   *  that puts a functional object down or takes one away calls this instead of nudging
   *  the number by the def's `armyMax`: a running total only had to miss one branch to
   *  be permanently wrong offline, where no reconcile comes along to fix it (see
   *  armyCapacity.ts). Cheap and idempotent — it no-ops when nothing changed, so it is
   *  also safe to call on a placement that turned out not to land. */
  const refreshArmyCap = () => {
    state.syncArmyCapacity(armyCapacityOf(
      serverArmyBase,
      field.placedKeys(),
      (key) => placeCatalog.get(key)?.armyMax,
    ));
  };
  /** The same for the shed: re-derive its capacity from the shed actually standing on
   *  the farm rather than trusting the number the save carries (see shedCapacity.ts).
   *  Idempotent, so every path that can change which shed is placed just calls it. */
  const refreshShedCap = () => {
    state.syncShedCapacity(shedCapacityOf(
      field.placedKeys(),
      (key) => placeCatalog.get(key)?.storageSlots,
    ));
  };

  // Placed objects (trees) and the actors share Field.entityLayer so the farmer
  // depth-sorts correctly in front of / behind trees.
  world.addChild(field.entityLayer);

  /** Scenery on the land BELOW the camera's box — the deep strip a zoomed-out portrait
   *  phone sees past `boundB` (see cameraFloor). Drawn straight over the entity layer
   *  rather than inside it, and correct because everything here is strictly SOUTH of
   *  everything in that layer: a point south of every farm tile, object, actor and
   *  near-ring tree is in front of all of them by the isometric rule, so there is
   *  nothing here to interleave.
   *
   *  That is worth a whole layer because the entity layer's topological sort is O(n²)
   *  and reruns whenever an actor crosses a tile. Filling this strip from the same
   *  lattice quadrupled its child count — 3.8ms a sort on a desktop, for scenery no
   *  one can ever walk behind. Paint order in here is settled by key, not by the sort. */
  const farScenery = new Container();
  world.addChild(farScenery);

  // Plant/harvest job diamonds draw above entities so tall ripe crops do not clip
  // them. Plow markers live beside plotLayer inside Field, under actors/crops.
  world.addChild(field.highlightLayer);

  // Fertilize leaf FX draw above crops/actors (below night so they dim at dusk).
  world.addChild(field.fxLayer);

  // Decorative scenery on the land AROUND the farm — never on a farm tile. It's
  // added to the depth-sorted entity layer (zIndex = grid depth) so trees south of
  // the farm draw in front of it and northern ones behind, matching placed trees.
  // Purely visual: not registered in the tile grid, so it blocks nothing.
  //
  // Rebuildable: a Farm Size upgrade grows field.w/h, so the ring must move outward
  // (old foliage would otherwise end up sitting ON the newly-added farm tiles). We
  // track the sprites and regenerate them against the current bounds. The RNG is
  // seeded per field size so a given farm size always yields the same stable layout.
  //
  // WHAT gets scattered comes from the applied ground skin (see surroundings.ts):
  // grass keeps the temperate trees/shrubs, the sandy skin gets palms and a
  // shipwrecked pirate's cargo, and so on.
  let foliage: Sprite[] = [];
  /** The far strip's pieces, held with the depth key that orders them, so a later
   *  growth can splice new rows into the paint order without disturbing the ones
   *  already standing. */
  let farPieces: { key: number; sp: Sprite }[] = [];
  /** The first lattice row the far sweep has NOT emitted yet. Growth resumes here. */
  let farNextV = 0;
  /** Extend the far strip down to a world y, emitting only the rows below what is
   *  already built.
   *
   *  The strip grows because `reachB` is viewport-shaped, and the whole point is that
   *  growing it must not touch the near band above it — that band is what the player
   *  is looking at, and rebuilding a forest on screen to add trees underneath it is
   *  work for nothing. This used to be a full `buildFoliage()` off the resize handler,
   *  which destroyed and recreated every scenery sprite in the world; since a window
   *  dragged taller grows `reachB` a few pixels at a time, that ran on essentially
   *  every resize event for the length of the drag.
   *
   *  Replaced by every buildFoliage, which owns the theme context the sweep needs, so
   *  it is a no-op until the first one has run. */
  let growFarScenery: (toY: number) => void = () => {};
  // Box the camera into the world: the view can pan/zoom to reveal the sky down to the
  // farm and the decorated grass ring around it, but no further into empty green void
  // and never above the top of the drawn backdrop. Recomputed by computeBounds()
  // whenever the farm grows OR the viewport changes shape; the reach matches the
  // foliage band so all scenery stays reachable.
  //
  // DECLARED HERE, hundreds of lines above the computeBounds() that fills them in and
  // the camera clamp that consumes them, because the scatter and the road builders
  // just below READ them. `let` has a temporal dead zone: left down beside their own
  // code, any call into buildFoliage/buildRoad that ever lands earlier in the startup
  // sequence throws `ReferenceError: reachB is not defined` — an error that names a
  // variable rather than the ordering mistake, thrown with nothing on screen to
  // explain it, and one TypeScript does not catch. The same trap is documented on
  // dressBackdrop below, which is a hoisted `function` for exactly this reason.
  // Zero is a safe reading for every one of them: it means "no room yet", so a build
  // that somehow runs this early scatters nothing instead of crashing, and the
  // syncWorldToFarm() at startup rebuilds it against real bounds moments later.
  let boundL = 0, boundR = 0, boundT = 0, boundB = 0;
  /** The lowest world y the camera can ever reach on THIS viewport: as far below the
   *  box as a fully zoomed-out view is tall (see cameraFloor). Not a pan limit — a
   *  coverage target, for the scatter and the road that have to fill down to it. */
  let reachB = 0;
  /** Night lights cast by the surroundings' own lamps. A sibling of the placed
   *  objects' `field.objectLights` under the night layer, and world-positioned the
   *  same way — separate only because these belong to the ring and have to be torn
   *  down with it, whereas an object's light lives and dies with the object. */
  const sceneryLights = new Container();
  /** Where the road sits this build. Shared so the scatter can keep off it. */
  interface RoadGeometry {
    row: number; colMin: number; colMax: number;
    nearVerge: number; farVerge: number; crossCol: number;
  }
  // How far below the backdrop's base the skyline stands. Far enough that the poles
  // read as planted on the land rather than growing out of the hills, close enough
  // that they still sit against them.
  const SKYLINE_DROP = 34;
  // A visit may display the friend's selection, but must never overwrite this
  // device's own preference in localStorage.
  let displayedFarmBackground: FarmBackground = getFarmBackground();
  let surroundings = surroundingsTheme(field.climate);
  // Read here rather than beside the night code that owns it: the backdrop dressing
  // below needs it, and that runs during startup well before the lighting is built.
  let dayNightMode: DayNightMode = getDayNightMode();
  /** Is the sunset horizon the one to show? Only in `auto` — a player who has pinned
   *  the farm to day or night has said what they want the sky to be. */
  const wantDusk = () =>
    !!surroundings.dusk && dayNightMode === "auto" && isLocalDusk();
  let duskShown = false;
  // Bumped by every build so a texture load that finishes after a later rebuild
  // (or a theme switch) resolves into a no-op instead of a duplicate ring.
  let foliageGeneration = 0;

  /** Lay a street across the surrounding land, and line its two verges.
   *
   *  The carriageway runs down a single grid ROW, which in iso is the down-right
   *  diagonal — the direction the road art's own lane markings are painted along.
   *  Laid the other way the dashes would run ACROSS the road.
   *
   *  Surface pieces go into the ground-object layer rather than the entity layer, so
   *  everything on the verges (and anything that ever walks past) draws over the
   *  asphalt instead of sorting against it. Verge pieces are ordinary scenery and go
   *  where the scatter's pieces go. Everything is pushed into `foliage`, which is
   *  what a rebuild tears down — a road that outlived its skin would be worse than
   *  no road at all. */
  const buildRoad = (
    road: RoadSpec, geom: RoadGeometry, objScale: number,
    pieceTexture: (p: SceneryPiece) => Texture | null, rnd: () => number,
  ) => {
    const def = placeCatalog.get(road.key);
    const surface = def && assets.objects[def.sprite];
    if (!def || !surface) return; // catalog or texture not resolved yet
    const cross = placeCatalog.get(road.crossingKey);
    const crossTex = cross && assets.objects[cross.sprite];
    const { row: roadRow, colMin, colMax, crossCol } = geom;
    const lay = (
      piece: SceneryPiece, tex: Texture, col: number, row: number,
      w: number, h: number, scale: number, dy = 0,
    ) => {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 1);
      sp.scale.set(piece.flip ? -scale : scale, scale);
      sp.position.set(((col + (w - 1) / 2) - (row + (h - 1) / 2)) * HW,
        gridToScreen(col + w - 1, row + h - 1).y + TILE_H + dy);
      return sp;
    };
    // Road art is anchored by its authored flat-tile pivot, not bottom-centred like
    // everything else — the same rule Field.flatTileOffset applies to a placed one.
    // A constant offset cannot open a seam (pieces still step exactly 2*HW across),
    // but it decides where the asphalt sits relative to the ROWS, and the verges are
    // positioned by row: get it wrong and the kerbs crowd one side of the street and
    // leave a gap on the other. For a 2x2 it reduces to a vertical nudge.
    const kerbDy = def.nativeH * objScale * (def.anchorY ?? 0);
    const surfacePiece = { file: def.sprite };
    const paveTo = (sp: Sprite) => { field.groundObjectLayer.addChild(sp); foliage.push(sp); };
    for (let col = colMin; col <= colMax; col += 2) {
      // The crossing replaces one straight rather than sitting beside it, so the run
      // stays in step and the junction lands on the lay instead of half a tile off.
      const useCross = col === crossCol && cross && crossTex;
      paveTo(useCross
        ? lay({ file: cross!.sprite }, crossTex!, col, roadRow, 2, 2, objScale,
          cross!.nativeH * objScale * (cross!.anchorY ?? 0))
        : lay(surfacePiece, surface, col, roadRow, 2, 2, objScale, kerbDy));
    }
    // The branch off the crossing, running AWAY from the farm down a fixed column.
    // Same art MIRRORED: a horizontal flip of an iso diamond swaps the two axes, so
    // the lane markings turn with the road instead of running across it.
    // Run it past everything the camera can REVEAL, which is not the same as its pan
    // box: minSceneZoom has a width term and deliberately no height one, so a tall
    // viewport zoomed right out ends up taller than the box and the whole surplus is
    // let down BELOW it (see cameraFloor). `reachB` is that floor, and the street has
    // to reach the same place the scatter does or it stops in mid-air.
    //
    // Laid once, unlike the scatter, which can be grown a row at a time afterwards.
    // It can afford to be: `reachB` is measured worst-case over both orientations, so
    // the only thing that outgrows a built road is a desktop window being dragged
    // taller — and a window wide enough to be a desktop is width-bound at a zoom that
    // never reveals past boundB in the first place.
    //
    // The main road needs no such margin: the width term means the view is never
    // WIDER than the box, so its two tiles of overshoot always clear the screen.
    const branchEnd = Math.ceil((reachB + TILE_H) / HH) - crossCol + 4;
    for (let row = roadRow + 2; row <= branchEnd; row += 2) {
      paveTo(lay({ file: def.sprite, flip: true }, surface, crossCol, row, 2, 2,
        objScale, kerbDy));
    }
    const place = (piece: SceneryPiece, col: number, row: number) => {
      const tex = pieceTexture(piece);
      if (!tex) return;
      const sp = lay(piece, tex, col, row, 1, 1, objScale * (piece.scale ?? 1));
      setFootprint(sp, col, row, col, row);
      field.entityLayer.addChild(sp);
      foliage.push(sp);
      return sp;
    };
    /** Light a lamp after dark. A street light exists to light a street, so one that
     *  goes dark at night is the same mistake as one standing in an empty lot.
     *
     *  Same glow table, radius and reveal strength as a PLACED object of that art
     *  (Field.attachObjectLight), so a Street Light bought from the Market and one
     *  standing on this kerb cast identical light. The vertical rule is that method's
     *  too — 0.35 of the light's own diameter above the ground point. The horizontal
     *  nudge is the one thing extra: the art hangs its lamp on an arm about a third of
     *  its width off the pole, and `flip` says which way that arm is pointing, so the
     *  pool lands under the head instead of under the post. */
    const lightLamp = (piece: SceneryPiece, sp: Sprite, tex: Texture) => {
      const glow = OBJECT_GLOWS[piece.file.replace(/\.png$/, "")];
      if (!glow) return;
      const l = makeLight(glow.radius, glow.color, 0.7);
      const scale = objScale * (piece.scale ?? 1);
      l.position.set(sp.x + (piece.flip ? -1 : 1) * tex.width * scale * 0.35,
        sp.y - l.height * 0.35);
      sceneryLights.addChild(l);
    };
    // Lamps march: an even stride down one kerb, skipping the junction so none
    // stands in the mouth of the side road.
    if (road.lamps.length && road.lampSpacing >= 1) {
      let i = 0;
      for (let col = colMin; col <= colMax; col += road.lampSpacing, i++) {
        if (Math.abs(col - crossCol) <= 2) continue;
        const piece = road.lamps[i % road.lamps.length];
        const sp = place(piece, col, geom.nearVerge);
        const tex = pieceTexture(piece);
        if (sp && tex) lightLamp(piece, sp, tex);
      }
    }
    // Litter does not march. Clumps are dropped at random along the far side and a
    // handful of pieces scattered around each, because that is how waste actually
    // accumulates — someone tips a load and it spreads from where it landed.
    if (road.litter.length) {
      const spread = Math.max(4, (colMax - colMin) / (road.litterClumps * 2));
      for (let c = 0; c < road.litterClumps; c++) {
        const cc = colMin + rnd() * (colMax - colMin);
        const cr = geom.farVerge + rnd() * 2;
        for (let k = 0; k < road.litterPerClump; k++) {
          const col = Math.round(cc + (rnd() - 0.5) * spread);
          const row = Math.round(Math.max(geom.farVerge, cr + (rnd() - 0.5) * 3));
          if (Math.abs(col - crossCol) <= 2) continue; // keep the side road clear
          place(road.litter[Math.floor(rnd() * road.litter.length)], col, row);
        }
      }
    }
  };

  /** Top of the scatterable land: the grass just below the hill bases. Shared by
   *  every pass that fills that band, so they cannot disagree about where it starts. */
  const treeTopY = () => background.position.y + 6;

  /** Drop a scenery piece at a world point, depth-sorted on the tile it stands on. */
  const dropPiece = (
    piece: SceneryPiece, tex: Texture, wx: number, wy: number, scale: number,
  ) => {
    const sp = new Sprite(tex);
    sp.anchor.set(0.5, 1);
    sp.scale.set(piece.flip ? -scale : scale, scale);
    sp.position.set(wx, wy);
    const v = (wy - HH) / HH, u = wx / HW;
    const col = Math.round((u + v) / 2), row = Math.round((v - u) / 2);
    setFootprint(sp, col, row, col, row);
    field.entityLayer.addChild(sp);
    foliage.push(sp);
  };

  /** Landmarks with the wood held back around them. Returns each one's clearing as a
   *  world-space circle, which the scatter and the trails both steer around.
   *
   *  Sited by rejection sampling rather than by an authored position: the land around
   *  the farm changes size with it, so any fixed spot would drift out of the ring on a
   *  bigger farm. Attempts are bounded — on a small farm there may genuinely be
   *  nowhere left that satisfies every rule, and the honest answer then is fewer
   *  springs, not one jammed against the fence. */
  const buildSprings = (
    spec: SpringSpec, objScale: number,
    pieceTexture: (p: SceneryPiece) => Texture | null,
    rnd: () => number, distOutside: (c: number, r: number) => number,
  ): { x: number; y: number; r: number }[] => {
    const clearings: { x: number; y: number; r: number }[] = [];
    const radius = spec.clearing * HW;
    for (let i = 0; i < spec.count; i++) {
      // The piece is chosen BEFORE the position, because how tall it is decides where
      // it may stand. Every scenery sprite is drawn upward from its ground point, so
      // a piece whose ground point sits at the top of the band still covers the hills
      // above it. For a tree that is right — it is standing in front of them. For a
      // POND it is not: flat water cannot climb a hillside, and one drawn over the
      // slope reads as pinned to it. So the whole sprite is kept below the horizon.
      const piece = spec.pieces[Math.floor(rnd() * spec.pieces.length)];
      const tex = pieceTexture(piece);
      if (!tex) break; // art still loading; the rebuild will place it
      const scale = objScale * (piece.scale ?? 1);
      const top = treeTopY() + tex.height * scale;
      if (top >= boundB) break; // nowhere it could stand clear of the hills
      for (let attempt = 0; attempt < 200; attempt++) {
        const wx = boundL + rnd() * (boundR - boundL);
        const wy = top + rnd() * (boundB - top);
        const v = (wy - HH) / HH, u = wx / HW;
        const col = (u + v) / 2, row = (v - u) / 2;
        if (distOutside(col, row) < spec.minDistance) continue;
        // Two springs on top of each other are one big pond, so keep them apart by
        // both their clearings.
        if (clearings.some((c) => Math.hypot(c.x - wx, c.y - wy) < radius * 2)) continue;
        dropPiece(piece, tex, wx, wy, scale);
        clearings.push({ x: wx, y: wy, r: radius });
        break;
      }
    }
    return clearings;
  };

  /** Stone trails winding through the land.
   *
   *  Each is a random walk: a heading that turns a little at every step, which is the
   *  cheapest thing that reads as a path someone wore rather than a line someone
   *  drew. Steps that land on the farm, its margin or a spring are skipped rather
   *  than ending the trail, so a path can pass behind an obstacle and pick up again
   *  on the far side. */
  const buildPaths = (
    spec: PathSpec, objScale: number,
    pieceTexture: (p: SceneryPiece) => Texture | null,
    rnd: () => number, distOutside: (c: number, r: number) => number,
    clearings: { x: number; y: number; r: number }[], margin: number,
  ) => {
    // Starts are STRATIFIED, not simply random: the band is cut into a coarse grid
    // and each trail begins in its own cell. A dozen independent uniform draws
    // reliably leaves half the wood untouched and stacks three trails in one corner
    // — the clustering is what random looks like, and it reads as a few gravel
    // patches rather than as paths running through the place.
    const top = treeTopY();
    const cols = Math.ceil(Math.sqrt(spec.count));
    const rows = Math.ceil(spec.count / cols);
    for (let t = 0; t < spec.count; t++) {
      let wx = boundL + ((t % cols) + rnd()) * (boundR - boundL) / cols;
      let wy = top + (Math.floor(t / cols) + rnd()) * (boundB - top) / rows;
      let heading = rnd() * Math.PI * 2;
      for (let s = 0; s < spec.length; s++) {
        heading += (rnd() - 0.5) * 2 * spec.wander;
        // Iso is half as tall as it is wide, so a heading walked in raw screen space
        // would make every trail look like it runs downhill. Squash y to match.
        wx += Math.cos(heading) * spec.step;
        wy += Math.sin(heading) * spec.step * (HH / HW);
        if (wx < boundL || wx > boundR || wy < top || wy > boundB) break;
        const v = (wy - HH) / HH, u = wx / HW;
        if (distOutside((u + v) / 2, (v - u) / 2) < margin) continue;
        if (clearings.some((c) => Math.hypot(c.x - wx, c.y - wy) < c.r)) continue;
        const piece = spec.pieces[Math.floor(rnd() * spec.pieces.length)];
        const tex = pieceTexture(piece);
        if (!tex) return;
        dropPiece(piece, tex, wx, wy, objScale * (piece.scale ?? 1));
      }
    }
  };

  /** A line of pieces marching across the screen just below the hills.
   *
   *  A HORIZONTAL screen line is not a grid row — rows run diagonally. It is a line
   *  of constant col+row, which is exactly a constant world y, so this walks world x
   *  directly and converts back only to work out what tile each piece stands on for
   *  the depth sort. */
  const buildSkyline = (
    spec: SkylineSpec, objScale: number,
    pieceTexture: (p: SceneryPiece) => Texture | null,
  ) => {
    if (!spec.pieces.length || spec.spacing < 1) return;
    const y = background.position.y + SKYLINE_DROP;
    const step = spec.spacing * HW;
    let i = 0;
    // Anchored to a multiple of the step rather than to boundL, so growing the farm
    // widens the line instead of shuffling every pole along it.
    for (let x = Math.ceil(boundL / step) * step; x <= boundR; x += step, i++) {
      const piece = spec.pieces[i % spec.pieces.length];
      const tex = pieceTexture(piece);
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 1);
      const s = objScale * (piece.scale ?? 1);
      sp.scale.set(piece.flip ? -s : s, s);
      sp.position.set(x, y);
      const v = (y - HH) / HH, u = x / HW;
      const col = Math.round((u + v) / 2), row = Math.round((v - u) / 2);
      setFootprint(sp, col, row, col, row);
      field.entityLayer.addChild(sp);
      foliage.push(sp);
    }
  };

  const buildFoliage = () => {
    const generation = ++foliageGeneration;
    // Far pieces are in `foliage` too, so this destroys them; the strip's own
    // bookkeeping has to be wound back with it or growth would resume mid-air.
    for (const s of foliage) { s.parent?.removeChild(s); s.destroy(); }
    foliage = [];
    farPieces = [];
    farNextV = 0;
    for (const l of sceneryLights.removeChildren()) l.destroy();
    // Theme pieces are ordinary object art, which loads lazily. Draw with whatever
    // is already resident, and rebuild once the rest of this theme's art arrives.
    // The road SURFACE is named by catalog key rather than filename (the layout
    // needs its footprint, not just its art), so it is resolved here and added to
    // the same preload — otherwise the first build of an urban farm lays verges
    // down an invisible street and never comes back to fill it in.
    const roadSprite = surroundings.road
      ? placeCatalog.get(surroundings.road.key)?.sprite : undefined;
    const wanted = themeObjectFiles(surroundings);
    if (roadSprite) wanted.push(roadSprite);
    const missing = wanted.filter((f) => !assets.objects[f]);
    if (missing.length) {
      void Promise.all(missing.map((f) => ensureObjectTexture(assets, f).catch(() => null)))
        .then(() => { if (generation === foliageGeneration) buildFoliage(); });
    }
    const pieceTexture = (p: SceneryPiece): Texture | null =>
      (p.scenery ? assets.scenery[p.file] : assets.objects[p.file]) ?? null;
    const objScale = TILE_W / assets.field.tileW;
    let seed = 20240706 ^ (field.w << 8) ^ field.h;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    // How many tiles a point lies OUTSIDE the farm rectangle (0 = inside it).
    const distOutside = (c: number, r: number) =>
      Math.max(0, Math.max(-c, c - (field.w - 1)), Math.max(-r, r - (field.h - 1)));
    const MARGIN = 2.5; // clear grass between the farm edge and the nearest foliage

    // Fill the WORLD-SPACE rectangle the camera can reveal at max zoom-out
    // ([boundL..boundR] x [treeTop..boundB]) instead of a grid-space diamond ring —
    // that ring is why the far screen corners used to sit on bare grass when fully
    // zoomed out. We sweep the rotated (u,v) lattice (u = col-row, v = col+row),
    // which maps straight onto that rect:  worldX = u*HW,  worldY = v*HH + HH.
    //
    // This NEAR band stops at the pan bound `boundB`, and so depends only on the farm
    // and the skin — never on the viewport. The land past boundB, which only a view
    // taller than the world box can see, is the far strip: same lattice, same stream,
    // swept separately by `growFarScenery` so a viewport that grows extends it instead
    // of rebuilding everything above it. Springs and trails stay in the near band —
    // their counts are authored, and spreading a fixed dozen ponds over three times
    // the area just thins out the ring nobody has to zoom out to see.
    //
    // Everything past boundB goes to `farScenery` instead of the depth-sorted entity
    // layer, paint-ordered by the same depth key the sort would give it. For a POINT
    // footprint that key is just `col + row`, which is `jv` — and among points,
    // ascending key IS a valid topological order (a lower c+r means a lower c or a
    // lower r, which is the separating rule), so this is not an approximation.
    const treeTop = treeTopY();
    const uMin = Math.floor(boundL / HW) - 2, uMax = Math.ceil(boundR / HW) + 2;
    const vMin = Math.floor((treeTop - HH) / HH) - 2;
    const vMax = Math.ceil((boundB - HH) / HH) + 2;
    const STEP = 2;

    // The street, if this skin has one. Laid FIRST so the scatter below can be told
    // to keep off it — a bin standing in the middle of the carriageway would undo
    // the one thing a road is here to do, which is look deliberate.
    const road = surroundings.road;
    // The road piece is 2x2, so the carriageway covers rows [row, row+1]. Columns
    // span the reachable rect: worldX = (col - row) * HW, so at a fixed row the
    // visible column range falls straight out of the camera's x bounds.
    //
    // The two verges are NOT symmetric about the carriageway, and cannot be. Road art
    // is pinned by its authored flat-tile pivot, which sits below the footprint's
    // bottom-centre — so the asphalt is drawn about a third of a row further toward
    // the far side than its rows suggest. Two clear rows on the near side put the
    // lamps off the kerb; on the far side it takes three.
    const roadRow = field.h - 1 + (road?.offset ?? 0);
    const geom = {
      row: roadRow,
      colMin: Math.floor(roadRow + boundL / HW) - 2,
      colMax: Math.ceil(roadRow + boundR / HW) + 2,
      nearVerge: roadRow - 2,
      farVerge: roadRow + 3,
      // The crossing sits where the road passes directly below the middle of the
      // farm (world x is 0 where col == row), snapped onto the two-tile lay so the
      // piece lands in step with the straights either side of it.
      crossCol: 0,
    };
    geom.crossCol = geom.colMin + 2 * Math.round((roadRow - geom.colMin) / 2);
    // Rows the scatter must leave alone: the carriageway and both verges, which the
    // road dresses itself, plus the corridor the branch runs down.
    const onRoad = (col: number, row: number) => {
      if (!road) return false;
      if (row >= geom.nearVerge && row <= geom.farVerge) return true;
      return row > geom.farVerge && Math.abs(col - geom.crossCol) <= 2.5;
    };
    if (road) buildRoad(road, geom, objScale, pieceTexture, rnd);
    if (surroundings.skyline) buildSkyline(surroundings.skyline, objScale, pieceTexture);
    // Springs before trails before the scatter, strictly: each pass needs more room
    // than the one after it, so the one that needs the most gets to choose first and
    // the rest steer around what is already down.
    const clearings = surroundings.springs
      ? buildSprings(surroundings.springs, objScale, pieceTexture, rnd, distOutside)
      : [];
    if (surroundings.paths) {
      buildPaths(surroundings.paths, objScale, pieceTexture, rnd, distOutside,
        clearings, MARGIN);
    }
    // Farm Background setting scales the tree count: Deep Forest = full, Woodland
    // ~half, Light Meadow ~a tenth. Same seed, so the sparser sets are subsets of
    // the denser ones and switching just thins/thickens the same forest. The theme
    // scales it again — a paved lot or an airless moon stays sparse at every
    // setting (surroundings.ts `density`).
    const accept = 0.34 * FARM_BG_DENSITY[displayedFarmBackground] *
      (surroundings.density ?? 1);
    const treeShare = surroundings.treeShare ?? 0.5;
    /** One lattice point's piece, or null where the gates reject it.
     *
     *  Shared by both sweeps so a tree cannot change species or size depending on
     *  which pass laid it down, and — because every path through here draws exactly
     *  five numbers before it can bail — so that the stream stays in step whichever
     *  pass walks a row. That is what lets the far strip be grown a few rows at a
     *  time and still land the layout one single sweep would have produced.
     *
     *  There is no bottom bound in here: each sweep owns its own, and the far one's
     *  is a lattice row rather than a world y. */
    const scatterAt = (u: number, v: number) => {
      const ju = u + (rnd() - 0.5) * STEP * 1.3; // jitter off the lattice
      const jv = v + (rnd() - 0.5) * STEP * 1.3;
      const wx = ju * HW, wy = jv * HH + HH;
      const col = (ju + jv) / 2, row = (jv - ju) / 2;
      const d = distOutside(col, row);
      const r1 = rnd(), r2 = rnd(), r3 = rnd(); // consume RNG evenly (stable layout)
      // Gate: inside the reachable rect (slight overshoot so edges fully cover) and
      // off the farm + its clearing margin.
      if (wx < boundL - HW || wx > boundR + HW || wy < treeTop) return null;
      if (d < MARGIN) return null;
      // the street dresses its own carriageway, verges and branch
      if (onRoad(col, row)) return null;
      // A spring is meant to be somewhere the wood stops, so nothing fills it in.
      if (clearings.some((c) => Math.hypot(c.x - wx, c.y - wy) < c.r)) return null;
      // Woodland fill: the far band is `treeShare` trees and the rest props, and
      // everything nearer the clearing edge is a prop. `accept` sets how much of
      // the lattice is populated at all.
      if (r1 >= accept) return null;
      const isTree = d >= 4.5 && r2 < treeShare;
      // Piece choice is hashed off the lattice point, not drawn from `rnd`: the
      // draws left also set the SIZE, so sharing one would tie every big piece to
      // the same object. Sizes are multiples of the piece's NATIVE object scale,
      // so a scenery palm matches a placed one exactly.
      const piece = pickPiece(isTree ? surroundings.trees : surroundings.props, u, v);
      const tex = pieceTexture(piece);
      if (!tex) return null; // theme art still loading — the rebuild above fills it in
      const s = objScale * (piece.scale ?? 1) *
        (isTree ? 0.85 + r3 * 0.30 : 0.80 + r3 * 0.35);
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 1);
      // A flipped piece mirrors about its own vertical axis. The anchor is already
      // horizontally centred, so a negative x scale turns the art in place — it
      // does not shift off its ground point (see SceneryPiece.flip).
      sp.scale.set(piece.flip ? -s : s, s);
      sp.position.set(wx, wy);
      foliage.push(sp);
      return { key: jv, wy, col, row, sp };
    };

    /** Put a piece in the depth-sorted layer, on a point footprint so it sorts with
     *  trees and actors. */
    const placeNear = (hit: { col: number; row: number; sp: Sprite }) => {
      const fc = Math.round(hit.col), fr = Math.round(hit.row);
      setFootprint(hit.sp, fc, fr, fc, fr);
      field.entityLayer.addChild(hit.sp);
    };
    /** Child order is paint order in `farScenery`, so lay the strip down back to
     *  front. The lattice is walked v-major, but the jitter is wider than the step,
     *  so rows interleave and emission order alone would leave a tree behind its
     *  neighbour — and they interleave ACROSS a growth boundary too, which is why the
     *  whole strip is re-ordered rather than the new rows simply appended. Reordering
     *  moves children that already exist; it does not rebuild any of them. */
    const sortFar = () => {
      farPieces.sort((a, b) => a.key - b.key);
      for (const f of farPieces) farScenery.addChild(f.sp);
    };

    // The near band. Its overshoot rows run a little past boundB, and whatever lands
    // there is already far-strip material — handing it straight over keeps the two
    // sweeps contiguous, with no seam of bare ground along the join.
    let nextV = vMin;
    for (; nextV <= vMax; nextV += STEP) {
      for (let u = uMin; u <= uMax; u += STEP) {
        const hit = scatterAt(u, nextV);
        if (!hit) continue;
        if (hit.wy > boundB + HH) farPieces.push({ key: hit.key, sp: hit.sp });
        else placeNear(hit);
      }
    }
    farNextV = nextV;
    sortFar();

    growFarScenery = (toY: number) => {
      const toV = Math.ceil((toY - HH) / HH) + 2;
      if (toV < farNextV) return; // already grown past there
      let v = farNextV;
      for (; v <= toV; v += STEP) {
        for (let u = uMin; u <= uMax; u += STEP) {
          const hit = scatterAt(u, v);
          // Everything down here is south of boundB by construction, so it is all
          // far-strip material — there is no near/far test left to make.
          if (hit) farPieces.push({ key: hit.key, sp: hit.sp });
        }
      }
      farNextV = v;
      sortFar();
    };
    growFarScenery(reachB);
  };

  const actor = new Actor(assets);
  field.entityLayer.addChild(actor.container);
  let appliedHead = -1;
  let appliedBody = -1;
  const applyFarmerAppearance = () => {
    if (appliedHead === state.farmerHeadId && appliedBody === state.farmerBodyId) return;
    const head = assets.farmer.heads.find((part) => part.id === state.farmerHeadId);
    const body = assets.farmer.bodies.find((part) => part.id === state.farmerBodyId);
    if (!head || !body) return;
    actor.setAppearance(head.part, body.id);
    appliedHead = head.id;
    appliedBody = body.id;
  };
  state.onChange(applyFarmerAppearance);
  applyFarmerAppearance();

  let petActor: PetActor | null = null;
  let appliedPet: string | null | undefined;
  let petLoadGeneration = 0;
  const applyActivePet = () => {
    if (appliedPet === state.activePet) return;
    appliedPet = state.activePet;
    const generation = ++petLoadGeneration;
    petActor?.destroy();
    petActor = null;
    if (!state.activePet) return;
    const def = assets.pets.pets.find((pet) => pet.key === state.activePet);
    if (!def) return;
    void PetActor.load(def).then((loaded) => {
      if (generation !== petLoadGeneration || state.activePet !== def.key) {
        loaded.destroy();
        return;
      }
      petActor = loaded;
      field.entityLayer.addChild(loaded.container);
      loaded.update(0, actor.container.x, actor.container.y);
    }).catch((error) => console.warn(`[pet] failed to load ${def.key}`, error));
  };
  state.onChange(applyActivePet);
  applyActivePet();

  let penPetActors: PetActor[] = [];
  let appliedPenPets = "";
  let penPetLoadGeneration = 0;
  const applyPenPets = () => {
    const signature = state.penPets.join("\0");
    if (signature === appliedPenPets) return;
    appliedPenPets = signature;
    const generation = ++penPetLoadGeneration;
    penPetActors.forEach((pet) => pet.destroy());
    penPetActors = [];
    void Promise.all(state.penPets.flatMap((key) => {
      const def = assets.pets.pets.find((pet) => pet.key === key);
      return def ? [PetActor.load(def)] : [];
    })).then((loaded) => {
      if (generation !== penPetLoadGeneration || state.penPets.join("\0") !== signature) {
        loaded.forEach((pet) => pet.destroy());
        return;
      }
      penPetActors = loaded;
      for (const pet of loaded) field.entityLayer.addChild(pet.container);
    }).catch((error) => console.warn("[pet-pen] failed to load occupants", error));
  };
  state.onChange(applyPenPets);
  applyPenPets();

  const start = assets.field.start;
  const walk = new WalkController(actor, field, start.col, start.row);

  // The one head bonus that moves the farmer rather than the farm (the ninja masks,
  // +25%). Keyed off the BONUS head, not the worn one, so a pinned ninja keeps paying
  // while another head is on show — the same rule every other head bonus follows.
  let appliedSpeedHead = -1;
  const applyFarmerSpeed = () => {
    if (appliedSpeedHead === state.bonusHeadId()) return;
    appliedSpeedHead = state.bonusHeadId();
    walk.setSpeedPx(state.farmerWalkSpeedPx(SPEED_PX));
  };
  state.onChange(applyFarmerSpeed);
  applyFarmerSpeed();

  // Owned zombies (Phase 3): grown from harvested zombie crops, they wander the
  // farm (routing around objects) and can be selected to inspect their stats.
  const zombies = new ZombieField(
    assets, field, state, (key) => zombieDefs.get(key), () => audio.play("instaGrow"),
    () => walk.tile // where a unit with no saved position of its own arrives
  );
  audio.setZombieBarkSource(() => zombies.randomBrainBark());
  // The graveyard. Wired here (not in the online block) because both the offline
  // and the server-verified raid paths funnel their dead through removeCasualties,
  // and a Memorial Statue is a purely local, cosmetic keepsake either way.
  zombies.onFallen = (units) =>
    state.recordFallen(units.map((unit) => snapshotFallen(unit, Date.now())));
  zombies.onRevived = (ids) => state.forgetFallen(ids);
  // Selling or shelving a statue must not take its occupant with it.
  field.onMemorialReleased = (fallen) => state.releaseFallen(fallen);

  // Night lighting layer: a dark mask with the lights erased out of it (revealing
  // the daytime scene under each light — never a glare), above the farm/entities
  // but below the job labels & cursor (UI stays readable). Toggled from the HUD's
  // Developer menu for now (a real day/night cycle comes later).
  const night = new NightLayer();
  night.lights.addChild(field.objectLights); // glowing objects' lights
  night.lights.addChild(sceneryLights); // and the surroundings' own street lamps
  // Farmer lantern: two point lights (ZF2 addPlayerLight: radius 200 & 350, white).
  // Alpha here = how strongly the light carves the darkness away (reveals daytime).
  const lanternInner = makeLight(200, 0xfff0c8, 1.0);
  const lanternOuter = makeLight(350, 0xffe6b0, 0.55);
  night.lights.addChild(lanternOuter, lanternInner);
  world.addChild(night);
  let isNight = false;
  // Whether the farmer carries a lit lantern after dark. Off leaves the darkness mask
  // whole except for the placed objects' own glows — a real look, and one players asked
  // for. Toggled by tapping the farmer (see the Select tool's tap handling) and from
  // Settings; persisted, so it survives a reload.
  let lanternOn = getFarmerLantern();
  // Whether that tap-the-farmer shortcut is armed at all. Off leaves Settings as the
  // only way to switch the lantern, which is what you want if you keep flipping it by
  // accident while working the plots he is standing on.
  let lanternTapEnabled = getFarmerLanternTap();
  const setNight = (on: boolean) => {
    // A browser may preserve the JS objects while discarding their GPU render
    // target in the background. Rebuild on an off->on transition so a cold night
    // load never inherits an empty light map.
    if (on && !isNight) night.resetRenderTarget();
    isNight = on;
    night.visible = on;
    actor.setLanternVisible(on && lanternOn);
    lanternInner.visible = on && lanternOn;
    lanternOuter.visible = on && lanternOn;
    // Leave the viewport FILLER (the area beyond the hills backdrop) at its daytime
    // colour in both modes — it's the exact mid-hill colour of the current skin's
    // backdrop (surroundings.ts `filler`). At night the NightLayer's dark overlay
    // covers the whole screen, so it darkens this filler by the SAME amount as the
    // hills; they read as one continuous surface instead of the hills floating over
    // a near-black void.
  };
  const syncEnvironment = () => {
    setNight(dayNightMode === "night" || (dayNightMode === "auto" && isLocalNight()));
    // The clock can cross into or out of the dusk window while the farm is open, so
    // the horizon is re-dressed here too rather than only when the skin changes.
    if (wantDusk() !== duskShown) dressBackdrop();
  };
  hud.getNight = () => isNight;
  hud.onSetNight = (on) => setNight(on); // retained for the developer menu
  /** Turn the farmer's lantern on/off. Re-runs setNight so the lamp sprite, the two
   *  point lights and the light map all change together on the same frame. */
  const setLantern = (on: boolean) => {
    if (on === lanternOn) return;
    lanternOn = on;
    setFarmerLantern(on);
    if (isNight) night.resetRenderTarget(); // the carved holes just changed
    setNight(isNight);
  };
  hud.getFarmerLantern = () => lanternOn;
  hud.onSetFarmerLantern = setLantern;
  hud.getFarmerLanternTap = () => lanternTapEnabled;
  hud.onSetFarmerLanternTap = (on) => {
    lanternTapEnabled = on;
    setFarmerLanternTap(on);
  };
  hud.getDayNightMode = () => dayNightMode;
  hud.onSetDayNightMode = (mode) => {
    dayNightMode = mode;
    setDayNightMode(mode);
    syncEnvironment();
  };
  syncEnvironment();
  // Auto mode crosses the 7am/7pm boundary without requiring a reload.
  window.setInterval(() => {
    if (dayNightMode === "auto") syncEnvironment();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (isNight) night.resetRenderTarget();
      if (dayNightMode === "auto") syncEnvironment();
    }
  });
  app.canvas.addEventListener("webglcontextrestored", () => {
    night.resetRenderTarget();
    syncEnvironment();
  });

  // Job labels ("Plow/Plant/Harvest" pills) and the plot cursor render above the
  // field + entities so they're never hidden behind the farmer/zombie. The plow
  // selection itself is parented with the soil inside Field.
  world.addChild(field.labelLayer);
  world.addChild(field.cursor);

  // Center camera on the starting tile (pivot = that tile center) and render the
  // farm ~2.2x bigger by default. Wheel to zoom toward the cursor.
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3;
  const DEFAULT_ZOOM = 1.0;
  const sc = tileCenter(start.col, start.row);
  world.pivot.set(sc.x, sc.y);
  world.scale.set(DEFAULT_ZOOM);
  const REACH = 10; // tiles of grass beyond the farm the camera may show (foliage band)
  const BG_BASE_HALF = assets.background.width / 2; // native half-width of the backdrop

  // Scale the hills/sky backdrop so it always spans the (possibly upgraded) farm. A
  // bigger farm reaches farther in world-x than the native 2800px art; without this
  // the camera clamp (bounded below by the backdrop width) would cut off the far
  // corners. Scaling keeps the horizon covering the whole field.
  const fitBackground = () => {
    const halfSpan = (field.w - 1 + 2 * REACH) * HW + 90;
    background.scale.set(Math.max(1, halfSpan / BG_BASE_HALF));
    background.position.set(0, -BG_GAP_TILES * TILE_H);
    fitSkyExtension();
  };

  /** Size the sky band sitting on the backdrop's top edge.
   *
   *  It used to be a full viewport tall, measured at MIN_ZOOM, because the camera was
   *  allowed to rise above the art and needed something up there to look at. It is not
   *  any more — `cameraFloor` pins the top of the view to the top of the drawn art — so
   *  the band is down to what the SEAM needs: the backdrop is scaled by a fractional
   *  factor to span the farm, and being half a pixel short at its top edge is a
   *  filler-coloured line across the sky. A few tiles, overlapping the art by one. */
  const SKY_SEAM_TILES = 4;
  const fitSkyExtension = () => {
    const top = background.position.y - background.height;
    skyExtension.width = background.width;
    skyExtension.height = SKY_SEAM_TILES * TILE_H;
    skyExtension.position.set(background.position.x, top + TILE_H);
    fitGroundFill();
  };

  /** Size the tiled ground to cover every bit of land the camera can reveal below the
   *  horizon — the mirror of fitSkyExtension, and generous for the same reason: it is
   *  one tiling quad, and coming up short leaves a band of bare filler along an edge.
   *
   *  `tilePosition` pins the pattern to the WORLD origin rather than to the sprite,
   *  which matters twice. A Farm Size upgrade widens the backdrop and therefore moves
   *  this sprite's left edge, and without the correction the whole ground would jump
   *  sideways under the farm. And because the emitted fill uses the same lattice phase
   *  as Field.fit, anchoring both to the origin is what makes the stones outside the
   *  fence line up with the stones inside it. */
  const fitGroundFill = () => {
    if (!groundFill.visible) return;
    const top = background.position.y;
    const left = background.position.x - background.width / 2;
    groundFill.width = background.width;
    groundFill.height = app.screen.height / MIN_ZOOM + BG_GAP_TILES * TILE_H;
    groundFill.position.set(left, top);
    // The fill is emitted on the source 48px grid but the farm draws its own tiles
    // at TILE_W (47), so without this the two patterns are 2% out and drift apart
    // the further you get from the origin. Same ratio the objects use (objectScale).
    const scale = TILE_W / assets.field.tileW;
    groundFill.tileScale.set(scale);
    const pw = groundFill.texture.width * scale;
    const ph = groundFill.texture.height * scale;
    if (pw && ph) {
      groundFill.tilePosition.set(((-left % pw) + pw) % pw, ((-top % ph) + ph) % ph);
    }
  };

  // How far out the camera may zoom. The WIDTH term stands: the world box is bounded
  // left and right by the backdrop, and past its edges there is only filler colour with
  // no sky over it, so a view wider than the box would show hills against green.
  //
  // There is deliberately no HEIGHT term. That term was the whole reason a portrait
  // phone could not zoom out: a tall, narrow viewport divided by the world's modest
  // height pinned it around 0.6 while a desktop reached 0.25 on the same farm. A view
  // taller than the box is the CLAMP's problem instead, and it solves it downward — see
  // cameraFloor.
  const minSceneZoom = () => Math.max(MIN_ZOOM, app.screen.width / (boundR - boundL));

  // The camera box itself is declared far above, with the scatter that reads it.
  const computeBounds = () => {
    const skyTopY = background.y - background.height; // world y of the sky's top edge
    const grassBoundL = -((field.w - 1 + 2 * REACH) * HW) - 90;
    boundL = Math.max(grassBoundL, -background.width / 2);
    boundR = Math.min(-grassBoundL, background.width / 2);
    boundT = skyTopY;
    boundB = (field.w - 1 + REACH + (field.h - 1 + REACH)) * HH + 60;
    // The coverage target, measured worst case over BOTH orientations rather than off
    // the viewport as it stands: the tallest view this screen can produce is its long
    // side, at the zoom its short side permits. A phone that rotates therefore needs no
    // new scenery at all — which is the point, because a rotate cannot grow the strip
    // and so cannot stall on one. What is left that can still move it is a desktop
    // window genuinely changing size, and there the width term keeps the strip empty.
    const shortSide = Math.min(app.screen.width, app.screen.height);
    const longSide = Math.max(app.screen.width, app.screen.height);
    const outZoom = Math.max(MIN_ZOOM, shortSide / (boundR - boundL));
    reachB = Math.max(boundB, boundT + longSide / outZoom);
  };

  // Re-fit the backdrop, foliage ring, and camera bounds to the current farm size.
  // Called at startup, after a save loads (its size may be larger), and after a
  // Farm Size upgrade grows the field.
  const syncWorldToFarm = () => {
    fitBackground();
    computeBounds(); // foliage now fills the world-space camera rect, so bounds first
    buildFoliage();
  };
  syncWorldToFarm();

  // Re-dress everything OUTSIDE the farm to match the applied ground skin: the
  // scatter of trees/props, the hills-and-sky backdrop, and the viewport filler
  // beyond it. The filler must stay the backdrop's own mid-hill colour so the two
  // read as one surface — at night the darkness overlay dims both by the same
  // amount, and any mismatch shows up as the hills floating over a void.
  /** Put the right horizon up: the skin's own, or its sunset variant during the
   *  hours around nightfall. The filler and the sky band travel WITH the backdrop —
   *  they are that image's own mid-hill and top-row colours, so swapping the art
   *  without them leaves the hills floating on the wrong ground.
   *
   *  A hoisted `function`, not a `const` arrow like its neighbours, and deliberately:
   *  syncEnvironment() is CALLED during startup well above this line, and it re-dresses
   *  the backdrop when the clock has crossed the dusk boundary. That is unreachable
   *  today only because the boot theme is always the dusk-less Grass (Field.climate
   *  defaults to it and the save's skin arrives later, through applySurroundings). Give
   *  the boot theme a `dusk` and an arrow here would throw on every startup during the
   *  dusk window — a temporal-dead-zone crash with nothing on screen to explain it. */
  function dressBackdrop() {
    const theme = surroundings;
    const dusk = wantDusk() ? theme.dusk! : null;
    duskShown = !!dusk;
    app.renderer.background.color = dusk?.filler ?? theme.filler;
    skyExtension.tint = dusk?.sky ?? theme.sky;
    const file = dusk?.background ?? theme.background;
    void ensureBackgroundTexture(assets, file).then((tex) => {
      // Bail if the skin changed, or the clock crossed the dusk boundary, while
      // this was loading — either way a later dress has already had the last word.
      if (surroundings !== theme || duskShown !== !!dusk) return;
      background.texture = tex;
    }).catch((e) => console.warn(`[surroundings] backdrop ${file} failed`, e));
  }

  const applySurroundings = (terrain: string) => {
    const theme = surroundingsTheme(terrain);
    if (theme === surroundings) return;
    surroundings = theme;
    buildFoliage();
    dressBackdrop();
    // Tiled ground for the land outside the farm, for themes that have one. Hidden
    // immediately on a switch rather than when the new art arrives, so changing away
    // from a textured skin cannot leave the old terrain lying under the new one.
    groundFill.visible = false;
    if (theme.groundFill) {
      void ensureBackgroundTexture(assets, theme.groundFill).then((tex) => {
        if (surroundings !== theme) return;
        // A tiling quad samples past the texture's edge by definition; without this
        // the sampler clamps and the whole fill is one smeared row of edge pixels.
        tex.source.addressMode = "repeat";
        groundFill.texture = tex;
        groundFill.visible = true;
        fitGroundFill();
      }).catch((e) => console.warn(`[surroundings] fill ${theme.groundFill} failed`, e));
    }
  };
  // Fires for a Market purchase, re-applying an owned skin, AND a save load
  // restoring one. Wired after the first world sync so a callback can never run
  // before the backdrop/bounds/foliage it re-dresses exist.
  field.onClimateChange = applySurroundings;
  // Cues an animated decoration reaches mid-run, played on the SFX channel like any
  // other one-shot (see objectAnimation's `sound`).
  field.playAnimationSound = (file) => audio.tap(file);
  applySurroundings(field.climate);

  const clampZoom = () => {
    const s = Math.max(minSceneZoom(), Math.min(MAX_ZOOM, world.scale.x));
    world.scale.set(s);
    return s;
  };
  // Clamp one axis so the visible span [pos-based] stays within [lo,hi]; if the
  // view is larger than the box on that axis, center the box instead.
  const clampAxis = (pos: number, pivot: number, screen: number, lo: number, hi: number) => {
    const s = world.scale.y; // uniform scale
    if (screen / s >= hi - lo) return screen / 2 - ((lo + hi) / 2 - pivot) * s;
    const upper = s * (pivot - lo); // keeps the near (left/top) edge >= lo
    const lower = screen - s * (hi - pivot); // keeps the far (right/bottom) edge <= hi
    return Math.min(upper, Math.max(lower, pos));
  };
  /** The camera's floor: the bottom of the world box, or as far below `boundT` as the
   *  view is tall — whichever is lower.
   *
   *  A fully zoomed-out view on a tall screen is TALLER than the box, and that surplus
   *  has to go somewhere. It all goes DOWN. Above `boundT` is the top edge of the drawn
   *  backdrop and there is nothing beyond it but flat colour, which is what a portrait
   *  phone used to be shown: `clampAxis` centres a box smaller than the view, so half
   *  the surplus went up and players could see over the sky. Below the box is more of
   *  the same land the farm sits on, which the ring is grown to cover (`reachB`).
   *
   *  Handing `clampAxis` a box exactly as tall as the view makes its centring branch
   *  work out to precisely that top pin, so the clamp needs no special case for it. */
  const cameraFloor = () => Math.max(boundB, boundT + app.screen.height / world.scale.y);
  const clampCamera = () => {
    clampZoom();
    world.position.x = clampAxis(world.position.x, world.pivot.x, app.screen.width, boundL, boundR);
    world.position.y = clampAxis(world.position.y, world.pivot.y, app.screen.height,
      boundT, cameraFloor());
  };
  const recenter = () => {
    // The sky band is sized off the backdrop, but the ground fill under it is sized off
    // the viewport, so a rotate into portrait — the orientation that needs it — has to
    // re-cut them before the camera re-clamps.
    fitSkyExtension();
    // The camera floor is viewport-shaped, so a resize can reveal land the far strip
    // was not grown for. Extend it downward — never rebuild. Both calls are cheap and
    // idempotent, which they have to be: this runs on every resize event, and a desktop
    // window drag fires one per frame.
    computeBounds();
    growFarScenery(reachB);
    world.position.set(app.screen.width / 2, app.screen.height / 2);
    clampCamera();
  };
  recenter();

  // Hold WASD to pan the farm camera. Movement is frame-rate independent and
  // screen-space based, so it feels consistent at every zoom level.
  const cameraKeys = new Set<string>();
  const isEditableTarget = (target: EventTarget | null) => {
    const el = target instanceof HTMLElement ? target : null;
    return !!el && (el.isContentEditable || el.matches("input, textarea, select"));
  };
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (!"wasd".includes(key) || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    if (hud.el.classList.contains("tutorial")) return;
    cameraKeys.add(key);
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => cameraKeys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => cameraKeys.clear());

  // Zoom by `factor` while keeping the world point under (sx,sy) — a screen-space
  // pixel — fixed. Shared by mouse-wheel (desktop) and pinch (touch) so both zoom
  // toward the pointer/pinch-midpoint identically.
  const zoomAt = (sx: number, sy: number, factor: number) => {
    const cursor = new Point(sx, sy);
    const before = world.toLocal(cursor);
    const ns = Math.max(minSceneZoom(), Math.min(MAX_ZOOM, world.scale.x * factor));
    world.scale.set(ns);
    world.position.set(
      cursor.x - (before.x - world.pivot.x) * ns,
      cursor.y - (before.y - world.pivot.y) * ns
    );
    clampCamera(); // don't let zoom-out reveal above the sky
  };

  app.canvas.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  // ---- floating reward/cost popups (world-space) ----
  const feedbackIcons = {
    gold: await Assets.load<Texture>(`${BASE}assets/ui/topbar_money_icon.png`),
    brains: await Assets.load<Texture>(`${BASE}assets/ui/topbar_brain_icon.png`),
    xp: await Assets.load<Texture>(`${BASE}assets/ui/topbar_exp_icon.png`),
  };
  // One shared style rather than a fresh literal per popup: Pixi keys its rasterised
  // text cache on the style, so sharing one instance keeps every "+31g" hitting the
  // same cached texture. Never mutate it.
  const FLOAT_STYLE = new TextStyle({
    fontFamily: "system-ui, sans-serif", fontSize: 20, fontWeight: "700",
    fill: 0xffd24a, stroke: { color: 0x3a2400, width: 4 },
  });
  const FLOAT_ICON = 25; // px; re-applied on every reuse, since a texture swap resizes
  type Float = { view: Container; text: Text; icon: Sprite; ttl: number; delay: number };
  const floats: Float[] = [];
  // Retired popups are reused instead of destroyed. Insta-Harvest pops every plot's
  // OWN numbers in a single frame — up to three per plot, plus one per ripe tree — so
  // a full farm builds hundreds at once. Beyond the allocation churn, destroying a
  // Text drops its rasterised texture, which meant the next identical "+31g" had to be
  // measured and re-rendered from scratch. The pool is capped so one huge harvest
  // doesn't leave that many text textures resident afterwards.
  const FLOAT_POOL_MAX = 96;
  const floatPool: Float[] = [];
  const makeFloat = (): Float => {
    const text = new Text({ text: "", style: FLOAT_STYLE });
    text.anchor.set(0.5, 0.5);
    const icon = new Sprite();
    icon.anchor.set(0.5);
    const view = new Container();
    view.addChild(icon, text);
    return { view, text, icon, ttl: 0, delay: 0 };
  };
  const floatText = (x: number, y: number, msg: string, delay = 0) => {
    const currency = /[+-]\d+g\b/.test(msg) ? "gold"
      : /[+-]\d+b\b/.test(msg) ? "brains"
      : /[+-]\d+xp\b/.test(msg) ? "xp" : null;
    const readable = msg
      .replace(/([+-]\d+)g\b/g, "$1 gold")
      .replace(/([+-]\d+)b\b/g, "$1 brains")
      .replace(/([+-]\d+)xp\b/g, "$1 XP");
    const f = floatPool.pop() ?? makeFloat();
    f.text.text = readable;
    if (currency) {
      f.icon.texture = feedbackIcons[currency];
      f.icon.width = f.icon.height = FLOAT_ICON;
      f.icon.visible = true;
      const totalW = f.text.width + 31;
      f.icon.x = -totalW / 2 + 12;
      f.text.x = 15;
    } else {
      f.icon.visible = false;
      f.text.x = 0;
    }
    f.view.position.set(x, y);
    f.view.alpha = 1;
    f.view.visible = delay <= 0;
    f.ttl = 1.1;
    f.delay = delay;
    world.addChild(f.view);
    floats.push(f);
  };

  // Purchases made on the farm use the same delayed world-space XP reward as a
  // crop harvest. Instant purchases made inside a modal (currently pets) use a
  // visible HUD toast instead, since the modal obscures the world layer.
  const showPurchaseXp = (xp: number, at?: { x: number; y: number }) => {
    const feedback = purchaseXpFeedback(xp);
    if (!feedback) return;
    if (at) floatText(at.x, at.y, feedback.floating, 0.42);
    else hud.showToast(feedback.toast);
  };

  // The harvested crop itself pops free and flies upward, echoing the original
  // game's collection feedback. Zombie harvests already visibly produce the new
  // full-size unit, so this collection fly-up is reserved for vegetable crops.
  const harvestFx: {
    view: Sprite; age: number; x: number; y: number;
    dx: number; rise: number; spin: number; baseScale: number;
  }[] = [];
  const popHarvestIcon = (result: import("./Field").HarvestResult, x: number, y: number) => {
    if (result.zombieKey) return;
    const texture = assets.cropIcon[result.icon];
    if (!texture) return;
    const count = Math.random() < 0.5 ? 4 : 5;
    for (let i = 0; i < count; i++) {
      const view = new Sprite(texture);
      view.anchor.set(0.5);
      const maxSide = Math.max(texture.width, texture.height, 1);
      const baseScale = (34 + Math.random() * 6) / maxSide;
      view.scale.set(baseScale);
      const centered = i - (count - 1) / 2;
      const startX = x + centered * 5 + (Math.random() - 0.5) * 5;
      const startY = y + Math.abs(centered) * 2 + (Math.random() - 0.5) * 4;
      view.position.set(startX, startY);
      view.rotation = (Math.random() - 0.5) * 0.3;
      field.labelLayer.addChild(view);
      harvestFx.push({
        view, age: 0, x: startX, y: startY,
        dx: centered * 15 + (Math.random() - 0.5) * 10,
        rise: 105 + Math.random() * 25,
        spin: (Math.random() - 0.5) * 2.2,
        baseScale,
      });
    }
  };

  // Boss Tokens use the active boss's transparent face portrait. At 52px they are
  // effectively the same size as the farmer's 53x55 head art. They emerge from the
  // harvested plot with a small overshoot, then hover briefly over a soft gold glow.
  const bossTokenFx: { view: Container; glow: Graphics; age: number; x: number; y: number }[] = [];
  const popBossToken = (x: number, y: number, bossId: string, portrait: string) => {
    const url = `${BASE}assets/epic-bosses/${bossId}/${portrait}`;
    void Assets.load<Texture>(url).then((texture) => {
      const view = new Container();
      const glow = new Graphics()
        .circle(0, 0, 29)
        .fill({ color: 0xffdc55, alpha: 0.22 })
        .stroke({ color: 0xffef91, width: 2, alpha: 0.48 });
      const face = new Sprite(texture);
      face.anchor.set(0.5);
      face.width = 52;
      face.height = 52;
      view.addChild(glow, face);
      view.position.set(x, y + 10);
      view.scale.set(0.16);
      field.labelLayer.addChild(view);
      bossTokenFx.push({ view, glow, age: 0, x, y });
    }).catch(() => { /* a missing portrait should never interrupt harvesting */ });
  };

  // Quest event bus: plow/plant/harvest/buy post notifications that the QuestSystem
  // turns into quest progress. Created before the JobSystem so farm actions can post.
  const questBus = new QuestBus();
  let tutorial: TutorialController | null = null;

  /** The crop lure, assigned by the Epic Boss block far below once the pieces it needs
   *  (the quest rail, the save manager, the UI sync) exist — hence the forward
   *  declaration up here, where the job system that reaches it is built.
   *
   *  Assigned in BOTH modes; only ever CALLED offline. The mode test lives at the call
   *  site (onCropHarvested), because online the lure is the server's roll and a second
   *  one here would be a client minting itself free events. */
  let lureEpicBossOffline: ((cropKey: string, growMs: number) => void) | null = null;

  /** Roll a harvested crop for a Boss Token and, when it hits, award it HERE — in the
   *  same frame, out of the plot that produced it.
   *
   *  The roll used to be the server's online: the client harvested, the Worker rolled
   *  during replay, and the token only appeared when that batch settled — a window
   *  later, over a plot the player had already replanted, with no float text. The roll
   *  is now the client's in both modes and the server simply records what it reports
   *  (see `epicBoss.token` in net/protocol.ts). An edited client can therefore mint
   *  tokens; that is deliberate. A token buys one Epic Boss attempt, the drop is
   *  common, and the paid alternative is a single brain.
   *
   *  The running boss's FAVOURITE crop rolls a quarter better (epicBoss/favoriteCrops.ts).
   *  That is decided here, against the run actually in progress, so planting some other
   *  boss's favourite earns nothing extra. */
  const awardEpicBossToken = (
    crop: { key: string; growMs: number; value: number }, x: number, y: number
  ): boolean => {
    const run = state.epicBossRun;
    const def = epicBossById(run?.bossId);
    if (!run || !def || !new EpicBossManager(def).isActive(run)
      || !dropsEpicBossToken(crop.growMs, crop.value, Math.random, isFavoriteCrop(def.id, crop.key))) return false;
    state.setEpicBossRun({ ...run, tokenCount: (run.tokenCount ?? 0) + 1 });
    // Online, tell the server about it. Grants for THIS run fold into one command, so a
    // field-wide Insta-Harvest that turns up a dozen tokens still costs one command.
    if (state.onFarm) economy?.submitEpicBossToken(run.runId);
    popBossToken(x, y, def.id, def.portrait);
    // No toast: the token portrait rises out of the plot and the caller floats
    // "+1 Boss Token!" over it. Online used to need a toast because the token arrived
    // with nothing on screen to attach it to; an Insta-Harvest turning up several would
    // now stack that many identical toasts on top of each other.
    audio.play("xp");
    return true;
  };

  /** Everything a harvested vegetable crop owes the Epic Boss system: a token roll while
   *  an event is running, and — when none is — the far rarer chance that this crop's
   *  boss noticed it and turned up.
   *
   *  Only the token half is the client's online. A lure is worth the boss's whole brain
   *  price AND reopens its prize quest chain, so online the Worker rolls it while it
   *  replays the harvest it already grow-gates (server/src/v3/engine.ts). The event then
   *  arrives on the next settle and announces itself; nothing is drawn over the plot,
   *  because an event starting is a screen-level moment rather than a "+1" on some dirt
   *  the player has already replanted. */
  const onCropHarvested = (
    crop: { key: string; growMs: number; value: number }, x: number, y: number
  ): boolean => {
    if (!state.onFarm) lureEpicBossOffline?.(crop.key, crop.growMs);
    return awardEpicBossToken(crop, x, y);
  };

  // The farmer's job queue (till / plant / harvest / walk). He walks to each target,
  // hoes, then the action applies; queued plots stay highlighted green until done.
  // Harvesting a zombie crop grows an owned zombie at the plot's center tile.
  const jobs = new JobSystem(
    field, actor, walk, state, floatText, (name) => audio.play(name),
    (key, oc, or, context) => {
      const unit = zombies.spawnVerified(key, oc + 1, or + 1, offlineHarvestMutation(key, context));
      return unit ? { id: unit.id, subjectAliases: unitSubjectAliasesOf(unit) } : null;
    },
    questBus,
    (oc, or) => zombies.tryFertilize(oc, or),
    (oc, or) => tutorial?.onPlotPlowed(oc, or),
    onCropHarvested,
    (currency, needed) => hud.showToast(
      currency === "gold" ? "Not enough coins." : `Not enough brains (need ${needed}).`
    ),
    popHarvestIcon,
    () => zombies.zombieHarvestRoom()
  );

  // `raidActive` is declared up here (ahead of both the celebration queue and the raid
  // block far below) so every closure that reads it — the tutorial's isRaidActive(),
  // celebrateQuest() — sees an already-initialised binding; the raid launch handlers
  // assign it.
  let raidActive = false;

  // Quest-complete celebration, styled like the level-up popup. Quests can finish in
  // bursts (several at once on a raid return), so completions QUEUE and show one at a
  // time; the HUD calls onQuestCompleteClosed when each is dismissed to feed the next.
  const uiIcon = (name: string) => `${BASE}assets/ui/${name}`;
  const questRewards = (def: QuestDef): QuestReward[] => {
    const reward = questRewardInfo(def);
    const bonus = questBonusRewardInfo(def);
    return [
      ...(reward ? [{ icon: uiIcon(reward.icon), label: reward.label }] : []),
      // The completion popup lists every line the quest actually paid, so an
      // achievement that hands over a brain as well as XP shows both.
      ...(bonus ? [{ icon: uiIcon(bonus.icon), label: bonus.label }] : []),
    ];
  };
  const questCompleteQueue: QuestCompleteView[] = [];
  let questCompleteShowing = false;
  const showNextQuestComplete = () => {
    const next = questCompleteQueue.shift();
    if (!next) { questCompleteShowing = false; return; }
    questCompleteShowing = true;
    hud.openQuestComplete(next);
  };
  hud.onQuestCompleteClosed = showNextQuestComplete;
  const celebrateQuest = (def: QuestDef) => {
    questCompleteQueue.push({
      icon: def.sprite,
      title: def.title,
      message: def.messageComplete,
      rewards: questRewards(def),
    });
    // A battle owns the screen (and online a raid quest completes the moment
    // /raid/finish answers, while the result panel is still up), so hold the
    // celebration until the player is back on the farm. Closing the raid result
    // flushes the queue.
    if (!questCompleteShowing && !raidActive) showNextQuestComplete();
  };
  const flushQuestCompletions = () => {
    if (!questCompleteShowing) showNextQuestComplete();
  };

  /**
   * Place a zombie earned outside the crop cycle (quest, voucher, rare raid drop).
   * A full active farm files it in Received instead of destroying it; claiming it
   * from there later costs a real Mausoleum slot.
   *
   * Returns the deployed unit, or null when the award went to Received.
   *
   * ONLINE the Received bucket is server-owned: the authoritative grant already
   * writes its own marker, and a locally minted one would be erased by the next
   * storage sync (and could not be claimed, since the server has never seen that
   * id). So the local marker is written only when this client owns storage.
   */
  const grantEarnedZombie = (key: string): OwnedZombie | null => {
    if (zombies.canAdd()) return zombies.grantReward(key, walk.tile.col, walk.tile.row);
    if (!onlineFarm) {
      // Earned is earned: the Almanac counts the species here rather than waiting for
      // the claim, so the collection never differentiates by which bucket holds a unit.
      const mutation = zombieDefs.get(key)?.mutation ?? 0;
      state.recordZombieDiscovered(key, mutation);
      state.receiveItem(encodeReceivedZombie({
        id: crypto.randomUUID(), key, mutation, invasions: 0,
      }));
    }
    return null;
  };

  /** Put a server-awarded zombie on the results panel, where the player actually
   *  looks. A prize that could not go straight onto the farm used to be announced
   *  only by a toast fired the instant before the panel covered it — for an Epic
   *  Boss milestone that meant the event's signature zombie arrived unannounced.
   *  Also counts the species for the Almanac when it went to Received: nothing
   *  claims it into the roster, so no other path would. */
  const rewardZombieDrop = (
    unit: { key: string; stored: boolean; received?: boolean; mutation?: number }
  ): LootDrop => {
    // A Received prize keeps the mask the server minted it with; falling back to the
    // species default covers a prize the caller described without one.
    if (unit.received) {
      state.recordZombieDiscovered(unit.key, unit.mutation ?? zombieDefs.get(unit.key)?.mutation ?? 0);
    }
    return {
      name: zombieDefs.get(unit.key)?.name ?? "Reward zombie",
      icon: zombiePortrait(unit.key),
      qty: 1,
      note: unit.received ? "Waiting in Received" : unit.stored ? "Sent to the Mausoleum" : undefined,
    };
  };

  // The data-driven quest engine (all 96 quests from quests.json). Rewards route to
  // GameState / the roster; the HUD rail and the completion popup come from `hud`.
  const quests = new QuestSystem(
    new Map(Object.entries(assets.quests)), state, questBus,
    {
      // Signed-in quest progress follows accepted server commands. Advancing from
      // local notifications would permanently complete quests for actions the
      // server later rejected or rolled back.
      authoritative: onlineFarm,
      // Online: the server grants the quest's currency reward (and any level-up brains)
      // authoritatively and idempotently; return true so QuestSystem skips the local add
      // (which the spend-only economy endpoint would reject anyway). Offline: `economy`
      // is null → return false → currency is granted locally as before.
      grantReward: (def) => {
        if (!economy) return false;
        economy.submitQuest(def.id);
        return true;
      },
      grantItem: (key) => {
        if (key === "Invasion Voucher") state.addBoost("invasion_voucher");
        else if (key === "Golden Dice") state.addBoost("golden_dice");
        else state.receiveItem(key);
      },
      grantZombie: (key) => { grantEarnedZombie(key); },
      completed: (def) => celebrateQuest(def),
      requestAuthoritativeCompletionCheck: () => {
        // Some effects post their quest notification just before enqueueing their
        // semantic command. The microtask lets that stack finish, then drains both
        // pending and in-flight command lanes without treating the preview as truth.
        queueMicrotask(() => { void economy?.settleBeforeDependency().catch(() => {}); });
      },
      render: (views) => hud.setQuests(views),
    }
  );

  // Daily / weekly quests. The SAME generator runs on both sides of the build split:
  // offline this object is the authority (it generates the board, counts bus events
  // and pays the XP), online the server owns all three and this only draws what the
  // latest projection said. `authoritative` is what picks between the two.
  const periodicQuests = new PeriodicQuestSystem(
    state,
    // Seeds the roll. Online that is the account; offline the active profile's save
    // key, which is the only thing that is stable for the life of a local farm.
    () => (onlineFarm ? api.getSession()?.accountId ?? "anon" : profiles.activeSaveKey()),
    questBus,
    {
      authoritative: onlineFarm,
      submitClaim: (scope, questId, xp) => economy?.submitPeriodicQuestClaim(scope, questId, xp) ?? false,
      claimed: (text, xp) => hud.showToast(`${text} — +${xp} XP`),
      render: (views) => hud.setPeriodicQuests(views),
    }
  );
  hud.onPeriodicQuestClaim = (scope, questId) => periodicQuests.claim(scope, questId);
  // The panel's "Resets in …" is minute-resolution, and offline the day has to roll
  // over inside a long session rather than only at the next launch. One minute covers
  // both; nothing here is expensive enough to want a tighter or looser tick.
  setInterval(() => {
    periodicQuests.refresh();
    hud.setPeriodicQuests(periodicQuests.views());
  }, 60_000);

  // ---- consumable boosts: buy (into inventory) + use (apply farm effect) ----
  // Gift vouchers are "1 per farm": you can't buy/use one once you already own
  // that zombie OR already hold an (unused) voucher granting it. The check is keyed
  // by the RESULTING zombie, so ordinary and pink Cupid use independent one-copy
  // limits while duplicate vouchers for the same exact actor still share a limit.
  // A copy waiting in Received counts as owned (it just hasn't taken its Mausoleum
  // slot yet), so a full farm can't be used to redeem a second voucher for the same
  // unique. The server applies the same rule to `power.use`.
  const ownsGiftZombie = (giftKey: string) =>
    !!giftKey && (
      zombies.roster().some((z) => z.key === giftKey) ||
      state.received.some((entry) => parseReceivedZombie(entry)?.key === giftKey)
    );
  const holdsGiftVoucher = (giftKey: string) =>
    !!giftKey &&
    assets.boosts.some(
      (b) => b.effect === "gift" && b.giftZombieKey === giftKey && state.boostCount(b.key) > 0
    );
  const giftLimitReached = (boostKey: string) => {
    const gk = boostCatalog.get(boostKey)?.giftZombieKey ?? "";
    return !!gk && (ownsGiftZombie(gk) || holdsGiftVoucher(gk));
  };
  hud.giftLimitReached = giftLimitReached;

  function onlineGameplayBlocked(): boolean {
    return onlineFarm && !!economy && !economy.available;
  }

  hud.onBuyBoost = (def, qty = 1) => {
    if (onlineGameplayBlocked()) return 0;
    if (tutorial && !tutorial.allowsBoostPurchase(def.key)) return 0;
    if (def.effect === "gift" && giftLimitReached(def.key)) return 0; // 1 per farm
    if (def.effect === "gift") qty = 1; // a voucher run makes no sense — 1 per farm
    // Each pack is bought as its own atomic step with a fresh funds check, so a
    // balance that moved underneath the confirm dialog (harvests landing, the
    // farmer spending) shortens the run rather than overdrafting. Returns how many
    // packs were actually paid for.
    let bought = 0;
    for (let i = 0; i < qty; i++) {
      if (state.onInventory) {
        // ONLINE: the server prices the boost (exact catalog cost), debits currency,
        // and grants perPurchase — atomically, one command per pack. Affordability is
        // checked against the optimistically-updated balance first for instant
        // feedback; the server is the gate.
        const funds = def.brainsNeeded ? state.brains : state.gold;
        if (funds < def.cost) break;
        const optimistic = def.brainsNeeded
          ? { count: def.perPurchase, brains: -def.cost }
          : { count: def.perPurchase, gold: -def.cost };
        state.onInventory({ type: "buy", key: def.key }, optimistic);
      } else {
        const paid = def.brainsNeeded ? state.spendBrains(def.cost) : state.spendGold(def.cost);
        if (!paid) break;
        state.addBoost(def.key, def.perPurchase); // a purchase grants `perPurchase` uses
      }
      bought++;
    }
    if (bought > 0) audio.play("buy"); // once per run, not per pack
    return bought;
  };
  hud.onUseBoost = (def) => {
    if (onlineGameplayBlocked()) return;
    if (state.boostCount(def.key) <= 0) return;
    giftUnitId = null;
    powerGold = 0;
    powerXp = 0;
    if (!applyBoost(def)) return; // only consume if it did something
    // ONLINE: the server owns the count — decrement there (optimistic + reconcile).
    // A gift voucher redeems into a zombie, so it also carries the spawned unit's id:
    // the server consumes the voucher and files that unit in the roster atomically.
    if (state.onInventory) {
      const action = giftUnitId
        ? { type: "use" as const, key: def.key, unitId: giftUnitId }
        : powerUnitIds.length
          ? { type: "use" as const, key: def.key, localZombieHarvests: powerUnitIds }
        : growTarget
          ? { type: "use" as const, key: def.key, oc: growTarget.oc, or: growTarget.or }
          : { type: "use" as const, key: def.key };
      state.onInventory(action, { count: -1, gold: powerGold, xp: powerXp });
    } else state.useBoost(def.key);
    giftUnitId = null;
    powerUnitIds = [];
    growTarget = null;
    powerGold = 0;
    powerXp = 0;
  };
  hud.canUseBoost = (def) =>
    def.effect !== "plow" ||
    field.serialize().some((plot) => plot.state === "dirt" || plot.state === "hole");

  // The speed-grow (Insta-Grow) boost, exposed so the HUD can render the equippable
  // Grow tool (icon + live count) and the growing-crop info window can offer it.
  // Returns the boost def + a live count getter, or null if the catalog has no
  // grow boost.
  const GROW_BOOST_KEY = "insta_grow";
  const growBoostDef = () => boostCatalog.get(GROW_BOOST_KEY) ?? null;
  hud.getSpeedGrowBoost = () => {
    const def = growBoostDef();
    if (!def) return null;
    return { name: def.name, icon: `${BASE}assets/boosts/${def.icon}`, count: () => state.boostCount(def.key) };
  };

  /** The eligible Insta-Grow target beneath one world point. Resolve the 4x4 plot to
   * its origin so crossing several of its tiles during a drag still spends one use. */
  const instaGrowTargetAtWorld = (
    col: number, row: number, wx: number, wy: number,
  ): InstaGrowTarget | null => {
    const objectId = field.objectAtPoint(wx, wy);
    const selectedPot = objectId && field.objectDefOf(objectId)?.zombiePot
      ? zombies.potFor(objectId)
      : null;
    if (objectId && selectedPot?.busy && !selectedPot.ready)
      return { kind: "pot", instanceId: objectId };
    const origin = field.plotOriginAt(col, row);
    const crop = origin ? field.cropInfoAt(origin.oc, origin.or) : null;
    return origin && crop && !crop.ripe ? { kind: "crop", ...origin } : null;
  };

  // Ripen exactly one resolved crop or active Zombie Pot and spend one use. A stale
  // target is ignored, which makes backtracking and state changes during a stroke safe.
  // When the last use is spent the tool auto-unequips back to the select tool.
  const applyInstaGrowTarget = (target: InstaGrowTarget): boolean => {
    const def = growBoostDef();
    if (!def) return false;
    if (state.boostCount(def.key) <= 0) { hud.setMode("walk"); return false; }
    if (target.kind === "pot" && zombies.finishCombineNow(target.instanceId)) {
      if (state.onInventory) state.onInventory({ type: "use", key: def.key, target: "zombie_pot" }, { count: -1 });
      else state.useBoost(def.key);
      audio.play("instaGrow");
      const p = field.objectWorkPoint(target.instanceId);
      if (p) floatText(p.x, p.y - 48, "Ready!");
      saveManager.save();
      if (state.boostCount(def.key) <= 0) hud.setMode("walk");
      return true;
    }
    if (target.kind !== "crop") return false;
    const grown = field.growCropAt(target.oc, target.or);
    if (!grown) return false; // no longer growing -> keep tool equipped
    if (state.onInventory) state.onInventory({ type: "use", key: def.key, oc: grown.oc, or: grown.or }, { count: -1 });
    else state.useBoost(def.key);
    audio.play("instaGrow");
    const c = field.plotCenterOf(grown.oc, grown.or);
    floatText(c.x, c.y, "Grew!");
    if (state.boostCount(def.key) <= 0) hud.setMode("walk"); // used up -> unequip
    return true;
  };

  const tryInstaGrow = (col: number, row: number, wx: number, wy: number): boolean => {
    const target = instaGrowTargetAtWorld(col, row, wx, wy);
    return target ? applyInstaGrowTarget(target) : false;
  };

  // Set by applyBoost when a GIFT voucher spawns its zombie: the new unit's id, which
  // onUseBoost sends with the voucher `use` so the server can grant that same unit.
  // Null for every other boost effect.
  let giftUnitId: string | null = null;
  let powerUnitIds: { id: string; oc: number; or: number }[] = [];
  let growTarget: { oc: number; or: number } | null = null;
  // ONLINE: what a farm-wide power (Insta-Harvest / Insta-Plow) just paid out, summed
  // over every plot and tree it hit. The server owns these rewards, but sending them as
  // the power command's optimistic delta keeps the top-bar counters rising with the
  // per-plot popups instead of a beat later, on reconcile.
  let powerGold = 0;
  let powerXp = 0;

  // Apply a farm-usable boost's effect. Returns true if it actually did anything
  // (so a no-op — e.g. Insta-Harvest with nothing ripe — doesn't waste the boost).
  const applyBoost = (def: BoostDef): boolean => {
    const c = tileCenter(walk.tile.col, walk.tile.row); // float near the farmer
    if (def.effect === "grow") {
      const grown = field.growSomeCrops(def.amount || 1); // single-use: grows one crop
      growTarget = grown[0] ?? null;
      if (grown.length) { audio.play("instaGrow"); floatText(c.x, c.y, `Grew ${grown.length}!`); }
      return grown.length > 0;
    }
    if (def.effect === "harvest") {
      let harvested = 0;
      // Insta-Harvest is one atomic action: snapshot every zombie's neighbours so
      // harvesting a ripe adjacent vegetable earlier in this loop cannot erase it.
      const mutationContexts = new Map(field.ripePlots().filter((plot) => plot.isZombie)
        .map((plot) => [`${plot.oc}:${plot.or}`, field.zombieMutationContextAt(plot.oc, plot.or)]));
      for (const pl of field.ripePlots()) {
        if (pl.isZombie && !zombies.canHarvestZombie()) continue;
        const r = field.harvestAt(pl.oc, pl.or);
        if (!r) continue;
        state.recordHarvest(r.key, !!r.zombieKey);
        const cropCenter = field.plotCenterOf(pl.oc, pl.or);
        popHarvestIcon(r, cropCenter.x, cropCenter.y);
        // Every plot pays exactly what harvesting it by hand would (see JobSystem):
        // farmer-adjusted gold for a vegetable, XP for both kinds.
        const gold = r.zombieKey ? 0 : state.farmerHarvestGold(r.sell);
        const xp = harvestXp(r.xp, field.hasPlowFree());
        let harvestAliases: readonly string[] = [];
        if (state.onFarm) {
          if (r.zombieKey) {
            const context = mutationContexts.get(`${pl.oc}:${pl.or}`) ?? r.mutationContext!;
            const unit = zombies.spawnVerified(r.zombieKey, pl.oc + 1, pl.or + 1,
              offlineHarvestMutation(r.zombieKey, context));
            if (!unit) continue;
            harvestAliases = unitSubjectAliasesOf(unit);
            powerUnitIds.push({ id: unit.id, oc: pl.oc, or: pl.or });
          }
          // The server receives one semantic power command from onUseBoost below;
          // individual optimistic harvests must not become commands. Their totals
          // ride along as that command's optimistic delta so the counters move now.
        } else {
          if (gold) state.addGold(gold);
          state.addXp(xp);
          if (r.zombieKey) {
            const context = mutationContexts.get(`${pl.oc}:${pl.or}`) ?? r.mutationContext!;
            // spawnVerified, not spawn: the army may be full with the Mausoleum still
            // open (canHarvestZombie above passes on either), and plain spawn would
            // return null there — silently deleting a zombie whose crop is now spent.
            harvestAliases = unitSubjectAliasesOf(
              zombies.spawnVerified(r.zombieKey, pl.oc + 1, pl.or + 1,
                offlineHarvestMutation(r.zombieKey, context))
            );
          }
        }
        powerGold += gold;
        powerXp += xp;
        questBus.post(
          r.isZombie ? QuestEvent.ZombieHarvested : QuestEvent.CropHarvested,
          r.name, 1, harvestAliases
        );
        // Same hook the farmer's own harvests use, so an Insta-Harvest can lure a boss
        // too. The first plot to hit takes it: every later roll in this sweep sees an
        // event already running and stops.
        const bossToken = !r.isZombie && onCropHarvested(
          { key: r.key, growMs: r.growMs, value: r.sell }, cropCenter.x, cropCenter.y
        );
        // Each plot pops its OWN reward numbers, in this one frame, so the farm
        // reads as having been harvested all at once (as the original game did).
        if (r.zombieKey) {
          floatText(cropCenter.x, cropCenter.y, `+${xp}xp`);
        } else {
          floatText(cropCenter.x, cropCenter.y, `+${gold}g${r.fertilized ? " ×2" : ""}`);
          if (xp) floatText(cropCenter.x, cropCenter.y, `+${xp}xp`, 0.42);
          if (bossToken) floatText(cropCenter.x, cropCenter.y, "+1 Boss Token!", xp ? 0.84 : 0.42);
        }
        harvested++;
      }
      // Trees are part of the same immediate, farm-wide activation. Online, the
      // single power command below awards them authoritatively; locally we mirror
      // the normal tree harvest's gold, quest event, and regrow timer.
      for (const id of field.ripeTreeIds()) {
        const treeDef = field.objectDefOf(id);
        const treeAt = field.objectWorkPoint(id);
        const baseGold = field.harvestObject(id);
        if (!treeDef || baseGold === null) continue;
        state.recordTreeHarvest();
        const gold = state.farmerHarvestGold(baseGold);
        if (!state.onFarm) state.addGold(gold);
        powerGold += gold;
        questBus.post(QuestEvent.CropHarvested, treeDef.name);
        if (treeAt) floatText(treeAt.x, treeAt.y, `+${gold}g`);
        harvested++;
      }
      if (harvested) floatText(c.x, c.y, `Harvested ${harvested}!`);
      return harvested > 0;
    }
    if (def.effect === "plow") {
      const plowed = field.replowSpent();
      const xp = plowXp(field.hasPlowFree());
      // The boost replaces only the gold cost: its XP matches the same plots being
      // plowed manually. Online the server credits it authoritatively; the total
      // rides along as the power command's optimistic delta (see onUseBoost).
      if (plowed.length && !state.onInventory) state.addXp(xp * plowed.length);
      powerXp += xp * plowed.length;
      for (const pl of plowed) {
        state.recordPlowed();
        questBus.post(QuestEvent.SoilPlowed, "Plow");
        questBus.post(QuestEvent.NewSoilPlowed, "Plow");
        // Same as harvest: every plot shows its own reward in this one frame.
        const at = field.plotCenterOf(pl.oc, pl.or);
        floatText(at.x, at.y, "Plowed!");
        if (xp) floatText(at.x, at.y, `+${xp}xp`, 0.42);
      }
      if (plowed.length) floatText(c.x, c.y, `Plowed ${plowed.length}!`);
      return plowed.length > 0;
    }
    if (def.effect === "gift") {
      if (!def.giftZombieKey) return false;
      // 1 per farm: don't spawn a duplicate of a gift zombie you already own.
      if (ownsGiftZombie(def.giftZombieKey)) { floatText(c.x, c.y, `Already have ${def.name}!`); return false; }
      if (!zombieDefs.has(def.giftZombieKey)) return false;
      // ONLINE, the voucher `use` grants this unit server-side, so spawn it verified
      // (no onGrant) and hand its id to onUseBoost to send. A full active farm files
      // the award in Received instead — the server does exactly the same, and reports
      // no created id for it, so `giftUnitId` must stay null on that path.
      // The server re-checks the catalog key, voucher count, and 1-per-farm rule.
      const unit = grantEarnedZombie(def.giftZombieKey);
      giftUnitId = unit?.id ?? null;
      floatText(c.x, c.y, unit ? `Got ${def.name}!` : `${def.name} sent to Received!`);
      return true;
    }
    // concentration / dice are spent on the Invade screens, not on the farm.
    floatText(c.x, c.y, "Used during invasions");
    return false;
  };

  // Restore a prior farm (currencies, XP, plots, crops-with-offline-growth, farmer
  // position) if one exists, then start autosaving. Load before the loop so the
  // restored farm shows on the first frame.
  const saveManager = new SaveManager(
    state, field, walk, zombies, quests, catalog, placeCatalog,
    (sprite) => ensureObjectTexture(assets, sprite),
    playMode,
    jobs,
  );
  saveManager.periodicQuests = periodicQuests;
  saveManager.onStorageError = (message) => hud.showToast(message);
  // Same treatment for the audio settings: a device that won't keep them is the one
  // thing that makes a volume change look like it worked and silently undoes it.
  audio.onStorageError = (message) => hud.showToast(message);
  // ...and for the display/controls preferences, which are the ones a player is most
  // likely to change and least likely to notice reverting until the next launch.
  setPrefStorageErrorHandler((message) => hud.showToast(message));
  // The online layer's live state, for the diagnostics report. A paused farm and a
  // healthy one look identical in a paste without this — which is exactly what made the
  // two "Gameplay paused — reconnect to continue" reports so expensive: the account data
  // said the lease was live and being renewed, and nothing on the client's side of the
  // story was recoverable at all. `recovery` answers the one question that matters, which
  // is whether anything is still trying.
  hud.getDiagnosticExtras = (): Record<string, string> => {
    if (!economy) return {};
    // `writer` is the availability chain in the order it fails: the browser lock this
    // document holds, then the server credential it was issued, then whether that
    // credential still agrees with the client key on disk. A drift there refuses every
    // command batch forever while every other signal looks healthy.
    const identity = api.writerIdentityState();
    return {
      gameplay: economy.available ? "available" : `unavailable (${economy.unavailableReason})`,
      recovery: economy.recoveryState,
      writer: [
        api.hasLocalWriterLock() ? "lock held" : "NO LOCK (another tab?)",
        api.hasWriterCredential() ? "credential held" : "no credential",
        identity ? `identity ${identity}` : "identity unknown",
      ].join(", "),
    };
  };
  jobs.onQueueChanged = () => saveManager.checkpointJobs();

  // Pixi's ticker is requestAnimationFrame-driven and may stop completely when
  // the tab/window is backgrounded. Keep a separate monotonic clock for just the
  // queued farm-job pipeline. If frames are merely throttled, each sparse frame
  // advances the missing time; if they stop, the first focus/visible event does.
  // Nothing else (notably raids) receives this elapsed time.
  let lastJobAdvanceAt = Date.now();
  const advanceFarmJobsToNow = (forceSilent = false) => {
    const now = Date.now();
    const elapsed = (now - lastJobAdvanceAt) / 1000;
    // A throttled/hidden tab can complete several queued jobs in one catch-up.
    // Do that work silently so their independent one-shots do not all burst at once.
    jobs.advanceElapsed(elapsed, forceSilent || elapsed > 0.25);
    lastJobAdvanceAt = now;
  };

  // Battles suspend the farm queue and JobSystem replays the suspended span on the way
  // out (see JobSystem.setPaused), so the two clocks have to be handed off cleanly.
  // Re-baseline this one at each edge: while paused it accumulates a gap it will never
  // apply, and a tab frozen through the whole invasion would otherwise hand that same
  // span back a second time on the first frame after the result panel closes.
  const pauseFarmJobs = () => { advanceFarmJobsToNow(); jobs.setPaused(true); };
  const resumeFarmJobs = () => { advanceFarmJobsToNow(); jobs.setPaused(false); lastJobAdvanceAt = Date.now(); };

  // Visit mode: if a friend farm was requested (via enterVisit → reload), hydrate
  // THEIR read-only save into these fresh singletons and — crucially — never call
  // enableAutosave(). The player's own save is never loaded in this mode, so a
  // visit cannot read, write, or corrupt it. On any fetch failure we clear the
  // target and fall through to a normal load, so the player always lands on their
  // own farm.
  // A visit target stashed before the closedown began would otherwise send this load
  // into a friend's read-only farm instead of the export handoff — the player would
  // have to work out that "leave farm" is the way to reach their own export. Visiting
  // is meaningless during a closedown, so drop the target and go collect their farm.
  if (exportOnlyFarm) clearVisitTarget();
  const visitTarget = onlineFarm && !exportOnlyFarm ? getVisitTarget() : null;
  let visiting = false;
  let visitError = "";
  let restored = false;
  if (visitTarget) {
    try {
      const { save } = await api.getFriendSave(visitTarget.id);
      // Defense in depth: a friend's farm is server-validated on write, but the
      // visitor re-checks the dimensions before hydrating so a malformed/extreme
      // save can never drive an oversized field allocation here. (See SECURITY.md
      // finding #9 — malicious saves attacking visitors.)
      const w = save?.farm?.w, h = save?.farm?.h;
      const MAX_VISIT_DIM = 128;
      const okDim = (n: unknown) =>
        typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_VISIT_DIM;
      if (!okDim(w) || !okDim(h)) throw new api.ApiError(422, "bad_farm");
      displayedFarmBackground = isFarmBackground(save.farm.background)
        ? save.farm.background
        : DEFAULT_FARM_BACKGROUND;
      await saveManager.hydrateReadOnly(save);
      state.seedFarmerCatalog(assets.farmer);
      applyFarmerAppearance();
      visiting = true;
      console.log(`[visit] viewing ${visitTarget.name}'s farm (read-only)`);
    } catch (e) {
      clearVisitTarget();
      visitError = e instanceof api.ApiError ? e.code : "error";
      console.warn("[visit] could not open friend's farm:", visitError);
    }
  }
  if (!visiting) {
    let loadResult = await saveManager.load();
    if (loadResult.kind === "online-unavailable") {
      await showOnlineUnavailable(
        async () => {
          loadResult = await saveManager.load();
          return loadResult.kind !== "online-unavailable";
        },
        () => {
          setPreferredPlayMode("local");
          location.reload();
        },
      );
    }
    if (loadResult.kind === "local-unavailable") {
      await showLocalUnavailable(
        async () => {
          loadResult = await saveManager.load();
          return loadResult.kind !== "local-unavailable";
        },
        () => {
          saveManager.suspend();
          saveManager.clear();
          location.reload();
        },
      );
    }
    restored = loadResult.kind === "local-existing" ||
      loadResult.kind === "online-cached" ||
      (loadResult.kind === "online-authoritative" && loadResult.restored);
    if (loadResult.kind === "online-cached") hud.setPlayStatus("online", "cached");
    else if (loadResult.kind === "online-authoritative") hud.setPlayStatus("online", "synced");
    // The foliage was initially built before the signed-in presentation arrived.
    // Reapply its saved density to both the live scene and device preference.
    const restoredBackground = saveManager.loadedFarmBackground;
    if (isFarmBackground(restoredBackground)) {
      displayedFarmBackground = restoredBackground;
      setFarmBackground(restoredBackground);
      buildFoliage();
    }
    state.seedFarmerCatalog(assets.farmer);
    applyFarmerAppearance();
    if (!restored) quests.restore(); // fresh farm: activate the opening quests
    // Same for the daily/weekly board. A restored save installs its own through
    // SaveManager; a fresh farm has none, and without this the panel would stay empty
    // until the next event happened to roll it over.
    if (!restored) periodicQuests.restore();
    // Closedown handoff. The farm is now hydrated from the server — which is the only
    // way to serialise an Online Farm, since one keeps no full blob on the device — so
    // this is the earliest point the export can be produced, and the latest point that
    // is still before autosave, the economy client, and the game loop start. The screen
    // never resolves: every button downloads or reloads.
    if (exportOnlyFarm) {
      boot?.close();
      await showExportOnly({
        notice: service.notice,
        // `/bootstrap` failed and the load fell back to this device's cached snapshot.
        // Exporting that is still better than nothing, but it may be missing recent
        // progress, and a player must not find that out afterwards.
        cachedFrom: loadResult.kind === "online-cached" ? loadResult.savedAt : null,
        retryAuthoritative: async () => {
          const retry = await saveManager.load();
          return retry.kind === "online-authoritative";
        },
        exportRaw: async () => {
          saveManager.flushCritical();
          return saveManager.exportOnline();
        },
        // Byte-for-byte the file Settings' Export writes, and the only thing Local
        // Farm's Import accepts — one export format, one import path.
        download: (raw) => downloadSaveFile(raw, "online"),
        openLocal: () => {
          setPreferredPlayMode("local");
          location.reload();
        },
      });
    }
    // Repair a cap the save disagrees with. A local save carries the number rather
    // than deriving it, so any farm drifted by the old accumulate-as-you-go handling
    // — most visibly a Zombie Monolith standing on the farm whose +4 was never
    // counted — comes back wrong and stays wrong. Deriving it here settles it once,
    // and every placement path keeps it settled from then on.
    refreshArmyCap();
    // Same repair for the shed. Its capacity used to be carried in the save and only
    // ever raised, so any farm whose file understates it — an imported Online Farm
    // export above all, since the bootstrap projection had no capacity to project —
    // came back showing eight slots with a McDonnell's Barn standing on it.
    refreshShedCap();
    saveManager.enableAutosave();
    // Backfill newly-added presentation fields (such as woodland density) even
    // when an existing player does not immediately change another farm value.
    saveManager.save();
    console.log(
      loadResult.kind === "online-cached"
        ? `[save] showing cached Online Farm from ${new Date(loadResult.savedAt).toISOString()}`
        : restored ? "[save] restored existing farm" : "[save] fresh farm"
    );
  }
  // Server-authoritative currency (online, own-farm only). Wire the money hook so
  // every gold/brains/xp change mirrors to the server ledger, then start() adopts
  // the authoritative balance (server wins over the just-loaded blob). Offline or
  // while visiting, `economy` stays null and currency is purely local as before.

  /** Put a gameplay pause into the diagnostics buffer Settings can copy.
   *
   *  A paused farm is the one failure a player cannot work around, and the branch that
   *  caused it lived only in a toast and a console line — both gone by the time they
   *  write the report, which is usually after a reload. The composite reason
   *  (`state_conflict/q3/nocred`) is the whole diagnosis, so it belongs somewhere
   *  durable.
   *
   *  Deduped on that composite: several paths pause in quick succession, and the tap
   *  handler asks on EVERY tap while paused. Without this the 50-entry buffer would be
   *  50 copies of one pause, pushing out the error that explains it. */
  let lastRecordedPause = "";
  const recordPause = (reason: string): void => {
    const detail = `${reason} | ${economy?.unavailableReason ?? ""}`;
    if (detail === lastRecordedPause) return;
    lastRecordedPause = detail;
    recordDiagnostic({
      at: Date.now(), kind: "error", where: "gameplay-paused",
      message: `gameplay paused: ${detail}`,
    });
  };

  hud.onEquipFarmerHead = (head) => {
    if (economy && !economy.submitFarmerEquip(head.id)) return;
    state.equipFarmerHead(head.id);
  };
  hud.onEquipFarmerBody = (body) => { state.equipFarmerBody(body.id); };
  hud.onEquipFarmerBonusHead = (headId) => {
    if (economy && !economy.submitFarmerBonus(headId)) return;
    state.equipFarmerBonusHead(headId);
  };
  hud.onBuyFarmerHead = (head) => {
    const cost = head.cost ?? 0;
    if (!cost) {
      state.unlockFarmerHead(head.id, head.bodyId);
      state.equipFarmerHead(head.id);
      return true;
    }
    const currency = head.brains ? "brains" : "gold";
    if ((currency === "brains" ? state.brains : state.gold) < cost) return false;
    // Buying a head pays out XP scaled off its price, exactly as buying a Market
    // object or a pet does. Online the server recomputes it from the same catalog
    // row; the optimistic amount here only decides what the bar shows meanwhile.
    const xp = farmerHeadXp(head);
    if (economy) {
      if (!economy.submitFarmerBuy(head.id, currency, cost, xp)) return false;
    } else {
      const paid = currency === "brains"
        ? state.spendBrains(cost, "purchase")
        : state.spendGold(cost, "purchase");
      if (!paid) return false;
      if (xp > 0) state.addXp(xp, "purchase");
    }
    state.unlockFarmerHead(head.id, head.bodyId);
    state.equipFarmerHead(head.id);
    economy?.submitFarmerEquip(head.id);
    // Bought from inside the Market modal, so the world-space float would be
    // hidden behind it — the toast is the visible half (see showPurchaseXp).
    showPurchaseXp(xp);
    return true;
  };
  hud.onEquipPet = (pet) => {
    const key = pet?.key ?? null;
    if (visiting) return;
    if (economy && !economy.submitPetEquip(key)) return;
    state.equipPet(key);
  };
  hud.onSetPenPets = (pets) => {
    const keys = pets.map((pet) => pet.key);
    if (economy && !economy.submitPenPets(keys)) return;
    state.setPenPets(keys);
  };
  hud.onBuyPet = (pet) => {
    if (visiting || state.level < pet.level || !pet.brains || state.brains < pet.cost) return false;
    if (economy) {
      if (!economy.submitPetBuy(pet.key, pet.cost, pet.xp)) return false;
    } else if (!state.spendBrains(pet.cost, "purchase")) {
      return false;
    } else if (pet.xp > 0) {
      state.addXp(pet.xp, "purchase");
    }
    state.unlockPet(pet.key);
    showPurchaseXp(pet.xp);
    return true;
  };
  const storedObjectIds = new Map<string, string[]>();
  const objectPurchases = new Map<string, { cost: number; currency: "gold" | "brains" }>();
  /** The instance id of one stored copy of `key` — what both the retrieve and sell
   *  paths act on. Online that identity is the server's and comes from the object
   *  reconcile below; offline the save carries counts only, so it is minted on first
   *  use (otherwise a reloaded local shed holds items that can't be placed or sold). */
  const storedInstanceId = (key: string): string | undefined =>
    economy
      ? storedObjectIds.get(key)?.[0]
      : ensureLocalStoredIds(state, storedObjectIds, key, () => `stored-${crypto.randomUUID()}`);
  if (!visiting && onlineFarm) {
    let authoritativeObjectIds = new Set<string>();
    const acct = api.getSession()?.accountId ?? "anon";
    economy = new EconomyClient(state, acct, { requireReady: true });
    economy.onAuthoritativeSettled = (serverTime) => {
      // Let synchronous projection listeners finish rebuilding Field/Zombie state
      // before serializing the read-only reconnect snapshot.
      queueMicrotask(() => {
        saveManager.reconcileObjectLayouts(authoritativeObjectIds);
        saveManager.save();
        saveManager.cacheAuthoritativeSnapshot(serverTime);
      });
    };
    economy.onPendingChange = (pending) =>
      hud.setPlayStatus("online", pending > 0 ? "saving" : "synced", pending);
    // The sync badge is a button: a press sends the waiting batch immediately. A press
    // while one is already on the wire is ignored, so it cannot be spammed into extra
    // requests; the badge itself is the feedback (SAVING (n) → SYNCED as it lands).
    hud.onSyncRequested = () => {
      const outcome = economy!.syncNow();
      if (outcome === "idle") hud.showToast("Everything is synced.");
      else if (outcome === "paused") hud.showToast("Reconnecting to your farm…");
    };
    // This tab's JS and the deployed Worker disagree about the raid ruleset, so every
    // invasion would be refused at /raid/start. Tell the player up front — the fix is a
    // reload, and finding that out before committing an army is far better than after.
    economy.onRulesetSkew = (serverVersion, clientVersion) => {
      console.warn("[raid] ruleset skew", { serverVersion, clientVersion });
      promptReload("The game has updated. Reload to keep raiding.");
    };
    state.canMutateOnline = () => economy!.available;
    state.onMoney = (currency, delta, reason) => economy!.record(currency, delta, reason);
    // Veggie plant/harvest go through the server's EXACT economics engine instead of
    // mutating gold/xp locally (JobSystem checks state.onFarm).
    state.onFarm = (action, optimistic) => economy!.submitFarm(action, optimistic);
    // Boost buy/use/grant go through the server-owned inventory (the presence of this
    // hook is what tells the game "boosts are server-owned"); counts reconcile like
    // currency, so the blob's boost list becomes an ignored cache.
    state.onInventory = (action, optimistic) => economy!.submitInventory(action, optimistic);
    state.onTreeHarvest = (instanceId, gold) => economy!.submitTreeHarvest([instanceId], gold);
    // Reconciliation also adopts fertilization from another/restored client. A crop
    // rolled here is already marked, so markFertilized prevents duplicate FX.
    economy.onCropFertilized = (oc, or) => {
      if (field.markFertilized(oc, or)) {
        zombies.animateFertilize(oc, or);
        const c = tileCenter(oc, or);
        floatText(c.x, c.y - 18, "Fertilized!");
      }
    };
    economy.onFarmState = (farmState) => {
      const authoritative = [
        ...farmState.plowed.map((p) => ({ oc: p.oc, or: p.pr, state: "plowed" as const })),
        ...(farmState.spent ?? []).map((p) => ({
          oc: p.oc,
          or: p.pr,
          state: p.zombie ? "hole" as const : "dirt" as const,
        })),
        ...farmState.crops.map((p) => ({
          oc: p.oc,
          or: p.pr,
          state: "planted" as const,
          crop: {
            key: p.crop_key,
            isZombie: zombieDefs.has(p.crop_key),
            plantedAt: p.planted_at,
            growMs: p.grow_ms,
            fertilized: !!p.fertilized,
          },
        })),
      ];
      const occupied = new Set(authoritative.map((p) => `${p.oc}:${p.or}`));
      const presentation = field.serialize().filter(
        (p) => (p.state === "dirt" || p.state === "hole") && !occupied.has(`${p.oc}:${p.or}`)
      );
      field.reconcilePlots([...presentation, ...authoritative], (key) => catalog.get(key));
    };
    let objectReconcileGeneration = 0;
    /** Server objects the farm has no room to re-home — warned about once each, so a
     *  full farm does not repeat the same toast on every reconcile. */
    const rehomeWarned = new Set<string>();
    economy.onObjectState = async (objects, aliases, baseZombieMax, rejectedLocalIds) => {
      authoritativeObjectIds = new Set(objects.map((object) => object.instanceId));
      const generation = ++objectReconcileGeneration;
      for (const id of rejectedLocalIds) field.removeObject(id);

      // The purchase + shed projections read only `objects`, never the field, so run
      // them BEFORE the texture-loading loop below. Anything after that loop is skipped
      // whenever a newer reconcile supersedes this one, and the shed must not be left
      // reading empty just because an object swapped catalog keys (a shed upgrade).
      objectPurchases.clear();
      for (const object of objects) {
        if (object.purchaseCost === undefined || object.purchaseCurrency === undefined) continue;
        objectPurchases.set(object.instanceId, { cost: object.purchaseCost, currency: object.purchaseCurrency });
      }

      storedObjectIds.clear();
      for (const object of objects) {
        if (object.status !== "stored") continue;
        const ids = storedObjectIds.get(object.catalogKey) ?? [];
        ids.push(object.instanceId);
        storedObjectIds.set(object.catalogKey, ids);
      }
      state.syncObjectStorage(Object.fromEntries([...storedObjectIds].map(([key, ids]) => [key, ids.length])));

      // Load every texture this pass can need BEFORE touching the field. This loop used
      // to await mid-iteration, which let a newer pass supersede it half-applied and made
      // the alias map unusable at exactly the point it was still needed. With the awaits
      // hoisted, everything below is synchronous and cannot interleave.
      const sprites = new Set<string>();
      for (const object of objects) {
        if (object.status !== "placed") continue;
        const def = placeCatalog.get(object.catalogKey);
        if (!def) continue;
        for (const file of objectSpriteFiles(def)) sprites.add(file);
      }
      await Promise.allSettled([...sprites].map((sprite) => ensureObjectTexture(assets, sprite)));
      if (generation !== objectReconcileGeneration) return false; // superseded: keep the aliases
      // A sprite whose download failed would otherwise be placed as an EMPTY texture: an
      // invisible object still holding its tiles against every future placement. Skip it
      // and let the next reconcile retry the download.
      const textureReady = (def: PlaceableDef) => {
        const optional = new Set(objectAnimFiles(def)); // motion, not the object
        return objectSpriteFiles(def).every((file) => optional.has(file) || !!assets.objects[file]);
      };

      const current = new Map(field.serializeObjects().map((object) => [object.id, object]));
      /** Local objects already adopted by a server object in this pass. */
      const claimedSources = new Set<string>();
      /** Placed server objects that no local object is holding a position for. */
      const orphans: { instanceId: string; def: PlaceableDef; readyAt?: number }[] = [];

      for (const object of objects) {
        const localId = aliases[object.instanceId];
        const source = current.get(object.instanceId) ?? (localId ? current.get(localId) : undefined);
        // `current` is a snapshot, so it keeps resolving a local object after that
        // object has been renamed to a server instance id. Two server objects aliased to
        // the SAME local id would therefore both be placed on its tile — stacking, and
        // displacing whatever legitimately stood there (this is how a Zombie Pot could
        // vanish from the farm while the server still owned it). One claim per local
        // object: a loser is skipped, and a reload rebuilds it from the server list.
        if (source && claimedSources.has(source.id)) continue;
        if (object.status !== "placed") {
          if (current.has(object.instanceId)) field.removeObject(object.instanceId);
          if (localId && current.has(localId)) field.removeObject(localId);
          continue;
        }
        const direct = current.get(object.instanceId);
        if (direct?.key === object.catalogKey) {
          claimedSources.add(direct.id); // already itself: no other object may adopt it
          if (object.readyAt !== undefined) field.syncObjectReadyAt(object.instanceId, object.readyAt);
          continue;
        }
        const def = placeCatalog.get(object.catalogKey);
        if (!def || !textureReady(def)) continue;
        if (!source) {
          orphans.push({ instanceId: object.instanceId, def, readyAt: object.readyAt });
          continue;
        }
        claimedSources.add(source.id);
        field.removeObject(source.id);
        if (!field.placeObject(def, source.oc, source.or, object.instanceId, object.readyAt,
          savedTurn(def, source))) {
          // Its remembered tile is taken (a stale layout entry can collide with a live
          // object). Re-home it below rather than let it fall off the farm.
          orphans.push({ instanceId: object.instanceId, def, readyAt: object.readyAt });
        }
      }

      // Anything the server still owns as placed but that nothing on the farm holds a
      // position for is otherwise unreachable forever: the presentation layout is written
      // from the field, so an object missing from the field is missing from the next save
      // too. Give it a real tile so it becomes visible, movable, and persisted again.
      //
      // This runs even when the farm is otherwise empty. Gameplay objects and the
      // presentation blob arrive in the SAME bootstrap response, so "no positions at all"
      // cannot mean a half-loaded save — it means those positions are genuinely gone, and
      // a real tile beats an invisible object the player has already paid for.
      for (const orphan of orphans) {
        const spot = field.findFreeOrigin(orphan.def);
        if (!spot) {
          if (!rehomeWarned.has(orphan.instanceId)) {
            rehomeWarned.add(orphan.instanceId);
            hud.showToast(`No room to put your ${orphan.def.name} back — clear a space and it will reappear.`);
          }
          continue;
        }
        field.placeObject(orphan.def, spot.oc, spot.or, orphan.instanceId, orphan.readyAt);
        rehomeWarned.delete(orphan.instanceId);
      }
      // Persist the recovered positions immediately: a reload before the next autosave
      // would drop them straight back into the state this just repaired.
      if (orphans.length) saveManager.flushCritical();

      // The server's own base wins from here on, so an offline-default client and an
      // account whose base the server later changes agree on what the objects add to.
      serverArmyBase = baseZombieMax;
      const placed = [...field.placedKeys()];
      state.syncCapacities(
        armyCapacityOf(serverArmyBase, placed, (key) => placeCatalog.get(key)?.armyMax),
        shedCapacityOf(placed, (key) => placeCatalog.get(key)?.storageSlots),
      );
      return true; // aliases consumed — EconomyClient may drop them
    };
    economy.onRosterState = (roster, aliases, settled) => {
      const pots = zombies.reconcileServerPots(roster, settled);
      for (const pot of pots.live) {
        economy!.restoreCombineParents(pot.potId, pot.parentAId, pot.parentBId, pot.playerLevel);
      }
      if (pots.retired.length) {
        // The job was a local fiction: the server holds no reservation for it, so its
        // parents are ordinary roster units again and the reconcile below will show
        // them. Persist immediately so a reload cannot resurrect the phantom Pot.
        hud.showToast(pots.retired.length > 1
          ? "Some Zombie Pot combines could not be confirmed — those zombies are back on your farm."
          : "That Zombie Pot combine could not be confirmed — your zombies are back on your farm.");
        saveManager.flushCritical();
      }
      const hidden = new Set(zombies.pendingPotParents().flatMap((pot) => [pot.parentAId, pot.parentBId]));
      zombies.reconcileServerRoster(roster.filter((unit) => !hidden.has(unit.id)), aliases);
    };
    economy.onRaidRevival = (offer, brains) => {
      const current = new Map(zombies.roster().map((zombie) => [zombie.id, zombie]));
      const casualties = offer.zombies.flatMap((snapshot) => {
        const cached = current.get(snapshot.id);
        if (cached) return [{ ...cached }];
        const def = zombieDefs.get(snapshot.key);
        return def ? [makeOwned(
          snapshot.id,
          def,
          walk.tile.col,
          walk.tile.row,
          snapshot.invasions,
          snapshot.mutation
        )] : [];
      });
      const views = casualties.map((zombie) => ({
        id: zombie.id,
        key: zombie.key,
        name: zombie.name,
        typeName: zombie.typeName,
        portrait: zombiePortrait(zombie.key),
        mutation: zombie.mutation,
        color: zombie.color,
      }));
      hud.openZombieRevival(views, brains, async (reviveIds) => {
        const revived = await economy!.resolveRaidRevival(offer.sessionId, reviveIds);
        const accepted = new Set(revived.revivedIds);
        zombies.reviveCasualties(casualties.filter((zombie) => accepted.has(zombie.id)));
        saveManager.save();
        return true;
      });
    };
    // Server-owned roster: seed the shadow from the current units, then report every
    // post-load create (grant) / casualty + combined parent (casualty), and route a
    // SELL through the server (it prices + credits it, rejecting a unit it doesn't own
    // — so a fabricated zombie can't be cashed out). Seed + go-live before wiring the
    // hooks so restoring the save doesn't re-emit grants.
    void economy.syncRoster(zombies.seedData());
    zombies.onGrant = (u) => economy!.submitRoster({ type: "grant", unitId: u.id, key: u.key, mutation: u.mutation, invasions: u.invasions });
    zombies.onCasualty = (ids) => economy!.submitRoster({ type: "casualty", unitIds: ids });
    // Combine goes through its own server ops so the result is validated against the two
    // parents (a combine can't fabricate an arbitrary expensive result).
    zombies.onCombineStart = (potId, parentAId, parentBId) =>
      economy!.submitRoster({ type: "combineStart", potId, parentAId, parentBId, playerLevel: state.level });
    zombies.onCombineCollect = (potId, unitId, key, mutation, stored) =>
      economy!.submitRoster({ type: "combineCollect", potId, unitId, key, mutation, stored });
    for (const pot of zombies.pendingPotParents()) {
      economy.restoreCombineParents(pot.potId, pot.parentAId, pot.parentBId, pot.playerLevel);
    }
    zombies.setRosterLive();
    state.onRosterSell = (unitId, value) => economy!.submitRoster({ type: "sell", unitId }, { gold: value });
    // Server-owned placeable objects: seed the ownership counts from the currently-placed
    // objects (one-time, so already-placed placeables stay refundable), then buy/refund
    // route through the server at their call sites (object buy + sellObject).
    void economy.syncObjects(field.objectKeyCounts());
    // Server-owned soil: import this save's already-plowed plots (one-time). Without it
    // the server would reject planting on soil this client shows as tilled — and won't
    // let the player re-till, since re-tilling only applies to harvested dirt/holes.
    void economy.syncFarm(field.plowedPlotOrigins());
    // Server-owned farm size + climate skins: adopt the authoritative values (a resize
    // reverts a rejected purchase; a save-edited larger farm shrinks to the server's).
    economy.onShopState = (size, climates) => {
      if (size !== field.w) {
        field.resizeAuthoritative(size, size);
        syncWorldToFarm();
        clampCamera();
      }
      state.ownedClimates = ["grass", ...climates.filter((t) => t !== "grass")];
    };
    economy.onFarmerState = (headIds, equippedHeadId, bonusHeadId) =>
      state.syncFarmerOwnership(headIds, assets.farmer, equippedHeadId, bonusHeadId);
    economy.onPetState = (ownedPets, activePet, penPets) => state.syncPetOwnership(ownedPets, activePet, penPets);
    economy.onQuestState = (serverState) => quests.restoreAuthoritative(serverState);
    economy.onQuestChanges = (changes) => quests.applyAuthoritativeChanges(changes);
    economy.onPeriodicQuestState = (serverState) => periodicQuests.adoptAuthoritative(serverState);
    economy.onTutorialState = (rewarded) => {
      if (!rewarded) return;
      state.setTutorial(reconcileTutorialCompletion(state.tutorial, true));
      tutorial?.completeFromAuthority();
    };
    // The reason is the only thing that distinguishes "the network blipped" from a
    // lease, protocol or envelope problem that will never clear on its own. It used
    // to be dropped on the floor, so a paused farm looked identical whatever caused
    // it and every player report read as "my internet is fine". Keep it in the toast
    // and on the console so a screenshot names the branch.
    economy.onGameplayUnavailable = (reason) => {
      hud.setPlayStatus("online", "reconnecting");
      hud.showToast(`Online gameplay paused (${reason}) — reconnecting to your farm.`);
      console.warn(`[zf] gameplay paused: ${reason} | ${economy?.unavailableReason}`);
      // Also into the diagnostics buffer, which is what Settings > Diagnostics > Copy
      // hands to a bug report. The console line above is gone the moment the tab is
      // closed, and a player reporting "gameplay paused" is usually reporting it after
      // a reload — so the branch that caused it was the one thing the report could
      // never carry. Deduped in recordPause: several paths pause in quick succession.
      recordPause(reason);
    };
    const showWriterLock = () => {
      saveManager.setOnlineWritable(false);
      hud.showWriterLock(async () => {
        if (!await economy!.takeOver()) return false;
        window.location.reload();
        return true;
      });
    };
    economy.onWriterReplaced = showWriterLock;
    economy.onWriterOwned = () => {
      saveManager.setOnlineWritable(true);
      saveManager.restoreOnlineJobs();
    };
    economy.onWriterAvailable = () => {
      hud.setPlayStatus("online", "synced");
      hud.hideWriterLock();
    };
    economy.onCommandRejected = (command, error) => {
      // A refused Boss Token grant means the event it belonged to has just ended, and
      // the run projection already carries the correction. There is nothing the player
      // could have done differently, so it passes without a rollback toast.
      if (command?.type === "epicBoss.token") return;
      if (command?.type === "roster.combine_start") {
        zombies.cancelCombine(command.potId);
        saveManager.flushCritical();
      }
      if (command?.type === "roster.combine" && command.potId &&
          zombies.rollbackCombineCollection(command.potId)) {
        economy!.restoreCombineParents(
          command.potId,
          command.parentAId,
          command.parentBId,
          command.playerLevel,
        );
        saveManager.flushCritical();
      }
      // A refused purchase has to take the object back off the farm. tryPlaceObject
      // places optimistically and the object reconcile only ever ADDS what the server
      // owns, so a rejected buy used to leave a phantom behind: paid for by nobody,
      // granted no XP, and still sellable — which is how "I couldn't afford a second
      // one but it let me keep placing them" turned into free decor. Reverse it here,
      // the same way sellObject does, and let the reconcile recompute capacities.
      if (command?.type === "object.buy" && command.clientInstanceId) {
        const id = command.clientInstanceId;
        const def = field.objectDefOf(id);
        if (def) {
          field.removeObject(id);
          refreshArmyCap();
          objectPurchases.delete(id);
          saveManager.flushCritical();
        }
      }
      const subject = command?.type.startsWith("roster.") ? "Zombie action"
        : command?.type.startsWith("object.") ? "Object action"
        : command?.type.startsWith("storage.") ? "Reward action"
        : command?.type.startsWith("farm.") ? "Farm action"
        : command?.type.startsWith("power.") ? "Boost action" : "Action";
      const reason: Record<string, string> = {
        not_owned: "the item is no longer available", capacity_full: "capacity is full",
        none_owned: "the reward is no longer available", stack_full: "the inventory stack is full",
        army_full: "the farm is full", storage_full: "storage is full",
        shed_full: "the shed is full",
        not_grown: "the crop is not ready", nothing_planted: "the crop changed",
        not_plowed: "the soil is no longer plowed", plot_occupied: "the plot already contains a crop",
        insufficient: "there are not enough funds", no_effect: "the game state changed",
        prior_command_failed: "an earlier related action failed",
      };
      hud.showToast(`${subject} was rolled back: ${reason[error] ?? error.replace(/_/g, " ")}.`);
    };
    // A drag-paint stroke travels as ONE command, so a stroke the server only partly
    // accepted has no per-plot rejection to report. Summarise it instead — otherwise the
    // plots that did not take just quietly vanish on the next reconcile, which is the
    // whole class of bug this reporting exists to prevent.
    economy.onBulkFarmPartial = (plots, error) => {
      const reason: Record<string, string> = {
        insufficient: "there was not enough gold", locked: "the crop is not unlocked yet",
        not_plowed: "the soil was no longer plowed", plot_occupied: "something was already growing",
        already_plowed: "the soil was already plowed", plot_overlap: "the ground was taken",
        farm_full: "the farm has no room for more plots", bad_coord: "the plots were off the farm",
      };
      hud.showToast(
        `${plots} plot${plots === 1 ? "" : "s"} skipped: ${reason[error] ?? error.replace(/_/g, " ")}.`
      );
    };
    void economy.start();
    // Seed the shop state from the save, then adopt server truth (once, after load).
    void economy.syncShop(field.w, state.ownedClimates);
  }
  // A restored (or visited) farm may be a larger (upgraded) size than the 30x30
  // default the world was first built for: re-fit backdrop/foliage/bounds + re-clamp.
  syncWorldToFarm();
  clampCamera();

  // A brand-new farm starts EMPTY: the guided tutorial's whole first step is to
  // grow the player's very first zombie, so we no longer inject a starter unit.
  // (Restored farms rebuild their own roster; a visited farm shows the friend's.)
  if (!visiting && !restored) {
    state.setZombieCount(0); // no starter; sync the HUD count off the default 1
  }

  // Visit mode UI: hide the farm-editing chrome, show a "Visiting X — Exit" banner.
  // Autosave was never enabled above, so nothing here can persist.
  if (visiting && visitTarget) {
    hud.setMode("walk"); // no tool is ever active while visiting
    hud.setVisiting(true, visitTarget.name, () => exitVisit());
  } else if (visitError) {
    hud.showToast(
      visitError === "not_friends" ? "You're no longer friends with that player."
        : visitError === "no_save" ? "That player hasn't started a farm yet."
        : "Couldn't open that farm right now."
    );
  }

  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;

  let dragging = false;
  let moved = false;
  let lastPlot = "";
  const last = new Point();
  const pressStart = new Point();
  let hoveredCrop: { col: number; row: number; wx: number; wy: number; x: number; y: number } | null = null;
  let cropHoverRefresh = 0;
  let temporaryPanGesture = false;
  let pressPointerType = "mouse";
  let pressPointerId = -1;
  let pressMaxDistance = 0;
  let touchSelectStartTile: { col: number; row: number } | null = null;
  let touchToolStartTile: { col: number; row: number } | null = null;
  let touchOutsideFarmPan = false;
  let zombieLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let zombieLongPressActivated = false;
  let harvestStrokeCandidate: HarvestTarget | null = null;
  let harvestStrokeActive = false;
  const harvestStrokeLast = new Point();
  const harvestStrokeTargets: HarvestTarget[] = [];
  const harvestStrokeKeys = new Set<string>();
  const harvestStrokePreviews = new Map<string, Graphics>();
  // Plant tiles painted by the current finger gesture. Plowing uses the explicit
  // rectangle state below so a release can never also become a second plow tap.
  const touchGestureTiles: { col: number; row: number }[] = [];
  const touchGestureTileKeys = new Set<string>();
  const touchPlantPreviews = new Map<string, Graphics>();
  // Where the plant drag-paint last sampled. The stroke between two pointermove
  // events is walked tile by tile from here (see the "plant" branch of pointermove),
  // so a fast swipe cannot jump over a plot.
  const plantStrokeLast = new Point();
  let instaGrowStrokeActive = false;
  const instaGrowStrokeLast = new Point();
  const instaGrowStrokeTargets: InstaGrowTarget[] = [];
  const instaGrowStrokeKeys = new Set<string>();
  let plowStrokeAnchor: { oc: number; or: number } | null = null;
  const plowStrokeLast = new Point();
  const plowStrokeTargets: { oc: number; or: number }[] = [];
  const plowStrokeKeys = new Set<string>();
  const plowStrokePreviews = new Map<string, Graphics>();
  /** Every tile this stroke has already claimed for a plot.
   *
   *  On MOUSE the stroke enqueues as it goes and `Field.reserveTill` holds the ground, so
   *  nothing later in the stroke can land on top. TOUCH only collects previews and
   *  enqueues them all on finger-up, so it has no reservations to consult and needs its
   *  own record — without one, two targets could overlap, and at commit the second would
   *  be refused and vanish. It only became reachable when plowTargetAt gained its
   *  off-lattice fallback: before that every target sat on one 4-tile lattice and could
   *  not overlap by construction. */
  const plowStrokeClaimed = new Set<string>();
  // Deselect-by-drag: pressing ON a queued action arms this stroke, and dragging
  // then un-queues every queued job it crosses (see cancelTargetAtGlobal below).
  let cancelStrokeCandidate: CancelTarget | null = null;
  let cancelStrokeActive = false;
  const cancelStrokeLast = new Point();
  const cancelStrokeTargets: CancelTarget[] = [];
  const cancelStrokeKeys = new Set<string>();
  const cancelStrokePreviews = new Map<string, Graphics>();

  const cancelZombieLongPress = () => {
    if (zombieLongPressTimer !== null) clearTimeout(zombieLongPressTimer);
    zombieLongPressTimer = null;
  };

  const clearTouchPlantPreview = () => {
    for (const preview of touchPlantPreviews.values()) preview.destroy();
    touchPlantPreviews.clear();
  };
  const clearTouchToolStroke = () => {
    touchGestureTiles.length = 0;
    touchGestureTileKeys.clear();
    touchToolStartTile = null;
    clearTouchPlantPreview();
  };
  const clearInstaGrowStroke = () => {
    instaGrowStrokeActive = false;
    instaGrowStrokeTargets.length = 0;
    instaGrowStrokeKeys.clear();
  };
  const clearHarvestStroke = () => {
    for (const preview of harvestStrokePreviews.values()) preview.destroy();
    harvestStrokePreviews.clear();
    harvestStrokeTargets.length = 0;
    harvestStrokeKeys.clear();
    harvestStrokeCandidate = null;
    harvestStrokeActive = false;
  };
  const clearPlowStroke = () => {
    for (const preview of plowStrokePreviews.values()) preview.destroy();
    plowStrokePreviews.clear();
    plowStrokeTargets.length = 0;
    plowStrokeKeys.clear();
    plowStrokeClaimed.clear();
    plowStrokeAnchor = null;
  };
  const clearCancelStroke = () => {
    for (const preview of cancelStrokePreviews.values()) preview.destroy();
    cancelStrokePreviews.clear();
    cancelStrokeTargets.length = 0;
    cancelStrokeKeys.clear();
    cancelStrokeCandidate = null;
    cancelStrokeActive = false;
  };
  const recordTouchPlantTile = (col: number, row: number) => {
    const rawKey = tileKey(col, row);
    if (touchGestureTileKeys.has(rawKey)) return;
    touchGestureTileKeys.add(rawKey);
    touchGestureTiles.push({ col, row });
    if (hud.mode !== "plant" || !hud.planting || !field.canPlant(col, row)) return;
    const origin = field.plotOriginAt(col, row);
    if (!origin) return;
    const key = tileKey(origin.oc, origin.or);
    if (touchPlantPreviews.has(key)) return;
    const center = field.plotCenterOf(origin.oc, origin.or);
    const width = PLOT * HW;
    const height = PLOT * HH;
    const preview = new Graphics();
    preview.moveTo(0, -height).lineTo(width, 0).lineTo(0, height).lineTo(-width, 0).lineTo(0, -height)
      .fill({ color: 0x8df25a, alpha: 0.2 })
      .stroke({ width: 3, color: 0x8df25a, alpha: 0.8 });
    preview.position.set(center.x, center.y);
    field.highlightLayer.addChild(preview);
    touchPlantPreviews.set(key, preview);
  };
  const commitTouchToolStroke = () => {
    for (const tile of touchGestureTiles) enqueueTool(tile.col, tile.row);
    clearTouchToolStroke();
  };

  // ---- multi-touch pinch-to-zoom (mobile) ----
  // Handled with native touch events (not Pixi pointers): e.touches reliably
  // lists every finger with coordinates, which is exactly what a pinch needs.
  // While two fingers are down, `touchPinch` is set — the Pixi pan/tap path
  // early-returns on it — and the finger-spread ratio drives zoom (toward the
  // midpoint) while the midpoint's travel pans, i.e. one pinch-and-drag gesture.
  // Attached unconditionally: the handlers no-op unless exactly two fingers are
  // down, so a mouse device pays nothing and any touch-capable device works
  // without depending on feature detection.
  let touchPinch = false;
  let pinchDist = 0;
  const pinchMid = new Point();
  const cancelPointerGesture = () => {
    cancelZombieLongPress();
    zombieLongPressActivated = false;
    dragging = false;
    moved = false;
    lastPlot = "";
    pressPointerId = -1;
    touchOutsideFarmPan = false;
    clearTouchToolStroke();
    clearInstaGrowStroke();
    clearPlowStroke();
    field.clearTillSelection();
    touchPinch = false;
    pinchDist = 0;
    temporaryPanGesture = false;
    field.hideCursor();
    field.setObjectHighlight(null);
    clearHarvestStroke();
    clearCancelStroke();
  };
  // Canvas-relative CSS pixels (same space wheel/zoomAt use).
  const canvasXY = (clientX: number, clientY: number) => {
    const r = app.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  const pinchInfo = (t: TouchList) => {
    const a = canvasXY(t[0].clientX, t[0].clientY);
    const b = canvasXY(t[1].clientX, t[1].clientY);
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  {
    app.canvas.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length !== 2 || raidActive) return;
      e.preventDefault();
      touchPinch = true;
      cancelZombieLongPress();
      dragging = false; // abandon any in-progress single-finger pan
      // Nothing has committed yet: discard the pending paint stroke and let the
      // two fingers control the camera instead.
      clearTouchToolStroke();
      clearInstaGrowStroke();
      clearHarvestStroke();
      clearCancelStroke();
      lastPlot = "";
      clearPlowStroke();
      field.clearTillSelection();
      field.hideCursor();
      const g = pinchInfo(e.touches);
      pinchDist = g.dist;
      pinchMid.set(g.mx, g.my);
    }, { passive: false });

    app.canvas.addEventListener("touchmove", (e: TouchEvent) => {
      if (!touchPinch || e.touches.length < 2) return;
      e.preventDefault();
      const g = pinchInfo(e.touches);
      if (pinchDist > 0) zoomAt(pinchMid.x, pinchMid.y, g.dist / pinchDist); // zoom by spread
      world.position.x += g.mx - pinchMid.x; // and pan by the midpoint's travel
      world.position.y += g.my - pinchMid.y;
      clampCamera();
      pinchDist = g.dist;
      pinchMid.set(g.mx, g.my);
    }, { passive: false });

    const endPinch = (e: TouchEvent) => {
      if (e.type === "touchcancel") {
        cancelPointerGesture();
        return;
      }
      // Once fewer than two fingers remain the pinch is over. Stay out of pan mode
      // so the last finger doesn't jump the camera.
      if (e.touches.length < 2) { touchPinch = false; dragging = false; }
    };
    app.canvas.addEventListener("touchend", endPinch);
    app.canvas.addEventListener("touchcancel", endPinch);
  }
  const toWorld = (e: FederatedPointerEvent) => world.toLocal(e.global);
  const tileAt = (e: FederatedPointerEvent) => {
    const w = toWorld(e);
    const g = screenToGrid(w.x, w.y);
    return { col: Math.round(g.col), row: Math.round(g.row), wx: w.x, wy: w.y };
  };
  /** The same tile resolution as `tileAt`, for an interpolated point along a stroke
   *  rather than a real pointer event. */
  const tileAtGlobal = (x: number, y: number) => {
    const w = world.toLocal(new Point(x, y));
    const g = screenToGrid(w.x, w.y);
    return { col: Math.round(g.col), row: Math.round(g.row) };
  };

  const instaGrowTargetAtGlobal = (x: number, y: number): InstaGrowTarget | null => {
    const worldPoint = world.toLocal(new Point(x, y));
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    return instaGrowTargetAtWorld(
      Math.round(grid.col), Math.round(grid.row), worldPoint.x, worldPoint.y,
    );
  };

  const recordInstaGrowStrokeTarget = (target: InstaGrowTarget) => {
    if (!appendInstaGrowTarget(target, instaGrowStrokeTargets, instaGrowStrokeKeys)) return;
    // A touch stroke stays pending until release, so a second finger can cancel it
    // into a pinch without having spent inventory. Mouse strokes apply as they cross.
    if (!isTouchPointer(pressPointerType)) applyInstaGrowTarget(target);
  };

  const collectInstaGrowStrokeSegment = (x: number, y: number) => {
    for (const point of sampleStrokeSegment(instaGrowStrokeLast, { x, y })) {
      const target = instaGrowTargetAtGlobal(point.x, point.y);
      if (target) recordInstaGrowStrokeTarget(target);
    }
    instaGrowStrokeLast.set(x, y);
  };

  const beginInstaGrowStroke = (x: number, y: number) => {
    clearInstaGrowStroke();
    instaGrowStrokeActive = true;
    instaGrowStrokeLast.set(x, y);
    const target = instaGrowTargetAtGlobal(x, y);
    if (target) recordInstaGrowStrokeTarget(target);
  };

  const commitTouchInstaGrowStroke = () => {
    const targets = [...instaGrowStrokeTargets];
    clearInstaGrowStroke();
    for (const target of targets) {
      if (!applyInstaGrowTarget(target) && state.boostCount(GROW_BOOST_KEY) <= 0) break;
    }
  };
  const tileKey = (col: number, row: number) => `${col},${row}`;

  const harvestTargetPending = (target: HarvestTarget): boolean => target.kind === "tree"
    ? jobs.isTreeHarvestPending(target.instanceId)
    : target.kind === "replow"
      ? jobs.isPlotTillPending(target.oc, target.or)
      : jobs.isPlotHarvestPending(target.oc, target.or);

  // A visible ripe tree owns the swipe point before the plot behind its canopy.
  // Else resolve to the canonical 4x4 plot origin so crossing one crop's tiles only
  // creates one target. Tutorial strokes remain constrained to the current beat.
  const harvestTargetAt = (globalX: number, globalY: number): HarvestTarget | null => {
    const worldPoint = world.toLocal(new Point(globalX, globalY));
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    const col = Math.round(grid.col), row = Math.round(grid.row);
    if (tutorial?.active && !tutorial.allowsTile(col, row)) return null;
    const objectId = field.objectAtPoint(worldPoint.x, worldPoint.y);
    if (objectId) {
      if (!field.isObjectReady(objectId)) return null;
      const target: HarvestTarget = { kind: "tree", instanceId: objectId };
      return harvestTargetPending(target) ? null : target;
    }
    const origin = field.plotOriginAt(col, row);
    if (!origin) return null; // bare ground never becomes a select-tool plow target
    const target: HarvestTarget | null = field.isRipe(col, row)
      ? {
          kind: "plot", oc: origin.oc, or: origin.or,
          isZombie: field.ripeZombieAt(col, row),
        }
      : field.isSpent(col, row)
        ? { kind: "replow", oc: origin.oc, or: origin.or }
        : null;
    if (!target) return null;
    return harvestTargetPending(target) ? null : target;
  };

  const enqueueHarvestTarget = (target: HarvestTarget): boolean => {
    if (target.kind === "tree") {
      if (!field.isObjectReady(target.instanceId)) return false;
      const point = field.objectWorkPoint(target.instanceId);
      return !!point && jobs.enqueueTreeHarvest(target.instanceId, point.x, point.y);
    }
    if (target.kind === "replow") {
      if (!field.isSpent(target.oc, target.or)) return false;
      return jobs.enqueue("till", target.oc, target.or);
    }
    if (!field.isRipe(target.oc, target.or)) return false;
    // The army/Mausoleum check lives in jobs.enqueue, which also debits the zombie
    // harvests already queued — a swipe across a field of ripe zombies must not queue
    // more than there is room for, and re-swiping a queued plot must not re-warn.
    return jobs.enqueue("harvest", target.oc, target.or);
  };

  const showHarvestStrokePreview = (target: HarvestTarget) => {
    const key = harvestTargetKey(target);
    if (harvestStrokePreviews.has(key)) return;
    const area = target.kind === "tree"
      ? field.objectHighlightArea(target.instanceId)
      : { ...field.plotCenterOf(target.oc, target.or), tiles: PLOT };
    if (!area) return;
    const w = area.tiles * HW, h = area.tiles * HH;
    const color = target.kind === "replow" ? 0x8df25a : 0xffd45a;
    const stroke = target.kind === "replow" ? 0x8df25a : 0xffe58a;
    const preview = new Graphics();
    preview.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h)
      .fill({ color, alpha: 0.24 })
      .stroke({ width: 3, color: stroke, alpha: 0.95 });
    preview.position.set(area.x, area.y);
    field.highlightLayer.addChild(preview);
    harvestStrokePreviews.set(key, preview);
  };

  const recordHarvestStrokeTarget = (target: HarvestTarget) => {
    if (harvestTargetPending(target) ||
        !appendHarvestTarget(target, harvestStrokeTargets, harvestStrokeKeys)) return;
    if (isTouchPointer(pressPointerType)) showHarvestStrokePreview(target);
    else enqueueHarvestTarget(target);
  };

  const collectHarvestStrokeSegment = (x: number, y: number) => {
    for (const point of sampleStrokeSegment(harvestStrokeLast, { x, y })) {
      const target = harvestTargetAt(point.x, point.y);
      if (target) recordHarvestStrokeTarget(target);
    }
    harvestStrokeLast.set(x, y);
  };

  const beginHarvestStroke = (x: number, y: number) => {
    if (!harvestStrokeCandidate) return;
    harvestStrokeActive = true;
    recordHarvestStrokeTarget(harvestStrokeCandidate);
    collectHarvestStrokeSegment(x, y);
  };

  const commitTouchHarvestStroke = () => {
    const targets = [...harvestStrokeTargets];
    clearHarvestStroke();
    for (const target of targets) enqueueHarvestTarget(target);
  };

  // ---- cancel stroke: drag across queued actions to un-queue them ----
  // A tap on a queued plot/tree already toggles it off. Starting the press ON a
  // queued action instead turns the whole drag into an eraser: every queued
  // plow/plant/harvest/tree job the stroke crosses is un-queued, and anything
  // without a pending job is passed over, so the same swipe never queues new work.
  const cancelTargetAtGlobal = (x: number, y: number): CancelTarget | null => {
    const worldPoint = world.toLocal(new Point(x, y));
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    const col = Math.round(grid.col), row = Math.round(grid.row);
    if (tutorial?.active && !tutorial.allowsTile(col, row)) return null;
    // Plot before object, matching the tap-cancel cascade: a queued plot keeps the
    // press even when a tree's canopy overlaps it.
    const plotJob = jobs.pendingPlotJobAt(col, row);
    if (plotJob) return { kind: "plot", jobKind: plotJob.kind, oc: plotJob.oc, or: plotJob.or };
    const objectId = field.objectAtPoint(worldPoint.x, worldPoint.y);
    return objectId && jobs.isTreeHarvestPending(objectId)
      ? { kind: "object", instanceId: objectId }
      : null;
  };

  const applyCancelTarget = (target: CancelTarget): boolean => target.kind === "object"
    ? jobs.cancelObject(target.instanceId)
    : jobs.cancelAtTile(target.oc, target.or);

  const showCancelStrokePreview = (target: CancelTarget) => {
    const key = cancelTargetKey(target);
    if (cancelStrokePreviews.has(key)) return;
    const area = target.kind === "object"
      ? field.objectHighlightArea(target.instanceId)
      : { ...field.plotCenterOf(target.oc, target.or), tiles: PLOT };
    if (!area) return;
    const w = area.tiles * HW, h = area.tiles * HH;
    const preview = new Graphics();
    preview.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h)
      .fill({ color: 0xf25a5a, alpha: 0.28 })
      .stroke({ width: 3, color: 0xff8f7a, alpha: 0.95 });
    preview.position.set(area.x, area.y);
    // Same layer as the job's own green diamond (plow jobs draw on their own layer),
    // so the red marker always sits above the queued highlight it will remove.
    (target.kind === "plot" && target.jobKind === "till"
      ? field.plowHighlightLayer : field.highlightLayer).addChild(preview);
    cancelStrokePreviews.set(key, preview);
  };

  const recordCancelStrokeTarget = (target: CancelTarget) => {
    if (!appendCancelTarget(target, cancelStrokeTargets, cancelStrokeKeys)) return;
    // Touch keeps the stroke pending until release, so a second finger can still
    // convert it into a pinch without cancelling anything. Mouse un-queues as it
    // crosses, like the other paint strokes.
    if (isTouchPointer(pressPointerType)) showCancelStrokePreview(target);
    else applyCancelTarget(target);
  };

  const collectCancelStrokeSegment = (x: number, y: number) => {
    for (const point of sampleStrokeSegment(cancelStrokeLast, { x, y })) {
      const target = cancelTargetAtGlobal(point.x, point.y);
      if (target) recordCancelStrokeTarget(target);
    }
    cancelStrokeLast.set(x, y);
  };

  const beginCancelStroke = (x: number, y: number) => {
    cancelStrokeActive = true;
    if (cancelStrokeCandidate) recordCancelStrokeTarget(cancelStrokeCandidate);
    collectCancelStrokeSegment(x, y);
  };

  const commitTouchCancelStroke = () => {
    const targets = [...cancelStrokeTargets];
    clearCancelStroke();
    for (const target of targets) applyCancelTarget(target);
  };

  // Queue the active tool on a plot: Plow places/re-tills a 4x4; Plant sows the
  // currently-selected crop. No-op for select/sell.
  const enqueueTool = (col: number, row: number): boolean => {
    if (hud.mode === "till") return jobs.enqueue("till", col, row);
    if (hud.mode === "plant" && hud.planting)
      return jobs.enqueue("plant", col, row, hud.planting);
    return false;
  };

  const originAtTile = (col: number, row: number): { oc: number; or: number } => {
    const target = field.resolveTill(col, row);
    return { oc: target.oc, or: target.or };
  };

  const showPlowStrokePreview = (target: { oc: number; or: number }) => {
    const key = tileKey(target.oc, target.or);
    if (plowStrokePreviews.has(key)) return;
    const center = field.plotCenterOf(target.oc, target.or);
    const w = PLOT * HW, h = PLOT * HH;
    const preview = new Graphics();
    preview.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h)
      .fill({ color: 0x8df25a, alpha: 0.2 })
      .stroke({ width: 3, color: 0x8df25a, alpha: 0.8 });
    preview.position.set(center.x, center.y);
    field.plowHighlightLayer.addChild(preview);
    plowStrokePreviews.set(key, preview);
  };

  /** Whether a 4x4 plot can actually be laid with this origin — free ground the field
   *  accepts, and not already spoken for by this same stroke. */
  const plowOriginFits = (origin: { oc: number; or: number }): boolean => {
    for (let r = origin.or; r < origin.or + PLOT; r++)
      for (let c = origin.oc; c < origin.oc + PLOT; c++)
        if (plowStrokeClaimed.has(tileKey(c, r))) return false;
    const target = field.resolveTill(origin.oc + PLOT / 2, origin.or + PLOT / 2);
    return target.valid && target.oc === origin.oc && target.or === origin.or;
  };

  const recordPlowStrokeTarget = (target: { oc: number; or: number }) => {
    const key = tileKey(target.oc, target.or);
    if (plowStrokeKeys.has(key)) return;
    if (!plowOriginFits(target)) return;
    plowStrokeKeys.add(key);
    for (let r = target.or; r < target.or + PLOT; r++)
      for (let c = target.oc; c < target.oc + PLOT; c++) plowStrokeClaimed.add(tileKey(c, r));
    plowStrokeTargets.push(target);
    if (isTouchPointer(pressPointerType)) showPlowStrokePreview(target);
    else jobs.enqueue("till", target.oc + PLOT / 2, target.or + PLOT / 2);
  };

  const plowTargetAt = (globalX: number, globalY: number): { oc: number; or: number } | null => {
    if (!plowStrokeAnchor) return null;
    const worldPoint = world.toLocal(new Point(globalX, globalY));
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    const col = Math.round(grid.col), row = Math.round(grid.row);
    if (tutorial?.active && !tutorial.allowsTile(col, row)) return null;
    const existing = field.plotOriginAt(col, row);
    if (existing) {
      const target = field.resolveTill(col, row);
      return target.valid ? { oc: target.oc, or: target.or } : null;
    }
    return choosePlowOrigin(
      plowStrokeAnchor, col, row, originAtTile(col, row), plowOriginFits
    );
  };

  const collectPlowStrokeSegment = (x: number, y: number) => {
    for (const point of sampleStrokeSegment(plowStrokeLast, { x, y })) {
      const target = plowTargetAt(point.x, point.y);
      if (target) recordPlowStrokeTarget(target);
    }
    plowStrokeLast.set(x, y);
  };

  const beginPlowStroke = (col: number, row: number, x: number, y: number): boolean => {
    const target = field.resolveTill(col, row);
    if (!target.valid) return false;
    plowStrokeAnchor = { oc: target.oc, or: target.or };
    plowStrokeLast.set(x, y);
    recordPlowStrokeTarget(plowStrokeAnchor);
    return true;
  };

  const commitTouchPlowStroke = () => {
    const targets = [...plowStrokeTargets];
    clearPlowStroke();
    for (const target of targets)
      jobs.enqueue("till", target.oc + PLOT / 2, target.or + PLOT / 2);
  };

  // ---- object buy / place / move ----
  // The Market offers only the NEXT shed above the current tier; report the placed
  // shed's capacity (0 = none) so it can filter to that single card.
  hud.getShedSlots = () => {
    const id = field.shedId();
    return id ? field.objectDefOf(id)?.storageSlots ?? 0 : 0;
  };
  hud.objectLimitReached = (def) => {
    const limit = placeablePurchaseLimit(def);
    if (limit === undefined) return false;
    const placed = field.objectKeyCounts()[def.key] ?? 0;
    const stored = state.storedItems.find((item) => item.key === def.key)?.count ?? 0;
    return placed + stored >= limit;
  };
  // Colored graves gate planting their zombie class (Blue/Red/Silver).
  hud.hasGrave = (color) => field.hasGrave(color);
  // Lets crop cards quote the harvest XP the Plowing Monolith actually pays out.
  hud.hasPlowFree = () => field.hasPlowFree();

  // ---- Farm Size upgrade (Market → Upgrade tab) ----
  // Buying an expansion grows the field (origin stays at 0,0 so nothing on the farm
  // moves) and re-fits the backdrop/foliage/camera to the new size. Sizes are bought
  // in order (30 → 40 → 50 → 60 → 70). Each tier has a gold card and a brains card;
  // buying either grows the farm, so the other currency's card then reads as owned.
  hud.setUpgrades(assets.upgrades.mapSize);
  hud.getMapSize = () => field.w;
  hud.onBuyUpgrade = async (size, currency) => {
    if (onlineGameplayBlocked()) return false;
    const up = assets.upgrades.mapSize.find((u) => u.size === size);
    if (!up || size <= field.w || state.level < up.level) return false;
    // Enforce sequential purchase: only the immediate next tier is buyable.
    const nextSize = Math.min(
      ...assets.upgrades.mapSize.filter((u) => u.size > field.w).map((u) => u.size)
    );
    if (size !== nextSize) return false;
    const cost = currency === "brains" ? up.brains : up.gold;
    // ONLINE: the server owns the farm size — it prices + debits the upgrade (and can
    // reject it). Wait for settlement before changing the playable boundary.
    if (economy) {
      const funds = currency === "brains" ? state.brains : state.gold;
      if (funds < cost) return false;
      if (!economy.submitShopSize(size, currency, cost)) return false;
      try { await economy.settleBeforeDependency(); } catch { return false; }
      if (field.w !== size) return false;
    } else if (!(currency === "brains" ? state.spendBrains(up.brains) : state.spendGold(up.gold))) {
      return false; // offline: insufficient funds in the chosen currency
    } else {
      field.resize(size, size);
      syncWorldToFarm();
      clampCamera();
    }
    audio.play("buy");
    saveManager.save(); // persist the new size (server owns it; blob is an offline cache)
    hud.showToast(`Farm expanded to ${size}×${size}!`);
    questBus.post(QuestEvent.ItemBought, up.name);
    return true;
  };

  // ---- Ground/climate skins (Market → Upgrade → Ground) ----
  // Buying a skin charges gold, repaints the farm, and records ownership so it can
  // be re-applied for free later. Grassy is the free default (always owned).
  hud.setClimates(assets.upgrades.climate);
  hud.getClimate = () => field.climate;
  hud.ownsClimate = (terrain) => state.ownsClimate(terrain);
  hud.onBuyClimate = async (c) => {
    if (onlineGameplayBlocked()) return false;
    if (state.ownsClimate(c.terrain) || c.terrain === "grass") return false;
    if (state.level < c.level) return false;
    // ONLINE: the server owns the climate set — it prices + debits the skin (and can
    // reject it). Wait for settlement before applying or saving the presentation.
    if (economy) {
      if (state.gold < c.gold) return false;
      if (!economy.submitShopClimate(c.terrain, c.gold)) return false;
      try { await economy.settleBeforeDependency(); } catch { return false; }
      if (!state.ownsClimate(c.terrain)) return false;
    } else if (!state.spendGold(c.gold)) {
      return false;
    } else {
      state.addOwnedClimate(c.terrain);
    }
    field.setClimate(c.terrain);
    saveManager.save();
    hud.showToast(`${c.name} applied!`);
    questBus.post(QuestEvent.ItemBought, c.name);
    audio.play("buy");
    return true;
  };
  hud.onApplyClimate = (c) => {
    if (!state.ownsClimate(c.terrain) && c.terrain !== "grass") return;
    field.setClimate(c.terrain);
    saveManager.save();
    audio.play("menuClick");
  };

  // Upgrade an already-placed building (storage shed / Mausoleum) to a bigger tier
  // IN PLACE (no re-placement): charge, swap its type/sprite, and raise its capacity.
  const upgradeBuilding = (def: PlaceableDef, id: string | null) => {
    if (onlineGameplayBlocked()) return;
    if (!id) return;
    if (state.level < def.level) return;
    const xp = buyXp(def.cost, def.xp, !!def.brainsNeeded, def.category);
    // Server-owned upgrade (online, priced): the server charges the new shed's full
    // price, swaps the ownership record, and grants the xp. The old shed is given up
    // with no refund — same as the local path. A legacy shed the server doesn't know
    // is rejected, and the optimistic debit reconciles away.
    const from = field.objectDefOf(id);
    const serverObject = !!economy && !!from && def.cost > 0;
    if (serverObject) {
      const have = def.brainsNeeded ? state.brains : state.gold;
      if (have < def.cost) return; // optimistic affordability; server re-checks
      economy!.submitObject(
        { type: "upgrade", fromKey: from!.key, toKey: def.key, instanceId: id },
        def.brainsNeeded ? { brains: -def.cost, xp } : { gold: -def.cost, xp }
      );
    } else {
      const paid = def.brainsNeeded ? state.spendBrains(def.cost) : state.spendGold(def.cost);
      if (!paid) return;
      state.addXp(xp);
    }
    audio.play("buy");
    field.replaceObjectDef(id, def);
    if (def.storageSlots) refreshShedCap(); // the shed IS the capacity — derived, so read it back
    saveManager.save();
    const o = field.objectOriginOf(id);
    if (o) {
      const c = tileCenter(o.oc, o.or);
      floatText(c.x, c.y, `-${def.cost}${def.brainsNeeded ? "b" : "g"}`);
      showPurchaseXp(xp, c);
    }
    questBus.post(QuestEvent.ItemBought, def.name, 1, objectAliases.get(def.key) ?? []);
  };

  // Buying an object from the market: load its sprite(s) (lazy). A shed or Mausoleum
  // with one already placed UPGRADES it in place; otherwise enter placement. Fruit
  // trees have a second (growing) frame to preload.
  hud.onBuy = async (def) => {
    if (onlineGameplayBlocked()) return;
    if (hud.objectLimitReached?.(def)) return;
    // A purchase is never a free placement. Dropping both armings here covers the
    // one case the def check in onModeChange cannot see: buying the SAME key that a
    // pending retrieve holds, where the tap would spend the shed copy and hand the
    // player their purchase for nothing.
    retrieving = null;
    receiving = null;
    await ensureObjectTextures(assets, def);
    if (def.storageSlots && field.shedId()) upgradeBuilding(def, field.shedId()); // upgrade, don't place
    // A placed Mausoleum upgrades in place too; a lower/equal tier is a no-op.
    else if (def.zombieStorage && field.mausoleumId()) {
      if ((def.zombieSlots ?? 0) > zombies.mausoleumCap) upgradeBuilding(def, field.mausoleumId());
    }
    else if (def.zombiePatch && field.patchId()) return; // only one Zombie Patch
    else if (def.graveColor && field.hasGrave(def.graveColor)) return; // already own this grave
    else hud.setPlacing(def);
  };

  // Center the camera on a world point (used to locate a zombie from the roster).
  const centerOn = (x: number, y: number) => {
    world.pivot.set(x, y);
    recenter();
  };

  // ---- zombie roster (the Zombies menu) ----
  // Zombies are stored in the Mausoleum (capped at mausoleumCap slots); the army
  // cap limits only the count deployed on the farm.
  hud.getRoster = () => zombies.roster();
  // Zombie Almanac: every obtainable species with its lifetime-obtained count.
  // Base catalog stats only — deliberately no farmer/veterancy/mutation modifiers.
  const almanacSources = {
    raidNameById: (raidId: number) => assets.raids.find((raid) => raid.id === raidId)?.name,
    epicBossNameByQuestId: (questId: string) =>
      EPIC_BOSSES.find((boss) => boss.questIds.includes(questId))?.name,
  };
  hud.getAlmanac = () =>
    almanacEntries(assets.zombies, state.zombieDiscovered).map((def) => {
      // Epic Boss exclusives are flagged here; the panel groups them under "Epic".
      const epic = isEpicZombie(def);
      return {
        key: def.key,
        name: def.name,
        portrait: zombiePortrait(def.key),
        group: def.group,
        className: def.className,
        classColor: def.classColor,
        category: def.category,
        str: def.str, dex: def.dex, con: def.con, focus: def.focus,
        obtained: state.zombieDiscovered[def.key] ?? 0,
        hint: obtainHint(def, almanacSources),
        ...(epic ? { epic } : {}),
      };
    });
  // The Almanac's field notes. Everything the guide cannot import for itself is
  // resolved from the loaded catalogs here — the Brain Ticket's Market listing, the
  // Epic Boss lineup, which invasions have a rare zombie, and the species names the
  // Pot's tier-5 promotions produce. Built per call so a catalog swapped at runtime
  // (a live-balance fetch) is reflected the next time the tab is opened.
  hud.getAlmanacGuide = () => {
    const ticket = assets.boosts.find((boost) => boost.key === BRAIN_TICKET_KEY);
    const unlockLevels = EPIC_BOSSES.map((boss) => epicBossUnlockLevel(boss));
    const brainCosts = EPIC_BOSSES.map((boss) => boss.costBrains);
    const zombieName = new Map(assets.zombies.map((def) => [def.key, def.name]));
    return almanacGuide({
      brainTicket: ticket ? { cost: ticket.cost, level: ticket.level } : null,
      epic: EPIC_BOSSES.length
        ? {
            count: EPIC_BOSSES.length,
            firstLevel: Math.min(...unlockLevels),
            lastLevel: Math.max(...unlockLevels),
            minBrains: Math.min(...brainCosts),
            maxBrains: Math.max(...brainCosts),
            // Every authored event is the same length and the same ladder height; the
            // max keeps the sentence honest if a future one is longer.
            rungs: Math.max(...EPIC_BOSSES.map((boss) => boss.maxLevel)),
            days: Math.round(Math.max(...EPIC_BOSSES.map((boss) => boss.durationMs)) / 86_400_000),
          }
        : null,
      rareZombieRaids: Object.keys(RAID_ZOMBIE_DROPS)
        .map((raidId) => almanacSources.raidNameById(Number(raidId)))
        .filter((name): name is string => !!name),
      speciesName: (key) => zombieName.get(key),
    });
  };
  // The Mutation Almanac's entries. Crop names come from the plant catalog, which is
  // where the obtain hint ("Grow a zombie crop beside Tomatoes") gets its wording.
  hud.getMutationAlmanac = () => {
    const cropName = new Map(assets.plants.map((plant) => [plant.key, plant.name]));
    return mutationAlmanacEntries(state.mutationDiscovered, { cropName: (key) => cropName.get(key) });
  };
  // The Statistics panel (Account menu). Everything is resolved HERE — crop keys
  // through the plant catalog, collection totals through the two Almanacs — so the
  // panel itself only prints rows. Built per call: it is a snapshot of the farm at
  // the moment it was opened, not a live view.
  hud.getStats = () => {
    const species = almanacEntries(assets.zombies, state.zombieDiscovered);
    const mutations = mutationAlmanacEntries(state.mutationDiscovered, { cropName: () => undefined });
    return buildStatsView({
      stats: state.stats,
      now: Date.now(),
      name: state.name,
      level: state.level,
      xp: state.xp,
      gold: state.gold,
      brains: state.brains,
      zombiesDeployed: zombies.count,
      zombieMax: state.zombieMax,
      zombiesStored: zombies.storedCount,
      speciesDiscovered: species.filter((def) => (state.zombieDiscovered[def.key] ?? 0) > 0).length,
      speciesTotal: species.length,
      mutationsDiscovered: mutations.filter((entry) => entry.obtained > 0).length,
      mutationsTotal: mutations.length,
      cropName: (key) => catalog.get(key)?.name,
    });
  };
  hud.zombiePortraitOf = (key) => zombiePortrait(key);
  hud.getMausoleumCap = () => zombies.mausoleumCap;
  // The Mausoleum upgrade ladder: each tier is an ordinary catalog placeable that
  // replaces the placed one (see upgradeBuilding), so the next tier is simply the
  // cheapest authored Mausoleum with more slots than the one standing on the farm.
  const nextMausoleumTier = (): PlaceableDef | null => {
    if (!field.mausoleumId()) return null;
    const cap = zombies.mausoleumCap;
    return [...placeCatalog.values()]
      .filter((def) => def.zombieStorage && (def.zombieSlots ?? 0) > cap)
      .sort((a, b) => (a.zombieSlots ?? 0) - (b.zombieSlots ?? 0))[0] ?? null;
  };
  hud.getMausoleumUpgrade = () => {
    const def = nextMausoleumTier();
    return def
      ? { name: def.name, cost: def.cost, brains: !!def.brainsNeeded, slots: def.zombieSlots ?? 0 }
      : null;
  };
  hud.onMausoleumUpgrade = async () => {
    const def = nextMausoleumTier();
    if (!def) return;
    await ensureObjectTextures(assets, def);
    upgradeBuilding(def, field.mausoleumId());
  };
  hud.canStoreZombies = () => !!field.mausoleumId() && !zombies.mausoleumFull;
  hud.canDeployZombie = () => zombies.canAdd();
  hud.canTakeZombieDelivery = () => zombies.canHarvestZombie();
  hud.onZombieRename = (id, requested) => {
    const name = zombies.rename(id, requested);
    if (name) saveManager.flushCritical();
    return name;
  };
  hud.onZombieStore = async (id) => {
    if (onlineGameplayBlocked()) return;
    try { if (economy) [id] = await economy.settleUnitIds([id]); }
    catch { hud.showToast("Could not confirm that zombie. Please reconnect."); return; }
    if (field.mausoleumId() && !zombies.mausoleumFull && zombies.store(id)) economy?.submitRosterStatus(id, true);
  };
  hud.onZombieDeploy = async (id) => {
    if (onlineGameplayBlocked()) return;
    try { if (economy) [id] = await economy.settleUnitIds([id]); }
    catch { hud.showToast("Could not confirm that zombie. Please reconnect."); return; }
    if (zombies.deploy(id)) economy?.submitRosterStatus(id, false);
  };
  hud.onZombieLocate = (id) => {
    const p = zombies.selectById(id);
    if (p) centerOn(p.x, p.y);
  };
  // ---- saved line-ups ("Zombie Teams", opened from the Mausoleum) ----
  hud.getArmyCap = () => state.zombieMax;
  hud.getTeams = () => state.zombieTeams;
  hud.onTeamsChange = (teams) => {
    state.zombieTeams = sanitizeTeams(teams);
    saveManager.flushCritical(); // same path a rename takes: teams are presentation data
  };
  // Assemble a team: deploy its members, store everyone else. Deliberately built
  // out of the SAME two moves the Mausoleum's own buttons make (zombies.store /
  // zombies.deploy + submitRosterStatus), so a team can never move a zombie in a
  // way a player could not by hand — the server sees an ordinary sequence of
  // roster.status commands and validates each one itself.
  hud.onTeamAssemble = async (memberIds) => {
    if (onlineGameplayBlocked()) return null;
    let members = memberIds;
    let settledTeams = false;
    try {
      if (economy) {
        // A harvest settled since the team was saved may have exchanged an
        // optimistic local id for the server's; rewrite the saved team too, or it
        // loses that zombie for good the moment the id it remembers stops existing.
        members = await economy.settleUnitIds(memberIds);
        const settled = settleTeamMembers(state.zombieTeams, (id) => economy!.authoritativeUnitId(id));
        settledTeams = settled.some((team, i) => team !== state.zombieTeams[i]);
        if (settledTeams) state.zombieTeams = settled;
      }
    } catch {
      hud.showToast("Could not confirm your zombies. Please reconnect.");
      return null;
    }
    const plan = planTeamAssembly(members, zombies.roster(), state.zombieMax, zombies.mausoleumCap);
    let stored = 0;
    let deployed = 0;
    // Preserve the planner's interleaving: with a full Mausoleum, a deploy may be the
    // move that opens the storage slot needed by the following store.
    for (const operation of plan.operations) {
      if (operation.type === "store") {
        if (zombies.store(operation.id)) {
          economy?.submitRosterStatus(operation.id, true);
          stored++;
        }
      } else if (zombies.deploy(operation.id)) {
        economy?.submitRosterStatus(operation.id, false);
        deployed++;
      }
    }
    // The team's order IS an attack order: adopt it for the Army screen so a team
    // built for one invasion also reopens with its line-up in the right sequence.
    // Only members that made it onto the farm — the screen shows deployed units.
    const onFarm = new Set(zombies.roster().filter((unit) => !unit.stored).map((unit) => unit.id));
    const order = members.filter((id) => onFarm.has(id));
    if (order.length) state.raidAttackOrder = order;
    // Rewritten member ids are worth a write of their own: an assembly that moved
    // nothing (the team is already standing there) still learned the real ids.
    if (stored || deployed || settledTeams) saveManager.flush();
    // A move the plan asked for that the field refused (the roster shifted under
    // us — a crop finished growing mid-assembly) counts as blocked/left too, so
    // the toast can never claim more than actually happened.
    return {
      deployed, stored,
      missing: plan.missing.length,
      blocked: plan.blocked.length + (plan.deploy.length - deployed),
      left: plan.left.length + (plan.store.length - stored),
      present: plan.present.length,
      shortfall: plan.shortfall,
    };
  };
  hud.zombieBaseCost = (key) => zombieDefs.get(key)?.cost ?? 0;
  hud.zombieCostsBrains = (key) => !!zombieDefs.get(key)?.brainsNeeded;
  hud.onZombieSell = async (id) => {
    if (onlineGameplayBlocked()) return;
    try { if (economy) [id] = await economy.settleUnitIds([id]); }
    catch { hud.showToast("Could not confirm that zombie. Please reconnect."); return; }
    const z = zombies.roster().find((r) => r.id === id);
    if (!z) { hud.showToast("That zombie is no longer available."); return; }
    const def = zombieDefs.get(z.key);
    const value = zombieSellValue(def?.cost ?? 0, !!def?.brainsNeeded);
    const p = zombies.selectById(id); // deployed unit's world pos (null if stored)
    if (!zombies.sell(id)) return; // gone already; don't credit gold
    state.recordZombieSold();
    audio.play("sell");
    // ONLINE: the server owns the roster — it prices + credits the sell (and rejects a
    // unit it doesn't own, so a fabricated zombie can't be cashed out). OFFLINE: credit
    // locally as before.
    if (state.onRosterSell) state.onRosterSell(id, value);
    else state.addGold(value);
    if (p) floatText(p.x, p.y, `+${value}g`);
  };

  // ---- Zombie Pot (combiner) ----
  const potBaseMs = () => POT_DURATION_MS;
  let activePotId: string | null = null;
  hud.getPotStatus = () => {
    const pot = activePotId ? zombies.potFor(activePotId) : zombies.combinePot;
    return {
      busy: pot.busy,
      ready: pot.ready,
      remainingMs: pot.remainingMs(),
      totalMs: pot.totalMs(),
      monolith: field.hasCombineMonolith(), // Clay Monolith speeds the pot timer
      canCollect: zombies.canAdd(),
      // The Pot can hand the child straight to the Mausoleum, so a full farm no
      // longer strands a finished combine.
      canStore: zombies.canStoreCombine(),
      pending: pot.pending
        ? {
            keyA: pot.pending.keyA, keyB: pot.pending.keyB,
            maskA: pot.pending.maskA, maskB: pot.pending.maskB,
            colorA: pot.pending.colorA, colorB: pot.pending.colorB,
          }
        : null,
      // Only set once the combine is done: the panel then shows the finished
      // zombie in place of the two parents until it is collected.
      result: zombies.combinePreview(activePotId ?? undefined),
    };
  };
  // The Zombie Pot panel's own Insta-Grow. Deliberately the SAME steps the tool takes
  // when you tap the building (see tryInstaGrow): finish the job, spend the use through
  // the server when online, play the cue, save. Nothing is spent unless the pot really
  // had a running combine to finish.
  hud.onPotInstaGrow = () => {
    if (onlineGameplayBlocked()) return false;
    const def = growBoostDef();
    if (!def || state.boostCount(def.key) <= 0) return false;
    const potId = activePotId ?? field.zombiePotId();
    if (!potId || !zombies.finishCombineNow(potId)) return false;
    if (state.onInventory) {
      state.onInventory({ type: "use", key: def.key, target: "zombie_pot" }, { count: -1 });
    } else state.useBoost(def.key);
    audio.play("instaGrow");
    const point = field.objectWorkPoint(potId);
    if (point) floatText(point.x, point.y - 48, "Ready!");
    saveManager.save();
    return true;
  };
  hud.canCombineZombie = (key, slot) => {
    const def = zombieDefs.get(key);
    return !def?.rewardOnly && !(slot === "B" && def?.category === "special");
  };
  hud.onCombine = async (idA, idB) => {
    if (onlineGameplayBlocked()) return false;
    if (!activePotId) return false;
    try { if (economy) [idA, idB] = await economy.settleUnitIds([idA, idB]); }
    catch { hud.showToast("Could not confirm those zombies. Please reconnect."); return false; }
    const ok = zombies.combine(idA, idB, potBaseMs(), activePotId);
    if (ok) {
      saveManager.flushCritical();
    }
    return ok;
  };
  hud.onCollectCombine = async (stored) => {
    if (onlineGameplayBlocked()) return null;
    if (!activePotId) return null;
    const targetPotId = activePotId;
    const pending = zombies.potFor(targetPotId).pending;
    const combined = pending ? combinedPotSubjects(pending) : null;
    // The child climbs out of the POT it was brewed in, not out of the farmer.
    const at = zombies.objectArrivalTile(targetPotId);
    const z = zombies.collectCombine(at.col, at.row, targetPotId, { stored });
    if (z) {
      if (combined?.subject) {
        questBus.post(QuestEvent.CombinerCombined, combined.subject, 1, combined.aliases);
      }
      // Fires for every collection — promotion or not, farm or Mausoleum — so a
      // "collect N from the Pot" objective counts what its wording says.
      questBus.post(QuestEvent.CombinerCollected, z.typeName, 1, unitSubjectAliasesOf(z));
      // Only a species neither parent was counts as "combined for" — see
      // isCombinePromotion. A job with no snapshot to compare against keeps the
      // old unconditional behavior rather than silently losing quest progress.
      if (!pending || isCombinePromotion(z.key, pending.keyA, pending.keyB)) {
        questBus.post(QuestEvent.CombinerHarvested, z.typeName, 1, unitSubjectAliasesOf(z));
      }
      const c = tileCenter(z.col, z.row);
      floatText(c.x, c.y, z.mutation ? `${z.name}!` : z.name);
      // No toast naming the result: the Pot's ready view already shows the finished
      // zombie — portrait, name and inherited mutations — before it is collected.
      try { await economy?.settleBeforeDependency(); }
      catch { hud.showToast("The combine result is waiting for the server to reconnect."); }
      zombies.confirmCombineCollection(targetPotId);
      saveManager.flushCritical();
    } else if (zombies.combineReadyFor(targetPotId) &&
               (stored ? zombies.canStoreCombine() : zombies.canAdd())) {
      // The job is still ready and the chosen destination has room, so this was not the
      // ordinary "wait for a slot" refusal — the collection could not be handed to the
      // server (or its species no longer resolves). collectCombine has already put the
      // job back; say so rather than letting the button appear dead.
      hud.showToast("That combine could not be confirmed just now — it is still in the Pot. Try again in a moment.");
    }
    return z ? z.name : null;
  };

  // ---- raids / invasions ----
  const raidCooldownMs = RAID_COOLDOWN_MS;
  // Raid completion is a critical boundary (rewards/casualties/cooldown): flush()
  // persists the save immediately, and flush the economy so the raid's gold/brains/xp
  // ledger events land now rather than behind the debounce.
  const raids = new RaidManager(
    assets,
    state,
    zombies,
    // Raid settlement is the authoritative write. A synchronous presentation flush
    // here used to race /raid/finish for the writer-operation lock; schedule the
    // visual save normally and let the durable finish go first.
    {
      save: () => { saveManager.save(); void economy?.flush(); },
      grantZombie: (key) => {
        const name = zombieDefs.get(key)?.name ?? "Rare zombie";
        hud.showToast(grantEarnedZombie(key)
          ? `${name} joined your farm!`
          : `${name} was sent to Received.`);
      },
      placedCount: (key) => field.placedCount(key),
    },
    raidCooldownMs
  );
  hud.getRaidCards = () => raids.raidCards();
  hud.getRaidParty = () => raids.partyView();
  hud.getRaidStatus = () => ({
    cooldownMs: raids.cooldownRemaining(),
    voucherCount: raids.voucherCount(),
    brainTicketCount: raids.brainTicketCount(),
  });
  const selectEpicBoss = (bossId: string | null | undefined) => {
    const def = epicBossById(bossId) ?? DR_GROUNDHOG;
    if (epicBoss.def.id !== def.id) epicBoss = new EpicBossManager(def);
    return def;
  };
  // The prize panel shows each drop's OWN art (epicBoss/lootImage); `def.lootIcon` is
  // the one-per-boss badge it falls back to, and used to be all any drop ever showed.
  const epicLootArt = { placeables: assets.placeables, pets: assets.pets };
  const epicRun = () => {
    selectEpicBoss(state.epicBossRun?.bossId);
    return epicBoss.normalize(state.epicBossRun);
  };
  hud.getEpicBossView = () => {
    const run = epicRun();
    const now = Date.now();
    const active = epicBoss.isActive(run);
    const shownBosses = visibleEpicBosses(EPIC_BOSSES, active && run ? run.bossId : null);
    return shownBosses.map((def) => {
      const ownRun = run?.bossId === def.id ? run : null;
      const ownActive = active && ownRun !== null;
      return {
        id: def.id, name: def.name,
        portrait: epicAsset(def, def.portrait), questIcon: epicAsset(def, def.questIcon),
        costBrains: def.costBrains, unlockLevel: epicBossUnlockLevel(def),
        levelLocked: state.level < epicBossUnlockLevel(def), maxLevel: def.maxLevel,
        reconstructed: !!def.reconstructed, blocked: active && !ownActive,
        run: ownRun, active: ownActive,
        expired: !!ownRun && !ownRun.completedAt && now >= ownRun.expiresAt,
        completed: !!ownRun?.completedAt,
        eventRemainingMs: ownActive && ownRun ? Math.max(0, ownRun.expiresAt - now) : 0,
        encounterRemainingMs: ownActive && ownRun?.encounterStartedAt
          ? Math.max(0, ownRun.encounterStartedAt + def.encounterMs - now) : 0,
        rewards: def.loot.map((loot) => loot.name),
        zombieRewards: epicZombieRewardNotes(def, assets.quests),
        favoriteCrop: assets.plants.find((plant) => plant.key === favoriteCropOf(def.id))?.name ?? null,
      };
    });
  };
  const syncEpicBossUi = () => {
    const run = epicRun();
    const active = epicBoss.isActive(run);
    quests.setEpicBossActive(active, active ? epicBoss.def.questIds : []);
    const days = active && run ? Math.max(1, Math.ceil((run.expiresAt - Date.now()) / 86_400_000)) : 0;
    hud.setBossShortcut(active, days ? `Boss · ${days}d` : "Boss");
  };
  // Runs whose start has already been announced, so the popup fires once per event.
  // Seeded from the first state we adopt — that one is the bootstrap, and an event
  // already under way when the game loaded is not news.
  const announcedEpicRuns = new Set<string>();
  let adoptedEpicBossState = false;
  const announceEpicBossStart = (bossId: string, luredCropKey: string | null) => {
    const def = epicBossById(bossId);
    const run = epicRun();
    if (!def || !run) return;
    const crop = luredCropKey ? assets.plants.find((plant) => plant.key === luredCropKey) : null;
    void showEpicBossStart(hud.el, {
      name: def.name,
      portrait: epicAsset(def, def.portrait),
      maxLevel: def.maxLevel,
      days: Math.max(1, Math.round(def.durationMs / 86_400_000)),
      // A lure with an unrecognised crop key still announces — as a plain start, not a
      // sentence with a hole in it.
      luredBy: crop?.name ?? null,
      onView: () => hud.openMarket("Epic Boss"),
    });
  };
  // No token FX here any more: a harvested token is popped by awardEpicBossToken, at
  // the plot it came from, in the frame the crop was pulled. This handler adopts the
  // authoritative run (the count it carries already includes any grant still waiting in
  // the outbox — see EconomyClient.withPendingBossTokens) and is also where a
  // SERVER-lured event surfaces: the Worker rolled it while replaying a harvest, so the
  // first this client hears of it is the projection arriving with `startedCrop` set.
  if (economy) economy.onEpicBossState = (run) => {
    state.setEpicBossRun(run ?? null);
    syncEpicBossUi();
    const current = epicRun();
    const adopted = current
      ? { runId: current.runId, startedCrop: current.startedCrop, active: epicBoss.isActive(current) }
      : null;
    const announce = shouldAnnounceEpicBossStart(
      adopted, { adopted: adoptedEpicBossState, announced: announcedEpicRuns }
    );
    adoptedEpicBossState = true;
    if (!current) return;
    // Remember the run either way. On the bootstrap adoption that is what suppresses a
    // popup for an event that was already under way when the game loaded.
    announcedEpicRuns.add(current.runId);
    if (announce) announceEpicBossStart(current.bossId, current.startedCrop ?? null);
  };
  /** Offline twin of the Worker's lure roll. Single-player, so the client is the only
   *  authority there is. Assigned in both modes and gated by its one caller, which
   *  skips it whenever `state.onFarm` is set — that hook exists only online, and online
   *  the Worker owns this roll (server/src/v3/engine.ts maybeLureEpicBoss). */
  lureEpicBossOffline = (cropKey, growMs) => {
    if (epicBoss.isActive(state.epicBossRun)) return;
    const bossId = bossForFavoriteCrop(cropKey);
    const def = bossId ? epicBossById(bossId) : null;
    if (!def || state.level < epicBossUnlockLevel(def) || !luresEpicBoss(growMs)) return;
    selectEpicBoss(def.id); // point the manager at THIS boss before it activates one
    const run = { ...epicBoss.activate(crypto.randomUUID()), startedCrop: cropKey };
    state.setEpicBossRun(run);
    announcedEpicRuns.add(run.runId);
    // Same order as the bought activation below: the run is live before syncEpicBossUi
    // marks it active, and the quest rail reopens only after that.
    syncEpicBossUi();
    quests.reopenEpicQuests(def.questIds);
    saveManager.flush();
    audio.play("buy");
    announceEpicBossStart(def.id, cropKey);
  };
  hud.onActivateEpicBoss = async (bossId) => {
    if (epicBoss.isActive(state.epicBossRun)) return false;
    const def = selectEpicBoss(bossId);
    const unlockLevel = epicBossUnlockLevel(def);
    if (state.level < unlockLevel) {
      hud.showToast(`${def.name} unlocks at level ${unlockLevel}.`);
      return false;
    }
    if (onlineFarm) {
      try {
        await economy?.settleBeforeDependency();
        const activated = await api.epicBossActivate(crypto.randomUUID(), def.id);
        const activatedRun = epicBossRunToClient(activated.event, activated.serverTime ?? Date.now());
        // `activated.quests` is the Worker's reopen of this boss's finished quests —
        // a repeat run earns its prizes, signature zombie included, all over again.
        economy?.adoptEpicBossActivation(activated.event, activated.balance, activated.serverTime, activated.quests);
        state.setEpicBossRun(activatedRun);
        syncEpicBossUi();
        saveManager.flush();
        audio.play("buy");
        // Claim the announcement here rather than letting the settle handler find it: a
        // bought run carries no `startedCrop`, so that path would ignore it anyway, and
        // marking it announced keeps the two routes from ever racing over one event.
        if (activatedRun) announcedEpicRuns.add(activatedRun.runId);
        announceEpicBossStart(def.id, null);
        return true;
      } catch (error) {
        const code = errCode(error);
        hud.showToast(code === "locked" ? `${def.name} unlocks at level ${unlockLevel}.`
          : code === "insufficient_brains" ? `You need ${def.costBrains} brains.`
          : code === "gameplay_unavailable" || code === "offline" ? "Reconnecting to the farm serverâ€¦"
          : "The Epic Boss event could not be started.");
        return false;
      }
    }
    if (!state.spendBrains(def.costBrains, "epic_boss_activate")) return false;
    const bought = epicBoss.activate(crypto.randomUUID());
    state.setEpicBossRun(bought);
    // Offline twin of the Worker's reopen (v3/epicBoss.activate): a new run puts this
    // boss's finished quests back on the rail so they pay out again. After
    // setEpicBossRun, so syncEpicBossUi's setEpicBossActive can surface them.
    syncEpicBossUi();
    quests.reopenEpicQuests(def.questIds);
    saveManager.flush();
    audio.play("buy");
    announcedEpicRuns.add(bought.runId);
    announceEpicBossStart(def.id, null);
    return true;
  };
  hud.onEndEpicBoss = async () => {
    const run = epicRun();
    if (!run || !epicBoss.isActive(run)) return false;
    if (onlineFarm) {
      try {
        await economy?.settleBeforeDependency();
        const ended = await api.epicBossEnd(run.runId);
        state.setEpicBossRun(epicBossRunToClient(ended.event, ended.serverTime ?? Date.now()));
      } catch (error) {
        const code = errCode(error);
        hud.showToast(code === "inactive" ? "That Epic Boss event has already ended."
          : "The Epic Boss event could not be ended.");
        return false;
      }
    } else {
      const ended = epicBoss.end(run);
      if (!ended) return false;
      state.setEpicBossRun(ended);
    }
    syncEpicBossUi();
    saveManager.flush();
    return true;
  };
  syncEpicBossUi();
  window.setInterval(syncEpicBossUi, 60_000);
  // ---- Tim Buckwheat guided tutorial (first-run) ----
  // A DOM overlay layer that leads the player through the core farm loop. It
  // coexists with the quest rail (subscribes to the same questBus, polls live
  // state) and mutates no gameplay systems. See src/tutorial/.
  // Quietly absorb rapid relaunch taps during the server's minimum invasion window.
  // This mainly covers an immediate retreat to correct the selected army order while
  // the result request is still releasing the shared raid/Epic-Boss session lock.
  let raidLaunchLockedUntil = 0;
  tutorial = new TutorialController({
    hud, state, field, zombies, questBus,
    // Screen-pixel center of a plot origin (world → global for the arrow).
    plotScreenPos: (col, row) => {
      const c = field.plotCenterOf(col, row);
      const g = world.toGlobal(new Point(c.x, c.y));
      return { x: g.x, y: g.y };
    },
    // Reuse the tutorial zombie's plot when restoring an older in-progress save;
    // otherwise find empty ground near the farmer. This only selects a target —
    // the tutorial's Plow step creates the soil through the real job/backend path.
    findTutorialPlot: (preferExisting = false) => {
      const plots = field.serialize();
      if (preferExisting) {
        const existing = plots.find((p) => p.crop?.key === TUTORIAL_ZOMBIE_KEY)
          ?? plots.find((p) => p.state === "plowed" && !p.crop);
        if (existing) return { col: existing.oc, row: existing.or };
      }
      const anchors: [number, number][] = [
        [start.col + 4, start.row + 1], [start.col + 4, start.row - 3],
        [start.col - 5, start.row + 1], [start.col + 1, start.row + 5],
        [start.col + 1, start.row - 5], [start.col - 5, start.row - 3],
      ];
      for (const [c, r] of anchors) {
        const t = field.resolveTill(c, r);
        if (t.valid) return { col: t.oc, row: t.or };
      }
      return null;
    },
    isRaidActive: () => raidActive,
    // Plant and Insta-Grow are causally dependent server mutations. Confirm the
    // tutorial crop before the boost beat so an older plant projection cannot
    // overwrite the optimistic ripe timestamp from the first power use.
    settlePlant: () => economy?.settleBeforeDependency() ?? Promise.resolve(),
    grantCompletionBonus: () => {
      state.addGold(200);
      economy?.submitTutorialCompletion();
    },
  });
  // Kick off on a brand-new farm (never while visiting a friend); restore mid-run
  // otherwise. The fresh-farm detection (restored/visiting) happened at load above.
  if (!visiting) {
    if (!restored) tutorial.start();
    else tutorial.restore(state.tutorial);
  }

  // ---- save profiles: switch/create flush + reload so the whole game reloads
  // cleanly from the target profile; rename/delete just update the index. ----
  hud.getProfiles = playMode === "local" ? () => profiles.listProfiles() : null;
  // Flush the current game to its (still-active) profile, then STOP saving before
  // moving the active pointer — otherwise this page's beforeunload/autosave would
  // write the outgoing game into the profile we're switching into. The reload
  // then loads the target profile cleanly (fresh, for a brand-new one).
  hud.onSwitchProfile = playMode === "local" ? (id) => {
    saveManager.save();
    saveManager.suspend();
    profiles.setActive(id);
    location.reload();
  } : null;
  hud.onCreateProfile = playMode === "local" ? (name) => {
    saveManager.save();
    saveManager.suspend();
    profiles.setActive(profiles.createProfile(name)); // fresh (no save) → new game on reload
    location.reload();
  } : null;
  hud.onRenameProfile = playMode === "local" ? (id, name) => profiles.renameProfile(id, name) : null;
  hud.onDeleteProfile = playMode === "local" ? (id) => profiles.deleteProfile(id) : null;
  hud.onSwitchFarm = (destination) => {
    saveManager.flush();
    void economy?.flush().catch(() => {});
    saveManager.suspend();
    setPreferredPlayMode(destination);
    location.reload();
  };
  // Online has no full blob on this device (only presentation), so the file is
  // serialised from the live server-hydrated game. Settle the outbox first, or a
  // just-spent balance / just-harvested zombie would be missing from the copy.
  const exportOnlineFarm = async () => {
    try { await economy?.flush(); } catch { /* the durable outbox retries on its own */ }
    saveManager.flushCritical();
    const raw = saveManager.exportOnline();
    if (!raw) {
      hud.showToast("Online Farm could not be exported.");
      return;
    }
    downloadSaveFile(raw, "online");
    hud.showToast("Online Farm exported. Load it with Local Farm's Import.");
  };
  hud.onExportSave = playMode === "local" ? () => {
    saveManager.flushCritical();
    const raw = saveManager.exportLocal();
    if (!raw) {
      hud.showToast("Local Farm could not be exported.");
      return;
    }
    downloadSaveFile(raw, "local");
    hud.showToast("Local Farm backup exported.");
  } : () => { void exportOnlineFarm(); };
  hud.onImportLocal = playMode === "local" ? (raw) => {
    if (!saveManager.importLocal(raw)) return false;
    saveManager.suspend();
    location.reload();
    return true;
  } : null;
  hud.onResetLocal = playMode === "local" ? () => {
    saveManager.suspend();
    saveManager.clear();
    location.reload();
  } : null;
  // Available in both farm modes — the service worker serves the app shell either way.
  hud.onCheckForUpdate = () => checkForUpdate();

  // ---- friends: OFFLINE path (local stub, autosaved via GameState.onChange).
  // Used when no server is configured or the player is signed out. ----
  hud.getFriends = () => state.friends;
  hud.onAddFriend = (name) => state.addFriend(name);
  hud.onRemoveFriend = (id) => { state.removeFriend(id); };
  hud.onGiftBrain = (id) => state.giftBrain(id);

  // ---- friends: ONLINE path (server ground truth via net/api + net/auth).
  // The whole block is inert when no server is configured; every hook falls back
  // to the offline path above. state.friends doubles as the display cache. ----
  const errCode = (e: unknown) => e instanceof api.ApiError ? e.code
    : e instanceof Error && e.message ? e.message : "error";
  const finishEpicBossOnline = async (sessionId: string, finalTick: number, inputs: api.RaidReplayInput[]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await api.epicBossFinish(sessionId, finalTick, inputs);
      } catch (error) {
        lastError = error;
        // Deterministic validation/client errors will not improve on retry. Network
        // failures and 5xx responses may have committed server-side but lost the
        // response; finish is idempotent, so retrying safely recovers that result and
        // prevents a live session from looking like "another battle" afterward.
        if (error instanceof api.ApiError && error.status > 0 && error.status < 500) throw error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  let inboxCache: { id: string; fromName: string }[] = [];
  let requestsCache: { fromAccountId: string; name: string }[] = [];

  hud.onlineAvailable = () => playMode === "online" && auth.isOnlineAvailable();
  hud.socialOnline = () => onlineFarm && auth.isSignedIn();
  hud.myAccount = () => {
    const s = api.getSession();
    return s ? { name: api.displayName(s), friendCode: s.friendCode } : null;
  };
  hud.refreshAccount(); // now that myAccount is wired, show the real name in the nameplate
  hud.renderAuthButton = (el) => void auth.renderSignInButton(el);
  hud.onSignOut = async () => {
    saveManager.save(); // flush latest to the server first
    try { await economy?.flush(); } catch { /* the durable outbox will retry next sign-in */ }
    saveManager.suspend();
    await auth.signOut();
    location.reload(); // back to the sign-in gate
  };
  // Permanent deletion, both modes. Written as ONE mode-branched assignment on
  // purpose: the hooks in this block are assigned unconditionally (they check the
  // mode when CALLED, not here), so a second unguarded `hud.onDeleteAccount = …`
  // earlier in the file would simply be overwritten — which is exactly what the
  // first version of this did, leaving Local Farm's delete button quietly calling
  // the server and failing.
  hud.onDeleteAccount = playMode === "local" ? async () => {
    // No account and no server call: on this side the farm IS the save, so
    // clearing it (and the backup, which `clear` handles) is the whole operation.
    // Reloading then boots the ordinary new-game path.
    saveManager.suspend(); // one-way, but the next line is the delete — nothing to save
    saveManager.clear();
    location.reload();
    return null;
  } : async () => {
    try {
      await api.deleteAccount();
    } catch (e) {
      // Refused — a live trade, or a batch still in flight. Nothing was deleted and
      // the farm is genuinely still playable, so leave the autosave alone and let the
      // dialog explain. Two things have to hold for "still playable" to be true, and
      // both are one-way if they are got wrong: `suspend()` is deliberately NOT called
      // before this point, and `api.deleteAccount` deliberately does not release the
      // writer lease before the call — releasing it here would leave a surviving farm
      // unable to write, behind a takeover gate it has no reason to be behind.
      //
      // The code rides the diagnostics trail: a player who reports "it says come
      // back later" can paste a crumb that says WHICH refusal, or that the server
      // itself failed (`purge_failed`, which is the maintainer's problem, not theirs).
      const code = errCode(e);
      crumb("account:delete-refused", code);
      return code;
    }
    // Past here the account is gone and the session with it. Stop the autosave so
    // no pending flush fires at a server row that no longer exists, then reload
    // into the sign-in gate — where the same Google account signs in to a brand-new
    // farm, because the server freed the id along with the row.
    saveManager.suspend();
    location.reload();
    return null;
  };
  hud.onSetUsername = async (name) => {
    try {
      await api.setUsername(name);
      hud.refreshAccount();
      return null;
    } catch (e) {
      // Not errCode: a content refusal carries a `reason` in the body, and dropping
      // it here is what left Settings explaining a blocked name as a network fault.
      return {
        code: errCode(e),
        reason: e instanceof api.ApiError
          ? (e.body as { reason?: string } | null)?.reason
          : undefined,
      };
    }
  };
  hud.getBlackMarketOrders = (query) => api.blackMarketOrders(query);
  hud.onCreateBlackMarketOrder = async (input) => {
    if (!economy) throw new Error("online_gameplay_unavailable");
    const expectedAccountVersion = await economy.prepareExternalMutation();
    const operationId = crypto.randomUUID();
    const result = input.kind === "SELL_ZOMBIE"
      ? await api.createBlackMarketOrder({ ...input, unitId: economy.authoritativeUnitId(input.unitId), operationId, expectedAccountVersion })
      : await api.createBlackMarketOrder({ ...input, operationId, expectedAccountVersion });
    await economy.refreshAuthoritative();
    saveManager.flushCritical();
    return result;
  };
  hud.onCancelBlackMarketOrder = async (orderId) => {
    if (!economy) throw new Error("online_gameplay_unavailable");
    const expectedAccountVersion = await economy.prepareExternalMutation();
    const result = await api.cancelBlackMarketOrder(orderId, crypto.randomUUID(), expectedAccountVersion);
    await economy.refreshAuthoritative();
    saveManager.flushCritical();
    return result;
  };
  // A repost only re-dates the caller's own listing — no escrow, no currency, no
  // roster — so unlike every other market action it needs no CAS boundary and no
  // authoritative refresh afterwards.
  hud.onRepostBlackMarketOrder = async (orderId) => {
    if (!economy) throw new Error("online_gameplay_unavailable");
    return api.repostBlackMarketOrder(orderId);
  };
  hud.onFulfillBlackMarketOrder = async (order, unitId) => {
    if (!economy) throw new Error("online_gameplay_unavailable");
    const expectedAccountVersion = await economy.prepareExternalMutation();
    const operationId = crypto.randomUUID();
    let result: Awaited<ReturnType<typeof api.fulfillBlackMarketOrder>> | undefined;
    // The seller may be completing a command batch at the exact instant the buyer
    // accepts the listing. That lock is transient; retry the same idempotent market
    // operation instead of making an affordable listing look unpurchasable.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await api.fulfillBlackMarketOrder(order.id, operationId, expectedAccountVersion,
          unitId ? economy.authoritativeUnitId(unitId) : undefined);
        break;
      } catch (error) {
        if (!(error instanceof api.ApiError) || error.code !== "counterparty_busy" || attempt === 2) throw error;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    if (!result) throw new Error("market_fulfillment_failed");
    await economy.refreshAuthoritative();
    saveManager.flushCritical();
    return result;
  };
  hud.getBlackMarketFulfillments = async () => (await api.blackMarketFulfillments()).fulfillments;
  hud.onCollectBlackMarketOrder = async (orderId, awaitingClaim) => {
    // A card that owes this account a zombie mints it here, so that side needs the
    // same writer preparation as any other external mutation. A pure acknowledgment
    // (the payment-earned card) still does not.
    if (awaitingClaim) await economy?.prepareExternalMutation();
    // The BALANCE has to move on screen either way: a sale's payment is PAID OUT by
    // this call (the market held it until now), and a filled request's was credited
    // at settlement — an event this client never observed. Without adopting a fresh
    // balance neither shows up until the next bootstrap or command batch.
    const result = await api.collectBlackMarketOrder(orderId);
    // Exactly one of these is set, by the post's own currency; the panel already knows
    // which coin the card was priced in, so it only needs the amount.
    const paid = result.brainsPaid ?? result.goldPaid ?? 0;
    // A claimed zombie arrives as a roster row this client has never seen, and a payout
    // bumps the account version server-side (it moves real currency). Both need the
    // authoritative refresh rather than the cheap balance adopt: adopting a balance
    // alone would leave this client's expectedAccountVersion one behind, so its very
    // next command batch would 409 into a conflict rebase.
    if (result.claimed || paid) await economy?.refreshAuthoritative();
    // Remain compatible while the manually deployed Worker rolls forward: an older
    // one omits the balance, so pay for a second round-trip only in that case.
    else if (result.balance) economy?.adoptExternalBalance(result.balance);
    else await economy?.refreshAuthoritative();
    return { claimed: result.claimed ?? null, paid };
  };
  hud.getBlackMarketHistory = () => api.blackMarketHistory();
  hud.refreshFriends = async () => {
    const list = await api.getFriends();
    state.friends = list.map(api.toFriend); // server list becomes the cache
  };
  // The friend leaderboard (Social → Leaderboard). A plain passthrough: the panel
  // owns its loading/error states, and the ranking is pure (social/leaderboard.ts).
  hud.getFriendLeaderboard = () => api.getFriendLeaderboard();
  hud.onAddFriendCode = async (code) => {
    try {
      await api.addFriend(code);
      await hud.refreshFriends?.();
      return null;
    } catch (e) {
      return errCode(e);
    }
  };
  hud.onGiftBrainOnline = async (friendId) => {
    try {
      const result = await api.sendGift(friendId);
      // Remain compatible while the manually deployed Worker rolls forward.
      if (result.balance) economy?.adoptExternalBalance(result.balance, result.accountVersion);
      if (result.lastRaidAt != null) state.syncRaidCooldown(serverTimestampToClient(
        result.lastRaidAt,
        result.serverTime ?? Date.now(),
      ));
      return null;
    } catch (e) {
      return errCode(e);
    }
  };
  // ---- friend requests (consent flow) ----
  hud.refreshRequests = async () => {
    const reqs = await api.getFriendRequests();
    requestsCache = reqs.map((r) => ({ fromAccountId: r.fromAccountId, name: r.name }));
  };
  hud.getRequests = () => requestsCache;
  hud.onAcceptRequest = async (fromAccountId) => {
    try {
      await api.acceptFriend(fromAccountId);
      await hud.refreshFriends?.();
      return null;
    } catch (e) {
      return errCode(e);
    }
  };
  hud.onRejectRequest = async (accountId) => {
    try { await api.rejectFriend(accountId); } catch { /* best-effort */ }
  };
  hud.onRemoveFriend = async (id) => {
    // Online: unfriend server-side then refresh. Offline path handled above.
    if (onlineFarm) await api.removeFriendOnline(id);
    else state.removeFriend(id);
  };
  hud.onBlockFriend = async (accountId) => {
    await api.blockFriend(accountId);
  };
  hud.onRotateCode = async () => {
    try { return await api.rotateFriendCode(); } catch { return null; }
  };
  hud.onListSessions = () => api.listSessions();
  hud.onRevokeSession = async (id) => {
    try { await api.revokeSession(id); return true; } catch { return false; }
  };
  // Visit a friend's farm: stash the target and reload into read-only visit mode
  // (see net/visit.ts + the visit branch at load time above).
  hud.onVisitFriend = (friendId, name) => enterVisit({ id: friendId, name });
  hud.refreshInbox = async () => {
    const gifts = await api.getInbox();
    inboxCache = gifts.map((g) => ({ id: g.id, fromName: g.fromName }));
  };
  hud.getInbox = () => inboxCache;
  hud.onClaimGift = async (id, opts) => {
    try {
      // Gift claims are server-fenced independently of the gameplay writer. Do not
      // let a paused queue or a writer lease held by another tab block acceptance.
      const claimed = economy ? await economy.claimGift(id) : await api.claimGift(id);
      // "Open all" suppresses this and refreshes once at the end: one pull per gift
      // would double the request count of a bulk open for no benefit.
      if (opts?.refreshInbox !== false) {
        try { await hud.refreshInbox?.(); }
        catch (refreshError) { console.warn("[gift] inbox refresh failed", errCode(refreshError)); }
      }
      // The server decides (and reports) the contents. A claim that credited nothing
      // (already opened on another device) has no reward to reveal — say so rather
      // than guessing at a payout the player never received.
      if (!claimed.credited) return null;
      return claimed.reward ?? { kind: "brain" as const, amount: 1 };
    } catch (e) {
      const code = errCode(e);
      console.warn("[gift] claim failed", code);
      const reason: Record<string, string> = {
        operation_in_progress: "your farm is still saving; try again in a moment",
        rate_limited: "too many requests; wait a minute and try again",
        offline: "the game server could not be reached",
        unauthorized: "your session expired; sign in again",
        no_session: "you need to sign in again",
        client_upgrade_required: "reload the page to update the game",
      };
      return `Couldn't claim gift: ${reason[code] ?? code}.`;
    }
  };

  // (Sign-in is handled by the pre-game gate; sign-out reloads via onSignOut.)

  // On boot, if signed in, renew the access token (keeps a long-lived tab fresh
  // against the shorter session TTL) and surface any waiting gifts / friend
  // requests with a gentle toast.
  if (onlineFarm) {
    // Bootstrap already supplied session gameplay/social summaries. Full friend
    // and inbox data remains on-demand when those menus open.
    void hud.refreshInbox?.().then(() => {
      const n = hud.getInbox?.().length ?? 0;
      if (n) hud.showToast(`You have ${n} gift${n === 1 ? "" : "s"} waiting! 🎁`);
    }).catch(() => { /* best-effort toast; offline boot must not surface an error */ });
    void hud.refreshRequests?.().then(() => {
      const n = hud.getRequests?.().length ?? 0;
      if (n) hud.showToast(`You have ${n} friend request${n === 1 ? "" : "s"}! 👋`);
    }).catch(() => { /* best-effort toast; offline boot must not surface an error */ });
    void hud.getBlackMarketFulfillments?.().then((rows) => {
      const n = rows.length;
      if (!n) return;
      // A zombie waiting to be claimed is the more urgent of the two — it is not on the
      // farm yet — so it names the toast whenever the batch contains one.
      const zombies = rows.filter((row) => row.awaitingClaim).length;
      if (zombies) hud.showToast(zombies === 1
        ? "A Black Market zombie is waiting for you! Visit the market to collect. 🧟"
        : `${zombies} Black Market zombies are waiting for you! Visit the market to collect. 🧟`);
      else {
        // Name the money when the market is holding some: this toast used to promise a
        // "collect" that only dismissed a notice, because the payment had already landed.
        // Sales can be priced in either currency, so both are named when both are owed.
        const owed = (["GOLD", "BRAINS"] as const)
          .map((currency) => ({
            currency,
            amount: rows.reduce((total, row) =>
              total + (row.awaitingPayout && row.currency === currency ? row.price : 0), 0),
          }))
          .filter((entry) => entry.amount > 0)
          .map((entry) => entry.currency === "GOLD"
            ? `${entry.amount.toLocaleString()} gold`
            : `${entry.amount.toLocaleString()} brain${entry.amount === 1 ? "" : "s"}`);
        hud.showToast(owed.length
          ? `${owed.join(" and ")} from your Black Market sales are waiting! Visit the market to collect. 💰`
          : n === 1
            ? "One of your Black Market posts was fulfilled! Visit the market to collect. 💰"
            : `${n} of your Black Market posts were fulfilled! Visit the market to collect. 💰`);
      }
    }).catch(() => { /* best-effort toast; a market-disabled server must not surface an error */ });
  }

  // Night lighting toggle (Developer menu). Was the N key; now driven from the HUD.
  hud.getNight = () => isNight;
  hud.onSetNight = (on) => setNight(on);

  // Farm Background picker (Settings): re-seed & rebuild the foliage ring live at
  // the new density — no reload, same spirit as the night toggle.
  hud.getFarmBackground = () => displayedFarmBackground;
  hud.onSetFarmBackground = (bg) => {
    displayedFarmBackground = bg;
    setFarmBackground(bg);
    buildFoliage();
    saveManager.save();
  };

  // Zombie appearance (Settings): both toggles are device-local display choices, so
  // they are persisted to prefs and applied live. The farm's standing zombies are
  // reassembled here; portraits re-render on demand because MutationPortraits keys its
  // cache by the appearance it draws, and raid actors are built fresh on entry.
  hud.getZombieAppearance = () => zombieAppearancePrefs();
  hud.onSetZombieAppearance = (prefs) => {
    setZombieBodyColorMode(prefs.bodyColor);
    setShowZombieMutations(prefs.showMutations);
    zombies.refreshAppearance();
  };
  // Per-zombie mutation toggles (the eye badges on a zombie's card) land the same
  // way: the choice is already persisted, so all that is left is to reassemble the
  // standing rigs. Portraits re-render on demand and raid actors are built fresh
  // on entry, exactly as with the Settings switches above.
  hud.onZombieAppearanceChanged = () => zombies.refreshAppearance();

  hud.getRaidBoosts = (raidId) => ({
    concentration: raids.concentrationCount(),
    dice: raids.diceCount(),
    maxDice: raids.maxDiceFor(raidId),
    brainTickets: raids.brainTicketCount(),
  });

  // Live battle scene — the ONLY way a raid is played out (no instant/auto-resolve in
  // the game; `raids.start` remains only for the `ZF.runRaid` dev hook + headless tests).
  // `raidActive` gates farm input synchronously (the scene loads its textures async);
  // `raidScene` is the running scene once ready.
  let raidScene: RaidScene | null = null;
  /** One launch at a time, decided synchronously, plus a stamp that lets a scene build
   *  landing late tell that it has been superseded. `raidActive` alone covers neither:
   *  it is set near the END of a launch (after the server gate and Tim's tips), and it
   *  cannot tell this build's fight from a later one. See src/raid/launchGate.ts. */
  const launchGate = new LaunchGate();

  /** Put the farm back after a battle that never got as far as its own teardown.
   *
   *  Both launch paths flip the farm into battle mode (jobs paused, world hidden, HUD
   *  in raid layout) BEFORE awaiting RaidScene.create, and every path that flips it
   *  back lives inside the scene's onFinish. So a scene that fails to build stranded
   *  the player on a blank screen with the farm frozen — `raidActive` stayed true, and
   *  nothing else in the session ever clears it. Online it also left the invasion
   *  session open, holding the roster locked and refusing the next fight until the
   *  15-minute TTL. A reload was the only way out. */
  /** How long a battle scene may spend loading before the launch is called a failure.
   *
   *  Generous — a phone on mobile data pulling a stage it has never cached is the case
   *  this must not punish — but finite, because the alternative is what was reported:
   *  the farm is already hidden, every path back out lives inside the scene's own
   *  `onFinish`, and a build that never settles leaves the player on a blank screen
   *  with a spent attempt and only a reload to escape. Timing out routes that into the
   *  catch below, which hands the farm back, says so, and — the part that matters for
   *  the next report — writes the reason into the diagnostics buffer. A soft-lock that
   *  records nothing is why the first report of this arrived saying "no errors". */
  const BATTLE_LOAD_TIMEOUT_MS = 45_000;

  /** Bound a battle-scene build in time. A build that lands after the deadline has
   *  nobody waiting on it, so it is torn down rather than left alive off-stage. */
  const withBattleLoadTimeout = (build: Promise<RaidScene>): Promise<RaidScene> => {
    let timedOut = false;
    let timer = 0;
    const expired = new Promise<RaidScene>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        timedOut = true;
        reject(new Error(`battle scene did not load within ${BATTLE_LOAD_TIMEOUT_MS} ms`));
      }, BATTLE_LOAD_TIMEOUT_MS);
    });
    void build.then(
      (scene) => { window.clearTimeout(timer); if (timedOut) scene.destroy(); },
      () => window.clearTimeout(timer),
    );
    return Promise.race([build, expired]);
  };

  /** The friend invasion this client currently holds open on the server. PvP allows one
   *  live session per attacker; every way a fight can end WITHOUT settling has to hand
   *  it back, or the player is locked out of all invasions until the 15-minute TTL runs
   *  down. Cleared the moment /raid/pvp/finish answers — settled or refused, the row is
   *  no longer ours to release. */
  let livePvpSession: string | null = null;
  const setLivePvpSession = (sessionId: string | null) => {
    livePvpSession = sessionId;
    api.setLiveInvasionSession(sessionId); // so a closed tab releases it too
  };
  const releasePvpSession = () => {
    const sessionId = livePvpSession;
    if (!sessionId) return;
    setLivePvpSession(null);
    // Fire-and-forget: the fight is already over on this side, and the TTL still
    // covers the case where this call never lands.
    void api.pvpAbandon(sessionId).catch(() => { /* best effort */ });
  };

  const abandonBattle = () => {
    crumb("battle:left", raidScene ? "scene torn down" : "never loaded");
    // Covers every non-settling exit from a friend invasion in one place: a scene that
    // failed to load, a settle the verifier refused, a teardown from elsewhere.
    releasePvpSession();
    if (raidScene) {
      app.stage.removeChild(raidScene.container);
      raidScene.destroy();
      raidScene = null;
    }
    raidActive = false;
    resumeFarmJobs();
    world.visible = true;
    hud.setRaiding(false);
    audio.exitRaid();
    // The farm is back even though the battle ended badly — a level-up earned before
    // things went wrong is still owed, and nothing else in the session would flush it.
    flushLevelUps();
  };

  hud.onLaunchEpicBoss = (partyIds, payment) =>
    launchGate.run(async () => launchEpicBoss(partyIds, payment), false);
  const launchEpicBoss: NonNullable<Hud["onLaunchEpicBoss"]> = async (partyIds, payment) => {
    if (raidActive || Date.now() < raidLaunchLockedUntil) return false;
    const def = selectEpicBoss(state.epicBossRun?.bossId);
    const gate = epicBoss.start(state.epicBossRun, partyIds);
    if (!gate.ok) {
      hud.showToast("That Epic Boss event is no longer active.");
      syncEpicBossUi();
      return false;
    }
    const cap = raids.partyView().cap;
    const selectedNames = new Map(zombies.roster().map((z) => [z.id, z.name]));
    let party: ReturnType<typeof zombies.roster> = [];
    let epicSessionId: string | null = null;
    if (onlineFarm) {
      try {
        await economy?.settleBeforeDependency();
        // Settlement may replace an optimistic harvest id, or remove that unit if
        // the server rejected its creation. Rebuild from the reconciled roster so a
        // stale army card can never reach the server as an opaque `bad_roster`.
        const settled = reconcilePartySelection(
          partyIds,
          zombies.roster().filter((z) => !z.stored),
          (id) => economy?.authoritativeUnitId(id) ?? id,
          cap
        );
        if (settled.missingIds.length) {
          const names = settled.missingIds.map((id) => selectedNames.get(id) ?? "A selected zombie");
          hud.showToast(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer available. Your army was refreshed.`);
          hud.refreshEpicBossArmy();
          return false;
        }
        partyIds = settled.ids;
        party = settled.party;
        if (!party.length) return false;
        const opened = await api.epicBossStart(partyIds, payment);
        epicSessionId = opened.sessionId;
        economy?.adoptEpicBossActivation(opened.event, opened.balance, opened.serverTime);
        state.setEpicBossRun(epicBossRunToClient(opened.event, opened.serverTime ?? Date.now()));
      } catch (error) {
        const code = errCode(error);
        if (code === "insufficient_tokens") hud.showToast("You need a Boss Token.");
        else if (code === "insufficient_brains") hud.showToast(`You need ${EPIC_BOSS_FIGHT_BRAIN_COST} brains.`);
        else if (code === "battle_in_progress") hud.showToast("Another battle is already in progress.");
        else if (code === "bad_roster") hud.showToast("One of those zombies is unavailable. Please choose your army again.");
        else if (code === "stale_ruleset") {
          // Same refusal, same remedy as an invasion (see the raid launch path): this tab
          // predates the deployed Worker, so it would simulate the fight under different
          // rules than the replay. Nothing was charged — no token, no brain, no session —
          // and only a reload fixes it, so say so instead of "please reconnect".
          hud.showToast("The game has updated. Reload to keep fighting.", 6000);
          promptReload("The game has updated. Reload to keep fighting.");
        }
        else hud.showToast("The Epic Boss fight could not be started. Please reconnect and try again.");
        return false;
      }
    } else {
      const settled = reconcilePartySelection(
        partyIds, zombies.roster().filter((z) => !z.stored), (id) => id, cap
      );
      partyIds = settled.ids;
      party = settled.party;
      if (!party.length) return false;
      if (payment === "token") {
        if ((gate.run.tokenCount ?? 0) < 1) { hud.showToast("You need a Boss Token."); return false; }
        state.setEpicBossRun({ ...gate.run, tokenCount: gate.run.tokenCount - 1 });
      } else {
        if (!state.spendBrains(EPIC_BOSS_FIGHT_BRAIN_COST, "epic_boss_fight")) {
          hud.showToast(`You need ${EPIC_BOSS_FIGHT_BRAIN_COST} brains.`);
          return false;
        }
        state.setEpicBossRun(gate.run);
      }
    }
    const paidRun = state.epicBossRun ?? gate.run;
    const setup = buildEpicBossSetup(def, paidRun, party, assets, state);
    pauseFarmJobs();
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true);
    // `.raiding` hides every piece of farm chrome and the battle's own HUD is drawn
    // inside the scene, so from here until the scene lands there is nothing on screen
    // at all — just the stage's clear colour. Say what is happening. See setBattleLoading.
    hud.setBattleLoading(true, `Loading ${def.name}…`);
    crumb("battle:launch", `${def.name} L${paidRun.level} · ${party.length} zombies · ${payment}`);
    audio.enterRaid(setup.raid.music);
    const epoch = launchGate.stamp();
    withBattleLoadTimeout(RaidScene.create(app, {
      raid: setup.raid,
      assets,
      playerUnits: setup.playerUnits,
      enemyUnits: setup.enemyUnits,
      bossThrow: null,
      roundMs: def.fightMs,
      escapeOnRoundEnd: true,
      noDistractions: true,
      imageBase: epicAsset(def, ""),
      bossTexture: epicAsset(def, def.bossTexture),
      bossPortrait: epicAsset(def, def.portrait),
      bossAnimations: def.animations,
      bossFallsFromSky: true,
      bossEngageDistance: 150,
      // The animated bosses sit high and left inside generously padded animation cells,
      // so their token is nudged to put the visible character on the ground line (Loco
      // Locust sits lower in his cells than the rest, so he needs less of a drop). A
      // reconstructed boss draws from a frame cut tight to its own art, with no padding
      // to compensate for, so it stands on the line unaided.
      // Keyed on `reconstructed`, not on whether strips exist: a reconstructed boss now
      // ships hand-ordered strips too, but they are cut tight to the art rather than
      // sitting inside ZF2's padded cells, so it still needs no compensation.
      bossGroundOffset: def.reconstructed
        ? { x: 0, y: 0 }
        : { x: 32, y: def.id === "loco-locust" ? 8 : 24 },
      onStrike: (strike) => audio.fightStrike(strike),
      onBrainRelease: (sourceKey) => audio.brainForZombie(sourceKey),
      confirmRetreat: () => hud.confirmInGame(
        "Retreat from battle?", `This attempt will end and ${def.name} will escape.`, "Retreat"
      ),
      onFinish: (outcome, finalTick, inputs) => {
        // `granted` is supplied ONLINE, where the server has already rolled the brain and
        // moved the balance by it. Rolling again here would print a number the account
        // never received — the gold half agrees either way, but the brain is an 8% chance
        // (EPIC_BRAIN_DROP_CHANCE) and would disagree most of the time.
        const presentResult = (
          result: ReturnType<EpicBossManager["finish"]>,
          drops: LootDrop[],
          granted?: { brains: number; gold: number }
        ) => {
        state.setEpicBossRun(result.run);
        const currency = granted ?? (result.defeatedLevel === null
          ? { brains: 0, gold: 0 }
          : epicBossCurrencyReward(result.defeatedLevel, def.maxLevel));
        if (result.defeatedLevel !== null && !onlineFarm) {
          state.addBrains(currency.brains, "epic_boss_victory");
          state.addGold(currency.gold, "epic_boss_victory");
          questBus.post(QuestEvent.EpicStageEnemyDefeated, String(result.defeatedLevel), 1);
          // Collected spans every place a prize can end up — unclaimed, in the shed, or
          // already standing on the farm — plus tamed pets. Received alone would treat a
          // claimed prize as never-won and keep re-offering it ahead of unseen ones.
          const collected = new Set([
            ...state.received,
            ...state.storedItems.filter((item) => item.count > 0).map((item) => item.key),
            ...def.loot.filter((loot) => loot.tile && field.placedCount(loot.tile) > 0).map((loot) => loot.name),
            ...state.ownedPets.map((key) =>
              def.loot.find((loot) => loot.stageActor === key)?.name ?? key),
          ]);
          for (const loot of rollEpicBossDrops(def, result.defeatedLevel, collected)) {
            if (loot.stageActor) state.unlockPet(loot.stageActor);
            else state.receiveItem(loot.name);
            questBus.post(QuestEvent.EpicBossEpicItemWon, loot.name, 1);
            drops.push({ name: loot.name, icon: epicLootImage(epicLootArt, def, loot) });
          }
          // Gold-side bonus on top of the decor rolls, scaled by how deep the rung was.
          if (Math.random() < epicBrainTicketChance(result.defeatedLevel, def.maxLevel)) {
            state.addBoost(BRAIN_TICKET_KEY, 1);
            drops.push({ name: "Brain Ticket", icon: `${BASE}assets/boosts/brain_ticket.png` });
          }
        }
        saveManager.flush();
        syncEpicBossUi();
        const view: RaidResultView = {
          win: result.defeatedLevel !== null,
          title: result.completed ? "EPIC BOSS DEFEATED" : result.defeatedLevel !== null ? "LEVEL CLEARED" : "BOSS ESCAPED",
          enemiesBeaten: result.defeatedLevel !== null ? 1 : 0,
          zombiesLost: outcome.losses.length,
          // An epic-boss rung pays no XP at all (prizes and currency only), so the
          // first-clear flag has nothing to label — the XP row never renders.
          gold: currency.gold, brains: currency.brains, xp: 0, firstClear: false,
          loot: drops, abilityUnlock: "",
        };
        hud.openRaidResult(view, () => {
          if (raidScene) { app.stage.removeChild(raidScene.container); raidScene.destroy(); raidScene = null; }
          raidActive = false;
          resumeFarmJobs();
          world.visible = true;
          hud.setRaiding(false);
          audio.exitRaid();
          flushLevelUps(); // and the level-up, if the fight's quest rewards crossed one
          flushQuestCompletions(); // celebrate on the farm, not over the result panel
        });
        };
        if (onlineFarm && epicSessionId) {
          void finishEpicBossOnline(epicSessionId, finalTick, inputs).then((server) => {
            zombies.recordInvasion(server.survivors);
            zombies.removeCasualties(server.losses);
            const rewardDrops: LootDrop[] = [];
            for (const unit of server.newZombies) {
              if (!unit.received) zombies.grantReward(unit.key, walk.tile.col, walk.tile.row, unit.id, unit.stored);
              rewardDrops.push(rewardZombieDrop(unit));
              hud.showToast(`${zombieDefs.get(unit.key)?.name ?? "Epic reward zombie"} joined your ${unit.received ? "Received storage" : unit.stored ? "Mausoleum" : "farm"}!`);
            }
            economy?.adoptEpicBossResult(server);
            void economy?.refreshAuthoritative().catch(() => { /* reconcile again on next settle */ });
            // The run's five epochs are the SERVER's clock. Translate them here — as
            // every other adopt does — before anything stores or compares them: the
            // event window, the encounter timeout and the retry gate are all read
            // against Date.now(), and isActive() also gates Boss Token drops. Writing
            // the raw projection back undid the conversion adoptEpicBossResult had
            // just applied, and only the async refresh above ever repaired it.
            // (Non-null: the helper answers null only for a nullish run, and a finish
            // response always carries one.)
            const serverRun = epicBossRunToClient(server.event, server.serverTime ?? Date.now())!;
            state.setEpicBossRun(serverRun);
            const result = {
              run: serverRun,
              defeatedLevel: server.defeatedLevel,
              completed: !!server.event.completedAt,
              escaped: server.escaped,
            };
            // `drops` is the authoritative list; `loot` is its first entry and the only
            // field a pre-multi-drop stored result carries, so fall back to it.
            const serverDrops = server.drops ?? (server.loot ? [server.loot] : []);
            presentResult(result, [
              ...serverDrops.map((entry) => ({
                name: entry.name, icon: epicLootImageByName(epicLootArt, def, entry.name),
              })),
              ...(server.brainTicket
                ? [{ name: "Brain Ticket", icon: `${BASE}assets/boosts/brain_ticket.png` }]
                : []),
              ...rewardDrops,
            ], server.currency ?? { brains: 0, gold: 0 });
          }).catch(() => {
            hud.showToast("The fight result could not be verified. Reconnecting will recover it.");
            abandonBattle();
            flushQuestCompletions();
          });
          return;
        }
        zombies.recordInvasion(outcome.survivors);
        zombies.removeCasualties(outcome.losses);
        const result = epicBoss.finish(paidRun, outcome.playerDamage, outcome.win);
        presentResult(result, []);
      },
    })).then((scene) => {
      hud.setBattleLoading(false);
      // The GAP to the launch crumb above is the measurement this whole trail exists for:
      // this step taking seconds instead of tenths is what the green-screen report was.
      crumb("battle:ready", def.name);
      if (!raidActive || !launchGate.isCurrent(epoch)) return scene.destroy();
      raidScene = scene;
      app.stage.addChild(scene.container);
      // Debug handle — dev builds only, mirroring the online launch path below.
      if (import.meta.env.DEV) {
        (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene;
      }
    }).catch((error) => {
      // The farm is already in battle mode and nothing downstream can undo that, so
      // hand it back here rather than leaving the player on a frozen blank screen.
      // The attempt is paid for by this point (brains or a token, and online a live
      // epic session), so say so rather than promising nothing happened. The resync
      // is what closes that session: bootstrap expires an abandoned one.
      // Catching this took it off `unhandledrejection`, which is what used to put it
      // in the player's diagnostics report — so record it explicitly. A soft-lock the
      // player can now escape is still the thing we most want to see in a bug report.
      recordDiagnostic({
        at: Date.now(), kind: "error", where: "epic-boss-scene",
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.warn("[epic boss] battle scene failed to load", error);
      crumb("battle:failed", def.name);
      abandonBattle();
      hud.showToast("The battle could not be loaded. This attempt was lost — reload and try again.", 6000);
      void economy?.refreshAuthoritative().catch(() => { /* recovered on the next sync */ });
    });
    return true;
  };
  // Server-owned raid cooldown: the session id from /raid/start, carried to
  // /raid/finish so the server starts the cooldown once the raid is done.
  let raidSessionId: string | null = null;
  // The live session's TTL, in this browser's clock domain, plus the last state the
  // player was told about so the ticker check below speaks only on a transition. The
  // server zeroes anything settled past this instant, and the fight cannot notice on
  // its own: it runs on the ticker, which stops dead while the page is hidden.
  let raidExpiresAt: number | null = null;
  let raidExpiryAnnounced: InvasionExpiryState = "ok";
  const clearRaidExpiry = () => { raidExpiresAt = null; raidExpiryAnnounced = "ok"; };

  // ---- Friend invasions (PvP). ONLINE only: the server pins the whole fight —
  // the chosen eight, a snapshot of the friend's deployed zombies as the enemy
  // team, and both reward tiers — and this client ADOPTS that config wholesale, so
  // the verified replay cannot diverge. Nobody loses anything; a verified win pays
  // boosts scaled by the opposing army's strength.
  const boostDefOf = (key: string) => assets.boosts.find((b) => b.key === key);
  const launchPvpBattle = (
    sessionId: string,
    config: NonNullable<Awaited<ReturnType<typeof api.pvpStart>>["config"]>,
    friendName: string
  ) => {
    const raidDef = buildPvpRaidDef(
      { raidName: config.raidName, defenderName: config.pvp.defenderName },
      assets.raids.find((r) => r.id === MCDONNELL_ID)
    );
    pauseFarmJobs();
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true);
    hud.setBattleLoading(true, `Invading ${friendName}'s farm…`);
    setLivePvpSession(sessionId);
    crumb("battle:launch", `pvp:${friendName} · ${config.playerUnits.length} zombies`);
    audio.enterRaid(raidDef.music);
    const epoch = launchGate.stamp();
    withBattleLoadTimeout(RaidScene.create(app, {
      raid: raidDef,
      assets,
      playerUnits: config.playerUnits,
      enemyUnits: config.enemyUnits,
      // ADOPTED, not null: formation mode perches a brute that throws, and the
      // server's verifier replays with it. Dropping it here would put the two
      // simulations out of step from the brute's first throw.
      bossThrow: config.bossThrow ?? null,
      waveCadence: config.waveCadence,
      // PvP always fights at full focus: pinned server-side, mirrored here — a
      // disagreement would desync the verified replay from tick 0.
      concentration: true,
      onStrike: (strike) => audio.fightStrike(strike),
      onBrainRelease: (sourceKey) => audio.brainForZombie(sourceKey),
      onVictory: () => audio.playRaidVictory(),
      confirmRetreat: () => hud.confirmInGame(
        "Retreat from the invasion?", "The fight ends and their defense holds.", "Retreat"
      ),
      onCheckpoint: undefined,
      onFinish: (outcome, finalTick, inputs) => {
        void api.pvpFinish(sessionId, finalTick, inputs, outcome).then((res) => {
          // Settled: the row is closed server-side, so stop tracking it. A refusal
          // takes the other path, where abandonBattle hands the session back — the
          // release is idempotent, so it costs nothing when the server had already
          // closed the row itself over an invalid replay.
          setLivePvpSession(null);
          // Boost rewards were granted into server inventory; adopt the echoed counts.
          if (res.inventory) economy?.adoptRaidStartInventory(res.inventory);
          const rewards = res.rewards ?? [];
          const view: RaidResultView = {
            win: !!res.win,
            title: res.win ? "FARM CONQUERED!" : "INVASION REPELLED",
            enemiesBeaten: res.outcome?.enemiesBeaten ?? outcome.enemiesBeaten,
            // Friendly fight: every fallen zombie walks home afterwards.
            zombiesLost: 0,
            gold: 0, brains: 0, xp: 0, firstClear: false,
            loot: rewards.map((r) => ({
              name: boostDefOf(r.key)?.name ?? r.key,
              icon: `${BASE}assets/boosts/${boostDefOf(r.key)?.icon ?? `${r.key}.png`}`,
              qty: r.qty,
            })),
            abilityUnlock: "",
          };
          hud.openRaidResult(view, () => {
            if (raidScene) { app.stage.removeChild(raidScene.container); raidScene.destroy(); raidScene = null; }
            raidActive = false;
            resumeFarmJobs();
            world.visible = true;
            hud.setRaiding(false);
            audio.exitRaid();
          });
          // A win past the daily rewarded-wins cap counts everywhere except the wallet.
          if (res.win && res.rewarded === false) {
            hud.showToast("Past today's rewarded wins — that one was for glory.", 6000);
          }
        }).catch((error) => {
          const code = error instanceof api.ApiError ? error.code : "unknown_error";
          hud.showToast(
            code === "stale_ruleset"
              ? "The game was updated during this invasion, so its result could not be settled. Nothing was lost."
              : "The invasion result could not be verified. Nothing was lost.",
            6000
          );
          abandonBattle();
        });
      },
    })).then((scene) => {
      hud.setBattleLoading(false);
      crumb("battle:ready", raidDef.name);
      if (!raidActive || !launchGate.isCurrent(epoch)) return scene.destroy();
      raidScene = scene;
      app.stage.addChild(scene.container);
      if (import.meta.env.DEV) {
        (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene;
      }
    }).catch((error) => {
      recordDiagnostic({
        at: Date.now(), kind: "error", where: "pvp-scene",
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.warn("[pvp] battle scene failed to load", error);
      crumb("battle:failed", raidDef.name);
      abandonBattle();
      hud.showToast("The invasion could not be loaded. Nothing was lost — try again.", 6000);
    });
  };
  hud.onInvadeFriend = (friendId, friendName) => {
    if (!PVP_UI_ENABLED) return; // parked — see docs/FRIEND_INVASIONS.md
    if (!onlineFarm) { hud.showToast("Friend invasions need an online farm."); return; }
    if (raidActive || launchGate.busy || Date.now() < raidLaunchLockedUntil) return;
    hud.openPvpArmy(friendName, (orderedIds) => void launchGate.run(async () => {
      try {
        await economy?.settleBeforeDependency();
        const settled = reconcilePartySelection(
          orderedIds,
          zombies.roster().filter((z) => !z.stored),
          (id) => economy?.authoritativeUnitId(id) ?? id,
          PVP_ARMY_SIZE
        );
        if (settled.missingIds.length || settled.ids.length !== PVP_ARMY_SIZE) {
          hud.showToast("Some chosen zombies are no longer available. Please pick your army again.");
          return;
        }
        const gate = await api.pvpStart(friendId, settled.ids);
        if (!gate.ok || !gate.sessionId || !gate.config) {
          const err = gate.error ?? "unknown";
          hud.showToast(
            err === "pair_limit"
              ? `You've already invaded ${friendName} ${gate.limit ?? 3} times today — try again tomorrow.`
              : err === "no_defense"
                ? `${friendName} has no zombies on their farm to defend it.`
                : err === "not_friends"
                  ? "You can only invade friends."
                  : err === "raid_in_progress"
                    ? "Another invasion is already in progress."
                    : "The invasion could not be started."
          );
          return;
        }
        raidLaunchLockedUntil = Math.max(raidLaunchLockedUntil, Date.now() + 15_000);
        launchPvpBattle(gate.sessionId, gate.config, friendName);
      } catch (error) {
        if (error instanceof api.ApiError) {
          const body = (error.body ?? {}) as { limit?: number };
          if (error.code === "stale_ruleset") {
            hud.showToast("The game has updated. Reload to invade friends.", 6000);
            promptReload("The game has updated. Reload to keep playing.");
          } else if (error.code === "pair_limit") {
            hud.showToast(`You've already invaded ${friendName} ${body.limit ?? 3} times today — try again tomorrow.`);
          } else if (error.code === "no_defense") {
            hud.showToast(`${friendName} has no zombies on their farm to defend it.`);
          } else if (error.code === "not_friends") {
            hud.showToast("You can only invade friends.");
          } else if (error.code === "raid_in_progress") {
            hud.showToast("Another invasion is already in progress.");
          } else hud.showToast("The invasion could not be started.");
        } else hud.showToast("Gameplay is paused until the server reconnects.");
      }
    }, undefined));
  };
  // ---- Invasions panel hooks (ui/panels/invasions.ts) ----
  hud.pvpAvailable = () => !!economy?.serverPvpEnabled;
  hud.getPlayerLevel = () => state.level;
  hud.getPvpOverview = async () => {
    if (!onlineFarm) return null;
    try { return await api.pvpHistory(); } catch { return null; }
  };
  hud.onScoutPvpDefense = async (friendId) => {
    if (!onlineFarm) return null;
    try {
      return await api.pvpPreview(friendId);
    } catch (error) {
      // The gate refusals (no_defense, defender_level) arrive as API errors; the
      // panel renders them as explanations, not failures.
      if (error instanceof api.ApiError && error.code) return { error: error.code };
      return null;
    }
  };
  hud.getPvpDefense = async () => {
    if (!onlineFarm) return null;
    try { return await api.pvpDefenseGet(); } catch { return null; }
  };
  hud.onSavePvpDefense = async (unitIds) => {
    if (!onlineFarm) return "offline";
    try {
      // Loadout ids must be the server's ids: settle any pending roster mutations
      // first so a freshly combined/bought zombie's local id doesn't leak into it.
      await economy?.settleBeforeDependency();
      const mapped = unitIds.map((id) => economy?.authoritativeUnitId(id) ?? id);
      const res = await api.pvpDefenseSet(mapped);
      return res.ok ? null : res.error ?? "unknown";
    } catch (error) {
      return error instanceof api.ApiError ? error.code ?? "unknown" : "offline";
    }
  };
  hud.onClaimAllPvpDefense = async () => {
    if (!onlineFarm) return null;
    try {
      let claimed = 0;
      const rewards = new Map<string, number>();
      // The server bounds each transaction, not the action: keep requesting slices so
      // "Claim all" drains the entire backlog instead of silently stopping at 4,000.
      while (true) {
        const res = await api.pvpCollectAll();
        if (!res.ok) break;
        claimed += res.claimed;
        for (const r of res.rewards) rewards.set(r.key, (rewards.get(r.key) ?? 0) + r.qty);
        if (res.inventory) economy?.adoptRaidStartInventory(res.inventory);
        if (!res.remaining) break;
        // A malformed/stale response must not turn the button into an infinite request
        // loop. A valid remaining slice always claims at least one row.
        if (res.claimed === 0) break;
      }
      return claimed
        ? { claimed, rewards: [...rewards.entries()].map(([key, qty]) => ({ key, qty })) }
        : null;
    } catch {
      return null;
    }
  };
  hud.onWatchPvpReplay = (sessionId) => {
    if (!onlineFarm || raidActive || launchGate.busy) return;
    void launchGate.run(async () => {
      try {
        const res = await api.pvpReplay(sessionId);
        if (!res.ok || !res.config) {
          hud.showToast("That recording is no longer available.");
          return;
        }
        launchPvpReplay(res.config, res.finalTick ?? 0, res.inputs ?? [], res.attackerName ?? "A friend");
      } catch (error) {
        const code = error instanceof api.ApiError ? error.code : null;
        hud.showToast(
          code === "replay_expired" ? "That recording has been retired — only the last 10 fights keep theirs."
          : code === "stale_replay" ? "That fight was recorded under an older game version and can't be replayed."
          : "That recording could not be loaded."
        );
      }
    }, undefined);
  };
  /** Watch a recorded invasion: the same battle scene, fed the verified transcript,
   *  with every control disabled (see RaidScene's playback mode). Settles nothing. */
  const launchPvpReplay = (
    config: NonNullable<Awaited<ReturnType<typeof api.pvpStart>>["config"]>,
    finalTick: number,
    inputs: api.RaidReplayInput[],
    attackerName: string
  ) => {
    const raidDef = buildPvpRaidDef(
      { raidName: config.raidName, defenderName: config.pvp.defenderName },
      assets.raids.find((r) => r.id === MCDONNELL_ID)
    );
    pauseFarmJobs();
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true);
    hud.setBattleLoading(true, `Replaying ${attackerName}'s invasion…`);
    crumb("battle:launch", `pvp-replay:${attackerName}`);
    audio.enterRaid(raidDef.music);
    const closeReplay = () => {
      if (raidScene) { app.stage.removeChild(raidScene.container); raidScene.destroy(); raidScene = null; }
      raidActive = false;
      resumeFarmJobs();
      world.visible = true;
      hud.setRaiding(false);
      audio.exitRaid();
    };
    const epoch = launchGate.stamp();
    withBattleLoadTimeout(RaidScene.create(app, {
      raid: raidDef,
      assets,
      playerUnits: config.playerUnits,
      enemyUnits: config.enemyUnits,
      // ADOPTED, not null: formation mode perches a brute that throws, and the
      // server's verifier replays with it. Dropping it here would put the two
      // simulations out of step from the brute's first throw.
      bossThrow: config.bossThrow ?? null,
      waveCadence: config.waveCadence,
      concentration: true,
      playback: { finalTick, inputs },
      onStrike: (strike) => audio.fightStrike(strike),
      onBrainRelease: (sourceKey) => audio.brainForZombie(sourceKey),
      onVictory: () => audio.playRaidVictory(),
      // onFinish fires DURING scene.update (the outro's last frame); destroying the
      // scene synchronously there leaves the rest of that frame touching destroyed
      // Pixi objects. Defer the teardown out of the update call.
      onFinish: () => { setTimeout(closeReplay, 0); },
    })).then((scene) => {
      hud.setBattleLoading(false);
      crumb("battle:ready", `replay:${raidDef.name}`);
      if (!raidActive || !launchGate.isCurrent(epoch)) return scene.destroy();
      raidScene = scene;
      app.stage.addChild(scene.container);
      if (import.meta.env.DEV) {
        (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene;
      }
    }).catch((error) => {
      recordDiagnostic({
        at: Date.now(), kind: "error", where: "pvp-replay",
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      crumb("battle:failed", `replay:${raidDef.name}`);
      closeReplay();
      hud.showToast("The recording could not be loaded.", 6000);
    });
  };

  hud.onLaunchRaid = (raidId, partyIds, opts) =>
    launchGate.run(async () => launchRaid(raidId, partyIds, opts), false);
  const launchRaid: NonNullable<Hud["onLaunchRaid"]> = async (raidId, partyIds, opts) => {
    // The gate above already refused a re-entrant tap; this is the ordinary "a fight
    // is on" / "relaunch too soon" check. Everything below it that drops the fence on
    // the live session (raidSessionId, the expiry, setLiveRaid) now only runs for a
    // launch that is actually going ahead.
    if (raidActive || Date.now() < raidLaunchLockedUntil) return false;
    raidSessionId = null;
    clearRaidExpiry();
    economy?.setLiveRaid(null);
    // ONLINE: the server owns the between-raids cooldown. Ask it to authorize the
    // launch; if it's still on cooldown (and no voucher bypass), decline so the army
    // screen stays up. On success beginRaid runs with serverAuthorized so it doesn't
    // re-gate the (now server-owned) cooldown.
    if (onlineFarm) {
      try {
        const selectedNames = new Map(zombies.roster().map((z) => [z.id, z.name]));
        await economy?.settleBeforeDependency();
        const settled = reconcilePartySelection(
          partyIds,
          zombies.roster().filter((z) => !z.stored),
          (id) => economy?.authoritativeUnitId(id) ?? id,
          raids.partyView().cap
        );
        if (settled.missingIds.length) {
          const names = settled.missingIds.map((id) => selectedNames.get(id) ?? "A selected zombie");
          hud.showToast(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer available. Please choose your army again.`);
          return false;
        }
        partyIds = settled.ids;
        // Golden Dice are consumed SERVER-side here (the loot roll's luck is pinned to
        // the session), so send how many the player asked for and adopt what it charged.
        const gate = await api.raidStart(
          !!opts.useVoucher,
          raidId,
          partyIds,
          !!opts.concentration,
          Math.max(0, Math.floor(opts.dice ?? 0)),
          !!opts.brainTicket
        );
        if (!gate.ok) {
          // Distinguish the server's refusals: the client already hides locked raids and
          // blocks a second launch, so `locked` / `raid_in_progress` mean the client and
          // server disagree — say so plainly rather than blaming the cooldown.
          if (gate.error === "locked") {
            hud.showToast(`That invasion unlocks at level ${gate.unlockLevel ?? "?"}.`);
          } else if (gate.error === "raid_in_progress") {
            hud.showToast("Another invasion is already in progress.");
          } else if (gate.error === "no_voucher") {
            hud.showToast("No Invasion Voucher to skip the cooldown.");
          } else if (gate.error === "no_brain_ticket") {
            hud.showToast("No Brain Ticket for an elite invasion.");
          } else {
            const mins = Math.ceil((gate.cooldownRemaining ?? 0) / 60000);
            hud.showToast(`Invasion on cooldown — about ${mins} min left.`);
          }
          return false;
        }
        raidSessionId = gate.sessionId ?? null;
        // Fence the live session against the abandoned-raid recovery: from here until
        // its finish is submitted, no bootstrap may retreat it out from under the
        // player (see EconomyClient.recoverResumableRaid).
        economy?.setLiveRaid(raidSessionId);
        // Adopt the session's deadline. /raid/start has always returned it and the
        // client has always ignored it, which is why a fight frozen in a background
        // tab could sail past the TTL and settle for nothing with no warning at all.
        raidExpiresAt = gate.expiresAt == null
          ? null
          : serverTimestampToClient(gate.expiresAt, gate.serverTime ?? Date.now());
        raidExpiryAnnounced = "ok";
        raidLaunchLockedUntil = Math.max(
          raidLaunchLockedUntil,
          gate.earliestFinishAt == null
            ? Date.now() + 15_000
            : serverTimestampToClient(gate.earliestFinishAt, gate.serverTime ?? Date.now())
        );
        if (gate.inventory) economy?.adoptRaidStartInventory(gate.inventory);
        if (gate.lastRaidAt != null) state.syncRaidCooldown(serverTimestampToClient(
          gate.lastRaidAt,
          gate.serverTime ?? Date.now(),
        ));
        opts = {
          ...opts,
          serverAuthorized: true,
          bypassed: !!gate.bypassed,
          serverDice: gate.dice ?? 0,
          serverBrainDrop: gate.brainDrop ?? 0,
          serverElite: !!gate.elite,
          // The server pinned its wave from this same id, so a raid with per-fight
          // randomness (the Robots' random boss) resolves identically on both sides.
          waveSeed: raidSessionId ?? undefined,
        };
      } catch (error) {
        if (error instanceof api.ApiError) {
          const body = (error.body ?? {}) as { cooldownRemaining?: number; unlockLevel?: number };
          if (error.code === "cooldown") {
            hud.showToast(`Invasion on cooldown — about ${Math.ceil((body.cooldownRemaining ?? 0) / 60000)} min left.`);
          } else if (error.code === "locked") hud.showToast(`That invasion unlocks at level ${body.unlockLevel ?? "?"}.`);
          else if (error.code === "raid_in_progress") hud.showToast("Another invasion is already in progress.");
          else if (error.code === "no_voucher") hud.showToast("No Invasion Voucher to skip the cooldown.");
          else if (error.code === "no_brain_ticket") hud.showToast("No Brain Ticket for an elite invasion.");
          else if (error.code === "stale_ruleset") {
            // This tab predates the deployed Worker, so the server refuses to pin a fight
            // it and the client would simulate differently. Nothing is consumed and no
            // cooldown starts — but without this branch the player just sees "could not
            // start that invasion" and has no way to know a reload fixes it.
            hud.showToast("The game has updated. Reload to keep raiding.", 6000);
            promptReload("The game has updated. Reload to keep raiding.");
          }
          else hud.showToast("The server could not start that invasion.");
        } else hud.showToast("Gameplay is paused until the server reconnects.");
        return false;
      }
    }
    const setup = raids.beginRaid(raidId, partyIds, opts);
    // Offline play has no server timestamp, but uses the same gentle relaunch delay.
    if (setup && !onlineFarm) raidLaunchLockedUntil = Date.now() + 15_000;
    if (!setup) {
      // The server already opened a session but no battle will run, so drop the fence:
      // this one really IS abandoned and recovery should be free to close it.
      economy?.setLiveRaid(null);
      return false; // gated (cooldown/army) — the army screen stays up
    }
    // NOTE: the elite warning is NOT here. It used to be a one-off Tim notice fired at
    // this point — after the ticket was charged and the session opened — so its only
    // button was OK and the player was marched into the fight either way. It is now a
    // real confirm on the Army screen, asked before this function is ever called (see
    // Hud.openRaidArmy), where "no" still means no.
    //
    // First invasion that actually fields a hazard: hazards are the one part of a
    // fight the player has to handle by hand, and nothing on screen says so. Ask the
    // resolved setup rather than the raid's data flags — raids 2/10/11 declare a grab
    // or an obstacle they have no implementation for, and the wall is per-STAGE, so
    // only this tells us a hazard will really show up.
    // Zedzox's fire and his pixel zombies are the same kind of thing — something on the
    // field you answer with your finger rather than with the army — so they belong to the
    // same tip. They read differently enough to be worth their own words, though: nothing
    // gets grabbed and nothing blocks the lane, and a player told to expect that would be
    // waiting for the wrong thing. `turnedTemplate` is the tell (only raid 9 has one).
    const tapHazard = setup.grabber || setup.crab || setup.wallTemplate || setup.turnedTemplate;
    if (!hasSeenHazardTip() && tapHazard) {
      markHazardTipSeen();
      const verb = isTouch() ? "Tap" : "Click";
      await hud.timSays(
        setup.turnedTemplate
          ? "Careful now — this one FIGHTS DIRTY. He'll set your zombies alight,\n" +
            "and he'll turn one right around against you.\n" +
            `${verb} the fire to beat it out, and ${verb.toLowerCase()} the pixel one\n` +
            "till it breaks — that's how you get your zombie back!"
          : "Careful now — this invasion's got HAZARDS. They'll grab your zombies\n" +
            `right off the field, or block the way forward.\n${verb} one to damage it — ` +
            "keep at it and it'll go away!"
      );
    }
    // Some invasions run on a rule nothing on the battlefield states — the Pirates'
    // Scallywag mirrors whatever attack speed you bring it. Tim gives that warning
    // once, before the first attempt, instead of the game only admitting it in the
    // defeat text after the fight has already been paid for.
    const tip = raidTip(raidId);
    if (tip && !hasSeenRaidTip(raidId)) {
      markRaidTipSeen(raidId);
      await hud.timSays(tip);
    }
    pauseFarmJobs();
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true); // battle scene takes over the screen
    hud.setBattleLoading(true, `Loading ${setup.raid.name}…`); // ...which is blank until it lands
    crumb("battle:launch", `${setup.raid.name} · ${setup.playerUnits.length} zombies`);
    audio.enterRaid(setup.raid.music); // swap farm bed for this stage's battle BGM
    const epoch = launchGate.stamp();
    withBattleLoadTimeout(RaidScene.create(app, {
      raid: setup.raid,
      assets,
      playerUnits: setup.playerUnits,
      enemyUnits: setup.enemyUnits,
      bossThrow: setup.bossThrow,
      bossSpecials: setup.bossSpecials,
      grabber: setup.grabber,
      crab: setup.crab,
      summon: setup.summon,
      waveCadence: setup.waveCadence,
      wallTemplate: setup.wallTemplate,
      turnedTemplate: setup.turnedTemplate,
      brainDrop: setup.brainDrop,
      concentration: setup.concentration,
      onStrike: (strike) => audio.fightStrike(strike),
      onBrainRelease: (sourceKey) => audio.brainForZombie(sourceKey),
      onVictory: () => audio.playRaidVictory(),
      confirmRetreat: () => hud.confirmInGame(
        "Retreat from invasion?", "This invasion will count as a loss.", "Retreat"
      ),
      onCheckpoint: undefined,
      onFinish: (outcome, finalTick, inputs) => {
        // The fight is over, so the TTL has nothing left to warn about: whatever the
        // settlement below returns is now the story, told by invasionSettlementNotice.
        clearRaidExpiry();
        // ONLINE: the server prices the base win gold + first-clear XP AND rolls the
        // loot. finishRaid() credits none of it locally — it hands the reward back as
        // `serverReward`, which we submit through the balance client (POST /raid/finish).
        // That call also starts the server-owned cooldown and returns the authoritative
        // balance + lastRaidAt + the rolled drop, which the client reconciles.
        const online = onlineFarm && !!raidSessionId && !!economy;
        const view = raids.finishRaid(
          setup.raid, setup.party, outcome, setup.dice, online,
          setup.brainDrop, setup.brainEligible, setup.elite
        );
        const casualtyParty = setup.party.filter((zombie) => outcome.losses.includes(zombie.id));
        let settlementPromise: Promise<api.RaidFinishResult> | null = null;
        if (online) {
          const sid = raidSessionId!;
          raidSessionId = null;
          const sr = view.serverReward;
          // The server's drop arrives after the result panel has opened, so patch it in
          // when it lands (the panel shows an empty Loot row until then).
          economy!.onRaidSettled = (res) => {
            economy!.onRaidSettled = null;
            // A session can be settled by something OTHER than the fight just played:
            // a boot-time abandon from another device that took the writer, or a raid
            // that outlived its 15-minute server TTL. /raid/finish then answers 200
            // with the ALREADY-STORED result, and patching those zeros in silently is
            // what let a won invasion read "0 gold, 0 brains, no loot" with nothing to
            // report. Say what happened instead of quietly overwriting the victory.
            // Pass the WHOLE result: the TTL branch is recognisable only by `expired`,
            // since its stored body carries no outcome for a rule to compare against.
            const settlement = invasionSettlementNotice(outcome, res);
            if (settlement) {
              hud.setRaidResultNotice(settlement.notice);
              hud.showToast(settlement.toast, 8000);
            }
            if (res.outcome) zombies.applyServerRaidOutcome(res.outcome.survivors, res.outcome.losses);
            // Online the tutorial's invade beat no longer rides the local quest event,
            // so advance it from the verified outcome as soon as it lands (closing the
            // result panel is the other, later, chance).
            tutorial?.onRaidResolved();
            const drops: LootDrop[] = res.loot
              ? [{ name: res.loot.name, icon: raids.lootIconFor(res.loot.name), qty: res.loot.qty ?? 1 }]
              : [];
            if (res.newZombie) {
              if (!res.newZombie.received) {
                zombies.grantReward(
                  res.newZombie.key,
                  walk.tile.col,
                  walk.tile.row,
                  res.newZombie.id,
                  res.newZombie.stored
                );
              }
              drops.push(rewardZombieDrop(res.newZombie));
              hud.showToast(
                `${zombieDefs.get(res.newZombie.key)?.name ?? "Rare zombie"} joined your ${res.newZombie.received ? "Received storage" : res.newZombie.stored ? "Mausoleum" : "farm"}!`
              );
            }
            hud.setRaidResultLoot(drops, res.gold);
            hud.setRaidResultBrains(res.brains ?? 0);
          };
          // Submit win OR loss: a loss still finishes the session to start the cooldown.
          settlementPromise = economy!.submitRaid(sid, finalTick, inputs, outcome, {
            gold: sr?.gold ?? 0,
            xp: sr?.xp ?? 0,
          });
          // submitRaid persists this transcript before its first await, so recovery now
          // resends the REAL fight rather than needing the fence.
          economy!.setLiveRaid(null);
          // Always observe settlement, even when there were no casualties or the
          // player has not closed the result panel yet. If every idempotent retry
          // fails, a bootstrap still recovers any commit whose response was lost.
          void settlementPromise.catch(async (error) => {
            economy!.onRaidSettled = null;
            const code = error instanceof api.ApiError ? error.code : "unknown_error";
            const verificationMessage = code === "truncated_transcript"
              ? "The invasion result could not be verified. No rewards were granted, and the normal invasion cooldown still applies."
              : code === "stale_ruleset"
                ? "The game was updated during this invasion. Its result could not be settled, and the normal invasion cooldown still applies."
                : null;
            try {
              await economy!.refreshAuthoritative();
              hud.showToast(verificationMessage ?? `Invasion settlement failed (${code}). Your farm was resynced.`, 6000);
            } catch {
              hud.showToast(
                verificationMessage
                  ? `${verificationMessage} Reconnecting will resync your farm.`
                  : `Invasion settlement failed (${code}). Reconnecting will resync your farm.`,
                6000
              );
            }
          });
        } else if (onlineFarm && raidSessionId) {
          // Signed in but no balance client (shouldn't happen): report finish for the
          // cooldown only; rewards were credited locally by finishRaid above.
          const sid = raidSessionId;
          raidSessionId = null;
          void api
            .raidFinish(sid, finalTick, inputs, outcome)
            .then((r) => {
              // An expired settlement starts no cooldown and sends no stamp to adopt.
              if (r.lastRaidAt == null) return;
              state.syncRaidCooldown(serverTimestampToClient(
                r.lastRaidAt,
                r.serverTime ?? Date.now(),
              ));
            })
            .catch(() => {});
        }
        hud.openRaidResult(view, () => {
          if (raidScene) {
            app.stage.removeChild(raidScene.container);
            raidScene.destroy();
            raidScene = null;
          }
          raidActive = false;
          resumeFarmJobs();
          world.visible = true;
          hud.setRaiding(false);
          audio.exitRaid(); // battle over — hand the farm bed back
          // The win's XP (first clear or the repeat trickle) may have crossed a level
          // while the battle owned the screen. Celebrate it here, on the farm, with the
          // topbar visible again — and BEFORE the quest events below, which can grant XP
          // of their own and level the player a second time. Flushing first keeps the two
          // popups in the order they were earned.
          flushLevelUps();
          // OFFLINE, advance raid quests only now that we're back on the farm. Online
          // the server already counted this win and its questChanges have been applied,
          // so posting again would count it twice (see src/raid/questEvents.ts).
          // `elite` and the fight's technique record ride along from the setup and the
          // sim outcome rather than through RaidResultView — the result PANEL has no use
          // for either, and widening its view type to carry quest plumbing would be the
          // wrong seam.
          postRaidWinQuests(
            questBus,
            { ...view, elite: setup.elite, feats: outcome.feats },
            setup.raid.name,
            onlineFarm
          );
          tutorial?.onRaidResolved(); // finish post-win if the quest event did not
          // Any quest that completed during the battle celebrates now, on the farm.
          flushQuestCompletions();

          if (!casualtyParty.length) return;
          const revivalViews = casualtyParty.map((zombie) => ({
            id: zombie.id,
            key: zombie.key,
            name: zombie.name,
            typeName: zombie.typeName,
            portrait: zombiePortrait(zombie.key),
            mutation: zombie.mutation,
            color: zombie.color,
          }));
          if (settlementPromise && economy) {
            // The battle is gone and the farm is visible before this event opens.
            // Settlement captured each casualty server-side, so resolving the offer
            // remains safe even if the finish response arrived after the player tapped.
            void settlementPromise.then((settled) => {
              // Both come from a settlement that actually replayed the fight: an
              // expired one offers no revival and reports no balance to spend from.
              if (!settled.revival || !settled.balance) return;
              hud.openZombieRevival(revivalViews, settled.balance.brains, async (reviveIds) => {
                const revived = await economy!.resolveRaidRevival(settled.revival!.sessionId, reviveIds);
                const accepted = new Set(revived.revivedIds);
                zombies.reviveCasualties(casualtyParty.filter((zombie) => accepted.has(zombie.id)));
                saveManager.save();
                return true;
              });
            }).catch(() => { /* the settlement observer above already recovered/reported */ });
          } else if (!onlineFarm) {
            hud.openZombieRevival(revivalViews, state.brains, (reviveIds) => {
              if (!state.spendBrains(reviveIds.length, "zombie_revive")) return false;
              const accepted = new Set(reviveIds);
              zombies.reviveCasualties(casualtyParty.filter((zombie) => accepted.has(zombie.id)));
              saveManager.save();
              return true;
            });
          }
        });
      },
    })).then((scene) => {
      hud.setBattleLoading(false);
      crumb("battle:ready", setup.raid.name); // ...and the gap to the launch crumb is the load
      if (!raidActive || !launchGate.isCurrent(epoch)) return scene.destroy(); // finished/aborted before load done
      raidScene = scene;
      app.stage.addChild(scene.container);
      // Debug handle — dev builds only (window.ZF doesn't exist in prod). Guarded
      // so the missing global can't throw in production.
      if (import.meta.env.DEV) {
        (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene;
      }
    }).catch((error) => {
      // The farm went into battle mode before this load was awaited, and every path
      // that takes it back out lives inside the scene's own onFinish — which a scene
      // that never built will never call. Hand the farm back here instead of leaving
      // the player on a frozen blank screen with only a reload to escape.
      // See the epic-boss chain: the catch is what removes this from the automatic
      // unhandledrejection capture, so it is recorded by hand instead.
      recordDiagnostic({
        at: Date.now(), kind: "error", where: "invasion-scene",
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.warn("[invasion] battle scene failed to load", error);
      crumb("battle:failed", setup.raid.name);
      abandonBattle();
      // Same drop as the gated-launch path above: the server has a session open that
      // no battle will ever settle, so clear the fence and let the next invasion's
      // recovery retreat it (see EconomyClient.recoverResumableRaid). Until then the
      // party stays locked, so say so rather than inviting an immediate retry.
      raidSessionId = null;
      clearRaidExpiry();
      economy?.setLiveRaid(null);
      hud.showToast(
        "The battle could not be loaded. Your army is released when you next invade.",
        6000
      );
    });
    return true;
  };

  // ---- item storage: retrieve a stored decoration back to a free placement ----
  // `retrieving` holds the stored item key being re-placed; while set, the next
  // valid placement consumes it (free) and exits placement mode.
  let retrieving: { key: string; instanceId: string } | null = null;
  hud.onRetrieveItem = async (key) => {
    if (onlineGameplayBlocked()) return;
    const def = placeCatalog.get(key);
    if (!def) return;
    // Resolve the copy being taken out BEFORE entering placement: a shed slot with
    // no identity behind it would otherwise flick placement mode on and straight
    // back off, which reads as the panel closing and nothing happening.
    const instanceId = storedInstanceId(key);
    if (!instanceId) {
      hud.showToast("That item is no longer in your shed.");
      return;
    }
    await ensureObjectTextures(assets, def);
    hud.setPlacing(def); // enter placement mode (fires onModeChange first)
    retrieving = { key, instanceId }; // ...then arm retrieval so onModeChange doesn't clear it
  };

  // ---- Received rewards: resolve the raw key list into displayable cards ----
  // Entries are heterogeneous strings: boost names, a brains-currency drop, and
  // decorations. A decoration resolves to a placeable by display name, or (when
  // the placeable's name differs from the reward's) via the drop's `tile` key —
  // so nearly every loot/reward decor can now be placed. Anything that still
  // resolves to no placeable (e.g. the Rusty Fragment key-piece) is a trophy.
  const receivedDef = (entry: string): PlaceableDef | undefined =>
    placeByName.get(entry) ?? placeCatalog.get(assets.drops[entry]?.tile ?? "");
  const receivedViews = (): ReceivedView[] =>
    state.received.map((entry, index): ReceivedView => {
      const zombie = parseReceivedZombie(entry);
      if (zombie) {
        const def = zombieDefs.get(zombie.key);
        return {
          index, name: def?.name ?? "Zombie reward", icon: zombiePortrait(zombie.key),
          kind: "zombie",
          // Names the destination the claim will actually pick (see onClaimReceived).
          actionLabel: zombies.canAdd() ? "Deploy to farm" : "Store in Mausoleum",
        };
      }
      const boost = assets.boosts.find((b) => b.name === entry);
      if (boost)
        return { index, name: entry, icon: `${BASE}assets/boosts/${boost.icon}`, kind: "boost", actionLabel: "Claim" };
      const drop = assets.drops[entry];
      if (drop?.brains)
        return { index, name: entry, icon: BASE + "assets/ui/topbar_brain_icon.png", kind: "brains", actionLabel: "Claim" };
      const pdef = receivedDef(entry);
      const dropArt = raidRewardImage(assets, entry);
      if (pdef)
        return {
          index, name: entry, icon: dropArt || `${BASE}assets/objects/${pdef.sprite}`,
          // Only the catalog sprite carries the def's tint; a loot atlas image is
          // already coloured and must not be multiplied again.
          tint: dropArt ? undefined : objectTint(pdef.color),
          kind: "placeable", actionLabel: "Place",
          sellable: pdef.category !== "functional",
          // Asked of the def rather than of a placed object, because there is no
          // object yet — same rule, one step earlier (see canStore).
          storable: canStore(pdef),
        };
      return { index, name: entry, icon: dropArt, kind: "trophy", actionLabel: "" };
    });
  hud.getReceived = receivedViews;

  // Claim a boost/currency reward: apply its effect, then remove it from Received.
  hud.onClaimReceived = (index) => {
    if (onlineGameplayBlocked()) return;
    const entry = state.received[index];
    if (entry == null) return;
    const zombie = parseReceivedZombie(entry);
    if (zombie) {
      // Deploy onto the farm whenever the army has room, and fall back to the
      // Mausoleum only when it does not — mirrors the Worker's storage.claim, so both
      // sides agree on where the unit lands (client zombieMax already carries the
      // placed army bonus online). A full crypt must not strand an earned reward
      // while there is a free army slot standing empty.
      const deploy = zombies.canAdd();
      if (!deploy && !field.mausoleumId()) { hud.showToast("Place a Mausoleum before claiming this zombie."); return; }
      if (!deploy && zombies.mausoleumFull) { hud.showToast("Make room in the Mausoleum first."); return; }
      if (economy && !economy.submitStorageClaim(entry, {})) return;
      // The Almanac counted this species when the reward was EARNED; claiming only
      // moves it, so counting again here would inflate the lifetime tally.
      zombies.grantReward(zombie.key, walk.tile.col, walk.tile.row, zombie.id, !deploy,
        { recordDiscovery: false });
      state.takeReceivedAt(index);
      saveManager.flushCritical();
      return;
    }
    const boost = assets.boosts.find((b) => b.name === entry);
    if (boost) {
      // ONLINE: atomically consume Received into the server-owned boost inventory.
      // OFFLINE: the local save owns both buckets.
      if (economy) {
        if (!economy.submitStorageClaim(entry, { inventoryKey: boost.key })) return;
      } else state.addBoost(boost.key);
      state.takeReceivedAt(index);
      return;
    }
    const drop = assets.drops[entry];
    if (drop?.brains) {
      const amt = parseInt(entry, 10);
      if (economy) {
        // The v3 server deliberately refuses legacy premium-currency entries.
        if (!economy.submitStorageClaim(entry, {})) return;
      } else if (amt > 0) state.addBrains(amt);
      state.takeReceivedAt(index);
    }
  };

  // Place a decoration reward: enter placement mode; the placement below consumes
  // it from Received once dropped on a valid tile. Mirrors the storage-retrieve arm.
  let receiving: number | null = null;
  hud.onPlaceReceived = async (index) => {
    if (onlineGameplayBlocked()) return;
    const entry = state.received[index];
    const def = entry ? receivedDef(entry) : undefined;
    if (!def) return;
    await ensureObjectTextures(assets, def);
    hud.setPlacing(def);
    receiving = index; // arm after setPlacing so onModeChange doesn't clear it
  };

  // Shelve a decoration reward without ever putting it on the farm. The two-step
  // place-then-store dance it replaces also meant finding somewhere to drop an object
  // you did not want out, which on a full farm could be nowhere at all.
  hud.onStoreReceived = (index) => {
    if (onlineGameplayBlocked()) return false;
    const entry = state.received[index];
    const def = entry ? receivedDef(entry) : undefined;
    // Re-checked here rather than trusted from the card: the shed can fill up between
    // the panel rendering and the tap (a second reward stored, a reconcile landing).
    if (!entry || !def || !canStore(def)) {
      if (def) hud.showToast("Your shed is full.");
      return false;
    }
    if (economy) {
      // Claim into an authoritative object and shelve it in the same ordered batch —
      // the same two-command shape the direct sale uses, so the object exists only
      // long enough to be filed. The shed count then arrives with the reconcile.
      const instanceId = `reward-store-${crypto.randomUUID()}`;
      if (!economy.submitStorageClaim(entry, { localObjectId: instanceId })) return false;
      economy.submitObjectStatus(instanceId, "stored");
    } else if (!state.storeItem(def.key)) return false; // offline: the save owns the shed
    state.takeReceivedAt(index);
    audio.play("menuClick");
    return true;
  };

  // The object currently being relocated by the Move tool (null = none). `flipped`
  // tracks its orientation so rotating mid-carry survives the drop.
  let carrying: { id: string; def: PlaceableDef; turn: number } | null = null;
  // The farm plot currently in hand (Move tool). Objects and plots are both carried
  // one at a time and never together, so picking one up always drops the other.
  let carryingPlot: { oc: number; or: number } | null = null;
  const cancelCarry = () => {
    carrying = null;
    carryingPlot = null;
    field.hideObjectCursor();
    field.hideCursor();
  };

  // Orientation for the placement ghost, remembered across taps so a whole fence run
  // can be laid facing the same way. One number covers both kinds of turning: 0/1 for
  // art that turns by mirroring, 0..3 for a piece with its own art per corner (the
  // road bends) — see turnArt.
  let placeTurn = 0;

  // The Rotate tool is context-sensitive: while placing it spins the ghost, while
  // carrying (Move) it spins the carried object, and otherwise it toggles a
  // standalone rotate mode (tap any placed object to flip it). This keeps a single
  // button meaning "rotate whatever I'm working with" in every situation.
  /** Say why an object refuses to turn. See `canMirrorObject`: turning is a mirror, and
   *  a mirrored sign reads backwards, so art with writing on it does not turn at all. */
  const sayCannotRotate = (def: PlaceableDef) =>
    hud.showToast(`The ${def.name}'s sign would read backwards, so it can't be turned.`);

  const rotateCurrent = () => {
    if (hud.mode === "place" && hud.placing) {
      if (!canMirrorObject(hud.placing)) { sayCannotRotate(hud.placing); return; }
      placeTurn = (placeTurn + 1) % turnCount(hud.placing);
      field.setGhostTurn(placeTurn);
    } else if (hud.mode === "move" && carrying) {
      if (!canMirrorObject(carrying.def)) { sayCannotRotate(carrying.def); return; }
      carrying.turn = (carrying.turn + 1) % turnCount(carrying.def);
      field.setGhostTurn(carrying.turn);
    } else {
      hud.setMode("rotate");
    }
  };
  hud.onRotateTool = rotateCurrent;

  // Place the selected object at the pointer tile if the footprint is valid,
  // unlocked, and affordable. Stays in placement mode to place several — except
  // for an item whose last allowed copy this was (see the exit below).
  const tryPlaceObject = (col: number, row: number) => {
    const def = hud.placing;
    if (!def) return;
    if (!retrieving && receiving === null && hud.objectLimitReached?.(def)) return;
    if (def.zombiePot && field.zombiePotCount() >= MAX_ZOMBIE_POTS) {
      hud.showToast(`You can place at most ${MAX_ZOMBIE_POTS} Zombie Pots.`);
      return;
    }
    if (noRoomForAnother(def, field)) return;
    const placeFlip = turnFlip(def, placeTurn);
    const { oc, or } = field.resolveObjectOrigin(def, col, row, placeFlip);
    if (!field.canPlaceObject(oc, or, def, undefined, placeFlip)) return;
    // Retrieving a stored item: already owned, so it's free and places just one.
    if (retrieving) {
      const selected = retrieving;
      if (!takeStoredObject(state, storedObjectIds, selected)) {
        retrieving = null;
        hud.setPlacing(null);
        return;
      }
      field.placeObject(def, oc, or, selected.instanceId, undefined, placeTurn);
      audio.play("place");
      refreshArmyCap(); // re-apply functional effect
      economy?.submitObjectStatus(selected.instanceId, "placed");
      retrieving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    // Placing a Received reward: also free, consumed from the Received bucket.
    if (receiving !== null) {
      const receivedIndex = receiving;
      const itemName = state.received[receivedIndex];
      // Resolve the reward BEFORE putting anything down, and check it is still the one
      // this placement was armed for. The arming is an INDEX, and claiming or selling
      // another reward re-indexes the bucket underneath it — so it can come to point at
      // a different entry, or past the end entirely. Placing first left that object
      // standing on the farm owned by nobody and paid for by nobody: a Zombie Monolith
      // stranded that way never got the +4, and storing it later took away four slots
      // the cap had never been given.
      if (!itemName || receivedDef(itemName)?.key !== def.key) {
        receiving = null;
        hud.setPlacing(null);
        return;
      }
      const placedId = field.placeObject(def, oc, or, undefined, undefined, placeTurn);
      if (!placedId) return;
      if (economy && !economy.submitStorageClaim(itemName, { localObjectId: placedId })) {
        field.removeObject(placedId);
        return;
      }
      audio.play("place");
      refreshArmyCap();
      state.takeReceivedAt(receivedIndex);
      receiving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    if (state.level < def.level) return;
    // The Zombie Pot costs 500 GOLD for the first, then a flat 3 BRAINS for every
    // one after — permanently, even if the player sells it (see zombiePotBought).
    const potBought = !!def.zombiePot && state.zombiePotBought;
    const cost = def.zombiePot ? (potBought ? 3 : 500) : def.cost;
    const useBrains = def.zombiePot ? potBought : def.brainsNeeded;
    const xp = buyXp(cost, def.xp, useBrains, def.category);
    // Server-owned object buy: the server debits the exact price, records ownership,
    // and persists the dynamic first/subsequent Zombie Pot pricing flag.
    const serverObject = !!economy && cost > 0;
    if (serverObject) {
      const have = useBrains ? state.brains : state.gold;
      if (have < cost) return; // optimistic affordability; server re-checks
    } else {
      const paid = useBrains ? state.spendBrains(cost) : state.spendGold(cost);
      if (!paid) return;
      state.addXp(xp);
    }
    if (def.zombiePot) state.markZombiePotBought(); // next pot is 3 brains forever
    const placedId = field.placeObject(def, oc, or, undefined, undefined, placeTurn);
    if (def.zombiePot && placedId) {
      objectPurchases.set(placedId, { cost, currency: useBrains ? "brains" : "gold" });
    }
    if (serverObject && placedId) {
      economy!.submitObject(
        { type: "buy", key: def.key, instanceId: placedId },
        useBrains ? { brains: -cost, xp } : { gold: -cost, xp }
      );
      // Persist its layout immediately and promptly settle ownership so a reload
      // cannot strand a newly placed functional object between the two projections.
      saveManager.flushCritical();
      void economy!.settleBeforeDependency().then(() => saveManager.flushCritical()).catch(() => {});
    }
    audio.play("place");
    refreshArmyCap(); // functional effect — no-ops when the placement did not land
    if (def.storageSlots && placedId) refreshShedCap(); // shed capacity
    const c = tileCenter(col, row);
    floatText(c.x, c.y, `-${cost}${useBrains ? "b" : "g"}`);
    showPurchaseXp(xp, c);
    questBus.post(QuestEvent.ItemBought, def.name, 1, objectAliases.get(def.key) ?? []);
    // That may have been the last copy the player is allowed: a Blue Grave, a
    // monolith, the third Zombie Pot. Leave placement mode rather than trail a
    // ghost of something no further tap could ever put down.
    if (hud.objectLimitReached?.(def) || noRoomForAnother(def, field)) hud.setPlacing(null);
  };

  // Move tool: first tap lifts the object under the pointer; next valid tap drops
  // it. Invalid drop keeps it carried; right-click / tool-switch cancels.
  const handleMoveTap = (col: number, row: number, wx: number, wy: number) => {
    if (carrying) {
      const { oc, or } = field.resolveObjectOrigin(
        carrying.def, col, row, turnFlip(carrying.def, carrying.turn));
      if (field.moveObject(carrying.id, oc, or, carrying.turn)) cancelCarry();
      return;
    }
    if (carryingPlot) {
      const from = carryingPlot;
      const { oc, or } = field.plotOriginFor(col, row);
      if (!field.movePlot(from.oc, from.or, oc, or)) return; // blocked: keep holding it
      // The farmer may be walking to the tile this plot just left.
      jobs.cancelAtTile(from.oc, from.or);
      // Layout is client-owned, but WHICH plot exists where is not: without this the
      // next reconcile would put the plot back where the server still thinks it is.
      if (state.onFarm) state.onFarm({ type: "move", oc: from.oc, or: from.or, toOc: oc, toOr: or }, {});
      audio.play("place");
      saveManager.save();
      cancelCarry();
      return;
    }
    // Nothing in hand: pick up whatever is under the tap. An object wins over the
    // plot beneath it, matching every other tool's hit order.
    const id = field.objectAtPoint(wx, wy);
    const def = id ? field.objectDefOf(id) : null;
    if (id && def) {
      carrying = { id, def, turn: field.objectTurnOf(id) };
      field.setObjectCursor(def, col, row, id, carrying.turn);
      return;
    }
    const plot = field.plotOriginAt(col, row);
    if (!plot) return;
    if (!field.canMovePlot(plot.oc, plot.or)) {
      // Say why rather than silently ignoring the tap — an unresponsive plot reads
      // as a broken tool.
      hud.showToast("Only bare tilled plots can be moved.");
      return;
    }
    carryingPlot = plot;
    field.setPlotMoveCursor(col, row, plot.oc, plot.or);
  };

  // Gold paid when selling a placed object. Brain prices convert at 1,000g each.
  // An award-only invasion prize has no price to derive a refund from (cost 0, which
  // floors at one gold), so its authored value wins — see raidDropValue.ts. The
  // server prices the same sale from its own copy of that table.
  const sellRefund = (def: PlaceableDef) =>
    awardedSellValue(def.key) ?? sellBack(def.cost, !!def.brainsNeeded);

  /** Functional items are permanent — except the Memorial Statue, which is bought
   *  in quantity and has to be reversible: a player who buys ten and wants two back
   *  otherwise has no way out. Its occupant is handed back to the graveyard by
   *  Field.onMemorialReleased, so a sale costs the plinth and nothing else. */
  const canSellObject = (def: PlaceableDef) => def.category !== "functional" || !!def.memorial;

  // Sell a placed object for a refund (used by the Remove tool + object popup).
  const sellObject = (id: string) => {
    if (onlineGameplayBlocked()) return;
    const def = field.objectDefOf(id);
    if (def && !canSellObject(def)) return;
    const o = field.objectOriginOf(id);
    field.removeObject(id);
    if (!def || !o) return;
    audio.play("sell");
    refreshArmyCap(); // reverse functional effect
    const purchase = objectPurchases.get(id);
    const boughtWithBrains = purchase ? purchase.currency === "brains" : !!def.brainsNeeded;
    const refund = purchase ? sellBack(purchase.cost, boughtWithBrains) : sellRefund(def);
    // Every online object sale must reach the ownership service, including free
    // raid/quest rewards claimed from Received. Otherwise the client removes the
    // object only from its layout and reconciliation restores the still-owned copy.
    // A legacy object the server doesn't know is rejected and its optimistic credit
    // is dropped, while its local layout removal remains saved.
    const serverObject = !!economy;
    if (serverObject) {
      economy!.submitObject({ type: "refund", key: def.key, instanceId: id }, { gold: refund });
    } else {
      state.addGold(refund);
    }
    const c = tileCenter(o.oc, o.or);
    objectPurchases.delete(id);
    floatText(c.x, c.y, `+${refund}g`);
  };

  hud.onSellStoredItem = async (key) => {
    if (onlineGameplayBlocked()) return false;
    const def = placeCatalog.get(key);
    const instanceId = storedInstanceId(key);
    // A shelved Memorial Statue is always a bare plinth (its occupant went back to
    // the graveyard when it was stored), so selling it from here frees nothing.
    if (!def || !canSellObject(def)) return false;
    if (!instanceId) {
      hud.showToast("That item is no longer in your shed.");
      return false;
    }
    const purchase = objectPurchases.get(instanceId);
    const boughtWithBrains = purchase ? purchase.currency === "brains" : !!def.brainsNeeded;
    const refund = purchase ? sellBack(purchase.cost, boughtWithBrains) : sellRefund(def);
    if (!await hud.confirmInGame(
      `Sell ${def.name}?`,
      `Sell this stored item for ${refund} gold? This cannot be undone.`,
      `Sell +${refund}g`,
    )) return false;
    if (!takeStoredObject(state, storedObjectIds, { key, instanceId })) return false;
    if (retrieving?.instanceId === instanceId) {
      retrieving = null;
      hud.setPlacing(null);
    }
    objectPurchases.delete(instanceId);
    if (economy) {
      economy.submitObject({ type: "refund", key, instanceId }, { gold: refund });
    } else state.addGold(refund);
    audio.play("sell");
    return true;
  };

  hud.onSellReceived = async (index) => {
    if (onlineGameplayBlocked()) return false;
    const entry = state.received[index];
    const def = entry ? receivedDef(entry) : undefined;
    if (!entry || !def || def.category === "functional") return false;
    const refund = sellRefund(def);
    if (!await hud.confirmInGame(
      `Sell ${def.name}?`,
      `Sell this reward directly from Received for ${refund} gold? This cannot be undone.`,
      `Sell +${refund}g`,
    )) return false;
    if (economy) {
      // Claim into a short-lived authoritative object, then refund it in the same
      // ordered command batch. The requested id links the two operations without
      // ever placing a client-side object on the farm.
      const instanceId = `reward-sale-${crypto.randomUUID()}`;
      if (!economy.submitStorageClaim(entry, { localObjectId: instanceId })) return false;
      economy.submitObject({ type: "refund", key: def.key, instanceId }, { gold: refund });
    } else state.addGold(refund);
    state.takeReceivedAt(index);
    audio.play("sell");
    return true;
  };

  // Store a placed object in the shed (returns it to inventory for free re-placing
  // later). Reverses any functional effect; the shed must have a free slot.
  const storeObject = (id: string) => {
    if (onlineGameplayBlocked()) return;
    const def = field.objectDefOf(id);
    if (!def) return;
    if (!state.storeItem(def.key)) return; // shed full
    field.removeObject(id);
    refreshArmyCap(); // reverse functional effect — derived, so it reads the farm AFTER
    const storedIds = storedObjectIds.get(def.key) ?? [];
    storedIds.push(id);
    storedObjectIds.set(def.key, storedIds);
    economy?.submitObjectStatus(id, "stored");
  };

  // Can this object be stored in the shed? Storage buildings can't; the shed
  // must have a free slot. A Memorial Statue can — the shed holds only a key and a
  // count, so it goes in as a bare plinth and its occupant returns to the graveyard
  // (Field.onMemorialReleased) rather than being shelved with it.
  const canStore = (def: PlaceableDef) =>
    !def.storageSlots && !def.zombieStorage &&
    state.storedItemTotal() < state.storageItemCap;


  // The Move / Rotate / Store / Sell sheet for a placed object. Both entry points
  // (desktop tap and touch long-press) go through here so every object reachable
  // from one is reachable from the other.
  const openObjectActionsFor = (oid: string, def: PlaceableDef) => {
    hud.openObjectActions({
      name: def.name,
      portrait: `${BASE}assets/objects/${def.sprite}`,
      tint: objectTint(def.color), // monoliths share one sprite, coloured per def
      canStore: canStore(def),
      canSell: canSellObject(def),
      sellRefund: sellRefund(def),
      sellBrains: false,
      // The pen's own collection, which used to be all a tap on it could reach.
      ...(def.petPen
        ? { manageLabel: "Pets", onManage: () => hud.openStorage("Pets", true) }
        : {}),
      onMove: () => {
        hud.setMode("move"); // fires onModeChange (clears carry) FIRST...
        carrying = { id: oid, def, turn: field.objectTurnOf(oid) }; // ...then pick up this object
        const o = field.objectOriginOf(oid);
        // Aim the ghost at the tile the object is already centered on, in the
        // orientation it is standing in — a turned object's footprint is transposed.
        const fp = objectFootprint(def, turnFlip(def, carrying.turn));
        if (o) field.setObjectCursor(def, o.oc + Math.floor((fp.w - 1) / 2),
          o.or + Math.floor((fp.h - 1) / 2), oid, carrying.turn);
      },
      onRotate: () => {
        if (!canMirrorObject(def)) { sayCannotRotate(def); return; }
        if (!field.flipObject(oid)) {
          hud.showToast("No room to turn that — move it somewhere clearer first.");
          return;
        }
        saveManager.save();
      },
      onStore: () => storeObject(oid),
      // The sheet sells decor on one tap, which is fine for a 50-gold daisy. A
      // Memorial Statue is a 3,000-gold object that may be carrying somebody, so it
      // asks first — and says where that somebody goes.
      onSell: def.memorial ? () => void confirmSellMemorial(oid, def) : () => sellObject(oid),
    });
  };

  /** Confirm-then-sell for a Memorial Statue. The occupant is not destroyed: it goes
   *  back to the graveyard (Field.onMemorialReleased), so this only costs the plinth. */
  const confirmSellMemorial = async (oid: string, def: PlaceableDef) => {
    const occupant = field.memorialOccupant(oid);
    const refund = sellRefund(def);
    const confirmed = await hud.confirmInGame(
      `Sell ${def.name}?`,
      `Sell this statue for ${refund} gold?`
      + (occupant
        ? ` ${occupant.name} is not lost with it — they return to the graveyard and can be enshrined on another statue.`
        : ""),
      `Sell +${refund}g`,
    );
    // The farm may have changed while the confirmation was open.
    if (confirmed && field.objectDefOf(oid) === def) sellObject(oid);
  };

  // Remove tool: a placed OBJECT sells back for a 50% refund; any plot is cleared
  // to bare ground for no money. A planted crop forfeits its cost and reward.
  const tryRemove = async (col: number, row: number, wx: number, wy: number) => {
    const id = field.objectAtPoint(wx, wy);
    if (id) {
      const d = field.objectDefOf(id);
      if (!d || !canSellObject(d)) return;
      const purchase = objectPurchases.get(id);
      const boughtWithBrains = purchase ? purchase.currency === "brains" : !!d.brainsNeeded;
      const refund = purchase ? sellBack(purchase.cost, boughtWithBrains) : sellRefund(d);
      // Selling a memorial does not destroy who it remembered — say so, or the
      // warning reads as "this deletes your dead zombie" and nobody ever taps it.
      const occupant = d.memorial ? field.memorialOccupant(id) : null;
      const confirmed = await hud.confirmInGame(
        `Sell ${d.name}?`,
        `The Remove tool will permanently sell this item for ${refund} gold. This cannot be undone.`
        + (occupant ? ` ${occupant.name} returns to the graveyard and can be enshrined again.` : ""),
        `Sell +${refund}g`
      );
      // The farm may have changed while the confirmation was open.
      if (!confirmed || field.objectDefOf(id) !== d) return;
      sellObject(id);
      return;
    }
    const origin = field.plotOriginAt(col, row);
    if (origin) {
      const crop = field.cropInfoAt(col, row);
      // Bare plowed soil holds nothing of value (the seed is only paid for when the
      // farmer actually plants), so removing it is a plain tap — no confirmation.
      if (crop) {
        const confirmed = await hud.confirmInGame(
          "Remove this plot?",
          `Remove this plot and discard the ${crop.name} growing on it? You will receive no refund.`,
          "Remove Plot"
        );
        const current = field.plotOriginAt(col, row);
        if (!confirmed || !current || current.oc !== origin.oc || current.or !== origin.or) return;
      }
      jobs.cancelAtTile(col, row); // drop any queued job on this plot first
      field.removePlot(col, row); // plot (and any crop) -> bare ground, no refund
      if (state.onFarm) state.onFarm({ type: "remove", oc: origin.oc, or: origin.or }, {});
      audio.play("sell");
      saveManager.save();
    }
  };

  // These edit actions are immediate for a mouse, but touch calls this only after
  // finger-up confirms the gesture was a tap (rather than the start of a pinch).
  const performEditTap = (mode: Mode, col: number, row: number, wx: number, wy: number) => {
    if (mode === "place") tryPlaceObject(col, row);
    else if (mode === "move") handleMoveTap(col, row, wx, wy);
    else if (mode === "remove") void tryRemove(col, row, wx, wy);
    else if (mode === "instagrow") tryInstaGrow(col, row, wx, wy);
    else if (mode === "rotate") {
      const id = field.objectAtPoint(wx, wy);
      if (!id) return;
      const rotateDef = field.objectDefOf(id);
      if (rotateDef && !canMirrorObject(rotateDef)) { sayCannotRotate(rotateDef); return; }
      // A long object turns across the diagonal it was lying on, so the tiles it
      // needs change: say why nothing happened instead of eating the tap.
      if (!field.flipObject(id)) {
        hud.showToast("No room to turn that — move it somewhere clearer first.");
        return;
      }
      audio.play("place");
      saveManager.save();
    }
  };

  /** Tap a Memorial Statue: show who it remembers, or pick someone to remember.
   *  Enshrining moves the snapshot out of the graveyard and onto the statue, so the
   *  same zombie can never stand on two plinths. */
  const openMemorialFor = (objId: string, objDef: PlaceableDef) => {
    hud.openMemorial({
      occupant: field.memorialOccupant(objId),
      fallen: state.fallenZombies,
      cardOf: (fallen) => fallenToInfo(fallen, zombieDefs.get(fallen.key), zombiePortrait(fallen.key)),
      onObjectOptions: () => openObjectActionsFor(objId, objDef),
      onEnshrine: (fallenId) => {
        const claimed = state.claimFallen(fallenId);
        if (!claimed) return false;
        if (!field.setMemorialOccupant(objId, claimed)) {
          state.releaseFallen(claimed); // the statue vanished under the open panel
          return false;
        }
        // ONLINE the graveyard and every statue's occupant are server-owned, because
        // a friend visiting this farm renders the memorial from the authoritative
        // object projection. The name rides along: it is the one client-authored
        // field, exactly as it is for a living unit.
        economy?.submitMemorial({ type: "memorial.enshrine", instanceId: objId,
          unitId: claimed.id, ...(claimed.name ? { name: claimed.name } : {}) });
        audio.play("place");
        saveManager.save();
        return true;
      },
      onClear: () => {
        const occupant = field.memorialOccupant(objId);
        if (!occupant) return;
        field.setMemorialOccupant(objId, null);
        state.releaseFallen(occupant);
        economy?.submitMemorial({ type: "memorial.clear", instanceId: objId });
        saveManager.save();
      },
    });
  };

  const interactWithObject = (objId: string, objDef: PlaceableDef): boolean => {
    if (objDef.tapSound) audio.tap(objDef.tapSound);
    field.triggerObjectAnimation(objId); // tap-played decor (Parrot, Taiko Drum, …)
    if (objDef.storageSlots) hud.openStorage();
    else if (objDef.memorial) openMemorialFor(objId, objDef);
    else if (objDef.zombieStorage) hud.openMausoleum();
    else if (objDef.zombiePatch) {
      const napping = zombies.toggleGather(field.patchRestTiles());
      const wp = field.objectWorkPoint(objId);
      saveManager.flushCritical();
      if (wp) floatText(wp.x, wp.y - 24, napping ? "Zzzâ€¦" : "Awake!");
    } else if (objDef.zombiePot) {
      activePotId = objId;
      hud.openCombiner();
    } else if (field.isObjectReady(objId)) {
      enqueueHarvestTarget({ kind: "tree", instanceId: objId });
    } else {
      openObjectActionsFor(objId, objDef);
    }
    return true;
  };

  const inspectZombie = (zu: NonNullable<ReturnType<typeof zombies.pick>>) => {
    zombies.select(zu);
    const d = zu.getData();
    const wp = zu.worldPos;
    floatText(wp.x, wp.y - 44, "Brains…");
    audio.brain(d.group, d.key);
    hud.openZombieInfo({
      name: d.name, typeName: d.typeName, key: d.key, group: d.group,
      className: d.className, classColor: d.classColor,
      str: d.str * state.farmerZombieStrengthMult(), dex: d.dex,
      con: d.con * state.farmerZombieLifeMult(), focus: d.focus, mutation: d.mutation,
      invasions: d.invasions,
      portrait: zombiePortrait(d.key), color: d.color,
      // Friend-farm visits are inspect-only, so omit action-bearing unit IDs.
      id: visiting ? undefined : d.id, stored: false,
    });
  };

  /** Tap the farmer to switch his lantern on or off. Returns whether the tap landed.
   *
   *  Only meaningful after dark, so during the day the tap is left to fall through to
   *  whatever is under him — a farmer standing on a ripe plot must not swallow the
   *  harvest. Visiting is read-only, and the tutorial owns the farm outright while it
   *  runs, so both sit this out.
   *
   *  On MOUSE this resolves just after the zombie pick, ahead of the tile. On TOUCH it
   *  is the last resort, the same deal a zombie gets: a finger covers the plot behind
   *  him, so the plot keeps the tap and the farmer is only reachable on open ground.
   *  Settings carries the same switch for anyone who would rather not chase him, and
   *  a second Settings toggle disarms this tap entirely for anyone who keeps hitting
   *  it by accident. */
  const tapFarmer = (wx: number, wy: number): boolean => {
    if (!lanternTapEnabled || !isNight || visiting || tutorial.active) return false;
    if (!actor.containsPoint(wx, wy)) return false;
    setLantern(!lanternOn);
    audio.play("menuClick");
    floatText(actor.container.x, actor.container.y - 70, lanternOn ? "Lantern on" : "Lantern off");
    return true;
  };

  const beginWorldLongPress = (wx: number, wy: number, pointerId: number) => {
    cancelZombieLongPress();
    zombieLongPressActivated = false;
    const zombieCandidate = zombies.pick(wx, wy);
    const objectId = zombieCandidate || visiting ? null : field.objectAtPoint(wx, wy);
    const objectCandidate = objectId ? field.objectDefOf(objectId) : null;
    if (!zombieCandidate && (!objectId || !objectCandidate)) return;
    zombieLongPressTimer = setTimeout(() => {
      zombieLongPressTimer = null;
      if (pointerId !== pressPointerId || touchPinch || !dragging ||
          !isZombieHold(pressPointerType, TOUCH_ZOMBIE_HOLD_MS, moved)) return;
      zombieLongPressActivated = true;
      dragging = false;
      lastPlot = "";
      if (zombieCandidate) inspectZombie(zombieCandidate);
      else if (objectId && objectCandidate && field.objectDefOf(objectId) === objectCandidate)
        interactWithObject(objectId, objectCandidate);
    }, TOUCH_ZOMBIE_HOLD_MS);
  };

  app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (raidActive) return; // farm input is inert during a live raid
    if (economy && !economy.available) {
      // Name the cause. "reconnect to continue" on its own sends players chasing a
      // network problem they don't have.
      const why = economy.unavailableReason;
      hud.showToast(`Gameplay paused (${why}) — reconnect to continue.`);
      console.warn(`[zf] tap while paused: ${why}`);
      // The tap path can be the FIRST place a pause is noticed: several branches set
      // `paused` without emitting onGameplayUnavailable (a 409 rebase, a bootstrap
      // that says the writer moved). recordPause dedupes, so tapping repeatedly on a
      // dead farm still leaves exactly one entry.
      recordPause("tap_while_paused");
      // A tap on a dead farm is the clearest evidence a stall is live, and the worst
      // moment to sit out the rest of a 60-second backoff. Pull the next attempt
      // forward instead of only reporting the pause.
      economy.nudgeRecovery();
      return;
    }
    if (touchPinch) return; // a pinch is in progress; ignore extra finger-downs
    if (isTouchPointer(e.pointerType) && !e.isPrimary) return;
    const touch = isTouchPointer(e.pointerType);
    // The tap immediately collapses the mobile HUD, which changes the DOM under
    // the finger. Keep Android's release routed to the canvas so endDrag can open
    // the plot's plant/crop panel instead of silently losing pointer-up.
    captureTouchPointer(app.canvas, e.pointerId, e.pointerType);
    pressPointerType = e.pointerType;
    pressPointerId = e.pointerId;
    pressMaxDistance = 0;
    touchSelectStartTile = null;
    touchToolStartTile = null;
    touchOutsideFarmPan = false;
    cancelZombieLongPress();
    zombieLongPressActivated = false;
    clearHarvestStroke();
    clearPlowStroke();
    clearInstaGrowStroke();
    clearCancelStroke();
    pressStart.copyFrom(e.global);
    clearTouchToolStroke();
    if (visiting) {
      // Read-only visit: no tools, no editing. Only start a camera pan; a tap
      // (pan that doesn't move) resolves to walk / inspect in endDrag below.
      if (e.button === 2) return;
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      if (touch) {
        const w = toWorld(e);
        beginWorldLongPress(w.x, w.y, e.pointerId);
      }
      return;
    }
    if (e.button === 2) {
      // Right-click opens the tool menu (see the contextmenu handler below, which
      // fires after this one and knows the client coordinates). Here it only has
      // to make sure the press never starts a pan or a tool stroke.
      dragging = false;
      return;
    }
    if (hud.isTemporaryPanning) {
      temporaryPanGesture = true;
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      return;
    }
    const { col, row, wx, wy } = tileAt(e);
    if (touch && hud.mode === "plant") touchToolStartTile = { col, row };
    touchOutsideFarmPan = isOutsideFarmPanGesture(
      e.pointerType,
      hud.mode,
      field.inBounds(col, row),
    );
    // Tutorial world gate: while the guided tutorial is active, freeze every farm
    // tap except the current beat's target plot (so nothing collapses the menu or
    // acts out of turn). Menu/narrative beats freeze the farm entirely.
    if (tutorial.active && !tutorial.allowsTile(col, row)) return;
    hud.collapse(); // any tap on the field collapses the bars into the corner fab
    // Plow remains equipped after making a plot. On touch, tapping that newly
    // plantable soil is selection intent: return to the Multi-tool so pointer-up
    // opens the same left-side Plants/Zombies picker as a desktop click.
    if (touch && hud.mode === "till" && field.canPlant(col, row)) hud.setMode("walk");
    if (touch && hud.mode === "walk") touchSelectStartTile = { col, row };
    if (hud.mode === "walk") {
      harvestStrokeCandidate = harvestTargetAt(e.global.x, e.global.y);
      harvestStrokeLast.copyFrom(e.global);
    }
    if (touch && hud.mode === "walk") beginWorldLongPress(wx, wy, e.pointerId);
    if (hud.mode === "instagrow") {
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      beginInstaGrowStroke(e.global.x, e.global.y);
      return;
    }
    if (isDeferredTouchMode(hud.mode)) {
      if (touch) {
        // Wait for pointer-up. A second finger may still convert this tap into a
        // pinch, and none of these actions are safely reversible.
        dragging = true;
        moved = false;
        last.copyFrom(e.global);
      } else {
        performEditTap(hud.mode, col, row, wx, wy);
        dragging = false;
      }
      return;
    }
    // Press on a queued action: a plain click still toggles it off (mouse cancels
    // immediately, touch resolves the tap in endDrag), and dragging from it erases
    // every queued job the stroke crosses instead of starting a pan/paint stroke.
    const cancelCandidate = cancelTargetAtGlobal(e.global.x, e.global.y);
    if (cancelCandidate) {
      cancelStrokeCandidate = cancelCandidate;
      cancelStrokeLast.copyFrom(e.global);
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      if (!touch) beginCancelStroke(e.global.x, e.global.y);
      return;
    }
    if (hud.mode === "till") {
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      if (!touchOutsideFarmPan) beginPlowStroke(col, row, e.global.x, e.global.y);
      return;
    }
    dragging = true;
    moved = false;
    last.copyFrom(e.global);
    // The drag-paint stroke starts here, so interpolation has somewhere to measure
    // its first segment from.
    plantStrokeLast.copyFrom(e.global);
    if (hud.mode !== "walk") {
      // Plant preserves immediate mouse click/drag painting. Touch waits for either a
      // confirmed tap or movement beyond its larger finger-jitter threshold.
      if (!touch) enqueueTool(col, row);
      lastPlot = touch ? "" : tileKey(col, row);
    }
  });
  app.stage.on("pointermove", (e: FederatedPointerEvent) => {
    if (raidActive) { hoveredCrop = null; hud.showCropHover(null); return; }
    if (touchPinch) return; // pinch owns the gesture; skip pan/cursor updates
    if (dragging && e.pointerId === pressPointerId) {
      pressMaxDistance = Math.max(
        pressMaxDistance,
        Math.hypot(e.global.x - pressStart.x, e.global.y - pressStart.y),
      );
      if (!moved) moved = gestureMoved(pressStart.x, pressStart.y, e.global.x, e.global.y, pressPointerType);
      if (moved) cancelZombieLongPress();
      if (moved && !harvestStrokeActive && harvestStrokeCandidate && hud.mode === "walk" &&
          !temporaryPanGesture) beginHarvestStroke(e.global.x, e.global.y);
      // A touch drag that began on a queued action becomes a cancel stroke once it
      // moves (mouse strokes are already active from pointerdown).
      if (moved && !cancelStrokeActive && cancelStrokeCandidate)
        beginCancelStroke(e.global.x, e.global.y);
    }
    if (harvestStrokeActive) {
      collectHarvestStrokeSegment(e.global.x, e.global.y);
      hoveredCrop = null;
      hud.showCropHover(null);
      field.hideCursor();
      return;
    }
    if (cancelStrokeActive) {
      collectCancelStrokeSegment(e.global.x, e.global.y);
      hoveredCrop = null;
      hud.showCropHover(null);
      field.hideCursor();
      return;
    }
    if (visiting) {
      // Read-only visit: drag pans the camera; no tool cursors are ever shown.
      // An idle mouse still gets the crop/tree hover, the same look a visitor
      // would take at their own field. It reads state and changes nothing.
      if (dragging) {
        hoveredCrop = null;
        hud.showCropHover(null);
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (moved) {
          world.position.x += dx;
          world.position.y += dy;
          clampCamera();
        }
        last.copyFrom(e.global);
      } else if (!isTouchPointer(e.pointerType)) {
        const { col, row, wx, wy } = tileAt(e);
        hoveredCrop = { col, row, wx, wy, x: e.global.x, y: e.global.y };
        hud.showCropHover(
          field.cropInfoAt(col, row) ?? field.treeInfoAtPoint(wx, wy),
          e.global.x,
          e.global.y,
        );
      } else {
        hoveredCrop = null;
        hud.showCropHover(null);
      }
      return;
    }
    const { col, row, wx, wy } = tileAt(e);
    if (!dragging && hud.mode === "walk" && !isTouchPointer(e.pointerType)) {
      hoveredCrop = { col, row, wx, wy, x: e.global.x, y: e.global.y };
      hud.showCropHover(
        field.cropInfoAt(col, row) ?? field.treeInfoAtPoint(wx, wy),
        e.global.x,
        e.global.y,
      );
    } else {
      hoveredCrop = null;
      hud.showCropHover(null);
    }
    if (hud.mode === "place" && hud.placing) {
      field.setObjectCursor(hud.placing, col, row, undefined, placeTurn); // ghost follows the cursor
      return;
    }
    if (hud.mode === "move") {
      if (carrying) field.setObjectCursor(carrying.def, col, row, carrying.id, carrying.turn);
      else if (carryingPlot) field.setPlotMoveCursor(col, row, carryingPlot.oc, carryingPlot.or);
      return;
    }
    if (hud.mode === "remove") {
      // Highlight the object under the pointer; else show the red plot cursor.
      const id = field.objectAtPoint(wx, wy);
      field.setObjectHighlight(id);
      if (id) field.hideCursor();
      else field.setCursor(col, row, "remove");
      return;
    }
    if (instaGrowStrokeActive && dragging)
      collectInstaGrowStrokeSegment(e.global.x, e.global.y);
    if (hud.mode === "instagrow" || instaGrowStrokeActive) {
      const id = field.objectAtPoint(wx, wy);
      const selectedPot = id && field.objectDefOf(id)?.zombiePot ? zombies.potFor(id) : null;
      const isActivePot = !!selectedPot?.busy && !selectedPot.ready;
      field.setObjectHighlight(isActivePot ? id : null);
      if (isActivePot) {
        field.hideCursor();
        return;
      }
      field.setCursor(col, row, "grow"); // green over a growing crop, red otherwise
      return;
    }
    if (dragging) {
      if (hud.mode === "walk" || touchOutsideFarmPan) {
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (moved) {
          world.position.x += dx;
          world.position.y += dy;
          clampCamera(); // block panning above the sky
        }
        last.copyFrom(e.global);
      } else if (hud.mode === "till" && plowStrokeAnchor) {
        collectPlowStrokeSegment(e.global.x, e.global.y);
        field.setCursor(col, row, "till");
        return;
      } else if (hud.mode === "plant" && moved) {
        // Drag-paint plants across the field. Touch records the stroke and commits
        // on finger-up; mouse queues each new tile immediately.
        //
        // INTERPOLATED, like the plow and harvest strokes. Reading only the raw
        // pointermove positions meant a swipe fast enough to travel more than a plot
        // between two events planted neither of them — and a gesture is fastest in
        // its MIDDLE, which is exactly where players reported a handful of plots
        // being left behind while the ends of the drag came out fine.
        for (const point of sampleStrokeSegment(plantStrokeLast, { x: e.global.x, y: e.global.y })) {
          const tile = tileAtGlobal(point.x, point.y);
          const tk = tileKey(tile.col, tile.row);
          if (tk === lastPlot) continue;
          if (isTouchPointer(pressPointerType)) {
            if (!touchGestureTiles.length && touchToolStartTile)
              recordTouchPlantTile(touchToolStartTile.col, touchToolStartTile.row);
            recordTouchPlantTile(tile.col, tile.row);
          }
          else enqueueTool(tile.col, tile.row);
          lastPlot = tk;
        }
        plantStrokeLast.set(e.global.x, e.global.y);
      }
    }
    const tool = hud.mode === "till" || hud.mode === "plant" ? hud.mode : null;
    field.setCursor(col, row, tool);
  });
  app.canvas.addEventListener("pointerleave", () => {
    hoveredCrop = null;
    hud.showCropHover(null);
  });
  const endDrag = (e: FederatedPointerEvent) => {
    const selectTap = hud.mode === "walk" &&
      isSelectTapGesture(pressPointerType, moved, pressMaxDistance);
    if (dragging && (!moved || selectTap)) {
      const released = tileAt(e);
      // A touch tap targets the plot beneath initial contact. This prevents normal
      // finger wobble from resolving the release just beyond an isometric edge.
      const startPlot = touchSelectStartTile
        ? field.plotOriginAt(touchSelectStartTile.col, touchSelectStartTile.row)
        : null;
      const col = startPlot ? touchSelectStartTile!.col : released.col;
      const row = startPlot ? touchSelectStartTile!.row : released.row;
      const { wx, wy } = released;
      if (isTouchPointer(pressPointerType)) {
        // Match desktop's queued-action toggle, but only after this is known to be
        // a tap so the first finger of a pinch cannot cancel unrelated work.
        if (jobs.cancelAtTile(col, row)) {
          dragging = false;
          lastPlot = "";
          return;
        }
        const queuedObjId = field.objectAtPoint(wx, wy);
        if (queuedObjId && jobs.cancelObject(queuedObjId)) {
          dragging = false;
          lastPlot = "";
          return;
        }
        if (isDeferredTouchMode(hud.mode)) {
          performEditTap(hud.mode, col, row, wx, wy);
          dragging = false;
          lastPlot = "";
          return;
        }
        if (hud.mode === "till" || hud.mode === "plant") {
          const mode = hud.mode;
          if (enqueueTool(col, row)) {
            dragging = false;
            lastPlot = "";
            return;
          }
          // A finger tap on already-plowed soil used to disappear while Plow was
          // equipped (especially noticeable immediately after the tutorial). A
          // failed Plow tap on plantable soil is selection intent: return to the
          // Multi-tool and fall through to the normal crop picker below.
          if (mode === "till" && field.canPlant(col, row)) hud.setMode("walk");
          else {
            dragging = false;
            lastPlot = "";
            return;
          }
        }
      }
      if (hud.mode === "walk") {
        // Select tool: clicking an owned zombie inspects it; the storage shed opens
        // Storage; a ripe fruit tree harvests for gold; else it's tile-based (same
        // clickbox as Plow) — ripe plot -> harvest; tilled plot -> plant picker;
        // spent plot -> re-till; else free-roam when idle.
        // A mouse resolves the zombie first; a finger cannot. A zombie's sprite
        // covers the plots drawn behind it, so on touch the tile keeps the tap and
        // the zombie is reached by press-and-hold instead. That only applies where
        // the tile actually wants the tap: when nothing beneath claims it, the
        // cascade below falls through to the zombie so open ground needs no hold.
        const zu = isTouchPointer(pressPointerType) ? null : zombies.pick(wx, wy);
        if (zu) {
          inspectZombie(zu);
          dragging = false;
          lastPlot = "";
          return;
        }
        if (!isTouchPointer(pressPointerType) && tapFarmer(wx, wy)) {
          dragging = false;
          lastPlot = "";
          return;
        }
        zombies.clearSelection();
        if (visiting) {
          // Read-only visit: looking is allowed, touching is not. A planted plot
          // (growing OR ripe: nothing here can harvest it) and a fruit tree open the
          // same info popup they do at home, minus the Insta-Grow row. On touch the
          // plot keeps the tap over a zombie exactly as at home, and bare ground
          // falls through to the zombie so no hold is needed there. Anything else
          // just free-roams the visitor's avatar: no harvest/plant/store/object
          // actions on their farm.
          if (field.hasCrop(col, row)) {
            hud.openCropInfo(() => field.cropInfoAt(col, row), { readOnly: true });
          } else if (field.treeInfoAtPoint(wx, wy)) {
            hud.openCropInfo(() => {
              const t = field.treeInfoAtPoint(wx, wy);
              return t ? { ...t, isZombie: false } : null;
            }, { readOnly: true });
          } else {
            const bare = isTouchPointer(pressPointerType) ? zombies.pick(wx, wy) : null;
            if (bare) inspectZombie(bare);
            else if (!jobs.busy) walk.goToPoint(wx, wy);
          }
          dragging = false;
          lastPlot = "";
          return;
        }
        // A plot owns a normal touch tap even when an item's sprite covers it.
        // Holding still targets that item through beginWorldLongPress().
        const touchPlot = plotOwnsObjectTap(pressPointerType, !!field.plotOriginAt(col, row));
        const objId = touchPlot ? null : field.objectAtPoint(wx, wy);
        const objDef = objId ? field.objectDefOf(objId) : null;
        // Signature decor (Liberty Bell, Gnome King, …) plays its own tap sound.
        if (objDef?.tapSound) audio.tap(objDef.tapSound);
        // Tap-played decor: the Parrot flaps and squawks, the Box o' Lantern pops.
        if (objId) field.triggerObjectAnimation(objId);
        if (objId && objDef && objDef.storageSlots) {
          hud.openStorage();
        } else if (objId && objDef && objDef.memorial) {
          openMemorialFor(objId, objDef); // who this statue remembers, or the graveyard
        } else if (objId && objDef && objDef.zombieStorage) {
          hud.openMausoleum(); // the Mausoleum's storage slots
        } else if (objId && objDef && objDef.zombiePatch) {
          // Tap the Zombie Patch: call all zombies to nap, or wake them.
          const napping = zombies.toggleGather(field.patchRestTiles());
          const wp = field.objectWorkPoint(objId);
          saveManager.flushCritical();
          if (wp) floatText(wp.x, wp.y - 24, napping ? "Zzz…" : "Awake!");
        } else if (objId && objDef && objDef.zombiePot) {
          activePotId = objId;
          hud.openCombiner(); // pick two zombies to combine, or collect a finished one
        } else if (objId && field.isObjectReady(objId)) {
          enqueueHarvestTarget({ kind: "tree", instanceId: objId });
        } else if (objId && objDef) {
          // A placed decoration/tree/Pet Pen: Move / Rotate / Store / Sell popup.
          openObjectActionsFor(objId, objDef);
        } else if (field.isRipe(col, row)) {
          const origin = field.plotOriginAt(col, row);
          if (origin) enqueueHarvestTarget({
            kind: "plot", oc: origin.oc, or: origin.or,
            isZombie: field.ripeZombieAt(col, row),
          });
        } else if (field.hasCrop(col, row)) {
          // Still-growing crop/zombie (not ripe yet): show its type + time left
          // (re-read on the popup's timer so the countdown ticks live) plus a button
          // to equip the Insta-Grow tool (or buy it when none are owned).
          hud.openCropInfo(() => field.cropInfoAt(col, row));
        } else if (field.canPlant(col, row)) {
          const onPick = (cfg: CropConfig) => {
            hud.setPlanting(cfg); // keep planting this crop on further taps
            jobs.enqueue("plant", col, row, cfg);
          };
          // During the tutorial's plant beat, constrain the menu to the base Zombie.
          if (tutorial.wantsLockedPlant(col, row))
            hud.openPlantMenu(onPick, { onlyKey: TUTORIAL_ZOMBIE_KEY });
          else hud.openPlantMenu(onPick);
        } else if (field.isSpent(col, row)) {
          const origin = field.plotOriginAt(col, row);
          if (origin) enqueueHarvestTarget({ kind: "replow", oc: origin.oc, or: origin.or });
        } else {
          // Nothing on this tile claimed the tap. On touch that makes an
          // overlapping zombie the obvious target, so away from plots it takes a
          // plain tap and the hold gesture is never needed.
          const bare = isTouchPointer(pressPointerType) ? zombies.pick(wx, wy) : null;
          if (bare) inspectZombie(bare);
          else if (tapFarmer(wx, wy)) { /* lantern toggled */ }
          else if (!jobs.busy) walk.goToPoint(wx, wy); // free-roam only when idle
        }
      } else if (hud.mode === "plant" && !field.canPlant(col, row)) {
        hud.setPlanting(null); // tapped anything but plantable ground -> back to select
      }
    }
    dragging = false;
    lastPlot = "";
  };
  const onPointerUp = (e: FederatedPointerEvent) => {
    // During/after a pinch, dragging was cleared so endDrag fires no stray tap.
    if (touchPinch) return;
    if (pressPointerId !== -1 && e.pointerId !== pressPointerId) return;
    cancelZombieLongPress();
    if (zombieLongPressActivated) {
      zombieLongPressActivated = false;
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      clearTouchToolStroke();
      clearHarvestStroke();
      clearPlowStroke();
      clearCancelStroke();
      return;
    }
    if (temporaryPanGesture) {
      temporaryPanGesture = false;
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      clearHarvestStroke();
      clearPlowStroke();
      return;
    }
    if (cancelStrokeActive) {
      collectCancelStrokeSegment(e.global.x, e.global.y);
      if (isTouchPointer(pressPointerType)) commitTouchCancelStroke();
      else clearCancelStroke();
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      touchOutsideFarmPan = false;
      touchSelectStartTile = null;
      field.hideCursor();
      clearTouchToolStroke();
      clearHarvestStroke();
      clearPlowStroke();
      return;
    }
    if (instaGrowStrokeActive) {
      collectInstaGrowStrokeSegment(e.global.x, e.global.y);
      if (isTouchPointer(pressPointerType)) commitTouchInstaGrowStroke();
      else clearInstaGrowStroke();
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      field.hideCursor();
      field.setObjectHighlight(null);
      clearTouchToolStroke();
      clearHarvestStroke();
      clearPlowStroke();
      return;
    }
    if (dragging && hud.mode === "till" && plowStrokeTargets.length) {
      collectPlowStrokeSegment(e.global.x, e.global.y);
      if (isTouchPointer(pressPointerType)) commitTouchPlowStroke();
      else clearPlowStroke();
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      touchOutsideFarmPan = false;
      clearTouchToolStroke();
      clearHarvestStroke();
      return;
    }
    if (harvestStrokeActive) {
      collectHarvestStrokeSegment(e.global.x, e.global.y);
      if (isTouchPointer(pressPointerType)) commitTouchHarvestStroke();
      else clearHarvestStroke();
      dragging = false;
      moved = false;
      lastPlot = "";
      pressPointerId = -1;
      touchOutsideFarmPan = false;
      touchSelectStartTile = null;
      clearTouchToolStroke();
      return;
    }
    if (dragging && moved && !touchOutsideFarmPan && isTouchPointer(pressPointerType) &&
        hud.mode === "plant") {
      commitTouchToolStroke();
    }
    endDrag(e);
    pressPointerId = -1;
    touchOutsideFarmPan = false;
    touchSelectStartTile = null;
    clearTouchToolStroke();
    clearHarvestStroke();
    clearPlowStroke();
    clearInstaGrowStroke();
    clearCancelStroke();
  };
  app.stage.on("pointerup", onPointerUp);
  app.stage.on("pointerupoutside", onPointerUp);
  // Some Android browsers emit the native release but lose Pixi's federated
  // pointer-up when collapsing the HUD changes the DOM beneath the finger. Wait
  // until native propagation is complete, then finish any touch gesture Pixi did
  // not already finish. Select taps intentionally resolve from pressStart: that
  // is the stable plowed plot the player actually touched.
  window.addEventListener("pointerup", (e: PointerEvent) => {
    if (!shouldRecoverTouchPointerUp(pressPointerId, e.pointerId, e.pointerType)) return;
    const pointerId = e.pointerId;
    setTimeout(() => {
      if (!shouldRecoverTouchPointerUp(pressPointerId, pointerId, "touch")) return;
      onPointerUp({ pointerId, global: pressStart } as FederatedPointerEvent);
    }, 0);
  });
  app.stage.on("pointercancel", cancelPointerGesture);
  window.addEventListener("blur", () => {
    if (dragging && moved && isTouchPointer(pressPointerType) && hud.mode === "plant")
      commitTouchToolStroke();
    cancelPointerGesture();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (dragging && moved && isTouchPointer(pressPointerType) && hud.mode === "plant")
        commitTouchToolStroke();
      cancelPointerGesture();
    }
  });

  // Right-click anywhere on the farm opens the tool menu (and suppresses the
  // browser menu). It opens on Select, so the old right-click-to-cancel reflex is
  // still one Enter away; the wheel scrolls to anything else.
  let toolWheel: ToolWheelHandle | null = null;
  const closeToolWheel = () => { toolWheel?.close(); toolWheel = null; };
  // Equip a tool without the toolbar's toggle behaviour: choosing the tool you are
  // already holding, from a menu, must keep it — not silently unequip it.
  const equipTool = (m: Mode) => { if (hud.mode !== m) hud.setMode(m); };
  const toolWheelItems = (): ToolWheelItem[] => {
    // The rotate row is context-sensitive here for the same reason the toolbar button
    // and the 3 key are: with something in hand, all three turn THAT. See rotateRowFor.
    const held = heldObjectName(hud.mode, hud.placing?.name, carrying?.def.name);
    const rotate = rotateRowFor(held);
    const rotateRow: ToolWheelItem = held
      ? { ...rotate, icon: "button_rotate.png", hint: "3", onPick: () => rotateCurrent() }
      : { ...rotate, icon: "button_rotate.png", hint: "3",
          active: hud.mode === "rotate", onPick: () => equipTool("rotate") };
    return [
      { id: "walk", label: "Select", icon: "button_multitool.png", hint: "1",
        active: hud.mode === "walk", onPick: () => equipTool("walk") },
      { id: "move", label: "Move", icon: "button_move.png", hint: "2",
        active: hud.mode === "move", onPick: () => equipTool("move") },
      rotateRow,
      { id: "till", label: "Plow", icon: "button_plow.png", hint: "4",
        active: hud.mode === "till", onPick: () => equipTool("till") },
      { id: "remove", label: "Remove", icon: "button_sell.png", hint: "5",
        active: hud.mode === "remove", onPick: () => equipTool("remove") },
      { id: "plant", label: "Plant…", icon: "button_plant.png", hint: "P",
        active: hud.mode === "plant",
        onPick: () => hud.openPlantMenu((cfg) => hud.setPlanting(cfg)) },
    ];
  };
  app.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (tutorial.active || visiting || raidActive) return;
    // Touch long-press already means "inspect"; a phone gets the × cancel button
    // instead, so never let a synthesized contextmenu open the menu there.
    if (isTouchPointer(pressPointerType)) return;
    if (toolWheel) { closeToolWheel(); return; }
    // Settings → Controls picks what right-click means: the tool menu (default) or
    // the older reflex of jumping straight back to the Select tool. Read per event
    // so a change in Settings applies to the very next right-click.
    if (getRightClickMode() === "select") { equipTool("walk"); return; }
    toolWheel = openToolWheel(hud.el, {
      x: e.clientX, y: e.clientY, items: toolWheelItems(),
      onSound: () => audio.play("menuClick"),
      onClose: () => { toolWheel = null; },
    });
  });

  // Hide the tool cursor when switching tools (and drop any carried object);
  // next pointer move re-shows the right cursor.
  hud.onModeChange = () => {
    clearPlowStroke();
    field.clearTillSelection();
    field.hideCursor();
    field.setObjectHighlight(null);
    zombies.clearSelection();
    cancelCarry();
    // Leaving placement drops a pending retrieve / Received placement — and so does
    // switching WHAT is being placed, which is the same abandonment by another route:
    // the Market calls setPlacing with a new def without ever leaving "place" mode.
    // See placementArming.ts for what an arming spent on the wrong def destroys.
    const armedReward = receiving === null ? undefined : receivedDef(state.received[receiving] ?? "");
    if (!armingSurvives(hud.mode, hud.placing?.key, retrieving?.key)) retrieving = null;
    if (!armingSurvives(hud.mode, hud.placing?.key, armedReward?.key)) receiving = null;
    if (hud.mode !== "place") placeTurn = 0; // and reset the ghost orientation
  };
  hud.onTemporaryPanChange = () => {
    clearPlowStroke();
    field.clearTillSelection();
    field.hideCursor();
    field.setObjectHighlight(null);
    hoveredCrop = null;
    hud.showCropHover(null);
  };

  window.addEventListener("resize", recenter);

  // ---- game loop ----
  // Persistent combine-timer bar that floats over the placed Zombie Pot while a
  // combine runs (offline-safe: it reflects the pot's absolute finish time).
  type PotBarView = { bar: Container; fill: Graphics; label: Text };
  const potBars = new Map<string, PotBarView>();
  const makePotBar = (): PotBarView => {
    const bar = new Container();
    bar.visible = false;
    const fill = new Graphics();
    const label = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "700",
        fill: 0xffffff, stroke: { color: 0x0a1406, width: 3 },
      },
    });
    const W = 88, H = 16, PAD = 2;
    const bg = new Graphics();
    bg.roundRect(-W / 2, -H / 2, W, H, 4)
      .fill({ color: 0x1a1a24, alpha: 0.9 })
      .stroke({ width: 2, color: 0x05050a });
    fill.roundRect(0, 0, W - 2 * PAD, H - 2 * PAD, 3).fill({ color: 0x8ad14a });
    fill.position.set(-W / 2 + PAD, -H / 2 + PAD);
    fill.scale.x = 0;
    label.anchor.set(0.5, 0.5);
    bar.addChild(bg, fill, label);
    field.labelLayer.addChild(bar);
    return { bar, fill, label };
  };

  // requestAnimationFrame normally stops in a hidden tab. Keep the small farm-job
  // pipeline alive on a coarse timer so plant commands reach the authoritative
  // server near their logical completion time instead of being held until the tab
  // is visible again. Browsers may throttle this timer (which is fine because the
  // elapsed-time replay closes the gap), and fully suspended tabs still catch up
  // through the visibility handler below.
  window.setInterval(() => {
    if (document.hidden) advanceFarmJobsToNow(true);
  }, 1000);

  // Watch the live session's TTL on WALL clock, which is the one thing the fight
  // itself cannot see (its dt is clamped per frame and stops entirely while hidden).
  // Checked from the ticker on purpose: the first frame after the player comes back
  // is exactly the moment they need to hear that the session ran out while away.
  const checkRaidExpiry = () => {
    if (!raidActive || raidExpiresAt == null) return;
    const expiry = invasionExpiryState(raidExpiresAt, Date.now());
    if (expiry === raidExpiryAnnounced) return;
    raidExpiryAnnounced = expiry;
    const message = invasionExpiryMessage(expiry, raidExpiresAt - Date.now());
    if (message) hud.showToast(message, 8000);
  };

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05);
    if (raidScene) raidScene.update(dt); // live battle drives itself
    checkRaidExpiry();
    advanceFarmJobsToNow(); // wall-clock-safe queued work + farmer movement
    // While a battle owns the screen the farm world is fully hidden, so every
    // visual update below (depth sorts, rig posing, occlusion masks, the night
    // light-map render) would be discarded work. Crop growth is wall-clock based,
    // so the first frame after the raid snaps everything to its true state.
    if (raidActive) return;
    const modalOpen = !!hud.el.querySelector(".panelbg, .mkt-bg, .st-bg, .pm-bg");
    if (modalOpen && hoveredCrop) {
      hoveredCrop = null;
      hud.showCropHover(null);
    }
    if (!modalOpen && cameraKeys.size) {
      const speed = 520 * dt;
      const dx = (cameraKeys.has("a") ? speed : 0) - (cameraKeys.has("d") ? speed : 0);
      const dy = (cameraKeys.has("w") ? speed : 0) - (cameraKeys.has("s") ? speed : 0);
      if (dx || dy) {
        world.position.x += dx;
        world.position.y += dy;
        clampCamera();
      }
    }
    cropHoverRefresh -= dt;
    if (hoveredCrop && cropHoverRefresh <= 0) {
      hud.showCropHover(
        field.cropInfoAt(hoveredCrop.col, hoveredCrop.row) ??
          field.treeInfoAtPoint(hoveredCrop.wx, hoveredCrop.wy),
        hoveredCrop.x,
        hoveredCrop.y,
      );
      cropHoverRefresh = 0.25;
    }
    for (let i = bossTokenFx.length - 1; i >= 0; i--) {
      const fx = bossTokenFx[i];
      fx.age += dt;
      const rise = Math.min(1, fx.age / 0.42);
      const easedRise = 1 - Math.pow(1 - rise, 3);
      // Back-ease scale supplies the slight "harvested zombie" pop/settle.
      const back = 1.70158;
      const scale = rise < 1
        ? 1 + (back + 1) * Math.pow(rise - 1, 3) + back * Math.pow(rise - 1, 2)
        : 1;
      fx.view.scale.set(Math.max(0.16, scale));
      fx.view.position.set(fx.x, fx.y + 10 - 62 * easedRise - (rise === 1 ? Math.sin((fx.age - 0.42) * 7) * 2 : 0));
      const pulse = 1 + Math.sin(fx.age * 10) * 0.06;
      fx.glow.scale.set(pulse);
      fx.glow.alpha = 0.82 + Math.sin(fx.age * 10) * 0.12;
      if (fx.age > 1.25) fx.view.alpha = Math.max(0, 1 - (fx.age - 1.25) / 0.4);
      if (fx.age < 1.65) continue;
      fx.view.destroy({ children: true });
      bossTokenFx.splice(i, 1);
    }
    petActor?.update(dt, actor.container.x, actor.container.y);
    const penBounds = field.petPenBounds();
    for (const pet of penPetActors) {
      pet.container.visible = !!penBounds;
      if (penBounds) pet.updateInPen(dt, penBounds);
    }
    zombies.update(dt);
    zombies.setInvasionReady(!raidActive && raids.cooldownRemaining() <= 0);
    field.updatePetPenOcclusion(penPetActors.map((pet) => pet.container));
    // What the camera can see, in world coordinates. The Sakura skin's falling
    // blossom is seeded across this rather than across the farm, so its on-screen
    // density stays the same however much land you own and however far you zoom.
    const viewTL = world.toLocal({ x: 0, y: 0 });
    const viewBR = world.toLocal({ x: app.screen.width, y: app.screen.height });
    field.setViewBounds(viewTL.x, viewTL.y, viewBR.x, viewBR.y);
    field.update(dt);
    // Farmer's lantern light follows the lamp carried in his hand, only at night.
    if (isNight) {
      const { x: lx, y: ly } = actor.lanternWorldPosition();
      lanternInner.position.set(lx, ly);
      lanternOuter.position.set(lx, ly);
      // Rebuild the light-map (dark mask with the lights erased into it) and lay it
      // over the farm. Runs before the automatic stage render (lower ticker priority),
      // so the map the display sprite shows is this frame's.
      night.update(app.renderer, world);
    }
    // Each physical Zombie Pot owns its own job and progress bar.
    const placedPotIds = new Set(field.zombiePotIds());
    for (const [id, view] of potBars) {
      if (placedPotIds.has(id)) continue;
      field.labelLayer.removeChild(view.bar);
      view.bar.destroy({ children: true });
      potBars.delete(id);
    }
    for (const potId of placedPotIds) {
      const pot = zombies.potFor(potId);
      // The pot itself shows what it is doing: lid clamped on while the combine
      // cooks, the new zombie's arm out once it is done (source art, one tile per
      // state). Cheap to call every frame — it only repaints on a state change.
      field.setObjectWork(potId, pot.busy ? (pot.ready ? "ready" : "busy") : null);
      let view = potBars.get(potId);
      if (!view) { view = makePotBar(); potBars.set(potId, view); }
      const wp = field.objectWorkPoint(potId);
      view.bar.visible = !!wp && pot.busy;
      if (!wp || !pot.busy) continue;
      view.bar.position.set(wp.x, wp.y - 92);
      view.fill.scale.x = pot.ready ? 1 : pot.progress();
      const secs = Math.ceil(pot.remainingMs() / 1000);
      view.label.text = pot.ready ? "Ready!" : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
    }
    // animate floating popups (rise + fade)
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      if (f.delay > 0) {
        f.delay -= dt;
        if (f.delay > 0) continue;
        f.view.visible = true;
      }
      f.ttl -= dt;
      f.view.y -= 26 * dt;
      f.view.alpha = Math.min(1, f.ttl);
      if (f.ttl <= 0) {
        world.removeChild(f.view);
        floats.splice(i, 1);
        // Back to the pool for the next popup; only the overflow is really destroyed.
        if (floatPool.length < FLOAT_POOL_MAX) floatPool.push(f);
        else f.view.destroy({ children: true });
      }
    }
    for (let i = harvestFx.length - 1; i >= 0; i--) {
      const fx = harvestFx[i];
      fx.age += dt;
      const p = Math.min(1, fx.age / 1.05);
      const eased = 1 - Math.pow(1 - p, 3);
      fx.view.position.set(
        fx.x + fx.dx * p + Math.sin(p * Math.PI) * Math.sign(fx.dx || 1) * 5,
        fx.y - fx.rise * eased,
      );
      fx.view.rotation += fx.spin * dt;
      fx.view.scale.set(fx.baseScale * (1 + p * 0.32));
      fx.view.alpha = p < 0.68 ? 1 : 1 - (p - 0.68) / 0.32;
      if (p < 1) continue;
      fx.view.destroy();
      harvestFx.splice(i, 1);
    }
  });

  // When the tab returns to the foreground after being backgrounded, the render loop
  // has been throttled/paused so on-screen crop growth is stale until the next frame.
  // Growth itself is wall-clock based (Field derives crop age from plantedAt), so a
  // single update(0) snaps every crop to its true current stage right away instead of
  // waiting on the first (possibly delayed) rAF tick, then we persist the fresh state.
  document.addEventListener("visibilitychange", () => {
    // Settle the job clock on both edges. On hide this captures the final sliver
    // after the last frame; on show it consumes the entire suspended interval.
    advanceFarmJobsToNow(true);
    if (document.hidden) {
      // Save after catch-up, not before it. Mobile browsers may freeze the page
      // before a debounced state-change timer gets another chance to run.
      saveManager.flushCritical();
      return;
    }
    field.update(0);
    saveManager.save();
  });
  window.addEventListener("pagehide", () => {
    advanceFarmJobsToNow(true);
    field.update(0);
    saveManager.flushCritical();
  });
  window.addEventListener("focus", () => advanceFarmJobsToNow(true));

  // Live game-state handle + mutation helpers for local testing (instant raids,
  // boost grants, zombie spawning, placement, combine, raid wins). DEV BUILDS
  // ONLY: `import.meta.env.DEV` is statically false in production, so Vite
  // tree-shakes this entire object — and the helpers it closes over — out of the
  // shipped bundle. It was never a security boundary (a determined player can edit
  // browser state regardless), but it must not be handed to every player. Real
  // integrity comes from server-side validation/authority.
  if (import.meta.env.DEV) (window as any).ZF = { app, world, field, actor, walk, zombies, state, hud, jobs, audio, save: saveManager, quests, questBus, periodicQuests, raids, screenToGrid, CARROT,
    placeables: placeCatalog,
    boosts: boostCatalog,
    // Seed/zombie-crop configs by key, so a test can plant one without the menu.
    crops: catalog,
    // Instantly resolve a raid for testing (e.g. ZF.runRaid(1) with 8+ zombies).
    runRaid: (id: number) => raids.start(id, raids.partyView().defaultSelectedIds),
    // Grant a boost for testing (e.g. ZF.giveBoost("instaGrow", 3)).
    giveBoost: (key: string, n = 1) => state.addBoost(key, n),
    // Mark a tier boss beaten so its abilities unlock across the roster.
    winRaid: (tier: number) => state.completeRaid(String(tier)),
    // Grow the farm as the Farm Size upgrade does, so the surroundings (backdrop,
    // camera bounds, scenery ring, and the road laid across it) rebuild for the new
    // size. The ring's extents are derived from those bounds, so this is the only
    // honest way to check them at 40/50/60/70 without buying four upgrades.
    growFarm: (size: number) => {
      field.resizeAuthoritative(size, size);
      syncWorldToFarm();
      clampCamera();
      return { w: field.w, h: field.h };
    },
    // Debug: place a catalog object by key (loads its texture first).
    place: async (key: string, oc: number, or: number) => {
      const def = placeCatalog.get(key);
      if (!def) return null;
      await ensureObjectTextures(assets, def);
      return field.placeObject(def, oc, or);
    },
    // Debug: spawn a zombie of `key` carrying mutation mask `mask` (bit OR), for
    // testing mutation rendering. e.g. ZF.spawnMutant("ZombieActorRegularTier1", 2|64).
    spawnMutant: (key: string, mask: number) =>
      zombies.spawn(key, walk.tile.col, walk.tile.row, mask),
    // Zombie Pot: start combining two owned zombies by id (needs a placed Zombie
    // Pot). e.g. ZF.combine("z1","z2"). Returns whether it started.
    combine: (idA: string, idB: string) => {
      return zombies.combine(idA, idB);
    },
    // Collect a finished combine beside the Pot (or into storage if capped).
    collectCombine: () => {
      const pending = zombies.combinePot.pending;
      const combined = pending ? combinedPotSubjects(pending) : null;
      const at = zombies.objectArrivalTile(field.zombiePotId());
      const z = zombies.collectCombine(at.col, at.row);
      if (z) {
        if (combined?.subject) {
          questBus.post(QuestEvent.CombinerCombined, combined.subject, 1, combined.aliases);
        }
        questBus.post(QuestEvent.CombinerCollected, z.typeName, 1, unitSubjectAliasesOf(z));
        if (!pending || isCombinePromotion(z.key, pending.keyA, pending.keyB)) {
          questBus.post(QuestEvent.CombinerHarvested, z.typeName, 1, unitSubjectAliasesOf(z));
        }
      }
      return z;
    },
    // Inspect the running combine: { busy, ready, remainingMs, pending }.
    potStatus: () => ({
      busy: zombies.combinePot.busy,
      ready: zombies.combineReady,
      remainingMs: zombies.combinePot.remainingMs(),
      pending: zombies.combinePot.pending,
    }),
    // Guided tutorial: the controller + dev controls.
    tutorial,
    tut: {
      start: () => tutorial.restart(),
      goto: (n: number) => tutorial.jumpTo(n as TutStep),
      reset: () => tutorial.clearPersisted(),
      steps: TutStep,
    } };
  // eslint-disable-next-line no-console
  console.log(`field ${field.w}x${field.h} ready`);

  // Game is fully built behind the boot overlay — fill the bar and flip it to
  // "Click to Start". Once that signed-in player dismisses the overlay, offer
  // fullscreen on supported mobile browsers. This callback timing prevents the
  // prompt from covering the loading art, while its dedicated top layer keeps it
  // above the tutorial and any writer/device-lock dialog already on the HUD.
  const offerMobileFullscreen = () =>
    offerFullscreenPrompt(hud, isMobile(), onlineFarm);
  if (boot) boot.ready(() => {
    // Use the explicit "Click to Start" gesture to satisfy browser/PWA media
    // policies. Constructor autoplay is only a best-effort early attempt.
    audio.resumeFromGesture();
    offerMobileFullscreen();
  });
  else offerMobileFullscreen();
}

main().catch((err) => {
  console.error(err);
  boot?.fail(); // drop the start screen so the error below is visible
  const hud = document.getElementById("hud");
  if (hud) hud.innerHTML = `<b style="color:#ffb0b0">Error:</b> ${err}`;
});
