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
    for (const name of Object.keys(kept)) {
      const why = variantProblem(kept, name);
      if (why) {
        console.warn(`[clips] ${key}/${name}: dropped — ${why}`);
        delete kept[name];
      }
    }
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

// ---- cosmetic variants ----------------------------------------------------
// A swing can have alternates: `attack:Foo~2`, `attack:Foo~3`, ... (likewise `attack~2`,
// `throw~2`) sit beside the clip they vary, and the actor rolls one of them per swing so a
// crowd of the same minion does not move in lockstep. The SIM still swings one attack —
// which alternate draws it is pure presentation.
//
// The roll happens where the clip's own timeline wraps, so every alternate has to agree
// with its base on what that timeline IS: same timeBase, same damageTiming, same
// windup mapping. Otherwise the hit frame moves between variants, and the wrap the actor
// re-rolls on is not the wrap the next variant starts from.
const VARIANT_SEP = "~";

/** "attack:Foo~2" -> "attack:Foo"; a name with no suffix is its own base. */
export function variantBase(name: string): string {
  const i = name.lastIndexOf(VARIANT_SEP);
  return i > 0 && /^\d+$/.test(name.slice(i + 1)) ? name.slice(0, i) : name;
}

/** Why a variant clip cannot run beside its base, or "" when it can (or is no variant). */
export function variantProblem(set: Record<string, Clip>, name: string): string {
  const baseName = variantBase(name);
  if (baseName === name) return "";
  const base = set[baseName];
  if (!base) return `variant of "${baseName}", which this rig has no clip for`;
  const clip = set[name];
  if ((clip.timeBase || "free") !== (base.timeBase || "free")) {
    return `timeBase "${clip.timeBase}" differs from its base's "${base.timeBase}"`;
  }
  if ((clip.damageTiming ?? null) !== (base.damageTiming ?? null)) {
    return `damageTiming ${clip.damageTiming} differs from its base's ${base.damageTiming}`;
  }
  if (JSON.stringify(clip.simProgress ?? null) !== JSON.stringify(base.simProgress ?? null)) {
    return "simProgress differs from its base's";
  }
  return "";
}

/** The base clip or one of its `~n` alternates, chosen by `roll` in [0, 1). */
function pickVariant(forKey: Record<string, Clip>, name: string, base: Clip, roll: number): Clip {
  let n = 1;
  while (forKey[name + VARIANT_SEP + (n + 1)]) n++;
  if (n === 1) return base;
  const i = Math.min(n - 1, Math.max(0, Math.floor(roll * n)));
  return i === 0 ? base : forKey[name + VARIANT_SEP + (i + 1)];
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

/** The clip name a frame resolves to (before any variant roll), or null for none. */
function resolveClipName(
  kind: RigKind, key: string, moving: boolean, attackName: string | undefined,
  attacking: boolean, explicit?: string,
): string | null {
  const name = clipNameFor(moving, attackName, attacking, explicit);
  if (rigClipFor(kind, key, name)) return name;
  if (attacking && attackName && rigClipFor(kind, key, "attack")) return "attack";
  return null;
}

/**
 * Where on its own 0..1 timeline the attack clip for this swing is, or null when no
 * authored clip covers it. Every variant shares its base's timeline (see
 * `variantProblem`), so this is the phase whichever variant is drawing — the actor
 * watches it wrap to know when one swing has ended and the next may roll a new variant.
 */
export function attackClipPhase(
  kind: RigKind, key: string, attackName: string | undefined, atkProg: number,
  wallT: number, explicit?: string,
): number | null {
  if (!hasRigClips(kind, key)) return null;
  const name = resolveClipName(kind, key, false, attackName, true, explicit);
  const clip = name ? rigClipFor(kind, key, name) : null;
  return clip ? clipTimeFor(clip, wallT, atkProg) : null;
}

/**
 * Resolve and evaluate the clip for one actor frame, or null to run the procedural pose.
 * A named attack clip falls back to the un-suffixed "attack" the studio writes when a rig
 * has only one, so a rig with a single swing can be edited under either name.
 *
 * `variantRoll` in [0, 1) picks among the clip's `~n` alternates; 0 is always the base.
 */
export function poseForFrame(
  kind: RigKind, key: string, model: ClipModel,
  moving: boolean, attackName: string | undefined, atkProg: number | null,
  wallT: number, explicit?: string, variantRoll = 0,
): ClipPose | null {
  if (!hasRigClips(kind, key)) return null;
  const attacking = atkProg != null;
  const name = resolveClipName(kind, key, moving, attackName, attacking, explicit);
  const base = name ? rigClipFor(kind, key, name) : null;
  if (!name || !base) return null;
  const clip = attacking ? pickVariant(SETS[kind][key], name, base, variantRoll) : base;
  return poseAt(kind, model, clip, clipTimeFor(clip, wallT, atkProg), wallT);
}
