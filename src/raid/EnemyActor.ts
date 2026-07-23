// A display-only raid ENEMY sprite, assembled at runtime from its packed part
// strip (raids/enemies/parts/<key>.png) + rig (raids/enemies/models.json), and
// animated procedurally — the same approach the zombie RaidActor uses. ZF2's stage
// actors animate via a code-driven state machine (walk/idle) rather than baked
// keyframes, so a procedural idle-bob + leg-step walk + head-nod is faithful in
// spirit and keeps enemies visually consistent with the player zombies.
//
// Animation groups (set by tools/prep_enemies.py classify()):
//   body  — torso/surfboard/wheel/… (static; carried by the whole-body bob)
//   head  — nods about the rig's neck point
//   leg   — anchored at the hip; alternate front/back swing while advancing
//   arm   — held-tool arms on walkers stay put; on legless floaters they read as
//           tentacles/fins and sway
//   wing  — flaps (mirrored back/front)
import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import { EnemyModel } from "../assets";

const TILT_AMP_MOVE = 0.09;
const TILT_AMP_IDLE = 0.045;
const TILT_PERIOD_MOVE = 2.0;
const TILT_PERIOD_IDLE = 4.0;
const TILT_BACK_FRAC = 0.6;
const STEP_SPEED = 4.5;
const STEP_LIFT = 2.5;
const STEP_ANGLE = 0.3; // legs pivot at the hip, so this reads as a stride
const BOB_FREQ = 1.4;
const BOB_IDLE = 0.6; // whole-body breathe
const BOB_HOVER = 2.4; // legless floaters (squid, ice-cream) bob more
const ARM_SWAY_IDLE = 0.1; // floater tentacle/fin sway
const ARM_SWAY_MOVE = 0.18;
const ARM_FREQ = 1.7;
const WING_FLAP = 0.35;
const WING_FREQ = 6.0;
const WHEEL_SPIN = 7.0; // rad/s while rolling (bear unicycle)
// ---- attack swing (ZF2 fightAttack: — data-driven per Attacks.json) ----
// The enemy has no per-frame attack art, so the strike is procedural (as in the
// source, which animates stage actors via code, not baked keyframes). Like the player
// ZOMBIES, a weapon-holder does NOT jab its arm forward off the shoulder — instead the
// front arm stays ROOTED at the shoulder and CHOPS: it raises the held tool
// (pitchfork/axe) UP over the wind-up, then swings it DOWN through rest to strike. The
// downstroke peaks at the attack's damageTiming (Farmhand poke 0.33, Lumberjack slice
// 0.75) so the hit lands on the chop, then it recovers to rest by the cycle's end. A
// small whole-body step adds weight without sliding the arm off the shoulder.
const SWING_FRAC = 0.72; // fraction of the attack cooldown the swing occupies (rest before)
const LUNGE_PX = 5; // small forward body step at the strike (kept low: the reach is the chop, not a lunge)
const LUNGE_COCK = 0.35; // backward wind-up before the step (× LUNGE_PX)
// Chop envelope for weapon-holders — rotation of the front arm ABOUT THE SHOULDER.
// Positive lifts the tool's business end UP (wind-up); the downstroke swings it back
// DOWN past rest to the hit.
const CHOP_RAISE = 0.85; // rad the arm lifts the tool UP during the wind-up
const CHOP_STRIKE = 0.4; // rad past rest on the downstroke at the hit
const CHOP_RAISE_FRAC = 0.6; // fraction of the pre-hit window spent raising (rest chops down)
// The Scallywag's club uses a longer, higher wind-up and a shorter downstroke.
const HEAVY_CHOP_KEY = "PirateStageActorScallywag";
const HEAVY_CHOP_RAISE = 1.45;
const HEAVY_CHOP_STRIKE = 0.55;
const HEAVY_CHOP_RAISE_FRAC = 0.72;
// Rigs that strike with the BACK arm instead of the front one. SquiDude's front "arm"
// part is his bunched-up tentacle skirt (a wide z=9 mass covering the body) while the
// back part is the single raised tentacle — so the default front-arm strike swung the
// whole skirt. Striking with the back tentacle reads as the squid whipping it down.
const STRIKE_BACK_ARM_KEYS = new Set(["BeachStageActorBoss"]);
// A PUNCHER's forward jab keeps a small arm thrust (it has no tool to chop with).
const ARM_THRUST = 0.5; // puncher front-arm rotation added at the peak (rad; +ve reads as a forward jab)
const ARM_COCK = 0.35; // arm wind-up back-swing (× ARM_THRUST)
// A PUNCHER (bare-fisted lawyer / office boss — model.punch) rests its front arm DOWN
// at its side and only lifts it to jab; a weapon-holder keeps its tool up. The droop
// rotates the front arm about the shoulder; it eases back to 0 (extended) at the jab peak.
const ARM_PUNCH_DROOP = -1.3; // rad the front arm hangs down at rest (negative = swings DOWN)
// A legged attacker's REAR arm counter-swings with the strike (the body torques into
// the punch) instead of hanging frozen — e.g. McDonnell's back arm pumps as he jabs.
// It mirrors the front jab's envelope at a smaller amplitude, rotated the opposite way.
const BACK_ARM_SWING = 0.5; // rad the rear arm swings back at the jab peak
// A SLAMMER (model.slam — pirate boss) raises BOTH arms overhead during the wind-up,
// then slams them down through rest at the hit. Negative = up/back overhead; positive
// follow-through past rest. Both arms rotate about their authored shoulder pivots.
const SLAM_RAISE = 2.5; // rad both arms rotate UP overhead at the top of the wind-up
const SLAM_FOLLOW = 0.7; // rad past rest at the bottom of the slam (follow-through)
const SLAM_RAISE_FRAC = 0.55; // fraction of the pre-hit window spent raising (rest slams down)
// Circus attack families recovered from ZFAttackAnims (22/24) and the
// CircusStageActorMinion2 attack-state override (23).
const CIRCUS_BEAR_ATTACK = "UnicycleBearAttack";
const CIRCUS_STACK_ATTACK = "MidgetStackAttack";
const CIRCUS_RINGMASTER_ATTACK = "RingMasterAttack";
// Lawyers raid families recovered from ZFAttackAnims animation IDs 1, 4, and 6.
const LAWYER_WORKER_ATTACK = "CrazedWorkerAttack";
const LAWYER_ATTACK = "LawyerAttack";
const LAWYER_BOSS_ATTACKS = new Set(["CorporateBossPunch", "CorporateBossPunchSpecial"]);
// Pirates raid animation IDs 2 and 3. Scallywag shares animation 1 above.
const PIRATE_BOSS_ATTACK = "PirateBossSlash";
const PIRATE_SWASHBUCKLER_ATTACK = "SwashbucklerSlice";
const NINJA_STAB_ATTACK = "NinjaStab";
const ROBOT_BRO_ATTACK = "BroBotAttack";
const ROBOT_JUNK_ATTACK = "JunkBotBite";
const DEG = Math.PI / 180;

/** Smoothstep 0..1. */
const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

const keyframe = (t: number, frames: readonly (readonly [number, number])[]) => {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [time, value] = frames[i];
    const [prevTime, prevValue] = frames[i - 1];
    if (t <= time) return prevValue + (value - prevValue) * smooth((t - prevTime) / (time - prevTime));
  }
  return frames[frames.length - 1][1];
};

export interface EnemyAttackPose {
  atkProg: number;
  damageTiming: number;
  attackName?: string;
}

export class EnemyActor {
  readonly container = new Container();
  private root = new Container();
  private neck: { x: number; y: number } | null;
  private headParts: { sp: Sprite; bx: number; by: number }[] = [];
  private legs: { sp: Sprite; baseX: number; baseY: number; baseRot: number; back: boolean }[] = [];
  private arms: {
    sp: Sprite; baseX: number; baseY: number; baseRot: number;
    baseScaleX: number; baseScaleY: number; back: boolean;
  }[] = [];
  private bodies: {
    sp: Sprite; baseX: number; baseY: number; baseRot: number; baseScaleX: number; baseScaleY: number;
  }[] = [];
  private wings: { sp: Sprite; baseRot: number; back: boolean }[] = [];
  private wheels: { sp: Sprite; baseRot: number }[] = [];
  private hasLegs = false;
  /** Shared shoulder pivot the front arm(s) + held tool swing about during an attack —
   *  the top-most (min py) front arm part's anchor. Null if the rig has no front arm. */
  private shoulder: { x: number; y: number } | null = null;
  private backShoulder: { x: number; y: number } | null = null;
  private punch = false; // bare-fisted: rest arms at the sides, extend only to jab
  private slam = false; // two-handed overhead slam instead of a one-arm jab
  private heavyChop = false; // Scallywag's slower primary-hand club slam
  private strikeBack = false; // strike with the BACK arm; the front assembly rests/sways
  private chopSign = 1; // sign of the weapon-chop rotation (−1 for a cross-body swing)
  /** Art faces LEFT; enemies attack leftward (toward the zombies), so no flip by default. */
  private facing = 1;
  private tiltPhase = 0;
  private stepPhase = 0;
  private t = 0;

  constructor(strip: Texture, model: EnemyModel, sourceKey = "") {
    this.container.addChild(this.root);
    this.root.sortableChildren = true;
    this.neck = model.neck;
    this.punch = !!model.punch;
    this.slam = !!model.slam;
    this.heavyChop = sourceKey === HEAVY_CHOP_KEY;
    this.strikeBack = STRIKE_BACK_ARM_KEYS.has(sourceKey);
    const backShoulder = model.pivots?.find((p) => p.name === "back-shoulder");
    if (backShoulder) this.backShoulder = { x: backShoulder.x, y: backShoulder.y };
    if (model.chopSign) this.chopSign = model.chopSign < 0 ? -1 : 1;
    for (const p of model.parts) {
      const tex = new Texture({
        source: strip.source,
        frame: new Rectangle(p.rx, p.ry, p.rw, p.rh),
      });
      const sp = new Sprite(tex);
      sp.anchor.set(p.ax, p.ay);
      sp.position.set(p.px, p.py);
      sp.rotation = p.rot;
      sp.zIndex = p.z;
      this.root.addChild(sp);
      if (p.group === "head") this.headParts.push({ sp, bx: p.px, by: p.py });
      else if (p.group === "leg")
        this.legs.push({ sp, baseX: p.px, baseY: p.py, baseRot: p.rot, back: p.back });
      else if (p.group === "arm")
        this.arms.push({
          sp, baseX: p.px, baseY: p.py, baseRot: p.rot,
          baseScaleX: sp.scale.x, baseScaleY: sp.scale.y, back: p.back,
        });
      else if (p.group === "body")
        this.bodies.push({
          sp, baseX: p.px, baseY: p.py, baseRot: p.rot,
          baseScaleX: sp.scale.x, baseScaleY: sp.scale.y,
        });
      else if (p.group === "wing") this.wings.push({ sp, baseRot: p.rot, back: p.back });
      else if (p.group === "wheel") this.wheels.push({ sp, baseRot: p.rot });
    }
    this.hasLegs = this.legs.length > 0;
    // Shoulder the front-arm assembly (upper arm + held tool) swings about, so the
    // weapon thrusts WITH the arm instead of spinning about its own centre. The rig
    // gives it explicitly for weapon-holders (the arm bone, not the raised blade tip);
    // otherwise fall back to the top-most (min py) front arm part.
    if (model.shoulder) {
      this.shoulder = { x: model.shoulder.x, y: model.shoulder.y };
    } else {
      const front = this.arms.filter((a) => !a.back);
      if (front.length) {
        const top = front.reduce((a, b) => (b.baseY < a.baseY ? b : a));
        this.shoulder = { x: top.baseX, y: top.baseY };
      }
    }
  }

  /** Face toward a horizontal movement delta (art faces left at facing +1). */
  setFacingFromDelta(dx: number) {
    if (dx > 0.01) this.facing = -1;
    else if (dx < -0.01) this.facing = 1;
  }

  /**
   * @param attack when the enemy is trading blows, drives its strike swing:
   *   `atkProg` 0..1 fills over the attack cooldown (the sim's attack clock) and
   *   `damageTiming` is where in the swing the hit connects. Null = not attacking
   *   (rest). The lunge/thrust peaks near the hit, then recovers to rest by cycle end.
   */
  update(dt: number, moving: boolean, attack: EnemyAttackPose | null = null) {
    this.t += dt;
    const circusAttack = attack?.attackName === CIRCUS_BEAR_ATTACK
      || attack?.attackName === CIRCUS_STACK_ATTACK
      || attack?.attackName === CIRCUS_RINGMASTER_ATTACK;
    const lawyersAttack = attack?.attackName === LAWYER_WORKER_ATTACK
      || attack?.attackName === LAWYER_ATTACK
      || !!attack?.attackName && LAWYER_BOSS_ATTACKS.has(attack.attackName);
    const pirateAttack = attack?.attackName === PIRATE_BOSS_ATTACK
      || attack?.attackName === PIRATE_SWASHBUCKLER_ATTACK;
    const ninjaAttack = attack?.attackName === NINJA_STAB_ATTACK;
    const robotAttack = attack?.attackName === ROBOT_BRO_ATTACK
      || attack?.attackName === ROBOT_JUNK_ATTACK;
    const authoredAttack = circusAttack || lawyersAttack || pirateAttack || ninjaAttack || robotAttack;
    const genericAttack = authoredAttack ? null : attack;

    // Attack swing envelopes (0 when not attacking): a forward-then-back thrust that
    // peaks at the attack's damageTiming so the reach lands with the sim's hit.
    let thrust = 0; // 0=rest, 1=full forward reach (at the connect)
    let cock = 0; // brief backward wind-up, 0..1
    let chop = 0; // weapon-holders: front-arm rotation about the shoulder (- up, + downstroke)
    let slamAngle = 0; // slammers only: arms raise overhead (-) then slam down (+) to the hit
    if (genericAttack) {
      // The swing occupies the tail SWING_FRAC of the cooldown; rest before it.
      const u = (genericAttack.atkProg - (1 - SWING_FRAC)) / SWING_FRAC;
      if (u > 0 && u < 1) {
        const c = Math.min(0.95, Math.max(0.05, genericAttack.damageTiming)); // connect fraction
        thrust = u < c ? smooth(u / c) : 1 - smooth((u - c) / (1 - c));
        cock = Math.sin(Math.PI * Math.min(u / c, 1)); // wind-up bump, peaks mid-approach
        // Chop: raise the tool UP over the first CHOP_RAISE_FRAC of the approach, whip it
        // DOWN through rest to the hit at the connect (c), then ease back up to rest.
        const chopRaise = this.heavyChop ? HEAVY_CHOP_RAISE : CHOP_RAISE;
        const chopStrike = this.heavyChop ? HEAVY_CHOP_STRIKE : CHOP_STRIKE;
        const chopRaiseFrac = this.heavyChop ? HEAVY_CHOP_RAISE_FRAC : CHOP_RAISE_FRAC;
        const cf = c * chopRaiseFrac;
        if (u < cf) chop = chopRaise * smooth(u / cf);
        else if (u < c) chop = chopRaise - (chopRaise + chopStrike) * smooth((u - cf) / (c - cf));
        else chop = -chopStrike * (1 - smooth((u - c) / (1 - c)));
        chop *= this.chopSign; // flip for cross-body swingers so the raise still lifts UP
        if (this.slam) {
          // Raise overhead over the first SLAM_RAISE_FRAC of the approach, whip down to
          // the hit at the connect (c), then ease the follow-through back to rest.
          const rf = c * SLAM_RAISE_FRAC;
          if (u < rf) slamAngle = -SLAM_RAISE * smooth(u / rf);
          else if (u < c)
            slamAngle = -SLAM_RAISE + (SLAM_RAISE + SLAM_FOLLOW) * smooth((u - rf) / (c - rf));
          else slamAngle = SLAM_FOLLOW * (1 - smooth((u - c) / (1 - c)));
        }
      }
    }
    // Lunge the whole rig toward the target (screen-forward = the way it faces); this
    // carries the held tool + body together. Cock back a touch, then jab.
    const lunge = LUNGE_PX * thrust - LUNGE_PX * LUNGE_COCK * cock;
    const forward = -this.facing; // facing +1 = art/target to screen-left

    // Whole-body bob — a breathe when idle, a stronger hover for legless floaters.
    this.root.x = forward * lunge;
    this.root.y = Math.sin(this.t * BOB_FREQ) * (this.hasLegs ? BOB_IDLE : BOB_HOVER);

    // Head nod about the neck (rocks back/forth; faster while moving).
    if (this.neck && this.headParts.length) {
      const period = moving ? TILT_PERIOD_MOVE : TILT_PERIOD_IDLE;
      const amp = moving ? TILT_AMP_MOVE : TILT_AMP_IDLE;
      this.tiltPhase = (this.tiltPhase + dt / period) % 1;
      const p = this.tiltPhase;
      const angle =
        p < TILT_BACK_FRAC
          ? amp * Math.cos((p / TILT_BACK_FRAC) * Math.PI)
          : -amp * Math.cos(((p - TILT_BACK_FRAC) / (1 - TILT_BACK_FRAC)) * Math.PI);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const nx = this.neck.x, ny = this.neck.y;
      for (const h of this.headParts) {
        const dx = h.bx - nx, dy = h.by - ny;
        h.sp.position.set(nx + dx * cos - dy * sin, ny + dx * sin + dy * cos);
        h.sp.rotation = angle;
      }
    }

    // Legs step (swing from the hip + lift) while advancing; rest otherwise.
    if (this.hasLegs) {
      if (moving) {
        this.stepPhase += dt * STEP_SPEED;
        for (const l of this.legs) {
          const s = Math.sin(this.stepPhase + (l.back ? Math.PI : 0));
          l.sp.rotation = l.baseRot + s * STEP_ANGLE;
          l.sp.x = l.baseX;
          l.sp.y = l.baseY - Math.max(0, s) * STEP_LIFT;
        }
      } else {
        for (const l of this.legs) {
          l.sp.rotation = l.baseRot;
          l.sp.x = l.baseX;
          l.sp.y = l.baseY;
        }
      }
    }

    // Arms. FRONT arm(s) + the held tool swing together about the shared shoulder while
    // attacking — a forward jab whose reach peaks at the hit — else rest (walkers) or
    // sway as tentacles/fins (floaters). BACK arms never thrust: they rest, or sway on
    // floaters. Rotating about the shoulder (not each part's own anchor) is what makes
    // the weapon travel WITH the arm instead of spinning in place.
    const swing = genericAttack ? ARM_THRUST * thrust - ARM_THRUST * ARM_COCK * cock : 0;
    // A puncher's front arm hangs at its side (droop) and eases up to extended (0) at the
    // jab's peak (it has no tool, so it jabs); a weapon-holder chops instead (see `chop`).
    const droop = this.punch ? ARM_PUNCH_DROOP : 0;
    // Front-arm rotation about the shoulder: a puncher jabs (droop→extended + thrust);
    // a weapon-holder chops the tool up then down. Both stay ROOTED at the shoulder.
    const frontAngle = this.punch ? droop * (1 - thrust) + swing : chop;
    const sway = (a: { back: boolean }) =>
      this.hasLegs ? 0 : Math.sin(this.t * ARM_FREQ + (a.back ? Math.PI : 0)) * (moving ? ARM_SWAY_MOVE : ARM_SWAY_IDLE);
    for (const a of this.arms) {
      a.sp.scale.set(a.baseScaleX, a.baseScaleY);
      if (this.slam && genericAttack) {
        // Overhead slam: BOTH arm assemblies rotate about their authored shoulders.
        // Rotating at the sprite anchors made the Pirate Boss's arms detach and orbit.
        const pivot = a.back ? this.backShoulder : this.shoulder;
        if (pivot) {
          const cos = Math.cos(slamAngle), sin = Math.sin(slamAngle);
          const dx = a.baseX - pivot.x, dy = a.baseY - pivot.y;
          a.sp.position.set(
            pivot.x + dx * cos - dy * sin,
            pivot.y + dx * sin + dy * cos
          );
        } else {
          a.sp.position.set(a.baseX, a.baseY);
        }
        a.sp.rotation = a.baseRot + slamAngle;
      } else if (this.strikeBack) {
        // Back-arm striker: the BACK arm swings the strike, the front assembly only
        // rests/sways. Rotate about the part's OWN anchor rather than the rig's
        // `shoulder` — that pivot is authored for the front assembly, and these rigs
        // carry no back-shoulder pivot. The squid's back tentacle anchors at its top
        // centre, so an in-place rotation reads as it whipping down from the base.
        a.sp.position.set(a.baseX, a.baseY);
        a.sp.rotation = a.baseRot + (a.back && genericAttack ? frontAngle : sway(a));
      } else if (!a.back && this.shoulder && (this.punch || genericAttack)) {
        // Front arm rotates about the shared shoulder: puncher jab or weapon chop.
        const theta = frontAngle;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        const dx = a.baseX - this.shoulder.x, dy = a.baseY - this.shoulder.y;
        a.sp.position.set(this.shoulder.x + dx * cos - dy * sin, this.shoulder.y + dx * sin + dy * cos);
        a.sp.rotation = a.baseRot + theta;
      } else if (a.back && genericAttack && this.hasLegs) {
        // Rear arm on a legged attacker: counter-swing with the strike (opposite the
        // front jab, smaller reach) so the back arm pumps along instead of freezing.
        const back = -BACK_ARM_SWING * thrust + BACK_ARM_SWING * ARM_COCK * cock;
        a.sp.position.set(a.baseX, a.baseY);
        a.sp.rotation = a.baseRot + back;
      } else {
        a.sp.position.set(a.baseX, a.baseY);
        a.sp.rotation = a.baseRot + sway(a);
      }
    }

    // Wings flap (mirrored front/back).
    for (const w of this.wings) {
      w.sp.rotation = w.baseRot + Math.sin(this.t * WING_FREQ + (w.back ? Math.PI : 0)) * WING_FLAP;
    }

    // Wheel rolls in the travel direction while advancing (facing +1 = moving left).
    if (moving) {
      for (const wheel of this.wheels) wheel.sp.rotation -= dt * WHEEL_SPIN * this.facing;
    }

    for (const body of this.bodies) {
      body.sp.position.set(body.baseX, body.baseY);
      body.sp.rotation = body.baseRot;
      body.sp.scale.set(body.baseScaleX, body.baseScaleY);
    }
    if (circusAttack && attack) this.poseCircusAttack(attack);
    else if (lawyersAttack && attack) this.poseLawyersAttack(attack);
    else if (pirateAttack && attack) this.posePirateAttack(attack);
    else if (ninjaAttack && attack) this.poseNinjaStab(attack);
    else if (robotAttack && attack) this.poseRobotAttack(attack);

    this.root.scale.x = this.facing;
  }

  /** Rotate the cooldown so the source contact frame coincides with the sim hit. */
  private sourceAttackProgress(atkProg: number, damageTiming: number) {
    const recovery = 1 - damageTiming;
    return atkProg <= recovery ? damageTiming + atkProg : atkProg - recovery;
  }

  private poseCircusAttack(attack: EnemyAttackPose) {
    const t = this.sourceAttackProgress(attack.atkProg, attack.damageTiming);
    if (attack.attackName === CIRCUS_BEAR_ATTACK) this.poseUnicycleBear(t);
    else if (attack.attackName === CIRCUS_STACK_ATTACK) this.poseMidgetStack(t);
    else if (attack.attackName === CIRCUS_RINGMASTER_ATTACK) this.poseRingmaster(t);
  }

  private poseLawyersAttack(attack: EnemyAttackPose) {
    const t = this.sourceAttackProgress(attack.atkProg, attack.damageTiming);
    if (attack.attackName === LAWYER_WORKER_ATTACK) this.poseCrazedWorker(t);
    else if (attack.attackName === LAWYER_ATTACK) this.poseLawyer(t);
    else if (attack.attackName && LAWYER_BOSS_ATTACKS.has(attack.attackName))
      this.poseCorporateBoss(t);
  }

  private posePirateAttack(attack: EnemyAttackPose) {
    const t = this.sourceAttackProgress(attack.atkProg, attack.damageTiming);
    if (attack.attackName === PIRATE_BOSS_ATTACK) this.posePirateBoss(t);
    else if (attack.attackName === PIRATE_SWASHBUCKLER_ATTACK)
      this.poseSwashbuckler(t);
  }

  /**
   * Animation 1: armWhackFront + armHackBack2 + headHack.
   * The source front hand takes almost the whole cycle to wind through 180 degrees,
   * while the rear hand performs a shorter three-key hack and the head snaps forward.
   */
  private poseCrazedWorker(t: number) {
    const front = keyframe(t, [[0, 0], [0.9, 180 * DEG], [1, 0]]);
    const back = keyframe(t, [
      [0, 0], [0.55, -90 * DEG], [0.8, 25 * DEG],
      [0.85, -135 * DEG], [1, -135 * DEG],
    ]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    // headHack is two relative moves: (8, 4) over .95, then (-5, 0) over .05.
    const headX = keyframe(t, [[0, 0], [0.95, -8], [1, -3]]);
    const headY = keyframe(t, [[0, 0], [0.95, -4], [1, -4]]);
    for (const head of this.headParts) {
      head.sp.x += headX * this.facing;
      head.sp.y += headY;
    }
  }

  /**
   * Animation 4: the boss-only Flail2 pair. Each arm runs two .4s strikes with
   * a sharp .1s reset; the rear arm starts cocked at -45 degrees.
   */
  private poseCorporateBoss(t: number) {
    const phase = t < 0.5 ? t : t - 0.5;
    const front = phase <= 0.4
      ? keyframe(phase, [[0, 0], [0.4, -90 * DEG]])
      : keyframe(phase, [[0.4, -90 * DEG], [0.5, 0]]);
    const back = phase <= 0.1
      ? keyframe(phase, [[0, 0], [0.1, -45 * DEG]])
      : keyframe(phase, [[0.1, -45 * DEG], [0.5, -135 * DEG]]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    // headFlail: half a second into the blow, then half a second back.
    const headFlail = t <= 0.5 ? smooth(t / 0.5) : 1 - smooth((t - 0.5) / 0.5);
    for (const head of this.headParts) {
      head.sp.x += -8 * this.facing * headFlail;
      head.sp.y += headFlail;
    }
  }

  /**
   * Animation 6: an immediate 15px forward/up step, standard front/back flails,
   * and headFlail. The two arm helpers deliberately arrive on alternating beats.
   */
  private poseLawyer(t: number) {
    const front = keyframe(t, [[0, 0], [0.5, 50 * DEG], [0.75, 0], [1, 0]]);
    const back = keyframe(t, [[0, 0], [0.5, 0], [0.75, 50 * DEG], [1, 0]]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    const step = t < 0.75 ? 1 : 1 - smooth((t - 0.75) / 0.25);
    this.root.x += -15 * this.facing * step;
    this.root.y -= 15 * step;
    const headFlail = t <= 0.5 ? smooth(t / 0.5) : 1 - smooth((t - 0.5) / 0.5);
    for (const head of this.headParts) {
      head.sp.x += -8 * this.facing * headFlail;
      head.sp.y += headFlail;
    }
  }

  /**
   * Animation 2: armHackFront + an accelerated armHackBack + headFlail.
   * The rear helper is run at 90% scale and therefore finishes before contact.
   */
  private posePirateBoss(t: number) {
    const front = keyframe(t, [[0, 0], [0.95, 90 * DEG], [1, -135 * DEG]]);
    const back = keyframe(t, [[0, 0], [0.855, 45 * DEG], [0.9, -135 * DEG], [1, -135 * DEG]]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    const headFlail = t <= 0.5 ? smooth(t / 0.5) : 1 - smooth((t - 0.5) / 0.5);
    for (const head of this.headParts) {
      head.sp.x += -8 * this.facing * headFlail;
      head.sp.y += headFlail;
    }
  }

  /** Animation 3: armHackFront + armHackBack2 + the late headHack snap. */
  private poseSwashbuckler(t: number) {
    const front = keyframe(t, [[0, 0], [0.95, 90 * DEG], [1, -135 * DEG]]);
    const back = keyframe(t, [
      [0, 0], [0.55, -90 * DEG], [0.8, 25 * DEG],
      [0.85, -135 * DEG], [1, -135 * DEG],
    ]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    const headX = keyframe(t, [[0, 0], [0.95, -8], [1, -3]]);
    const headY = keyframe(t, [[0, 0], [0.95, -4], [1, -4]]);
    for (const head of this.headParts) {
      head.sp.x += headX * this.facing;
      head.sp.y += headY;
    }
  }

  /**
   * Animation 7: the Ninja girl's authored full-body stab. ZFAnims combines
   * armFlailFront3/Back3, headFlail2, the forward-lean helpers, and a tiptoe.
   */
  private poseNinjaStab(attack: EnemyAttackPose) {
    const t = this.sourceAttackProgress(attack.atkProg, attack.damageTiming);
    const frontArm = keyframe(t, [[0, 0], [0.8, -20 * DEG], [1, 90 * DEG]]);
    const backArm = keyframe(t, [[0, 0], [0.2, -90 * DEG], [1, 20 * DEG]]);
    for (const arm of this.arms) {
      const leanX = arm.back ? -5 : -10;
      const leanY = arm.back ? 4 : 2;
      arm.sp.x = arm.baseX + leanX * this.facing * t;
      arm.sp.y = arm.baseY + leanY * t;
      arm.sp.rotation = arm.baseRot + (arm.back ? backArm : frontArm);
    }

    const headAngle = keyframe(t, [
      [0, 0], [0.25, 0], [0.5, -3 * DEG],
      [0.75, -10 * DEG], [1, -2 * DEG],
    ]) * this.facing;
    for (const head of this.headParts) {
      head.sp.x += -8 * this.facing * t;
      head.sp.y += 3 * t;
      head.sp.rotation = headAngle;
    }
    for (const body of this.bodies)
      body.sp.rotation = body.baseRot - 8 * DEG * this.facing * t;

    for (const leg of this.legs) {
      if (leg.back) continue;
      leg.sp.x = leg.baseX + 2 * this.facing * t;
      leg.sp.y = leg.baseY - 2 * t;
      leg.sp.rotation = leg.baseRot - 20 * DEG * this.facing * t;
    }
  }

  private poseRobotAttack(attack: EnemyAttackPose) {
    const t = this.sourceAttackProgress(attack.atkProg, attack.damageTiming);
    if (attack.attackName === ROBOT_BRO_ATTACK) this.poseBroBot(t);
    else if (attack.attackName === ROBOT_JUNK_ATTACK) this.poseJunkBot(t);
  }

  /** Animation 14: BroBot's two independent mechanical arm spins and head jolt. */
  private poseBroBot(t: number) {
    const front = this.arms.filter((arm) => !arm.back);
    const primary = keyframe(t, [
      [0, 0], [0.05, 0], [0.65, 180 * DEG],
      [0.95, -270 * DEG], [1, 90 * DEG],
    ]);
    const secondary = keyframe(t, [
      [0, 0], [0.01, 0], [0.61, 140 * DEG],
      [0.96, -275 * DEG], [1, 0],
    ]);
    front.forEach((arm, i) => {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (i === 0 ? primary : secondary);
      const scale = i === 0
        ? keyframe(t, [[0, 1], [0.9, 1.2], [1, 1]])
        : 1;
      arm.sp.scale.set(arm.baseScaleX * scale, arm.baseScaleY * scale);
    });
    for (const arm of this.arms.filter((item) => item.back)) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + keyframe(t, [
        [0, 0], [0.9, 10 * DEG], [1, -20 * DEG],
      ]);
    }
    const headX = keyframe(t, [[0, 0], [0.8, -8], [0.95, 5], [1, 0]]);
    const headY = keyframe(t, [[0, 0], [0.8, -4], [0.95, 2], [1, 0]]);
    for (const head of this.headParts) {
      head.sp.x += headX * this.facing;
      head.sp.y += headY;
    }
  }

  /** Animation 15: JunkBot's body recoil followed by the fast 100-degree bite snap. */
  private poseJunkBot(t: number) {
    const body = keyframe(t, [[0, 0], [0.2, -20 * DEG], [1, 0]]);
    for (const part of this.bodies) part.sp.rotation = part.baseRot + body;
    const bite = keyframe(t, [[0, 0], [0.2, 100 * DEG], [0.3, 0], [1, 0]]);
    for (const head of this.headParts) head.sp.rotation = bite;
  }

  /** Animation 22: rapid unicycle corrections, a large arm flourish, then recovery. */
  private poseUnicycleBear(t: number) {
    const bodyRock = keyframe(t, [
      [0, 0], [0.05, -10 * DEG], [0.1, 10 * DEG], [0.2, -15 * DEG],
      [0.3, 15 * DEG], [0.6, -10 * DEG], [1, 0],
    ]);
    for (const body of this.bodies) body.sp.rotation = body.baseRot + bodyRock;
    for (const leg of this.legs) leg.sp.rotation = leg.baseRot - bodyRock * 0.6;

    this.arms.forEach((arm, i) => {
      const direction = i === 0 ? -1 : 1;
      const angle = keyframe(t, [
        [0, 0], [0.05, direction * 90 * DEG], [0.1, -direction * 90 * DEG],
        [0.2, direction * 120 * DEG], [0.3, -direction * 15 * DEG],
        [0.55, direction * 10 * DEG], [1, 0],
      ]);
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + angle;
    });
    for (const wheel of this.wheels) {
      wheel.sp.rotation = wheel.baseRot + keyframe(t, [
        [0, 0], [0.2, -90 * DEG], [0.3, 90 * DEG], [0.65, -20 * DEG], [1, 0],
      ]);
    }
    const hop = Math.sin(Math.PI * t);
    this.root.y += -5 * hop;
  }

  /** Animation 23 lives in CircusStageActorMinion2, not the generic dispatcher. */
  private poseMidgetStack(t: number) {
    const hit = 0.2;
    const envelope = t <= hit ? smooth(t / hit) : 1 - smooth((t - hit) / (1 - hit));
    this.bodies.forEach((body, i) => {
      const direction = i % 2 === 0 ? 1 : -1;
      const layer = i + 1;
      body.sp.x = body.baseX + direction * layer * 1.5 * envelope;
      body.sp.y = body.baseY - (i === this.bodies.length - 1 ? 5 : 2) * envelope;
      body.sp.rotation = body.baseRot + direction * (8 + layer) * DEG * envelope;
      body.sp.scale.set(
        body.baseScaleX * (1 + 0.025 * layer * envelope),
        body.baseScaleY * (1 - 0.02 * layer * envelope)
      );
    });
    this.arms.forEach((arm, i) => {
      const direction = i % 2 === 0 ? -1 : 1;
      arm.sp.x = arm.baseX + direction * 3 * envelope;
      arm.sp.y = arm.baseY - (i + 1) * envelope;
      arm.sp.rotation = arm.baseRot + direction * (10 + i * 3) * DEG * envelope;
    });
  }

  /** Animation 24: the Ringmaster's staggered, full-body theatrical strike. */
  private poseRingmaster(t: number) {
    const front = keyframe(t, [
      [0, 0], [0.1, 90 * DEG], [0.5, 160 * DEG], [0.75, 40 * DEG], [1, 0],
    ]);
    const back = keyframe(t, [
      [0, 0], [0.1, -90 * DEG], [0.5, -160 * DEG], [0.75, -40 * DEG], [1, 0],
    ]);
    for (const arm of this.arms) {
      arm.sp.position.set(arm.baseX, arm.baseY);
      arm.sp.rotation = arm.baseRot + (arm.back ? back : front);
    }
    const flourish = keyframe(t, [[0, 0], [0.4, 1], [0.75, 0.55], [1, 0]]);
    const strike = keyframe(t, [[0, 0], [0.5, 0], [0.75, 1], [1, 0]]);
    for (const body of this.bodies) body.sp.rotation = body.baseRot - 10 * DEG * flourish;
    for (const head of this.headParts) {
      head.sp.x -= 10 * strike;
      head.sp.y += 5 * strike;
      head.sp.rotation += 10 * DEG * flourish;
    }
    this.legs.forEach((leg, i) => {
      leg.sp.rotation = leg.baseRot + (i % 2 === 0 ? -1 : 1) * 10 * DEG * flourish;
    });
    this.root.x += -this.facing * 5 * strike;
  }
}
