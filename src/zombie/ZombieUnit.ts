// One owned zombie on the farm, assembled from its PER-TYPE model (reverse-
// engineered from ZombieSheet — real body/head/features per group x tier) and
// tinted by its authentic unit colour. It idles/wanders the farm, routing around
// placed objects via A* over the occupancy grid, and can be selected (a glowing
// foot ring) to inspect its stats.
//
// Animation: the head group rocks back/forth, the legs step while moving, and the
// whole rig translates along its path.
import { Container, Graphics, Sprite } from "pixi.js";
import { GameAssets, ZombieModel } from "../assets";
import { Field } from "../Field";
import { depth, screenToGrid, tileCenter } from "../iso";
import { setFootprint } from "../depthSort";
import { findPath } from "../pathfind";
import { OwnedZombie } from "./types";
import { bitsOf, slotOf } from "./mutations";

// Head replacements draw over the base skull but under facial parts, so eyes stay
// visible on Onion/Tomato/etc. Hair/eye mutations draw above the face.
const MUT_HEAD_REPLACE_Z = 4.5;
const MUT_FACE_OVERLAY_Z = 20;

const SPEED_PX = 34; // slow amble
const WANDER_RADIUS = 5; // tiles from current spot to pick a new target
// Global multiplier on a model's own `scale`. The model `scale` values ARE the
// exact per-group whole-actor setScale from the ZF2 binary (Regular 0.90, Small
// 0.60, Girl 0.80, Garden 0.70, Large 1.15, Headless 0.90 — see prep_zombie_models
// scale_of), so this stays 1.0 to render them at the game's true size.
const MODEL_BASE = 1.0;

const TILT_AMP_MOVE = 0.1;
const TILT_AMP_IDLE = 0.05;
const TILT_PERIOD_MOVE = 2.0;
const TILT_PERIOD_IDLE = 4.0;
const TILT_BACK_FRAC = 0.6;

const STEP_SPEED = 4.5;
const STEP_LIFT = 2.5;
const STEP_ANGLE = 0.18;
const FERTILIZE_CAST_MS = 1100;
const FERTILIZE_RAISE_MS = 220;
const FERTILIZE_LOWER_MS = 220;
const ARM_RAISE_ANGLE = -2.5;

export class ZombieUnit {
  readonly container = new Container();
  readonly id: string;
  private data: OwnedZombie;
  private field: Field;
  private root = new Container();
  // Head parts live as flat siblings in `root` (sorted by their own zIndex, like the
  // engine's single-layer draw order — so a z8 beard sits over the z7 front arm), and
  // are tilted for the idle/walk head-nod by rotating each around the neck point every
  // frame instead of via a wrapping container (which would collapse them to one z).
  private neck = { x: 0, y: 0 };
  private headParts: { sp: Sprite; bx: number; by: number }[] = [];
  private parts: Sprite[] = [];
  private ring = new Graphics();
  private footF!: Sprite;
  private footB!: Sprite;
  private footFBaseY = 0;
  private footBBaseY = 0;
  private arms: { sp: Sprite; baseRotation: number }[] = [];
  private renderScale = MODEL_BASE; // MODEL_BASE * model group-scale

  private wx = 0;
  private wy = 0;
  private path: { x: number; y: number }[] = []; // remaining tile-center waypoints
  private pauseMs = 1500;
  private sleeping = false; // gathered on the Zombie Patch: stay put, don't wander
  private facing = 1;
  private tiltPhase = 0;
  private stepPhase = 0;
  // Half the sprite's rendered footprint, for click hit-testing.
  private hitHalfW = 24;
  private hitH = 60;
  private fertilizeCastMs = 0;

  constructor(assets: GameAssets, field: Field, data: OwnedZombie) {
    this.field = field;
    this.data = data;
    this.id = data.id;
    this.buildRing();
    this.build(assets);
    this.container.addChild(this.root);
    const c = tileCenter(data.col, data.row);
    this.wx = c.x;
    this.wy = c.y;
    this.sync();
  }

  getData(): OwnedZombie {
    // Keep the resting tile current so saves capture where it wandered to.
    const g = screenToGrid(this.wx, this.wy);
    this.data.col = Math.round(g.col);
    this.data.row = Math.round(g.row);
    return this.data;
  }

  /** Zombie GROUP ("Garden", "Regular", …) — used to find fertilizers. */
  get group(): string {
    return this.data.group;
  }
  /** This unit's type key + individual name (for the fertilize toast/roll). */
  get typeKey(): string {
    return this.data.key;
  }
  get displayName(): string {
    return this.data.name;
  }

  /** Instantly move to a world spot and pause there a beat — a Garden zombie
   *  "teleports" to a crop it fertilizes, then resumes wandering. */
  teleportTo(wx: number, wy: number) {
    this.wx = wx;
    this.wy = wy;
    this.path = [];
    this.sleeping = false;
    this.pauseMs = 100;
    this.fertilizeCastMs = FERTILIZE_CAST_MS;
    this.sync();
  }

  private buildRing() {
    // No ground shadow: ZF2 renders none for characters (binary-verified), so the
    // zombie casts none too. Only the select ring below is drawn.
    // A soft glowing ellipse under the feet, shown while selected.
    this.ring.ellipse(0, 0, 22, 9).fill({ color: 0xffe066, alpha: 0.5 })
      .stroke({ width: 2, color: 0xfff4b0, alpha: 0.9 });
    this.ring.zIndex = -1;
    this.ring.visible = false;
    this.root.addChild(this.ring);
  }

  private build(assets: GameAssets) {
    // Resolve this unit's model by key (fall back to the base Regular zombie).
    const m: ZombieModel =
      assets.zombieModels[this.data.key] ??
      assets.zombieModels["ZombieActorRegularTier1"];
    const [r, g, b] = this.data.color ?? m.color;
    const tint = (r << 16) | (g << 8) | b; // authentic Market colour
    const scale = MODEL_BASE * (m.scale ?? 1);
    this.renderScale = scale;
    this.root.sortableChildren = true;
    this.neck = { x: m.neck.x, y: m.neck.y };

    for (const p of m.parts) {
      const tex = assets.zombiePartTex[p.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.zIndex = p.z;
      if (p.tint) sp.tint = tint; // only the grey skeleton is unit-coloured
      this.parts.push(sp);
      this.root.addChild(sp);
      if (p.group === "head") {
        this.headParts.push({ sp, bx: p.px, by: p.py }); // tilts with the head-nod
      } else if (p.group === "footF") { this.footF = sp; this.footFBaseY = p.py; }
      else if (p.group === "footB") { this.footB = sp; this.footBBaseY = p.py; }
      else if (/Arm[FB]/i.test(p.file)) this.arms.push({ sp, baseRotation: sp.rotation });
    }
    // Attach crop-mutation parts from the unit's mask (onion head, celery arm, …).
    // Independent of species: a combined zombie shows exactly the mutations it
    // carries. Head parts join headParts (tilt with the head-nod); the rest sit flat.
    this.addMutations(assets, m, tint);
    // Some models (Headless) have no feet parts; guard the walk animation.
    if (!this.footF) { this.footF = new Sprite(); this.root.addChild(this.footF); }
    if (!this.footB) { this.footB = new Sprite(); this.root.addChild(this.footB); }
    this.root.scale.set(scale);
    const bounds = this.root.getLocalBounds();
    this.hitHalfW = (bounds.width * scale) / 2 + 4;
    this.hitH = bounds.height * scale + 4;
  }

  // Attach crop-mutation parts for this unit's mutation mask. Each bit maps to a
  // ZombieSheet part (mutations.json); head parts join the tilting headParts, the
  // rest sit on the root. Positions use the same rig math as the base model, so a
  // mutation lands correctly on any species' body. A model may remap a bit to an
  // alternate part (Tier-4 variants: bit 512 -> heartichokeBody, bit 4 -> eyebiscusHat)
  // so the shared stat bit still shows the variant's own hair on the field.
  private addMutations(assets: GameAssets, model: ZombieModel, _tint: number) {
    const neck = model.neck;
    for (const bit of bitsOf(this.data.mutation)) {
      const partKey = model.mutationOverrides?.[String(bit)] ?? String(bit);
      const mp = assets.mutationParts[partKey];
      if (!mp) continue;
      const tex = assets.zombiePartTex[mp.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(mp.ax, mp.ay);
      const px = mp.ox + (mp.headRel ? neck.x : 0);
      const py = -mp.oy + (mp.headRel ? neck.y : 0);
      sp.position.set(px, py);
      this.root.addChild(sp);
      if (mp.group === "head") {
        sp.zIndex = slotOf(bit) === "hair_eye" ? MUT_FACE_OVERLAY_Z : MUT_HEAD_REPLACE_Z;
        this.headParts.push({ sp, bx: px, by: py }); // tilts with the head-nod
      } else {
        sp.zIndex = mp.z; // arms/body/collar keep their authored layering
      }
      this.parts.push(sp);
    }
  }

  setSelected(on: boolean) {
    this.ring.visible = on;
  }

  // Is world point (wx,wy) within this zombie's rendered sprite box? Used to pick
  // a zombie in select mode (its feet sit at the container position).
  containsPoint(wx: number, wy: number): boolean {
    const dx = wx - this.wx;
    const dy = wy - this.wy;
    return dx >= -this.hitHalfW && dx <= this.hitHalfW && dy <= 6 && dy >= -this.hitH;
  }

  // Current world position (feet), for centering the camera on this unit.
  get worldPos(): { x: number; y: number } {
    return { x: this.wx, y: this.wy };
  }

  // Depth for select-priority: front-most (largest depth) wins ties.
  get sortDepth(): number {
    const g = screenToGrid(this.wx, this.wy);
    return depth(g.col, g.row);
  }

  // Walk to a specific tile and stay there — the Zombie Patch "calls" units to
  // nap on it. Stops wandering until woken.
  sleepAt(col: number, row: number) {
    this.sleeping = true;
    const g = screenToGrid(this.wx, this.wy);
    const from = { col: Math.round(g.col), row: Math.round(g.row) };
    const cells = findPath(from, { col, row }, (c, r) => this.field.isPassable(c, r));
    this.path = cells.length
      ? cells.map((c) => tileCenter(c.col, c.row))
      : [tileCenter(col, row)];
  }
  // Wake up and resume wandering.
  wake() {
    this.sleeping = false;
    this.pauseMs = 500 + Math.random() * 1500;
  }
  get isSleeping(): boolean {
    return this.sleeping;
  }

  // Pick a new wander destination and route to it around obstacles.
  private repath() {
    const g = screenToGrid(this.wx, this.wy);
    const from = { col: Math.round(g.col), row: Math.round(g.row) };
    for (let tries = 0; tries < 12; tries++) {
      const col = Math.round(from.col + (Math.random() * 2 - 1) * WANDER_RADIUS);
      const row = Math.round(from.row + (Math.random() * 2 - 1) * WANDER_RADIUS);
      if (!this.field.isPassable(col, row)) continue;
      const cells = findPath(from, { col, row }, (c, r) => this.field.isPassable(c, r));
      if (cells.length) {
        this.path = cells.map((c) => tileCenter(c.col, c.row));
        return;
      }
    }
  }

  private tilt(dt: number, moving: boolean) {
    const period = moving ? TILT_PERIOD_MOVE : TILT_PERIOD_IDLE;
    const amp = moving ? TILT_AMP_MOVE : TILT_AMP_IDLE;
    this.tiltPhase = (this.tiltPhase + dt / period) % 1;
    const p = this.tiltPhase;
    let angle: number;
    if (p < TILT_BACK_FRAC) {
      angle = amp * Math.cos((p / TILT_BACK_FRAC) * Math.PI);
    } else {
      angle = -amp * Math.cos(((p - TILT_BACK_FRAC) / (1 - TILT_BACK_FRAC)) * Math.PI);
    }
    // Rotate every head part around the neck point (was a container rotation; done
    // per-part so head parts stay flat siblings sorted by their own z).
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (const h of this.headParts) {
      const dx = h.bx - this.neck.x, dy = h.by - this.neck.y;
      h.sp.position.set(this.neck.x + dx * cos - dy * sin, this.neck.y + dx * sin + dy * cos);
      h.sp.rotation = angle;
    }
  }

  private legs(moving: boolean, dt: number) {
    if (moving) {
      this.stepPhase += dt * STEP_SPEED;
      const f = Math.sin(this.stepPhase);
      const b = Math.sin(this.stepPhase + Math.PI);
      this.footF.y = this.footFBaseY - Math.max(0, f) * STEP_LIFT;
      this.footF.rotation = f * STEP_ANGLE;
      this.footB.y = this.footBBaseY - Math.max(0, b) * STEP_LIFT;
      this.footB.rotation = b * STEP_ANGLE;
    } else {
      this.footF.y = this.footFBaseY;
      this.footF.rotation = 0;
      this.footB.y = this.footBBaseY;
      this.footB.rotation = 0;
    }
  }

  update(dt: number) {
    let moving = false;
    if (this.fertilizeCastMs > 0) {
      this.fertilizeCastMs = Math.max(0, this.fertilizeCastMs - dt * 1000);
      const elapsed = FERTILIZE_CAST_MS - this.fertilizeCastMs;
      const raise = elapsed < FERTILIZE_RAISE_MS
        ? elapsed / FERTILIZE_RAISE_MS
        : this.fertilizeCastMs < FERTILIZE_LOWER_MS
          ? this.fertilizeCastMs / FERTILIZE_LOWER_MS
          : 1;
      for (const arm of this.arms) {
        arm.sp.rotation = arm.baseRotation + ARM_RAISE_ANGLE * Math.max(0, Math.min(1, raise));
      }
      if (this.fertilizeCastMs <= 0) {
        for (const arm of this.arms) arm.sp.rotation = arm.baseRotation;
      }
    } else if (this.path.length) {
      const t = this.path[0];
      const dx = t.x - this.wx;
      const dy = t.y - this.wy;
      const dist = Math.hypot(dx, dy);
      const step = SPEED_PX * dt;
      if (dist <= step || dist === 0) {
        this.wx = t.x;
        this.wy = t.y;
        this.path.shift();
        if (!this.path.length) this.pauseMs = 1500 + Math.random() * 3000;
      } else {
        moving = true;
        this.wx += (dx / dist) * step;
        this.wy += (dy / dist) * step;
        if (dx > 0.1) this.facing = -1;
        else if (dx < -0.1) this.facing = 1;
      }
    } else if (!this.sleeping) {
      // Napping units stay put; only wandering units pick a new destination.
      this.pauseMs -= dt * 1000;
      if (this.pauseMs <= 0) this.repath();
    }
    this.tilt(dt, moving);
    this.legs(moving, dt);
    this.root.scale.set(this.renderScale * this.facing, this.renderScale);
    this.sync();
  }

  private sync() {
    this.container.position.set(this.wx, this.wy);
    const g = screenToGrid(this.wx, this.wy);
    const c = Math.round(g.col);
    const r = Math.round(g.row);
    // Point footprint on the zombie's foot tile; bias 0.5 keeps it in front of
    // statics on its tile but behind the farmer (0.6) when they share one.
    setFootprint(this.container, c, r, c, r, 0.5);
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
