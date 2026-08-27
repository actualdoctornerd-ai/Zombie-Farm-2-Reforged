// Authored animation clips, at runtime.
//
// A rig's motion is procedural: EnemyActor and RaidActor compute the bob, the head rock,
// the leg step and the attack swing in code. The Rig Studio (tools/rig_studio.html) can
// TRANSCRIBE that into the clip schema, show it on a timeline, and let it be edited — but
// an edited clip needs somewhere to land, and until now there was nowhere: the export was
// the deliverable and applying it meant hand-porting keyframes back into the actors.
//
// This is that landing place. If a clip has been authored for the rig an actor is
// drawing, the actor poses itself from the clip instead of computing the pose; if none
// has, nothing changes at all — it runs exactly the code it always ran. That fallback is
// the whole safety argument: only rigs someone deliberately edited take the new path, and
// src/rigClips.test.ts already proves the evaluator reproduces the procedural pose for
// every shipped rig and clip, so an un-edited rig could not diverge even if it did.
//
// Clips are cosmetic. BattleSim does not import the actors — it decides hits, damage and
// timing on its own clock and the actors only draw the result — so an edited animation
// cannot change the outcome of a fight, and none of this is a ruleset concern.
import { poseAt, REST_FRAC, SWING_FRAC } from "./rigClips.js";
import type { Clip, ClipModel, ClipPose, RigKind } from "./rigClips.js";

export type { Clip, ClipPose };

/** clips[modelKey][clipName] — the shape the studio's ⬇ button downloads. */
export type ClipSet = Record<string, Record<string, Clip>>;

const SETS: Record<RigKind, ClipSet> = { enemy: {}, zombie: {} };

/**
 * Install the authored clips for one rig dataset (see src/assets.ts).
 *
 * The file is hand-authored, so it is treated as untrusted: a track carrying a
 * non-finite keyframe evaluates to NaN, and a NaN position does not look like a bad
 * animation — the part disappears. Drop those tracks rather than letting one typo take a
 * limb off. src/clipData.test.ts catches the same thing at build time and names it;
 * this is the seatbelt for a file that never went through the test.
 */
export function setRigClips(kind: RigKind, clips: ClipSet | null | undefined) {
  SETS[kind] = clips && typeof clips === "object" ? sanitise(clips) : {};
}

function finiteKeys(track: Clip["tracks"][number]): boolean {
  if (track.wave && !Number.isFinite(track.wave.amp)) return false;
  if (track.spin && !Number.isFinite(track.spin.rate)) return false;
  if (!track.keys) return true;
  return track.keys.every(
    (k) => Array.isArray(k) && k.length === 2 && Number.isFinite(k[0]) && Number.isFinite(k[1]),
  );
}

function sanitise(clips: ClipSet): ClipSet {
  const out: ClipSet = {};
  for (const [key, set] of Object.entries(clips)) {
    if (!set || typeof set !== "object") continue;
    const kept: Record<string, Clip> = {};
    for (const [name, clip] of Object.entries(set)) {
      if (!clip || !Array.isArray(clip.tracks) || !(clip.duration > 0)) continue;
      const tracks = clip.tracks.filter(finiteKeys);
      if (tracks.length !== clip.tracks.length) {
        console.warn(
          `[clips] ${key}/${name}: dropped ${clip.tracks.length - tracks.length} track(s) `
          + "with a non-finite keyframe",
        );
      }
      kept[name] = tracks.length === clip.tracks.length ? clip : { ...clip, tracks };
    }
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

/** Has anything been authored for this rig at all? Cheap enough to ask every frame,
 *  and it keeps the per-frame clip lookup off rigs nobody has edited. */
export function hasRigClips(kind: RigKind, key: string): boolean {
  return !!key && !!SETS[kind][key];
}

/** The authored clip for one rig state, or null to keep the procedural path. */
export function rigClipFor(kind: RigKind, key: string, name: string): Clip | null {
  const forKey = SETS[kind][key];
  const clip = forKey && forKey[name];
  return clip && Array.isArray(clip.tracks) ? clip : null;
}

/**
 * The engine's cooldown→source-time rotation, so an authored timeline's contact frame
 * coincides with the sim's hit (EnemyActor.sourceAttackProgress).
 */
export function sourceAttackProgress(atkProg: number, damageTiming: number): number {
  const recovery = 1 - damageTiming;
  return atkProg <= recovery ? damageTiming + atkProg : atkProg - recovery;
}

/**
 * Where on a clip's own 0..1 timeline the actor currently is.
 *
 * `wallT` is the actor's free-running clock in seconds; `atkProg` is the sim's attack
 * cooldown position, or null when the rig is not swinging at anything.
 */
export function clipTimeFor(clip: Clip, wallT: number, atkProg: number | null): number {
  const base = clip.timeBase || "free";
  if (base === "free" || atkProg == null) {
    const d = clip.duration || 1;
    return ((wallT % d) + d) % d / d;
  }
  if (base === "source") return sourceAttackProgress(atkProg, clip.damageTiming ?? 0.5);
  if (base === "windup") {
    // A wind-up clip's own 0..1 IS the engine's swing parameter: RaidScene feeds the
    // perched boss `atkProg = rest + span * u`, so undo exactly that.
    const sp = clip.simProgress || { rest: REST_FRAC, span: SWING_FRAC, uSpan: 1 };
    const span = sp.span || 1;
    return Math.max(0, Math.min(1, (atkProg - sp.rest) / span));
  }
  return atkProg; // "cycle" clips ARE the cooldown
}

/** Which clip a rig's current state asks for. `explicit` lets a caller name one outright
 *  (a perched boss's "throw" / "ability"), which the actors cannot infer for themselves. */
export function clipNameFor(
  moving: boolean, attackName: string | undefined, attacking: boolean, explicit?: string,
): string {
  if (explicit) return explicit;
  if (attacking) return attackName ? "attack:" + attackName : "attack";
  return moving ? "move" : "idle";
}

/**
 * Which timeline the attack pose for this rig runs on, or null when no clip covers it
 * and the actor will pose itself procedurally. Resolved exactly the way `poseForFrame`
 * resolves it, including the fall back from a named clip to the plain "attack" one, so
 * the answer is the clip the frame will actually draw.
 *
 * The renderer needs this before it computes progress: only a `"source"` timeline has a
 * post-contact tail to suppress (see raid/attackPhase.ts `postContactTail`).
 */
export function attackClipTimeBase(
  kind: RigKind, key: string, attackName: string | undefined, explicit?: string,
): Clip["timeBase"] | null {
  if (!hasRigClips(kind, key)) return null;
  let clip = rigClipFor(kind, key, clipNameFor(false, attackName, true, explicit));
  if (!clip && attackName) clip = rigClipFor(kind, key, "attack");
  return clip ? (clip.timeBase || "free") : null;
}

/**
 * Resolve and evaluate the clip for one actor frame, or null to run the procedural pose.
 * A named attack clip falls back to the un-suffixed "attack" the studio writes when a rig
 * has only one, so a rig with a single swing can be edited under either name.
 */
export function poseForFrame(
  kind: RigKind, key: string, model: ClipModel,
  moving: boolean, attackName: string | undefined, atkProg: number | null,
  wallT: number, explicit?: string,
): ClipPose | null {
  if (!hasRigClips(kind, key)) return null;
  const attacking = atkProg != null;
  let clip = rigClipFor(kind, key, clipNameFor(moving, attackName, attacking, explicit));
  if (!clip && attacking && attackName) clip = rigClipFor(kind, key, "attack");
  if (!clip) return null;
  return poseAt(kind, model, clip, clipTimeFor(clip, wallT, atkProg), wallT);
}
