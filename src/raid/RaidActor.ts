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
// A faint alternating sway on the forward arms while walking, so they're not stiff.
const ARM_WALK_SWAY = 0.09;
// Focus pose: eyes narrow vertically while the gold deployment bar advances.
// Ease rather than snapping so distraction/refocus transitions remain organic.
const FOCUS_EYE_SCALE_Y = 0.76;
const FOCUS_EYE_EASE = 14;
// Recovered ZFAttackAnims/ZFAnims timelines. ZombieBite (anim 8) moves the
// head, jaw, eyes and both arms; ZombieScratch (anim 9) uses an asymmetric
// arm flail plus a head thrust.
const BITE_DAMAGE_TIMING = 0.75;
const SCRATCH_DAMAGE_TIMING = 0.5;
const BITE_HEAD_X = -8;
const BITE_HEAD_Y = -6;
const BITE_JAW_X = -3;
const BITE_JAW_Y = 6; // source Y-up -6 converted to Pixi Y-down
const BITE_ARM_ANGLE = -120 * Math.PI / 180;
const SCRATCH_HEAD_X = -8;
const SCRATCH_HEAD_Y = 1;
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
  private eyes: { sp: Sprite; baseScaleY: number }[] = [];
  private jaws: Sprite[] = [];
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

  /**
   * Bounds of the zombie rig used to normalize its raid size.
   *
   * Animated head effects can extend well above a headless body. Including those
   * particles in the contain-fit bounds makes decorated headless zombies smaller
   * than otherwise identical undecorated ones.
   */
  getSizingBounds() {
    const fx = this.specialHeadFx?.container;
    if (!fx) return this.container.getLocalBounds();

    this.root.removeChild(fx);
    const bounds = this.container.getLocalBounds();
    this.root.addChild(fx);
    return bounds;
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
        if (/Eye[LR](?:\.png)?$/i.test(p.file)) {
          this.eyes.push({ sp, baseScaleY: sp.scale.y });
        }
        if (/Jaw(?:Feature)?(?:\.png)?$/i.test(p.file)) this.jaws.push(sp);
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

/** Pose combat and movement each frame. Priority is activated-move wind-up,
   *  attack, walking, then idle. Bite and scratch follow the recovered source
   *  timelines, rotated so their contact frames line up with simulated damage. */
  poseArms(
    windup: number,
    attacking: boolean,
    walking: boolean,
    atkProg: number,
    _atkCount: number,
    smashSlam = -1,
    healRaise = 0,
    attackName = ""
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
      if (/scratch/i.test(attackName)) this.poseScratch(atkProg);
      else this.poseBite(atkProg);
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

  /** Rotate a cooldown phase so source-time `damageTiming` occurs at the sim hit.
   *  After a hit the source animation finishes recovery, returns to neutral, then
   *  begins the next wind-up without a visible discontinuity. */
  private sourceAttackProgress(atkProg: number, damageTiming: number): number {
    const recovery = 1 - damageTiming;
    return atkProg <= recovery ? damageTiming + atkProg : atkProg - recovery;
  }

  private poseBite(atkProg: number) {
    const t = this.sourceAttackProgress(atkProg, BITE_DAMAGE_TIMING);
    // ZFAnims headBite: 0.13 move, 0.25 hold, 0.62 return.
    const head = t < 0.13 ? smooth(t / 0.13)
      : t < 0.38 ? 1
      : 1 - smooth((t - 0.38) / 0.62);
    for (const part of this.headParts) {
      part.sp.x += BITE_HEAD_X * head;
      part.sp.y += BITE_HEAD_Y * head;
    }

    // jawBite: open over 0.37 then snap mostly shut over 0.06.
    const jaw = t < 0.37 ? smooth(t / 0.37)
      : t < 0.43 ? 1 - smooth((t - 0.37) / 0.06)
      : 0;
    for (const part of this.jaws) {
      part.x += BITE_JAW_X * jaw;
      part.y += BITE_JAW_Y * jaw;
    }

    // eyeBiteSquint reaches 75% height during the bite and releases quickly.
    const squint = t < 0.43 ? smooth(Math.min(1, t / 0.12))
      : t < 0.49 ? 1 - smooth((t - 0.43) / 0.06)
      : 0;
    for (const eye of this.eyes) {
      eye.sp.scale.y = eye.baseScaleY * (1 - 0.25 * squint);
    }

    // armBite: -90 degrees in 0.12, -120 in 0.06, hold, then recover.
    const arm = t < 0.12 ? smooth(t / 0.12) * 0.75
      : t < 0.18 ? 0.75 + smooth((t - 0.12) / 0.06) * 0.25
      : t < 0.36 ? 1
      : t < 0.79 ? 1 - smooth((t - 0.36) / 0.43)
      : 0;
    for (const part of this.arms) part.rotation = BITE_ARM_ANGLE * arm;
  }

  private poseScratch(atkProg: number) {
    const t = this.sourceAttackProgress(atkProg, SCRATCH_DAMAGE_TIMING);
    // headFlail: 0.5 toward the target, 0.5 back. Its midpoint is the hit.
    const thrust = Math.sin(Math.PI * t);
    for (const part of this.headParts) {
      part.sp.x += SCRATCH_HEAD_X * thrust;
      part.sp.y += SCRATCH_HEAD_Y * thrust;
    }

    // eyeFlailSquint: 0.125 squeeze, 0.5 hold, 0.125 release.
    const squint = t < 0.125 ? smooth(t / 0.125)
      : t < 0.625 ? 1
      : t < 0.75 ? 1 - smooth((t - 0.625) / 0.125)
      : 0;
    for (const eye of this.eyes) {
      eye.sp.scale.y = eye.baseScaleY * (1 - 0.25 * squint);
    }

    // armFlailFront/Back are distinct binary helpers: the front claw cuts down
    // hard while the back arm counterbalances with a smaller opposite sweep.
    const slash = Math.sin(Math.PI * t);
    this.arms.forEach((arm, i) => {
      arm.rotation = i % 2 === 0 ? 0.92 * slash : -0.42 * slash;
    });
  }

  /** Mark this zombie dead — begins the head-pop on the next update. Idempotent. */
  markDead() {
    if (this.deathT < 0) {
      this.deathT = 0;
      if (this.specialHeadFx) this.specialHeadFx.container.visible = false;
    }
  }

  update(dt: number, moving: boolean, focusing = false) {
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
    const eyeEase = Math.min(1, dt * FOCUS_EYE_EASE);
    const eyeTarget = focusing ? FOCUS_EYE_SCALE_Y : 1;
    for (const eye of this.eyes) {
      eye.sp.scale.y += (eye.baseScaleY * eyeTarget - eye.sp.scale.y) * eyeEase;
    }
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

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
