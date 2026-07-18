// Loads the prepped data (JSON) and textures produced by tools/prep_assets.py.
import { Assets, Rectangle, Texture } from "pixi.js";
import { makeCropTopTexture } from "./cropTop";
import type { QuestDef } from "./quest/types";
import type { RaidDef, EnemyStat, AttackDef } from "./raid/types";
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
  /** Per-attachment scale from the source actor. Named specials sometimes resize
   *  a replacement part (Skittles' candy body is 0.8x). */
  scale?: number;
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
  /** Base-model silhouette part this mutation replaces. Omitted for overlays. */
  replaces?: "body" | "armF";
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
  /** True for a bare-fisted actor (lawyer / office boss): arms rest at the sides and
   *  only extend to jab. A weapon-holder keeps its tool up. */
  punch?: boolean;
  /** Explicit shoulder pivot (strip space) the front arm + held weapon swing about.
   *  Set for weapon-holders so the swing pivots at the arm bone, not the blade tip;
   *  when absent EnemyActor falls back to the top-most front-arm part. */
  shoulder?: { x: number; y: number };
  /** Additional labelled animation pivots authored in the sprite assembler. */
  pivots?: { name: string; x: number; y: number }[];
  /** True for a two-handed OVERHEAD SLAM attacker (pirate boss): both arms raise above
   *  the head and slam down at the hit, instead of the default one-arm forward jab. */
  slam?: boolean;
  /** Sign of the weapon CHOP rotation about the shoulder (+1 default). A weapon-holder
   *  whose tool-arm sits on the far/right side of the shoulder (e.g. a cross-body axe
   *  swing) sets -1 so the raise still lifts the blade UP rather than dropping it. */
  chopSign?: number;
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
  seasonal?: boolean;
}

interface SpecialZombieManifest {
  name: string;
  neck: { x: number; y: number };
  color?: [number, number, number];
  floatingHead?: boolean;
  parts: Array<Omit<ZombieModelPart, "tint"> & { file: string }>;
}

const SPECIAL_GROUP_SCALE: Record<string, number> = {
  Regular: 0.9, Female: 0.8, Girl: 0.8, Small: 0.6,
  Large: 1.15, Headless: 0.9, Garden: 0.7,
};

// These actors paint their complete face into their dedicated head attachments.
// Keeping the ordinary facial details produces a second face over the authored one.
const COMPLETE_SPECIAL_FACES = new Set([
  "ZombieActorZombug",
  "ZombieActorZwampThing",
]);
const DEFAULT_FACE_SLOTS = new Set([
  "EyeL", "EyeR", "UpperTeeth", "LowerTeeth", "Scar",
]);

/** Merge a named actor's replacement attachments over the ordinary skeleton.
 *  The source special-zombie plists are deltas, not complete actors: for example,
 *  Skittles supplies only a Body attachment and inherits its head, limbs and face. */
export function mergeSpecialZombieModel(
  base: ZombieModel,
  def: ZombieDef,
  manifest: SpecialZombieManifest,
  textureKey: (file: string) => string
): ZombieModel {
  const slot = (file: string) => file.replace(/^default/, "").replace(/\.png$/i, "");
  const replaced = new Set(manifest.parts.map((part) => slot(part.file)));
  const hasCompleteSpecialFace = COMPLETE_SPECIAL_FACES.has(def.key);
  const headDx = replaced.has("Head") ? manifest.neck.x - base.neck.x : 0;
  const headDy = replaced.has("Head") ? manifest.neck.y - base.neck.y : 0;
  const inherited = manifest.floatingHead
    ? []
    : base.parts.filter((part) => {
      const partSlot = slot(part.file);
      return !replaced.has(partSlot)
        && !(hasCompleteSpecialFace && DEFAULT_FACE_SLOTS.has(partSlot));
    }).map((part) => ({
      ...part,
      px: part.px + (part.group === "head" ? headDx : 0),
      py: part.py + (part.group === "head" ? headDy : 0),
    }));
  const dedicated = manifest.parts.map((part) => ({
    ...part,
    file: textureKey(part.file),
    tint: false,
  }));
  return {
    name: def.name,
    neck: replaced.has("Head") ? manifest.neck : base.neck,
    scale: SPECIAL_GROUP_SCALE[def.group] ?? base.scale,
    color: manifest.color ?? base.color,
    parts: [...inherited, ...dedicated].sort((a, b) => a.z - b.z),
  };
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
  specialSprite?: string; // named source zombie rendered from its dedicated sheet
  rewardOnly?: boolean; // earned from an event/quest; never shown as a plantable Market crop
  marketHidden?: boolean; // obtained through a voucher/gift rather than planted directly
}

export const purchasableZombies = (zombies: readonly ZombieDef[]): ZombieDef[] =>
  zombies.filter((zombie) => !zombie.rewardOnly && !zombie.marketHidden);

// A consumable boost from the Market (tools/prep_boosts.py). Farm-usable effects
// (grow/harvest/plow/gift) apply immediately; the rest wait for their system.
export interface BoostDef {
  key: string;
  name: string;
  cost: number;
  brainsNeeded: boolean;
  level: number;
  effect: "grow" | "harvest" | "plow" | "gift" | "concentration" | "dice" | "other";
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
  // Movement collision can be WIDER than the placement footprint. A fence occupies a
  // single tile for placement (so runs pack tight), but its rail panel bridges into a
  // neighbouring tile — walkers must be blocked there too or they clip through it.
  // Extra blocked tiles are listed as (dc,dr) offsets from the origin in BASE
  // (unflipped) orientation; a horizontal flip mirrors the panel, which in iso swaps
  // the two diagonal axes, so the offsets swap dc<->dr when the object is flipped.
  collideExtend?: { dc: number; dr: number }[];
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
  petPen?: boolean; // Pet Pen: manages up to four displayed pets
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
  farmer: FarmerCatalog; // source Farmer market heads + independently equipable bodies
  pets: PetCatalog; // source pet market + animation-strip metadata
  soil: Record<string, Texture>; // plot filename -> texture
  crop: Record<string, Texture>; // crop-stage filename -> texture
  cropTop: Record<string, Texture>; // crop-stage filename -> plants-only texture (soil keyed out)
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

export interface FarmerHeadDef {
  id: number;
  name: string;
  part: string;
  bodyId: number;
  sort: number;
  /** Missing or zero means the part is unlocked by default. */
  cost?: number;
  brains?: boolean;
  description?: string;
  effect?: { key: import("./farmer").FarmerEffectKey; amount: number };
}

export interface FarmerBodyDef {
  id: number;
  name: string;
  body: string;
  arm1: string;
  arm2: string;
  arm3: string;
  arm4: string;
  /** Bodies currently have no independent source price and start unlocked. */
  cost?: number;
  brains?: boolean;
}

export interface FarmerCatalog {
  heads: FarmerHeadDef[];
  bodies: FarmerBodyDef[];
}

export interface PetAnimationDef {
  frames: number[];
  frameSeconds: number;
}

export interface PetDef {
  key: string;
  actorKey: string;
  name: string;
  cost: number;
  brains: boolean;
  level: number;
  hidden: boolean;
  description: string;
  color: [number, number, number];
  scale: number;
  walkingSpeed: number;
  randomDelay: boolean;
  playerOffset: [number, number];
  portrait: string;
  sheet: { file: string; cellWidth: number; cellHeight: number; frameCount: number };
  animations: Record<string, PetAnimationDef>;
  states: Record<string, { animation: string; probability: number }[]>;
}

export interface PetCatalog { version: number; pets: PetDef[] }

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

// Load the complete modular Farmer rig so every market head/body can be equipped.
export async function loadAssets(): Promise<GameAssets> {
  const [field, groundIndex, rig, plants, zombies, placeables, boosts, quests,
    raids, enemyStats, raidAttacks, zombieNames, drops, upgrades, farmer, pets] = await Promise.all([
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
    json<FarmerCatalog>(BASE + "assets/farmer.json"),
    json<PetCatalog>(BASE + "assets/pets/catalog.json"),
  ]);
  setZombieNames(zombieNames); // seed the random-name picker before any zombie is built

  // Fence panels are 1 tile for placement but their rail bridges into a neighbour, so
  // movement collision extends one tile. A spaced fence wall only SEALS if the overhang
  // points into the gap between panels — which way depends on how the run is laid/flipped.
  // ┌── TOGGLE for testing: base (unflipped) overhang offset. A horizontal flip swaps
  // │   dc<->dr at runtime, so this one value covers both flip states of a run.
  // │   Candidates (only these two seal anything; negatives point the wrong way):
  // │     [{ dc: 1, dr: 0 }]  — seals col-walls unflipped / row-walls flipped
  // │     [{ dc: 0, dr: 1 }]  — seals col-walls flipped   / row-walls unflipped
  // │   Or block BOTH neighbours to seal EVERY orientation: [{ dc: 1, dr: 0 }, { dc: 0, dr: 1 }]
  // └── (null disables the overhang entirely).
  const FENCE_OVERHANG: { dc: number; dr: number }[] | null = [{ dc: 0, dr: 1 }];
  const FENCE_KEYS = new Set(["pen_01", "barbWireFence_01", "cemeteryFence_01", "hazardFence"]);

  // Flag functional items by key. (TODO: bake these into prep_placeables.py so
  // they're source-driven rather than derived here.)
  for (const p of placeables) {
    if (FENCE_OVERHANG && FENCE_KEYS.has(p.key)) p.collideExtend = FENCE_OVERHANG;
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
    if (p.key === "pettingZoo") p.petPen = true;
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
    Object.keys(rig).map(async (f) => {
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

  // Plants-only companions: the same crop art with its baked soil keyed out, so
  // the plant can be depth-sorted in the entity layer while the dirt renders in
  // a ground layer that never clips a neighbour (see cropTop.ts / Field). The
  // flat seed stage keeps its full texture (it IS just soil).
  const cropTop: Record<string, Texture> = {};
  for (const [f, tex] of Object.entries(crop))
    cropTop[f] = f === SEED_FILE ? tex : makeCropTopTexture(tex);

  // Per-type zombie models: one shared atlas (ZombieSheet.png) sliced into part
  // sub-textures via frames.json, plus models.json (composition per unit type).
  const [zombieModels, zombieFrames, mutationParts, sheet, enemyModels,
    specialModels, specialFrames, specialSheet] = await Promise.all([
    json<Record<string, ZombieModel>>(BASE + "assets/zombie/models.json"),
    json<Record<string, { x: number; y: number; w: number; h: number }>>(
      BASE + "assets/zombie/frames.json"
    ),
    json<Record<string, MutationPart>>(BASE + "assets/zombie/mutations.json"),
    Assets.load(BASE + "assets/zombie/ZombieSheet.png") as Promise<Texture>,
    json<Record<string, EnemyModel>>(BASE + "assets/raids/enemies/models.json").catch(() => ({})),
    json<Record<string, SpecialZombieManifest>>(BASE + "assets/zombie/special_models.json"),
    json<Record<string, { x: number; y: number; w: number; h: number }>>(
      BASE + "assets/zombie/special_frames.json"
    ),
    Assets.load(BASE + "assets/zombie/SpecialZombieSheet.png") as Promise<Texture>,
  ]);
  const zombiePartTex: Record<string, Texture> = {};
  for (const [name, f] of Object.entries(zombieFrames)) {
    zombiePartTex[name] = new Texture({
      source: sheet.source,
      frame: new Rectangle(f.x, f.y, f.w, f.h),
    });
  }
  // A named special's plist contains only the attachments it replaces. Load those
  // dedicated parts, then merge them over a plain skeleton so partial actors do not
  // collapse to a lone prop/body (Skittles was previously just one candy).
  const plain = zombieModels["ZombieActorRegularTier1"];
  const headless = zombieModels["ZombieActorHeadlessTier1"];
  for (const z of zombies.filter((row) => row.specialSprite)) {
    const manifest = specialModels[z.key];
    if (!manifest) continue;
    for (const file of new Set(manifest.parts.map((part) => part.file))) {
      const f = specialFrames[`${z.key}:${file}`];
      if (!f) continue;
      zombiePartTex[`special:${z.key}:${file}`] = new Texture({
        source: specialSheet.source,
        frame: new Rectangle(f.x, f.y, f.w, f.h),
      });
    }
    // Bombie is authored as a floating head, but its plantable incarnation uses
    // the ordinary headless-zombie body beneath its dedicated bomb attachments.
    const base = z.key === "ZombieActorBombie" ? headless : plain;
    const assembledManifest = z.key === "ZombieActorBombie"
      ? { ...manifest, floatingHead: false }
      : manifest;
    zombieModels[z.key] = mergeSpecialZombieModel(
      base, z, assembledManifest, (file) => `special:${z.key}:${file}`
    );
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
    field, groundIndex, rig, ground, player, farmer, pets, soil, crop, cropTop,
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
