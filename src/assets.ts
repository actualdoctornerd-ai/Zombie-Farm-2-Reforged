// Loads the prepped data (JSON) and textures produced by tools/prep_assets.py.
import { Assets, Rectangle, Texture } from "pixi.js";
import { makeCropTopTexture } from "./cropTop";
import type { QuestDef } from "./quest/types";
import type { RaidDef, EnemyStat, AttackDef } from "./raid/types";
import { setZombieNames } from "./zombie/names";
// Value import, and safe from a cycle: mutationVisual takes only TYPES from this module.
import { hidesHeadMutationArt } from "./zombie/mutationVisual";
import { BASE } from "./base";
import { fetchJson, mapConcurrent } from "./assetLoading";
import { noteAssetFailure } from "./assetFailures";
import { isFencePanel } from "./pathCosts";
import { MAX_ZOMBIE_POTS } from "./placementLimit";
import { setRigClips } from "./raid/clipRuntime";
import type { ClipSet } from "./raid/clipRuntime";

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
  /** Per-attachment scale, about the part's own pivot. Named specials carry theirs
   *  from the source actor (Skittles' candy body is 0.8x); the growable models take
   *  theirs from PART_SCALE in prep_zombie_models.py (the Flower zombies' 1.2x
   *  sunflower). Absent means 1. */
  scale?: number;
}
// A full per-type zombie model (from tools/prep_zombie_models.py). Reverse-
// engineered part composition + authentic per-unit colour + group scale.
export interface ZombieModel {
  name: string;
  neck: { x: number; y: number };
  scale: number; // whole-actor display scale (Regular .90, Small .60, Girl .80, Garden .70, Large 1.15)
  color: [number, number, number]; // authentic Market tint for the grey skeleton
  parts: ZombieModelPart[]; // z-sorted
  // Tier-4 variants (Eyebiscus/Heartichoke) SHARE a lower tier's mutation (carrot /
  // cauli) for stats and slot, but have their own hair art. This remaps a mutation to
  // an alternate mutationParts key so the field render uses the variant's true sprite
  // instead of the shared one. Keyed by mutation KEY (a raw bit still resolves — see
  // mutationVisual.mutationPartFor).
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
  replaces?: "body" | "armF" | "head";
}

// A raid-enemy rig part (raids/enemies/models.json). rx/ry/rw/rh slice the enemy's
// packed part strip (raids/enemies/parts/<key>.png); px/py/ax/ay/z/rot place it (see
// tools/prep_enemies.py). `group` drives the procedural animation in EnemyActor.
export interface EnemyPart {
  rx: number; ry: number; rw: number; rh: number;
  px: number; py: number; ax: number; ay: number; z: number; rot: number;
  group: "head" | "leg" | "arm" | "wing" | "wheel" | "body";
  back: boolean;
  /** This part does NOT take the actor's runtime colour — the source's
   *  `setInheritColor: NO`. Only the alien minion sets it (its face and body detail stay
   *  grey while the rest of the body takes a random hue); see EnemyActor.applyTint. */
  noTint?: boolean;
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
  icon: string; // standalone produce sprite for Market cards and harvest pickups
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
// Keeping the ordinary facial details produces a second face over the authored one:
// a mouth floating on a diving helmet, eyes on top of a ninja mask, a green jaw under
// a robot's grille. Each one here supplies a Head (or, for the Diver, a whole helmet)
// with its expression already drawn on.
// Exported so the BAKED portrait can be pinned to the same list the live rig uses:
// tools/prep_assets.py composites the same actors and had none of these rules, which
// is how a Zombug ended up with the default eyes on its card but not on the farm.
// See src/zombie/specialPortrait.test.ts.
export const COMPLETE_SPECIAL_FACES = new Set([
  "ZombieActorZombug",
  "ZombieActorZwampThing",
  "ZombieActorMasterNinjombie",
  "ZombieActorNinjombie",
  "ZombieActorMerZombie",
  "ZombieActorProto",
  "ZombieActorZombieBot",
  "ZombieActorOmegaZombieBot",
  "ZombieActorZomtar",
  "ZombieActorZomdini",
]);
// A named actor whose face is a MASK — a beard, a space helmet, a wall of leaves —
// keeps the ordinary head and eyes behind it (they read through or around the mask by
// design), but must not inherit the mouth that would show below it.
//
// The membership itself lives in zombie/mutationVisual, because the SAME set of actors
// has to suppress head-mutation art for the same reason (a pumpkin drawn over a beard
// has nowhere to sit). Two lists would be two chances to add the fourth masked actor to
// one rule and not the other, and the failure would be silent art.
export const DEFAULT_FACE_SLOTS = new Set([
  "EyeL", "EyeR", "UpperTeeth", "LowerTeeth", "Scar", "Jaw",
]);
export const MASKED_FACE_SLOTS = new Set(["LowerTeeth"]);

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
  const isMasked = hidesHeadMutationArt(def.key);
  // An actor that brings its OWN jaw brings its own mouth line with it: the default
  // lower teeth are placed against the DEFAULT jaw and land wrong on any other shape,
  // which is what put a second set of teeth on the Dapper Zombie's chin.
  const ownJaw = replaced.has("Jaw");
  const headDx = replaced.has("Head") ? manifest.neck.x - base.neck.x : 0;
  const headDy = replaced.has("Head") ? manifest.neck.y - base.neck.y : 0;
  const inherited = manifest.floatingHead
    ? []
    : base.parts.filter((part) => {
      const partSlot = slot(part.file);
      if (replaced.has(partSlot)) return false;
      if (hasCompleteSpecialFace && DEFAULT_FACE_SLOTS.has(partSlot)) return false;
      if (isMasked && MASKED_FACE_SLOTS.has(partSlot)) return false;
      return !(ownJaw && partSlot === "LowerTeeth");
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
  tier?: number; // 0..5 combat tier; retained for combat and persisted Pot compatibility
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
/** One animated layer of a placed object: a strip of cells cut from `sheet`,
 *  laid left-to-right in `cols` columns and wrapped into rows. */
export interface ObjectAnimLayer {
  sheet: string; // filename under /assets/objects/
  n: number; // cell count
  cols: number; // cells per row on the sheet
  ms: number; // how long ONE pass through every cell takes
  /** Pause held on the LAST cell before the loop restarts (the Geyser rests 5s
   *  between eruptions). Never set on a tap-played layer. */
  restMs?: number;
  /** Plays once when the object is tapped instead of looping. */
  onClick?: boolean;
  /** These cells ARE the object's own sprite rather than a part drawn over it, so
   *  a finished tap-played run puts the still back (cocos restoreOriginalFrame).
   *  An overlay layer has no still to fall back to and rests on cell 0. */
  base?: boolean;
  sound?: string; // fired as the run reaches `soundFrame`
  soundFrame?: number;
}
/** One MOTION-PATH part of a placed object: a single piece of art walked along a
 *  keyframed path (the Mechanical Egg's lid, a firefly in its jar, any of the
 *  Skeleton Couple's 21 bones). Positions are in screen pixels relative to the
 *  object's ground point, which is where Field anchors its sprite. */
export interface ObjectAnimPart {
  art: string; // filename under /assets/objects/
  x: number; // home position of the part's anchor, from the ground point
  y: number;
  ax?: number; // anchor within the part (default its top-left)
  ay?: number;
  ms?: number; // one lap of the path; absent for a part that never moves
  keys?: [number, number, number][]; // [t, dx, dy], linearly interpolated
  scaleMs?: number; // the scale track runs on its own clock (the Dish twinkles
  scaleKeys?: [number, number][]; // fast while it hops slowly)
  onClick?: boolean; // plays once when the object is tapped
  sound?: string;
  soundAt?: number; // ms into the lap
}
/** A placed object's animation. A FLIPBOOK layer cycles cells that are `w`x`h` and
 *  share the still sprite's centre line, so a mirrored object needs no offset;
 *  `dy` is how far they hang below its ground line. A MOTION part is drawn over the
 *  object instead, which is why `base` exists: the still bakes every part in at its
 *  home position (the bull on its plinth, the lid on the egg) and `base` is that art
 *  with the parts taken back out, so nothing is left behind when they move.
 *  See tools/prep_placeables.py build_animation. */
export interface ObjectAnimDef {
  w: number;
  h: number;
  dy?: number;
  base?: string;
  layers: ObjectAnimLayer[];
  parts?: ObjectAnimPart[];
}

export interface PlaceableDef {
  key: string;
  name: string;
  category: "tree" | "decor" | "functional" | "reward"; // Items section ("reward" = raid loot, not sold)
  seasonal?: boolean; // holiday/event decor is grouped after the permanent catalog
  cost: number;
  level: number; // player level required to unlock
  xp: number; // gold-buy XP; zero falls back to cost / 100, brain XP is cost-derived
  brainsNeeded?: boolean;
  /** Original Market RGB, applied multiplicatively to the object sprite. */
  color?: [number, number, number];
  /** Base tile this row recolours — same art and footprint, different `color`.
   *  Absent on ordinary items and on the family's base row. Quest objectives treat
   *  a whole family as one item (see quest/objectVariants). */
  variantOf?: string;
  /** Seasonal label (christmas, easter, …). Absent = evergreen, always on sale.
   *  A labelled row is buyable only while its label is on the market allow-list;
   *  see src/decorThemes.ts. */
  theme?: string;
  /** Who drew this object's art, when it was drawn FOR this project rather than
   *  extracted from the original game's atlases ("Art by LennyFaze"). Present only
   *  on contributed rows (see tools/contributed_art.py); the Market shows it on the
   *  card's magnifier parchment, which is the one place an item's own text lives. */
  credit?: string;
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
  /** This object's art must never be mirrored — see `canMirrorObject`. */
  noMirror?: boolean;
  tapSound?: string; // signature audio played when this decor is tapped (e.g. belltoll.mp3)
  sprite: string; // filename under /assets/objects/
  /** Far-side art (the source's `childNodes` layer), drawn on the SAME canvas as
   *  `sprite` but behind anything standing inside the object. Only the Pet Pen has
   *  one: its far wall, which pets have to walk in front of. */
  backSprite?: string;
  /** Working-state art. The source ships each state of a functional object as its
   *  own tile with the SAME footprint and ground point: the Zombie Pot is bare
   *  while idle (`sprite`), wears a clamped-down lid while a combine cooks
   *  (`busySprite`), and sprouts the finished zombie's arm once it is done
   *  (`readySprite`). Both are taller than the idle art; bottom-center anchoring
   *  keeps the pot itself in exactly the same place. */
  busySprite?: string;
  readySprite?: string;
  /** Flipbook animation played on the farm (26 decor items have one). See
   *  `objectAnimation.ts` for how it runs and tools/prep_placeables.py for how the
   *  cell sheets are cut. */
  anim?: ObjectAnimDef;
  nativeW: number;
  nativeH: number;
  pivotX: number;
  pivotY: number;
  /** Ground-hugging art (roads, ponds, rocks, the zombie patch). Its pieces are
   *  drawn to meet each other seam-to-seam, which only works if each one hangs off
   *  its own authored pivot instead of being bottom-centered on its footprint —
   *  see `anchorX`/`anchorY` and Field.flatTileOffset. */
  flatTile?: boolean;
  /** Cocos anchor point of a flat tile's art (y measured UP from the bottom edge),
   *  already rebased onto the trimmed PNG we ship. Only present with `flatTile`. */
  anchorX?: number;
  anchorY?: number;
  /** Orientations this object is drawn in, when turning it means swapping ART rather
   *  than mirroring one sprite. Only the two road bends have these — see ROAD_TURNS
   *  in tools/prep_placeables.py and `turnArt`. Index 0 always restates the def's own
   *  sprite, so a def with `turns` and one without are read the same way. */
  turns?: TurnState[];
  armyMax?: number; // functional: increases zombie army cap by this on placement
  storageSlots?: number; // functional: storage shed item capacity (8..64)
  petPen?: boolean; // Pet Pen: manages up to four displayed pets
  zombieStorage?: boolean; // functional: the Mausoleum — stores owned zombies
  zombieSlots?: number; // functional: Mausoleum zombie capacity (15..60 by tier)
  graveColor?: "Blue" | "Red" | "Silver"; // colored grave: unlocks planting that zombie class
  zombiePatch?: boolean; // functional: the Zombie Patch — gathers zombies to nap on it
  plowFree?: boolean; // functional: Plowing Monolith — plowing costs no gold
  fastWork?: boolean; // functional: Speed Monolith — farming actions are instant
  mutantMonolith?: boolean; // functional: Mutant Monolith — halves mutant-zombie grow times
  combineFast?: boolean; // functional: Clay Monolith — Zombie Pot combines in 15 min (0.25x)
  zombiePot?: boolean; // functional: Zombie Pot — enables combining two zombies
  /** functional: Memorial Statue — one perished zombie can be enshrined on it,
   *  rendered as a stone statue standing on the plinth. */
  memorial?: boolean;
  /** Where a `memorial` object's statue stands, as fractions of the sprite (x from
   *  the left edge, y UP from the bottom edge) — the centre of the plinth's top
   *  face. Authored by tools/memorial_statue.py; absent on every other object. */
  mountX?: number;
  mountY?: number;
  // fruit trees: repeatable harvest. growMs = time to regrow fruit; harvestValue
  // = gold per harvest; growingSprite = the pre-harvest (fruitless) sprite.
  growMs?: number;
  harvestValue?: number;
  growingSprite?: string;
}

/** One orientation of an object whose corners are separate pieces of art.
 *
 *  Everything else on the farm turns by mirroring its one sprite, which in iso is a
 *  quarter turn. That fails for a road bend: the mirror swaps the two grid axes, so a
 *  bend's arms swap with each other and the corner comes back as ITSELF, redrawn a few
 *  pixels out of line. The source authored the corners as separate tiles instead, and
 *  this is one of them: its own art, its own anchor, and (for the apex-south piece) a
 *  measured whole-tile render offset. See ROAD_TURNS in tools/prep_placeables.py. */
export interface TurnState {
  sprite: string;
  nativeW: number;
  nativeH: number;
  /** Flat-tile anchor of THIS state's art (see `anchorX`/`anchorY`). */
  anchorX: number;
  anchorY: number;
  /** This state is the mirror of its art — the fourth corner the source never drew. */
  flip?: boolean;
  /** Tile offset applied to where the art hangs, NOT to the footprint. */
  dc?: number;
  dr?: number;
}

/** How many orientations the Rotate tool cycles this object through: one per authored
 *  turn state, or the plain mirrored/unmirrored pair for ordinary art. */
export function turnCount(def: Pick<PlaceableDef, "turns">): number {
  return def.turns?.length ?? 2;
}

/** The art (sprite + anchors + offsets) a given orientation draws. Falls back to the
 *  def's own fields, so a caller never has to ask whether this object has turn states. */
export function turnArt(
  def: PlaceableDef, turn: number,
): Pick<PlaceableDef, "sprite" | "nativeW" | "nativeH" | "anchorX" | "anchorY" | "flatTile">
  & { dc?: number; dr?: number } {
  const state = def.turns?.[turn];
  return state ? { ...state, flatTile: def.flatTile } : def;
}

/** Is this orientation mirrored? For a def with turn states the answer belongs to the
 *  state (only the fourth corner is a mirror); for everything else turn 1 IS the
 *  mirror. Orientation is one number end to end — save, ghost, placed object — so the
 *  flip is always derived here rather than tracked alongside it. */
export function turnFlip(def: Pick<PlaceableDef, "turns" | "noMirror">, turn: number): boolean {
  if (def.turns) return !!def.turns[turn]?.flip;
  return turn === 1 && canMirrorObject(def);
}

/** The orientation an object will actually stand in: out-of-range indexes wrap, and a
 *  mirror this art must never take (`canMirrorObject`) collapses to unturned — so a
 *  stored turn and the flip derived from it can never disagree. */
export function normalizeTurn(def: Pick<PlaceableDef, "turns" | "noMirror">, turn: number): number {
  const n = turnCount(def);
  const t = ((Math.trunc(turn) % n) + n) % n;
  return def.turns || turnFlip(def, t) ? t : 0;
}

/** Can the Rotate tool turn this object?
 *
 *  "Rotate" is a horizontal mirror, which for isometric art is exactly a quarter turn —
 *  a shed facing front-left comes back facing front-right, and that is right for almost
 *  everything on the farm. It is wrong for art with WRITING baked into it: mirroring the
 *  Ice Cream Stand hands you a sign reading "MAERC ECI", which is what players reported.
 *
 *  There is no mechanical repair for that. Un-mirroring the lettering afterwards would
 *  need it re-skewed onto a plank now leaning the other way, which is drawing, not a
 *  transform. So these objects simply do not rotate, and the tool says so rather than
 *  turning them into nonsense. Flag any object whose art carries readable text; anything
 *  merely asymmetric (a banner's crest, a mailbox's flag) mirrors fine and should not be
 *  listed. The flag is authored in tools/prep_placeables.py — placeables.json is
 *  generated, so editing it alone is undone by the next asset regen. */
export function canMirrorObject(def: Pick<PlaceableDef, "noMirror">): boolean {
  return !def.noMirror;
}

/** Convert an authored RGB triplet to the packed tint format used by Pixi. */
export function objectTint(color?: [number, number, number]): number {
  if (!color) return 0xffffff;
  const [r, g, b] = color.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
  return (r << 16) | (g << 8) | b;
}

/** Multiply two packed RGB tints channel-by-channel, matching sprite tinting. */
export function multiplyObjectTint(a: number, b: number): number {
  const channel = (shift: number) =>
    Math.round(((a >> shift) & 0xff) * ((b >> shift) & 0xff) / 255);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** Maximum simultaneously-owned copies of a Market placeable. Functional items
 * default to one; the Zombie Pot is the explicit higher-limit exception, and the
 * Memorial Statue has no limit at all (one per zombie you want to remember).
 * Stored objects still count as owned. Undefined means no special purchase limit. */
export function placeablePurchaseLimit(def: Pick<PlaceableDef, "key" | "category">): number | undefined {
  if (def.category !== "functional") return undefined;
  if (def.key === "memorialStatue") return undefined;
  return def.key === "zombieCombiner" ? MAX_ZOMBIE_POTS : 1;
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
  cropIcon: Record<string, Texture>; // standalone produce filename -> Market/harvest texture
  zombieModels: Record<string, ZombieModel>; // unitKey -> per-type model
  enemyModels: Record<string, EnemyModel>; // raid-enemy key -> animated rig
  zombiePartTex: Record<string, Texture>; // ZombieSheet part name -> sub-texture
  mutationParts: Record<string, MutationPart>; // mutation bit (as string) -> body part
  invasionBubble: Texture; // farm invasion-ready indicator
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
  background: Texture; // green-hills + sky backdrop behind the farm (the grass default)
  // Per-climate backdrop repaints, keyed by filename. Loaded lazily by
  // ensureBackgroundTexture when a ground skin is applied; seeded with the grass one.
  backgrounds: Record<string, Texture>;
  scenery: Record<string, Texture>; // dedicated temperate foliage art, filename -> texture
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
  /** The body's back / front arm (PlayerDictionary kActorPartTagArmB / ArmF). A body
   *  owns exactly these two images; the walk animates them by rotation (see Actor). */
  arm1: string;
  arm2: string;
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
  xp: number; // exact source XP granted on purchase
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

/** Picture shown for a raid reward. Placeable rewards use their canonical object
 *  sprite—the same image Storage shows after the object has been placed and packed
 *  away. The recovered loot-atlas indexes are unreliable for several drops. */
export function raidRewardImage(
  assets: Pick<GameAssets, "drops" | "placeables" | "boosts">,
  name: string,
): string {
  const drop = assets.drops[name];
  if (drop?.tile) {
    const placeable = assets.placeables.find((candidate) => candidate.key === drop.tile);
    if (placeable) return `${BASE}assets/objects/${placeable.sprite}`;
  }
  if (drop?.icon) return lootImage(drop.icon);
  const boost = assets.boosts.find((candidate) => candidate.name === name);
  return boost?.icon ? `${BASE}assets/boosts/${boost.icon}` : "";
}

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
  return fetchJson<T>(url);
}

// Keep first-visit startup from flooding slower/mobile browsers with simultaneous
// image fetches and decodes. HTTP/2 can multiplex the requests, but decoding dozens
// of PNGs at once still creates avoidable memory and worker pressure.
const STARTUP_ASSET_CONCURRENCY = 8;

/** Folder a bare loose mutation filename resolves under, relative to assets/zombie/. */
export const LOOSE_MUTATION_DIR = "mutations";

/** Where a mutations.json `file` that is NOT an atlas frame lives, relative to
 *  assets/zombie/. A bare name lands in the mutations/ folder; a name containing a
 *  slash is taken as authored, so art kept in its own folder resolves unchanged. */
export function looseMutationPath(file: string): string {
  const named = file.includes("/") ? file : `${LOOSE_MUTATION_DIR}/${file}`;
  return /\.png$/i.test(named) ? named : `${named}.png`;
}

/** Which mutation part files this build has to fetch individually: every `file` in
 *  mutations.json that ZombieSheet.png doesn't already carry a frame for. */
export function looseMutationFiles(
  parts: Readonly<Record<string, MutationPart>>,
  atlas: Readonly<Record<string, unknown>>,
): string[] {
  return [...new Set(
    Object.values(parts).map((part) => part.file).filter((file) => !(file in atlas))
  )];
}

/**
 * Load mutation art that isn't packed into the shared zombie atlas.
 *
 * ZombieSheet.png + frames.json are generated by the asset pipeline, so adding a
 * mutation used to mean repacking the sheet before its art could be seen at all.
 * Anything mutations.json names that the sheet has no frame for is instead fetched
 * as its own PNG — one file to drop in, offsets tunable in place. A part that fails
 * to load is warned about and skipped: the rigs already draw nothing for a mutation
 * with no texture (and, importantly, leave the base body part in place), so a
 * mis-typed filename costs that one mutation its art rather than the game its boot.
 */
async function loadLooseMutationParts(
  parts: Readonly<Record<string, MutationPart>>,
  zombiePartTex: Record<string, Texture>,
): Promise<void> {
  await mapConcurrent(
    looseMutationFiles(parts, zombiePartTex), STARTUP_ASSET_CONCURRENCY,
    async (file) => {
      const url = `${BASE}assets/zombie/${looseMutationPath(file)}`;
      try {
        zombiePartTex[file] = (await Assets.load(url)) as Texture;
      } catch {
        console.warn(`[assets] mutation part "${file}" not found at ${url}`);
        noteAssetFailure(url); // ...and into the report, not only the console
      }
    },
  );
}

// Load the complete modular Farmer rig so every market head/body can be equipped.
export async function loadAssets(): Promise<GameAssets> {
  // Pixi's retryCount defaults to 3, but its default strategy is "throw", which
  // means the count is otherwise ignored. Apply this globally so later lazy object,
  // pet, and raid textures receive the same transient-failure protection.
  Assets.loader.loadOptions = {
    ...Assets.loader.loadOptions,
    strategy: "retry",
    retryCount: 3,
    retryDelay: 350,
  };

  const [field, groundIndex, rig, plants, zombies, placeables, boosts, importedQuests,
    reforgedQuests,
    raids, enemyStats, raidAttacks, zombieNames, drops, upgrades, farmer, pets] = await Promise.all([
    json<FieldData>(BASE + "assets/field_default.json"),
    json<GroundIndex>(BASE + "assets/ground_index.json"),
    json<Rig>(BASE + "assets/rig_player.json"),
    json<PlantDef[]>(BASE + "assets/plants.json"),
    json<ZombieDef[]>(BASE + "assets/zombies.json"),
    json<PlaceableDef[]>(BASE + "assets/placeables.json"),
    json<BoostDef[]>(BASE + "assets/boosts.json"),
    json<Record<string, QuestDef>>(BASE + "assets/quests.json"),
    json<Record<string, QuestDef>>(BASE + "assets/quests_reforged.json"),
    json<RaidDef[]>(BASE + "assets/raids/raids.json"),
    json<Record<string, EnemyStat>>(BASE + "assets/raids/enemy_stats.json"),
    json<Record<string, AttackDef>>(BASE + "assets/raids/attacks.json"),
    json<Record<string, string[]>>(BASE + "assets/zombie_names.json"),
    json<Record<string, DropDef>>(BASE + "assets/raids/drops.json"),
    json<UpgradeData>(BASE + "assets/upgrades.json"),
    json<FarmerCatalog>(BASE + "assets/farmer.json"),
    json<PetCatalog>(BASE + "assets/pets/catalog.json"),
  ]);
  // Two quest catalogs, one map. quests.json is GENERATED by tools/prep_quests.py from
  // the original Quests.plist, so anything hand-written there is lost on the next
  // regeneration — the Reforged-original achievements therefore live in their own
  // authored file. Ids are disjoint by construction (imported quests stop at 10011,
  // authored ones start at 20001); the spread puts the authored set last so a
  // collision would at least be deterministic rather than order-dependent.
  const quests: Record<string, QuestDef> = { ...importedQuests, ...reforgedQuests };
  setZombieNames(zombieNames); // seed the random-name picker before any zombie is built
  const invasionBubble = (await Assets.load(
    BASE + "assets/ui/thoughtBubbleBrains.png"
  )) as Texture;

  // Fence panels are 1 tile for placement but their rail is roughly twice that wide and
  // BRIDGES into the next tile, so movement collision extends one tile to match. Which
  // neighbour depends on the flip, and Field.extensionOffsets swaps dc<->dr to follow it.
  //
  // The offset has to be the one the ART actually bridges along, and for these panels
  // that is the ROW axis: measure pen_01.png and the rail rises to the right, which in
  // this projection is -row, with its two posts exactly two row-steps apart. It is the
  // same axis the 1x5 gates run along, which is what lets a run meet a gate end to
  // end. Mirrored, the rail bridges +col instead, and Field.extensionOffsets swaps
  // dc<->dr to follow it. Do not re-derive this axis from a screenshot of a RUN —
  // panels overlap each other by half their length, so a run reads as a wall whichever
  // way it was laid, and it is only the single panel that tells you anything.
  //
  // Field.objectRenderY drops the art half a tile so its posts land on the lattice
  // corners either end of this pair; the two have to agree or the art and the wall it
  // stands for part company.
  //
  // WHICH objects get it is `isFencePanel` — every one-tile barrier in the catalog,
  // derived from the terrain price list rather than named here. This used to be four
  // hard-coded keys, one per fence family, so the six colour variants beside them
  // (Pink / Blue / Red / Black Fence, Pink Iron Fence, Christmas Fence) drew the same
  // two-tile rail while blocking only one tile: a spaced run of any of them looked
  // solid and had a walkable hole at every gap.
  const FENCE_OVERHANG: { dc: number; dr: number }[] | null = [{ dc: 0, dr: 1 }];

  // Flag functional items by key. (TODO: bake these into prep_placeables.py so
  // they're source-driven rather than derived here.)
  for (const p of placeables) {
    // Footprints are whole tiles in the base game (`-[Tile dimensions]` reads
    // tileWidth/tileHeight via integerValue, truncating). Coerce any authored
    // fractional size (e.g. coolerLarge 1.5) to an integer so occupancy and the
    // depth footprint cover exact tiles with no half-tile hole. BEFORE the panel
    // test below, which asks how many tiles the footprint really covers.
    p.tileW = Math.max(1, Math.floor(p.tileW));
    p.tileH = Math.max(1, Math.floor(p.tileH));
    if (FENCE_OVERHANG && isFencePanel(p)) p.collideExtend = FENCE_OVERHANG;
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
    if (p.key === "memorialStatue") p.memorial = true;
  }

  // Load every ground-tile variant texture.
  const ground: Record<string, Texture> = {};
  const groundFiles = Object.values(groundIndex).flat();
  await mapConcurrent(
    groundFiles, STARTUP_ASSET_CONCURRENCY, async (f) => {
      ground[f] = await Assets.load(`${BASE}assets/ground/${f}`);
    },
  );

  // Load the farmer's part textures.
  const player: Record<string, Texture> = {};
  await mapConcurrent(
    Object.keys(rig), STARTUP_ASSET_CONCURRENCY, async (f) => {
      player[f] = await Assets.load(`${BASE}assets/player/${f}`);
    },
  );

  // Load soil-plot textures.
  const soil: Record<string, Texture> = {};
  await mapConcurrent(
    SOIL_FILES, STARTUP_ASSET_CONCURRENCY, async (f) => {
      soil[f] = await Assets.load(`${BASE}assets/soil/${f}`);
    },
  );

  // Load crop-stage textures: every plant's two stages + the generic grown zombie.
  // The shared seed stage reuses the "planted" soil texture (set below).
  const crop: Record<string, Texture> = {};
  const cropFiles = new Set<string>([ZOMBIE_GROWN, ...ZOMBIE_STAGES]);
  for (const p of plants) {
    cropFiles.add(p.stage1);
    cropFiles.add(p.stage2);
  }
  await mapConcurrent(
    [...cropFiles], STARTUP_ASSET_CONCURRENCY, async (f) => {
      crop[f] = await Assets.load(`${BASE}assets/crops/${f}`);
    },
  );
  crop[SEED_FILE] = soil[SEED_FILE]; // seed stage = seeded-soil texture

  // Plants-only companions: the same crop art with its baked soil keyed out, so
  // the plant can be depth-sorted in the entity layer while the dirt renders in
  // a ground layer that never clips a neighbour (see cropTop.ts / Field). The
  // flat seed stage keeps its full texture (it IS just soil).
  const cropTop: Record<string, Texture> = {};
  for (const [f, tex] of Object.entries(crop))
    cropTop[f] = f === SEED_FILE ? tex : makeCropTopTexture(tex, soil[PLOWED_FILE]);

  // Standalone produce art is deliberately separate from the planted stage art.
  // It is shared by Market cards and the crop-only harvest burst.
  const cropIcon: Record<string, Texture> = {};
  await mapConcurrent(
    [...new Set(plants.map((p) => p.icon))], STARTUP_ASSET_CONCURRENCY, async (f) => {
      cropIcon[f] = await Assets.load(`${BASE}assets/crop-icons/${f}`);
    },
  );

  // Per-type zombie models: one shared atlas (ZombieSheet.png) sliced into part
  // sub-textures via frames.json, plus models.json (composition per unit type).
  const [zombieModels, zombieFrames, mutationParts, sheet, enemyModels,
    specialModels, specialFrames, specialSheet, enemyClips, zombieClips] = await Promise.all([
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
    // Animations authored in the Rig Studio, if any have been. Optional by design: a rig
    // with no clip keeps running the procedural pose in EnemyActor/RaidActor, so a
    // missing file is the ordinary case rather than a failure. See raid/clipRuntime.ts.
    json<ClipSet>(BASE + "assets/raids/enemies/clips.json").catch(() => ({})),
    json<ClipSet>(BASE + "assets/zombie/clips.json").catch(() => ({})),
  ]);
  setRigClips("enemy", enemyClips);
  setRigClips("zombie", zombieClips);
  const zombiePartTex: Record<string, Texture> = {};
  for (const [name, f] of Object.entries(zombieFrames)) {
    zombiePartTex[name] = new Texture({
      source: sheet.source,
      frame: new Rectangle(f.x, f.y, f.w, f.h),
    });
  }
  await loadLooseMutationParts(mutationParts, zombiePartTex);

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

  // The static hills-and-sky backdrop that sits behind the farm. Only the grass
  // one is preloaded; the other climates' repaints load when their skin is applied.
  const background = (await Assets.load(BASE + "assets/farm_background.png")) as Texture;
  const backgrounds: Record<string, Texture> = { "farm_background.png": background };

  // Dedicated foliage art (tree + shrubs + bush) for the temperate surroundings —
  // the only scenery that isn't drawn from the placeable-object library. Preloaded
  // because it dresses the default (grass) farm every player starts on.
  const sceneryFiles = ["tree.png", "shrub1.png", "shrub2.png", "shrub3.png"];
  const sceneryTex = await mapConcurrent(
    sceneryFiles,
    STARTUP_ASSET_CONCURRENCY,
    (f) => Assets.load(`${BASE}assets/scenery/${f}`) as Promise<Texture>,
  );
  const scenery: Record<string, Texture> = {};
  sceneryFiles.forEach((f, i) => { scenery[f] = sceneryTex[i]; });

  return {
    field, groundIndex, rig, ground, player, farmer, pets, soil, crop, cropTop, cropIcon,
    invasionBubble,
    zombieModels, enemyModels, zombiePartTex, mutationParts, plants, zombies, placeables, boosts, quests,
    raids, enemyStats, raidAttacks, drops, objects, background, backgrounds, scenery, upgrades,
  };
}

/** Lazily load (and cache) one of the per-climate hills-and-sky backdrops. The
 *  variants are all the same dimensions as the base art, so a swap needs no re-fit. */
export async function ensureBackgroundTexture(
  assets: GameAssets,
  file: string
): Promise<Texture> {
  if (!assets.backgrounds[file]) {
    assets.backgrounds[file] = await Assets.load(`${BASE}assets/${file}`);
  }
  return assets.backgrounds[file];
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

/** Every /assets/objects/ file a placed object draws: its own art, the pre-harvest
 *  frame a fruit tree shows, the far-side layer the Pet Pen renders behind its
 *  contents, the working-state frames the Zombie Pot swaps to, and the cell sheets
 *  an animated decor flips through. Callers preload the whole list — a missing back
 *  layer would leave the pen showing only its near wall, a missing lid would pop the
 *  pot back to idle art mid-combine, and a missing cell sheet would leave a windmill
 *  standing still. */
export function objectSpriteFiles(def: PlaceableDef): string[] {
  return [...new Set(
    [def.sprite, def.growingSprite, def.backSprite, def.busySprite, def.readySprite,
      // Every corner of a road bend, so the Rotate tool never lands on a blank frame.
      // Two of the four share one file, hence the dedupe.
      ...(def.turns ?? []).map((t) => t.sprite),
      ...objectAnimFiles(def)]
      .filter((f): f is string => !!f))];
}

/** The cell sheets an animated decoration flips through. Included in
 *  `objectSpriteFiles` so they preload with everything else, but listed separately
 *  because they are the one part an object can be placed WITHOUT: a sheet that fails
 *  to download costs the motion, not the windmill. */
export function objectAnimFiles(def: PlaceableDef): string[] {
  return [
    ...(def.anim?.layers ?? []).map((l) => l.sheet),
    ...(def.anim?.parts ?? []).map((p) => p.art),
    ...(def.anim?.base ? [def.anim.base] : []),
  ];
}

/** Preload every texture `def` needs before it can be placed on the farm. */
export async function ensureObjectTextures(assets: GameAssets, def: PlaceableDef): Promise<void> {
  await Promise.all(objectSpriteFiles(def).map((file) => ensureObjectTexture(assets, file)));
}
