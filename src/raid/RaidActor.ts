// A display-only zombie sprite for the raid scene: the SAME per-type skeletal
// model the farm uses (assets.zombieModels), with the SAME idle-tilt + leg-step
// walk animation as ZombieUnit — just decoupled from the farm's field/pathing.
// The scene positions it and tells it whether it's moving each frame.
import { Container, Sprite } from "pixi.js";
import { GameAssets, ZombieModel } from "../assets";

const MODEL_BASE = 0.95;
const TILT_AMP_MOVE = 0.1;
const TILT_AMP_IDLE = 0.05;
const TILT_PERIOD_MOVE = 2.0;
const TILT_PERIOD_IDLE = 4.0;
const TILT_BACK_FRAC = 0.6;
const STEP_SPEED = 4.5;
const STEP_LIFT = 2.5;
const STEP_ANGLE = 0.18;
// Arms rest pointing down (rotation 0); swing them up-and-back to raise overhead.
const RAISE_ANGLE = -2.5;

export class RaidActor {
  readonly container = new Container();
  private root = new Container();
  // Head parts are flat siblings in `root` sorted by their own zIndex (matching the
  // engine draw order); the head-nod tilts each around the neck point (see ZombieUnit).
  private neck = { x: 0, y: 0 };
  private headParts: { sp: Sprite; bx: number; by: number }[] = [];
  private footF!: Sprite;
  private footB!: Sprite;
  private footFBaseY = 0;
  private footBBaseY = 0;
  private arms: Sprite[] = []; // ArmF/ArmB sprites, for the activated wind-up pose
  private renderScale = MODEL_BASE;
  /** Art faces LEFT at facing +1; zombies attack rightward so they default to -1. */
  private facing = -1;
  private tiltPhase = 0;
  private stepPhase = 0;

  constructor(assets: GameAssets, key: string) {
    this.container.addChild(this.root);
    this.build(assets, key);
  }

  private build(assets: GameAssets, key: string) {
    const m: ZombieModel =
      assets.zombieModels[key] ?? assets.zombieModels["ZombieActorRegularTier1"];
    const [r, g, b] = m.color;
    const tint = (r << 16) | (g << 8) | b;
    this.renderScale = MODEL_BASE * (m.scale ?? 1);
    this.root.sortableChildren = true;
    this.neck = { x: m.neck.x, y: m.neck.y };

    for (const p of m.parts) {
      const tex = assets.zombiePartTex[p.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.zIndex = p.z;
      if (p.tint) sp.tint = tint;
      this.root.addChild(sp);
      if (p.group === "head") {
        this.headParts.push({ sp, bx: p.px, by: p.py });
      } else if (p.group === "footF") { this.footF = sp; this.footFBaseY = p.py; }
      else if (p.group === "footB") { this.footB = sp; this.footBBaseY = p.py; }
      // Arms live in the "root" group; grab them by filename for the wind-up.
      else if (/Arm[FB]/i.test(p.file)) this.arms.push(sp);
    }
    // Headless models have no feet — guard the walk animation.
    if (!this.footF) { this.footF = new Sprite(); this.root.addChild(this.footF); }
    if (!this.footB) { this.footB = new Sprite(); this.root.addChild(this.footB); }
    this.root.scale.set(this.renderScale);
  }

  /** Face toward a horizontal movement delta (art faces left at facing +1). */
  setFacingFromDelta(dx: number) {
    if (dx > 0.01) this.facing = -1;
    else if (dx < -0.01) this.facing = 1;
  }

  /** Pose the arms for an activated wind-up: 0 = rest (arms down), 1 = arms fully
   *  raised overhead (about to bash). The scene passes the charge progress; when it
   *  releases (progress→0) the arms snap back and the token's hit-lunge reads as
   *  the strike. Both arms swing the same way so it looks like a two-handed raise. */
  setWindup(progress: number) {
    const a = Math.max(0, Math.min(1, progress)) * RAISE_ANGLE;
    for (const arm of this.arms) arm.rotation = a;
  }

  update(dt: number, moving: boolean) {
    // Head tilt (rocks back/forth; faster while moving).
    const period = moving ? TILT_PERIOD_MOVE : TILT_PERIOD_IDLE;
    const amp = moving ? TILT_AMP_MOVE : TILT_AMP_IDLE;
    this.tiltPhase = (this.tiltPhase + dt / period) % 1;
    const p = this.tiltPhase;
    const angle =
      p < TILT_BACK_FRAC
        ? amp * Math.cos((p / TILT_BACK_FRAC) * Math.PI)
        : -amp * Math.cos(((p - TILT_BACK_FRAC) / (1 - TILT_BACK_FRAC)) * Math.PI);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (const h of this.headParts) {
      const dx = h.bx - this.neck.x, dy = h.by - this.neck.y;
      h.sp.position.set(this.neck.x + dx * cos - dy * sin, this.neck.y + dx * sin + dy * cos);
      h.sp.rotation = angle;
    }

    // Legs step while moving.
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
    this.root.scale.set(this.renderScale * this.facing, this.renderScale);
  }
}
