import { Application, Assets, Container, FederatedPointerEvent, Graphics, Point, Sprite, Text, Texture } from "pixi.js";
// Patch Pixi's renderer to use no-eval polyfills for its shader/UBO/uniform/particle
// codegen (it otherwise uses `new Function`, which the production CSP's script-src
// blocks — no 'unsafe-eval'). Side-effect import; must run before `new Application()`.
// pixi.js lists ./lib/unsafe-eval/init.* under "sideEffects", so it survives bundling.
import "pixi.js/unsafe-eval";
import { loadAssets, ensureObjectTexture, PlaceableDef, BoostDef, SEED_FILE, ZombieDef, zombiePortrait, ZOMBIE_STAGES, lootImage, purchasableZombies } from "./assets";
import { Field, CARROT, CropConfig } from "./Field";
import { Actor } from "./Actor";
import { PetActor } from "./PetActor";
import { WalkController } from "./WalkController";
import { ZombieField } from "./zombie/ZombieField";
import { makeOwned } from "./zombie/types";
import { POT_DURATION_MS } from "./zombie/ZombiePot";
import { GameState } from "./GameState";
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
import { QuestBus, QuestEvent } from "./quest/events";
import { QuestSystem } from "./quest/QuestSystem";
import { QuestDef, RewardType } from "./quest/types";
import { RaidManager, RaidResultView } from "./raid/RaidManager";
import { RaidScene } from "./raid/RaidScene";
import { RAID_COOLDOWN_MS } from "./raid/RaidCatalog";
import { reconcilePartySelection } from "./raid/partySelection";
import { screenToGrid, tileCenter, TILE_H, TILE_W, HW, HH } from "./iso";
import { setFootprint } from "./depthSort";
import { NightLayer, makeLight } from "./lighting";
import { buyXp, sellBack, zombieSellValue } from "./economy";
import {
  DEFAULT_FARM_BACKGROUND, getFarmBackground, isFarmBackground, setFarmBackground,
  FARM_BG_DENSITY, type FarmBackground,
} from "./prefs";
import { BASE } from "./base";
import { TutorialController } from "./tutorial/TutorialController";
import { reconcileTutorialCompletion, TutStep, TUTORIAL_ZOMBIE_KEY } from "./tutorial/steps";
import { initPlatform, isMobile } from "./platform";
import { gestureMoved, isDeferredTouchMode, isTouchPointer } from "./touchInput";
import { mutationDescription } from "./zombie/mutations";
import { DR_GROUNDHOG, EPIC_BOSSES, epicBossById } from "./epicBoss/catalog";
import { EpicBossManager } from "./epicBoss/EpicBossManager";
import { buildEpicBossSetup, rollEpicBossLoot } from "./epicBoss/combat";
import { epicBossCurrencyReward } from "./epicBoss/rewards";
import { epicZombieRewardNotes, visibleEpicBosses } from "./epicBoss/market";
import { dropsEpicBossToken, EPIC_BOSS_FIGHT_BRAIN_COST } from "./epicBoss/tokens";

// The boot / start screen lives in index.html and paints on the first frame (no
// empty-farm flash). We report load milestones to it and, once the game is fully
// built, tell it to finish — it then shows "Click to Start" and a tap dismisses it.
const boot = (window as unknown as {
  __ZFBoot?: { progress(p: number): void; ready(): void; fail(): void };
}).__ZFBoot;

async function main() {
  // Detect device up front so <html data-platform> is set before the HUD's CSS
  // renders (drives the compact/desktop layout; re-evaluates on resize/rotate).
  initPlatform();
  // The game is locked behind Google sign-in: block here until the player is
  // signed in and has chosen a username (no-op on an offline build). Only then do
  // we load assets and build the game, so nothing runs for a signed-out visitor.
  await requireAuth();
  boot?.progress(0.35); // signed in — start filling the plate bar
  const app = new Application();
  await app.init({
    background: "#67bb4e", // grass green around the farm, matching the backdrop hills
    resizeTo: window,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById("app")!.appendChild(app.canvas);

  const assets = await loadAssets();
  boot?.progress(0.8); // heaviest step done — art is in
  const state = new GameState();
  let epicBoss = new EpicBossManager(DR_GROUNDHOG);
  state.seedFarmerCatalog(assets.farmer);
  const audio = new AudioManager(); // music/SFX default off (toggled in Settings)
  const hud = new Hud(state, audio);
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
      unlockLevel: p.level,
    };
    catalog.set(cfg.key, cfg);
    return {
      name: p.name, cost: p.cost, sell: p.sell, timeLabel: fmtTime(p.growMs),
      level: p.level, seasonal: p.seasonal,
      portrait: `${BASE}assets/crops/${p.stage2}`, cfg,
    };
  });
  // Zombie type catalog by key, so a harvested zombie crop can look up its full
  // def (stats + taxonomy) to spawn the matching owned unit.
  const zombieDefs = new Map<string, ZombieDef>();
  for (const z of assets.zombies) zombieDefs.set(z.key, z);
  const zombieCards = purchasableZombies(assets.zombies).map((z) => {
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
      description: mutationDescription(z.mutation ?? 0),
      portrait: zombiePortrait(z.key), // per-type composited portrait
      cfg,
    };
  });
  hud.setCatalog(plantCards, zombieCards);

  // Placeable-object catalog: key -> def, for the buy menu and save/load. Apply
  // the same debug grow-scaling to fruit-tree regrow timers as crops use.
  const placeCatalog = new Map<string, PlaceableDef>();
  const placeByName = new Map<string, PlaceableDef>();
  for (const o of assets.placeables) {
    placeCatalog.set(o.key, o);
    placeByName.set(o.name, o); // loot/quest rewards are keyed by display name
  }
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
  state.onLevelUpCb = (from, to) => {
    const unlocks: LevelUpUnlock[] = [];
    for (const r of assets.raids) {
      if (r.unlockLevel > from && r.unlockLevel <= to) {
        const f = r.bossPortrait || r.enemyIcon;
        unlocks.push({ icon: f ? raidImg(f) : "", name: r.name, kind: "Invasion" });
      }
    }
    for (const o of assets.placeables) {
      if (o.level > from && o.level <= to)
        unlocks.push({ icon: `${BASE}assets/objects/${o.sprite}`, name: o.name, kind: "Item" });
    }
    for (const b of assets.boosts) {
      if (b.level > from && b.level <= to)
        unlocks.push({ icon: `${BASE}assets/boosts/${b.icon}`, name: b.name, kind: "Boost" });
    }
    hud.openLevelUp({ level: to, brains: to - from, unlocks });
    audio.play("levelUp");
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
  const background = new Sprite(assets.background);
  background.anchor.set(0.5, 1);
  background.position.set(0, -BG_GAP_TILES * TILE_H);
  world.addChild(background);

  const field = new Field(assets);
  world.addChild(field.container);

  // Placed objects (trees) and the actors share Field.entityLayer so the farmer
  // depth-sorts correctly in front of / behind trees.
  world.addChild(field.entityLayer);

  // Job highlight diamonds (queued plow/plant/harvest markers) draw ABOVE the
  // entity layer so a ripe crop's tall sprite can't clip the top of the harvest
  // highlight. Kept below fxLayer/night so leaves and dusk still layer over it.
  world.addChild(field.highlightLayer);

  // Fertilize leaf FX draw above crops/actors (below night so they dim at dusk).
  world.addChild(field.fxLayer);

  // Decorative foliage on the grass AROUND the farm — never on a farm tile. It's
  // added to the depth-sorted entity layer (zIndex = grid depth) so trees south of
  // the farm draw in front of it and northern ones behind, matching placed trees.
  // Purely visual: not registered in the tile grid, so it blocks nothing.
  //
  // Rebuildable: a Farm Size upgrade grows field.w/h, so the ring must move outward
  // (old foliage would otherwise end up sitting ON the newly-added farm tiles). We
  // track the sprites and regenerate them against the current bounds. The RNG is
  // seeded per field size so a given farm size always yields the same stable layout.
  let foliage: Sprite[] = [];
  // A visit may display the friend's selection, but must never overwrite this
  // device's own preference in localStorage.
  let displayedFarmBackground: FarmBackground = getFarmBackground();
  const buildFoliage = () => {
    for (const s of foliage) { s.parent?.removeChild(s); s.destroy(); }
    foliage = [];
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
    const treeTop = background.position.y + 6; // grass just below the hill bases
    const uMin = Math.floor(boundL / HW) - 2, uMax = Math.ceil(boundR / HW) + 2;
    const vMin = Math.floor((treeTop - HH) / HH) - 2;
    const vMax = Math.ceil((boundB - HH) / HH) + 2;
    const STEP = 2;
    // Farm Background setting scales the tree count: Deep Forest = full, Woodland
    // ~half, Light Meadow ~a tenth. Same seed, so the sparser sets are subsets of
    // the denser ones and switching just thins/thickens the same forest.
    const accept = 0.34 * FARM_BG_DENSITY[displayedFarmBackground];
    for (let v = vMin; v <= vMax; v += STEP) {
      for (let u = uMin; u <= uMax; u += STEP) {
        const ju = u + (rnd() - 0.5) * STEP * 1.3; // jitter off the lattice
        const jv = v + (rnd() - 0.5) * STEP * 1.3;
        const wx = ju * HW, wy = jv * HH + HH;
        const col = (ju + jv) / 2, row = (jv - ju) / 2;
        const d = distOutside(col, row);
        const r1 = rnd(), r2 = rnd(), r3 = rnd(); // consume RNG evenly (stable layout)
        // Gate: inside the reachable rect (slight overshoot so edges fully cover) and
        // off the farm + its clearing margin.
        if (wx < boundL - HW || wx > boundR + HW || wy < treeTop || wy > boundB + HH) continue;
        if (d < MARGIN) continue;
        // Even woodland fill: half trees / half shrubs (shrubs only near the clearing
        // edge; full-height trees farther out). `accept` sets how much of the lattice
        // is populated per the Farm Background setting.
        if (r1 >= accept) continue;
        const isTree = d >= 4.5 && r2 < 0.5;
        const tex = isTree ? assets.scenery[0] : assets.scenery[1 + Math.floor(r3 * 3)];
        const s = objScale * (isTree ? 0.7 + r3 * 0.28 : 0.55 + r3 * 0.3);
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1);
        sp.scale.set(s);
        sp.position.set(wx, wy);
        // Point footprint on its tile so it depth-sorts with trees/actors.
        const fc = Math.round(col), fr = Math.round(row);
        setFootprint(sp, fc, fr, fc, fr);
        field.entityLayer.addChild(sp);
        foliage.push(sp);
      }
    }
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

  // Owned zombies (Phase 3): grown from harvested zombie crops, they wander the
  // farm (routing around objects) and can be selected to inspect their stats.
  const zombies = new ZombieField(assets, field, state, (key) => zombieDefs.get(key));

  // Night lighting layer: a dark mask with the lights erased out of it (revealing
  // the daytime scene under each light — never a glare), above the farm/entities
  // but below the job labels & cursor (UI stays readable). Toggled from the HUD's
  // Developer menu for now (a real day/night cycle comes later).
  const night = new NightLayer();
  night.lights.addChild(field.objectLights); // glowing objects' lights
  // Farmer lantern: two point lights (ZF2 addPlayerLight: radius 200 & 350, white).
  // Alpha here = how strongly the light carves the darkness away (reveals daytime).
  const lanternInner = makeLight(200, 0xfff0c8, 1.0);
  const lanternOuter = makeLight(350, 0xffe6b0, 0.55);
  night.lights.addChild(lanternOuter, lanternInner);
  world.addChild(night);
  let isNight = false;
  const setNight = (on: boolean) => {
    isNight = on;
    night.visible = on;
    // Leave the viewport FILLER (the area beyond the hills backdrop) the daytime
    // hill/grass green in both modes — it's the exact colour of the backdrop hills
    // (sampled 0x67bb4e). At night the NightLayer's dark overlay covers the whole
    // screen, so it darkens this filler by the SAME amount as the hills; they read
    // as one continuous surface instead of the hills floating over a near-black void.
  };
  // The night toggle now lives in the Developer menu (HUD hotspot) instead of the
  // N key. Hooks are wired below once the HUD exists.

  // Job labels ("Plow/Plant/Harvest" pills) and the plot cursor render above the
  // field + entities so they're never hidden behind the farmer/zombie.
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
  };

  // Box the camera into the world: the view can pan/zoom to reveal the full sky
  // (top), the farm, and the decorated grass ring around it, but no further into
  // empty green void or above the sky. Recomputed whenever the farm grows; the reach
  // matches the foliage band so all scenery stays reachable.
  let boundL = 0, boundR = 0, boundT = 0, boundB = 0;
  const computeBounds = () => {
    const skyTopY = background.y - background.height; // world y of the sky's top edge
    const grassBoundL = -((field.w - 1 + 2 * REACH) * HW) - 90;
    boundL = Math.max(grassBoundL, -background.width / 2);
    boundR = Math.min(-grassBoundL, background.width / 2);
    boundT = skyTopY;
    boundB = (field.w - 1 + REACH + (field.h - 1 + REACH)) * HH + 60;
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

  const minSceneZoom = () => Math.max(
    MIN_ZOOM,
    app.screen.width / (boundR - boundL),
    app.screen.height / (boundB - boundT)
  );
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
  const clampCamera = () => {
    clampZoom();
    world.position.x = clampAxis(world.position.x, world.pivot.x, app.screen.width, boundL, boundR);
    world.position.y = clampAxis(world.position.y, world.pivot.y, app.screen.height, boundT, boundB);
  };
  const recenter = () => {
    world.position.set(app.screen.width / 2, app.screen.height / 2);
    clampCamera();
  };
  recenter();

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

  // ---- floating "+xp / -gold" popups (world-space) ----
  const floats: { t: Text; ttl: number }[] = [];
  const floatText = (x: number, y: number, msg: string) => {
    const t = new Text({
      text: msg,
      style: {
        fontFamily: "system-ui, sans-serif", fontSize: 20, fontWeight: "700",
        fill: 0xffd24a, stroke: { color: 0x3a2400, width: 4 },
      },
    });
    t.anchor.set(0.5, 0.5);
    t.position.set(x, y);
    world.addChild(t);
    floats.push({ t, ttl: 1.1 });
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

  let latestBossTokenHarvest: { x: number; y: number } | null = null;
  const awardOfflineEpicBossToken = (growMs: number, value: number, x: number, y: number): boolean => {
    if (state.onFarm) {
      latestBossTokenHarvest = { x, y };
      return false;
    }
    const run = state.epicBossRun;
    const def = epicBossById(run?.bossId);
    if (!run || !def || !new EpicBossManager(def).isActive(run) || !dropsEpicBossToken(growMs, value)) return false;
    state.setEpicBossRun({ ...run, tokenCount: (run.tokenCount ?? 0) + 1 });
    popBossToken(x, y, def.id, def.portrait);
    return true;
  };

  // The farmer's job queue (till / plant / harvest / walk). He walks to each target,
  // hoes, then the action applies; queued plots stay highlighted green until done.
  // Harvesting a zombie crop grows an owned zombie at the plot's center tile.
  const jobs = new JobSystem(
    field, actor, walk, state, floatText, (name) => audio.play(name),
    (key, oc, or) => zombies.spawnVerified(key, oc + 1, or + 1)?.id ?? null,
    questBus,
    (oc, or) => zombies.tryFertilize(oc, or),
    (oc, or) => tutorial?.onPlotPlowed(oc, or),
    awardOfflineEpicBossToken
  );

  // Quest-complete celebration, styled like the level-up popup. Quests can finish in
  // bursts (several at once on a raid return), so completions QUEUE and show one at a
  // time; the HUD calls onQuestCompleteClosed when each is dismissed to feed the next.
  const uiIcon = (name: string) => `${BASE}assets/ui/${name}`;
  const questRewards = (def: QuestDef): QuestReward[] => {
    switch (def.rewardType) {
      case RewardType.Gold:
        return def.rewardValue ? [{ icon: uiIcon("topbar_money_icon.png"), label: `+${def.rewardValue} Gold` }] : [];
      case RewardType.Xp:
        return def.rewardValue ? [{ icon: uiIcon("topbar_level_icon.png"), label: `+${def.rewardValue} XP` }] : [];
      case RewardType.Brains:
        return def.rewardValue
          ? [{ icon: uiIcon("topbar_brain_icon.png"), label: `+${def.rewardValue} ${def.rewardValue === 1 ? "Brain" : "Brains"}` }]
          : [];
      case RewardType.Item:
      case RewardType.Zombie:
        // A named item/zombie reward — show its name; the quest sprite doubles as its icon.
        return def.rewardItem ? [{ icon: uiIcon(def.sprite), label: def.rewardItem }] : [];
      default:
        return [];
    }
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
    if (!questCompleteShowing) showNextQuestComplete();
  };

  // The data-driven quest engine (all 96 quests from quests.json). Rewards route to
  // GameState / the roster; the HUD rail and the completion popup come from `hud`.
  const quests = new QuestSystem(
    new Map(Object.entries(assets.quests)), state, questBus,
    {
      // Signed-in quest progress follows accepted server commands. Advancing from
      // local notifications would permanently complete quests for actions the
      // server later rejected or rolled back.
      authoritative: auth.isSignedIn(),
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
      grantZombie: (key) => { zombies.grantReward(key, walk.tile.col, walk.tile.row); },
      completed: (def) => celebrateQuest(def),
      render: (views) => hud.setQuests(views),
    }
  );

  // ---- consumable boosts: buy (into inventory) + use (apply farm effect) ----
  // Gift vouchers are "1 per farm": you can't buy/use one once you already own
  // that zombie OR already hold an (unused) voucher granting it. The check is keyed
  // by the RESULTING zombie, so ordinary and pink Cupid use independent one-copy
  // limits while duplicate vouchers for the same exact actor still share a limit.
  const ownsGiftZombie = (giftKey: string) =>
    !!giftKey && zombies.roster().some((z) => z.key === giftKey);
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
    return auth.isSignedIn() && !!economy && !economy.available;
  }

  hud.onBuyBoost = (def) => {
    if (onlineGameplayBlocked()) return false;
    if (tutorial && !tutorial.allowsBoostPurchase(def.key)) return false;
    if (def.effect === "gift" && giftLimitReached(def.key)) return false; // 1 per farm
    if (state.onInventory) {
      // ONLINE: the server prices the boost (exact catalog cost), debits currency, and
      // grants perPurchase — atomically. Affordability is checked against the
      // server-synced balance first for instant feedback; the server is the gate.
      const funds = def.brainsNeeded ? state.brains : state.gold;
      if (funds < def.cost) return false;
      const optimistic = def.brainsNeeded
        ? { count: def.perPurchase, brains: -def.cost }
        : { count: def.perPurchase, gold: -def.cost };
      state.onInventory({ type: "buy", key: def.key }, optimistic);
      audio.play("buy");
      return true;
    }
    const paid = def.brainsNeeded ? state.spendBrains(def.cost) : state.spendGold(def.cost);
    if (!paid) return false;
    state.addBoost(def.key, def.perPurchase); // a purchase grants `perPurchase` uses
    audio.play("buy");
    return true;
  };
  hud.onUseBoost = (def) => {
    if (onlineGameplayBlocked()) return;
    if (state.boostCount(def.key) <= 0) return;
    giftUnitId = null;
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
      state.onInventory(action, { count: -1 });
    } else state.useBoost(def.key);
    giftUnitId = null;
    powerUnitIds = [];
    growTarget = null;
  };

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

  // The Insta-Grow tool (mode "instagrow") ripens exactly the tapped crop or an
  // active Zombie Pot and spends one use. A stray tap is ignored (no wasted use).
  // When the last use is spent the tool auto-unequips back to the select tool.
  const tryInstaGrow = (col: number, row: number, wx: number, wy: number) => {
    const def = growBoostDef();
    if (!def) return;
    if (state.boostCount(def.key) <= 0) { hud.setMode("walk"); return; }
    const objectId = field.objectAtPoint(wx, wy);
    const objectDef = objectId ? field.objectDefOf(objectId) : null;
    if (objectDef?.zombiePot && objectId && zombies.finishCombineNow(objectId)) {
      if (state.onInventory) state.onInventory({ type: "use", key: def.key, target: "zombie_pot" }, { count: -1 });
      else state.useBoost(def.key);
      audio.play("instaGrow");
      const p = field.objectWorkPoint(objectId!);
      if (p) floatText(p.x, p.y - 48, "Ready!");
      saveManager.save();
      if (state.boostCount(def.key) <= 0) hud.setMode("walk");
      return;
    }
    const grown = field.growCropAt(col, row);
    if (!grown) return; // not a growing crop -> keep tool equipped
    if (state.onInventory) state.onInventory({ type: "use", key: def.key, oc: grown.oc, or: grown.or }, { count: -1 });
    else state.useBoost(def.key);
    audio.play("instaGrow");
    const c = tileCenter(col, row);
    floatText(c.x, c.y, "Grew!");
    if (state.boostCount(def.key) <= 0) hud.setMode("walk"); // used up -> unequip
  };

  // Set by applyBoost when a GIFT voucher spawns its zombie: the new unit's id, which
  // onUseBoost sends with the voucher `use` so the server can grant that same unit.
  // Null for every other boost effect.
  let giftUnitId: string | null = null;
  let powerUnitIds: { id: string; oc: number; or: number }[] = [];
  let growTarget: { oc: number; or: number } | null = null;

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
      for (const pl of field.ripePlots()) {
        if (pl.isZombie && !zombies.canAdd()) continue; // respect the army cap
        const r = field.harvestAt(pl.oc, pl.or);
        if (!r) continue;
        if (state.onFarm) {
          if (r.zombieKey) {
            const unit = zombies.spawnVerified(r.zombieKey, pl.oc + 1, pl.or + 1);
            if (!unit) continue;
            powerUnitIds.push({ id: unit.id, oc: pl.oc, or: pl.or });
          }
          // The server receives one semantic power command from onUseBoost below;
          // individual optimistic harvests must not become commands.
        } else {
          if (r.sell) state.addGold(state.farmerHarvestGold(r.sell));
          state.addXp(r.xp);
          if (r.zombieKey) zombies.spawn(r.zombieKey, pl.oc + 1, pl.or + 1);
        }
        questBus.post(r.isZombie ? QuestEvent.ZombieHarvested : QuestEvent.CropHarvested, r.name);
        const cropCenter = field.plotCenterOf(pl.oc, pl.or);
        if (!r.isZombie && awardOfflineEpicBossToken(r.growMs, r.sell, cropCenter.x, cropCenter.y)) {
          floatText(c.x, c.y - 28, "+1 Boss Token!");
        }
        harvested++;
      }
      if (harvested) floatText(c.x, c.y, `Harvested ${harvested}!`);
      return harvested > 0;
    }
    if (def.effect === "plow") {
      const n = field.replowSpent();
      for (let i = 0; i < n; i++) {
        questBus.post(QuestEvent.SoilPlowed, "Plow");
        questBus.post(QuestEvent.NewSoilPlowed, "Plow");
      }
      if (n) floatText(c.x, c.y, `Plowed ${n}!`);
      return n > 0;
    }
    if (def.effect === "gift") {
      if (!def.giftZombieKey) return false;
      // 1 per farm: don't spawn a duplicate of a gift zombie you already own.
      if (ownsGiftZombie(def.giftZombieKey)) { floatText(c.x, c.y, `Already have ${def.name}!`); return false; }
      if (!zombies.canAdd()) { floatText(c.x, c.y, "Army full!"); return false; }
      // ONLINE, the voucher `use` grants this unit server-side, so spawn it verified
      // (no onGrant) and hand its id to onUseBoost to send. The server re-checks the
      // catalog key, the voucher count, and the 1-per-farm rule.
      const unit = zombies.spawnVerified(def.giftZombieKey, walk.tile.col, walk.tile.row);
      if (!unit) return false;
      giftUnitId = unit.id;
      floatText(c.x, c.y, `Got ${def.name}!`);
      return true;
    }
    // concentration / dice are spent on the Invade screens, not on the farm.
    floatText(c.x, c.y, "Used during invasions");
    return false;
  };

  // Restore a prior farm (currencies, XP, plots, crops-with-offline-growth, farmer
  // position) if one exists, then start autosaving. Load before the loop so the
  // restored farm shows on the first frame.
  const saveManager = new SaveManager(state, field, walk, zombies, quests, catalog, placeCatalog, (sprite) =>
    ensureObjectTexture(assets, sprite)
  );

  // Visit mode: if a friend farm was requested (via enterVisit → reload), hydrate
  // THEIR read-only save into these fresh singletons and — crucially — never call
  // enableAutosave(). The player's own save is never loaded in this mode, so a
  // visit cannot read, write, or corrupt it. On any fetch failure we clear the
  // target and fall through to a normal load, so the player always lands on their
  // own farm.
  const visitTarget = getVisitTarget();
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
    restored = await saveManager.load();
    state.seedFarmerCatalog(assets.farmer);
    applyFarmerAppearance();
    if (!restored) quests.restore(); // fresh farm: activate the opening quests
    saveManager.enableAutosave();
    // Backfill newly-added presentation fields (such as woodland density) even
    // when an existing player does not immediately change another farm value.
    saveManager.save();
    console.log(restored ? "[save] restored existing farm" : "[save] fresh farm");
  }
  // Server-authoritative currency (online, own-farm only). Wire the money hook so
  // every gold/brains/xp change mirrors to the server ledger, then start() adopts
  // the authoritative balance (server wins over the just-loaded blob). Offline or
  // while visiting, `economy` stays null and currency is purely local as before.
  let economy: EconomyClient | null = null;
  hud.onEquipFarmerHead = (head) => {
    if (economy && !economy.submitFarmerEquip(head.id)) return;
    state.equipFarmerHead(head.id);
  };
  hud.onEquipFarmerBody = (body) => { state.equipFarmerBody(body.id); };
  hud.onBuyFarmerHead = (head) => {
    const cost = head.cost ?? 0;
    if (!cost) {
      state.unlockFarmerHead(head.id, head.bodyId);
      state.equipFarmerHead(head.id);
      return true;
    }
    const currency = head.brains ? "brains" : "gold";
    if ((currency === "brains" ? state.brains : state.gold) < cost) return false;
    if (economy) {
      if (!economy.submitFarmerBuy(head.id, currency, cost)) return false;
    } else {
      const paid = currency === "brains"
        ? state.spendBrains(cost, "purchase")
        : state.spendGold(cost, "purchase");
      if (!paid) return false;
    }
    state.unlockFarmerHead(head.id, head.bodyId);
    state.equipFarmerHead(head.id);
    economy?.submitFarmerEquip(head.id);
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
      if (!economy.submitPetBuy(pet.key, pet.cost)) return false;
    } else if (!state.spendBrains(pet.cost, "purchase")) {
      return false;
    }
    state.unlockPet(pet.key);
    return true;
  };
  const storedObjectIds = new Map<string, string[]>();
  if (!visiting && auth.isSignedIn()) {
    const acct = api.getSession()?.accountId ?? "anon";
    economy = new EconomyClient(state, acct);
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
    // The server owns the Garden-zombie fertilize roll; when a freshly-planted crop
    // comes back fertilized, apply the 2x visual (leaf FX) to that plot.
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
    economy.onObjectState = async (objects, aliases, baseZombieMax, rejectedLocalIds) => {
      const generation = ++objectReconcileGeneration;
      const current = new Map(field.serializeObjects().map((object) => [object.id, object]));
      for (const id of rejectedLocalIds) field.removeObject(id);

      for (const object of objects) {
        const localId = aliases[object.instanceId];
        const source = current.get(object.instanceId) ?? (localId ? current.get(localId) : undefined);
        if (object.status !== "placed") {
          if (current.has(object.instanceId)) field.removeObject(object.instanceId);
          if (localId && current.has(localId)) field.removeObject(localId);
          continue;
        }
        const direct = current.get(object.instanceId);
        if (direct?.key === object.catalogKey) {
          if (object.readyAt !== undefined) field.syncObjectReadyAt(object.instanceId, object.readyAt);
          continue;
        }
        const def = placeCatalog.get(object.catalogKey);
        if (!def || !source) continue;
        await ensureObjectTexture(assets, def.sprite);
        if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
        if (generation !== objectReconcileGeneration) return;
        field.removeObject(source.id);
        field.placeObject(def, source.oc, source.or, object.instanceId, object.readyAt, !!source.rotation);
      }

      if (generation !== objectReconcileGeneration) return;

      storedObjectIds.clear();
      for (const object of objects) {
        if (object.status !== "stored") continue;
        const ids = storedObjectIds.get(object.catalogKey) ?? [];
        ids.push(object.instanceId);
        storedObjectIds.set(object.catalogKey, ids);
      }
      state.syncObjectStorage(Object.fromEntries([...storedObjectIds].map(([key, ids]) => [key, ids.length])));
      const placed = field.serializeObjects();
      const armyBonus = placed.reduce((sum, object) => sum + (placeCatalog.get(object.key)?.armyMax ?? 0), 0);
      const itemCap = placed.reduce((cap, object) => Math.max(cap, placeCatalog.get(object.key)?.storageSlots ?? 0), 8);
      state.syncCapacities(baseZombieMax + armyBonus, itemCap);
    };
    economy.onRosterState = (roster, aliases) => {
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
        name: zombie.name,
        typeName: zombie.typeName,
        portrait: zombiePortrait(zombie.key),
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
    zombies.onCombineCollect = (potId, unitId, key, mutation) =>
      economy!.submitRoster({ type: "combineCollect", potId, unitId, key, mutation });
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
    economy.onFarmerState = (headIds, equippedHeadId) =>
      state.syncFarmerOwnership(headIds, assets.farmer, equippedHeadId);
    economy.onPetState = (ownedPets, activePet, penPets) => state.syncPetOwnership(ownedPets, activePet, penPets);
    economy.onQuestState = (serverState) => quests.restoreAuthoritative(serverState);
    economy.onQuestChanges = (changes) => quests.applyAuthoritativeChanges(changes);
    economy.onTutorialState = (rewarded) => {
      if (!rewarded) return;
      state.setTutorial(reconcileTutorialCompletion(state.tutorial, true));
      tutorial?.completeFromAuthority();
    };
    economy.onGameplayUnavailable = () => hud.showToast("Gameplay paused — reconnect to continue.");
    const showWriterLock = () => {
      saveManager.setOnlineWritable(false);
      hud.showWriterLock(async () => {
        if (!await economy!.takeOver()) return false;
        window.location.reload();
        return true;
      });
    };
    economy.onWriterReplaced = showWriterLock;
    economy.onWriterAvailable = () => {
      saveManager.setOnlineWritable(true);
      hud.hideWriterLock();
    };
    economy.onCommandRejected = (command, error) => {
      const subject = command?.type.startsWith("roster.") ? "Zombie action"
        : command?.type.startsWith("object.") ? "Object action"
        : command?.type.startsWith("storage.") ? "Reward action"
        : command?.type.startsWith("farm.") ? "Farm action"
        : command?.type.startsWith("power.") ? "Boost action" : "Action";
      const reason: Record<string, string> = {
        not_owned: "the item is no longer available", capacity_full: "capacity is full",
        none_owned: "the reward is no longer available", stack_full: "the inventory stack is full",
        army_full: "the farm is full", storage_full: "storage is full",
        not_grown: "the crop is not ready", nothing_planted: "the crop changed",
        not_plowed: "the soil is no longer plowed", plot_occupied: "the plot already contains a crop",
        insufficient: "there are not enough funds", no_effect: "the game state changed",
        prior_command_failed: "an earlier related action failed",
      };
      hud.showToast(`${subject} was rolled back: ${reason[error] ?? error.replace(/_/g, " ")}.`);
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
  let pressPointerType = "mouse";
  let pressPointerId = -1;
  // Plow/plant tiles painted by the current finger gesture. They are queued only
  // on finger-up, so a second finger can safely convert the gesture into a pinch.
  const touchGestureTiles: { col: number; row: number }[] = [];

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
    dragging = false;
    moved = false;
    lastPlot = "";
    pressPointerId = -1;
    touchGestureTiles.length = 0;
    touchPinch = false;
    pinchDist = 0;
    field.hideCursor();
    field.setObjectHighlight(null);
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
      dragging = false; // abandon any in-progress single-finger pan
      // Nothing has committed yet: discard the pending paint stroke and let the
      // two fingers control the camera instead.
      touchGestureTiles.length = 0;
      lastPlot = "";
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
  const tileKey = (col: number, row: number) => `${col},${row}`;

  // Queue the active tool on a plot: Plow places/re-tills a 4x4; Plant sows the
  // currently-selected crop. No-op for select/sell.
  const enqueueTool = (col: number, row: number): boolean => {
    if (hud.mode === "till") return jobs.enqueue("till", col, row);
    if (hud.mode === "plant" && hud.planting)
      return jobs.enqueue("plant", col, row, hud.planting);
    return false;
  };

  // ---- object buy / place / move ----
  // The Market offers only the NEXT shed above the current tier; report the placed
  // shed's capacity (0 = none) so it can filter to that single card.
  hud.getShedSlots = () => {
    const id = field.shedId();
    return id ? field.objectDefOf(id)?.storageSlots ?? 0 : 0;
  };
  // Colored graves gate planting their zombie class (Blue/Red/Silver).
  hud.hasGrave = (color) => field.hasGrave(color);

  // ---- Farm Size upgrade (Market → Upgrade tab) ----
  // Buying an expansion grows the field (origin stays at 0,0 so nothing on the farm
  // moves) and re-fits the backdrop/foliage/camera to the new size. Sizes are bought
  // in order (30 → 40 → 50 → 60). Each tier has a gold card and a brains card;
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

  // Upgrade the already-placed shed to a bigger one IN PLACE (no re-placement):
  // charge, swap its type/sprite, and raise the storage capacity.
  const upgradeShed = (def: PlaceableDef) => {
    if (onlineGameplayBlocked()) return;
    const id = field.shedId();
    if (!id) return;
    if (state.level < def.level) return;
    const xp = buyXp(def.cost, def.xp); // buying/upgrading always rewards XP
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
    if (def.storageSlots) state.upgradeStorage(def.storageSlots);
    saveManager.save();
    const o = field.objectOriginOf(id);
    if (o) {
      const c = tileCenter(o.oc, o.or);
      floatText(c.x, c.y, `-${def.cost}${def.brainsNeeded ? "b" : "g"}  +${xp}xp`);
    }
    questBus.post(QuestEvent.ItemBought, def.name);
  };

  // Buying an object from the market: load its sprite(s) (lazy). A shed with one
  // already placed UPGRADES it in place; otherwise enter placement. Fruit trees
  // have a second (growing) frame to preload.
  hud.onBuy = async (def) => {
    if (onlineGameplayBlocked()) return;
    await ensureObjectTexture(assets, def.sprite);
    if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
    if (def.storageSlots && field.shedId()) upgradeShed(def); // upgrade, don't place
    else if (def.zombieStorage && field.mausoleumId()) return; // already have a Mausoleum
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
  hud.zombiePortraitOf = (key) => zombiePortrait(key);
  hud.mausoleumCap = zombies.mausoleumCap;
  hud.canStoreZombies = () => !!field.mausoleumId() && !zombies.mausoleumFull;
  hud.canDeployZombie = () => zombies.canAdd();
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
  hud.zombieBaseCost = (key) => zombieDefs.get(key)?.cost ?? 0;
  hud.onZombieSell = async (id) => {
    if (onlineGameplayBlocked()) return;
    try { if (economy) [id] = await economy.settleUnitIds([id]); }
    catch { hud.showToast("Could not confirm that zombie. Please reconnect."); return; }
    const z = zombies.roster().find((r) => r.id === id);
    if (!z) { hud.showToast("That zombie is no longer available."); return; }
    const value = zombieSellValue(zombieDefs.get(z.key)?.cost ?? 0);
    const p = zombies.selectById(id); // deployed unit's world pos (null if stored)
    if (!zombies.sell(id)) return; // gone already; don't credit gold
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
      pending: pot.pending
        ? { keyA: pot.pending.keyA, keyB: pot.pending.keyB, maskA: pot.pending.maskA, maskB: pot.pending.maskB }
        : null,
    };
  };
  hud.canCombineZombie = (key) => !zombieDefs.get(key)?.rewardOnly;
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
  hud.onCollectCombine = async () => {
    if (onlineGameplayBlocked()) return null;
    if (!activePotId) return null;
    const pending = zombies.potFor(activePotId).pending;
    const object = pending
      ? [zombieDefs.get(pending.keyA)?.name ?? "", zombieDefs.get(pending.keyB)?.name ?? ""].filter(Boolean).sort().join(" ")
      : "";
    const z = zombies.collectCombine(walk.tile.col, walk.tile.row, activePotId);
    if (z) {
      if (object) questBus.post(QuestEvent.CombinerCombined, object);
      questBus.post(QuestEvent.CombinerHarvested, z.typeName);
      const c = tileCenter(z.col, z.row);
      floatText(c.x, c.y, z.mutation ? `${z.name}!` : z.name);
      try { await economy?.settleBeforeDependency(); }
      catch { hud.showToast("The combine result is waiting for the server to reconnect."); }
      saveManager.flushCritical();
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
    { save: () => { saveManager.flush(); void economy?.flush(); } },
    raidCooldownMs
  );
  hud.getRaidCards = () => raids.raidCards();
  hud.getRaidParty = () => raids.partyView();
  hud.getRaidStatus = () => ({
    cooldownMs: raids.cooldownRemaining(),
    voucherCount: raids.voucherCount(),
  });
  const selectEpicBoss = (bossId: string | null | undefined) => {
    const def = epicBossById(bossId) ?? DR_GROUNDHOG;
    if (epicBoss.def.id !== def.id) epicBoss = new EpicBossManager(def);
    return def;
  };
  const epicAsset = (def: typeof DR_GROUNDHOG, file: string) => `${BASE}assets/epic-bosses/${def.id}/${file}`;
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
        costBrains: def.costBrains, maxLevel: def.maxLevel,
        reconstructed: !!def.reconstructed, blocked: active && !ownActive,
        run: ownRun, active: ownActive,
        expired: !!ownRun && !ownRun.completedAt && now >= ownRun.expiresAt,
        completed: !!ownRun?.completedAt,
        eventRemainingMs: ownActive && ownRun ? Math.max(0, ownRun.expiresAt - now) : 0,
        encounterRemainingMs: ownActive && ownRun?.encounterStartedAt
          ? Math.max(0, ownRun.encounterStartedAt + def.encounterMs - now) : 0,
        rewards: def.loot.map((loot) => loot.name),
        zombieRewards: epicZombieRewardNotes(def, assets.quests),
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
  if (economy) economy.onEpicBossState = (run) => {
    const previous = state.epicBossRun;
    state.setEpicBossRun(run ?? null);
    if (run && previous?.runId === run.runId && run.tokenCount > (previous.tokenCount ?? 0)) {
      const def = epicBossById(run.bossId);
      const spot = latestBossTokenHarvest ?? { x: actor.container.x, y: actor.container.y };
      if (def) popBossToken(spot.x, spot.y, def.id, def.portrait);
      latestBossTokenHarvest = null;
      hud.showToast("You found a Boss Token!");
      audio.play("xp");
    }
    syncEpicBossUi();
  };
  hud.onActivateEpicBoss = async (bossId) => {
    if (epicBoss.isActive(state.epicBossRun)) return false;
    const def = selectEpicBoss(bossId);
    if (auth.isSignedIn()) {
      try {
        await economy?.settleBeforeDependency();
        const activated = await api.epicBossActivate(crypto.randomUUID(), def.id);
        economy?.adoptEpicBossActivation(activated.event, activated.balance);
        state.setEpicBossRun(activated.event);
        syncEpicBossUi();
        saveManager.flush();
        audio.play("buy");
        return true;
      } catch (error) {
        const code = errCode(error);
        hud.showToast(code === "insufficient_brains" ? `You need ${def.costBrains} brains.`
          : code === "gameplay_unavailable" || code === "offline" ? "Reconnecting to the farm serverâ€¦"
          : "The Epic Boss event could not be started.");
        return false;
      }
    }
    if (!state.spendBrains(def.costBrains, "epic_boss_activate")) return false;
    state.setEpicBossRun(epicBoss.activate(crypto.randomUUID()));
    syncEpicBossUi();
    saveManager.flush();
    audio.play("buy");
    return true;
  };
  hud.onEndEpicBoss = async () => {
    const run = epicRun();
    if (!run || !epicBoss.isActive(run)) return false;
    if (auth.isSignedIn()) {
      try {
        await economy?.settleBeforeDependency();
        const ended = await api.epicBossEnd(run.runId);
        state.setEpicBossRun(ended.event);
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
  // Emit the quest events a raid WIN produces: the invasion itself, each looted
  // item, and a "perfect game" when nobody fell. Object names match the quest data
  // (raid name / loot item name), so invasion/loot quests advance.
  const postRaidWinQuests = (view: RaidResultView, raidName: string) => {
    if (!view.win) return;
    questBus.post(QuestEvent.InvasionSuccessful, raidName, 1);
    if (view.zombiesLost === 0) questBus.post(QuestEvent.InvasionPerfectGame, raidName, 1);
    for (const drop of view.loot) questBus.post(QuestEvent.LootItemWon, drop.name, 1);
  };

  // ---- Tim Buckwheat guided tutorial (first-run) ----
  // A DOM overlay layer that leads the player through the core farm loop. It
  // coexists with the quest rail (subscribes to the same questBus, polls live
  // state) and mutates no gameplay systems. See src/tutorial/.
  // `raidActive` is declared here (ahead of the raid block below) so the tutorial's
  // isRaidActive() closure reads an already-initialised binding; the raid launch
  // handler assigns it.
  let raidActive = false;
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
  hud.getProfiles = () => profiles.listProfiles();
  // Flush the current game to its (still-active) profile, then STOP saving before
  // moving the active pointer — otherwise this page's beforeunload/autosave would
  // write the outgoing game into the profile we're switching into. The reload
  // then loads the target profile cleanly (fresh, for a brand-new one).
  hud.onSwitchProfile = (id) => {
    saveManager.save();
    saveManager.suspend();
    profiles.setActive(id);
    location.reload();
  };
  hud.onCreateProfile = (name) => {
    saveManager.save();
    saveManager.suspend();
    profiles.setActive(profiles.createProfile(name)); // fresh (no save) → new game on reload
    location.reload();
  };
  hud.onRenameProfile = (id, name) => profiles.renameProfile(id, name);
  hud.onDeleteProfile = (id) => profiles.deleteProfile(id);

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

  hud.onlineAvailable = () => auth.isOnlineAvailable();
  hud.socialOnline = () => auth.isSignedIn();
  hud.myAccount = () => {
    const s = api.getSession();
    return s ? { name: api.displayName(s), friendCode: s.friendCode } : null;
  };
  hud.refreshAccount(); // now that myAccount is wired, show the real name in the nameplate
  hud.renderAuthButton = (el) => void auth.renderSignInButton(el);
  hud.onSignOut = () => {
    saveManager.save(); // flush latest to the server first
    void economy?.flush(); // and any pending currency events (outbox survives anyway)
    saveManager.suspend();
    auth.signOut();
    location.reload(); // back to the sign-in gate
  };
  hud.onSetUsername = async (name) => {
    try {
      await api.setUsername(name);
      hud.refreshAccount();
      return null;
    } catch (e) {
      return errCode(e);
    }
  };
  hud.refreshFriends = async () => {
    const list = await api.getFriends();
    state.friends = list.map(api.toFriend); // server list becomes the cache
  };
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
      await api.sendGift(friendId);
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
    if (auth.isSignedIn()) await api.removeFriendOnline(id);
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
  hud.onClaimGift = async (id) => {
    try {
      await economy?.settleBeforeDependency();
      const r = await api.claimGift(id);
      // Adopt the server's current rev so our next autosave isn't rejected as stale.
      saveManager.syncRev(r.rev);
      // The brain was credited to the server-owned BALANCE (not the save blob), so
      // refresh the economy to reflect it. If the economy layer isn't active
      // (shouldn't happen when signed in), no brain is shown until the next sync.
      await economy?.refreshAuthoritative();
      await hud.refreshInbox?.();
    } catch (e) {
      hud.showToast("Couldn't claim that gift.");
      console.warn("[gift] claim failed", errCode(e));
    }
  };

  // (Sign-in is handled by the pre-game gate; sign-out reloads via onSignOut.)

  // On boot, if signed in, renew the access token (keeps a long-lived tab fresh
  // against the shorter session TTL) and surface any waiting gifts / friend
  // requests with a gentle toast.
  if (auth.isSignedIn()) {
    // Bootstrap already supplied session gameplay/social summaries. Full friend
    // and inbox data remains on-demand when those menus open.
    void hud.refreshInbox?.().then(() => {
      const n = hud.getInbox?.().length ?? 0;
      if (n) hud.showToast(`You have ${n} gift${n === 1 ? "" : "s"} waiting! 🎁`);
    });
    void hud.refreshRequests?.().then(() => {
      const n = hud.getRequests?.().length ?? 0;
      if (n) hud.showToast(`You have ${n} friend request${n === 1 ? "" : "s"}! 👋`);
    });
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

  hud.getRaidBoosts = (raidId) => ({
    concentration: raids.concentrationCount(),
    dice: raids.diceCount(),
    maxDice: raids.maxDiceFor(raidId),
  });

  // Live battle scene — the ONLY way a raid is played out (no instant/auto-resolve in
  // the game; `raids.start` remains only for the `ZF.runRaid` dev hook + headless tests).
  // `raidActive` gates farm input synchronously (the scene loads its textures async);
  // `raidScene` is the running scene once ready.
  let raidScene: RaidScene | null = null;
  hud.onLaunchEpicBoss = async (partyIds, payment) => {
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
    if (auth.isSignedIn()) {
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
        economy?.adoptEpicBossActivation(opened.event, opened.balance);
        state.setEpicBossRun(opened.event);
      } catch (error) {
        const code = errCode(error);
        if (code === "insufficient_tokens") hud.showToast("You need a Boss Token.");
        else if (code === "insufficient_brains") hud.showToast(`You need ${EPIC_BOSS_FIGHT_BRAIN_COST} brains.`);
        else if (code === "battle_in_progress") hud.showToast("Another battle is already in progress.");
        else if (code === "bad_roster") hud.showToast("One of those zombies is unavailable. Please choose your army again.");
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
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true);
    audio.enterRaid(setup.raid.music);
    RaidScene.create(app, {
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
      bossAnimations: def.animations,
      bossFallsFromSky: true,
      bossEngageDistance: 150,
      // Loco Locust sits low inside his generously padded animation cells. Lift his
      // whole token slightly so the visible character shares the other bosses' line.
      bossGroundOffset: { x: 32, y: def.id === "loco-locust" ? 8 : 24 },
      confirmRetreat: () => hud.confirmInGame(
        "Retreat from battle?", `This attempt will end and ${def.name} will escape.`, "Retreat"
      ),
      onFinish: (outcome, finalTick, inputs) => {
        const presentResult = (result: ReturnType<EpicBossManager["finish"]>, drops: { name: string; icon: string }[]) => {
        state.setEpicBossRun(result.run);
        const currency = result.defeatedLevel === null
          ? { brains: 0, gold: 0 }
          : epicBossCurrencyReward(result.defeatedLevel);
        if (result.defeatedLevel !== null && !auth.isSignedIn()) {
          state.addBrains(currency.brains, "epic_boss_victory");
          state.addGold(currency.gold, "epic_boss_victory");
          questBus.post(QuestEvent.EpicStageEnemyDefeated, String(result.defeatedLevel), 1);
          const collected = new Set([...state.received, ...state.ownedPets.map((key) =>
            def.loot.find((loot) => loot.stageActor === key)?.name ?? key)]);
          const loot = rollEpicBossLoot(def, result.defeatedLevel, collected);
          if (loot) {
            if (loot.stageActor) state.unlockPet(loot.stageActor);
            else state.receiveItem(loot.name);
            questBus.post(QuestEvent.EpicBossEpicItemWon, loot.name, 1);
            drops.push({ name: loot.name, icon: epicAsset(def, def.lootIcon) });
          }
        }
        saveManager.flush();
        syncEpicBossUi();
        const view: RaidResultView = {
          win: result.defeatedLevel !== null,
          title: result.completed ? "EPIC BOSS DEFEATED" : result.defeatedLevel !== null ? "LEVEL CLEARED" : "BOSS ESCAPED",
          enemiesBeaten: result.defeatedLevel !== null ? 1 : 0,
          zombiesLost: outcome.losses.length,
          gold: currency.gold, brains: currency.brains, xp: 0, loot: drops, abilityUnlock: "",
        };
        hud.openRaidResult(view, () => {
          if (raidScene) { app.stage.removeChild(raidScene.container); raidScene.destroy(); raidScene = null; }
          raidActive = false;
          world.visible = true;
          hud.setRaiding(false);
          audio.exitRaid();
        });
        };
        if (auth.isSignedIn() && epicSessionId) {
          void finishEpicBossOnline(epicSessionId, finalTick, inputs).then((server) => {
            zombies.recordInvasion(server.survivors);
            zombies.removeCasualties(server.losses);
            for (const unit of server.newZombies) {
              zombies.grantReward(unit.key, walk.tile.col, walk.tile.row, unit.id, unit.stored);
              hud.showToast(`${zombieDefs.get(unit.key)?.name ?? "Epic reward zombie"} joined your ${unit.stored ? "Mausoleum" : "farm"}!`);
            }
            economy?.adoptEpicBossResult(server);
            void economy?.refreshAuthoritative();
            state.setEpicBossRun(server.event);
            const result = {
              run: server.event,
              defeatedLevel: server.defeatedLevel,
              completed: !!server.event.completedAt,
              escaped: server.escaped,
            };
            presentResult(result, server.loot ? [{ name: server.loot.name, icon: epicAsset(def, def.lootIcon) }] : []);
          }).catch(() => {
            hud.showToast("The fight result could not be verified. Reconnecting will recover it.");
            if (raidScene) { app.stage.removeChild(raidScene.container); raidScene.destroy(); raidScene = null; }
            raidActive = false; world.visible = true; hud.setRaiding(false); audio.exitRaid();
          });
          return;
        }
        zombies.recordInvasion(outcome.survivors);
        zombies.removeCasualties(outcome.losses);
        const result = epicBoss.finish(paidRun, outcome.playerDamage, outcome.win);
        presentResult(result, []);
      },
    }).then((scene) => {
      if (!raidActive) return scene.destroy();
      raidScene = scene;
      app.stage.addChild(scene.container);
    });
    return true;
  };
  // Server-owned raid cooldown: the session id from /raid/start, carried to
  // /raid/finish so the server starts the cooldown once the raid is done.
  let raidSessionId: string | null = null;
  hud.onLaunchRaid = async (raidId, partyIds, opts) => {
    if (raidActive || Date.now() < raidLaunchLockedUntil) return false;
    raidSessionId = null;
    // ONLINE: the server owns the between-raids cooldown. Ask it to authorize the
    // launch; if it's still on cooldown (and no voucher bypass), decline so the army
    // screen stays up. On success beginRaid runs with serverAuthorized so it doesn't
    // re-gate the (now server-owned) cooldown.
    if (auth.isSignedIn()) {
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
          Math.max(0, Math.floor(opts.dice ?? 0))
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
          } else {
            const mins = Math.ceil((gate.cooldownRemaining ?? 0) / 60000);
            hud.showToast(`Invasion on cooldown — about ${mins} min left.`);
          }
          return false;
        }
        raidSessionId = gate.sessionId ?? null;
        raidLaunchLockedUntil = Math.max(
          raidLaunchLockedUntil,
          gate.earliestFinishAt ?? Date.now() + 15_000
        );
        if (gate.inventory) economy?.adoptRaidStartInventory(gate.inventory);
        if (gate.lastRaidAt != null) state.syncRaidCooldown(gate.lastRaidAt);
        opts = { ...opts, serverAuthorized: true, bypassed: !!gate.bypassed, serverDice: gate.dice ?? 0 };
      } catch (error) {
        if (error instanceof api.ApiError) {
          const body = (error.body ?? {}) as { cooldownRemaining?: number; unlockLevel?: number };
          if (error.code === "cooldown") {
            hud.showToast(`Invasion on cooldown — about ${Math.ceil((body.cooldownRemaining ?? 0) / 60000)} min left.`);
          } else if (error.code === "locked") hud.showToast(`That invasion unlocks at level ${body.unlockLevel ?? "?"}.`);
          else if (error.code === "raid_in_progress") hud.showToast("Another invasion is already in progress.");
          else if (error.code === "no_voucher") hud.showToast("No Invasion Voucher to skip the cooldown.");
          else hud.showToast("The server could not start that invasion.");
        } else hud.showToast("Gameplay is paused until the server reconnects.");
        return false;
      }
    }
    const setup = raids.beginRaid(raidId, partyIds, opts);
    // Offline play has no server timestamp, but uses the same gentle relaunch delay.
    if (setup && !auth.isSignedIn()) raidLaunchLockedUntil = Date.now() + 15_000;
    if (!setup) return false; // gated (cooldown/army) — the army screen stays up
    raidActive = true;
    world.visible = false;
    hud.setRaiding(true); // battle scene takes over the screen
    audio.enterRaid(setup.raid.music); // swap farm bed for this stage's battle BGM
    RaidScene.create(app, {
      raid: setup.raid,
      assets,
      playerUnits: setup.playerUnits,
      enemyUnits: setup.enemyUnits,
      bossThrow: setup.bossThrow,
      bossSpecials: setup.bossSpecials,
      hazard: setup.hazard,
      summonTemplate: setup.summonTemplate,
      wallTemplate: setup.wallTemplate,
      concentration: setup.concentration,
      confirmRetreat: () => hud.confirmInGame(
        "Retreat from invasion?", "This invasion will count as a loss.", "Retreat"
      ),
      onCheckpoint: undefined,
      onFinish: (outcome, finalTick, inputs) => {
        // ONLINE: the server prices the base win gold + first-clear XP AND rolls the
        // loot. finishRaid() credits none of it locally — it hands the reward back as
        // `serverReward`, which we submit through the balance client (POST /raid/finish).
        // That call also starts the server-owned cooldown and returns the authoritative
        // balance + lastRaidAt + the rolled drop, which the client reconciles.
        const online = auth.isSignedIn() && !!raidSessionId && !!economy;
        const view = raids.finishRaid(setup.raid, setup.party, outcome, setup.dice, online);
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
            if (res.outcome) zombies.applyServerRaidOutcome(res.outcome.survivors, res.outcome.losses);
            const drops = res.loot ? [{ name: res.loot.name, icon: raids.lootIconFor(res.loot.name) }] : [];
            hud.setRaidResultLoot(drops, res.gold);
          };
          // Submit win OR loss: a loss still finishes the session to start the cooldown.
          settlementPromise = economy!.submitRaid(sid, finalTick, inputs, outcome, {
            gold: sr?.gold ?? 0,
            xp: sr?.xp ?? 0,
          });
        } else if (auth.isSignedIn() && raidSessionId) {
          // Signed in but no balance client (shouldn't happen): report finish for the
          // cooldown only; rewards were credited locally by finishRaid above.
          const sid = raidSessionId;
          raidSessionId = null;
          void api
            .raidFinish(sid, finalTick, inputs, outcome)
            .then((r) => { state.syncRaidCooldown(r.lastRaidAt); })
            .catch(() => {});
        }
        hud.openRaidResult(view, () => {
          if (raidScene) {
            app.stage.removeChild(raidScene.container);
            raidScene.destroy();
            raidScene = null;
          }
          raidActive = false;
          world.visible = true;
          hud.setRaiding(false);
          audio.exitRaid(); // battle over — hand the farm bed back
          // Advance raid quests only now that we're back on the farm, so their
          // completion popups appear over the farm rather than the battle result.
          postRaidWinQuests(view, setup.raid.name);
          tutorial.onRaidResolved(); // finish post-win if the quest event did not

          if (!casualtyParty.length) return;
          const revivalViews = casualtyParty.map((zombie) => ({
            id: zombie.id,
            name: zombie.name,
            typeName: zombie.typeName,
            portrait: zombiePortrait(zombie.key),
          }));
          if (settlementPromise && economy) {
            // The battle is gone and the farm is visible before this event opens.
            // Settlement captured each casualty server-side, so resolving the offer
            // remains safe even if the finish response arrived after the player tapped.
            void settlementPromise.then((settled) => {
              if (!settled.revival) return;
              hud.openZombieRevival(revivalViews, settled.balance.brains, async (reviveIds) => {
                const revived = await economy!.resolveRaidRevival(settled.revival!.sessionId, reviveIds);
                const accepted = new Set(revived.revivedIds);
                zombies.reviveCasualties(casualtyParty.filter((zombie) => accepted.has(zombie.id)));
                saveManager.save();
                return true;
              });
            }).catch(() => hud.showToast("The server could not settle that invasion."));
          } else if (!auth.isSignedIn()) {
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
    }).then((scene) => {
      if (!raidActive) return scene.destroy(); // finished/aborted before load done
      raidScene = scene;
      app.stage.addChild(scene.container);
      // Debug handle — dev builds only (window.ZF doesn't exist in prod). Guarded
      // so the missing global can't throw in production.
      if (import.meta.env.DEV) {
        (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene;
      }
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
    await ensureObjectTexture(assets, def.sprite);
    if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
    hud.setPlacing(def); // enter placement mode (fires onModeChange first)
    const instanceId = storedObjectIds.get(key)?.[0];
    if (!instanceId) { hud.setPlacing(null); return; }
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
      const boost = assets.boosts.find((b) => b.name === entry);
      if (boost)
        return { index, name: entry, icon: `${BASE}assets/boosts/${boost.icon}`, kind: "boost", actionLabel: "Claim" };
      const drop = assets.drops[entry];
      if (drop?.brains)
        return { index, name: entry, icon: BASE + "assets/ui/topbar_brain_icon.png", kind: "brains", actionLabel: "Claim" };
      const pdef = receivedDef(entry);
      const dropArt = drop?.icon ? lootImage(drop.icon) : "";
      if (pdef)
        return { index, name: entry, icon: dropArt || `${BASE}assets/objects/${pdef.sprite}`, kind: "placeable", actionLabel: "Place" };
      return { index, name: entry, icon: dropArt, kind: "trophy", actionLabel: "" };
    });
  hud.getReceived = receivedViews;

  // Claim a boost/currency reward: apply its effect, then remove it from Received.
  hud.onClaimReceived = (index) => {
    if (onlineGameplayBlocked()) return;
    const entry = state.received[index];
    if (entry == null) return;
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
    await ensureObjectTexture(assets, def.sprite);
    if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
    hud.setPlacing(def);
    receiving = index; // arm after setPlacing so onModeChange doesn't clear it
  };

  // The object currently being relocated by the Move tool (null = none). `flipped`
  // tracks its orientation so rotating mid-carry survives the drop.
  let carrying: { id: string; def: PlaceableDef; flipped: boolean } | null = null;
  const cancelCarry = () => {
    carrying = null;
    field.hideObjectCursor();
  };

  // Orientation for the placement ghost (Rotate tool flips it on the vertical axis),
  // remembered across taps so a whole fence run can be laid facing the same way.
  let placeFlipped = false;

  // The Rotate tool is context-sensitive: while placing it spins the ghost, while
  // carrying (Move) it spins the carried object, and otherwise it toggles a
  // standalone rotate mode (tap any placed object to flip it). This keeps a single
  // button meaning "rotate whatever I'm working with" in every situation.
  const rotateCurrent = () => {
    if (hud.mode === "place" && hud.placing) {
      placeFlipped = !placeFlipped;
      field.setGhostFlip(placeFlipped);
    } else if (hud.mode === "move" && carrying) {
      carrying.flipped = !carrying.flipped;
      field.setGhostFlip(carrying.flipped);
    } else {
      hud.setMode("rotate");
    }
  };
  hud.onRotateTool = rotateCurrent;

  // Place the selected object at the pointer tile if the footprint is valid,
  // unlocked, and affordable. Stays in placement mode to place several.
  const tryPlaceObject = (col: number, row: number) => {
    const def = hud.placing;
    if (!def) return;
    if (def.storageSlots && field.shedId()) return; // only one shed on the farm
    if (def.zombieStorage && field.mausoleumId()) return; // only one Mausoleum
    if (def.zombiePatch && field.patchId()) return; // only one Zombie Patch
    if (def.graveColor && field.hasGrave(def.graveColor)) return; // only one of each grave
    if (def.plowFree && field.hasPlowFree()) return; // only one Plowing Monolith
    if (def.fastWork && field.hasFastWork()) return; // only one Speed Monolith
    if (def.mutantMonolith && field.hasMutantMonolith()) return; // only one Mutant Monolith
    if (def.combineFast && field.hasCombineMonolith()) return; // only one Clay Monolith
    if (def.zombiePot && field.zombiePotCount() >= 3) {
      hud.showToast("You can place at most 3 Zombie Pots.");
      return;
    }
    const { oc, or } = field.resolveObjectOrigin(def, col, row);
    if (!field.canPlaceObject(oc, or, def)) return;
    // Retrieving a stored item: already owned, so it's free and places just one.
    if (retrieving) {
      field.placeObject(def, oc, or, retrieving.instanceId, undefined, placeFlipped);
      audio.play("place");
      if (def.armyMax) state.addZombieMax(def.armyMax); // re-apply functional effect
      state.retrieveItem(retrieving.key);
      economy?.submitObjectStatus(retrieving.instanceId, "placed");
      const ids = storedObjectIds.get(retrieving.key) ?? [];
      storedObjectIds.set(retrieving.key, ids.filter((id) => id !== retrieving!.instanceId));
      retrieving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    // Placing a Received reward: also free, consumed from the Received bucket.
    if (receiving !== null) {
      const receivedIndex = receiving;
      const itemName = state.received[receivedIndex];
      const placedId = field.placeObject(def, oc, or, undefined, undefined, placeFlipped);
      if (!placedId || !itemName) return;
      if (economy && !economy.submitStorageClaim(itemName, { localObjectId: placedId })) {
        field.removeObject(placedId);
        return;
      }
      audio.play("place");
      if (def.armyMax) state.addZombieMax(def.armyMax);
      state.takeReceivedAt(receivedIndex);
      receiving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    if (state.level < def.level) return;
    // The Zombie Pot costs 500 GOLD for the first, then a flat 30 BRAINS for every
    // one after — permanently, even if the player sells it (see zombiePotBought).
    const potBought = !!def.zombiePot && state.zombiePotBought;
    const cost = def.zombiePot ? (potBought ? 30 : 500) : def.cost;
    const useBrains = def.zombiePot ? potBought : def.brainsNeeded;
    const xp = buyXp(cost, def.xp); // buying always rewards XP (economy.ts)
    // Server-owned object buy (online, non-Pot, priced): the server debits the cost +
    // grants xp + records ownership so the object is later refundable. The Zombie Pot
    // (dynamic 500/30 pricing) and free/promo objects stay on the local path.
    const serverObject = !!economy && !def.zombiePot && cost > 0;
    if (serverObject) {
      const have = useBrains ? state.brains : state.gold;
      if (have < cost) return; // optimistic affordability; server re-checks
    } else {
      const paid = useBrains ? state.spendBrains(cost) : state.spendGold(cost);
      if (!paid) return;
      state.addXp(xp);
    }
    if (def.zombiePot) state.markZombiePotBought(); // next pot is 30 brains forever
    const placedId = field.placeObject(def, oc, or, undefined, undefined, placeFlipped);
    if (serverObject && placedId) {
      economy!.submitObject(
        { type: "buy", key: def.key, instanceId: placedId },
        useBrains ? { brains: -cost, xp } : { gold: -cost, xp }
      );
    }
    audio.play("place");
    if (def.armyMax) state.addZombieMax(def.armyMax); // functional effect
    if (def.storageSlots) state.upgradeStorage(def.storageSlots); // shed capacity
    const c = tileCenter(col, row);
    floatText(c.x, c.y, `-${cost}${useBrains ? "b" : "g"}  +${xp}xp`);
    questBus.post(QuestEvent.ItemBought, def.name);
  };

  // Move tool: first tap lifts the object under the pointer; next valid tap drops
  // it. Invalid drop keeps it carried; right-click / tool-switch cancels.
  const handleMoveTap = (col: number, row: number, wx: number, wy: number) => {
    if (carrying) {
      const { oc, or } = field.resolveObjectOrigin(carrying.def, col, row);
      if (field.moveObject(carrying.id, oc, or, carrying.flipped)) cancelCarry();
    } else {
      const id = field.objectAtPoint(wx, wy);
      const def = id ? field.objectDefOf(id) : null;
      if (id && def) {
        carrying = { id, def, flipped: field.objectFlipOf(id) };
        field.setObjectCursor(def, col, row, id, carrying.flipped);
      }
    }
  };

  // The gold/brains refunded when selling a placed object (see economy.ts —
  // significantly less than the purchase price).
  const sellRefund = (def: PlaceableDef) => sellBack(def.cost);

  // Sell a placed object for a refund (used by the Remove tool + object popup).
  const sellObject = (id: string) => {
    if (onlineGameplayBlocked()) return;
    const def = field.objectDefOf(id);
    const o = field.objectOriginOf(id);
    field.removeObject(id);
    if (!def || !o) return;
    audio.play("sell");
    if (def.armyMax) state.addZombieMax(-def.armyMax); // reverse functional effect
    const refund = sellRefund(def);
    // Server-owned object refund (online, non-Pot, priced): the server credits the
    // refund only for an object it recorded you owning. The optimistic credit matches
    // (both = floor(cost*0.2)), so it reconciles cleanly; a legacy object the server
    // doesn't know is rejected and the optimistic credit is dropped.
    const serverObject = !!economy && !def.zombiePot && def.cost > 0;
    if (serverObject) {
      economy!.submitObject({ type: "refund", key: def.key, instanceId: id }, def.brainsNeeded ? { brains: refund } : { gold: refund });
    } else if (def.brainsNeeded) {
      state.addBrains(refund);
    } else {
      state.addGold(refund);
    }
    const c = tileCenter(o.oc, o.or);
    floatText(c.x, c.y, `+${refund}${def.brainsNeeded ? "b" : "g"}`);
  };

  // Store a placed object in the shed (returns it to inventory for free re-placing
  // later). Reverses any functional effect; the shed must have a free slot.
  const storeObject = (id: string) => {
    if (onlineGameplayBlocked()) return;
    const def = field.objectDefOf(id);
    if (!def) return;
    if (!state.storeItem(def.key)) return; // shed full
    if (def.armyMax) state.addZombieMax(-def.armyMax); // reverse functional effect
    field.removeObject(id);
    const storedIds = storedObjectIds.get(def.key) ?? [];
    storedIds.push(id);
    storedObjectIds.set(def.key, storedIds);
    economy?.submitObjectStatus(id, "stored");
  };

  // Can this object be stored in the shed? Storage buildings can't; the shed
  // must have a free slot.
  const canStore = (def: PlaceableDef) =>
    !def.storageSlots && !def.zombieStorage &&
    state.storedItemTotal() < state.storageItemCap;

  // Remove tool: a placed OBJECT sells back for a 50% refund; a plowed/harvested
  // (crop-free) plot is cleared to bare ground for no money. Growing crops are
  // left alone — harvest them instead.
  const tryRemove = (col: number, row: number, wx: number, wy: number) => {
    const id = field.objectAtPoint(wx, wy);
    if (id) {
      const d = field.objectDefOf(id);
      if (d?.storageSlots || d?.zombieStorage) return; // storage buildings are movable, not sellable
      sellObject(id);
      return;
    }
    if (field.plotOriginAt(col, row) && !field.hasCrop(col, row)) {
      const origin = field.plotOriginAt(col, row);
      jobs.cancelAtTile(col, row); // drop any queued job on this plot first
      field.removePlot(col, row); // plowed/harvested plot -> bare ground, no refund
      if (origin && state.onFarm) state.onFarm({ type: "remove", oc: origin.oc, or: origin.or }, {});
    }
  };

  // These edit actions are immediate for a mouse, but touch calls this only after
  // finger-up confirms the gesture was a tap (rather than the start of a pinch).
  const performEditTap = (mode: Mode, col: number, row: number, wx: number, wy: number) => {
    if (mode === "place") tryPlaceObject(col, row);
    else if (mode === "move") handleMoveTap(col, row, wx, wy);
    else if (mode === "remove") tryRemove(col, row, wx, wy);
    else if (mode === "instagrow") tryInstaGrow(col, row, wx, wy);
    else if (mode === "rotate") {
      const id = field.objectAtPoint(wx, wy);
      if (id) { field.flipObject(id); audio.play("place"); saveManager.save(); }
    }
  };

  app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (raidActive) return; // farm input is inert during a live raid
    if (economy && !economy.available) { hud.showToast("Gameplay paused — reconnect to continue."); return; }
    if (touchPinch) return; // a pinch is in progress; ignore extra finger-downs
    if (isTouchPointer(e.pointerType) && !e.isPrimary) return;
    const touch = isTouchPointer(e.pointerType);
    pressPointerType = e.pointerType;
    pressPointerId = e.pointerId;
    pressStart.copyFrom(e.global);
    touchGestureTiles.length = 0;
    if (visiting) {
      // Read-only visit: no tools, no editing. Only start a camera pan; a tap
      // (pan that doesn't move) resolves to walk / inspect in endDrag below.
      if (e.button === 2) return;
      dragging = true;
      moved = false;
      last.copyFrom(e.global);
      return;
    }
    if (e.button === 2) { // right-click -> back to the select tool
      if (tutorial.active) return;
      cancelCarry();
      hud.setMode("walk");
      dragging = false;
      return;
    }
    const { col, row, wx, wy } = tileAt(e);
    // Tutorial world gate: while the guided tutorial is active, freeze every farm
    // tap except the current beat's target plot (so nothing collapses the menu or
    // acts out of turn). Menu/narrative beats freeze the farm entirely.
    if (tutorial.active && !tutorial.allowsTile(col, row)) return;
    hud.collapse(); // any tap on the field collapses the bars into the corner fab
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
    if (!touch && jobs.cancelAtTile(col, row)) { // tapped a queued action -> un-queue it
      dragging = false;
      return;
    }
    const queuedObjId = field.objectAtPoint(wx, wy);
    if (!touch && queuedObjId && jobs.cancelObject(queuedObjId)) {
      dragging = false;
      return;
    }
    dragging = true;
    moved = false;
    last.copyFrom(e.global);
    if (hud.mode !== "walk") {
      // Mouse preserves immediate click/drag painting. Touch waits for either a
      // confirmed tap or movement beyond its larger finger-jitter threshold.
      if (!touch) enqueueTool(col, row);
      lastPlot = touch ? "" : tileKey(col, row);
    }
  });
  app.stage.on("pointermove", (e: FederatedPointerEvent) => {
    if (raidActive) return;
    if (touchPinch) return; // pinch owns the gesture; skip pan/cursor updates
    if (dragging && e.pointerId === pressPointerId && !moved) {
      moved = gestureMoved(pressStart.x, pressStart.y, e.global.x, e.global.y, pressPointerType);
    }
    if (visiting) {
      // Read-only visit: drag pans the camera; no tool cursors are ever shown.
      if (dragging) {
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (moved) {
          world.position.x += dx;
          world.position.y += dy;
          clampCamera();
        }
        last.copyFrom(e.global);
      }
      return;
    }
    const { col, row, wx, wy } = tileAt(e);
    if (hud.mode === "place" && hud.placing) {
      field.setObjectCursor(hud.placing, col, row, undefined, placeFlipped); // ghost follows the cursor
      return;
    }
    if (hud.mode === "move") {
      if (carrying) field.setObjectCursor(carrying.def, col, row, carrying.id, carrying.flipped);
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
    if (hud.mode === "instagrow") {
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
      if (hud.mode === "walk") {
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (moved) {
          world.position.x += dx;
          world.position.y += dy;
          clampCamera(); // block panning above the sky
        }
        last.copyFrom(e.global);
      } else if (moved) {
        // Drag-paint plow/plant across the field. Touch records the stroke and
        // commits on finger-up; mouse queues each new tile immediately.
        const tk = tileKey(col, row);
        if (tk !== lastPlot) {
          if (isTouchPointer(pressPointerType)) touchGestureTiles.push({ col, row });
          else enqueueTool(col, row);
          lastPlot = tk;
        }
      }
    }
    const tool = hud.mode === "till" || hud.mode === "plant" ? hud.mode : null;
    field.setCursor(col, row, tool);
  });
  const endDrag = (e: FederatedPointerEvent) => {
    if (dragging && !moved) {
      const { col, row, wx, wy } = tileAt(e);
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
          enqueueTool(col, row);
          dragging = false;
          lastPlot = "";
          return;
        }
      }
      if (hud.mode === "walk") {
        // Select tool: clicking an owned zombie inspects it; the storage shed opens
        // Storage; a ripe fruit tree harvests for gold; else it's tile-based (same
        // clickbox as Plow) — ripe plot -> harvest; tilled plot -> plant picker;
        // spent plot -> re-till; else free-roam when idle.
        const zu = zombies.pick(wx, wy);
        if (zu) {
          zombies.select(zu);
          const d = zu.getData();
          // The zombie moans for "Brains…" (float text + a per-group audio bark).
          const wp = zu.worldPos;
          floatText(wp.x, wp.y - 44, "Brains…");
          audio.brain(d.group, d.key);
          hud.openZombieInfo({
            name: d.name, typeName: d.typeName, key: d.key, group: d.group,
            className: d.className, classColor: d.classColor,
            str: d.str * state.farmerZombieStrengthMult(), dex: d.dex,
            con: d.con * state.farmerZombieLifeMult(), focus: d.focus, mutation: d.mutation,
            invasions: d.invasions,
            portrait: zombiePortrait(d.key), // per-type composited portrait
            // Visiting a friend: inspect only — omit the id so openZombieInfo
            // renders no Deploy/Store/Sell/Locate actions on their unit.
            id: visiting ? undefined : d.id, stored: false,
          });
          dragging = false;
          lastPlot = "";
          return;
        }
        zombies.clearSelection();
        if (visiting) {
          // Read-only visit: a tap on non-zombie ground just free-roams the
          // visitor's avatar. No harvest/plant/store/object actions on their farm.
          if (!jobs.busy) walk.goToPoint(wx, wy);
          dragging = false;
          lastPlot = "";
          return;
        }
        const objId = field.objectAtPoint(wx, wy);
        const objDef = objId ? field.objectDefOf(objId) : null;
        // Signature decor (Liberty Bell, Gnome King, …) plays its own tap sound.
        if (objDef?.tapSound) audio.tap(objDef.tapSound);
        if (objId && objDef && objDef.storageSlots) {
          hud.openStorage();
        } else if (objId && objDef && objDef.petPen) {
          // The pen is an in-world shortcut to the same authoritative collection
          // used by the Pets market tab; it never grants or imports ownership.
          hud.openStorage("Pets", true);
        } else if (objId && objDef && objDef.zombieStorage) {
          hud.openMausoleum(); // the Mausoleum's storage slots
        } else if (objId && objDef && objDef.zombiePatch) {
          // Tap the Zombie Patch: call all zombies to nap, or wake them.
          const napping = zombies.toggleGather(field.patchRestTiles());
          const wp = field.objectWorkPoint(objId);
          if (wp) floatText(wp.x, wp.y - 24, napping ? "Zzz…" : "Awake!");
        } else if (objId && objDef && objDef.zombiePot) {
          activePotId = objId;
          hud.openCombiner(); // pick two zombies to combine, or collect a finished one
        } else if (objId && field.isObjectReady(objId)) {
          const wp = field.objectWorkPoint(objId); // farmer walks over and hoes (fast)
          if (wp) jobs.enqueueTreeHarvest(objId, wp.x, wp.y);
        } else if (objId && objDef) {
          // A placed decoration/tree: Move / Store / Sell popup.
          const oid = objId, def = objDef;
          hud.openObjectActions({
            name: def.name,
            portrait: `${BASE}assets/objects/${def.sprite}`,
            canStore: canStore(def),
            sellRefund: sellRefund(def),
            sellBrains: !!def.brainsNeeded,
            onMove: () => {
              hud.setMode("move"); // fires onModeChange (clears carry) FIRST...
              carrying = { id: oid, def, flipped: field.objectFlipOf(oid) }; // ...then pick up this object
              const o = field.objectOriginOf(oid);
              if (o) field.setObjectCursor(def, o.oc + Math.floor((def.tileW - 1) / 2),
                o.or + Math.floor((def.tileH - 1) / 2), oid, carrying.flipped);
            },
            onRotate: () => { field.flipObject(oid); saveManager.save(); },
            onStore: () => storeObject(oid),
            onSell: () => sellObject(oid),
          });
        } else if (field.isRipe(col, row)) {
          // Harvesting a ripe zombie crop grows an owned unit — refuse at army cap.
          if (field.ripeZombieAt(col, row) && !zombies.canAdd()) {
            const c = tileCenter(col, row);
            floatText(c.x, c.y, "Army full!");
          } else {
            jobs.enqueue("harvest", col, row);
          }
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
          jobs.enqueue("till", col, row); // re-till a harvested dirt/hole plot
        } else if (!jobs.busy) {
          walk.goToPoint(wx, wy); // free-roam only when idle; not a queued job
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
    if (dragging && moved && isTouchPointer(pressPointerType) &&
        (hud.mode === "till" || hud.mode === "plant")) {
      for (const tile of touchGestureTiles) enqueueTool(tile.col, tile.row);
    }
    endDrag(e);
    pressPointerId = -1;
    touchGestureTiles.length = 0;
  };
  app.stage.on("pointerup", onPointerUp);
  app.stage.on("pointerupoutside", onPointerUp);
  app.stage.on("pointercancel", cancelPointerGesture);
  window.addEventListener("blur", cancelPointerGesture);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelPointerGesture();
  });

  // Right-click anywhere returns to the select tool (and suppress the browser menu).
  app.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (tutorial.active) return;
    hud.setMode("walk");
  });

  // Hide the tool cursor when switching tools (and drop any carried object);
  // next pointer move re-shows the right cursor.
  hud.onModeChange = () => {
    field.hideCursor();
    field.setObjectHighlight(null);
    zombies.clearSelection();
    cancelCarry();
    if (hud.mode !== "place") retrieving = null; // leaving placement drops a pending retrieve
    if (hud.mode !== "place") receiving = null; // ...and a pending Received placement
    if (hud.mode !== "place") placeFlipped = false; // and reset the ghost orientation
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

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05);
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
    if (raidScene) raidScene.update(dt); // live battle drives itself; farm still ticks behind
    jobs.update(dt); // may start a walk-to-plot / hoe cycle for the farmer
    walk.update(dt);
    petActor?.update(dt, actor.container.x, actor.container.y);
    const penBounds = field.petPenBounds();
    for (const pet of penPetActors) {
      pet.container.visible = !!penBounds;
      if (penBounds) pet.updateInPen(dt, penBounds);
    }
    zombies.update(dt);
    field.updatePetPenOcclusion(
      penPetActors.map((pet) => pet.container),
      [actor.container, ...zombies.characterContainers(), ...(petActor ? [petActor.container] : [])],
    );
    field.update(dt);
    // Farmer's lantern follows him (raised onto his body), lit only at night.
    if (isNight) {
      const lx = actor.container.x, ly = actor.container.y - 34;
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
      f.ttl -= dt;
      f.t.y -= 26 * dt;
      f.t.alpha = Math.min(1, f.ttl);
      if (f.ttl <= 0) {
        world.removeChild(f.t);
        f.t.destroy();
        floats.splice(i, 1);
      }
    }
  });

  // When the tab returns to the foreground after being backgrounded, the render loop
  // has been throttled/paused so on-screen crop growth is stale until the next frame.
  // Growth itself is wall-clock based (Field derives crop age from plantedAt), so a
  // single update(0) snaps every crop to its true current stage right away instead of
  // waiting on the first (possibly delayed) rAF tick, then we persist the fresh state.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    field.update(0);
    saveManager.save();
  });

  // Live game-state handle + mutation helpers for local testing (instant raids,
  // boost grants, zombie spawning, placement, combine, raid wins). DEV BUILDS
  // ONLY: `import.meta.env.DEV` is statically false in production, so Vite
  // tree-shakes this entire object — and the helpers it closes over — out of the
  // shipped bundle. It was never a security boundary (a determined player can edit
  // browser state regardless), but it must not be handed to every player. Real
  // integrity comes from server-side validation/authority.
  if (import.meta.env.DEV) (window as any).ZF = { app, world, field, actor, walk, zombies, state, hud, jobs, audio, save: saveManager, quests, questBus, raids, screenToGrid, CARROT,
    placeables: placeCatalog,
    boosts: boostCatalog,
    // Instantly resolve a raid for testing (e.g. ZF.runRaid(1) with 8+ zombies).
    runRaid: (id: number) => raids.start(id, raids.partyView().defaultSelectedIds),
    // Grant a boost for testing (e.g. ZF.giveBoost("instaGrow", 3)).
    giveBoost: (key: string, n = 1) => state.addBoost(key, n),
    // Mark a tier boss beaten so its abilities unlock across the roster.
    winRaid: (tier: number) => state.completeRaid(String(tier)),
    // Debug: place a catalog object by key (loads its texture first).
    place: async (key: string, oc: number, or: number) => {
      const def = placeCatalog.get(key);
      if (!def) return null;
      await ensureObjectTexture(assets, def.sprite);
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
    // Collect a finished combine onto the farmer's tile (or storage if capped).
    collectCombine: () => {
      const pending = zombies.combinePot.pending;
      const object = pending
        ? [zombieDefs.get(pending.keyA)?.name ?? "", zombieDefs.get(pending.keyB)?.name ?? ""].filter(Boolean).sort().join(" ")
        : "";
      const z = zombies.collectCombine(walk.tile.col, walk.tile.row);
      if (z) {
        if (object) questBus.post(QuestEvent.CombinerCombined, object);
        questBus.post(QuestEvent.CombinerHarvested, z.typeName);
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
  // "Click to Start". The player's tap dismisses the overlay to reveal the farm.
  boot?.ready();
}

main().catch((err) => {
  console.error(err);
  boot?.fail(); // drop the start screen so the error below is visible
  const hud = document.getElementById("hud");
  if (hud) hud.innerHTML = `<b style="color:#ffb0b0">Error:</b> ${err}`;
});
