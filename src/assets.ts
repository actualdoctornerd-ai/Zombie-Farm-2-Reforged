// Loads the prepped data (JSON) and textures produced by tools/prep_assets.py.
import { Assets, Rectangle, Texture } from "pixi.js";
import { QuestDef } from "./quest/types";
import { RaidDef, EnemyStat, AttackDef } from "./raid/types";
import { setZombieNames } from "./zombie/names";
import { BASE } from "./base";

export interface Tile {
  terrain: string;
  variant: number;
}
export interface FieldData {
  w: number;
  h: number;
  tileW: number;
  tileH: number;
  start: { col: number; row: number };
  tiles: Tile[][];
}
export type GroundIndex = Record<string, string[]>; // terrain -> [filename,...]

export interface RigPart {
  offsetX: number;
  offsetY: number;
  pivotX: number;
  pivotY: number;
  z: number;
}
export type Rig = Record<string, RigPart>; // part filename -> layout

// One part of a per-type zombie model (assembled + animated at runtime). `file`
// keys into the shared ZombieSheet sub-textures; `tint` = colour by unit tint.
export interface ZombieModelPart {
  file: string;
  group: "root" | "head" | "footF" | "footB";
  px: number;
  py: number;
  ax: number;
  ay: number;
  z: number;
  tint: boolean;
}
// A full per-type zombie model (from tools/prep_zombie_models.py). Reverse-
// engineered part composition + authentic per-unit colour + group scale.
export interface ZombieModel {
  name: string;
  neck: { x: number; y: number };
  scale: number; // exact ZF2 group setScale (Regular .90, Small .60, Girl .80, Garden .70, Large 1.15, Headless .90)
  color: [number, number, number]; // authentic Market tint for the grey skeleton
  parts: ZombieModelPart[]; // z-sorted
  // Tier-4 variants (Eyebiscus/Heartichoke) SHARE a mutation bit with a lower-tier
  // mutation (Carrot=4 / Cauliflower=512) for stats/slot, but have their own hair
  // art. This remaps a mutation bit (as string) to an alternate mutationParts key so
  // the field render uses the variant's true sprite instead of the shared one.
  mutationOverrides?: Record<string, string>;
}

// A crop-mutation body part (mutations.json), attached at runtime onto any base
// body from a unit's mutation mask. `headRel` parts (hats) add the model's neck
// offset; head-slot parts and root parts (arms/body/collar) use their own offset.
export interface MutationPart {
  file: string; // ZombieSheet part name -> zombiePartTex
  group: "head" | "root";
  headRel: boolean;
  ox: number;
  oy: number;
  ax: number;
  ay: number;
  z: number;
}

// A raid-enemy rig part (raids/enemies/models.json). rx/ry/rw/rh slice the enemy's
// packed part strip (raids/enemies/parts/<key>.png); px/py/ax/ay/z/rot place it (see
// tools/prep_enemies.py). `group` drives the procedural animation in EnemyActor.
export interface EnemyPart {
  rx: number; ry: number; rw: number; rh: number;
  px: number; py: number; ax: number; ay: number; z: number; rot: number;
  group: "head" | "leg" | "arm" | "wing" | "wheel" | "body";
  back: boolean;
}
export interface EnemyModel {
  parts: EnemyPart[];
  neck: { x: number; y: number } | null;
}

// Market catalog entries (from Market.plist), used by the plant/zombie picker.
export interface PlantDef {
  key: string;
  name: string;
  cost: number; // gold to plant
  sell: number; // gold when harvested
  growMs: number; // authoritative (source) grow time
  level: number; // player level required to unlock
  xp: number; // xp granted on harvest
  stage1: string;
  stage2: string;
}
export interface ZombieDef {
  key: string;
  name: string;
  cost: number;
  growMs: number; // authoritative (source) grow time
  level: number; // player level required to unlock
  xp: number; // xp granted on harvest
  brainsNeeded?: boolean; // cost is paid in brains, not gold
  category: "normal" | "special" | "mutant";
  mutation?: number; // mutation BITMASK for market mutants (Carrot=4); 0/absent = none
  // Phase 3 taxonomy + combat stats (baked by tools/prep_market.py).
  group: string; // Regular / Female / Small / Large / Headless / Garden
  className: string; // Green / Blue / Red / Silver / Special / Yellow
  classColor: string; // "#rrggbb" for this class
  str: number;
  dex: number;
  con: number;
  focus: number;
  tier?: number; // 0..5 combat tier; drives Zombie Pot species selection (higher wins)
}

// A consumable boost from the Market (tools/prep_boosts.py). Farm-usable effects
// (grow/harvest/plow/gift) apply immediately; the rest wait for their system.
export interface BoostDef {
  key: string;
  name: string;
  cost: number;
  brainsNeeded: boolean;
  level: number;
  effect: "grow" | "harvest" | "plow" | "gift" | "refresh" | "concentration" | "dice" | "other";
  amount: number; // grow: how many crops to ripen
  perPurchase: number; // quantity added to inventory per purchase
  giftZombieKey: string; // gift: the zombie unit key to spawn
  usableOnFarm: boolean;
  info: string;
  flavorText: string;
  icon: string; // filename under /assets/boosts/
}

// A placeable farm object (tree/decor/functional) from Market + TileProperties.
export interface PlaceableDef {
  key: string;
  name: string;
  category: "tree" | "decor" | "functional" | "reward"; // Items section ("reward" = raid loot, not sold)
  cost: number;
  level: number; // player level required to unlock
  xp: number; // xp granted on purchase/placement
  brainsNeeded?: boolean;
  tileW: number; // footprint width in tiles
  tileH: number; // footprint height in tiles
  movable: boolean;
  rotations: number;
  tapSound?: string; // signature audio played when this decor is tapped (e.g. belltoll.mp3)
  sprite: string; // filename under /assets/objects/
  nativeW: number;
  nativeH: number;
  pivotX: number;
  pivotY: number;
  armyMax?: number; // functional: increases zombie army cap by this on placement
  storageSlots?: number; // functional: storage shed item capacity (8..64)
  zombieStorage?: boolean; // functional: the Mausoleum — stores owned zombies (uncapped)
  graveColor?: "Blue" | "Red" | "Silver"; // colored grave: unlocks planting that zombie class
  zombiePatch?: boolean; // functional: the Zombie Patch — gathers zombies to nap on it
  plowFree?: boolean; // functional: Plowing Monolith — plowing costs no gold
  fastWork?: boolean; // functional: Speed Monolith — farming actions are instant
  mutantMonolith?: boolean; // functional: Mutant Monolith — halves mutant-zombie grow times
  combineFast?: boolean; // functional: Clay Monolith — Zombie Pot combines in 15 min (0.25x)
  zombiePot?: boolean; // functional: Zombie Pot — enables combining two zombies
  // fruit trees: repeatable harvest. growMs = time to regrow fruit; harvestValue
  // = gold per harvest; growingSprite = the pre-harvest (fruitless) sprite.
  growMs?: number;
  harvestValue?: number;
  growingSprite?: string;
}

export interface GameAssets {
  field: FieldData;
  groundIndex: GroundIndex;
  rig: Rig;
  ground: Record<string, Texture>; // filename -> texture
  player: Record<string, Texture>; // part filename -> texture
  soil: Record<string, Texture>; // plot filename -> texture
  crop: Record<string, Texture>; // crop-stage filename -> texture
  zombieModels: Record<string, ZombieModel>; // unitKey -> per-type model
  enemyModels: Record<string, EnemyModel>; // raid-enemy key -> animated rig
  zombiePartTex: Record<string, Texture>; // ZombieSheet part name -> sub-texture
  mutationParts: Record<string, MutationPart>; // mutation bit (as string) -> body part
  plants: PlantDef[];
  zombies: ZombieDef[];
  placeables: PlaceableDef[];
  boosts: BoostDef[]; // consumable boosts
  quests: Record<string, QuestDef>; // quest id -> definition (all 96)
  raids: RaidDef[]; // invasions (from tools/prep_raids.py)
  enemyStats: Record<string, EnemyStat>; // enemy/boss unit key -> combat stats
  raidAttacks: Record<string, AttackDef>; // attack name -> definition
  drops: Record<string, DropDef>; // loot item name -> icon + brains/gold flags
  objects: Record<string, Texture>; // object sprite filename -> texture
  background: Texture; // green-hills + sky backdrop behind the farm
  scenery: Texture[]; // decorative foliage [tree, shrub, shrub, bush] for the grass
  upgrades: UpgradeData; // Market "Upgrade" tab: farm-size expansions + ground skins
}

// Farming-plot soil textures (from Soil.png): plowed (ready), planted (seeded),
// unplowed (post-harvest dirt), hole (post-zombie-harvest).
export const SOIL_FILES = [
  "plowed_dirt.png", "unplowed_dirt.png", "planted_dirt.png", "hole.png",
];
export const PLOWED_FILE = "plowed_dirt.png";
export const SEED_FILE = "planted_dirt.png"; // shared crop seed = seeded soil
export const DIRT_FILE = "unplowed_dirt.png"; // harvested-crop untilled dirt
export const HOLE_FILE = "hole.png"; // harvested-zombie hole
// Zombie crop growth cycle (Crops2.png zombiegrowtile): wooden cross -> hand
// emerging -> zombie clawing up -> zombie risen with a thumb up. Full-plot tiles
// (194x137) like the plant crops, so they scale/anchor the same way.
export const ZOMBIE_STAGES = [
  "zombie_grow_stage1.png", "zombie_grow_stage2.png",
  "zombie_grow_stage3.png", "zombie_grow_stage4.png",
];
export const ZOMBIE_GROWN = "zombie_grown.png"; // tight Dr. Zombie (card portrait)
// Per-type zombie portrait (menus): /assets/zombie/portrait/<unitKey>.png.
export const zombiePortrait = (key: string) => `${BASE}assets/zombie/portrait/${key}.png`;
/** Loot item drop metadata (from tools/prep_drops.py). */
export interface DropDef {
  icon: string; // filename under /assets/raids/loot/ ("" = no art)
  brains: boolean;
  gold: boolean;
  tile: string; // linked placeable key ("" = none); maps a reward to its placeable
  unique: boolean; // drops only once — filtered out of the loot roll once owned
  limit: number; // max copies that can ever drop (0 = unlimited; only Rusty Fragment: 3)
}
/** URL of a loot item's picture. */
export const lootImage = (file: string) => `${BASE}assets/raids/loot/${file}`;

/** A Farm Size expansion (from tools/prep_upgrades.py). Payable in gold OR brains
 *  (the source ships each size as a gold entry + a brains entry, merged here). */
export interface FarmSizeUpgrade {
  name: string;
  size: number; // new NxN field dimension (40 / 50 / 60)
  level: number; // player level required
  gold: number;
  brains: number;
  info: string; // "40x40"
  icon: string; // filename under /assets/ui/market/
}
/** A Ground/climate skin: repaints the whole farm's terrain tiles. */
export interface ClimateUpgrade {
  name: string;
  climateGID: number;
  terrain: string; // ground_index terrain key this skin uses (grass/dirt/snow/stone/sand/water)
  level: number;
  gold: number;
  icon: string;
}
export interface UpgradeData {
  mapSize: FarmSizeUpgrade[];
  climate: ClimateUpgrade[];
}
/** URL of an upgrade thumbnail icon. */
export const upgradeIcon = (file: string) => `${BASE}assets/ui/market/${file}`;

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

// The default male farmer's parts (a subset of the full rig).
export const FARMER_PARTS = [
  "male_arm1.png",
  "male_arm3.png",
  "malebody1.png",
  "boot_back.png",
  "boot_front.png",
  "male_arm2.png",
  "male_arm4.png",
  "malehead1.png",
  "plough.png", // the hoe, shown only while working a plot
];

export async function loadAssets(): Promise<GameAssets> {
  const [field, groundIndex, rig, plants, zombies, placeables, boosts, quests,
    raids, enemyStats, raidAttacks, zombieNames, drops, upgrades] = await Promise.all([
    json<FieldData>(BASE + "assets/field_default.json"),
    json<GroundIndex>(BASE + "assets/ground_index.json"),
    json<Rig>(BASE + "assets/rig_player.json"),
    json<PlantDef[]>(BASE + "assets/plants.json"),
    json<ZombieDef[]>(BASE + "assets/zombies.json"),
    json<PlaceableDef[]>(BASE + "assets/placeables.json"),
    json<BoostDef[]>(BASE + "assets/boosts.json"),
    json<Record<string, QuestDef>>(BASE + "assets/quests.json"),
    json<RaidDef[]>(BASE + "assets/raids/raids.json"),
    json<Record<string, EnemyStat>>(BASE + "assets/raids/enemy_stats.json"),
    json<Record<string, AttackDef>>(BASE + "assets/raids/attacks.json"),
    json<Record<string, string[]>>(BASE + "assets/zombie_names.json"),
    json<Record<string, DropDef>>(BASE + "assets/raids/drops.json"),
    json<UpgradeData>(BASE + "assets/upgrades.json"),
  ]);
  setZombieNames(zombieNames); // seed the random-name picker before any zombie is built

  // Flag functional items by key. (TODO: bake these into prep_placeables.py so
  // they're source-driven rather than derived here.)
  for (const p of placeables) {
    // Footprints are whole tiles in the base game (`-[Tile dimensions]` reads
    // tileWidth/tileHeight via integerValue, truncating). Coerce any authored
    // fractional size (e.g. coolerLarge 1.5) to an integer so occupancy and the
    // depth footprint cover exact tiles with no half-tile hole.
    p.tileW = Math.max(1, Math.floor(p.tileW));
    p.tileH = Math.max(1, Math.floor(p.tileH));
    if (/^mausoleum/i.test(p.key)) p.zombieStorage = true;
    const grave = /^gravestone(Blue|Red|Silver)$/.exec(p.key);
    if (grave) p.graveColor = grave[1] as "Blue" | "Red" | "Silver";
    if (p.key === "soil_zombiePatch") p.zombiePatch = true;
    if (p.key === "monolithPlowing") p.plowFree = true;
    if (p.key === "monolithSpeed") p.fastWork = true;
    if (p.key === "monolithMutation") p.mutantMonolith = true;
    if (p.key === "monolithCombine") p.combineFast = true; // Clay Monolith
    if (p.key === "zombieCombiner") p.zombiePot = true;
  }

  // Load every ground-tile variant texture.
  const ground: Record<string, Texture> = {};
  const groundFiles = Object.values(groundIndex).flat();
  await Promise.all(
    groundFiles.map(async (f) => {
      ground[f] = await Assets.load(`${BASE}assets/ground/${f}`);
    })
  );

  // Load the farmer's part textures.
  const player: Record<string, Texture> = {};
  await Promise.all(
    FARMER_PARTS.map(async (f) => {
      player[f] = await Assets.load(`${BASE}assets/player/${f}`);
    })
  );

  // Load soil-plot textures.
  const soil: Record<string, Texture> = {};
  await Promise.all(
    SOIL_FILES.map(async (f) => {
      soil[f] = await Assets.load(`${BASE}assets/soil/${f}`);
    })
  );

  // Load crop-stage textures: every plant's two stages + the generic grown zombie.
  // The shared seed stage reuses the "planted" soil texture (set below).
  const crop: Record<string, Texture> = {};
  const cropFiles = new Set<string>([ZOMBIE_GROWN, ...ZOMBIE_STAGES]);
  for (const p of plants) {
    cropFiles.add(p.stage1);
    cropFiles.add(p.stage2);
  }
  await Promise.all(
    [...cropFiles].map(async (f) => {
      crop[f] = await Assets.load(`${BASE}assets/crops/${f}`);
    })
  );
  crop[SEED_FILE] = soil[SEED_FILE]; // seed stage = seeded-soil texture

  // Per-type zombie models: one shared atlas (ZombieSheet.png) sliced into part
  // sub-textures via frames.json, plus models.json (composition per unit type).
  const [zombieModels, zombieFrames, mutationParts, sheet, enemyModels] = await Promise.all([
    json<Record<string, ZombieModel>>(BASE + "assets/zombie/models.json"),
    json<Record<string, { x: number; y: number; w: number; h: number }>>(
      BASE + "assets/zombie/frames.json"
    ),
    json<Record<string, MutationPart>>(BASE + "assets/zombie/mutations.json"),
    Assets.load(BASE + "assets/zombie/ZombieSheet.png") as Promise<Texture>,
    json<Record<string, EnemyModel>>(BASE + "assets/raids/enemies/models.json").catch(() => ({})),
  ]);
  const zombiePartTex: Record<string, Texture> = {};
  for (const [name, f] of Object.entries(zombieFrames)) {
    zombiePartTex[name] = new Texture({
      source: sheet.source,
      frame: new Rectangle(f.x, f.y, f.w, f.h),
    });
  }

  // Object sprites (197 of them) are loaded lazily — only when an object is
  // actually placed or restored — via ensureObjectTexture(). Market cards use
  // plain DOM <img>, so browsing does not pay any Pixi/texture cost.
  const objects: Record<string, Texture> = {};

  // The static hills-and-sky backdrop that sits behind the farm.
  const background = (await Assets.load(BASE + "assets/farm_background.png")) as Texture;

  // Decorative foliage (tree + shrubs + bush) scattered on the grass around the
  // farm. Order matters: index 0 is the tall tree, 1..3 are shrubs/bushes.
  const scenery = await Promise.all(
    ["tree.png", "shrub1.png", "shrub2.png", "shrub3.png"].map(
      (f) => Assets.load(`${BASE}assets/scenery/${f}`) as Promise<Texture>
    )
  );

  return {
    field, groundIndex, rig, ground, player, soil, crop,
    zombieModels, enemyModels, zombiePartTex, mutationParts, plants, zombies, placeables, boosts, quests,
    raids, enemyStats, raidAttacks, drops, objects, background, scenery, upgrades,
  };
}

/** Path to a raid image (boss portrait, stage background) under /assets/raids/. */
export const raidImage = (file: string) => `${BASE}assets/raids/images/${file}`;

// Lazily load (and cache) a placed object's texture the first time it's needed.
export async function ensureObjectTexture(
  assets: GameAssets,
  sprite: string
): Promise<Texture> {
  if (!assets.objects[sprite]) {
    assets.objects[sprite] = await Assets.load(`${BASE}assets/objects/${sprite}`);
  }
  return assets.objects[sprite];
}
