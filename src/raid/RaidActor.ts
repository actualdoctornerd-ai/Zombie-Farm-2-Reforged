// A display-only zombie sprite for the raid scene: the SAME per-type skeletal
// model the farm uses (assets.zombieModels), with the SAME idle-tilt + leg-step
// walk animation as ZombieUnit — just decoupled from the farm's field/pathing.
// The scene positions it and tells it whether it's moving each frame.
import { Container, Sprite } from "pixi.js";
import { GameAssets, ZombieModel } from "../assets";
import { slotOf } from "../zombie/mutations";
import {
  backArmPlacement,
  isMutationForegroundPart,
  matchesMutationReplacement,
  mutationBitsForRendering,
  mutationPartFor,
  mutationCoversFace,
  mutationPartZIndex,
  type MutationReplacement,
} from "../zombie/mutationVisual";
import {
  BRUTE_EYEBALL_SCALE,
  DEFAULT_ZOMBIE_EYE_TINT,
  displayedAppearance,
  isBruteEyeball,
  zombiePartTint,
} from "../zombie/appearance";
import { SpecialHeadFx, specialHeadFxKind } from "../zombie/specialHeadFx";
import { poseForFrame } from "./clipRuntime";
import {
  zombieAttackClipName, ZOMBIE_ATTACK_DAMAGE_TIMING,
} from "./zombieAttackPresentation";

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
// The two contact timings are NOT repeated here: the renderer measures each swing's
// follow-through window from the same numbers, and a copy that drifted would park a
// waiting zombie mid-bite instead of at rest. One source, in zombieAttackPresentation.
const BITE_DAMAGE_TIMING = ZOMBIE_ATTACK_DAMAGE_TIMING.ZombieBite;
const SCRATCH_DAMAGE_TIMING = ZOMBIE_ATTACK_DAMAGE_TIMING.ZombieScratch;
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
const MUT_BASE_FOREGROUND_Z = 30;

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
  /** Free-running clock, for a clip's idle/move phase (see raid/clipRuntime.ts). */
  private t = 0;
  /** Every part sprite BY MODEL PART INDEX, with its rest pose. build() SKIPS parts —
   *  a mutation replaces the arms, a missing texture drops one — so child order is not
   *  part order here and an authored clip, which addresses parts by index, needs this. */
  private partSprites: { sp: Sprite; i: number; px: number; py: number; scale: number }[] = [];
  /** The rig a clip would be authored against, and the key it is filed under. */
  private clipModel: ZombieModel | null = null;
  private clipKey = "";
  private specialHeadFx: SpecialHeadFx | null = null;

  constructor(
    assets: GameAssets,
    key: string,
    mutation = 0,
    group = "",
    /** The owned unit's body tint. Omitted (enemies, reference rigs, tests) falls
     *  back to the model's catalog colour. */
    color?: [number, number, number],
  ) {
    this.container.addChild(this.root);
    // Raid rigs honour the same display prefs as the farm and the portraits, so a
    // player who hid mutations (or pinned species colours) sees the same zombie here.
    const shown = displayedAppearance(mutation, color);
    this.build(assets, key, shown.mutation, group, shown.color);
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

  /** Rig height before its model-authored scale is applied. Farm actors use this
   * native silhouette with zombieFarmScale, so raids use it to retain the same
   * relative apparent size. */
  getNativeSizingHeight(): number {
    return this.getSizingBounds().height / Math.max(0.001, this.renderScale);
  }

  /** GLOBAL positions of the rig's individual eyes — the muzzles of the T3/T4
   *  walking laser, which fires one beam per eye. Each point follows its eye through
   *  walk-bob and attack tilts and honours the facing flip. Empty when the face is
   *  covered (a pumpkin head builds no eye sprites) or the head has popped off in
   *  death — callers fall back to an approximate eye height. */
  eyePointsGlobal(): { x: number; y: number }[] {
    if (this.deathT >= 0) return [];
    return this.eyes.map((eye) => this.root.toGlobal({ x: eye.sp.x, y: eye.sp.y }));
  }

  private build(
    assets: GameAssets, key: string, mutation: number, group: string,
    color?: [number, number, number],
  ) {
    const m: ZombieModel =
      assets.zombieModels[key] ?? assets.zombieModels["ZombieActorRegularTier1"];
    this.clipModel = m;
    this.clipKey = key;
    const mutationParts = mutationBitsForRendering(assets.zombies, key, mutation).flatMap((bit) => {
      const part = mutationPartFor(assets.mutationParts, m, bit);
      const texture = part ? assets.zombiePartTex[part.file] : undefined;
      return part && texture ? [{ bit, part, texture }] : [];
    });
    // Crop arms occupy the authored arm slot — BOTH arms, front and back. Only
    // suppress the base pair after the replacement has resolved, so an incomplete
    // asset cannot remove it.
    const replacements = new Set<MutationReplacement>();
    for (const { bit, part } of mutationParts) {
      if (part.replaces) replacements.add(part.replaces);
      else {
        const slot = slotOf(bit);
        if (slot === "head") replacements.add("head");
        else if (slot === "arm") replacements.add("armF");
        else if (slot === "body") replacements.add("body");
      }
    }
    // A head mutation that carries its own face (the pumpkin) takes the zombie's
    // eyes and jaw with the skull, instead of leaving them in front of it.
    const coversFace = mutationParts.some(({ bit }) => mutationCoversFace(bit));
    // Same rule as the farm rig and the portraits: an owned tint wins over the
    // model's catalog colour, so a Pot child looks the same everywhere.
    const [r, g, b] = color ?? m.color;
    const tint = (r << 16) | (g << 8) | b;
    this.renderScale = MODEL_BASE * (m.scale ?? 1);
    this.root.sortableChildren = true;
    this.neck = { x: m.neck.x, y: m.neck.y };

    for (const [partIndex, p] of m.parts.entries()) {
      if (replacements.has("armF") && matchesMutationReplacement(p.file, "armF")) continue;
      if (replacements.has("body") && /Body$/i.test(p.file)) continue;
      if (
        replacements.has("head")
        && p.group === "head"
        && (matchesMutationReplacement(p.file, "head")
          || (coversFace && isMutationForegroundPart(p.file)))
      ) continue;
      const tex = assets.zombiePartTex[p.file];
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.scale.set(p.scale ?? 1);
      // A head mutation pushes the face in FRONT of the new skull; anything that stays
      // at its authored z would end up behind it.
      const foreground = replacements.has("head") && isMutationForegroundPart(p.file);
      sp.zIndex = foreground ? MUT_BASE_FOREGROUND_Z + p.z : p.z;
      if (p.tint) sp.tint = zombiePartTint(p.file, tint, group);
      this.root.addChild(sp);
      this.partSprites.push({ sp, i: partIndex, px: p.px, py: p.py, scale: p.scale ?? 1 });
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

      // Match the farm rig: Large zombies retain their dark full-size eye disks
      // with a light authored eyeball centered inside at one-fifth scale. Register
      // the overlay as both a head part and an eye so raid tilt, death, focus, bite,
      // and scratch animations keep the two layers together.
      if (isBruteEyeball(group, p.file)) {
        const eyeball = new Sprite(tex);
        eyeball.anchor.set(p.ax, p.ay);
        eyeball.position.set(p.px, p.py);
        eyeball.scale.set((p.scale ?? 1) * BRUTE_EYEBALL_SCALE);
        eyeball.tint = DEFAULT_ZOMBIE_EYE_TINT;
        // Track the disk's own z, INCLUDING the head-mutation bump — the eyeball is the
        // only light thing in a Large zombie's eye, so leaving it at the authored z put
        // it behind an onion/pumpkin head and the eyes read as solid black.
        eyeball.zIndex = sp.zIndex + 0.1;
        this.root.addChild(eyeball);
        this.headParts.push({ sp: eyeball, bx: p.px, by: p.py });
        this.eyes.push({ sp: eyeball, baseScaleY: eyeball.scale.y });
      }
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
      sp.zIndex = mutationPartZIndex(bit, mp.group, mp.z);
      if (mp.group === "head") {
        this.headParts.push({ sp, bx: px, by: py });
      } else if (mp.replaces === "armF" || (!mp.replaces && slotOf(bit) === "arm")) {
        // A crop arm claims BOTH arms. The back copy is registered FIRST so `arms`
        // keeps the back/front alternation the base rig gives it (defaultArmB is
        // authored before defaultArmF) — the walk sway and the scratch flail read
        // that order by index parity.
        const at = backArmPlacement(m, mp);
        if (at) {
          const back = new Sprite(tex);
          back.anchor.set(at.ax, at.ay);
          back.position.set(at.x, at.y);
          back.scale.set(at.scale);
          back.tint = at.tint;
          back.zIndex = at.z;
          this.root.addChild(back);
          this.arms.push(back);
        }
        this.arms.push(sp);
      }
      this.root.addChild(sp);
    }
    // Headless models have no feet — guard the walk animation.
    const headFxKind = specialHeadFxKind(key, mutation);
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
    // An authored clip replaces the whole pose — the head rock update() just applied as
    // well as the arms — so it has to run here, after update(), where the combat state is
    // finally known. Abilities are deliberately NOT on this path: their clips are driven
    // by a progress value (wind-up, heal raise, slam) rather than a clock, and the
    // transcription does not record that mapping yet, so they keep the procedural pose.
    const ability = smashSlam >= 0 || windup > 0 || healRaise > 0;
    if (!ability && this.deathT < 0 && this.applyAuthoredClip(attacking, walking, atkProg, attackName)) {
      return;
    }
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

  /**
   * Pose from an authored clip. False when the rig has none for this state, in which
   * case the caller runs the procedural pose exactly as it always has.
   *
   * Anything the clip does not name is returned to its rest pose rather than left where
   * update() put it a moment ago — a clip is the WHOLE pose, not a layer on top.
   */
  private applyAuthoredClip(
    attacking: boolean, walking: boolean, atkProg: number, attackName: string,
  ): boolean {
    if (!this.clipModel) return false;
    const name = attacking
      ? zombieAttackClipName(/scratch/i.test(attackName) ? "ZombieScratch" : "ZombieBite")
      : walking ? "move" : "idle";
    const pose = poseForFrame(
      "zombie", this.clipKey, this.clipModel, walking,
      undefined, attacking ? atkProg : null, this.t, name,
    );
    if (!pose) return false;
    for (const base of this.partSprites) {
      const d = pose.parts[base.i];
      if (d) {
        base.sp.position.set(base.px + d.dx, base.py + d.dy);
        base.sp.rotation = d.rot;
        base.sp.scale.set(base.scale * d.sx, base.scale * d.sy);
      } else {
        base.sp.position.set(base.px, base.py);
        base.sp.rotation = 0;
        base.sp.scale.set(base.scale);
      }
    }
    this.root.scale.set(
      this.renderScale * this.facing * pose.root.sx, this.renderScale * pose.root.sy,
    );
    return true;
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

  /** Undo markDead: a Garden holder's Resurrect puts this zombie back on its feet.
   *
   *  The death pose is not something the idle/walk animation grows out of — while
   *  `deathT` is set, update() takes the head-pop branch and returns, so the head
   *  keeps flying further away every frame and the head effect stays hidden. A
   *  revived zombie therefore stood back up headless (most visibly the Headless
   *  families, whose whole head IS the effect, and anything wearing a head
   *  mutation). Put the head back on the neck and hand the rig to the live
   *  animation again. Idempotent. */
  markAlive() {
    if (this.deathT < 0) return;
    this.deathT = -1;
    for (const h of this.headParts) {
      h.sp.position.set(h.bx, h.by);
      h.sp.rotation = 0;
    }
    if (this.specialHeadFx) this.specialHeadFx.container.visible = true;
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

    this.t += dt;
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
