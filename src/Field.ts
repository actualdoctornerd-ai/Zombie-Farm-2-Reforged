// The isometric terrain. The ground is a fine 30x30 grid of small tiles; farming
// happens on PLOTS — 4x4 tile blocks that can be placed FREELY anywhere a 4x4 area
// is available (not on a fixed lattice). A plot cycles through soil states:
//   plowed -> planted -> (grows) -> harvest -> dirt (crop) / hole (zombie) -> re-till.
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
  DIRT_FILE, GameAssets, HOLE_FILE, PlaceableDef, PLOWED_FILE, SEED_FILE,
} from "./assets";
import { gridToScreen, HH, HW, TILE_H, TILE_W, tileCenter } from "./iso";
import { setFootprint, sortLayer } from "./depthSort";
import { makeLight, OBJECT_GLOWS } from "./lighting";
import { leafTexture, ParticleConfig, ParticleField } from "./raid/Particles";
import type { PlacedObjectSave, PlotSave } from "./save/schema";

export const PLOT = 4; // tiles per plot side

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
  sprite: Sprite; // the whole crop, depth-sorted in the entity layer (like objects)
  baseY: number;
  fertilized?: boolean; // a Garden zombie fertilized it → 2x harvest + leaf FX
  fertEmitMs?: number; // countdown to the next leaf emit (fertilized crops only)
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

// A placed farm object (tree/decor) occupying a tileW x tileH footprint.
interface FarmObject {
  id: string;
  def: PlaceableDef;
  oc: number; // footprint origin (north tile)
  or: number;
  sprite: Sprite;
  light?: Sprite; // additive night glow (glowing objects only), lives in the night layer
  // Fruit trees only: readyAt = epoch ms the fruit ripens; ready = fruit present.
  readyAt: number;
  ready: boolean;
  // Rotated by the Rotate tool: a horizontal mirror (flip on the vertical axis), so
  // a directional decor (fences!) can face either diagonal. The footprint is a
  // rectangle centered under the sprite, so mirroring never moves which tiles it
  // occupies — collision/depth are unaffected; only the art flips.
  flipped: boolean;
}

export class Field {
  readonly container = new Container();
  readonly groundLayer = new Container();
  readonly plotLayer = new Container();
  // Seed-stage crops live here — ABOVE the soil but BELOW the entity layer, so a
  // just-seeded plot layers exactly like plain plowed soil (actors always draw over
  // it). Once a crop grows past the seed stage it graduates to the entity layer and
  // depth-sorts by its footprint like any object. See layoutCrop.
  readonly cropSeedLayer = new Container();
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
  // Night lights for glowing objects. main parents this into the NightLayer, which
  // erases them out of the darkness so a glow reveals the scene around it at night.
  readonly objectLights = new Container();
  readonly cursor = new Container();
  private cursorGreen = new Graphics();
  private cursorRed = new Graphics();
  private cursorLabel!: Text;
  private objGhost = new Sprite(); // placement/move preview
  private ghostFlipped = false; // current horizontal-flip of the placement ghost
  // Field dimensions in tiles. Mutable: the Farm Size upgrade grows them at
  // runtime (origin stays at tile 0,0, so all existing plots/objects keep their
  // coordinates — the farm only gains land on its south/east edges).
  w = 0;
  h = 0;
  // Current ground/climate skin (a ground_index terrain key). The whole farm's
  // terrain tiles use this; changed by a Market → Upgrade → Ground purchase.
  climate = "grass";

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
  private nextObjId = 1;
  private highlightedObj: string | null = null;

  constructor(private assets: GameAssets) {
    this.groundObjectLayer.sortableChildren = true;
    this.entityLayer.sortableChildren = true;
    this.resize(assets.field.w, assets.field.h); // builds the initial ground grid
    this.buildCursor();
    this.objGhost.anchor.set(0.5, 1);
    this.objGhost.visible = false;
    this.cursor.addChild(this.objGhost);
    this.container.addChild(
      this.groundLayer, this.plotLayer, this.cropSeedLayer, this.groundObjectLayer, this.highlightLayer
    );
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

  // Can an actor walk on this tile? Placed objects block movement, EXCEPT the
  // Zombie Patch (it's walkable soil zombies nap on). Plots and bare ground are
  // walkable. Used by pathfinding (farmer + wandering zombies).
  isPassable(col: number, row: number): boolean {
    if (!this.inBounds(col, row)) return false;
    const k = `${col},${row}`;
    // A solid object on the tile blocks it (the walkable Zombie Patch is the exception).
    const id = this.tileObject.get(k);
    if (id && !this.objects.get(id)?.def.zombiePatch) return false;
    // A fence panel overhanging from a neighbour tile blocks it for movement too, even
    // though nothing "owns" this tile for placement.
    if (this.fenceBlock.get(k)?.size) return false;
    return true;
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
  // roughly centered on the pointer.
  private originFor(col: number, row: number) {
    return { oc: col - 1, or: row - 1 };
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
    { name: string; isZombie: boolean; ripe: boolean; remainingMs: number; growMs: number } | null {
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
  removePlot(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const k = this.key(at.oc, at.or);
    const p = this.plots.get(k);
    if (!p) return false;
    if (p.crop) p.crop.sprite.destroy(); // whole crop (entityLayer); auto-removes from parent
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
  growSomeCrops(n: number, priority?: { col: number; row: number }): number {
    let done = 0;
    if (priority) {
      const at = this.plotOriginAt(priority.col, priority.row);
      const c = at ? this.plots.get(this.key(at.oc, at.or))!.crop : undefined;
      if (c && c.ageMs < c.cfg.growMs && done < n) {
        this.ripenNow(c); // now ripe; the loop below skips it (age >= growMs)
        done++;
      }
    }
    for (const p of this.plots.values()) {
      if (done >= n) break;
      const c = p.crop;
      if (c && c.ageMs < c.cfg.growMs) {
        this.ripenNow(c);
        done++;
      }
    }
    if (done) this.update(0); // refresh growth-stage textures to the ripe frame now
    return done;
  }

  /** Ripen exactly the crop at (col,row) if it is still growing — the manual
   *  Insta-Grow tool targets one plot per tap. Returns true only when a growing
   *  crop was actually ripened (false for empty/ripe/out-of-bounds plots, so a
   *  stray tap never wastes a use or ripens some other plot). */
  growCropAt(col: number, row: number): boolean {
    const at = this.plotOriginAt(col, row);
    if (!at) return false;
    const c = this.plots.get(this.key(at.oc, at.or))?.crop;
    if (!c || c.ageMs >= c.cfg.growMs) return false;
    this.ripenNow(c); // now ripe
    this.update(0); // refresh the growth-stage texture to the ripe frame now
    return true;
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

  /** Insta-Plow: re-plow every harvested (dirt/hole) plot. Returns the count. */
  replowSpent(): number {
    let done = 0;
    for (const p of this.plots.values())
      if (p.state === "dirt" || p.state === "hole") {
        if (this.tillAt(p.oc, p.or)) done++;
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
  plantAt(oc: number, or: number, cfg: CropConfig): boolean {
    const p = this.plots.get(this.key(oc, or));
    if (!p || p.state !== "plowed" || p.crop) return false;
    this.fit(p.soil, this.assets.soil[SEED_FILE], oc, or, PLOT); // seeded soil
    const tex = this.assets.crop[cfg.stages[0]];
    // Mutant Monolith: a mutant-zombie crop planted while the monolith is placed
    // grows in half the time. Bake it into this planting's own config (persists via
    // the per-crop growMs) so it stays consistent across save/reload.
    const useCfg = cfg.isMutant && cfg.growMs > 0 && this.hasMutantMonolith()
      ? { ...cfg, growMs: Math.round(cfg.growMs * 0.5) }
      : cfg;
    const crop: Planting = { cfg: useCfg, plantedAt: Date.now(), ageMs: 0, sprite: new Sprite(), baseY: 0 };
    crop.baseY = this.layoutCrop(crop, tex, oc, or); // layoutCrop parents by stage
    p.crop = crop;
    p.state = "planted";
    return true;
  }

  /** Lay out a crop's single sprite for stage `tex`, and put it in the right layer.
   *
   *  At the SEED stage (stages[0]) the crop layers like plain tilled soil: it lives
   *  in cropSeedLayer (above the soil, below the entity layer) so actors always draw
   *  OVER it and never get hidden behind a flat seeded plot.
   *
   *  Once it grows PAST the seed stage the whole crop graduates to the depth-sorted
   *  entityLayer and sorts by its 4x4 plot footprint, exactly like a placed object:
   *  an actor standing anywhere on the plot (or south of it) draws in front, one
   *  standing north (behind) is covered. Simple painter's order — no per-crop
   *  splitting — so nothing "splits" when someone stands on the plot. */
  private layoutCrop(c: Planting, tex: Texture, oc: number, or: number): number {
    const soil = this.assets.soil[PLOWED_FILE];
    const scale = (PLOT * TILE_W) / tex.width;
    const soilH = soil.height * ((PLOT * TILE_W) / soil.width);
    const p = gridToScreen(oc, or);
    const baseY = p.y + (PLOT * TILE_H + soilH) / 2;

    c.sprite.anchor.set(0.5, 1); // bottom-center = the crop's ground contact point
    c.sprite.texture = tex;
    c.sprite.scale.set(scale);
    c.sprite.position.set(p.x, baseY);
    if (tex === this.assets.crop[c.cfg.stages[0]]) {
      // Seed stage: KEEP IT ON THE GROUND. A just-seeded plot reads like tilled land,
      // so it lives in cropSeedLayer (above soil, below the entity layer) with NO
      // footprint — it never depth-sorts, so the farmer always walks over it just like
      // he does over the plowed dirt beneath it.
      this.cropSeedLayer.addChild(c.sprite);
    } else {
      // Past seed: the plant patch is a real depth-sorted entity, handled EXACTLY like
      // a placed object — same entityLayer, same full-footprint setFootprint call (the
      // patch fills all 16 tiles of its 4x4 plot, so its footprint is the whole plot,
      // just as a 4x4 object's footprint is its whole base). It then loads back-to-
      // front, top-to-bottom, left-to-right with every other object (see depthSort).
      this.entityLayer.addChild(c.sprite);
      setFootprint(c.sprite, oc, or, oc + PLOT - 1, or + PLOT - 1);
    }
    return baseY;
  }

  // Harvest a ripe plot: crop -> dirt square, zombie -> hole. Returns {sell,xp,name};
  // for a zombie crop, `zombieKey` names the unit type to spawn as an owned zombie.
  // `name` is the crop/zombie display name (for quest-progress matching).
  harvestAt(oc: number, or: number): { sell: number; xp: number; name: string; isZombie: boolean; fertilized: boolean; zombieKey?: string } | null {
    const p = this.plots.get(this.key(oc, or));
    if (!p || !p.crop || p.crop.ageMs < p.crop.cfg.growMs) return null;
    const { cfg } = p.crop;
    // Fertilized (by a Garden zombie): the harvest is worth DOUBLE — ground truth
    // (`isFertilized` yields 6 crop drops instead of 3).
    const fertilized = !!p.crop.fertilized;
    const sell = fertilized ? cfg.sell * 2 : cfg.sell;
    p.crop.sprite.destroy();
    p.crop = undefined;
    p.state = cfg.isZombie ? "hole" : "dirt";
    this.fit(p.soil, this.assets.soil[cfg.isZombie ? HOLE_FILE : DIRT_FILE], oc, or, PLOT);
    return { sell, xp: cfg.xp, name: cfg.name, isZombie: !!cfg.isZombie, fertilized, zombieKey: cfg.isZombie ? cfg.key : undefined };
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
      const tex = this.assets.crop[c.cfg.stages[stage]];
      // On a stage change, re-layout both the ground crop and its protruding topper.
      if (c.sprite.texture !== tex) this.layoutCrop(c, tex, p.oc, p.or);
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
    // Ripen fruit trees: when the timer elapses, swap to the fruit-bearing sprite.
    for (const o of this.objects.values()) {
      if (!o.def.harvestValue || o.ready || now < o.readyAt) continue;
      o.ready = true;
      this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, true, o.flipped);
    }
    // Runs LAST in the frame (after the farmer + zombies have moved), so the
    // footprint depth-sort sees final positions. Ground objects (roads/patch) share
    // their own layer and only need ordering among themselves.
    sortLayer(this.entityLayer);
    sortLayer(this.groundObjectLayer);
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
    const ext = def.collideExtend;
    if (!ext?.length) return [];
    const out: string[] = [];
    for (const e of ext) {
      const c = oc + (flipped ? e.dr : e.dc);
      const r = or + (flipped ? e.dc : e.dr);
      if (c >= 0 && r >= 0 && c < this.w && r < this.h) out.push(`${c},${r}`);
    }
    return out;
  }
  private setExtensionBlocks(id: string, def: PlaceableDef, oc: number, or: number, flipped: boolean, add: boolean) {
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
  // Which sprite to show: a fruit tree that isn't ripe shows its growing frame.
  private objectSpriteName(def: PlaceableDef, ready: boolean): string {
    return !ready && def.growingSprite ? def.growingSprite : def.sprite;
  }
  private isGroundObject(def: PlaceableDef): boolean {
    return def.zombiePatch || /road/i.test(def.key);
  }
  private fitObjectSprite(sp: Sprite, def: PlaceableDef, oc: number, or: number, ready = true, flipped = false) {
    const name = this.objectSpriteName(def, ready);
    sp.texture = this.assets.objects[name] ?? this.assets.objects[def.sprite] ?? Texture.EMPTY;
    sp.anchor.set(0.5, 1);
    const s = this.objectScale();
    // Flip = mirror horizontally (about the sprite's bottom-center anchor), so the
    // art faces the other way while sitting in the exact same footprint tiles.
    sp.scale.set(flipped ? -s : s, s);
    const a = this.footprintAnchor(oc, or, def.tileW, def.tileH);
    sp.position.set(a.x, a.y);
    // Depth-sorts by the object's full footprint (see depthSort): an actor on the
    // object's own tiles or south of it draws in front, one behind it is covered.
    setFootprint(sp, oc, or, oc + def.tileW - 1, or + def.tileH - 1);
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
    const a = this.footprintAnchor(obj.oc, obj.or, obj.def.tileW, obj.def.tileH);
    // Raise the glow off the ground onto the object's body.
    l.position.set(a.x, a.y - (l.height ?? 0) * 0.35);
  }
  private destroyObjectLight(obj: FarmObject) {
    obj.light?.parent?.removeChild(obj.light);
    obj.light?.destroy();
    obj.light = undefined;
  }

  // Center a def's footprint on the pointer tile.
  resolveObjectOrigin(def: PlaceableDef, col: number, row: number): { oc: number; or: number } {
    return { oc: col - Math.floor((def.tileW - 1) / 2), or: row - Math.floor((def.tileH - 1) / 2) };
  }
  canPlaceObject(oc: number, or: number, def: PlaceableDef, ignoreId?: string): boolean {
    return (
      this.footprintFits(oc, or, def.tileW, def.tileH) &&
      this.footprintFree(oc, or, def.tileW, def.tileH, ignoreId)
    );
  }

  // Place a new object (id auto-generated) or restore one (id given). For fruit
  // trees, `readyAt` sets when fruit ripens (defaults to now + growMs for a fresh
  // placement); a past readyAt means it's already ripe (offline growth). Returns
  // the object id, or null if the footprint isn't valid.
  placeObject(def: PlaceableDef, oc: number, or: number, id?: string, readyAt?: number, flipped = false): string | null {
    if (!this.canPlaceObject(oc, or, def, id)) return null;
    const now = Date.now();
    const ra = def.growMs ? readyAt ?? now + def.growMs : 0;
    const ready = def.growMs ? now >= ra : false;
    const sprite = new Sprite();
    this.fitObjectSprite(sprite, def, oc, or, ready, flipped);
    (this.isGroundObject(def) ? this.groundObjectLayer : this.entityLayer).addChild(sprite);
    const oid = id ?? `o${this.nextObjId++}`;
    const obj: FarmObject = { id: oid, def, oc, or, sprite, readyAt: ra, ready, flipped };
    this.objects.set(oid, obj);
    this.attachObjectLight(obj);
    this.forEachFootprint(oc, or, def.tileW, def.tileH, (t) => this.tileObject.set(t, oid));
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
  // The footprint tiles of the placed Zombie Patch, for zombies to gather onto.
  patchRestTiles(): { col: number; row: number }[] | null {
    for (const o of this.objects.values()) {
      if (!o.def.zombiePatch) continue;
      const tiles: { col: number; row: number }[] = [];
      for (let r = o.or; r < o.or + o.def.tileH; r++)
        for (let c = o.oc; c < o.oc + o.def.tileW; c++) tiles.push({ col: c, row: r });
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
    this.forEachFootprint(o.oc, o.or, o.def.tileW, o.def.tileH, (t) => this.tileObject.delete(t));
    if (!this.footprintFits(o.oc, o.or, def.tileW, def.tileH) ||
        !this.footprintFree(o.oc, o.or, def.tileW, def.tileH, id)) {
      // restore the old footprint occupancy and bail
      this.forEachFootprint(o.oc, o.or, o.def.tileW, o.def.tileH, (t) => this.tileObject.set(t, id));
      return false;
    }
    this.setExtensionBlocks(id, o.def, o.oc, o.or, o.flipped, false);
    o.def = def;
    o.ready = def.growMs ? o.ready : false;
    this.fitObjectSprite(o.sprite, def, o.oc, o.or, true, o.flipped);
    this.forEachFootprint(o.oc, o.or, def.tileW, def.tileH, (t) => this.tileObject.set(t, id));
    this.setExtensionBlocks(id, def, o.oc, o.or, o.flipped, true);
    return true;
  }

  // Relocate an existing object; false if the destination footprint is invalid.
  // `flipped`, when given, also commits a new orientation (the Move tool lets you
  // rotate while carrying); omitted keeps the object's current flip.
  moveObject(id: string, oc: number, or: number, flipped?: boolean): boolean {
    const obj = this.objects.get(id);
    if (!obj || !this.canPlaceObject(oc, or, obj.def, id)) return false;
    this.forEachFootprint(obj.oc, obj.or, obj.def.tileW, obj.def.tileH, (t) => this.tileObject.delete(t));
    this.setExtensionBlocks(id, obj.def, obj.oc, obj.or, obj.flipped, false);
    obj.oc = oc;
    obj.or = or;
    if (flipped !== undefined) obj.flipped = flipped;
    this.fitObjectSprite(obj.sprite, obj.def, oc, or, obj.ready, obj.flipped);
    this.positionObjectLight(obj);
    this.forEachFootprint(oc, or, obj.def.tileW, obj.def.tileH, (t) => this.tileObject.set(t, id));
    this.setExtensionBlocks(id, obj.def, oc, or, obj.flipped, true);
    return true;
  }

  // Is this object a fruit tree with ripe fruit ready to harvest?
  isObjectReady(id: string): boolean {
    const o = this.objects.get(id);
    return !!o && !!o.def.harvestValue && o.ready;
  }
  // Harvest a ripe fruit tree: award its value, reset it to growing. Returns the
  // gold value, or null if it wasn't a ripe fruit tree.
  harvestObject(id: string): number | null {
    const o = this.objects.get(id);
    if (!o || !o.def.harvestValue || !o.ready) return null;
    o.ready = false;
    o.readyAt = Date.now() + (o.def.growMs ?? 0);
    this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, false, o.flipped);
    return o.def.harvestValue;
  }
  removeObject(id: string): PlaceableDef | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    if (this.highlightedObj === id) this.highlightedObj = null;
    this.forEachFootprint(obj.oc, obj.or, obj.def.tileW, obj.def.tileH, (t) => this.tileObject.delete(t));
    this.setExtensionBlocks(id, obj.def, obj.oc, obj.or, obj.flipped, false);
    obj.sprite.parent?.removeChild(obj.sprite);
    obj.sprite.destroy();
    this.destroyObjectLight(obj);
    this.objects.delete(id);
    return obj.def;
  }

  // Tint the object under the Remove tool's cursor so the player sees what will be
  // removed; pass null to clear. No-op if it's already the highlighted object.
  setObjectHighlight(id: string | null) {
    if (id === this.highlightedObj) return;
    const prev = this.highlightedObj ? this.objects.get(this.highlightedObj) : null;
    if (prev) prev.sprite.tint = 0xffffff;
    this.highlightedObj = id;
    const next = id ? this.objects.get(id) : null;
    if (next) next.sprite.tint = 0xff7a6a; // reddish "will remove" wash
  }
  objectDefOf(id: string): PlaceableDef | null {
    return this.objects.get(id)?.def ?? null;
  }
  objectOriginOf(id: string): { oc: number; or: number } | null {
    const o = this.objects.get(id);
    return o ? { oc: o.oc, or: o.or } : null;
  }
  // Current horizontal-flip of a placed object (for the Move tool to carry it over).
  objectFlipOf(id: string): boolean {
    return !!this.objects.get(id)?.flipped;
  }
  // Rotate tool: mirror a placed object on the vertical axis. Footprint is unchanged
  // (see FarmObject.flipped), so only the art flips. Returns the new flip state.
  flipObject(id: string): boolean {
    const o = this.objects.get(id);
    if (!o) return false;
    o.flipped = !o.flipped;
    this.fitObjectSprite(o.sprite, o.def, o.oc, o.or, o.ready, o.flipped);
    return o.flipped;
  }
  // World point the farmer walks to in order to harvest this object (its base).
  objectWorkPoint(id: string): { x: number; y: number } | null {
    const o = this.objects.get(id);
    return o ? this.footprintAnchor(o.oc, o.or, o.def.tileW, o.def.tileH) : null;
  }
  // Center/size for a queued-object footprint marker.
  objectHighlightArea(id: string): { x: number; y: number; tiles: number } | null {
    const o = this.objects.get(id);
    if (!o) return null;
    const tiles = Math.max(o.def.tileW, o.def.tileH);
    const base = this.footprintAnchor(o.oc, o.or, o.def.tileW, o.def.tileH);
    return { x: base.x, y: base.y - tiles * HH, tiles };
  }
  // Topmost object whose (tall) sprite contains world point (wx,wy) — so a tree
  // is clickable anywhere on its art, not just its footprint tile.
  objectAtPoint(wx: number, wy: number): string | null {
    let best: FarmObject | null = null;
    for (const o of this.objects.values()) {
      const s = o.sprite;
      if (wx >= s.x - s.width * 0.5 && wx <= s.x + s.width * 0.5 && wy >= s.y - s.height && wy <= s.y) {
        if (!best || o.oc + o.or > best.oc + best.or) best = o;
      }
    }
    return best ? best.id : null;
  }

  // Placement/move preview: a tinted ghost of the object at the snapped origin
  // (green tint if placeable, red if blocked). `ignoreId` = the object being moved.
  setObjectCursor(def: PlaceableDef, col: number, row: number, ignoreId?: string, flipped = false): { oc: number; or: number; valid: boolean } {
    const { oc, or } = this.resolveObjectOrigin(def, col, row);
    const valid = this.canPlaceObject(oc, or, def, ignoreId);
    this.cursorGreen.visible = false;
    this.cursorRed.visible = false;
    this.cursorLabel.visible = false;
    this.cursor.position.set(0, 0); // ghost positions are world-space
    this.objGhost.texture = this.assets.objects[def.sprite] ?? Texture.EMPTY;
    this.ghostFlipped = flipped;
    const s = this.objectScale();
    this.objGhost.scale.set(flipped ? -s : s, s); // preview the chosen orientation
    const a = this.footprintAnchor(oc, or, def.tileW, def.tileH);
    this.objGhost.position.set(a.x, a.y);
    this.objGhost.alpha = 0.6;
    this.objGhost.tint = valid ? 0x9cffa0 : 0xff8a8a;
    this.objGhost.visible = true;
    this.cursor.visible = true;
    return { oc, or, valid };
  }
  // Flip the placement ghost in place (no reposition) — the Rotate control uses this
  // to spin the current preview without waiting for a pointer move.
  setGhostFlip(flipped: boolean) {
    this.ghostFlipped = flipped;
    const s = this.objectScale();
    this.objGhost.scale.x = flipped ? -s : s;
  }
  get ghostFlip(): boolean {
    return this.ghostFlipped;
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
      p.crop?.sprite.destroy();
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
          crop.baseY = this.layoutCrop(crop, this.assets.crop[cfg.stages[0]], oc, or);
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

  serializeObjects(): PlacedObjectSave[] {
    const out: PlacedObjectSave[] = [];
    for (const o of this.objects.values()) {
      const s: PlacedObjectSave = { id: o.id, key: o.def.key, oc: o.oc, or: o.or };
      if (o.def.harvestValue) s.readyAt = o.readyAt; // fruit-tree ripen timer
      if (o.flipped) s.rotation = 1; // horizontally mirrored by the Rotate tool
      out.push(s);
    }
    return out;
  }

  // Rebuild placed objects from a save. `resolve` maps a def key to its config.
  restoreObjects(saves: PlacedObjectSave[], resolve: (key: string) => PlaceableDef | undefined) {
    for (const o of this.objects.values()) {
      o.sprite.parent?.removeChild(o.sprite);
      o.sprite.destroy();
      this.destroyObjectLight(o);
    }
    this.objects.clear();
    this.tileObject.clear();
    this.fenceBlock.clear();
    let maxN = 0;
    for (const s of saves) {
      const def = resolve(s.key);
      if (!def || !this.footprintFits(s.oc, s.or, def.tileW, def.tileH)) continue;
      this.placeObject(def, s.oc, s.or, s.id, s.readyAt, !!s.rotation);
      const m = /^o(\d+)$/.exec(s.id);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    this.nextObjId = maxN + 1;
  }
}
