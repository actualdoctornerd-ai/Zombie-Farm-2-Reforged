import { Application, Container, FederatedPointerEvent, Graphics, Point, Sprite, Text } from "pixi.js";
import { loadAssets, ensureObjectTexture, PlaceableDef, BoostDef, SEED_FILE, ZombieDef, zombiePortrait, ZOMBIE_STAGES, lootImage } from "./assets";
import { Field, CARROT, CropConfig } from "./Field";
import { Actor } from "./Actor";
import { WalkController } from "./WalkController";
import { ZombieField } from "./zombie/ZombieField";
import { POT_DURATION_MS } from "./zombie/ZombiePot";
import { GameState } from "./GameState";
import { Hud, graveNeededFor, LevelUpUnlock, ReceivedView } from "./hud";
import { JobSystem } from "./JobSystem";
import { AudioManager } from "./audio";
import { SaveManager } from "./save/SaveManager";
import * as profiles from "./save/profiles";
import * as api from "./net/api";
import * as auth from "./net/auth";
import { QuestBus, QuestEvent } from "./quest/events";
import { QuestSystem } from "./quest/QuestSystem";
import { RaidManager, RaidResultView } from "./raid/RaidManager";
import { RaidScene } from "./raid/RaidScene";
import { RAID_COOLDOWN_MS } from "./raid/RaidCatalog";
import { screenToGrid, tileCenter, TILE_H, TILE_W, HW, HH } from "./iso";
import { setFootprint } from "./depthSort";
import { NightLayer, makeLight } from "./lighting";
import { buyXp, sellBack, zombieSellValue } from "./economy";
import { isFastMode, setFastMode } from "./devSettings";
import { BASE } from "./base";
import { initPlatform } from "./platform";

async function main() {
  // Detect device up front so <html data-platform> is set before the HUD's CSS
  // renders (drives the compact/desktop layout; re-evaluates on resize/rotate).
  initPlatform();
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
  const state = new GameState();
  const audio = new AudioManager(); // music/SFX default off (toggled in Settings)
  const hud = new Hud(state, audio);

  // Build the plant/zombie picker catalog from the market data. Cards show the
  // real grow time, but actual growth is scaled down so crops finish while playing.
  const fmtTime = (ms: number) => {
    const s = ms / 1000;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };
  // Runtime grow time. Source grow times are hours/days; for playtesting we scale
  // them down to 8-45s. Fast Mode (Settings → Developer) drives this; it's ON by
  // default and can be turned off for real times. See devSettings.ts.
  // Cards always display the REAL time (fmtTime on the source growMs) either way.
  const FAST_GROW = isFastMode();
  const scaleGrow = (ms: number) =>
    FAST_GROW ? Math.max(8000, Math.min(45000, ms / 60)) : ms;

  // Catalog: crop key -> config, shared by the picker (hud) and save/load (to
  // rebuild planted crops from their saved key). Seed it with the quick-plant CARROT.
  const catalog = new Map<string, CropConfig>();
  catalog.set(CARROT.key, CARROT);
  const plantCards = assets.plants.map((p) => {
    const cfg: CropConfig = {
      key: p.key, name: p.name, stages: [SEED_FILE, p.stage1, p.stage2],
      growMs: scaleGrow(p.growMs), cost: p.cost, sell: p.sell, xp: p.xp,
      unlockLevel: p.level,
    };
    catalog.set(cfg.key, cfg);
    return {
      name: p.name, cost: p.cost, sell: p.sell, timeLabel: fmtTime(p.growMs),
      level: p.level, portrait: `${BASE}assets/crops/${p.stage2}`, cfg,
    };
  });
  // Zombie type catalog by key, so a harvested zombie crop can look up its full
  // def (stats + taxonomy) to spawn the matching owned unit.
  const zombieDefs = new Map<string, ZombieDef>();
  for (const z of assets.zombies) zombieDefs.set(z.key, z);
  const zombieCards = assets.zombies.map((z) => {
    const cfg: CropConfig = {
      key: z.key, name: z.name,
      // Zombie crop growth: wooden cross -> hand -> clawing up -> risen (thumb up).
      stages: ZOMBIE_STAGES,
      growMs: scaleGrow(z.growMs), cost: z.cost, brainsNeeded: z.brainsNeeded, sell: 0, xp: z.xp,
      unlockLevel: z.level, isZombie: true, isMutant: z.category === "mutant",
      unlockGrave: graveNeededFor(z.className) ?? undefined, // Blue/Red/Silver graves gate planting
    };
    catalog.set(cfg.key, cfg);
    return {
      name: z.name, cost: z.cost, brains: z.brainsNeeded, timeLabel: fmtTime(z.growMs), level: z.level,
      category: z.category,
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
    if (o.growMs) o.growMs = scaleGrow(o.growMs);
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
    const BAND = 10; // foliage only within this many tiles of the farm
    for (let c = -11; c <= field.w + 10; c += 3) {
      for (let r = -11; r <= field.h + 10; r += 3) {
        const jc = c + (rnd() - 0.5) * 1.8; // jitter off the lattice
        const jr = r + (rnd() - 0.5) * 1.8;
        const d = distOutside(jc, jr);
        const inBand = d >= MARGIN && d <= BAND;
        const sparse = rnd(); // consume RNG evenly so accepted set is stable
        const density = d < 5 ? 0.24 : 0.36;
        // Close to the farm: low shrubs only; farther out: allow full-height trees.
        const isTree = d >= 4.5 && rnd() < (d >= 7 ? 0.5 : 0.32);
        const tex = isTree ? assets.scenery[0] : assets.scenery[1 + Math.floor(rnd() * 3)];
        const s = objScale * (isTree ? 0.7 + rnd() * 0.25 : 0.55 + rnd() * 0.3);
        if (!inBand || sparse > density) continue;
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1);
        sp.scale.set(s);
        const p = tileCenter(jc, jr);
        sp.position.set(p.x, p.y);
        // Point footprint on its tile so it depth-sorts with trees/actors.
        const fc = Math.round(jc), fr = Math.round(jr);
        setFootprint(sp, fc, fr, fc, fr);
        field.entityLayer.addChild(sp);
        foliage.push(sp);
      }
    }
  };

  const actor = new Actor(assets);
  field.entityLayer.addChild(actor.container);

  const start = assets.field.start;
  const walk = new WalkController(actor, field, start.col, start.row);

  // Owned zombies (Phase 3): grown from harvested zombie crops, they wander the
  // farm (routing around objects) and can be selected to inspect their stats.
  const zombies = new ZombieField(assets, field, state, (key) => zombieDefs.get(key));

  // Night lighting layer: a dark mask with the lights erased out of it (revealing
  // the daytime scene under each light — never a glare), above the farm/entities
  // but below the job labels & cursor (UI stays readable). Toggled with the N key
  // for now (a real day/night cycle comes later).
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
  window.addEventListener("keydown", (e) => {
    if (e.key === "n" || e.key === "N") setNight(!isNight);
  });

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
    buildFoliage();
    computeBounds();
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

  // Quest event bus: plow/plant/harvest/buy post notifications that the QuestSystem
  // turns into quest progress. Created before the JobSystem so farm actions can post.
  const questBus = new QuestBus();

  // The farmer's job queue (till / plant / harvest / walk). He walks to each target,
  // hoes, then the action applies; queued plots stay highlighted green until done.
  // Harvesting a zombie crop grows an owned zombie at the plot's center tile.
  const jobs = new JobSystem(
    field, actor, walk, state, floatText, (name) => audio.play(name),
    (key, oc, or) => zombies.spawn(key, oc + 1, or + 1),
    questBus,
    (oc, or) => zombies.tryFertilize(oc, or)
  );

  // The data-driven quest engine (all 96 quests from quests.json). Rewards route to
  // GameState / the roster; the HUD rail and completion toast come from `hud`.
  const quests = new QuestSystem(
    new Map(Object.entries(assets.quests)), state, questBus,
    {
      grantItem: (key) => state.receiveItem(key),
      grantZombie: (key) => zombies.spawn(key, walk.tile.col, walk.tile.row),
      toast: (msg) => hud.showToast(msg),
      render: (views) => hud.setQuests(views),
    }
  );

  // ---- consumable boosts: buy (into inventory) + use (apply farm effect) ----
  // Gift vouchers are "1 per farm": you can't buy/use one once you already own
  // that zombie OR already hold an (unused) voucher granting it. The check is keyed
  // by the RESULTING zombie, so the two Cupid vouchers (Valentine / Valentine 2012)
  // share one limit.
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

  hud.onBuyBoost = (def) => {
    if (def.effect === "gift" && giftLimitReached(def.key)) return false; // 1 per farm
    const paid = def.brainsNeeded ? state.spendBrains(def.cost) : state.spendGold(def.cost);
    if (!paid) return false;
    state.addBoost(def.key, def.perPurchase); // a purchase grants `perPurchase` uses
    audio.play("buy");
    return true;
  };
  hud.onUseBoost = (def) => {
    if (state.boostCount(def.key) <= 0) return;
    if (applyBoost(def)) state.useBoost(def.key); // consume only if it did something
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

  // The Insta-Grow tool (mode "instagrow") ripens exactly the tapped crop and
  // spends one use. A stray tap on empty/ripe ground is ignored (no wasted use).
  // When the last use is spent the tool auto-unequips back to the select tool.
  const tryInstaGrow = (col: number, row: number) => {
    const def = growBoostDef();
    if (!def) return;
    if (state.boostCount(def.key) <= 0) { hud.setMode("walk"); return; }
    if (!field.growCropAt(col, row)) return; // not a growing crop -> keep tool equipped
    state.useBoost(def.key);
    audio.play("instaGrow");
    const c = tileCenter(col, row);
    floatText(c.x, c.y, "Grew!");
    if (state.boostCount(def.key) <= 0) hud.setMode("walk"); // used up -> unequip
  };

  // Apply a farm-usable boost's effect. Returns true if it actually did anything
  // (so a no-op — e.g. Insta-Harvest with nothing ripe — doesn't waste the boost).
  const applyBoost = (def: BoostDef): boolean => {
    const c = tileCenter(walk.tile.col, walk.tile.row); // float near the farmer
    if (def.effect === "grow") {
      const n = field.growSomeCrops(def.amount || 1); // single-use: grows one crop
      if (n) { audio.play("instaGrow"); floatText(c.x, c.y, `Grew ${n}!`); }
      return n > 0;
    }
    if (def.effect === "harvest") {
      let harvested = 0;
      for (const pl of field.ripePlots()) {
        if (pl.isZombie && !zombies.canAdd()) continue; // respect the army cap
        const r = field.harvestAt(pl.oc, pl.or);
        if (!r) continue;
        if (r.sell) state.addGold(r.sell);
        state.addXp(r.xp);
        if (r.zombieKey) zombies.spawn(r.zombieKey, pl.oc + 1, pl.or + 1);
        questBus.post(r.isZombie ? QuestEvent.ZombieHarvested : QuestEvent.CropHarvested, r.name);
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
      zombies.spawn(def.giftZombieKey, walk.tile.col, walk.tile.row);
      floatText(c.x, c.y, `Got ${def.name}!`);
      return true;
    }
    if (def.effect === "refresh") {
      // Reset every stale/aging ripe crop back to fully fresh (max sell value).
      const n = field.refreshCrops();
      if (n) floatText(c.x, c.y, `Freshened ${n}!`);
      return n > 0;
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
  const restored = await saveManager.load();
  if (!restored) quests.restore(); // fresh farm: activate the opening quests
  saveManager.enableAutosave();
  console.log(restored ? "[save] restored existing farm" : "[save] fresh farm");
  // A restored farm may be a larger (upgraded) size than the 30x30 default the
  // world was first built for: re-fit the backdrop/foliage/bounds and re-clamp.
  syncWorldToFarm();
  clampCamera();

  // A brand-new farm starts with one owned zombie (matching the default count) so
  // the player has a unit to see and inspect right away; restored farms rebuild
  // their roster from the save instead.
  if (!restored && zombies.count === 0) {
    zombies.spawn("ZombieActorRegularTier1", start.col - 4, start.row - 2);
  }

  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;

  let dragging = false;
  let moved = false;
  let lastPlot = "";
  const last = new Point();

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
  const tileAtScreen = (sx: number, sy: number) => {
    const w = world.toLocal(new Point(sx, sy));
    const g = screenToGrid(w.x, w.y);
    return { col: Math.round(g.col), row: Math.round(g.row) };
  };

  {
    app.canvas.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length !== 2 || raidActive) return;
      e.preventDefault();
      touchPinch = true;
      dragging = false; // abandon any in-progress single-finger pan
      // Each finger's pointerdown may have queued a tool action before the second
      // finger arrived; undo both so a pinch never plows/plants.
      for (let i = 0; i < 2; i++) {
        const p = canvasXY(e.touches[i].clientX, e.touches[i].clientY);
        const { col, row } = tileAtScreen(p.x, p.y);
        jobs.cancelAtTile(col, row);
      }
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
  const enqueueTool = (col: number, row: number) => {
    if (hud.mode === "till") jobs.enqueue("till", col, row);
    else if (hud.mode === "plant" && hud.planting)
      jobs.enqueue("plant", col, row, hud.planting);
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
  hud.onBuyUpgrade = (size, currency) => {
    const up = assets.upgrades.mapSize.find((u) => u.size === size);
    if (!up || size <= field.w || state.level < up.level) return false;
    // Enforce sequential purchase: only the immediate next tier is buyable.
    const nextSize = Math.min(
      ...assets.upgrades.mapSize.filter((u) => u.size > field.w).map((u) => u.size)
    );
    if (size !== nextSize) return false;
    const paid = currency === "brains" ? state.spendBrains(up.brains) : state.spendGold(up.gold);
    if (!paid) return false; // insufficient funds in the chosen currency
    audio.play("buy");
    field.resize(size, size);
    syncWorldToFarm();
    clampCamera();
    saveManager.save(); // persist the new size immediately (farm.w/h)
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
  hud.onBuyClimate = (c) => {
    if (state.ownsClimate(c.terrain) || c.terrain === "grass") return false;
    if (state.level < c.level) return false;
    if (!state.spendGold(c.gold)) return false;
    state.addOwnedClimate(c.terrain);
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
    const id = field.shedId();
    if (!id) return;
    if (state.level < def.level) return;
    const paid = def.brainsNeeded ? state.spendBrains(def.cost) : state.spendGold(def.cost);
    if (!paid) return;
    audio.play("buy");
    field.replaceObjectDef(id, def);
    if (def.storageSlots) state.upgradeStorage(def.storageSlots);
    const xp = buyXp(def.cost, def.xp); // buying/upgrading always rewards XP
    state.addXp(xp);
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
  hud.onZombieStore = (id) => { if (field.mausoleumId() && !zombies.mausoleumFull) zombies.store(id); };
  hud.onZombieDeploy = (id) => zombies.deploy(id);
  hud.onZombieLocate = (id) => {
    const p = zombies.selectById(id);
    if (p) centerOn(p.x, p.y);
  };
  hud.zombieBaseCost = (key) => zombieDefs.get(key)?.cost ?? 0;
  hud.onZombieSell = (id) => {
    const z = zombies.roster().find((r) => r.id === id);
    if (!z) return;
    const value = zombieSellValue(zombieDefs.get(z.key)?.cost ?? 0);
    const p = zombies.selectById(id); // deployed unit's world pos (null if stored)
    if (!zombies.sell(id)) return; // gone already; don't credit gold
    state.addGold(value);
    if (p) floatText(p.x, p.y, `+${value}g`);
  };

  // ---- Zombie Pot (combiner) ----
  // Base combine time follows the same debug grow-scaling as crops so a combine
  // finishes while playtesting; real time is 1h (scaleGrow is a no-op in real mode).
  const potBaseMs = () => scaleGrow(POT_DURATION_MS);
  hud.getPotStatus = () => {
    const pot = zombies.combinePot;
    return {
      busy: pot.busy,
      ready: zombies.combineReady,
      remainingMs: pot.remainingMs(),
      totalMs: pot.totalMs(),
      monolith: field.hasCombineMonolith(), // Clay Monolith speeds the pot timer
      pending: pot.pending
        ? { keyA: pot.pending.keyA, keyB: pot.pending.keyB, maskA: pot.pending.maskA, maskB: pot.pending.maskB }
        : null,
    };
  };
  // The combiner quests key off the parents' / result's TYPE names (species, e.g.
  // "Carrot Zombie"), not a unit's individual name. `combineObject` joins the two
  // parents alphabetically so the event object is order-independent (matches quest
  // data like "Carrot Zombie Tomato Zombie" regardless of which slot each was in).
  const zombieTypeName = (id: string) => zombies.roster().find((z) => z.id === id)?.typeName ?? "";
  const combineObject = (idA: string, idB: string) =>
    [zombieTypeName(idA), zombieTypeName(idB)].sort().join(" ");

  hud.onCombine = (idA, idB) => {
    const object = combineObject(idA, idB); // read parents BEFORE they're consumed
    const ok = zombies.combine(idA, idB, potBaseMs());
    if (ok) {
      questBus.post(QuestEvent.CombinerCombined, object);
      saveManager.save();
    }
    return ok;
  };
  hud.onCollectCombine = () => {
    const z = zombies.collectCombine(walk.tile.col, walk.tile.row);
    if (z) {
      questBus.post(QuestEvent.CombinerHarvested, z.typeName);
      const c = tileCenter(z.col, z.row);
      floatText(c.x, c.y, z.mutation ? `${z.name}!` : z.name);
      saveManager.save();
    }
    return z ? z.name : null;
  };

  // ---- raids / invasions ----
  // The real between-invasions cooldown is 2h (Help.json); scale it down for
  // playtesting alongside the crop grow-time scaling (real times when realGrow=1).
  const raidCooldownMs = FAST_GROW ? 60_000 : RAID_COOLDOWN_MS;
  const raids = new RaidManager(assets, state, zombies, { save: () => saveManager.save() }, raidCooldownMs);
  hud.getRaidCards = () => raids.raidCards();
  hud.getRaidParty = () => raids.partyView();
  hud.getRaidStatus = () => ({
    cooldownMs: raids.cooldownRemaining(),
    voucherCount: raids.voucherCount(),
  });
  // Emit the quest events a raid WIN produces: the invasion itself, each looted
  // item, and a "perfect game" when nobody fell. Object names match the quest data
  // (raid name / loot item name), so invasion/loot quests advance.
  const postRaidWinQuests = (view: RaidResultView, raidName: string) => {
    if (!view.win) return;
    questBus.post(QuestEvent.InvasionSuccessful, raidName, 1);
    if (view.zombiesLost === 0) questBus.post(QuestEvent.InvasionPerfectGame, raidName, 1);
    for (const drop of view.loot) questBus.post(QuestEvent.LootItemWon, drop.name, 1);
  };

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
  hud.onRemoveFriend = (id) => state.removeFriend(id);
  hud.onGiftBrain = (id) => state.giftBrain(id);

  // ---- friends: ONLINE path (server ground truth via net/api + net/auth).
  // The whole block is inert when no server is configured; every hook falls back
  // to the offline path above. state.friends doubles as the display cache. ----
  const errCode = (e: unknown) => (e instanceof api.ApiError ? e.code : "error");
  let inboxCache: { id: string; fromName: string }[] = [];

  hud.onlineAvailable = () => auth.isOnlineAvailable();
  hud.socialOnline = () => auth.isSignedIn();
  hud.myAccount = () => {
    const s = api.getSession();
    return s ? { name: s.name, friendCode: s.friendCode } : null;
  };
  hud.renderAuthButton = (el) => void auth.renderSignInButton(el);
  hud.onSignOut = () => {
    saveManager.save(); // flush latest to the server before dropping to local
    saveManager.suspend();
    auth.signOut(); // fires onAuthChange → reload into offline mode
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
  hud.refreshInbox = async () => {
    const gifts = await api.getInbox();
    inboxCache = gifts.map((g) => ({ id: g.id, fromName: g.fromName }));
  };
  hud.getInbox = () => inboxCache;
  hud.onClaimGift = async (id) => {
    try {
      const r = await api.claimGift(id);
      // Server credited the brain into the save (bumping rev). Reflect it locally
      // and adopt the new rev so our next autosave isn't rejected as stale.
      if (!r.alreadyClaimed && r.save) {
        saveManager.syncRev(r.rev);
        state.addBrains(1);
      }
      await hud.refreshInbox?.();
    } catch (e) {
      hud.showToast("Couldn't claim that gift.");
      console.warn("[gift] claim failed", errCode(e));
    }
  };

  // Signing in/out changes which save is authoritative, so reload to re-run the
  // load path cleanly (same flush-then-reload pattern as switching profiles).
  auth.onAuthChange(() => {
    saveManager.suspend();
    location.reload();
  });

  // On boot, if signed in, surface any waiting gifts with a gentle toast.
  if (auth.isSignedIn()) {
    void hud.refreshInbox?.().then(() => {
      const n = hud.getInbox?.().length ?? 0;
      if (n) hud.showToast(`You have ${n} gift${n === 1 ? "" : "s"} waiting! 🎁`);
    });
  }

  // Fast Mode toggle (Settings → Developer). Grow times / cooldowns are baked in
  // at load, so flush the current game and reload to apply the new timescale —
  // same flush-then-reload dance as switching profiles above.
  hud.getFastMode = () => isFastMode();
  hud.onSetFastMode = (on) => {
    saveManager.save();
    saveManager.suspend();
    setFastMode(on);
    location.reload();
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
  let raidActive = false;
  hud.onLaunchRaid = (raidId, partyIds, opts) => {
    if (raidActive) return false;
    const setup = raids.beginRaid(raidId, partyIds, opts);
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
      onFinish: (outcome) => {
        // Apply rewards and show the results panel NOW — the scene keeps rendering
        // (zombies marching off) behind it. The panel's finish button tears down.
        const view = raids.finishRaid(setup.raid, setup.party, outcome, setup.dice);
        postRaidWinQuests(view, setup.raid.name);
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
        });
      },
    }).then((scene) => {
      if (!raidActive) return scene.destroy(); // finished/aborted before load done
      raidScene = scene;
      app.stage.addChild(scene.container);
      (window as unknown as { ZF?: Record<string, unknown> }).ZF!.raidScene = scene; // debug handle
    });
    return true;
  };

  // ---- item storage: retrieve a stored decoration back to a free placement ----
  // `retrieving` holds the stored item key being re-placed; while set, the next
  // valid placement consumes it (free) and exits placement mode.
  let retrieving: string | null = null;
  hud.onRetrieveItem = async (key) => {
    const def = placeCatalog.get(key);
    if (!def) return;
    await ensureObjectTexture(assets, def.sprite);
    if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
    hud.setPlacing(def); // enter placement mode (fires onModeChange first)
    retrieving = key; // ...then arm retrieval so onModeChange doesn't clear it
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
    const entry = state.received[index];
    if (entry == null) return;
    const boost = assets.boosts.find((b) => b.name === entry);
    if (boost) {
      state.addBoost(boost.key);
      state.takeReceivedAt(index);
      return;
    }
    const drop = assets.drops[entry];
    if (drop?.brains) {
      const amt = parseInt(entry, 10);
      if (amt > 0) state.addBrains(amt);
      state.takeReceivedAt(index);
    }
  };

  // Place a decoration reward: enter placement mode; the placement below consumes
  // it from Received once dropped on a valid tile. Mirrors the storage-retrieve arm.
  let receiving: number | null = null;
  hud.onPlaceReceived = async (index) => {
    const entry = state.received[index];
    const def = entry ? receivedDef(entry) : undefined;
    if (!def) return;
    await ensureObjectTexture(assets, def.sprite);
    if (def.growingSprite) await ensureObjectTexture(assets, def.growingSprite);
    hud.setPlacing(def);
    receiving = index; // arm after setPlacing so onModeChange doesn't clear it
  };

  // The object currently being relocated by the Move tool (null = none).
  let carrying: { id: string; def: PlaceableDef } | null = null;
  const cancelCarry = () => {
    carrying = null;
    field.hideObjectCursor();
  };

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
    const { oc, or } = field.resolveObjectOrigin(def, col, row);
    if (!field.canPlaceObject(oc, or, def)) return;
    // Retrieving a stored item: already owned, so it's free and places just one.
    if (retrieving) {
      field.placeObject(def, oc, or);
      audio.play("place");
      if (def.armyMax) state.addZombieMax(def.armyMax); // re-apply functional effect
      state.retrieveItem(retrieving);
      retrieving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    // Placing a Received reward: also free, consumed from the Received bucket.
    if (receiving !== null) {
      field.placeObject(def, oc, or);
      audio.play("place");
      if (def.armyMax) state.addZombieMax(def.armyMax);
      state.takeReceivedAt(receiving);
      receiving = null;
      hud.setPlacing(null); // one at a time
      return;
    }
    if (state.level < def.level) return;
    // The Zombie Pot costs 500 GOLD for the first, then 30 BRAINS for each extra.
    const potOwned = !!def.zombiePot && field.hasZombiePot();
    const cost = def.zombiePot ? (potOwned ? 30 : 500) : def.cost;
    const useBrains = def.zombiePot ? potOwned : def.brainsNeeded;
    const paid = useBrains ? state.spendBrains(cost) : state.spendGold(cost);
    if (!paid) return;
    field.placeObject(def, oc, or);
    audio.play("place");
    const xp = buyXp(cost, def.xp); // buying always rewards XP (economy.ts)
    state.addXp(xp);
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
      if (field.moveObject(carrying.id, oc, or)) cancelCarry();
    } else {
      const id = field.objectAtPoint(wx, wy);
      const def = id ? field.objectDefOf(id) : null;
      if (id && def) {
        carrying = { id, def };
        field.setObjectCursor(def, col, row, id);
      }
    }
  };

  // The gold/brains refunded when selling a placed object (see economy.ts —
  // significantly less than the purchase price).
  const sellRefund = (def: PlaceableDef) => sellBack(def.cost);

  // Sell a placed object for a refund (used by the Remove tool + object popup).
  const sellObject = (id: string) => {
    const def = field.objectDefOf(id);
    const o = field.objectOriginOf(id);
    field.removeObject(id);
    if (!def || !o) return;
    audio.play("sell");
    if (def.armyMax) state.addZombieMax(-def.armyMax); // reverse functional effect
    const refund = sellRefund(def);
    if (def.brainsNeeded) state.addBrains(refund);
    else state.addGold(refund);
    const c = tileCenter(o.oc, o.or);
    floatText(c.x, c.y, `+${refund}${def.brainsNeeded ? "b" : "g"}`);
  };

  // Store a placed object in the shed (returns it to inventory for free re-placing
  // later). Reverses any functional effect; the shed must have a free slot.
  const storeObject = (id: string) => {
    const def = field.objectDefOf(id);
    if (!def) return;
    if (!state.storeItem(def.key)) return; // shed full
    if (def.armyMax) state.addZombieMax(-def.armyMax); // reverse functional effect
    field.removeObject(id);
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
      jobs.cancelAtTile(col, row); // drop any queued job on this plot first
      field.removePlot(col, row); // plowed/harvested plot -> bare ground, no refund
    }
  };

  app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
    if (raidActive) return; // farm input is inert during a live raid
    if (touchPinch) return; // a pinch is in progress; ignore extra finger-downs
    if (e.button === 2) { // right-click -> back to the select tool
      cancelCarry();
      hud.setMode("walk");
      dragging = false;
      return;
    }
    hud.collapse(); // any tap on the field collapses the bars into the corner fab
    const { col, row, wx, wy } = tileAt(e);
    if (hud.mode === "place") {
      tryPlaceObject(col, row);
      dragging = false;
      return;
    }
    if (hud.mode === "move") {
      handleMoveTap(col, row, wx, wy);
      dragging = false;
      return;
    }
    if (hud.mode === "remove") {
      tryRemove(col, row, wx, wy);
      dragging = false;
      return;
    }
    if (hud.mode === "instagrow") {
      tryInstaGrow(col, row); // ripen the tapped crop, spend one use
      dragging = false;
      return;
    }
    if (jobs.cancelAtTile(col, row)) { // tapped a queued action -> un-queue it
      dragging = false;
      return;
    }
    const queuedObjId = field.objectAtPoint(wx, wy);
    if (queuedObjId && jobs.cancelObject(queuedObjId)) {
      dragging = false;
      return;
    }
    dragging = true;
    moved = false;
    last.copyFrom(e.global);
    if (hud.mode !== "walk") {
      enqueueTool(col, row); // tap queues a plow/plant job for this plot
      lastPlot = tileKey(col, row);
    }
  });
  app.stage.on("pointermove", (e: FederatedPointerEvent) => {
    if (raidActive) return;
    if (touchPinch) return; // pinch owns the gesture; skip pan/cursor updates
    const { col, row, wx, wy } = tileAt(e);
    if (hud.mode === "place" && hud.placing) {
      field.setObjectCursor(hud.placing, col, row); // ghost follows the cursor
      return;
    }
    if (hud.mode === "move") {
      if (carrying) field.setObjectCursor(carrying.def, col, row, carrying.id);
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
      field.setCursor(col, row, "grow"); // green over a growing crop, red otherwise
      return;
    }
    if (dragging) {
      if (hud.mode === "walk") {
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        world.position.x += dx;
        world.position.y += dy;
        clampCamera(); // block panning above the sky
        last.copyFrom(e.global);
      } else {
        // drag to queue plow/plant across the field (new tile under the cursor)
        const tk = tileKey(col, row);
        if (tk !== lastPlot) {
          enqueueTool(col, row);
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
            str: d.str, dex: d.dex, con: d.con, focus: d.focus, mutation: d.mutation,
            invasions: d.invasions,
            portrait: zombiePortrait(d.key), // per-type composited portrait
            id: d.id, stored: false,
          });
          dragging = false;
          lastPlot = "";
          return;
        }
        zombies.clearSelection();
        const objId = field.objectAtPoint(wx, wy);
        const objDef = objId ? field.objectDefOf(objId) : null;
        // Signature decor (Liberty Bell, Gnome King, …) plays its own tap sound.
        if (objDef?.tapSound) audio.tap(objDef.tapSound);
        if (objId && objDef && objDef.storageSlots) {
          hud.openStorage();
        } else if (objId && objDef && objDef.zombieStorage) {
          hud.openMausoleum(); // the Mausoleum's storage slots
        } else if (objId && objDef && objDef.zombiePatch) {
          // Tap the Zombie Patch: call all zombies to nap, or wake them.
          const napping = zombies.toggleGather(field.patchRestTiles());
          const wp = field.objectWorkPoint(objId);
          if (wp) floatText(wp.x, wp.y - 24, napping ? "Zzz…" : "Awake!");
        } else if (objId && objDef && objDef.zombiePot) {
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
              carrying = { id: oid, def }; // ...then pick up this object
              const o = field.objectOriginOf(oid);
              if (o) field.setObjectCursor(def, o.oc + Math.floor((def.tileW - 1) / 2),
                o.or + Math.floor((def.tileH - 1) / 2), oid);
            },
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
          hud.openPlantMenu((cfg) => {
            hud.setPlanting(cfg); // keep planting this crop on further taps
            jobs.enqueue("plant", col, row, cfg);
          });
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
    endDrag(e);
  };
  app.stage.on("pointerup", onPointerUp);
  app.stage.on("pointerupoutside", onPointerUp);

  // Right-click anywhere returns to the select tool (and suppress the browser menu).
  app.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
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
  };

  window.addEventListener("resize", recenter);

  // ---- game loop ----
  // Persistent combine-timer bar that floats over the placed Zombie Pot while a
  // combine runs (offline-safe: it reflects the pot's absolute finish time).
  const potBar = new Container();
  potBar.visible = false;
  const potFill = new Graphics();
  const potLabel = new Text({
    text: "",
    style: {
      fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "700",
      fill: 0xffffff, stroke: { color: 0x0a1406, width: 3 },
    },
  });
  {
    const W = 88, H = 16, PAD = 2;
    const bg = new Graphics();
    bg.roundRect(-W / 2, -H / 2, W, H, 4)
      .fill({ color: 0x1a1a24, alpha: 0.9 })
      .stroke({ width: 2, color: 0x05050a });
    potFill.roundRect(0, 0, W - 2 * PAD, H - 2 * PAD, 3).fill({ color: 0x8ad14a });
    potFill.position.set(-W / 2 + PAD, -H / 2 + PAD);
    potFill.scale.x = 0;
    potLabel.anchor.set(0.5, 0.5);
    potBar.addChild(bg, potFill, potLabel);
    field.labelLayer.addChild(potBar);
  }

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05);
    if (raidScene) raidScene.update(dt); // live battle drives itself; farm still ticks behind
    jobs.update(dt); // may start a walk-to-plot / hoe cycle for the farmer
    walk.update(dt);
    zombies.update(dt);
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
    // Zombie Pot combine bar: show over the building while combining.
    const potId = field.zombiePotId();
    const pot = zombies.combinePot;
    if (potId && pot.busy) {
      const wp = field.objectWorkPoint(potId);
      if (wp) {
        potBar.visible = true;
        potBar.position.set(wp.x, wp.y - 92);
        const ready = zombies.combineReady;
        potFill.scale.x = ready ? 1 : pot.progress();
        const secs = Math.ceil(pot.remainingMs() / 1000);
        potLabel.text = ready ? "Ready!" : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
      }
    } else if (potBar.visible) {
      potBar.visible = false;
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

  (window as any).ZF = { app, world, field, actor, walk, zombies, state, hud, jobs, audio, save: saveManager, quests, questBus, raids, screenToGrid, CARROT,
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
      const object = combineObject(idA, idB);
      const ok = zombies.combine(idA, idB);
      if (ok) questBus.post(QuestEvent.CombinerCombined, object);
      return ok;
    },
    // Collect a finished combine onto the farmer's tile (or storage if capped).
    collectCombine: () => {
      const z = zombies.collectCombine(walk.tile.col, walk.tile.row);
      if (z) questBus.post(QuestEvent.CombinerHarvested, z.typeName);
      return z;
    },
    // Inspect the running combine: { busy, ready, remainingMs, pending }.
    potStatus: () => ({
      busy: zombies.combinePot.busy,
      ready: zombies.combineReady,
      remainingMs: zombies.combinePot.remainingMs(),
      pending: zombies.combinePot.pending,
    }) };
  // eslint-disable-next-line no-console
  console.log(`field ${field.w}x${field.h} ready`);
}

main().catch((err) => {
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) hud.innerHTML = `<b style="color:#ffb0b0">Error:</b> ${err}`;
});
