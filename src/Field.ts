// The isometric terrain. The ground is a fine 30x30 grid of small tiles; farming
// happens on PLOTS — 4x4 tile blocks that can be placed FREELY anywhere a 4x4 area
// is available (not on a fixed lattice). A plot cycles through soil states:
//   plowed -> planted -> (grows) -> harvest -> dirt (crop) / hole (zombie) -> re-till.
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
  canMirrorObject, DIRT_FILE, GameAssets, HOLE_FILE, multiplyObjectTint, objectTint,
  normalizeTurn, PlaceableDef, PLOWED_FILE, SEED_FILE, turnArt, turnCount, turnFlip,
} from "./assets";
import { clampPointToGrid, footprintOrigin, gridToScreen, HH, HW, screenToGrid, TILE_H, TILE_W, tileCenter } from "./iso";
import { setFootprint, sortLayer } from "./depthSort";
import { makeLight, OBJECT_GLOWS } from "./lighting";
import { mintObjectId, objectIdFloor } from "./objectIds";
import {
  advanceObjectAnim, animFrames, createObjectAnim, posePart, REST, triggerObjectAnim,
  type ObjectAnimState,
} from "./objectAnimation";
import {
  COST_AVOID, COST_GROUND, COST_PATH, isGate, objectWalkCost, wormholeSide,
} from "./pathCosts";
import type { Cell, PathOptions } from "./pathfind";
import { leafTexture, ParticleConfig, ParticleField, petalTexture } from "./raid/Particles";
import type { PlacedObjectSave, PlotSave } from "./save/schema";
import { plotsTouch } from "./zombie/cropMutations";
import { sanitizeFallenUncapped, type FallenZombie } from "./zombie/memorial";
import { buildStatueRig } from "./zombie/statueRig";

export const PLOT = 4; // tiles per plot side

/** The tiles a placeable actually covers in a given orientation.
 *
 *  The Rotate tool's "flip" is a horizontal mirror of the art — a reflection of the
 *  screen x axis. In this iso projection screen x is (col - row) and screen y is
 *  (col + row), so mirroring x negates (col - row) and leaves (col + row) alone:
 *  that is EXACTLY a col<->row swap about the object's origin tile. (It is the same
 *  reflection extensionTiles already applies to a fence's overhang offsets.)
 *
 *  So a turned object's footprint is its def rectangle TRANSPOSED. Anything
 *  asymmetric — a 1x5 hedge, a 4x1 banner, a 5x3 tractor — genuinely blocks a
 *  different set of tiles once it is turned, and the art moves with them. Squares
 *  are unaffected, which is why this went unnoticed: 371 of the 460 placeables are
 *  square, and the 89 that are not left an invisible barrier lying across the
 *  diagonal the hedge USED to run down. */
export function objectFootprint(
  def: Pick<PlaceableDef, "tileW" | "tileH">, flipped: boolean,
): { w: number; h: number } {
  return flipped
    ? { w: def.tileH, h: def.tileW }
    : { w: def.tileW, h: def.tileH };
}

/** The orientation a saved object comes back in.
 *
 *  Two fields, because they mean different things: `rotation` is the old mirror flag
 *  every object still writes, and `turn` is the corner index a piece with its own art
 *  per corner writes instead (the road bends). A bend saved before those corners
 *  existed carries `rotation: 1` — a mirror of the ONE corner it had, which was the
 *  same corner drawn a few pixels out of line — so it restores unturned rather than
 *  silently becoming a different corner. */
export function savedTurn(
  def: Pick<PlaceableDef, "turns">, s: { rotation?: number; turn?: number },
): number {
  return def.turns ? (s.turn ?? 0) : (s.rotation ? 1 : 0);
}

// Fertilize leaves: the CONTINUOUS effect a fertilized crop shows the whole time it
// stays fertilized. GROUND TRUTH (`-[Tile applyFarmParticles]`): a cocos2d
// `CCParticleFlower` emitter textured with leafFX.png, ~3 leaves, ~0.75/sec, life ~4s,
// additive, yellow-green tint (0.6,0.7,0.2), sitting above the crop and following it.
// Reproduced here by emitting one leaf every FERT_EMIT_MS through the shared gravity-
// mode ParticleField (a procedural leaf texture, not the soft dot). The gentle swirl
// (source radial/tangential accel) is approximated with a slow rise + settle + spin.
const FERTILIZE_FX: ParticleConfig = {
  maxParticles: 1, // emitted one at a time on a cadence (see FERT_EMIT_MS)
  angle: 90, angleVariance: 60, // drift upward, fanning out
  speed: 26, speedVariance: 12,
  gravityx: 0, gravityy: -18, // cocos y-up: negative → the leaf settles back down on screen
  particleLifespan: 1.7, particleLifespanVariance: 0.5,
  startParticleSize: 16, finishParticleSize: 11,
  sourcePositionVariancex: 20, sourcePositionVariancey: 10,
  startColorRed: 0.6, startColorGreen: 0.7, startColorBlue: 0.2, startColorAlpha: 1, // leafFX yellow-green
  finishColorAlpha: 0,
  rotatePerSecond: 45, // leaves tumble as they drift
  blendFuncDestination: 1, // additive, as in the source
};
const FERT_EMIT_MS = 900; // one leaf ≈ every 0.9s per fertilized crop (source ~0.75/s)
const FERT_CANOPY_DY = 52; // leaves emit this far above the crop's ground contact

// Falling blossom, for the Sakura ground skin — the one climate that dresses the
// farm with WEATHER rather than only with paint and scenery. Nothing in ZF2 does
// this; the source has no ambient climate effect of any kind, so the numbers below
// are authored rather than recovered.
//
// The petals fall over the farm itself, not just past its edges, so they are seeded
// uniformly across the whole field rectangle rather than along its top edge. That
// is what keeps the density even: a top-edge curtain with a survivable lifespan
// only ever fills the top of a 70x70 farm, and a lifespan long enough to cross one
// costs many times the particles for the same look. The price is that a petal
// appears mid-air rather than blowing in, which at 13px and 0.9 alpha is not a
// thing the eye catches.
const SAKURA_PETAL_FX: ParticleConfig = {
  maxParticles: 1, // emitted one at a time on a cadence (see petalEmitMs)
  angle: -90, angleVariance: 22, // downward, fanning slightly
  speed: 21, speedVariance: 9,
  // A steady crosswind (gravityx) plus a gentle downward pull. cocos is y-up, so a
  // NEGATIVE gravityy accelerates the petal down the screen.
  gravityx: 9, gravityy: -11,
  particleLifespan: 5, particleLifespanVariance: 1.4,
  startParticleSize: 16, finishParticleSize: 13,
  // Zero: each petal is positioned individually across the view (randomPetalOrigin).
  sourcePositionVariancex: 0, sourcePositionVariancey: 0,
  // A rose several shades DEEPER than either the blossom art (#ffa2e7) or the
  // ground it falls on. Matching the canopy is the obvious choice and the wrong
  // one: the Sakura skin paints the whole farm pale pink, so a petal the colour of
  // the tree it fell off is pink on pink and disappears — the fall only reads if
  // the petals are darker than everything behind them.
  startColorRed: 0.933, startColorGreen: 0.435, startColorBlue: 0.659, startColorAlpha: 0.95,
  finishColorAlpha: 0,
  rotatePerSecond: 65, // petals tumble as they fall
  blendFuncDestination: 0, // normal, NOT additive — additive turns the pink to white glare
};
const SAKURA_TERRAIN = "sakura";
// Petals alive at once. A flat count, seeded across WHAT THE CAMERA CAN SEE rather
// than across the farm, which is what makes it flat: spreading a per-tile density
// over a 70x70 farm puts almost every petal off-screen, so the budget buys
// invisible weather and the visible fall thins out the more land you own. Seeding
// the view instead keeps the on-screen density identical at every farm size and
// every zoom — the petals live in world space, so zooming out shrinks them and
// widens their spread together, exactly as real distance would.
const PETAL_TARGET_LIVE = 60;
// Fraction of a screen height petals are ALSO seeded above the top of the view, so
// they visibly blow in from off-camera rather than every petal on screen having
// popped into existence inside it.
const PETAL_SPAWN_HEADROOM = 0.25;

// Fruit trees are packed closely enough that a full-sprite rectangular tap target
// makes the transparent space beside one trunk cover its neighbours. Keep a broad
// canopy target, inset just inside the art, and narrow the lower target to the trunk.
const TREE_CANOPY_HEIGHT_RATIO = 0.65;
const TREE_CANOPY_WIDTH_RATIO = 0.92;
const TREE_TRUNK_WIDTH_RATIO = 0.38;

// The Pet Pen's masked near-wall copy sits above every footprint-sorted entity.
// sortLayer only assigns zIndex 0..n-1 to nodes that registered a footprint and
// leaves the rest alone, so any value past the layer's child count is "always last".
const PEN_OVERLAY_Z = 100000;

// Depth-key nudge that puts a two-layer object's NEAR art after its far wall — the two
// share one footprint, so without it their order is whatever the child list happens to
// be. Deliberately far below every actor bias (pets 0.4, zombies 0.5, farmer 0.6): it
// must separate the pair without ever tying with, or overtaking, a character.
const BACK_LAYER_BIAS = 0.1;

// The stone zombie standing on a Memorial Statue shares the plinth's footprint, so
// it needs a nudge to draw in FRONT of it. Kept under every actor bias (pets 0.4,
// zombies 0.5, farmer 0.6) so a character crossing the memorial's tiles still walks
// in front of the statue rather than behind it.
const MEMORIAL_RIG_BIAS = 0.2;

export interface CropConfig {
  key: string;
  name: string;
  // stages[0] is the "seed" stage (seeded soil for crops, a gravestone for zombies);
  // the rest are the growth art.
  stages: string[];
  growMs: number;
  cost: number; // gold (or brains, if brainsNeeded) to plant
  brainsNeeded?: boolean; // cost is paid in brains, not gold (special zombies)
  sell: number; // gold on harvest
  xp: number; // xp granted on harvest
  unlockLevel: number; // player level required to plant
  unlockGrave?: "Blue" | "Red" | "Silver"; // zombie: needs this colored grave placed
  isZombie?: boolean; // harvest leaves a hole (vs. a dirt square)
  isMutant?: boolean; // mutant-tier zombie: grows in half the time with a Mutant Monolith
  harvestIcon?: string; // standalone produce art; full stages are farm-only
}

export interface ZombieMutationContext {
  cropKeys: string[];
  guaranteed: boolean;
}

export interface HarvestResult {
  sell: number;
  xp: number;
  growMs: number;
  /** The plants.json crop key. `name` is the display string and is not stable enough to
   *  match on — the Epic Boss favourite-crop pairings key off this. */
  key: string;
  name: string;
  isZombie: boolean;
  fertilized: boolean;
  /** Standalone produce texture used by the collection fly-up animation. */
  icon: string;
  zombieKey?: string;
  mutationContext?: ZombieMutationContext;
}
/** Crops whose GROWING art is a piece of ground, not something standing on it.
 *
 *  The ordinary split render (see layoutCrop) puts the plant half in the depth-sorted
 *  entityLayer so a tall crop can legitimately hide an actor walking behind it. The
 *  Water Lily's middle stage is a pond: one flat isometric diamond filling the plot
 *  with nothing standing above the water, so being sorted at all means the farmer and
 *  any zombie crossing the plot vanish under it. That stage is treated like the flat
 *  seed stage instead — cropSeedLayer, no footprint, never sorts — so characters
 *  always walk OVER it.
 *
 *  The exception stops at the RIPE stage: that art grows a tall flower well clear of
 *  the water, so it takes the ordinary split path like every other crop and is allowed
 *  to occlude whatever stands behind it.
 *
 *  Keyed by CROP KEY, in code, on purpose: plants.json is regenerated wholesale by
 *  tools/prep_market.py, which silently drops hand-added fields (see
 *  tools/reforge_economy.py on the same trap). */
const FLAT_GROWTH_CROPS: ReadonlySet<string> = new Set(["water_lily"]);

/** Does this stage render as pure ground — flat, unsorted, below every entity? True
 *  for the shared seed stage of any crop, and for the pre-ripe stages of the crops
 *  above (never their final stage). */
function isFlatStage(cfg: CropConfig, stageFile: string): boolean {
  if (stageFile === SEED_FILE) return true;
  return FLAT_GROWTH_CROPS.has(cfg.key) && stageFile !== cfg.stages[cfg.stages.length - 1];
}

export const CARROT: CropConfig = {
  key: "carrot",
  name: "Carrots",
  stages: [SEED_FILE, "carrot_stage1.png", "carrot_stage2.png"],
  growMs: 15000,
  cost: 5,
  sell: 16,
  xp: 1,
  unlockLevel: 1,
  harvestIcon: "stex0006.png",
};

type PlotState = "plowed" | "planted" | "dirt" | "hole";

interface Planting {
  cfg: CropConfig;
  // Absolute epoch (ms) this crop was planted — the SOURCE OF TRUTH for growth.
  // Age is derived every frame as clamp(now - plantedAt, 0, staleAge), so growth
  // tracks real wall-clock time and cannot stall when the tab is backgrounded (the
  // render loop's dt is throttled/clamped there) or while the game is fully closed.
  plantedAt: number;
  // Per-frame cache of the derived age (now - plantedAt), refreshed in update(). Read
  // by ripeness/harvest checks; never the authority — plantedAt is.
  ageMs: number;
  sprite: Sprite; // plants-only, depth-sorted in the entity layer (like objects)
  // The soil half, drawn in cropGroundLayer beneath every entity. Only present
  // once the crop has grown past the flat seed stage. Pixel-aligned with sprite.
  groundSprite?: Sprite;
  stageFile?: string; // current stage texture filename (guards re-layout)
  baseY: number;
  fertilized?: boolean; // a Garden zombie fertilized it → 2x harvest + leaf FX
  fertEmitMs?: number; // countdown to the next leaf emit (fertilized crops only)
}
// Destroy both halves of a crop (the entity-layer plants sprite and the optional
// ground-layer soil copy). Both auto-remove from their parent on destroy.
function destroyCrop(c: Planting) {
  c.sprite.destroy();
  c.groundSprite?.destroy();
}
interface Plot {
  oc: number; // origin tile (north corner of the 4x4)
  or: number;
  soil: Sprite;
  state: PlotState;
  crop?: Planting;
}

export interface TillTarget {
  oc: number;
  or: number;
  valid: boolean; // can till here (place new plot or re-till dirt/hole)
}

export type TillHandleDirection = "col-" | "col+" | "row-" | "row+";

/** What a working object is doing, when that changes its art: "busy" = running,
 *  "ready" = finished and waiting to be collected. Null/absent = idle. */
export type ObjectWork = "busy" | "ready";

// A placed farm object (tree/decor) occupying a tileW x tileH footprint.
interface FarmObject {
  id: string;
  def: PlaceableDef;
  oc: number; // footprint origin (north tile)
  or: number;
  sprite: Sprite;
  // Two-layer objects (the Pet Pen): `backSprite` is the source's childNode art — the
  // far wall — sorted just BEHIND the main sprite so pen contents stand between them.
  backSprite?: Sprite;
  // The near wall must cover the pets inside the pen even though they stand "in front"
  // of the pen's footprint. A second copy of the main art, masked to those pets'
  // silhouettes and pinned above the whole layer, does that without inverting the
  // object's ordering against characters outside the pen.
  frontOverlay?: Container;
  frontMask?: Graphics;
  // Animated decor (windmill, geyser, koi pond, …): the flipbook driving `sprite`
  // and, for the two objects with a second layer, its child sprites.
  anim?: ObjectAnimState;
  light?: Sprite; // additive night glow (glowing objects only), lives in the night layer
  // Fruit trees only: readyAt = epoch ms the fruit ripens; ready = fruit present.
  readyAt: number;
  ready: boolean;
  // Functional objects that LOOK different while they work (the Zombie Pot: lid on
  // while a combine cooks, the new zombie's arm out once it is done). Driven from
  // the owning system through setObjectWork, since the job lives outside the Field.
  work?: ObjectWork;
  // Rotated by the Rotate tool: a horizontal mirror (flip on the vertical axis), so
  // a directional decor (fences! hedges!) can face either diagonal. In iso that
  // mirror reflects col<->row, so a flipped object's footprint is its def rectangle
  // TRANSPOSED — see objectFootprint. Every occupancy/anchor/depth read goes through
  // that helper, never through def.tileW/tileH directly.
  flipped: boolean;
  // Which orientation this object is in: an index into `def.turns` for a piece whose
  // corners are separate art (the road bends), otherwise 0 or 1 for unmirrored /
  // mirrored. `flipped` is DERIVED from it (turnFlip) and never set independently.
  turn: number;
  // Memorial Statue only: the zombie enshrined on it, and the stone rig drawn
  // standing on its plinth. `memorialRig` is derived — rebuilt whenever `memorial`
  // changes — so only the snapshot is ever persisted.
  memorial?: FallenZombie;
  memorialRig?: Container;
}

export class Field {
  /** Fired with a Memorial Statue's occupant when the statue itself is removed from
   *  the farm, so the graveyard takes the zombie back instead of losing them with
   *  the object. Never fires for a load/restore, which rebuilds statues wholesale. */
  onMemorialReleased: ((fallen: FallenZombie) => void) | null = null;
  readonly container = new Container();
  readonly groundLayer = new Container();
  readonly plotLayer = new Container();
  // Plow selection/queued markers belong with the soil: actors and grown crops
  // must paint over them just as they do over ordinary plowed ground.
  readonly plowHighlightLayer = new Container();
  // Seed-stage crops live here — ABOVE the soil but BELOW the entity layer, so a
  // just-seeded plot layers exactly like plain plowed soil (actors always draw over
  // it). Once a crop grows past the seed stage it graduates to the entity layer and
  // depth-sorts by its footprint like any object. See layoutCrop.
  readonly cropSeedLayer = new Container();
  // The soil half of every GROWN crop. A crop renders as two pixel-aligned
  // sprites: its untouched art here (below the entity layer, so its baked dirt
  // can never draw over anything) and a soil-keyed plants-only copy up in the
  // entity layer. This is what stops a plot's dirt from clipping the tall
  // crop/zombie on the plot behind it. See layoutCrop and cropTop.ts.
  readonly cropGroundLayer = new Container();
  readonly groundObjectLayer = new Container();
  readonly highlightLayer = new Container();
  readonly labelLayer = new Container();
  // Shared, depth-sorted layer holding placed objects AND the actors (farmer/
  // zombie), so the farmer correctly walks in front of / behind trees. main adds
  // the actor + zombie containers here and adds this layer to the world.
  readonly entityLayer = new Container();
  // Farm particle FX (fertilize leaves). main parents this ABOVE entityLayer so the
  // leaves draw over crops/actors. The leaves are tinted per the fertilize colour.
  readonly fxLayer = new Container();
  private fx = new ParticleField(leafTexture());
  // Sakura blossom, on its own field because a ParticleField owns ONE texture and
  // petals are not leaves. Built on demand: every farm pays for the fertilize
  // leaves, but only a farm actually wearing the Sakura skin should pay for a
  // second canvas texture, container and pool. See tickSakuraPetals.
  private petals: ParticleField | null = null;
  private petalEmitMs = 0;
  // What the camera can currently see, in world coordinates. main pushes this each
  // frame (setViewBounds); until it does, the petals fall over the farm rectangle
  // instead, which is what a headless test or the very first frame gets.
  private viewBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  // Night lights for glowing objects. main parents this into the NightLayer, which
  // erases them out of the darkness so a glow reveals the scene around it at night.
  readonly objectLights = new Container();
  readonly cursor = new Container();
  readonly tillSelectionLayer = new Container();
  private tillSelection = new Graphics();
  private tillSelectionHandles = new Map<TillHandleDirection, { x: number; y: number }>();
  private cursorGreen = new Graphics();
  private cursorRed = new Graphics();
  private cursorLabel!: Text;
  private objGhost = new Sprite(); // placement/move preview
  private ghostTurnIndex = 0; // current orientation of the placement ghost (see turnArt)
  // What the ghost is previewing, so flipping it in place can re-derive the flat-tile
  // anchor offset (which is not symmetric about the footprint's bottom-center).
  private ghostDef: PlaceableDef | null = null;
  // The pointer tile the ghost was last resolved against, and the object being moved
  // (if any), so a rotate can re-resolve the preview without a pointer move.
  private ghostTile: { col: number; row: number } | null = null;
  private ghostIgnoreId: string | undefined;
  // Field dimensions in tiles. Mutable: the Farm Size upgrade grows them at
  // runtime (origin stays at tile 0,0, so all existing plots/objects keep their
  // coordinates — the farm only gains land on its south/east edges).
  w = 0;
  h = 0;
  // Current ground/climate skin (a ground_index terrain key). The whole farm's
  // terrain tiles use this; changed by a Market → Upgrade → Ground purchase.
  climate = "grass";
  // Fired after the skin actually changes — including when a save load applies a
  // stored one. main uses it to re-theme everything OUTSIDE the farm (the scenery
  // ring, the hills backdrop, the viewport filler) to match. See surroundings.ts.
  onClimateChange: ((terrain: string) => void) | null = null;
  /** Plays a cue an animation reached (the Parrot's squawk, the Taiko Drum's hits).
   *  Bound to the audio mixer by main; a bare Field just animates silently. */
  playAnimationSound: (file: string) => void = () => {};

  private ground: Sprite[][] = [];
  private plots = new Map<string, Plot>(); // key "oc,or"
  private tilePlot = new Map<string, string>(); // tile "col,row" -> plot key
  private reserved = new Set<string>(); // tiles reserved by queued (not-yet-done) tills
  private objects = new Map<string, FarmObject>(); // id -> object
  private tileObject = new Map<string, string>(); // tile "col,row" -> object id (placement occupancy)
  // Extra MOVEMENT-only blocks beyond an object's placement footprint (fence panels
  // that overhang into a neighbour tile). Keyed tile -> set of object ids blocking it,
  // so overlapping overhangs (two fences meeting) and removal stay correct.
  private fenceBlock = new Map<string, Set<string>>();
  // Wormhole links, built on demand from the placed pads and dropped whenever
  // placement changes. See portalMap().
  private portals: Map<string, Cell> | null = null;
  // Whether a path has been laid anywhere on the farm. Same lifetime as `portals`.
  private paths: boolean | null = null;
  // The shared search options handed to every walker. Same lifetime again.
  private walkOpts: PathOptions | null = null;
  private nextObjId = 1;
  private highlightedObj: string | null = null;

  constructor(private assets: GameAssets) {
    this.groundObjectLayer.sortableChildren = true;
    this.entityLayer.sortableChildren = true;
    this.resize(assets.field.w, assets.field.h); // builds the initial ground grid
    this.buildCursor();
    this.tillSelectionLayer.addChild(this.tillSelection);
    this.objGhost.anchor.set(0.5, 1);
    this.objGhost.visible = false;
    this.cursor.addChild(this.objGhost);
    this.cropGroundLayer.sortableChildren = true;
    // NOTE: highlightLayer is intentionally NOT parented here. It must draw ABOVE
    // the entity layer so the green job diamond is not occluded by a ripe crop's
    // tall sprite (which graduates into entityLayer) — otherwise the top of the
    // harvest highlight gets clipped by the crop. main parents it above entityLayer.
    this.container.addChild(
      this.groundLayer, this.plotLayer, this.plowHighlightLayer,
      this.cropSeedLayer, this.cropGroundLayer,
      this.groundObjectLayer
    );
    this.plowHighlightLayer.addChild(this.tillSelectionLayer);
    this.fxLayer.addChild(this.fx.container);
  }

  private fit(sp: Sprite, tex: Texture, col: number, row: number, tiles: number) {
    sp.texture = tex;
    sp.anchor.set(0.5, 0);
    const scale = (tiles * TILE_W) / tex.width;
    sp.scale.set(scale);
    const p = gridToScreen(col, row);
    const gap = (tiles * TILE_H - tex.height * scale) / 2;
    sp.position.set(p.x, p.y + gap);
  }

  // Per-tile texture VARIANT (stable). The authored base-field asset supplies a
  // variant for its tiles; tiles beyond it (revealed by a Farm Size upgrade) use a
  // deterministic per-tile hash so an expanded farm looks continuous. The terrain
  // itself is always the current climate (see baseTile), so a ground skin repaints
  // the whole farm while keeping each tile's variety.
  private tileVariant(col: number, row: number): number {
    const t = this.assets.field.tiles[row]?.[col];
    if (t) return t.variant;
    return ((col * 73856093) ^ (row * 19349663)) >>> 0; // stable per-tile hash
  }

  private baseTile(col: number, row: number): { terrain: string; variant: number } {
    return { terrain: this.climate, variant: this.tileVariant(col, row) };
  }

  /** Repaint every ground tile to a new climate/terrain skin, keeping each tile's
   *  variant so the texture variety is preserved. No-op if unchanged. */
  setClimate(terrain: string) {
    if (terrain === this.climate) return;
    const { groundIndex, ground } = this.assets;
    if (!groundIndex[terrain]) return; // unknown terrain -> leave as-is
    this.climate = terrain;
    const variants = groundIndex[terrain];
    for (let row = 0; row < this.ground.length; row++) {
      const line = this.ground[row];
      if (!line) continue;
      for (let col = 0; col < line.length; col++) {
        const sp = line[col];
        if (!sp) continue;
        const file = variants[this.tileVariant(col, row) % variants.length];
        this.fit(sp, ground[file], col, row, 1);
      }
    }
    this.onClimateChange?.(terrain);
  }

  /** Grow the ground grid to at least nw x nh tiles (never shrinks). Only the
   *  newly-revealed tiles get sprites; existing ground is untouched. Origin stays
   *  at tile 0,0 so every placed plot/object keeps its coordinates. */
  resize(nw: number, nh: number) {
    nw = Math.max(this.w, Math.round(nw));
    nh = Math.max(this.h, Math.round(nh));
    if (nw === this.w && nh === this.h) return;
    const { groundIndex, ground } = this.assets;
    for (let row = 0; row < nh; row++) {
      if (!this.ground[row]) this.ground[row] = [];
      for (let col = 0; col < nw; col++) {
        if (this.ground[row][col]) continue; // already built
        const t = this.baseTile(col, row);
        const variants = groundIndex[t.terrain] ?? groundIndex["grass"];
        const file = variants[t.variant % variants.length];
        const sp = new Sprite();
        this.fit(sp, ground[file], col, row, 1);
        this.groundLayer.addChild(sp);
        this.ground[row][col] = sp;
      }
    }
    this.w = nw;
    this.h = nh;
  }

  /** Set the server-owned farm boundary exactly. Used only during online state
   * overlay; ordinary gameplay still uses grow-only resize(). */
  resizeAuthoritative(nw: number, nh: number) {
    nw = Math.max(1, Math.round(nw));
    nh = Math.max(1, Math.round(nh));
    if (nw >= this.w && nh >= this.h) {
      this.resize(nw, nh);
      return;
    }
    for (let row = 0; row < this.ground.length; row++) {
      const line = this.ground[row];
      if (!line) continue;
      for (let col = 0; col < line.length; col++) {
        if (row < nh && col < nw) continue;
        line[col]?.destroy();
      }
      line.length = Math.min(line.length, nw);
    }
    this.ground.length = Math.min(this.ground.length, nh);
    this.w = nw;
    this.h = nh;
  }

  // Plot cursor: a PLOT-sized diamond. Green when the action is valid, red when not,
  // with a tool label. (No plain hover cursor — the select tool shows nothing.)
  private buildCursor() {
    const w = PLOT * HW;
    const h = PLOT * HH;
    const diamond = (g: Graphics, color: number) => {
      g.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h);
      g.fill({ color, alpha: 0.28 });
      g.stroke({ width: 4, color, alpha: 1 });
    };
    diamond(this.cursorGreen, 0x8df25a);
    diamond(this.cursorRed, 0xff5a5a);
    this.cursorLabel = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif", fontSize: 22, fontWeight: "700",
        fill: 0xffffff, stroke: { color: 0x1a2a10, width: 5 },
      },
    });
    this.cursorLabel.anchor.set(0.5, 1);
    this.cursorLabel.position.set(0, -h - 6);
    this.cursor.addChild(this.cursorGreen, this.cursorRed, this.cursorLabel);
    this.cursor.visible = false;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.w && row < this.h;
  }

  /** What one step onto this tile costs a walker: `COST_GROUND` for plots and bare
   *  ground, less on a path, more in a pond, ruinously more through a hedge, and
   *  `Infinity` for a solid object or anything off the field. src/pathCosts.ts owns
   *  the table and explains the ordering. */
  tileCost(col: number, row: number): number {
    if (!this.inBounds(col, row)) return Infinity;
    const k = `${col},${row}`;
    const own = this.tileObject.get(k);
    const def = own ? this.objects.get(own)?.def : undefined;
    const cost = def ? objectWalkCost(def) : COST_GROUND;
    if (!Number.isFinite(cost)) return Infinity;
    // A fence panel overhanging from a neighbour tile is as hard to cross as the
    // fence it belongs to, even though nothing "owns" this tile for placement.
    //
    // A GATE is the deliberate hole in a fence run, and the last fence in the run
    // bridges into the gate's tile (see objectAnchor) — so a gate keeps its own
    // price. Otherwise sealing a pen would seal its door too.
    const ext = this.fenceBlock.get(k);
    if (ext?.size && !(def && isGate(def))) {
      let worst = cost;
      for (const oid of ext) {
        const o = this.objects.get(oid);
        if (o) worst = Math.max(worst, objectWalkCost(o.def));
      }
      return worst;
    }
    return cost;
  }

  // Can an actor walk on this tile at all? Only solid objects and the field edge say
  // no; a hedge is merely expensive. Used by pathfinding (farmer + wandering zombies).
  isPassable(col: number, row: number): boolean {
    return Number.isFinite(this.tileCost(col, row));
  }

  /** Is this tile somewhere a walker would happily BE — grass, a path, a plot, even
   *  a pond, but not a hedge or a closed gate? Destinations and arrival spots go
   *  through this; only the pathfinder itself may cross a barrier. */
  isOpenGround(col: number, row: number): boolean {
    return this.tileCost(col, row) < COST_AVOID;
  }

  /** Where stepping onto this tile comes out, for the tiles of a linked wormhole
   *  pad — otherwise null. */
  portalExit(col: number, row: number): Cell | null {
    return this.portalMap().get(`${col},${row}`) ?? null;
  }

  /** Is there a working wormhole pair on the farm? A walk that would otherwise be a
   *  plain straight line has to be searched properly once there is, or the shortcut
   *  is only ever taken by accident. */
  hasPortals(): boolean {
    return this.portalMap().size > 0;
  }

  /** Is anything on the farm CHEAPER to walk on than bare ground — i.e. has a path
   *  been laid? Same reason as hasPortals: a straight line over plain grass is
   *  already the best route there is until a road exists to be drawn onto. */
  hasPaths(): boolean {
    if (this.paths === null) {
      this.paths = false;
      for (const o of this.objects.values()) {
        if (objectWalkCost(o.def) < COST_GROUND) { this.paths = true; break; }
      }
    }
    return this.paths;
  }

  /** The options every walker on this farm searches with: its bounds, its terrain
   *  prices, and its wormholes.
   *
   *  Held rather than rebuilt, because a wandering zombie asks for these once per
   *  candidate destination — up to a dozen per re-target, for every unit on the farm —
   *  and the answer only changes when the placement does. Callers that want a variant
   *  (the farmer's `crossBarriers`) spread it into their own object, so the shared one
   *  is never written to. */
  pathOptions(): PathOptions {
    if (this.walkOpts) return this.walkOpts;
    const opts: PathOptions = {
      inBounds: (c, r) => this.inBounds(c, r),
      cost: (c, r) => this.tileCost(c, r),
      minTileCost: COST_PATH,
      // Hedges and shut gates are walls first and expensive second — see findPath.
      // Callers opt into crossing one; by default a route simply goes round or not
      // at all, which is what makes a fenced pen actually hold anything.
      avoidCost: COST_AVOID,
    };
    // Only once a pair is actually placed: `portal` costs the search its heuristic,
    // which is not a price worth paying on a farm with no wormholes on it.
    if (this.hasPortals()) opts.portal = (c, r) => this.portalExit(c, r);
    return (this.walkOpts = opts);
  }

  // Wormhole pads: tile -> the tile stepping onto it comes out at. Rebuilt lazily
  // after any placement change (see topologyChanged).
  //
  // Pads pair off A-with-B in placement order, so a farm with two of each has two
  // independent links rather than one four-way junction; a lone pad with no partner
  // is inert decor. Both tiles of a 1x2 pad lead to the same exit — the partner's
  // origin tile — and the partner leads back, which makes the link an ordinary
  // bidirectional edge in the search graph.
  private portalMap(): Map<string, Cell> {
    if (this.portals) return this.portals;
    const map = new Map<string, Cell>();
    const sides: Record<"A" | "B", FarmObject[]> = { A: [], B: [] };
    for (const o of this.objects.values()) {
      const side = wormholeSide(o.def);
      if (side) sides[side].push(o);
    }
    const order = (a: FarmObject, b: FarmObject) => a.oc - b.oc || a.or - b.or;
    sides.A.sort(order);
    sides.B.sort(order);
    const pairs = Math.min(sides.A.length, sides.B.length);
    for (let i = 0; i < pairs; i++) {
      this.linkPad(map, sides.A[i], sides.B[i]);
      this.linkPad(map, sides.B[i], sides.A[i]);
    }
    return (this.portals = map);
  }
  private linkPad(map: Map<string, Cell>, from: FarmObject, to: FarmObject) {
    const exit = { col: to.oc, row: to.or };
    const fp = objectFootprint(from.def, from.flipped);
    this.forEachFootprint(from.oc, from.or, fp.w, fp.h, (t) => map.set(t, exit));
  }
  // Placement changed, so what is derived from it may have. Called from the one
  // place every add / move / rotate / remove funnels through.
  private topologyChanged() {
    this.portals = null;
    this.paths = null;
    // Whether the shared options carry a `portal` is derived from the pads, so the
    // options go too.
    this.walkOpts = null;
  }

  private key(oc: number, or: number) {
    return `${oc},${or}`;
  }
  // A 4x4 plot at (oc,or) fits fully inside the field.
  private fits(oc: number, or: number): boolean {
    return oc >= 0 && or >= 0 && oc + PLOT - 1 < this.w && or + PLOT - 1 < this.h;
  }
  // A tile is occupied if a plot, a queued till reservation, or an object holds
  // it. `ignoreObj` skips tiles owned by one object (used while moving it).
  private tileOccupied(c: number, r: number, ignoreObj?: string): boolean {
    const k = `${c},${r}`;
    if (this.tilePlot.has(k) || this.reserved.has(k)) return true;
    const oid = this.tileObject.get(k);
    return oid !== undefined && oid !== ignoreObj;
  }
  // None of the plot's 16 tiles are already occupied.
  private areaFree(oc: number, or: number): boolean {
    for (let r = or; r < or + PLOT; r++)
      for (let c = oc; c < oc + PLOT; c++)
        if (this.tileOccupied(c, r)) return false;
    return true;
  }
  // Where a freshly-placed plot would be anchored for a pointer at (col,row):
  // centered on the pointer. A 4x4 diamond's visual center picks as origin + 2
  // (screenToGrid rounds the half-tile center up), so subtract half the footprint.
  // Keeping this inverse of plotCenterOf is especially important for the tutorial:
  // its arrow points at that center and its input gate expects the same origin.
  private originFor(col: number, row: number) {
    return footprintOrigin(col, row, PLOT);
  }
  private forEachTile(oc: number, or: number, fn: (k: string) => void) {
    for (let r = or; r < or + PLOT; r++)
      for (let c = oc; c < oc + PLOT; c++) fn(`${c},${r}`);
  }

  // The existing plot origin whose 4x4 covers this tile, or null.
  plotOriginAt(col: number, row: number): { oc: number; or: number } | null {
    const pk = this.tilePlot.get(`${col},${row}`);
    if (!pk) return null;
    const p = this.plots.get(pk)!;
    return { oc: p.oc, or: p.or };
  }
  plotCenterOf(oc: number, or: number): { x: number; y: number } {
    const p = gridToScreen(oc, or);
    return { x: p.x, y: p.y + PLOT * HH };
  }

  // Where a till action at (col,row) would go and whether it's valid: re-till an
  // existing dirt/hole plot, or place a new plot where a 4x4 fits & is free.
  resolveTill(col: number, row: number): TillTarget {
    const at = this.plotOriginAt(col, row);
    if (at) {
      const st = this.plots.get(this.key(at.oc, at.or))!.state;
      return { oc: at.oc, or: at.or, valid: st === "dirt" || st === "hole" };
    }
    const { oc, or } = this.originFor(col, row);
    return { oc, or, valid: this.fits(oc, or) && this.areaFree(oc, or) };
  }

  canPlant(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const p = this.plots.get(this.key(at.oc, at.or))!;
    return p.state === "plowed" && !p.crop;
  }
  isRipe(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const c = this.plots.get(this.key(at.oc, at.or))!.crop;
    return !!c && c.ageMs >= c.cfg.growMs;
  }
  hasCrop(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    return !!at && !!this.plots.get(this.key(at.oc, at.or))!.crop;
  }
  // Inspect the crop growing on the plot under (col,row): its type name, whether
  // it's a zombie, whether it's ripe, and how much grow time remains. Null when
  // the plot has no crop. Powers the "growing crop" info popup.
  cropInfoAt(col: number, row: number):
    { name: string; isZombie: boolean; ripe: boolean; remainingMs: number; growMs: number; fertilized: boolean } | null {
    const at = this.plotOriginAt(col, row);
    if (!at) return null;
    const c = this.plots.get(this.key(at.oc, at.or))!.crop;
    if (!c) return null;
    return {
      name: c.cfg.name,
      isZombie: !!c.cfg.isZombie,
      ripe: c.ageMs >= c.cfg.growMs,
      remainingMs: Math.max(0, c.cfg.growMs - c.ageMs),
      growMs: c.cfg.growMs,
      fertilized: !!c.fertilized,
    };
  }
  // A ripe crop that is a zombie (harvesting it would grow an owned unit). Used to
  // enforce the army cap before enqueuing the harvest.
  ripeZombieAt(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const c = this.plots.get(this.key(at.oc, at.or))!.crop;
    return !!c && c.ageMs >= c.cfg.growMs && !!c.cfg.isZombie;
  }

  // Remove the plot under (col,row) entirely (destroy any crop, free its tiles,
  // revert to bare ground). Used by the Remove tool.
  /** Origin a plot would take for a pointer at (col,row) — centred on the pointer,
   *  the same anchoring a freshly plowed plot uses. */
  plotOriginFor(col: number, row: number): { oc: number; or: number } {
    return this.originFor(col, row);
  }

  /** Is this plot one the Move tool may pick up?
   *
   *  Only a BARE tilled plot moves. Anything growing stays put: a crop's value and
   *  its mutation adjacency are decided where it sits, so letting a planted plot
   *  wander would make the farm's layout mid-grow a thing to game rather than plan.
   *  Spent dirt and holes are not tilled ground and stay put too. */
  canMovePlot(oc: number, or: number): boolean {
    const plot = this.plots.get(this.key(oc, or));
    return !!plot && plot.state === "plowed" && !plot.crop;
  }

  /** Can the plot at (fromOc,fromOr) be relocated to (toOc,toOr)?
   *
   *  The destination is allowed to overlap the plot's OWN tiles — nudging a plot one
   *  tile along is the common case, and it would otherwise collide with itself. */
  canMovePlotTo(fromOc: number, fromOr: number, toOc: number, toOr: number): boolean {
    if (!this.canMovePlot(fromOc, fromOr)) return false;
    if (!this.fits(toOc, toOr)) return false;
    const own = new Set<string>();
    this.forEachTile(fromOc, fromOr, (k) => own.add(k));
    for (let r = toOr; r < toOr + PLOT; r++)
      for (let c = toOc; c < toOc + PLOT; c++)
        if (!own.has(`${c},${r}`) && this.tileOccupied(c, r)) return false;
    return true;
  }

  /** Relocate a whole plot, carrying whatever grows on it.
   *
   *  Layout only: the Planting keeps its `plantedAt`, so growth is untouched — a crop
   *  moved mid-grow ripens exactly when it always would have. */
  movePlot(fromOc: number, fromOr: number, toOc: number, toOr: number): boolean {
    const fromKey = this.key(fromOc, fromOr);
    const plot = this.plots.get(fromKey);
    // Check movability BEFORE the same-origin shortcut, so a planted plot cannot
    // report a successful "move" just by being dropped where it already is.
    if (!plot || !this.canMovePlot(fromOc, fromOr)) return false;
    if (fromOc === toOc && fromOr === toOr) return true;
    if (!this.canMovePlotTo(fromOc, fromOr, toOc, toOr)) return false;

    // Release the old tiles BEFORE claiming the new ones: the two footprints can
    // overlap, and the destination must not inherit a stale claim.
    this.forEachTile(fromOc, fromOr, (t) => this.tilePlot.delete(t));
    this.plots.delete(fromKey);
    plot.oc = toOc;
    plot.or = toOr;
    const toKey = this.key(toOc, toOr);
    this.plots.set(toKey, plot);
    this.forEachTile(toOc, toOr, (t) => this.tilePlot.set(t, toKey));

    this.fit(plot.soil, plot.soil.texture, toOc, toOr, PLOT);
    if (plot.crop) {
      // Re-layout re-parents by stage, so pass the stage the crop is actually on.
      plot.crop.baseY = this.layoutCrop(
        plot.crop, plot.crop.stageFile ?? plot.crop.cfg.stages[0], toOc, toOr);
    }
    return true;
  }

  /** Ghost for the Move tool while a plot is in hand: the destination footprint,
   *  green when it can land there. Returns the resolved origin. */
  setPlotMoveCursor(col: number, row: number, fromOc: number, fromOr: number):
    { oc: number; or: number; valid: boolean } {
    this.objGhost.visible = false; // the plot ghost and the object ghost are exclusive
    const { oc, or } = this.originFor(col, row);
    const valid = this.canMovePlotTo(fromOc, fromOr, oc, or);
    const c = this.plotCenterOf(oc, or);
    this.cursor.position.set(c.x, c.y);
    this.cursorGreen.visible = valid;
    this.cursorRed.visible = !valid;
    this.cursorLabel.visible = true;
    this.cursorLabel.text = "Move";
    this.cursor.visible = true;
    return { oc, or, valid };
  }

  removePlot(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const k = this.key(at.oc, at.or);
    const p = this.plots.get(k);
    if (!p) return false;
    if (p.crop) destroyCrop(p.crop); // both crop halves; auto-remove from parents
    this.plotLayer.removeChild(p.soil);
    p.soil.destroy();
    this.forEachTile(at.oc, at.or, (t) => this.tilePlot.delete(t));
    this.plots.delete(k);
    return true;
  }

  // A harvested plot (dirt or hole) that can be re-tilled by interacting with it.
  isSpent(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const st = this.plots.get(this.key(at.oc, at.or))!.state;
    return st === "dirt" || st === "hole";
  }

  // ---- whole-farm boost effects (Insta-Grow / Insta-Harvest / Insta-Plow) ----

  /** Insta-Grow: instantly ripen up to `n` still-growing crops. Returns the count
   *  ripened (fewer if the farm has fewer growing crops). When `priority` names a
   *  plot with a growing crop, that crop is ripened FIRST (so activating the boost
   *  from a crop's own info window always grows the crop the player tapped). */
  growSomeCrops(n: number, priority?: { col: number; row: number }): { oc: number; or: number }[] {
    const grown: { oc: number; or: number }[] = [];
    if (priority) {
      const at = this.plotOriginAt(priority.col, priority.row);
      const c = at ? this.plots.get(this.key(at.oc, at.or))!.crop : undefined;
      if (c && c.ageMs < c.cfg.growMs && grown.length < n) {
        this.ripenNow(c); // now ripe; the loop below skips it (age >= growMs)
        grown.push({ oc: at!.oc, or: at!.or });
      }
    }
    for (const p of this.plots.values()) {
      if (grown.length >= n) break;
      const c = p.crop;
      if (c && c.ageMs < c.cfg.growMs) {
        this.ripenNow(c);
        grown.push({ oc: p.oc, or: p.or });
      }
    }
    if (grown.length) this.update(0); // refresh growth-stage textures to the ripe frame now
    return grown;
  }

  /** Ripen exactly the crop at (col,row) if it is still growing — the manual
   *  Insta-Grow tool targets one plot per tap. Returns its authoritative plot
   *  origin, or null for empty/ripe/out-of-bounds plots so a stray tap never
   *  wastes a use or ripens some other plot. */
  growCropAt(col: number, row: number): { oc: number; or: number } | null {
    const at = this.plotOriginAt(col, row);
    if (!at) return null;
    const c = this.plots.get(this.key(at.oc, at.or))?.crop;
    if (!c || c.ageMs >= c.cfg.growMs) return null;
    this.ripenNow(c); // now ripe
    this.update(0); // refresh the growth-stage texture to the ripe frame now
    return at;
  }

  /** Ripen a crop immediately by back-dating its plantedAt so it reads as just-ripened.
   *  Sets both plantedAt (the persisted truth — so it stays ripe after the next frame
   *  re-derives age and across save/reload) and the ageMs cache (so same-tick logic
   *  that reads ageMs before the next update() sees the ripe value). */
  private ripenNow(c: Planting) {
    c.plantedAt = Date.now() - c.cfg.growMs;
    c.ageMs = c.cfg.growMs;
  }

  /** Origins of every ripe plot (Insta-Harvest harvests each via harvestAt).
   *  `isZombie` lets the caller respect the army cap for zombie crops. */
  ripePlots(): { oc: number; or: number; isZombie: boolean }[] {
    const out: { oc: number; or: number; isZombie: boolean }[] = [];
    for (const p of this.plots.values())
      if (p.crop && p.crop.ageMs >= p.crop.cfg.growMs)
        out.push({ oc: p.oc, or: p.or, isZombie: !!p.crop.cfg.isZombie });
    return out;
  }

  /** Insta-Plow: re-plow every harvested (dirt/hole) plot in one pass. Returns the
   *  plots it plowed, so the caller can pop each one's own reward numbers at once. */
  replowSpent(): { oc: number; or: number }[] {
    const done: { oc: number; or: number }[] = [];
    for (const p of this.plots.values())
      if (p.state === "dirt" || p.state === "hole") {
        if (this.tillAt(p.oc, p.or)) done.push({ oc: p.oc, or: p.or });
      }
    return done;
  }

  // Reserve/free a plot's tiles while a till job is queued (so overlapping tills
  // aren't queued before the first one lands).
  reserveTill(oc: number, or: number) {
    if (!this.plots.has(this.key(oc, or)))
      this.forEachTile(oc, or, (k) => this.reserved.add(k));
  }
  private clearReserve(oc: number, or: number) {
    this.forEachTile(oc, or, (k) => this.reserved.delete(k));
  }
  // Release a queued till's reservation (its job was cancelled).
  unreserveTill(oc: number, or: number) {
    this.clearReserve(oc, or);
  }

  // Till at a resolved origin: re-till a dirt/hole plot, or create a new plot.
  tillAt(oc: number, or: number): boolean {
    const k = this.key(oc, or);
    const existing = this.plots.get(k);
    if (existing) {
      if (existing.state !== "dirt" && existing.state !== "hole") return false;
      existing.state = "plowed";
      this.fit(existing.soil, this.assets.soil[PLOWED_FILE], oc, or, PLOT);
      return true;
    }
    this.clearReserve(oc, or);
    if (!this.fits(oc, or) || !this.areaFree(oc, or)) return false;
    const soil = new Sprite();
    this.fit(soil, this.assets.soil[PLOWED_FILE], oc, or, PLOT);
    this.plotLayer.addChild(soil);
    this.plots.set(k, { oc, or, soil, state: "plowed" });
    this.forEachTile(oc, or, (t) => this.tilePlot.set(t, k));
    return true;
  }

  // Plant a crop/zombie on a plowed plot. Seeds the soil and shows the seed sprite.
  plantAt(oc: number, or: number, cfg: CropConfig, plantedAt = Date.now()): boolean {
    const p = this.plots.get(this.key(oc, or));
    if (!p || p.state !== "plowed" || p.crop) return false;
    this.fit(p.soil, this.assets.soil[SEED_FILE], oc, or, PLOT); // seeded soil
    // Mutant Monolith: a mutant-zombie crop planted while the monolith is placed
    // grows in half the time. Bake it into this planting's own config (persists via
    // the per-crop growMs) so it stays consistent across save/reload.
    const useCfg = cfg.isMutant && cfg.growMs > 0 && this.hasMutantMonolith()
      ? { ...cfg, growMs: Math.round(cfg.growMs * 0.5) }
      : cfg;
    const crop: Planting = { cfg: useCfg, plantedAt, ageMs: 0, sprite: new Sprite(), baseY: 0 };
    crop.baseY = this.layoutCrop(crop, useCfg.stages[0], oc, or); // layoutCrop parents by stage
    p.crop = crop;
    p.state = "planted";
    return true;
  }

  /** Lay out a crop for stage file `stageFile`, and put its sprite(s) in the right
   *  layer(s). `stageFile` keys both the full art (assets.crop) and its plants-only
   *  companion (assets.cropTop). Returns the ground-contact baseY.
   *
   *  At the SEED stage (stages[0]) the crop layers like plain tilled soil: one flat
   *  sprite in cropSeedLayer (above the soil, below the entity layer) so actors
   *  always draw OVER it and never get hidden behind a flat seeded plot.
   *
   *  Once it grows PAST the seed stage the crop renders as TWO pixel-aligned sprites:
   *    - the untouched art in cropGroundLayer (below the entity layer), which carries
   *      the baked soil — because it sits under every entity its dirt can never draw
   *      over a neighbouring plot's crop, and
   *    - a plants-only copy (soil keyed out, assets.cropTop) in the depth-sorted
   *      entityLayer, footprinted on the whole 4x4 plot like a placed object.
   *  So the plant still sorts correctly against actors and other crops, but a plot's
   *  dirt no longer clips the tall crop/zombie growing on the plot behind it. */
  private layoutCrop(c: Planting, stageFile: string, oc: number, or: number): number {
    const full = this.assets.crop[stageFile];
    const top = this.assets.cropTop[stageFile] ?? full;
    const soil = this.assets.soil[PLOWED_FILE];
    const scale = (PLOT * TILE_W) / full.width;
    const soilH = soil.height * ((PLOT * TILE_W) / soil.width);
    const p = gridToScreen(oc, or);
    const baseY = p.y + (PLOT * TILE_H + soilH) / 2;
    c.stageFile = stageFile;

    c.sprite.anchor.set(0.5, 1); // bottom-center = the crop's ground contact point
    c.sprite.scale.set(scale);
    c.sprite.position.set(p.x, baseY);
    // A FLAT_GROWTH_CROPS crop takes the seed stage's ground treatment while it grows:
    // that art is ground, so it must not join the depth sort until it stands up (ripe).
    if (isFlatStage(c.cfg, stageFile)) {
      // KEEP IT ON THE GROUND. The usual case is the shared tilled-soil seed
      // (planted_dirt) used by veg crops — it reads like plain land, so it lives in
      // cropSeedLayer (above soil, below the entity layer) with NO footprint. It
      // never depth-sorts, so the farmer always walks over it just like the plowed
      // dirt beneath it. No soil companion is needed (the whole art IS ground); drop
      // any leftover ground sprite from an earlier growth stage. Zombie crops have no
      // flat seed — their first stage is already a standing wooden cross, so it falls
      // through to the split path below and its overhang is protected like every
      // other stage. A FLAT_GROWTH_CROPS entry takes this branch for its growing
      // stages too, and leaves it once it is ripe.
      c.sprite.texture = full;
      this.cropSeedLayer.addChild(c.sprite);
      if (c.groundSprite) { c.groundSprite.parent?.removeChild(c.groundSprite); c.groundSprite.visible = false; }
    } else {
      // Past seed: plants-only copy is the depth-sorted entity (footprinted on the
      // whole 4x4 plot, exactly like a 4x4 object), and the full art (with soil)
      // renders beneath in cropGroundLayer, keyed to the plot's front-corner depth.
      c.sprite.texture = top;
      this.entityLayer.addChild(c.sprite);
      setFootprint(c.sprite, oc, or, oc + PLOT - 1, or + PLOT - 1);
      const g = (c.groundSprite ??= new Sprite());
      g.anchor.set(0.5, 1);
      g.texture = full;
      g.scale.set(scale);
      g.position.set(p.x, baseY);
      g.visible = true;
      g.zIndex = (oc + PLOT - 1) + (or + PLOT - 1); // front-corner depth
      this.cropGroundLayer.addChild(g);
    }
    return baseY;
  }

  // Harvest a ripe plot: crop -> dirt square, zombie -> hole. Returns {sell,xp,name};
  // for a zombie crop, `zombieKey` names the unit type to spawn as an owned zombie.
  // `name` is the crop/zombie display name (for quest-progress matching).
  harvestAt(oc: number, or: number): HarvestResult | null {
    const p = this.plots.get(this.key(oc, or));
    if (!p || !p.crop || p.crop.ageMs < p.crop.cfg.growMs) return null;
    const { cfg } = p.crop;
    const mutationContext = cfg.isZombie ? this.zombieMutationContextAt(oc, or) : undefined;
    // Fertilized (by a Garden zombie): the harvest is worth DOUBLE — ground truth
    // (`isFertilized` yields 6 crop drops instead of 3).
    const fertilized = !!p.crop.fertilized;
    const sell = fertilized ? cfg.sell * 2 : cfg.sell;
    destroyCrop(p.crop);
    p.crop = undefined;
    p.state = cfg.isZombie ? "hole" : "dirt";
    this.fit(p.soil, this.assets.soil[cfg.isZombie ? HOLE_FILE : DIRT_FILE], oc, or, PLOT);
    return { sell, xp: cfg.xp, growMs: cfg.growMs, key: cfg.key, name: cfg.name, isZombie: !!cfg.isZombie,
      fertilized, icon: cfg.harvestIcon ?? cfg.stages[cfg.stages.length - 1],
      zombieKey: cfg.isZombie ? cfg.key : undefined, mutationContext };
  }

  /** Mutation crops in every plot touching a zombie plot — edge or corner, whether or
   * not it shares the zombie plot's lattice. Only the planted crop key matters; its age
   * and visual growth stage intentionally do not. */
  zombieMutationContextAt(oc: number, or: number): ZombieMutationContext {
    const cropKeys: string[] = [];
    for (const plot of this.plots.values()) {
      if (!plotsTouch(oc, or, plot.oc, plot.or, PLOT)) continue;
      const crop = plot.crop;
      if (crop && !crop.cfg.isZombie) cropKeys.push(crop.cfg.key);
    }
    return { cropKeys, guaranteed: this.hasMutantMonolith() };
  }

  /** Mark the growing crop at plot (oc,or) as fertilized (a Garden zombie fertilized
   *  it on plant): doubles its harvest and starts the leaf FX. No-op / false if the
   *  plot has no crop or it's already fertilized. Veggie crops only (zombie crops
   *  sell for nothing, so the game never fertilizes them). */
  markFertilized(oc: number, or: number): boolean {
    const c = this.plots.get(this.key(oc, or))?.crop;
    if (!c || c.cfg.isZombie || c.fertilized) return false;
    c.fertilized = true;
    c.fertEmitMs = 0; // first leaf next frame
    return true;
  }

  /** World-space feet position at the FRONT (south, viewer-nearest) corner of a plot
   *  — where a Garden zombie teleports to when it fertilizes the crop there. */
  plotFrontSpot(oc: number, or: number): { x: number; y: number } {
    return tileCenter(oc + PLOT - 1, or + PLOT - 1);
  }

  update(dt: number) {
    const now = Date.now();
    for (const p of this.plots.values()) {
      const c = p.crop;
      if (!c) continue;
      // Age is derived from real wall-clock time (now - plantedAt), NOT accumulated
      // from the render-loop dt. That keeps growth advancing correctly no matter how
      // long the tab was backgrounded (where rAF is throttled and dt is clamped) or
      // fully closed — this recomputes to the true elapsed time on the next frame.
      // A ripe crop stays ripe forever (no wither); age is capped at growMs so it
      // doesn't grow unbounded.
      c.ageMs = Math.min(Math.max(0, now - c.plantedAt), c.cfg.growMs);
      const ripe = c.ageMs >= c.cfg.growMs;
      // The LAST frame is the finished/harvestable look, shown only when ripe; the
      // earlier frames spread across the whole growing period. This keeps "looks
      // done" in sync with "is harvestable" (no premature finished sprite).
      const n = c.cfg.stages.length;
      const stage = ripe
        ? n - 1
        : Math.min(n - 2, Math.floor((c.ageMs / c.cfg.growMs) * (n - 1)));
      const stageFile = c.cfg.stages[stage];
      // On a stage change, re-lay out both halves (plants + ground soil copy).
      if (c.stageFile !== stageFile) this.layoutCrop(c, stageFile, p.oc, p.or);
      // Fertilized crops emit a slow trickle of leaves above their canopy the whole
      // time they exist (source: an infinite CCParticleFlower on the tile).
      if (c.fertilized) {
        c.fertEmitMs = (c.fertEmitMs ?? 0) - dt * 1000;
        if (c.fertEmitMs <= 0) {
          this.fx.burst(FERTILIZE_FX, c.sprite.x, c.baseY - FERT_CANOPY_DY, 1);
          c.fertEmitMs = FERT_EMIT_MS * (0.75 + Math.random() * 0.5);
        }
      }
    }
    this.fx.update(dt);
    this.tickSakuraPetals(dt);
    // Ripen fruit trees (swap to the fruit-bearing sprite when the timer elapses)
    // and advance animated decor. Both ride the one pass over the objects.
    const dtMs = dt * 1000;
    for (const o of this.objects.values()) {
      if (o.anim && advanceObjectAnim(o.anim, dtMs, this.playAnimationSound))
        this.applyObjectAnim(o.sprite, o.anim);
      if (!o.def.harvestValue || o.ready || now < o.readyAt) continue;
      o.ready = true;
      this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, true, o.flipped, o);
    }
    // Runs LAST in the frame (after the farmer + zombies have moved), so the
    // footprint depth-sort sees final positions. Ground objects (roads/patch) share
    // their own layer and only need ordering among themselves.
    sortLayer(this.entityLayer);
    sortLayer(this.groundObjectLayer);
    // Mirror the depth order the entity sort just resolved onto the ground soil
    // copies, so a plot's dirt stacks EXACTLY like its plant does. sortLayer gives
    // every plant a unique zIndex, so this leaves no ties for cropGroundLayer to
    // break by child order — otherwise a plot re-laid-out on a stage change would
    // jump to the top of its depth tie and its dirt would draw over a plot in
    // front of it (whichever grew most recently "won").
    for (const p of this.plots.values())
      if (p.crop?.groundSprite) p.crop.groundSprite.zIndex = p.crop.sprite.zIndex;
  }

  /** Falling blossom over a farm wearing the Sakura ground skin.
   *
   *  Deliberately keeps ticking after the skin is changed away: petals already in
   *  the air finish their fall and fade instead of vanishing the instant the player
   *  buys a different ground. Once the last one dies the field is idle — an empty
   *  pool — so there is nothing to tear down. */
  private tickSakuraPetals(dt: number) {
    const sakura = this.climate === SAKURA_TERRAIN;
    if (sakura && !this.petals) {
      this.petals = new ParticleField(petalTexture());
      this.fxLayer.addChild(this.petals.container);
    }
    if (!this.petals) return;
    if (sakura && this.w > 0 && this.h > 0) {
      // One petal per (life / target) seconds keeps roughly `target` of them alive
      // at once, since each lives `particleLifespan` and they are emitted evenly.
      const emitMs = SAKURA_PETAL_FX.particleLifespan * 1000 / PETAL_TARGET_LIVE;
      this.petalEmitMs -= dt * 1000;
      // A loop, not an `if`: after a long frame more than one petal is due, and
      // dropping the surplus would silently thin the fall out exactly when the
      // frame rate is already suffering. Bounded so a paused tab cannot come back
      // and emit a year of blossom in one go.
      let guard = PETAL_TARGET_LIVE;
      while (this.petalEmitMs <= 0 && guard-- > 0) {
        const p = this.randomPetalOrigin();
        this.petals.burst(SAKURA_PETAL_FX, p.x, p.y, 1);
        this.petalEmitMs += emitMs;
      }
      if (guard <= 0) this.petalEmitMs = emitMs; // drop the rest of a long backlog
    }
    this.petals.update(dt);
  }

  /** Where the camera is looking, in world coordinates, so the blossom falls where
   *  it can be seen. Cheap enough to push every frame; main derives it from the
   *  world container's transform. */
  setViewBounds(x0: number, y0: number, x1: number, y1: number) {
    this.viewBounds = { x0, y0, x1, y1 };
  }

  /** A uniformly random point to drop a petal from: across the visible world, and
   *  some way above the top of it so petals also drift in from off-camera.
   *
   *  With no view yet, falls back to the farm itself — uniform in TILE space, not
   *  in the bounding box, because the field is an iso diamond and seeding its box
   *  would pile three quarters of the petals off the land to either side. */
  private randomPetalOrigin(): { x: number; y: number } {
    const v = this.viewBounds;
    if (!v) {
      const at = gridToScreen(Math.random() * this.w, Math.random() * this.h);
      return { x: at.x, y: at.y };
    }
    const height = v.y1 - v.y0;
    return {
      x: v.x0 + Math.random() * (v.x1 - v.x0),
      y: v.y0 - height * PETAL_SPAWN_HEADROOM
        + Math.random() * height * (1 + PETAL_SPAWN_HEADROOM),
    };
  }

  // Position the cursor. "till" resolves free placement (green valid / red invalid);
  // "plant"/"remove" act on the plot under the tile; null (select) shows nothing.
  setCursor(col: number, row: number, tool: "till" | "plant" | "remove" | "grow" | null) {
    this.objGhost.visible = false; // farming cursor and object ghost are exclusive
    if (tool === null) {
      this.cursor.visible = false;
      return;
    }
    let oc: number, or: number, valid: boolean;
    if (tool === "till") {
      const t = this.resolveTill(col, row);
      oc = t.oc; or = t.or; valid = t.valid;
    } else {
      const at = this.plotOriginAt(col, row);
      if (!at) {
        this.cursor.visible = false;
        return;
      }
      oc = at.oc; or = at.or;
      valid = tool === "plant" ? this.canPlant(col, row)
        // Grow tool: only a still-growing crop is a valid target.
        : tool === "grow" ? (this.hasCrop(col, row) && !this.isRipe(col, row))
        : true;
    }
    const c = this.plotCenterOf(oc, or);
    this.cursor.position.set(c.x, c.y);
    const showGreen = tool === "remove" ? false : valid;
    this.cursorGreen.visible = showGreen;
    this.cursorRed.visible = !showGreen;
    this.cursorLabel.visible = true;
    this.cursorLabel.text = tool === "till" ? "Plow" : tool === "plant" ? "Plant"
      : tool === "grow" ? "Grow" : "Remove";
    this.cursor.visible = true;
  }

  hideCursor() {
    this.cursor.visible = false;
    this.objGhost.visible = false;
  }

  // ---- placeable objects (trees / decor) ------------------------------------

  private forEachFootprint(oc: number, or: number, w: number, h: number, fn: (k: string) => void) {
    for (let r = or; r < or + h; r++)
      for (let c = oc; c < oc + w; c++) fn(`${c},${r}`);
  }
  // In-bounds tiles an object blocks for MOVEMENT beyond its placement footprint (its
  // collideExtend overhangs). A horizontal flip mirrors the art, which in iso reflects
  // col<->row, so a flipped object's overhang offsets swap dc<->dr.
  private extensionTiles(def: PlaceableDef, oc: number, or: number, flipped: boolean): string[] {
    const out: string[] = [];
    for (const e of this.extensionOffsets(def, flipped)) {
      const c = oc + e.dc;
      const r = or + e.dr;
      if (c >= 0 && r >= 0 && c < this.w && r < this.h) out.push(`${c},${r}`);
    }
    return out;
  }
  // The overhang offsets in the orientation the object is actually placed in.
  private extensionOffsets(def: PlaceableDef, flipped: boolean): { dc: number; dr: number }[] {
    const ext = def.collideExtend;
    if (!ext?.length) return [];
    return flipped ? ext.map((e) => ({ dc: e.dr, dr: e.dc })) : ext;
  }
  private setExtensionBlocks(id: string, def: PlaceableDef, oc: number, or: number, flipped: boolean, add: boolean) {
    // Every placement change comes through here, whether or not the object has an
    // overhang, so this is where the derived wormhole links get dropped.
    this.topologyChanged();
    for (const t of this.extensionTiles(def, oc, or, flipped)) {
      let set = this.fenceBlock.get(t);
      if (add) {
        if (!set) this.fenceBlock.set(t, (set = new Set()));
        set.add(id);
      } else if (set) {
        set.delete(id);
        if (set.size === 0) this.fenceBlock.delete(t);
      }
    }
  }
  private footprintFits(oc: number, or: number, w: number, h: number): boolean {
    return oc >= 0 && or >= 0 && oc + w - 1 < this.w && or + h - 1 < this.h;
  }
  private footprintFree(oc: number, or: number, w: number, h: number, ignoreId?: string): boolean {
    for (let r = or; r < or + h; r++)
      for (let c = oc; c < oc + w; c++)
        if (this.tileOccupied(c, r, ignoreId)) return false;
    return true;
  }
  // World-space bottom-center anchor point of a w x h footprint at (oc,or).
  private footprintAnchor(oc: number, or: number, w: number, h: number): { x: number; y: number } {
    const cx = ((oc + (w - 1) / 2) - (or + (h - 1) / 2)) * HW;
    const by = gridToScreen(oc + w - 1, or + h - 1).y + TILE_H;
    return { x: cx, y: by };
  }
  // Render scale: object art is authored for the source 48px tile grid, so display
  // every object at its NATIVE size mapped to our tile size (TILE_W / source tileW,
  // ~0.98). This matches the original game 1:1 — decor/trees/functional keep their
  // real proportions instead of being force-stretched to a fixed tile height.
  private objectScale(): number {
    return TILE_W / this.assets.field.tileW;
  }
  /** Where an object's art stands: the bottom-centre of its footprint, dropped half a
   *  tile for a fence panel.
   *
   *  A fence panel is not a thing standing ON a tile, it is a wall segment standing on
   *  the EDGE between two of them. Its rail is two tiles long and bridges into the
   *  neighbour it also blocks (`collideExtend`); the half-tile drop is what puts its
   *  two posts on the lattice CORNERS either end of that edge — measured, (c+0.5,
   *  r-0.5) and (c+0.5, r+1.5) for an unflipped panel at (c,r). Everything about a
   *  fence line depends on that: runs meet post to post, two runs meet squarely at a
   *  corner, and a run meets a gate's end post, because all of them land on the same
   *  lattice of tile corners. Move it and every junction on the farm goes crooked. */
  private objectRenderY(def: PlaceableDef, y: number): number {
    return y + (def.collideExtend?.length ? HH : 0);
  }
  // Which sprite to show: a working object (Zombie Pot) shows the frame for what it
  // is doing; a fruit tree that isn't ripe shows its growing frame. A state with no
  // art of its own falls back to the busy frame, so a pot holding a finished combine
  // keeps its lid rather than reverting to the idle pot.
  private objectSpriteName(
    def: PlaceableDef, ready: boolean, work?: ObjectWork, turn = 0,
  ): string {
    if (work === "ready" && def.readySprite) return def.readySprite;
    if (work && def.busySprite) return def.busySprite;
    if (!ready && def.growingSprite) return def.growingSprite;
    return turnArt(def, turn).sprite; // a road bend draws the corner it is turned to
  }
  private isGroundObject(def: PlaceableDef): boolean {
    return def.zombiePatch || /road/i.test(def.key);
  }
  // Bottom-centering an object on its footprint is an approximation, and flat
  // ground art is where it shows: a road piece is drawn to butt up against the next
  // one, so a couple of pixels of drift leaves a visible step in the kerb where a
  // straight meets a crossing.
  //
  // GROUND TRUTH `-[Tile anchorPoint]` + `-[Tile loadBaseSprite]`: a tile pins its
  // art by the authored `(pivotx, pivoty)` cocos anchor (default (0.38, 0)) onto the
  // position of the GROUND TILE it sits on — which cocos' iso tile map puts at the
  // bottom-left corner of that tile's 48x24 bounding box. This returns the offset
  // from where we draw the sprite today to where those two rules put it. Non-flat
  // objects keep bottom-centering: their pivots are authored for art that stands up
  // off the ground, and nothing has to line up with them edge to edge.
  private flatTileOffset(
    def: PlaceableDef, oc: number, or: number, flipped: boolean, turn = 0,
  ): { dx: number; dy: number } {
    const art = turnArt(def, turn);
    if (!art.flatTile || art.anchorX === undefined || art.anchorY === undefined) {
      return { dx: 0, dy: 0 };
    }
    const s = this.objectScale();
    const w = art.nativeW * s, h = art.nativeH * s;
    const fp = objectFootprint(def, flipped);
    // A turn state may hang its art off a NEIGHBOURING ground tile (the apex-south
    // road bend does, by a measured whole tile). The footprint is untouched: only
    // where the art hangs moves, so the block the player placed still blocks.
    const front = gridToScreen(oc + fp.w - 1 + (art.dc ?? 0), or + fp.h - 1 + (art.dr ?? 0));
    const p = { x: front.x - HW, y: front.y + TILE_H }; // the ground tile's own position
    const a = this.footprintAnchor(oc, or, fp.w, fp.h);
    // A mirrored tile reflects about the centre line of that same ground tile, one
    // source tile to the right of `p` — the binary's `1 - pivotx - 48/width`.
    const anchorX = flipped
      ? 1 - art.anchorX - this.assets.field.tileW / art.nativeW
      : art.anchorX;
    return {
      dx: (p.x - a.x) + w * (0.5 - anchorX),
      dy: (p.y - a.y) + h * art.anchorY,
    };
  }
  /** Put a Memorial Statue's stone zombie on top of its plinth. The plinth is
   *  bottom-centered on its footprint like any other object, so the statue's feet
   *  are the plinth's authored mount point (top-face centre) measured back from
   *  that bottom-centre anchor. Rendered ABOVE the plinth on the same footprint —
   *  a bias below every actor's, so a zombie walking past the memorial still
   *  passes in front of it. */
  private fitMemorialRig(obj: FarmObject) {
    const rig = obj.memorialRig;
    if (!rig) return;
    const def = obj.def;
    const s = this.objectScale();
    const fp = objectFootprint(def, obj.flipped);
    const anchor = this.footprintAnchor(obj.oc, obj.or, fp.w, fp.h);
    const mountX = def.mountX ?? 0.5;
    const mountY = def.mountY ?? 1;
    // The plinth art is not symmetric, so a flipped plinth mirrors its mount point
    // about the sprite's centre — otherwise the statue slides off the top face.
    const offsetX = (obj.flipped ? 1 - mountX : mountX) - 0.5;
    rig.position.set(
      anchor.x + def.nativeW * s * offsetX,
      this.objectRenderY(def, anchor.y) - def.nativeH * s * mountY,
    );
    setFootprint(rig, obj.oc, obj.or, obj.oc + fp.w - 1, obj.or + fp.h - 1,
      MEMORIAL_RIG_BIAS);
  }

  private fitObjectSprite(
    sp: Sprite, def: PlaceableDef, oc: number, or: number, ready = true, flipped = false,
    extra?: { backSprite?: Sprite; frontOverlay?: Container; work?: ObjectWork; turn?: number;
      anim?: ObjectAnimState },
  ) {
    const turn = extra?.turn ?? 0;
    const name = this.objectSpriteName(def, ready, extra?.work, turn);
    const texture = this.assets.objects[name] ?? this.assets.objects[def.sprite] ?? Texture.EMPTY;
    const tint = objectTint(def.color);
    const s = this.objectScale();
    // Flip = mirror horizontally, which in iso reflects the footprint about the
    // origin tile — so the art is bottom-centered on the TRANSPOSED rectangle it
    // actually occupies (objectFootprint), and lands over its own blocked tiles.
    const fp = objectFootprint(def, flipped);
    const a = this.footprintAnchor(oc, or, fp.w, fp.h);
    const off = this.flatTileOffset(def, oc, or, flipped, turn);
    const scaleX = flipped && canMirrorObject(def) ? -s : s;
    const c1 = oc + fp.w - 1, r1 = or + fp.h - 1;
    const lay = (sprite: Sprite, tex: Texture) => {
      sprite.texture = tex;
      sprite.tint = tint;
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(scaleX, s);
      sprite.position.set(a.x + off.dx, this.objectRenderY(def, a.y) + off.dy);
    };
    lay(sp, texture);
    // Animated decor draws a CELL over the still `lay` just applied. The cells share
    // the still's centre line, so the mirror and the position above already hold for
    // them; `dy` is the one correction — how far the cells hang below the still's
    // ground line (the Taiko Drum's sticks reach 15px under the drum). It is applied
    // whenever the object is animated, including the moment a tap-played object is
    // resting on its still, where it is worth at most the single pixel that costs.
    if (extra?.anim) {
      sp.position.y += (extra.anim.def.dy ?? 0) * s;
      this.applyObjectAnim(sp, extra.anim);
    }
    // Depth-sorts by the object's full footprint (see depthSort): an actor on the
    // object's own tiles or south of it draws in front, one behind it is covered.
    const back = extra?.backSprite;
    setFootprint(sp, oc, or, c1, r1, back ? BACK_LAYER_BIAS : 0);

    // ---- Two-layer objects (Pet Pen) --------------------------------------
    // The source draws the far wall as a childNode at a deeper depth than the base
    // sprite (TileProperties pettingZoo: pettingzoo_back.png at depth 15, front at 0),
    // both authored on the same canvas — so the two layers share one transform and
    // differ only in paint order. The far wall takes the same footprint with no bias,
    // which is what orders the pair.
    if (back) {
      lay(back, this.assets.objects[def.backSprite ?? ""] ?? Texture.EMPTY);
      setFootprint(back, oc, or, c1, r1);
    }
    // Pets stand on the pen's own tiles, so the depth sort puts them in FRONT of it —
    // right for the far wall, wrong for the near one they should be standing behind.
    // A masked copy of the near wall, clipped to those pets and pinned above the
    // layer, restores that without inverting the pen against anything outside it.
    const overlay = extra?.frontOverlay;
    if (overlay) {
      for (const child of overlay.removeChildren()) child.destroy();
      const copy = new Sprite();
      lay(copy, texture);
      overlay.addChild(copy);
      overlay.zIndex = PEN_OVERLAY_Z;
    }
  }

  // ---- Animated decor ------------------------------------------------------
  // Cells cut once per SHEET, not per placed object: ten tiki torches all flip
  // through the same four textures.
  private animCells = new Map<string, Texture[]>();

  /** Build the flipbook for a def about to be placed and hang its extra layers off
   *  `host`. Undefined for ordinary decor and for art that has not loaded. */
  private makeObjectAnim(def: PlaceableDef, host: Sprite): ObjectAnimState | undefined {
    const anim = def.anim && createObjectAnim(def.anim, (layer) => {
      const cached = this.animCells.get(layer.sheet);
      if (cached) return cached;
      const sheet = this.assets.objects[layer.sheet];
      if (!sheet) return undefined;
      const cells = animFrames(layer, def.anim!, sheet);
      this.animCells.set(layer.sheet, cells);
      return cells;
    }, (file) => this.assets.objects[file]);
    for (const l of anim?.layers ?? []) if (l.sprite) host.addChild(l.sprite);
    // Parts are added in source order, which is their draw order (the Skeleton
    // Couple's 21 bones stack shoulders under head under hat).
    for (const p of anim?.parts ?? []) host.addChild(p.sprite);
    return anim;
  }

  /** Show each layer's current cell. Layer 0 drives the object's own sprite, so a
   *  layer resting on its still (a tapped Box o' Lantern between pops) simply leaves
   *  the texture `fitObjectSprite` set. */
  private applyObjectAnim(sp: Sprite, anim: ObjectAnimState) {
    // The still holds every motion part baked in at its home spot, so an object
    // whose parts are moving draws the art with them taken back out.
    if (anim.base) sp.texture = anim.base;
    for (const l of anim.layers) {
      const tex = l.frame === REST ? undefined : l.frames[l.frame];
      if (l.sprite) l.sprite.texture = tex ?? Texture.EMPTY;
      else if (tex) sp.texture = tex;
    }
    for (const p of anim.parts) {
      const pose = posePart(p);
      p.sprite.position.set(pose.x, pose.y);
      p.sprite.scale.set(pose.scale);
      // A part scaled to nothing (the truck's drip between falls) is hidden rather
      // than drawn as a zero-area quad.
      p.sprite.visible = pose.scale > 0;
    }
  }

  /** Play the tap-triggered animation on a placed object (the Parrot's squawk, the
   *  Taiko Drum's two hits). No-op for an object with no flipbook or a looping one. */
  triggerObjectAnimation(id: string): boolean {
    const obj = this.objects.get(id);
    if (!obj?.anim || !triggerObjectAnim(obj.anim)) return false;
    this.applyObjectAnim(obj.sprite, obj.anim);
    return true;
  }

  private destroyObjectSprites(obj: FarmObject) {
    for (const l of obj.anim?.layers ?? []) l.sprite?.destroy();
    for (const p of obj.anim?.parts ?? []) p.sprite.destroy();
    obj.anim = undefined;
    obj.sprite.removeFromParent();
    obj.backSprite?.removeFromParent();
    obj.frontOverlay?.removeFromParent();
    obj.frontMask?.removeFromParent();
    this.destroyMemorialRig(obj);
    obj.sprite.destroy();
    obj.backSprite?.destroy();
    obj.frontOverlay?.destroy({ children: true });
    obj.frontMask?.destroy();
  }

  private destroyMemorialRig(obj: FarmObject) {
    if (!obj.memorialRig) return;
    obj.memorialRig.removeFromParent();
    obj.memorialRig.destroy({ children: true });
    obj.memorialRig = undefined;
  }

  /** Who is enshrined on this Memorial Statue, or null (unknown id, not a memorial,
   *  or an empty one). */
  memorialOccupant(id: string): FallenZombie | null {
    return this.objects.get(id)?.memorial ?? null;
  }

  /** Every placed Memorial Statue, with its occupant. Used to keep the graveyard
   *  list and the statues from ever showing the same zombie twice. */
  memorials(): { id: string; occupant: FallenZombie | null }[] {
    const out: { id: string; occupant: FallenZombie | null }[] = [];
    for (const o of this.objects.values()) {
      if (o.def.memorial) out.push({ id: o.id, occupant: o.memorial ?? null });
    }
    return out;
  }

  /** Enshrine `fallen` on the statue `id` (or clear it with null), rebuilding the
   *  stone rig. Returns false when `id` is not a Memorial Statue. Building the rig
   *  needs the species' part textures, which the zombie catalog loads up front, so
   *  this is synchronous. */
  setMemorialOccupant(id: string, fallen: FallenZombie | null): boolean {
    const obj = this.objects.get(id);
    if (!obj?.def.memorial) return false;
    this.destroyMemorialRig(obj);
    obj.memorial = fallen ?? undefined;
    if (fallen) {
      const rig = buildStatueRig(this.assets, fallen);
      if (rig) {
        obj.memorialRig = rig;
        this.entityLayer.addChild(rig);
        this.fitMemorialRig(obj);
      }
    }
    return true;
  }

  // Glowing objects (candle altar, sparklers, glow-flora, ...) emit an additive
  // night light (from ZF2 pointLights). It sits over the object's body and only
  // shows when the night layer is visible.
  private attachObjectLight(obj: FarmObject) {
    const glow = OBJECT_GLOWS[obj.def.key];
    if (!glow) return;
    // Alpha = reveal strength: glowing decor lifts the darkness around it a bit,
    // less than the farmer's lantern so it reads as a soft pool, not full daylight.
    const l = makeLight(glow.radius, glow.color, 0.7);
    obj.light = l;
    this.objectLights.addChild(l);
    this.positionObjectLight(obj);
  }
  private positionObjectLight(obj: FarmObject) {
    const l = obj.light;
    if (!l) return;
    const fp = objectFootprint(obj.def, obj.flipped);
    const a = this.footprintAnchor(obj.oc, obj.or, fp.w, fp.h);
    // Raise the glow off the ground onto the object's body.
    l.position.set(a.x, a.y - (l.height ?? 0) * 0.35);
  }
  private destroyObjectLight(obj: FarmObject) {
    obj.light?.parent?.removeChild(obj.light);
    obj.light?.destroy();
    obj.light = undefined;
  }

  // Center a def's footprint on the pointer tile. A turned object is transposed, so
  // the centering has to use the orientation it will actually be placed in — else
  // the ghost sits off the cursor by half the difference between its sides.
  resolveObjectOrigin(def: PlaceableDef, col: number, row: number, flipped = false): { oc: number; or: number } {
    const fp = objectFootprint(def, flipped);
    return { oc: col - Math.floor((fp.w - 1) / 2), or: row - Math.floor((fp.h - 1) / 2) };
  }
  canPlaceObject(oc: number, or: number, def: PlaceableDef, ignoreId?: string, flipped = false): boolean {
    const fp = objectFootprint(def, flipped);
    return (
      this.footprintFits(oc, or, fp.w, fp.h) &&
      this.footprintFree(oc, or, fp.w, fp.h, ignoreId)
    );
  }

  /** The first free origin for this def, scanned row-major from the farm's near corner,
   *  or null when nothing on the farm can hold it. Object positions live only in the
   *  presentation layout, so this is how the reconcile re-homes a server-owned object
   *  whose saved position was lost — without it that object can never be drawn again. */
  findFreeOrigin(def: PlaceableDef, flipped = false): { oc: number; or: number } | null {
    const fp = objectFootprint(def, flipped);
    for (let or = 0; or + fp.h - 1 < this.h; or++)
      for (let oc = 0; oc + fp.w - 1 < this.w; oc++)
        if (this.canPlaceObject(oc, or, def, undefined, flipped)) return { oc, or };
    return null;
  }

  // Place a new object (id auto-generated) or restore one (id given). For fruit
  // trees, `readyAt` sets when fruit ripens (defaults to now + growMs for a fresh
  // placement); a past readyAt means it's already ripe (offline growth). Returns
  // the object id, or null if the footprint isn't valid.
  placeObject(def: PlaceableDef, oc: number, or: number, id?: string, readyAt?: number,
    turn = 0, memorial?: FallenZombie): string | null {
    // Clamped here rather than at the call sites because this is the ONE door every
    // object comes through — a purchase, a restored save, a gift, a friend's farm. An
    // object whose art carries writing keeps its footprint AND its art unturned, so the
    // two can never disagree, and a save that already stored an orientation self-heals.
    turn = normalizeTurn(def, turn);
    const flipped = turnFlip(def, turn);
    if (!this.canPlaceObject(oc, or, def, id, flipped)) return null;
    const now = Date.now();
    const ra = def.growMs ? readyAt ?? now + def.growMs : 0;
    const ready = def.growMs ? now >= ra : false;
    const sprite = new Sprite();
    // The far wall is a plain second sprite; the near-wall overlay + its mask only
    // exist for an object whose contents must stand between the two layers.
    const backSprite = def.backSprite ? new Sprite() : undefined;
    const frontOverlay = def.petPen ? new Container() : undefined;
    const frontMask = def.petPen ? new Graphics() : undefined;
    if (frontOverlay && frontMask) frontOverlay.mask = frontMask;
    const anim = this.makeObjectAnim(def, sprite);
    this.fitObjectSprite(sprite, def, oc, or, ready, flipped,
      { backSprite, frontOverlay, turn, anim });
    const layer = this.isGroundObject(def) ? this.groundObjectLayer : this.entityLayer;
    if (backSprite) layer.addChild(backSprite);
    layer.addChild(sprite);
    if (frontOverlay) layer.addChild(frontOverlay);
    if (frontMask) layer.addChild(frontMask);
    const oid = id ?? this.mintId();
    const obj: FarmObject = { id: oid, def, oc, or, sprite, backSprite,
      frontOverlay, frontMask, anim, readyAt: ra, ready, flipped, turn };
    this.objects.set(oid, obj);
    this.attachObjectLight(obj);
    if (memorial) this.setMemorialOccupant(oid, memorial); // restoring an enshrined statue
    const fp = objectFootprint(def, flipped);
    this.forEachFootprint(oc, or, fp.w, fp.h, (t) => this.tileObject.set(t, oid));
    this.setExtensionBlocks(oid, def, oc, or, flipped, true);
    return oid;
  }
  // The placed storage shed's id (there is at most one), or null. A shed is any
  // placed object carrying a storageSlots capacity.
  shedId(): string | null {
    for (const o of this.objects.values()) if (o.def.storageSlots) return o.id;
    return null;
  }
  // The placed Mausoleum's id (the zombie-storage building), or null. At most one.
  mausoleumId(): string | null {
    for (const o of this.objects.values()) if (o.def.zombieStorage) return o.id;
    return null;
  }

  /** The placed Zombie Pot's object id (for the combine-timer bar), or null. */
  zombiePotId(): string | null {
    for (const o of this.objects.values()) if (o.def.zombiePot) return o.id;
    return null;
  }

  /** Every placed Zombie Pot id. Jobs are keyed to these ids so each physical pot
   * opens and advances its own combine. */
  zombiePotIds(): string[] {
    const ids: string[] = [];
    for (const o of this.objects.values()) if (o.def.zombiePot) ids.push(o.id);
    return ids;
  }

  zombiePotCount(): number {
    return this.zombiePotIds().length;
  }

  /** How many objects of this catalog key are on the farm. Loot eligibility needs it:
   * a `unique` drop stops being ownership-visible once it has been placed, so without
   * this the offline roll would keep re-awarding a decoration already standing outside. */
  placedCount(key: string): number {
    let n = 0;
    for (const o of this.objects.values()) if (o.def.key === key) n++;
    return n;
  }

  // Does the player own a colored grave of this class? Colored graves gate
  // planting the matching zombie class (Blue/Red/Silver); Green needs none.
  hasGrave(color: "Blue" | "Red" | "Silver"): boolean {
    for (const o of this.objects.values()) if (o.def.graveColor === color) return true;
    return false;
  }

  // The placed Zombie Patch's id (gathers zombies to nap), or null. At most one.
  patchId(): string | null {
    for (const o of this.objects.values()) if (o.def.zombiePatch) return o.id;
    return null;
  }

  /** The first placed pen's tile bounds. Normal actors still see its full object
   * footprint as solid; only cosmetic pen pets use this interior. */
  petPenBounds(): { oc: number; or: number; tileW: number; tileH: number } | null {
    for (const o of this.objects.values()) {
      if (o.def.petPen) {
        const fp = objectFootprint(o.def, o.flipped);
        return { oc: o.oc, or: o.or, tileW: fp.w, tileH: fp.h };
      }
    }
    return null;
  }

  /** Rebuild the Pet Pen's near-wall mask from the pets standing inside it. A
   * rectangle per pet is enough: transparent pixels in the wall art stay
   * transparent, so only actual rail pixels over a pet come forward. The far wall
   * needs no mask at all — pets are south of it and the depth sort already puts
   * them in front. */
  updatePetPenOcclusion(inside: Container[]) {
    for (const o of this.objects.values()) {
      const mask = o.def.petPen ? o.frontMask : undefined;
      if (!mask) continue;
      mask.clear();
      let any = false;
      for (const actor of inside) {
        if (!actor.visible || !actor.renderable) continue;
        const b = actor.getLocalBounds();
        if (!(b.width > 0 && b.height > 0)) continue;
        mask.rect(actor.x + b.x, actor.y + b.y, b.width, b.height);
        any = true;
      }
      if (any) mask.fill(0xffffff);
    }
  }

  // Plowing Monolith placed → plowing costs no gold.
  hasPlowFree(): boolean {
    for (const o of this.objects.values()) if (o.def.plowFree) return true;
    return false;
  }
  // Speed Monolith placed → farming actions (plow/plant/harvest) are instant.
  hasFastWork(): boolean {
    for (const o of this.objects.values()) if (o.def.fastWork) return true;
    return false;
  }
  // Mutant Monolith placed → mutant-zombie crops grow in half the time.
  hasMutantMonolith(): boolean {
    for (const o of this.objects.values()) if (o.def.mutantMonolith) return true;
    return false;
  }
  // Clay Monolith placed → Zombie Pot combines in 15 min (0.25x timer).
  hasCombineMonolith(): boolean {
    for (const o of this.objects.values()) if (o.def.combineFast) return true;
    return false;
  }
  // Zombie Pot placed → combining two zombies is available.
  hasZombiePot(): boolean {
    for (const o of this.objects.values()) if (o.def.zombiePot) return true;
    return false;
  }
  /** Count of currently-placed objects by catalog key — used to seed the server-owned
   *  object ownership (Phase D) so already-placed placeables stay refundable. */
  objectKeyCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const o of this.objects.values()) counts[o.def.key] = (counts[o.def.key] ?? 0) + 1;
    return counts;
  }
  /** Origins of every PLOWED-and-empty plot — the soil a plant can go into. Used once
   *  on load to import a migrating save's tilled soil into the server-owned soil state
   *  (a planted plot is excluded: its crop already represents that soil). */
  plowedPlotOrigins(): { oc: number; or: number }[] {
    const out: { oc: number; or: number }[] = [];
    for (const p of this.plots.values()) {
      if (p.state === "plowed" && !p.crop) out.push({ oc: p.oc, or: p.or });
    }
    return out;
  }
  // The footprint tiles of the placed Zombie Patch, for zombies to gather onto.
  patchRestTiles(): { col: number; row: number }[] | null {
    for (const o of this.objects.values()) {
      if (!o.def.zombiePatch) continue;
      const tiles: { col: number; row: number }[] = [];
      const fp = objectFootprint(o.def, o.flipped);
      for (let r = o.or; r < o.or + fp.h; r++)
        for (let c = o.oc; c < o.oc + fp.w; c++) tiles.push({ col: c, row: r });
      return tiles;
    }
    return null;
  }

  // Swap an object's type in place (same origin) — used to UPGRADE the storage
  // shed to the next tier without re-placing it. Returns false if the new
  // footprint wouldn't fit. Caller must have the new def's texture loaded.
  replaceObjectDef(id: string, def: PlaceableDef): boolean {
    const o = this.objects.get(id);
    if (!o) return false;
    const was = objectFootprint(o.def, o.flipped);
    const now = objectFootprint(def, o.flipped);
    this.forEachFootprint(o.oc, o.or, was.w, was.h, (t) => this.tileObject.delete(t));
    if (!this.footprintFits(o.oc, o.or, now.w, now.h) ||
        !this.footprintFree(o.oc, o.or, now.w, now.h, id)) {
      // restore the old footprint occupancy and bail
      this.forEachFootprint(o.oc, o.or, was.w, was.h, (t) => this.tileObject.set(t, id));
      return false;
    }
    this.setExtensionBlocks(id, o.def, o.oc, o.or, o.flipped, false);
    o.def = def;
    o.ready = def.growMs ? o.ready : false;
    this.fitObjectSprite(o.sprite, def, o.oc, o.or, true, o.flipped, o);
    this.forEachFootprint(o.oc, o.or, now.w, now.h, (t) => this.tileObject.set(t, id));
    this.setExtensionBlocks(id, def, o.oc, o.or, o.flipped, true);
    return true;
  }

  // Relocate an existing object; false if the destination footprint is invalid.
  // `turn`, when given, also commits a new orientation (the Move tool lets you
  // rotate while carrying); omitted keeps the object's current one.
  moveObject(id: string, oc: number, or: number, turn?: number): boolean {
    const obj = this.objects.get(id);
    // The drop is validated in the orientation it lands in, not the one it was
    // picked up in — turning a hedge mid-carry changes which tiles it needs.
    const asked = turn ?? obj?.turn ?? 0;
    const nextTurn = obj ? normalizeTurn(obj.def, asked) : asked;
    const next = obj ? turnFlip(obj.def, nextTurn) : false;
    if (!obj || !this.canPlaceObject(oc, or, obj.def, id, next)) return false;
    const was = objectFootprint(obj.def, obj.flipped);
    this.forEachFootprint(obj.oc, obj.or, was.w, was.h, (t) => this.tileObject.delete(t));
    this.setExtensionBlocks(id, obj.def, obj.oc, obj.or, obj.flipped, false);
    obj.oc = oc;
    obj.or = or;
    obj.flipped = next;
    obj.turn = nextTurn;
    this.fitObjectSprite(obj.sprite, obj.def, oc, or, obj.ready, obj.flipped, obj);
    this.fitMemorialRig(obj);
    this.positionObjectLight(obj);
    const fp = objectFootprint(obj.def, obj.flipped);
    this.forEachFootprint(oc, or, fp.w, fp.h, (t) => this.tileObject.set(t, id));
    this.setExtensionBlocks(id, obj.def, oc, or, obj.flipped, true);
    return true;
  }

  /** Show a working object's state art (the Zombie Pot's lid while a combine cooks).
   *  The job itself lives outside the Field, so its owner pushes the state in — see
   *  the per-pot loop in main.ts. No-op for objects with no state art, and for a
   *  state that is already showing. Returns true when the look actually changed. */
  setObjectWork(id: string, work: ObjectWork | null): boolean {
    const o = this.objects.get(id);
    if (!o || !o.def.busySprite) return false;
    const next = work ?? undefined;
    if (o.work === next) return false;
    o.work = next;
    this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, o.ready, o.flipped, o);
    return true;
  }

  // Is this object a fruit tree with ripe fruit ready to harvest?
  isObjectReady(id: string): boolean {
    const o = this.objects.get(id);
    return !!o && !!o.def.harvestValue && o.ready;
  }
  /** Hover-card projection for a placed fruit tree. */
  treeInfoAtPoint(x: number, y: number):
    { name: string; ripe: boolean; remainingMs: number; fertilized: false } | null {
    const id = this.objectAtPoint(x, y);
    const o = id ? this.objects.get(id) : null;
    if (!o?.def.harvestValue) return null;
    return {
      name: o.def.name,
      ripe: o.ready,
      remainingMs: o.ready ? 0 : Math.max(0, o.readyAt - Date.now()),
      fertilized: false,
    };
  }
  /** Every ripe fruit tree, for farm-wide harvest powers. */
  ripeTreeIds(): string[] {
    return [...this.objects.values()]
      .filter((o) => !!o.def.harvestValue && o.ready)
      .map((o) => o.id);
  }
  // Reconcile a fruit tree's ripen timer with the authoritative server state.
  // This also restores the ripe presentation when a local harvest is rejected.
  syncObjectReadyAt(id: string, readyAt: number): boolean {
    const o = this.objects.get(id);
    if (!o || !o.def.harvestValue) return false;
    o.readyAt = readyAt;
    o.ready = Date.now() >= readyAt;
    this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, o.ready, o.flipped, o);
    return true;
  }
  // Harvest a ripe fruit tree: award its value, reset it to growing. Returns the
  // gold value, or null if it wasn't a ripe fruit tree.
  harvestObject(id: string): number | null {
    const o = this.objects.get(id);
    if (!o || !o.def.harvestValue || !o.ready) return null;
    o.ready = false;
    o.readyAt = Date.now() + (o.def.growMs ?? 0);
    this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, false, o.flipped, o);
    return o.def.harvestValue;
  }
  removeObject(id: string): PlaceableDef | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    if (this.highlightedObj === id) this.highlightedObj = null;
    // A Memorial Statue can be sold or shelved, but the zombie carved on it must
    // not go with it: the shed stores a key and a count, and a sale stores nothing
    // at all. Hand the occupant back before the object stops existing. Announced
    // here rather than at the call sites so every removal path — sell, store, the
    // Remove tool, and anything added later — is covered by construction.
    if (obj.memorial) this.onMemorialReleased?.(obj.memorial);
    const fp = objectFootprint(obj.def, obj.flipped);
    this.forEachFootprint(obj.oc, obj.or, fp.w, fp.h, (t) => this.tileObject.delete(t));
    this.setExtensionBlocks(id, obj.def, obj.oc, obj.or, obj.flipped, false);
    this.destroyObjectSprites(obj);
    this.destroyObjectLight(obj);
    this.objects.delete(id);
    return obj.def;
  }

  // Tint the object under the Remove tool's cursor so the player sees what will be
  // removed; pass null to clear. No-op if it's already the highlighted object.
  //
  // A recoloured placeable (Black Fence Gate, Pink Iron Fence) is the base art plus
  // a sprite tint, so the wash has to compose with that colour rather than replace
  // it: clearing back to white would strip the recolour and leave the pale base art
  // until the farm was rebuilt, and washing to bare red would flash a black gate
  // bright. Multiply both ways — white is the identity, so an untinted object is
  // unaffected.
  setObjectHighlight(id: string | null) {
    if (id === this.highlightedObj) return;
    const applyWash = (obj: FarmObject | undefined, wash: number) => {
      if (!obj) return;
      const tint = multiplyObjectTint(objectTint(obj.def.color), wash);
      for (const sprite of [obj.sprite, obj.backSprite]) {
        if (sprite) sprite.tint = tint;
      }
      for (const child of obj.frontOverlay?.children ?? []) {
        if (child instanceof Sprite) child.tint = tint;
      }
    };
    applyWash(this.highlightedObj ? this.objects.get(this.highlightedObj) : undefined, 0xffffff);
    this.highlightedObj = id;
    applyWash(id ? this.objects.get(id) : undefined, 0xff7a6a); // reddish "will remove" wash
  }
  objectDefOf(id: string): PlaceableDef | null {
    return this.objects.get(id)?.def ?? null;
  }
  objectOriginOf(id: string): { oc: number; or: number } | null {
    const o = this.objects.get(id);
    return o ? { oc: o.oc, or: o.or } : null;
  }
  // Current orientation of a placed object (for the Move tool to carry it over).
  objectTurnOf(id: string): number {
    return this.objects.get(id)?.turn ?? 0;
  }
  // Rotate tool: turn a placed object one step, in place. For most art that is a
  // mirror on the vertical axis, which transposes the footprint (see objectFootprint)
  // and so can be BLOCKED — a hedge turned across its neighbours has nowhere to go.
  // A road bend instead steps to the next corner in its `turns` list.
  /** Turn a placed object a quarter turn. False when it did not turn — either the
   *  turned footprint has no room, or the object's art must never be mirrored
   *  (`canMirrorObject`). Callers check that second case first so they can say which
   *  it was. */
  flipObject(id: string): boolean {
    const o = this.objects.get(id);
    if (!o || !canMirrorObject(o.def)) return false;
    return this.moveObject(id, o.oc, o.or, (o.turn + 1) % turnCount(o.def));
  }
  // World point the farmer walks to in order to harvest this object (its base).
  objectWorkPoint(id: string): { x: number; y: number } | null {
    const o = this.objects.get(id);
    if (!o) return null;
    const fp = objectFootprint(o.def, o.flipped);
    const base = this.footprintAnchor(o.oc, o.or, fp.w, fp.h);
    return clampPointToGrid(base.x, base.y, this.w, this.h);
  }

  /** The front-most tile of a placed object's footprint — the one its art stands on
   *  (see footprintAnchor, which drops half a tile below this to find the base).
   *
   *  It is COVERED by the object, so it is never somewhere to put a zombie down: the
   *  caller steps out from here to the nearest open ground (see
   *  ZombieField.objectArrivalTile). Null once the object is gone. */
  objectAnchorTile(id: string): { col: number; row: number } | null {
    const o = this.objects.get(id);
    if (!o) return null;
    const fp = objectFootprint(o.def, o.flipped);
    return { col: o.oc + fp.w - 1, row: o.or + fp.h - 1 };
  }

  /** Draw a multi-plot plow preview. Invalid plots remain visible in red and are
   * skipped when the caller commits. Touch selections also expose four handles. */
  setTillSelection(targets: readonly (TillTarget & { valid: boolean })[], showHandles: boolean) {
    this.cursor.visible = false;
    this.tillSelection.clear();
    this.tillSelectionHandles.clear();
    if (!targets.length) {
      this.tillSelectionLayer.visible = false;
      return;
    }
    const w = PLOT * HW;
    const h = PLOT * HH;
    for (const target of targets) {
      const c = this.plotCenterOf(target.oc, target.or);
      const color = target.valid ? 0x8df25a : 0xff5a5a;
      this.tillSelection.moveTo(c.x, c.y - h).lineTo(c.x + w, c.y)
        .lineTo(c.x, c.y + h).lineTo(c.x - w, c.y).lineTo(c.x, c.y - h)
        .fill({ color, alpha: 0.2 }).stroke({ width: 3, color, alpha: 0.95 });
    }
    if (showHandles) {
      const minOc = Math.min(...targets.map((t) => t.oc));
      const maxOc = Math.max(...targets.map((t) => t.oc));
      const minOr = Math.min(...targets.map((t) => t.or));
      const maxOr = Math.max(...targets.map((t) => t.or));
      const a = gridToScreen(minOc, minOr);
      const b = gridToScreen(maxOc + PLOT, minOr);
      const c = gridToScreen(maxOc + PLOT, maxOr + PLOT);
      const d = gridToScreen(minOc, maxOr + PLOT);
      const center = { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
      const sides: [TillHandleDirection, { x: number; y: number }, { x: number; y: number }][] = [
        ["row-", a, b], ["col+", b, c], ["row+", c, d], ["col-", d, a],
      ];
      for (const [direction, start, end] of sides) {
        const edge = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        const tx = end.x - start.x, ty = end.y - start.y;
        const length = Math.hypot(tx, ty);
        let ux = ty / length, uy = -tx / length;
        // Pick the perpendicular that points away from the selection's center.
        if (ux * (edge.x - center.x) + uy * (edge.y - center.y) < 0) {
          ux = -ux;
          uy = -uy;
        }
        const x = edge.x + ux * 30;
        const y = edge.y + uy * 30;
        const px = -uy, py = ux;
        this.tillSelectionHandles.set(direction, { x, y });
        this.tillSelection.circle(x, y, 18).fill({ color: 0x173510, alpha: 0.92 })
          .stroke({ width: 3, color: 0x8df25a, alpha: 0.95 });
        this.tillSelection.moveTo(x + ux * 10, y + uy * 10)
          .lineTo(x - ux * 7 + px * 8, y - uy * 7 + py * 8)
          .lineTo(x - ux * 7 - px * 8, y - uy * 7 - py * 8)
          .closePath().fill({ color: 0x8df25a });
      }
    }
    this.tillSelectionLayer.visible = true;
  }

  clearTillSelection() {
    this.tillSelection.clear();
    this.tillSelectionHandles.clear();
    this.tillSelectionLayer.visible = false;
  }

  tillHandleAt(x: number, y: number, radius: number): TillHandleDirection | null {
    for (const [direction, point] of this.tillSelectionHandles)
      if (Math.hypot(x - point.x, y - point.y) <= radius) return direction;
    return null;
  }
  // Center/size for a queued-object footprint marker.
  objectHighlightArea(id: string): { x: number; y: number; tiles: number } | null {
    const o = this.objects.get(id);
    if (!o) return null;
    const tiles = Math.max(o.def.tileW, o.def.tileH);
    const fp = objectFootprint(o.def, o.flipped);
    const base = this.footprintAnchor(o.oc, o.or, fp.w, fp.h);
    return { x: base.x, y: base.y - tiles * HH, tiles };
  }
  // Topmost object whose (tall) sprite contains world point (wx,wy) — so a tree
  // is clickable anywhere on its art, not just its footprint tile.
  objectAtPoint(wx: number, wy: number): string | null {
    let best: FarmObject | null = null;
    for (const o of this.objects.values()) {
      const s = o.sprite;
      let hit: boolean;
      if (o.def.petPen) {
        // The pen texture fills a rectangle but its actual fence is an isometric
        // diamond. Reject the large transparent corner triangles so clicks beside
        // the pen continue to target the ground instead of opening pet management.
        const grid = screenToGrid(wx, wy);
        const fp = objectFootprint(o.def, o.flipped);
        hit = grid.col >= o.oc - 0.5 && grid.col <= o.oc + fp.w - 0.5 &&
          grid.row >= o.or - 0.5 && grid.row <= o.or + fp.h - 0.5;
      } else if (o.def.category === "tree") {
        const top = s.y - s.height;
        const canopyBottom = top + s.height * TREE_CANOPY_HEIGHT_RATIO;
        const canopyHalfW = s.width * TREE_CANOPY_WIDTH_RATIO * 0.5;
        const trunkHalfW = s.width * TREE_TRUNK_WIDTH_RATIO * 0.5;
        hit = (wy >= top && wy <= canopyBottom &&
          wx >= s.x - canopyHalfW && wx <= s.x + canopyHalfW) ||
          (wy >= canopyBottom && wy <= s.y &&
            wx >= s.x - trunkHalfW && wx <= s.x + trunkHalfW);
      } else hit = wx >= s.x - s.width * 0.5 && wx <= s.x + s.width * 0.5 &&
        wy >= s.y - s.height && wy <= s.y;
      if (hit) {
        if (!best || o.oc + o.or > best.oc + best.or) best = o;
      }
    }
    return best ? best.id : null;
  }

  // Placement/move preview: a tinted ghost of the object at the snapped origin
  // (green tint if placeable, red if blocked). `ignoreId` = the object being moved.
  setObjectCursor(def: PlaceableDef, col: number, row: number, ignoreId?: string, turn = 0): { oc: number; or: number; valid: boolean } {
    turn = normalizeTurn(def, turn);
    const flipped = turnFlip(def, turn);
    const { oc, or } = this.resolveObjectOrigin(def, col, row, flipped);
    const valid = this.canPlaceObject(oc, or, def, ignoreId, flipped);
    this.cursorGreen.visible = false;
    this.cursorRed.visible = false;
    this.cursorLabel.visible = false;
    this.cursor.position.set(0, 0); // ghost positions are world-space
    // The ghost previews the corner it would actually lay, not just a mirrored one.
    this.objGhost.texture = this.assets.objects[turnArt(def, turn).sprite]
      ?? this.assets.objects[def.sprite] ?? Texture.EMPTY;
    this.ghostTurnIndex = turn;
    const s = this.objectScale();
    this.objGhost.scale.set(flipped ? -s : s, s); // preview the chosen orientation
    const fp = objectFootprint(def, flipped);
    const a = this.footprintAnchor(oc, or, fp.w, fp.h);
    const off = this.flatTileOffset(def, oc, or, flipped, turn);
    this.ghostDef = def;
    this.ghostTile = { col, row };
    this.ghostIgnoreId = ignoreId;
    this.objGhost.position.set(a.x + off.dx, this.objectRenderY(def, a.y) + off.dy);
    this.objGhost.alpha = 0.6;
    this.objGhost.tint = multiplyObjectTint(
      objectTint(def.color),
      valid ? 0x9cffa0 : 0xff8a8a,
    );
    this.objGhost.visible = true;
    this.cursor.visible = true;
    return { oc, or, valid };
  }
  // Turn the placement ghost in place — the Rotate control uses this to spin the
  // current preview without waiting for a pointer move. Turning an object transposes
  // its footprint, so this is a full re-resolve against the tile the ghost is
  // sitting on: where it lands, which tiles it would take, and whether it still
  // fits all change with the orientation.
  setGhostTurn(turn: number) {
    this.ghostTurnIndex = turn;
    const def = this.ghostDef;
    if (!def || !this.ghostTile) {
      const s = this.objectScale();
      this.objGhost.scale.x = turn === 1 ? -s : s;
      return;
    }
    this.setObjectCursor(def, this.ghostTile.col, this.ghostTile.row, this.ghostIgnoreId, turn);
  }
  get ghostTurn(): number {
    return this.ghostTurnIndex;
  }
  hideObjectCursor() {
    this.objGhost.visible = false;
  }

  // ---- persistence ----------------------------------------------------------

  // Snapshot every plot for saving. Crop timers are stored as the absolute plantedAt
  // epoch (the live source of truth) so growth keeps advancing while the game is
  // closed and is recomputed exactly on reload — no drift from the frozen render loop.
  serialize(): PlotSave[] {
    const out: PlotSave[] = [];
    for (const p of this.plots.values()) {
      const ps: PlotSave = { oc: p.oc, or: p.or, state: p.state };
      if (p.crop) {
        ps.crop = {
          key: p.crop.cfg.key,
          isZombie: !!p.crop.cfg.isZombie,
          plantedAt: p.crop.plantedAt,
          growMs: p.crop.cfg.growMs,
          fertilized: p.crop.fertilized,
        };
      }
      out.push(ps);
    }
    return out;
  }

  // Rebuild all plots from a save. `resolve` maps a crop key to its config
  // (from the plant/zombie catalog); an unknown key falls back to a plowed plot.
  restore(plots: PlotSave[], resolve: (key: string) => CropConfig | undefined) {
    // Tear down any existing plots/crops (fresh field at startup = no-op).
    for (const p of this.plots.values()) {
      p.soil.destroy();
      if (p.crop) destroyCrop(p.crop);
    }
    this.plots.clear();
    this.tilePlot.clear();
    this.reserved.clear();
    this.plotLayer.removeChildren();

    const soilFile: Record<PlotState, string> = {
      plowed: PLOWED_FILE,
      planted: SEED_FILE,
      dirt: DIRT_FILE,
      hole: HOLE_FILE,
    };
    const now = Date.now();
    for (const ps of plots) {
      const { oc, or } = ps;
      if (!this.fits(oc, or) || !this.areaFree(oc, or)) continue; // stale/overlapping
      const k = this.key(oc, or);
      const soil = new Sprite();
      this.fit(soil, this.assets.soil[soilFile[ps.state]], oc, or, PLOT);
      this.plotLayer.addChild(soil);
      const plot: Plot = { oc, or, soil, state: ps.state };
      this.plots.set(k, plot);
      this.forEachTile(oc, or, (t) => this.tilePlot.set(t, k));

      if (ps.state === "planted" && ps.crop) {
        const base = resolve(ps.crop.key);
        if (base) {
          const cfg: CropConfig = {
            ...base,
            growMs: ps.crop.growMs,
            isZombie: ps.crop.isZombie,
          };
          // plantedAt is the persisted absolute truth; the ageMs cache is derived from
          // it here (and re-derived every frame in update()). Clamp the cache to growMs
          // so a crop that finished growing while the game was closed reads as ripe.
          const ageMs = Math.max(0, Math.min(cfg.growMs, now - ps.crop.plantedAt));
          const crop: Planting = { cfg, plantedAt: ps.crop.plantedAt, ageMs, sprite: new Sprite(), baseY: 0, fertilized: ps.crop.fertilized };
          // layoutCrop parents by stage; the update(0) below then re-layers it to
          // match its restored age (seed -> ground layer, grown -> entity layer).
          crop.baseY = this.layoutCrop(crop, cfg.stages[0], oc, or);
          plot.crop = crop;
        } else {
          // Unknown crop key: leave a plowed plot rather than a broken one.
          plot.state = "plowed";
          this.fit(soil, this.assets.soil[PLOWED_FILE], oc, or, PLOT);
        }
      }
    }
    this.update(0); // set correct growth-stage textures immediately (no flash)
  }

  /** Adopt authoritative timers/fertilization without tearing down plots whose
   *  identity and soil state already agree. A structural disagreement still uses
   *  the full restore path so rejected optimistic actions are visibly corrected. */
  reconcilePlots(plots: PlotSave[], resolve: (key: string) => CropConfig | undefined) {
    const wanted = new Map(plots.map((p) => [this.key(p.oc, p.or), p]));
    let sameStructure = wanted.size === plots.length && wanted.size === this.plots.size;
    if (sameStructure) {
      for (const [key, current] of this.plots) {
        const next = wanted.get(key);
        if (
          !next ||
          current.state !== next.state ||
          (current.state === "planted" &&
            (!current.crop || !next.crop || current.crop.cfg.key !== next.crop.key))
        ) {
          sameStructure = false;
          break;
        }
      }
    }
    if (!sameStructure) {
      this.restore(plots, resolve);
      return;
    }

    const now = Date.now();
    for (const [key, current] of this.plots) {
      if (current.state !== "planted" || !current.crop) continue;
      const saved = wanted.get(key)!.crop!;
      const base = resolve(saved.key);
      if (!base) {
        this.restore(plots, resolve);
        return;
      }
      current.crop.cfg = {
        ...base,
        growMs: saved.growMs,
        isZombie: saved.isZombie,
      };
      current.crop.plantedAt = saved.plantedAt;
      current.crop.ageMs = Math.max(0, Math.min(saved.growMs, now - saved.plantedAt));
      current.crop.fertilized = saved.fertilized;
    }
    this.update(0);
  }

  /** The catalog key of every object standing on the farm, one entry per placed copy.
   *  What the derived capacities are a function of (see armyCapacity.ts) — they have
   *  no business going through the save serializer to read a key off a save record. */
  *placedKeys(): Generator<string> {
    for (const o of this.objects.values()) yield o.def.key;
  }

  serializeObjects(): PlacedObjectSave[] {
    const out: PlacedObjectSave[] = [];
    for (const o of this.objects.values()) {
      const s: PlacedObjectSave = { id: o.id, key: o.def.key, oc: o.oc, or: o.or };
      if (o.def.harvestValue) s.readyAt = o.readyAt; // fruit-tree ripen timer
      // Orientation. Art that turns by mirroring keeps writing `rotation` (0/1); a
      // piece with its own art per corner writes the corner index instead, so a road
      // bend saved by an older build — where the only orientations WERE mirror or
      // not — comes back as the corner it drew, not as a different one.
      if (o.def.turns) { if (o.turn) s.turn = o.turn; }
      else if (o.flipped) s.rotation = 1;
      if (o.memorial) s.memorial = o.memorial; // the zombie enshrined on this plinth
      out.push(s);
    }
    return out;
  }

  /** Re-place one saved object, tolerating a saved position that its real footprint
   *  no longer fits.
   *
   *  Saves written before a turned object transposed its footprint (see
   *  objectFootprint) recorded the origin of a rectangle laid out the OTHER way
   *  round, so a hedge saved hard against the farm's east edge, or butted up against
   *  its neighbour, can now want tiles that are off the map or already taken.
   *  Losing the object is the one outcome a player cannot undo, so give ground in
   *  this order: nudge it back inside the farm, then, failing that, drop the flip
   *  and keep the object. Returns whether it made it onto the farm. */
  private restoreOneObject(
    def: PlaceableDef, s: PlacedObjectSave, memorial?: FallenZombie,
  ): boolean {
    const attempt = (turn: number): boolean => {
      const fp = objectFootprint(def, turnFlip(def, turn));
      // Clamp rather than reject: an origin one tile past the edge is a legal object
      // in the wrong place, not a missing one.
      const oc = Math.max(0, Math.min(s.oc, this.w - fp.w));
      const or = Math.max(0, Math.min(s.or, this.h - fp.h));
      return !!this.placeObject(def, oc, or, s.id, s.readyAt, turn, memorial);
    };
    const saved = savedTurn(def, s);
    return attempt(saved) || (!!saved && attempt(0));
  }

  // Rebuild placed objects from a save. `resolve` maps a def key to its config.
  restoreObjects(saves: PlacedObjectSave[], resolve: (key: string) => PlaceableDef | undefined) {
    for (const o of this.objects.values()) {
      this.destroyObjectSprites(o);
      this.destroyObjectLight(o);
    }
    this.objects.clear();
    this.tileObject.clear();
    this.fenceBlock.clear();
    this.topologyChanged();
    const restored: string[] = [];
    for (const s of saves) {
      const def = resolve(s.key);
      if (!def) continue;
      // A memorial occupant comes straight out of a save file, so it goes through
      // the same shape check the graveyard list does before a rig is built from it.
      // Uncapped: this is an ENSHRINED zombie, which the graveyard's cap never
      // counts (see sanitizeFallenUncapped).
      const memorial = s.memorial ? sanitizeFallenUncapped([s.memorial])[0] : undefined;
      this.restoreOneObject(def, s, memorial);
      restored.push(s.id); // reserve the id even if the object could not be re-placed
    }
    // Monotonic: a save whose objects all carry server instance ids scans to nothing,
    // and dropping the counter back would re-issue ids this session already aliased to
    // live server objects. See src/objectIds.ts for what that used to destroy.
    this.nextObjId = objectIdFloor(this.nextObjId, restored);
  }

  /** A local id for a newly placed object that cannot collide with one already in play. */
  private mintId(): string {
    const { id, next } = mintObjectId(this.nextObjId, this.objects);
    this.nextObjId = next;
    return id;
  }
}
