// One owned zombie on the farm, assembled from its PER-TYPE model (reverse-
// engineered from ZombieSheet — real body/head/features per group x tier) and
// tinted by its authentic unit colour. It idles/wanders the farm, routing around
// placed objects via A* over the occupancy grid, and can be selected (a glowing
// foot ring) to inspect its stats.
//
// Animation: the head group rocks back/forth, the legs step while moving, and the
// whole rig translates along its path.
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { GameAssets, MutationPart, ZombieModel } from "../assets";
import { Field } from "../Field";
import { depth, screenToGrid, tileCenter } from "../iso";
import { setFootprint } from "../depthSort";
import { findEscape, findPath, type Cell } from "../pathfind";
import { RouteWalker, walkRoute, type Waypoint } from "../walkRoute";
import { OwnedZombie } from "./types";
import { slotOf } from "./mutations";
import {
  backArmPlacement,
  isMutationForegroundPart,
  matchesMutationReplacement,
  mutationCoversFace,
  mutationBitsForRendering,
  mutationPartFor,
  mutationPartZIndex,
  type MutationReplacement,
} from "./mutationVisual";
import {
  BRUTE_EYEBALL_SCALE,
  DEFAULT_ZOMBIE_EYE_TINT,
  displayedAppearance,
  isBruteEyeball,
  zombiePartTint,
} from "./appearance";
import { SpecialHeadFx, specialHeadFxKind } from "./specialHeadFx";
import { visibleMutations } from "./mutationVisibility";
import { zombieFarmScale } from "./displayScale";

// Head replacements draw over the base skull but under facial parts, so eyes stay
// visible on Onion/Tomato/etc. Hair/eye mutations draw above the face.
const MUT_BASE_FOREGROUND_Z = 30;

const SPEED_PX = 34; // slow amble
const WANDER_RADIUS = 5; // tiles from current spot to pick a new target
const TILT_AMP_MOVE = 0.1;
const TILT_AMP_IDLE = 0.05;
const TILT_PERIOD_MOVE = 2.0;
const TILT_PERIOD_IDLE = 4.0;
const TILT_BACK_FRAC = 0.6;

const STEP_SPEED = 4.5;
const STEP_LIFT = 2.5;
const STEP_ANGLE = 0.18;
const IDLE_PAUSE_MIN_MS = 2500;
const IDLE_PAUSE_RANGE_MS = 3500;
const ARM_TRANSITION_SECONDS = 0.3;
const FERTILIZE_CAST_MS = 1100;
const FERTILIZE_RAISE_MS = 220;
const FERTILIZE_LOWER_MS = 220;
const ARM_RAISE_ANGLE = -2.5;
const ARM_REST_ANGLE = -1.5;

export function advanceZombieWalkBlend(
  current: number,
  walking: boolean,
  dt: number,
): number {
  const target = walking ? 1 : 0;
  const step = Math.max(0, dt) / ARM_TRANSITION_SECONDS;
  return target > current
    ? Math.min(target, current + step)
    : Math.max(target, current - step);
}

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
  private eyeParts: { sp: Sprite; openScaleY: number }[] = [];
  private eyesClosed = false;
  private parts: Sprite[] = [];
  private ring = new Graphics();
  private footF!: Sprite;
  private footB!: Sprite;
  private footFBaseY = 0;
  private footBBaseY = 0;
  private arms: { sp: Sprite; baseRotation: number }[] = [];
  private renderScale = 1;
  // A pre-drawn frame strip on a rig with no bones (the Video Game Zombie): the one
  // body sprite and the idle textures it cycles through. Null for every paper doll.
  private flipbook: { sp: Sprite; frames: Texture[]; fps: number } | null = null;
  private flipbookTime = 0;

  // Position, and the remaining (straightened — see walkRoute) waypoints. `warp` marks
  // the far side of a wormhole hop: the zombie is moved there outright rather than
  // walking the gap. Shared with the farmer, who walks a route the same way.
  private walker = new RouteWalker(0, 0, {
    onLeg: (dx) => { this.facing = dx > 0 ? -1 : 1; },
    onFinish: () => { this.pauseMs = this.nextIdlePause(); },
  });
  private pauseMs = IDLE_PAUSE_MIN_MS;
  private sleeping = false; // gathered on the Zombie Patch: stay put, don't wander
  private facing = 1;
  private tiltPhase = 0;
  private stepPhase = 0;
  private armWalkBlend = 0;
  // Half the sprite's rendered footprint, for click hit-testing.
  private hitHalfW = 24;
  private hitH = 60;
  private fertilizeCastMs = 0;
  private fertilizeCloud = new Graphics();
  // Patch tile to lie back down on once the fertilize cast finishes (see teleportTo).
  private fertilizeReturn: { col: number; row: number } | null = null;
  private invasionBubble!: Sprite;
  private specialHeadFx: SpecialHeadFx | null = null;

  // The walker owns the position outright; these keep the rig's many readers of it
  // spelled the way they always were rather than reaching through the indirection.
  private get wx(): number { return this.walker.x; }
  private set wx(v: number) { this.walker.x = v; }
  private get wy(): number { return this.walker.y; }
  private set wy(v: number) { this.walker.y = v; }

  constructor(assets: GameAssets, field: Field, data: OwnedZombie) {
    this.field = field;
    this.data = data;
    this.id = data.id;
    this.buildRing();
    this.build(assets);
    this.container.addChild(this.root);
    this.buildInvasionBubble(assets);
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
   *  "teleports" to a crop it fertilizes, then resumes wandering.
   *
   *  `returnTo` is its Zombie Patch resting tile when the farm is gathered: the
   *  cast wakes the unit (it has to stand up and raise its arms), so without it
   *  the one zombie that fertilized would be left wandering the farm while the
   *  rest of the army stayed asleep. It walks back and lies down again instead. */
  teleportTo(wx: number, wy: number, returnTo: { col: number; row: number } | null = null) {
    this.walker.moveTo(wx, wy);
    this.sleeping = false;
    this.setEyesClosed(false);
    this.pauseMs = 100;
    this.fertilizeCastMs = FERTILIZE_CAST_MS;
    this.fertilizeReturn = returnTo;
    this.sync();
  }

  private buildInvasionBubble(assets: GameAssets) {
    this.invasionBubble = new Sprite(assets.invasionBubble);
    this.invasionBubble.anchor.set(0.5, 1);
    this.invasionBubble.visible = false;
    this.invasionBubble.zIndex = 10;
    this.container.sortableChildren = true;
    this.container.addChild(this.invasionBubble);
    this.syncInvasionBubble();
  }

  private syncInvasionBubble() {
    const scale = 0.55;
    const width = this.invasionBubble.texture.width * scale;
    const height = this.invasionBubble.texture.height * scale;
    // `facing === 1` is the authored left-facing zombie. Keep the source bubble
    // orientation there; mirror it for right-facing zombies. Shift one complete
    // rendered bubble-width toward the zombie's gaze, and lower it by 15%.
    this.invasionBubble.scale.set(scale * this.facing, scale);
    this.invasionBubble.position.set(
      -this.facing * width,
      -this.hitH + 5 + height * 0.15,
    );
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
    // What this unit LOOKS like on the farm, after the mutations its own card hides
    // and then the device's display prefs. The data keeps its real mask and
    // inherited tint; only the drawing changes.
    const shown = displayedAppearance(
      visibleMutations(this.data.id, this.data.mutation),
      this.data.color,
    );
    const [r, g, b] = shown.color ?? m.color;
    const tint = (r << 16) | (g << 8) | b; // authentic Market colour
    const scale = zombieFarmScale(this.data.group, this.data.className, this.data.key);
    this.renderScale = scale;
    // Both feet are resolved from the model below, or stubbed at the end for a rig
    // that has none (Headless). Cleared first so a rebuild cannot hold on to the
    // previous rig's — by then destroyed — sprites.
    this.footF = this.footB = undefined as unknown as Sprite;
    this.root.sortableChildren = true;
    this.neck = { x: m.neck.x, y: m.neck.y };
    const replaceable: Record<MutationReplacement, Sprite[]> = { body: [], armF: [], head: [] };
    const headForeground: Sprite[] = [];

    for (const p of m.parts) {
      const tex = assets.zombiePartTex[p.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.scale.set(p.scale ?? 1);
      sp.zIndex = p.z;
      if (p.tint) sp.tint = zombiePartTint(p.file, tint, this.data.group);
      this.parts.push(sp);
      this.root.addChild(sp);
      if (m.flipbook && p.file === m.flipbook.idle[0]) {
        const frames = m.flipbook.idle.flatMap((file) => assets.zombiePartTex[file] ?? []);
        this.flipbook = { sp, frames, fps: m.flipbook.fps };
      }
      if (matchesMutationReplacement(p.file, "body")) replaceable.body.push(sp);
      if (matchesMutationReplacement(p.file, "armF")) replaceable.armF.push(sp);
      if (p.group === "head" && matchesMutationReplacement(p.file, "head")) {
        replaceable.head.push(sp);
      }
      if (p.group === "head" && isMutationForegroundPart(p.file)) {
        headForeground.push(sp);
      }
      if (p.group === "head") {
        this.headParts.push({ sp, bx: p.px, by: p.py }); // tilts with the head-nod
        if (/Eye[LR](?:\.png)?$/i.test(p.file)) {
          this.eyeParts.push({ sp, openScaleY: sp.scale.y });
        }
      } else if (p.group === "footF") { this.footF = sp; this.footFBaseY = p.py; }
      else if (p.group === "footB") { this.footB = sp; this.footBBaseY = p.py; }
      else if (/Arm[FB](?:\.png)?$/i.test(p.file)) this.arms.push({ sp, baseRotation: sp.rotation });

      if (isBruteEyeball(this.data.group, p.file)) {
        const eyeball = new Sprite(tex);
        eyeball.anchor.set(p.ax, p.ay);
        eyeball.position.set(p.px, p.py);
        eyeball.scale.set((p.scale ?? 1) * BRUTE_EYEBALL_SCALE);
        eyeball.tint = DEFAULT_ZOMBIE_EYE_TINT;
        eyeball.zIndex = p.z + 0.1;
        this.parts.push(eyeball);
        this.root.addChild(eyeball);
        this.headParts.push({ sp: eyeball, bx: p.px, by: p.py });
        this.eyeParts.push({ sp: eyeball, openScaleY: eyeball.scale.y });
        headForeground.push(eyeball);
      }
    }
    // Attach crop-mutation parts from the unit's mask (onion head, celery arm, …).
    // Independent of species: a combined zombie shows exactly the mutations it
    // carries. Head parts join headParts (tilt with the head-nod); the rest sit flat.
    this.addMutations(assets, m, replaceable, headForeground, shown.mutation);
    this.applyArmPose();
    this.buildFarmEffects();
    const headFxKind = specialHeadFxKind(this.data.key, shown.mutation);
    if (headFxKind) {
      this.specialHeadFx = new SpecialHeadFx(headFxKind);
      this.root.addChild(this.specialHeadFx.container);
    }
    // Some models (Headless) have no feet parts; guard the walk animation.
    if (!this.footF) { this.footF = new Sprite(); this.root.addChild(this.footF); }
    if (!this.footB) { this.footB = new Sprite(); this.root.addChild(this.footB); }
    this.root.scale.set(scale);
    const bounds = this.root.getLocalBounds();
    this.hitHalfW = (bounds.width * scale) / 2 + 4;
    this.hitH = bounds.height * scale + 4;
  }

  /** Reassemble this unit's rig from the same data, picking up a changed display
   *  preference (mutations hidden / species body colour). Nothing about the unit
   *  itself changes — only how it is drawn — so its position, path, sleep state and
   *  selection survive. Cheap enough for the whole farm: the same work spawning one
   *  zombie already does. */
  rebuildAppearance(assets: GameAssets) {
    for (const child of [...this.root.children]) {
      if (child === this.ring || child === this.fertilizeCloud) continue;
      this.root.removeChild(child);
      child.destroy({ children: true });
    }
    this.parts = [];
    this.headParts = [];
    this.eyeParts = [];
    this.arms = [];
    this.flipbook = null;
    this.specialHeadFx = null; // its container was a child, destroyed above
    this.fertilizeCloud.clear(); // buildFarmEffects redraws it
    const closed = this.eyesClosed;
    this.eyesClosed = false; // fresh eye sprites are open; setEyesClosed early-outs otherwise
    this.build(assets);
    this.setEyesClosed(closed);
    // build() recomputes hitH, and the invasion bubble hangs off it — a rig that just
    // lost its mutation art is shorter, so re-place the bubble rather than leaving it
    // floating at the old silhouette's height.
    this.syncInvasionBubble();
    this.sync();
  }

  private buildFarmEffects() {
    this.fertilizeCloud
      .circle(-11, 0, 10).fill({ color: 0x5aaa3f, alpha: 0.38 })
      .circle(0, -4, 13.5).fill({ color: 0x75c649, alpha: 0.34 })
      .circle(13, 1, 9).fill({ color: 0x438d32, alpha: 0.34 });
    this.fertilizeCloud.position.set(6, -23);
    this.fertilizeCloud.zIndex = 25;
    this.fertilizeCloud.visible = false;
    this.root.addChild(this.fertilizeCloud);
  }

  // Attach crop-mutation parts for this unit's mutation mask. Each mutation maps to a
  // ZombieSheet part (mutations.json); head parts join the tilting headParts, the
  // rest sit on the root. Positions use the same rig math as the base model, so a
  // mutation lands correctly on any species' body. A model may remap a mutation to an
  // alternate part (Tier-4 variants: cauli -> heartichokeBody, carrot -> eyebiscusHat)
  // so a shared mutation still shows the variant's own hair on the field.
  private addMutations(
    assets: GameAssets,
    model: ZombieModel,
    replaceable: Record<MutationReplacement, Sprite[]>,
    headForeground: Sprite[],
    // The mask to DRAW — the unit's own, unless the player turned mutations off.
    mask: number,
  ) {
    const neck = model.neck;
    for (const bit of mutationBitsForRendering(assets.zombies, this.data.key, mask)) {
      const mp = mutationPartFor(assets.mutationParts, model, bit);
      if (!mp) continue;
      const tex = assets.zombiePartTex[mp.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(mp.ax, mp.ay);
      const px = mp.ox + (mp.headRel ? neck.x : 0);
      const py = -mp.oy + (mp.headRel ? neck.y : 0);
      sp.position.set(px, py);
      const replacement: MutationReplacement | undefined =
        mp.replaces ?? (slotOf(bit) === "head" ? "head" : undefined);
      if (replacement) {
        for (const basePart of replaceable[replacement]) basePart.visible = false;
        if (replacement === "head") {
          // The face either rides in front of the new head or is part of it — see
          // mutationCoversFace. A pumpkin brings its own.
          const covers = mutationCoversFace(bit);
          for (const basePart of headForeground) {
            if (covers) basePart.visible = false;
            else basePart.zIndex = MUT_BASE_FOREGROUND_Z + basePart.zIndex;
          }
        }
      }
      this.root.addChild(sp);
      if (mp.group === "head") {
        sp.zIndex = mutationPartZIndex(bit, mp.group, mp.z);
        this.headParts.push({ sp, bx: px, by: py }); // tilts with the head-nod
      } else {
        sp.zIndex = mp.z; // arms/body/collar keep their authored layering
        if (replacement === "armF") {
          // A crop arm claims BOTH arms, so mirror it onto the back shoulder too.
          // Pushed back-first, which keeps `arms` in the same back/front order the
          // base rig produces (defaultArmB is authored before defaultArmF).
          const back = this.addBackArm(model, mp, tex);
          if (back) this.arms.push({ sp: back, baseRotation: back.rotation });
          this.arms.push({ sp, baseRotation: sp.rotation });
        }
      }
      this.parts.push(sp);
    }
  }

  /** The back-shoulder copy of a crop arm, or undefined on a rig with no back arm
   *  (the named specials carry no arm parts at all). */
  private addBackArm(
    model: ZombieModel,
    mp: MutationPart,
    tex: Texture,
  ): Sprite | undefined {
    const at = backArmPlacement(model, mp);
    if (!at) return undefined;
    const sp = new Sprite(tex);
    sp.anchor.set(at.ax, at.ay);
    sp.position.set(at.x, at.y);
    sp.scale.set(at.scale);
    sp.tint = at.tint;
    sp.zIndex = at.z;
    this.root.addChild(sp);
    this.parts.push(sp);
    return sp;
  }

  setSelected(on: boolean) {
    this.ring.visible = on;
  }

  setInvasionReady(on: boolean) {
    this.invasionBubble.visible = on;
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

  /** Walk to a specific tile and stay there — the Zombie Patch "calls" units to nap
   *  on it. Stops wandering until woken. Returns false, and stays where it is, when
   *  the patch cannot be walked to: a unit fenced away from it used to answer the
   *  call by cutting a straight line to the patch, fences and all. */
  sleepAt(col: number, row: number): boolean {
    const g = screenToGrid(this.wx, this.wy);
    const from = { col: Math.round(g.col), row: Math.round(g.row) };
    const cells = findPath(
      from, { col, row }, (c, r) => this.field.isPassable(c, r), this.pathOpts()
    );
    if (!cells.length && (from.col !== col || from.row !== row)) return false;
    this.sleeping = true;
    // Stay awake for the walk over; the eyes close once the final tile is reached.
    this.setEyesClosed(false);
    this.walker.setRoute(this.route(from, cells));
    return true;
  }

  // Wake up and resume wandering.
  wake() {
    this.sleeping = false;
    this.setEyesClosed(false);
    this.pauseMs = this.nextIdlePause();
  }
  get isSleeping(): boolean {
    return this.sleeping;
  }

  // Pick a new wander destination and route to it around obstacles.
  private repath() {
    const g = screenToGrid(this.wx, this.wy);
    const from = { col: Math.round(g.col), row: Math.round(g.row) };
    // Standing inside a placed object — bought onto an occupied tile, or one
    // dropped on top of where it stood. Every wander candidate within reach is
    // blocked too, so walk out through the object first; wandering resumes from
    // the open ground on the far side.
    if (!this.field.isPassable(from.col, from.row)) {
      const escape = findEscape(from, (c, r) => this.field.isPassable(c, r), this.pathOpts());
      if (escape.length) {
        this.walker.setRoute(this.route(from, escape));
        return;
      }
    }
    for (let tries = 0; tries < 12; tries++) {
      const col = Math.round(from.col + (Math.random() * 2 - 1) * WANDER_RADIUS);
      const row = Math.round(from.row + (Math.random() * 2 - 1) * WANDER_RADIUS);
      // Somewhere it would happily stand: a hedge tile is walkable in a pinch but
      // is not a place to go and loiter.
      if (!this.field.isOpenGround(col, row)) continue;
      const cells = findPath(
        from, { col, row }, (c, r) => this.field.isPassable(c, r), this.pathOpts()
      );
      if (cells.length) {
        this.walker.setRoute(this.route(from, cells));
        return;
      }
    }
  }

  // Tile route -> straightened world waypoints. Wandering runs the search constantly,
  // so without this every zombie on the farm shuffles along a raster line instead of
  // walking somewhere. See src/walkRoute.ts.
  private route(from: Cell, cells: Cell[]): Waypoint[] {
    return walkRoute(this.field, from, { x: this.wx, y: this.wy }, cells);
  }

  private pathOpts() {
    return this.field.pathOptions();
  }

  private nextIdlePause(): number {
    return IDLE_PAUSE_MIN_MS + Math.random() * IDLE_PAUSE_RANGE_MS;
  }

  private setEyesClosed(closed: boolean) {
    if (this.eyesClosed === closed) return;
    this.eyesClosed = closed;
    for (const eye of this.eyeParts) {
      // The eye art is centered on its socket, so flattening it vertically reads
      // as a closed eyelid while preserving mutations, tint, and head movement.
      eye.sp.scale.y = eye.openScaleY * (closed ? 0.08 : 1);
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

  /** Step a flipbook rig's idle strip. The pixel zombie has one loop for standing and
   *  walking alike (its source raid enemy plays the same four frames while it
   *  advances), and it holds its first frame while napping on the Patch — it has no
   *  eyes to close, so a frozen frame is what "asleep" looks like. */
  private stepFlipbook(dt: number, walking: boolean) {
    const book = this.flipbook;
    if (!book || !book.frames.length) return;
    if (this.sleeping && !walking) {
      this.flipbookTime = 0;
    } else {
      this.flipbookTime += dt;
    }
    const index = Math.floor(this.flipbookTime * book.fps) % book.frames.length;
    const frame = book.frames[index];
    if (book.sp.texture !== frame) book.sp.texture = frame;
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

  private applyArmPose() {
    for (const arm of this.arms) {
      arm.sp.rotation = arm.baseRotation + ARM_REST_ANGLE * (1 - this.armWalkBlend);
    }
  }

  private poseArms(walking: boolean, dt: number) {
    if (this.fertilizeCastMs > 0) return;
    this.armWalkBlend = advanceZombieWalkBlend(this.armWalkBlend, walking, dt);
    this.applyArmPose();
  }

  private updateFarmEffects() {
    if (this.fertilizeCloud.visible) {
      const progress = 1 - this.fertilizeCastMs / FERTILIZE_CAST_MS;
      this.fertilizeCloud.alpha = Math.sin(Math.min(1, progress) * Math.PI);
      const scale = 0.65 + progress * 1.15;
      this.fertilizeCloud.scale.set(scale);
      this.fertilizeCloud.y = -23 - progress * 13;
      if (this.fertilizeCastMs <= 0) this.fertilizeCloud.visible = false;
    }
  }

  update(dt: number) {
    // Animation follows the route, not displacement in just this frame. Reaching a
    // waypoint can consume a frame without translating; treating that as idle made
    // the arms and feet flash down between every pair of path cells.
    let walking = this.walker.walking;
    if (this.fertilizeCastMs > 0) {
      this.fertilizeCloud.visible = true;
      this.fertilizeCastMs = Math.max(0, this.fertilizeCastMs - dt * 1000);
      const elapsed = FERTILIZE_CAST_MS - this.fertilizeCastMs;
      const raise = elapsed < FERTILIZE_RAISE_MS
        ? elapsed / FERTILIZE_RAISE_MS
        : this.fertilizeCastMs < FERTILIZE_LOWER_MS
          ? this.fertilizeCastMs / FERTILIZE_LOWER_MS
          : 1;
      for (const arm of this.arms) {
        const t = Math.max(0, Math.min(1, raise));
        arm.sp.rotation = arm.baseRotation + ARM_REST_ANGLE +
          (ARM_RAISE_ANGLE - ARM_REST_ANGLE) * t;
      }
      if (this.fertilizeCastMs <= 0) {
        for (const arm of this.arms) arm.sp.rotation = arm.baseRotation;
        const home = this.fertilizeReturn;
        this.fertilizeReturn = null;
        // Walk back to the nap. sleepAt only fails when the patch is unreachable
        // (built over, or the crop is walled off); settle where it stands rather
        // than wander, so it still reads as part of a sleeping army.
        if (home && !this.sleepAt(home.col, home.row)) this.sleeping = true;
      }
    } else if (this.walker.walking) {
      this.walker.advance(SPEED_PX * dt);
    } else if (!this.sleeping) {
      // Napping units stay put; only wandering units pick a new destination.
      this.pauseMs -= dt * 1000;
      if (this.pauseMs <= 0) {
        this.repath();
        walking = this.walker.walking;
      }
    }
    this.setEyesClosed(this.sleeping && !this.walker.walking);
    this.tilt(dt, walking);
    this.legs(walking, dt);
    this.poseArms(walking, dt);
    this.stepFlipbook(dt, walking);
    this.updateFarmEffects();
    this.specialHeadFx?.update(dt);
    this.root.scale.set(this.renderScale * this.facing, this.renderScale);
    this.syncInvasionBubble();
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
