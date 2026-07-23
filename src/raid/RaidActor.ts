// A display-only zombie sprite for the raid scene: the SAME per-type skeletal
// model the farm uses (assets.zombieModels), with the SAME idle-tilt + leg-step
// walk animation as ZombieUnit — just decoupled from the farm's field/pathing.
// The scene positions it and tells it whether it's moving each frame.
import { Container, Sprite } from "pixi.js";
import { GameAssets, ZombieModel } from "../assets";
import { bitsOf, slotOf } from "../zombie/mutations";
import { zombiePartTint } from "../zombie/appearance";
import { SpecialHeadFx, specialHeadFxKind } from "../zombie/specialHeadFx";

const MODEL_BASE = 0.95;
const TILT_AMP_MOVE = 0.1;
const TILT_AMP_IDLE = 0.05;
const TILT_PERIOD_MOVE = 2.0;
const TILT_PERIOD_IDLE = 4.0;
const TILT_BACK_FRAC = 0.6;
const STEP_SPEED = 4.5;
const STEP_LIFT = 2.5;
const STEP_ANGLE = 0.18;
// Empirically, from the rendered rig: rotation 0 = arms STRAIGHT OUT IN FRONT (toward
// the enemy); rotating toward ARM_REST drops them DOWN to the sides; RAISE_ANGLE swings
// them up overhead (activated-move wind-up).
const RAISE_ANGLE = -2.5;
// Arms held STRAIGHT OUT IN FRONT (toward the enemy) — the classic zombie pose, used
// while WALKING (advancing) and as the base while ATTACKING.
const ARM_FWD = 0.0;
// Arms hanging DOWN at the sides — only while WAITING in the back group.
const ARM_REST = -1.5;
// Healing is cast from rest, sweeping FORWARD past ARM_FWD and up over the head.
// The activated-move angle starts from the forward zombie pose and winds backward,
// which makes a rest-to-heal motion look like the arms kick behind the body.
const HEAL_OVERHEAD = 1.5;
// Basic-attack wave: from the forward pose, the arms pump up/down in opposition (one
// up while the other's down) — a full switch per landed hit. Kept small so they stay
// reading as "out in front" rather than flailing overhead.
const ARM_WAVE = 0.34;
// A faint alternating sway on the forward arms while walking, so they're not stiff.
const ARM_WALK_SWAY = 0.09;
// ---- death: the head POPS OFF and tumbles backward ----
// On death the head detaches and launches up-and-back (away from the enemy), falling
// under gravity while it spins. Worked in the rig's LOCAL space (a POSITIVE x is always
// "backward" because root.scale.x carries the facing sign), so it flies the right way
// whichever direction the zombie faced.
const DEATH_HEAD_VX = 92; // local px/s, backward (away from the enemy)
const DEATH_HEAD_VY = -255; // local px/s, up
const DEATH_HEAD_G = 820; // gravity pulling the head back down
const DEATH_HEAD_SPIN = 13; // rad/s tumble
const MUT_HEAD_REPLACE_Z = 4.5;
const MUT_FACE_OVERLAY_Z = 20;

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
  private deathT = -1; // ≥0 once dead: seconds into the head-pop animation
  private specialHeadFx: SpecialHeadFx | null = null;

  constructor(assets: GameAssets, key: string, mutation = 0) {
    this.container.addChild(this.root);
    this.build(assets, key, mutation);
  }

  private build(assets: GameAssets, key: string, mutation: number) {
    const m: ZombieModel =
      assets.zombieModels[key] ?? assets.zombieModels["ZombieActorRegularTier1"];
    const mutationParts = bitsOf(mutation).flatMap((bit) => {
      const partKey = m.mutationOverrides?.[String(bit)] ?? String(bit);
      const part = assets.mutationParts[partKey];
      const texture = part ? assets.zombiePartTex[part.file] : undefined;
      return part && texture ? [{ bit, part, texture }] : [];
    });
    // Crop arms occupy the authored ArmF slot. Only suppress the base front arm
    // after its replacement has resolved, so incomplete assets cannot remove it.
    const replacesFrontArm = mutationParts.some(({ bit }) => slotOf(bit) === "arm");
    const [r, g, b] = m.color;
    const tint = (r << 16) | (g << 8) | b;
    this.renderScale = MODEL_BASE * (m.scale ?? 1);
    this.root.sortableChildren = true;
    this.neck = { x: m.neck.x, y: m.neck.y };

    for (const p of m.parts) {
      if (replacesFrontArm && /ArmF$/i.test(p.file)) continue;
      const tex = assets.zombiePartTex[p.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.scale.set(p.scale ?? 1);
      sp.zIndex = p.z;
      if (p.tint) sp.tint = zombiePartTint(p.file, tint);
      this.root.addChild(sp);
      if (p.group === "head") {
        this.headParts.push({ sp, bx: p.px, by: p.py });
      } else if (p.group === "footF") { this.footF = sp; this.footFBaseY = p.py; }
      else if (p.group === "footB") { this.footB = sp; this.footBBaseY = p.py; }
      // Arms live in the "root" group; grab them by filename for the wind-up.
      else if (/Arm[FB](?:\.png)?$/i.test(p.file)) this.arms.push(sp);
    }
    // Raid zombies use the same mutation overlays as their farm actors. The mask is
    // owned-unit state, not something that can be inferred from the species key after
    // combining, so it must travel with the combat unit.
    for (const { bit, part: mp, texture: tex } of mutationParts) {
      const sp = new Sprite(tex);
      sp.anchor.set(mp.ax, mp.ay);
      const px = mp.ox + (mp.headRel ? m.neck.x : 0);
      const py = -mp.oy + (mp.headRel ? m.neck.y : 0);
      sp.position.set(px, py);
      if (mp.group === "head") {
        sp.zIndex = slotOf(bit) === "hair_eye" ? MUT_FACE_OVERLAY_Z : MUT_HEAD_REPLACE_Z;
        this.headParts.push({ sp, bx: px, by: py });
      } else {
        sp.zIndex = mp.z;
        if (slotOf(bit) === "arm") this.arms.push(sp);
      }
      this.root.addChild(sp);
    }
    // Headless models have no feet — guard the walk animation.
    const headFxKind = specialHeadFxKind(key);
    if (headFxKind) {
      this.specialHeadFx = new SpecialHeadFx(headFxKind);
      this.root.addChild(this.specialHeadFx.container);
    }
    if (!this.footF) { this.footF = new Sprite(); this.root.addChild(this.footF); }
    if (!this.footB) { this.footB = new Sprite(); this.root.addChild(this.footB); }
    this.root.scale.set(this.renderScale);
  }

  /** Face toward a horizontal movement delta (art faces left at facing +1). */
  setFacingFromDelta(dx: number) {
    if (dx > 0.01) this.facing = -1;
    else if (dx < -0.01) this.facing = 1;
  }

  /** Pose the arms each frame. Priority: an activated-move WIND-UP (both arms swing
   *  overhead, two-handed) > a basic ATTACK (arms held out in front, pumping up/down
   *  in OPPOSITION — one up while the other is down, a full switch per landed hit) >
   *  WALKING (arms straight out in front, a faint sway) > WAITING (arms at the sides).
   *  So arms are FORWARD whenever the zombie is moving or fighting, and only drop to
   *  the sides while it stands idle in the back group.
   *
   *  windup:    0..1 activated-charge progress (0 = none).
   *  attacking: is this zombie trading basic blows right now.
   *  walking:   is this zombie advancing/marching (arms out, like the attack pose).
   *  atkProg:   0..1 through the current attack cooldown (0 = just hit).
   *  atkCount:  hits landed so far — its parity flips the wave each attack so the
   *             reach stays continuous when atkProg snaps 1→0 on the landed hit.
   *
   *  TODO(bite): a SECOND basic-attack variant — a head-lunge BITE (the zombie
   *  darts its head/upper body forward to chomp) — is noted for a later pass. */
  poseArms(
    windup: number,
    attacking: boolean,
    walking: boolean,
    atkProg: number,
    atkCount: number,
    smashSlam = -1,
    healRaise = 0
  ) {
    if (smashSlam >= 0) {
      // Smash SLAM: arms drive from fully overhead (1) back down (0) as the zombie
      // shrinks; continuous from the wind-up, which ended with the arms at RAISE_ANGLE.
      const a = smashSlam * RAISE_ANGLE;
      for (const arm of this.arms) arm.rotation = a;
    } else if (windup > 0) {
      const a = Math.max(0, Math.min(1, windup)) * RAISE_ANGLE;
      for (const arm of this.arms) arm.rotation = a;
    } else if (healRaise > 0) {
      const t = Math.max(0, Math.min(1, healRaise));
      const a = ARM_REST + (HEAL_OVERHEAD - ARM_REST) * t;
      for (const arm of this.arms) arm.rotation = a;
    } else if (attacking && this.arms.length) {
      // Out in front + up/down wave. One full switch = one attack; the parity term
      // keeps the wave continuous across the cooldown reset (atkProg 1→0 + a π step
      // cancel out).
      const phase = atkProg * Math.PI + (atkCount % 2 ? Math.PI : 0);
      const c = Math.cos(phase);
      this.arms.forEach((arm, i) => {
        const dir = i % 2 === 0 ? 1 : -1; // alternate arms: one up while the other's down
        arm.rotation = ARM_FWD + dir * c * ARM_WAVE;
      });
    } else if (walking && this.arms.length) {
      // Straight out in front (like the attack base) with a faint alternating sway.
      const s = Math.sin(this.stepPhase);
      this.arms.forEach((arm, i) => {
        const dir = i % 2 === 0 ? 1 : -1;
        arm.rotation = ARM_FWD + dir * s * ARM_WALK_SWAY;
      });
    } else {
      for (const arm of this.arms) arm.rotation = ARM_REST; // hang down at the sides (waiting)
    }
  }

  /** Mark this zombie dead — begins the head-pop on the next update. Idempotent. */
  markDead() {
    if (this.deathT < 0) {
      this.deathT = 0;
      if (this.specialHeadFx) this.specialHeadFx.container.visible = false;
    }
  }

  update(dt: number, moving: boolean) {
    // Dead: pop the head off and let it tumble backward (skip the normal idle/walk).
    if (this.deathT >= 0) {
      this.deathT += dt;
      const t = this.deathT;
      const hx = DEATH_HEAD_VX * t;
      const hy = DEATH_HEAD_VY * t + 0.5 * DEATH_HEAD_G * t * t;
      const rot = DEATH_HEAD_SPIN * t;
      for (const h of this.headParts) {
        h.sp.position.set(h.bx + hx, h.by + hy);
        h.sp.rotation = rot;
      }
      this.footF.y = this.footFBaseY;
      this.footF.rotation = 0;
      this.footB.y = this.footBBaseY;
      this.footB.rotation = 0;
      this.root.scale.set(this.renderScale * this.facing, this.renderScale);
      return;
    }

    this.specialHeadFx?.update(dt);
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
