// The BUILT-IN clips: a transcription of what src/raid/EnemyActor.ts and
// src/raid/RaidActor.ts do procedurally, expressed in the clip schema so the Rig Studio
// can show you the animation the game is actually running and let you edit from there.
//
// Studio-and-test only. The game never loads this file: a rig with no authored clip runs
// the procedural code itself, so these tables would be dead weight in the bundle. The
// schema and evaluator they build on are the runtime's own copy, imported below.
//
// src/rigClips.test.ts is what keeps the transcription honest — it drives every clip in
// here against the real actors, pose for pose.
import {
  DEG, clamp, round, clone, smooth, SWING_FRAC, REST_FRAC,
  partMeta, targetsOf, resolveTarget, pivotsOf, pivotPoint,
  evalKeys, evalTrack, poseAt, hitAt,
} from "../src/raid/rigClips.js";

export {
  DEG, clamp, round, clone, smooth, SWING_FRAC, REST_FRAC,
  partMeta, targetsOf, resolveTarget, pivotsOf, pivotPoint,
  evalKeys, evalTrack, poseAt, hitAt,
};

// =========================================================================
//  BUILT-INS
// =========================================================================
// --- EnemyActor.ts constants, verbatim ---
const TILT_AMP_MOVE = 0.09, TILT_AMP_IDLE = 0.045;
const TILT_PERIOD_MOVE = 2.0, TILT_PERIOD_IDLE = 4.0, TILT_BACK_FRAC = 0.6;
const STEP_SPEED = 4.5, STEP_LIFT = 2.5, STEP_ANGLE = 0.3;
const BOB_FREQ = 1.4, BOB_IDLE = 0.6, BOB_HOVER = 2.4;
const ARM_SWAY_IDLE = 0.1, ARM_SWAY_MOVE = 0.18, ARM_FREQ = 1.7;
const WING_FLAP = 0.35, WING_FREQ = 6.0, WHEEL_SPIN = 7.0;
const LUNGE_PX = 5, LUNGE_COCK = 0.35;
const CHOP_RAISE = 0.85, CHOP_STRIKE = 0.4, CHOP_RAISE_FRAC = 0.6;
const HEAVY_CHOP_KEY = "PirateStageActorScallywag";
const HEAVY_CHOP_RAISE = 1.45, HEAVY_CHOP_STRIKE = 0.55, HEAVY_CHOP_RAISE_FRAC = 0.72;
const STRIKE_BACK_ARM_KEYS = ["BeachStageActorBoss"];
const ARM_THRUST = 0.5, ARM_COCK = 0.35, ARM_PUNCH_DROOP = -1.3, BACK_ARM_SWING = 0.5;
const SLAM_RAISE = 2.5, SLAM_FOLLOW = 0.7, SLAM_RAISE_FRAC = 0.55;
// --- RaidActor.ts constants, verbatim ---
const Z_TILT_AMP_MOVE = 0.1, Z_TILT_AMP_IDLE = 0.05;
const Z_STEP_ANGLE = 0.18, Z_STEP_LIFT = 2.5;
const RAISE_ANGLE = -2.5, ARM_FWD = 0.0, ARM_REST = -1.5, HEAL_OVERHEAD = 1.5;
const ARM_WALK_SWAY = 0.09;
const BITE_DAMAGE_TIMING = 0.75, SCRATCH_DAMAGE_TIMING = 0.5;
const BITE_HEAD_X = -8, BITE_HEAD_Y = -6, BITE_JAW_X = -3, BITE_JAW_Y = 6;
const BITE_ARM_ANGLE = -120;
const SCRATCH_HEAD_X = -8, SCRATCH_HEAD_Y = 1;
const SMASH_GROW = 0.4, SMASH_SLAM_S = 0.18;
const HEAL_POSE_S = 0.7;
// --- RaidScene.ts: the perched boss reuses the attack envelope ---
const THROW_WINDOW_S = 0.55, THROW_DAMAGE_TIMING = 0.9;
const WALL_CAST_S = 3.0, WALL_DAMAGE_TIMING = 0.98, WALL_SPAN = 0.64 / SWING_FRAC;

const rad = (r) => round(r / DEG);      // engine radians -> authoring degrees
const T = (o) => o;                     // readability shim for track literals
/** Sample a continuous envelope into keys; used only where the engine's motion is
 *  not already piecewise-smoothstep (the half-sine cock, the hop). */
function sampled(fn, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n; out.push([round(t), round(fn(t))]); }
  return out;
}

/** The engine's asymmetric head rock (60% back, 40% forward), in degrees. */
const tiltKeys = (amp) => [
  [0, rad(amp)], [0.3, 0], [TILT_BACK_FRAC, rad(-amp)],
  [TILT_BACK_FRAC + (1 - TILT_BACK_FRAC) / 2, 0], [1, rad(amp)],
];
/** Cycles of a free-running sin(t * freq) that fit into a clip of `dur` seconds. */
const cyclesFor = (freq, dur) => round(dur * freq / (2 * Math.PI));

/** The whole-body bob's own period — `sin(t * BOB_FREQ)`, in seconds. */
const BOB_PERIOD = round(2 * Math.PI / BOB_FREQ);

/**
 * The two motions the engine runs under EVERYTHING, attack included.
 *
 * `headRock` is dropped for the handful of authored attacks that ASSIGN head rotation
 * rather than adding to it (NinjaStab's turn, JunkBot's bite) — those overwrite the
 * rock, so carrying it would double-count. Their head POSITION still comes from the
 * rock, but at these amplitudes that is under a pixel, and the alternative is a
 * per-channel override model for two rigs.
 */
const HEAD_ROT_OVERRIDDEN = ["NinjaStab", "JunkBotBite"];
function persistentTracks(model, hasHead, hasLegs, attackName) {
  const out = [{
    name: "breathe (free-running)", target: "root", channel: "y",
    wave: { amp: hasLegs ? BOB_IDLE : BOB_HOVER, cycles: 1, phase: 0 },
    free: { period: BOB_PERIOD },
  }];
  if (hasHead) {
    // NinjaStab and JunkBotBite ASSIGN head rotation, so the rock's turn is overwritten
    // — but its swing about the neck has already MOVED the head, and that survives.
    out.push({
      name: "head rock (free-running)", target: "head", channel: "rot", pivot: "neck",
      keys: tiltKeys(TILT_AMP_IDLE), free: { period: TILT_PERIOD_IDLE },
      posOnly: HEAD_ROT_OVERRIDDEN.indexOf(attackName) >= 0 || undefined,
    });
  }
  return out;
}

// ---- the generic enemy attack envelope ----------------------------------
// Written in CYCLE time: the engine rests for the first 28% of the attack cooldown
// and swings over the remaining 72%, with the blow landing at damageTiming inside
// that swing. `u` below is the engine's own swing parameter.
function envelope(c, heavy, chopSign) {
  c = clamp(c, 0.05, 0.95);
  const R = heavy ? HEAVY_CHOP_RAISE : CHOP_RAISE;
  const S = heavy ? HEAVY_CHOP_STRIKE : CHOP_STRIKE;
  const RF = heavy ? HEAVY_CHOP_RAISE_FRAC : CHOP_RAISE_FRAC;
  const cf = c * RF, rf = c * SLAM_RAISE_FRAC;
  const sign = chopSign < 0 ? -1 : 1;
  const thrust = (u) => (u <= 0 || u >= 1 ? 0 : u < c ? smooth(u / c) : 1 - smooth((u - c) / (1 - c)));
  const cock = (u) => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * Math.min(u / c, 1)));
  const chop = (u) => {
    let v;
    if (u < cf) v = R * smooth(u / cf);
    else if (u < c) v = R - (R + S) * smooth((u - cf) / (c - cf));
    else v = -S * (1 - smooth((u - c) / (1 - c)));
    return v * sign;
  };
  const slam = (u) => {
    if (u < rf) return -SLAM_RAISE * smooth(u / rf);
    if (u < c) return -SLAM_RAISE + (SLAM_RAISE + SLAM_FOLLOW) * smooth((u - rf) / (c - rf));
    return SLAM_FOLLOW * (1 - smooth((u - c) / (1 - c)));
  };
  return { c, cf, rf, thrust, cock, chop, slam, breaks: [0, cf, c, 1], slamBreaks: [0, rf, c, 1] };
}

/**
 * Turn one envelope into keys on a clip's timeline.
 *
 * `uToT` maps the engine's swing parameter onto the clip's own 0..1, and `uMax` is the
 * largest u the clip ever reaches — the 3 s wall summon only winds to u = 0.889, so its
 * breakpoints past that are unreachable and would otherwise pile up on the last frame.
 * Piecewise-smoothstep envelopes come out EXACT from their own breakpoints; anything
 * else (the half-sine wind-up) is sampled.
 */
function envKeys(fn, breaks, uToT, uMax) {
  // Untruncated, a piecewise-smoothstep envelope IS its breakpoints: the track's own
  // "smooth" ease reproduces each segment exactly. A clip that stops PART-WAY through a
  // segment cannot do that — re-easing a slice of a smoothstep eases it twice — so such
  // a track is densely sampled and interpolated LINEARLY instead.
  const last = breaks[breaks.length - 1];
  if (uMax >= last) {
    return { ease: "smooth", keys: breaks.map((u) => [round(uToT(u)), round(fn(u))]) };
  }
  return { ease: "linear", keys: sampleKeys(fn, uToT, uMax, 40) };
}
function sampleKeys(fn, uToT, uMax, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * uMax;
    out.push([round(uToT(u)), round(fn(u))]);
  }
  return out;
}

function genericTracks(model, key, damageTiming, uToT, uMax) {
  const heavy = key === HEAVY_CHOP_KEY;
  const strikeBack = STRIKE_BACK_ARM_KEYS.indexOf(key) >= 0;
  const env = envelope(damageTiming, heavy, model.chopSign || 1);
  const hasLegs = (model.parts || []).some((p) => p.group === "leg");
  // Same rule as the idle/move sets: an armless rig gets the body lunge and nothing
  // aimed at limbs it does not have. The Valentines heart-stack is three bodies.
  const hasArms = (model.parts || []).some((p) => p.group === "arm");
  const out = [];
  // The engine's swing is a REACH plus a WIND-UP: `thrust` is piecewise smoothstep and
  // transcribes to exact keys, while `cock` is a half-sine that does not. Splitting them
  // into two tracks on the same channel (which simply sum) keeps the reach exact and
  // confines the sampling to a term whose whole amplitude is a fraction of a radian.
  const thrustKeys = (scale, offset) => envKeys(
    (u) => round((offset || 0) + scale * env.thrust(u)), [0, env.c, 1], uToT, uMax);
  // The half-sine wind-up is never smoothstep, so it is sampled and read back linearly.
  const cockKeys = (scale) => ({
    ease: "linear", keys: sampleKeys((u) => round(scale * env.cock(u)), uToT, uMax, 64),
  });

  // Whole-body lunge: cock back a touch, then step into the blow. The rig faces
  // screen-LEFT at facing +1, so forward is negative x.
  out.push({ name: "body lunge", target: "root", channel: "x", ...thrustKeys(-LUNGE_PX, 0) });
  out.push({ name: "body wind-up", target: "root", channel: "x", ...cockKeys(LUNGE_PX * LUNGE_COCK) });

  if (!hasArms) {
    return out;
  }
  if (model.slam) {
    const slam = envKeys((u) => rad(env.slam(u)), env.slamBreaks, uToT, uMax);
    out.push({ name: "front arm slam", target: "arm.front", channel: "rot", pivot: "shoulder", ...slam });
    out.push({ name: "back arm slam", target: "arm.back", channel: "rot", pivot: "auto", ...clone(slam) });
  } else if (model.punch) {
    // A bare-fisted rig rests its front arm DOWN and only lifts it to jab.
    out.push({
      name: "front arm jab", target: "arm.front", channel: "rot", pivot: "shoulder",
      ...thrustKeys(rad(ARM_THRUST - ARM_PUNCH_DROOP), rad(ARM_PUNCH_DROOP)),
    });
    out.push({
      name: "front arm wind-up", target: "arm.front", channel: "rot", pivot: "shoulder",
      ...cockKeys(rad(-ARM_THRUST * ARM_COCK)),
    });
  } else if (strikeBack) {
    out.push({ name: "back tentacle whip", target: "arm.back", channel: "rot", ...envKeys((u) => rad(env.chop(u)), env.breaks, uToT, uMax) });
  } else {
    out.push({ name: "front arm chop", target: "arm.front", channel: "rot", pivot: "shoulder", ...envKeys((u) => rad(env.chop(u)), env.breaks, uToT, uMax) });
  }
  if (!model.slam && hasLegs) {
    out.push({
      name: "back arm counter-swing", target: "arm.back", channel: "rot", pivot: "auto",
      ...thrustKeys(rad(-BACK_ARM_SWING), 0),
    });
    out.push({
      name: "back arm wind-up", target: "arm.back", channel: "rot", pivot: "auto",
      ...cockKeys(rad(BACK_ARM_SWING * ARM_COCK)),
    });
  }
  return out;
}

// ---- authored enemy attacks (ZFAttackAnims / ZFAnims timelines) ---------
// Transcribed key-for-key from EnemyActor's pose* methods. These run in SOURCE
// time, so the hit is at `damageTiming` on this timeline.
const headFlailX = [[0, 0], [0.5, -8], [1, 0]];
const headFlailY = [[0, 0], [0.5, 1], [1, 0]];
const headHackX = [[0, 0], [0.95, -8], [1, -3]];
const headHackY = [[0, 0], [0.95, -4], [1, -4]];
const armHackBack2 = [[0, 0], [0.55, -90], [0.8, 25], [0.85, -135], [1, -135]];
const armHackFront = [[0, 0], [0.95, 90], [1, -135]];

const AUTHORED = {
  // Animation 1 — the Crazed Worker's 180-degree front wind-through.
  CrazedWorkerAttack: [
    { name: "front arm whack", target: "arm.front", channel: "rot", pivot: "auto", keys: [[0, 0], [0.9, 180], [1, 0]] },
    { name: "back arm hack", target: "arm.back", channel: "rot", pivot: "auto", keys: armHackBack2 },
    { name: "head hack x", target: "head", channel: "x", keys: headHackX },
    { name: "head hack y", target: "head", channel: "y", keys: headHackY },
  ],
  // Animation 4 — the Corporate Boss's boss-only Flail2 pair (two strikes a cycle).
  CorporateBossPunch: [
    { name: "front arm flail", target: "arm.front", channel: "rot", pivot: "auto", keys: [[0, 0], [0.4, -90], [0.5, 0], [0.9, -90], [1, 0]] },
    { name: "back arm flail", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.1, -45], [0.4999, -135], [0.5, 0], [0.6, -45], [1, -135]] },
    { name: "head flail x", target: "head", channel: "x", keys: headFlailX },
    { name: "head flail y", target: "head", channel: "y", keys: headFlailY },
  ],
  // Animation 6 — the Lawyer's immediate 15 px forward/up step.
  LawyerAttack: [
    { name: "front arm flail", target: "arm.front", channel: "rot", pivot: "auto", keys: [[0, 0], [0.5, 50], [0.75, 0], [1, 0]] },
    { name: "back arm flail", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.5, 0], [0.75, 50], [1, 0]] },
    { name: "step in (x)", target: "root", channel: "x", keys: [[0, -15], [0.75, -15], [1, 0]] },
    { name: "step in (y)", target: "root", channel: "y", keys: [[0, -15], [0.75, -15], [1, 0]] },
    { name: "head flail x", target: "head", channel: "x", keys: headFlailX },
    { name: "head flail y", target: "head", channel: "y", keys: headFlailY },
  ],
  // Animation 2 — the Pirate Boss's accelerated rear helper.
  PirateBossSlash: [
    { name: "front arm hack", target: "arm.front", channel: "rot", pivot: "auto", keys: armHackFront },
    { name: "back arm hack", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.855, 45], [0.9, -135], [1, -135]] },
    { name: "head flail x", target: "head", channel: "x", keys: headFlailX },
    { name: "head flail y", target: "head", channel: "y", keys: headFlailY },
  ],
  // Animation 3 — armHackFront + armHackBack2 + the late headHack snap.
  SwashbucklerSlice: [
    { name: "front arm hack", target: "arm.front", channel: "rot", pivot: "auto", keys: armHackFront },
    { name: "back arm hack", target: "arm.back", channel: "rot", pivot: "auto", keys: armHackBack2 },
    { name: "head hack x", target: "head", channel: "x", keys: headHackX },
    { name: "head hack y", target: "head", channel: "y", keys: headHackY },
  ],
  // Animation 7 — the Ninja girl's full-body stab (its leans are LINEAR in t).
  NinjaStab: [
    { name: "front arm stab", target: "arm.front", channel: "rot", pivot: "auto", keys: [[0, 0], [0.8, -20], [1, 90]] },
    { name: "back arm", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.2, -90], [1, 20]] },
    { name: "front arm lean x", target: "arm.front", channel: "x", ease: "linear", keys: [[0, 0], [1, -10]] },
    { name: "front arm lean y", target: "arm.front", channel: "y", ease: "linear", keys: [[0, 0], [1, 2]] },
    { name: "back arm lean x", target: "arm.back", channel: "x", ease: "linear", keys: [[0, 0], [1, -5]] },
    { name: "back arm lean y", target: "arm.back", channel: "y", ease: "linear", keys: [[0, 0], [1, 4]] },
    { name: "head lean x", target: "head", channel: "x", ease: "linear", keys: [[0, 0], [1, -8]] },
    { name: "head lean y", target: "head", channel: "y", ease: "linear", keys: [[0, 0], [1, 3]] },
    { name: "head turn", target: "head", channel: "rot", keys: [[0, 0], [0.25, 0], [0.5, -3], [0.75, -10], [1, -2]] },
    { name: "body lean", target: "body", channel: "rot", ease: "linear", keys: [[0, 0], [1, -8]] },
    { name: "tiptoe x", target: "leg.front", channel: "x", ease: "linear", keys: [[0, 0], [1, 2]] },
    { name: "tiptoe y", target: "leg.front", channel: "y", ease: "linear", keys: [[0, 0], [1, -2]] },
    { name: "tiptoe rot", target: "leg.front", channel: "rot", ease: "linear", keys: [[0, 0], [1, -20]] },
  ],
  // Animation 14 — BroBot's two independent mechanical arm spins.
  BroBotAttack: [
    { name: "primary arm spin", target: "arm.front.0", channel: "rot", pivot: "auto", keys: [[0, 0], [0.05, 0], [0.65, 180], [0.95, -270], [1, 90]] },
    { name: "secondary arm spin", target: "arm.front.1", channel: "rot", pivot: "auto", keys: [[0, 0], [0.01, 0], [0.61, 140], [0.96, -275], [1, 0]] },
    { name: "primary arm stretch x", target: "arm.front.0", channel: "scaleX", keys: [[0, 1], [0.9, 1.2], [1, 1]] },
    { name: "primary arm stretch y", target: "arm.front.0", channel: "scaleY", keys: [[0, 1], [0.9, 1.2], [1, 1]] },
    { name: "back arm", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.9, 10], [1, -20]] },
    { name: "head jolt x", target: "head", channel: "x", keys: [[0, 0], [0.8, -8], [0.95, 5], [1, 0]] },
    { name: "head jolt y", target: "head", channel: "y", keys: [[0, 0], [0.8, -4], [0.95, 2], [1, 0]] },
  ],
  // Animation 15 — JunkBot's body recoil then the fast bite snap.
  JunkBotBite: [
    { name: "body recoil", target: "body", channel: "rot", keys: [[0, 0], [0.2, -20], [1, 0]] },
    { name: "bite", target: "head", channel: "rot", keys: [[0, 0], [0.2, 100], [0.3, 0], [1, 0]] },
  ],
  // Animation 22 — the unicycle bear's rapid corrections and flourish.
  UnicycleBearAttack: [
    { name: "body rock", target: "body", channel: "rot", keys: [[0, 0], [0.05, -10], [0.1, 10], [0.2, -15], [0.3, 15], [0.6, -10], [1, 0]] },
    { name: "legs counter-rock", target: "leg", channel: "rot", keys: [[0, 0], [0.05, 6], [0.1, -6], [0.2, 9], [0.3, -9], [0.6, 6], [1, 0]] },
    { name: "arm 1 flourish", target: "arm.0", channel: "rot", pivot: "auto", keys: [[0, 0], [0.05, -90], [0.1, 90], [0.2, -120], [0.3, 15], [0.55, -10], [1, 0]] },
    { name: "arm 2 flourish", target: "arm.1", channel: "rot", pivot: "auto", keys: [[0, 0], [0.05, 90], [0.1, -90], [0.2, 120], [0.3, -15], [0.55, 10], [1, 0]] },
    { name: "wheel correction", target: "wheel", channel: "rot", keys: [[0, 0], [0.2, -90], [0.3, 90], [0.65, -20], [1, 0]] },
    { name: "hop", target: "root", channel: "y", keys: sampled((t) => round(-5 * Math.sin(Math.PI * t)), 12) },
  ],
  // Animation 24 — the Ringmaster's staggered theatrical strike.
  RingMasterAttack: [
    { name: "front arm", target: "arm.front", channel: "rot", pivot: "auto", keys: [[0, 0], [0.1, 90], [0.5, 160], [0.75, 40], [1, 0]] },
    { name: "back arm", target: "arm.back", channel: "rot", pivot: "auto", keys: [[0, 0], [0.1, -90], [0.5, -160], [0.75, -40], [1, 0]] },
    { name: "body flourish", target: "body", channel: "rot", keys: [[0, 0], [0.4, -10], [0.75, -5.5], [1, 0]] },
    { name: "head strike x", target: "head", channel: "x", keys: [[0, 0], [0.5, 0], [0.75, -10], [1, 0]] },
    { name: "head strike y", target: "head", channel: "y", keys: [[0, 0], [0.5, 0], [0.75, 5], [1, 0]] },
    { name: "head flourish", target: "head", channel: "rot", keys: [[0, 0], [0.4, 10], [0.75, 5.5], [1, 0]] },
    { name: "step", target: "root", channel: "x", keys: [[0, 0], [0.5, 0], [0.75, -5], [1, 0]] },
    // The legs splay on the flourish, alternating by INDEX (not by front/back).
    { name: "leg 1 splay", target: "leg.0", channel: "rot", keys: [[0, 0], [0.4, -10], [0.75, -5.5], [1, 0]] },
    { name: "leg 2 splay", target: "leg.1", channel: "rot", keys: [[0, 0], [0.4, 10], [0.75, 5.5], [1, 0]] },
  ],
};
AUTHORED.CorporateBossPunchSpecial = AUTHORED.CorporateBossPunch;
// MidgetStackAttack is per-body-layer, so it is generated against the actual rig.
function midgetStackTracks(model) {
  const env = [[0, 0], [0.2, 1], [1, 0]];
  const bodies = (model.parts || []).filter((p) => (p.group || "body") === "body").length;
  const arms = (model.parts || []).filter((p) => p.group === "arm").length;
  const out = [];
  for (let i = 0; i < bodies; i++) {
    const dir = i % 2 === 0 ? 1 : -1, layer = i + 1;
    const lift = i === bodies - 1 ? 5 : 2;
    const sc = (v) => env.map((k) => [k[0], round(1 + v * k[1])]);
    out.push({ name: "body " + i + " shear x", target: "body." + i, channel: "x", keys: env.map((k) => [k[0], round(dir * layer * 1.5 * k[1])]) });
    out.push({ name: "body " + i + " lift", target: "body." + i, channel: "y", keys: env.map((k) => [k[0], round(-lift * k[1])]) });
    out.push({ name: "body " + i + " tilt", target: "body." + i, channel: "rot", keys: env.map((k) => [k[0], round(dir * (8 + layer) * k[1])]) });
    out.push({ name: "body " + i + " squash x", target: "body." + i, channel: "scaleX", keys: sc(0.025 * layer) });
    out.push({ name: "body " + i + " squash y", target: "body." + i, channel: "scaleY", keys: sc(-0.02 * layer) });
  }
  for (let i = 0; i < arms; i++) {
    const dir = i % 2 === 0 ? -1 : 1;
    out.push({ name: "arm " + i + " x", target: "arm." + i, channel: "x", keys: env.map((k) => [k[0], round(dir * 3 * k[1])]) });
    out.push({ name: "arm " + i + " y", target: "arm." + i, channel: "y", keys: env.map((k) => [k[0], round(-(i + 1) * k[1])]) });
    out.push({ name: "arm " + i + " rot", target: "arm." + i, channel: "rot", keys: env.map((k) => [k[0], round(dir * (10 + i * 3) * k[1])]) });
  }
  return out;
}

// ---- enemy clip set -----------------------------------------------------
function enemyClips(key, model, combat) {
  const hasLegs = (model.parts || []).some((p) => p.group === "leg");
  const hasWings = (model.parts || []).some((p) => p.group === "wing");
  const hasWheels = (model.parts || []).some((p) => p.group === "wheel");
  const hasHead = (model.parts || []).some((p) => p.group === "head") && !!model.neck;
  // A track aimed at a limb the rig does not have resolves to no parts and does
  // nothing. It used to be emitted anyway — the Zobra, which is two wings and a body,
  // opened with two tentacle-sway tracks that could never move anything, and reading a
  // timeline of tracks that do nothing is how you end up mistrusting the ones that do.
  const hasArms = (model.parts || []).some((p) => p.group === "arm");
  const isBoss = /Boss/i.test(key) || ((combat.bossActions || []).length > 0);
  const clips = {};

  // --- idle ---
  const idleTracks = [];
  if (hasHead) idleTracks.push({ name: "head rock", target: "head", channel: "rot", pivot: "neck", keys: tiltKeys(TILT_AMP_IDLE) });
  idleTracks.push({
    name: hasLegs ? "breathe" : "hover", target: "root", channel: "y",
    wave: { amp: hasLegs ? BOB_IDLE : BOB_HOVER, cycles: cyclesFor(BOB_FREQ, TILT_PERIOD_IDLE), phase: 0 },
  });
  if (!hasLegs && hasArms) {
    idleTracks.push({ name: "front tentacle sway", target: "arm.front", channel: "rot", pivot: "auto", wave: { amp: rad(ARM_SWAY_IDLE), cycles: cyclesFor(ARM_FREQ, TILT_PERIOD_IDLE), phase: 0 } });
    idleTracks.push({ name: "back tentacle sway", target: "arm.back", channel: "rot", pivot: "auto", wave: { amp: rad(ARM_SWAY_IDLE), cycles: cyclesFor(ARM_FREQ, TILT_PERIOD_IDLE), phase: 0.5 } });
  }
  if (hasWings) {
    idleTracks.push({ name: "front wing flap", target: "wing.front", channel: "rot", wave: { amp: rad(WING_FLAP), cycles: cyclesFor(WING_FREQ, TILT_PERIOD_IDLE), phase: 0 } });
    idleTracks.push({ name: "back wing flap", target: "wing.back", channel: "rot", wave: { amp: rad(WING_FLAP), cycles: cyclesFor(WING_FREQ, TILT_PERIOD_IDLE), phase: 0.5 } });
  }
  // A PUNCH rig's front arm hangs at its side whenever nothing else is posing it —
  // `frontAngle` reduces to the droop the moment there is no attack (EnemyActor's arm
  // loop takes the `this.punch || genericAttack` branch even at rest).
  if (model.punch && model.shoulder) {
    const droop = {
      name: "front arm at rest", target: "arm.front", channel: "rot", pivot: "shoulder",
      keys: [[0, rad(ARM_PUNCH_DROOP)], [1, rad(ARM_PUNCH_DROOP)]],
    };
    idleTracks.push(droop);
  }
  clips.idle = { duration: TILT_PERIOD_IDLE, loop: true, timeBase: "free", tracks: idleTracks };

  // --- move ---
  const moveTracks = [];
  if (hasHead) moveTracks.push({ name: "head rock", target: "head", channel: "rot", pivot: "neck", keys: tiltKeys(TILT_AMP_MOVE) });
  moveTracks.push({
    name: hasLegs ? "breathe" : "hover", target: "root", channel: "y",
    wave: { amp: hasLegs ? BOB_IDLE : BOB_HOVER, cycles: cyclesFor(BOB_FREQ, TILT_PERIOD_MOVE), phase: 0 },
  });
  if (hasLegs) {
    const cyc = cyclesFor(STEP_SPEED, TILT_PERIOD_MOVE);
    moveTracks.push({ name: "front leg stride", target: "leg.front", channel: "rot", wave: { amp: rad(STEP_ANGLE), cycles: cyc, phase: 0 } });
    moveTracks.push({ name: "back leg stride", target: "leg.back", channel: "rot", wave: { amp: rad(STEP_ANGLE), cycles: cyc, phase: 0.5 } });
    moveTracks.push({ name: "front leg lift", target: "leg.front", channel: "y", wave: { amp: -STEP_LIFT, cycles: cyc, phase: 0, clamp: "pos" } });
    moveTracks.push({ name: "back leg lift", target: "leg.back", channel: "y", wave: { amp: -STEP_LIFT, cycles: cyc, phase: 0.5, clamp: "pos" } });
  } else if (hasArms) {
    moveTracks.push({ name: "front tentacle sway", target: "arm.front", channel: "rot", pivot: "auto", wave: { amp: rad(ARM_SWAY_MOVE), cycles: cyclesFor(ARM_FREQ, TILT_PERIOD_MOVE), phase: 0 } });
    moveTracks.push({ name: "back tentacle sway", target: "arm.back", channel: "rot", pivot: "auto", wave: { amp: rad(ARM_SWAY_MOVE), cycles: cyclesFor(ARM_FREQ, TILT_PERIOD_MOVE), phase: 0.5 } });
  }
  if (hasWings) {
    moveTracks.push({ name: "front wing flap", target: "wing.front", channel: "rot", wave: { amp: rad(WING_FLAP), cycles: cyclesFor(WING_FREQ, TILT_PERIOD_MOVE), phase: 0 } });
    moveTracks.push({ name: "back wing flap", target: "wing.back", channel: "rot", wave: { amp: rad(WING_FLAP), cycles: cyclesFor(WING_FREQ, TILT_PERIOD_MOVE), phase: 0.5 } });
  }
  if (hasWheels) moveTracks.push({ name: "wheel roll", target: "wheel", channel: "rot", spin: { rate: -WHEEL_SPIN } });
  if (model.punch && model.shoulder) {
    moveTracks.push({
      name: "front arm at rest", target: "arm.front", channel: "rot", pivot: "shoulder",
      keys: [[0, rad(ARM_PUNCH_DROOP)], [1, rad(ARM_PUNCH_DROOP)]],
    });
  }
  clips.move = { duration: TILT_PERIOD_MOVE, loop: true, timeBase: "free", tracks: moveTracks };

  // --- attack(s): one clip per named attack the rig actually swings ---
  const rows = (combat.attacks || []).length
    ? combat.attacks
    : [{ name: "", damageTiming: 0.5, frequency: 100 }];
  const cycleSec = round(1 / Math.max(0.2, combat.dex || 1));
  rows.forEach((row, i) => {
    const authored = AUTHORED[row.name] || (row.name === "MidgetStackAttack" ? midgetStackTracks(model) : null);
    const name = rows.length > 1 ? "attack:" + (row.name || i) : "attack";
    const under = persistentTracks(model, hasHead, hasLegs, row.name);
    if (authored) {
      clips[name] = {
        duration: cycleSec, loop: true, timeBase: "source",
        damageTiming: row.damageTiming, attackName: row.name, authored: true,
        note: "Authored ZFAttackAnims timeline (animID " + (row.animID == null ? "?" : row.animID)
          + "), over the bob and head rock the engine never stops.",
        tracks: under.concat(clone(authored)),
      };
    } else {
      clips[name] = {
        duration: cycleSec, loop: true, timeBase: "cycle",
        damageTiming: row.damageTiming, attackName: row.name,
        note: "Generic procedural swing — the rig has no authored timeline.",
        tracks: under.concat(genericTracks(model, key, row.damageTiming, (u) => REST_FRAC + SWING_FRAC * u, 1)),
      };
    }
  });

  // --- boss throw + boss ability ---
  // RaidScene maps the perched boss's 0..1 wind-up straight onto the swing
  // window, so both reuse the generic envelope on their own clock.
  if (isBoss) {
    // RaidScene feeds the renderer `atkProg = REST_FRAC + SWING_FRAC x swing`, so the
    // clip's own 0..1 IS the engine's swing parameter u. `simProgress` records that
    // mapping so the hit marker — and src/rigClips.test.ts — can follow it back.
    clips.throw = {
      duration: THROW_WINDOW_S, loop: true, timeBase: "windup",
      damageTiming: THROW_DAMAGE_TIMING,
      simProgress: { rest: REST_FRAC, span: SWING_FRAC, uSpan: 1 },
      note: "Perched boss throw: the arm cocks and swings, releasing the projectile at the hit mark.",
      tracks: persistentTracks(model, hasHead, hasLegs, "")
        .concat(genericTracks(model, key, THROW_DAMAGE_TIMING, (u) => u, 1)),
    };
    if ((combat.bossActions || []).length) {
      clips.ability = {
        duration: WALL_CAST_S, loop: true, timeBase: "windup",
        damageTiming: WALL_DAMAGE_TIMING,
        simProgress: { rest: REST_FRAC, span: 0.64, uSpan: WALL_SPAN },
        note: "Boss special (wall summon): a slow raise/hold across the authored cast time.",
        tracks: persistentTracks(model, hasHead, hasLegs, "")
          .concat(genericTracks(model, key, WALL_DAMAGE_TIMING, (u) => u / WALL_SPAN, WALL_SPAN)),
      };
    }
  }
  return clips;
}

// ---- zombie clip set ----------------------------------------------------
/** The zombie rig's own persistent layer: the head rock, and nothing else — RaidActor
 *  never moves its root, so there is no whole-body bob to carry. */
function zombiePersistent() {
  return [{
    // `head.all`, not `head`: RaidActor rocks every part it hangs off the neck, which
    // is the eyes and the jaw as well as the skull.
    name: "head rock (free-running)", target: "head.all", channel: "rot", pivot: "neck",
    keys: tiltKeys(Z_TILT_AMP_IDLE), free: { period: 4.0 },
  }];
}

function zombieClips(key, model) {
  // Tracks whose group is absent from this rig (a headless zombie has no jaw)
  // resolve to no parts and simply do nothing, so every rig gets the full set.
  const clips = {};

  clips.idle = {
    duration: 4.0, loop: true, timeBase: "free",
    note: "Waiting in the back group: arms hang at the sides.",
    tracks: [
      { name: "head rock", target: "head.all", channel: "rot", pivot: "neck", keys: tiltKeys(Z_TILT_AMP_IDLE) },
      { name: "arms at rest", target: "arm", channel: "rot", pivot: "auto", keys: [[0, rad(ARM_REST)], [1, rad(ARM_REST)]] },
    ],
  };

  const cyc = cyclesFor(STEP_SPEED, 2.0);
  clips.move = {
    duration: 2.0, loop: true, timeBase: "free",
    note: "Advancing: arms straight out in front with a faint alternating sway.",
    tracks: [
      { name: "head rock", target: "head.all", channel: "rot", pivot: "neck", keys: tiltKeys(Z_TILT_AMP_MOVE) },
      { name: "front foot step", target: "footF", channel: "rot", wave: { amp: rad(Z_STEP_ANGLE), cycles: cyc, phase: 0 } },
      { name: "back foot step", target: "footB", channel: "rot", wave: { amp: rad(Z_STEP_ANGLE), cycles: cyc, phase: 0.5 } },
      { name: "front foot lift", target: "footF", channel: "y", wave: { amp: -Z_STEP_LIFT, cycles: cyc, phase: 0, clamp: "pos" } },
      { name: "back foot lift", target: "footB", channel: "y", wave: { amp: -Z_STEP_LIFT, cycles: cyc, phase: 0.5, clamp: "pos" } },
      { name: "arms forward", target: "arm", channel: "rot", pivot: "auto", keys: [[0, rad(ARM_FWD)], [1, rad(ARM_FWD)]] },
      { name: "back arm sway", target: "arm.back", channel: "rot", pivot: "auto", wave: { amp: rad(ARM_WALK_SWAY), cycles: cyc, phase: 0 } },
      { name: "front arm sway", target: "arm.front", channel: "rot", pivot: "auto", wave: { amp: -rad(ARM_WALK_SWAY), cycles: cyc, phase: 0 } },
    ],
  };

  // ZombieBite — anim 8. Head, jaw, eyes and both arms, on the source timeline.
  clips["attack:bite"] = {
    duration: 1.0, loop: true, timeBase: "source", damageTiming: BITE_DAMAGE_TIMING,
    authored: true, attackName: "ZombieBite",
    note: "Authored ZFAnims bite, over the head rock the engine never stops: headBite 0.13/0.25/0.62, jawBite, eyeBiteSquint, armBite.",
    tracks: zombiePersistent().concat([
      { name: "head lunge x", target: "head.all", channel: "x", keys: [[0, 0], [0.13, BITE_HEAD_X], [0.38, BITE_HEAD_X], [1, 0]] },
      { name: "head lunge y", target: "head.all", channel: "y", keys: [[0, 0], [0.13, BITE_HEAD_Y], [0.38, BITE_HEAD_Y], [1, 0]] },
      { name: "jaw open x", target: "jaw", channel: "x", keys: [[0, 0], [0.37, BITE_JAW_X], [0.43, 0], [1, 0]] },
      { name: "jaw open y", target: "jaw", channel: "y", keys: [[0, 0], [0.37, BITE_JAW_Y], [0.43, 0], [1, 0]] },
      { name: "eye squint", target: "eye", channel: "scaleY", keys: [[0, 1], [0.12, 0.75], [0.43, 0.75], [0.49, 1], [1, 1]] },
      { name: "arms", target: "arm", channel: "rot", pivot: "auto", keys: [[0, 0], [0.12, round(BITE_ARM_ANGLE * 0.75)], [0.18, BITE_ARM_ANGLE], [0.36, BITE_ARM_ANGLE], [0.79, 0], [1, 0]] },
    ]),
  };

  // ZombieScratch — anim 9. Its head thrust and claw are half-sines about the hit.
  const halfSine = sampled((t) => round(Math.sin(Math.PI * t)), 12);
  const scaleKeys = (k, m) => k.map((p) => [p[0], round(p[1] * m)]);
  clips["attack:scratch"] = {
    duration: 1.0, loop: true, timeBase: "source", damageTiming: SCRATCH_DAMAGE_TIMING,
    authored: true, attackName: "ZombieScratch",
    note: "Authored ZFAnims scratch, over the head rock the engine never stops: headFlail + eyeFlailSquint + the asymmetric claw pair.",
    tracks: zombiePersistent().concat([
      { name: "head thrust x", target: "head.all", channel: "x", keys: scaleKeys(halfSine, SCRATCH_HEAD_X) },
      { name: "head thrust y", target: "head.all", channel: "y", keys: scaleKeys(halfSine, SCRATCH_HEAD_Y) },
      { name: "eye squint", target: "eye", channel: "scaleY", keys: [[0, 1], [0.125, 0.75], [0.625, 0.75], [0.75, 1], [1, 1]] },
      { name: "claw (back arm)", target: "arm.back", channel: "rot", pivot: "auto", keys: scaleKeys(halfSine, rad(0.92)) },
      { name: "counter (front arm)", target: "arm.front", channel: "rot", pivot: "auto", keys: scaleKeys(halfSine, rad(-0.42)) },
    ]),
  };

  // Garden heal cast — RaidScene's HEAL_POSE_S arms-overhead pose.
  clips["ability:heal"] = {
    duration: HEAL_POSE_S, loop: true, timeBase: "free",
    note: "Garden heal cast: both arms sweep from rest to overhead, hold, then lower.",
    tracks: [{
      name: "arms overhead", target: "arm", channel: "rot",
      keys: [[0, rad(ARM_REST)], [round(0.14 / HEAL_POSE_S), rad(HEAL_OVERHEAD)],
             [round((HEAL_POSE_S - 0.16) / HEAL_POSE_S), rad(HEAL_OVERHEAD)], [1, rad(ARM_REST)]],
    }],
  };

  // Smash (bash / bashV2): the rig GROWS as the arms raise, then slams and shrinks.
  const windup = 1.0, total = windup + SMASH_SLAM_S;
  const rel = round(windup / total);
  clips["ability:smash"] = {
    duration: round(total), loop: true, timeBase: "free",
    note: "Bash family: grow to 1+SMASH_GROW while the arms raise, then a rapid slam+shrink (feet-anchored in game).",
    tracks: [
      { name: "arms raise", target: "arm", channel: "rot", pivot: "auto", keys: [[0, 0], [rel, rad(RAISE_ANGLE)], [1, 0]] },
      { name: "grow x", target: "root", channel: "scaleX", keys: [[0, 1], [rel, 1 + SMASH_GROW], [1, 1]] },
      { name: "grow y", target: "root", channel: "scaleY", keys: [[0, 1], [rel, 1 + SMASH_GROW], [1, 1]] },
    ],
  };

  // Explode / Mini Buddy keep the plain overhead raise (no grow).
  clips["ability:windup"] = {
    duration: 1.0, loop: true, timeBase: "free",
    note: "Explode / Mini Buddy wind-up: the plain arms-overhead raise, no grow.",
    tracks: [{ name: "arms raise", target: "arm", channel: "rot", pivot: "auto", keys: [[0, 0], [0.85, rad(RAISE_ANGLE)], [1, rad(RAISE_ANGLE)]] }],
  };

  return clips;
}

/** Every clip the game gives this rig today. */
export function defaults(kind, key, model, combat) {
if (!model) return {};
if (kind === "zombie") return zombieClips(key, model);
return enemyClips(key, model, combat || {});
}


export const CHANNELS = ["rot", "x", "y", "scaleX", "scaleY"];
export const EASES = ["smooth", "linear", "step"];
export { AUTHORED };
