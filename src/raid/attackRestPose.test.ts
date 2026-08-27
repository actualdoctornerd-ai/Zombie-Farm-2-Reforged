// Where a rig STANDS between blows, checked against every shipped attack animation.
//
// The renderer holds a swing that has not struck yet at the far end of its post-contact
// tail (raid/attackPhase.ts) rather than drawing the follow-through of a blow that never
// landed. That only works if the far end of the tail really is the rig's rest pose, and
// two whole families of animation did not honour it:
//
//   * A `timeBase: "source"` clip runs `damageTiming -> 1`, then `0 -> damageTiming`, so
//     clip time 1 and clip time 0 are ONE INSTANT. Six of the eleven shipped source
//     clips ended that loop somewhere other than where they started it — the Ninja
//     Girl's arm reached its full +90 stab at clip time 1 and snapped back to 0 a frame
//     later, the Swashbuckler's slammed arm teleported 135 degrees, BroBot's windmill a
//     quarter turn. Every one of those poses was ALSO what the renderer parked on.
//
//   * A pose driven by the cooldown WINDOW has no tail to park in at all: the GENERIC
//     `EnemyActor` swing rests over the first 28% of the cycle and swings across the
//     rest, and a `timeBase: "cycle"` clip's t IS the cooldown. Holding one of those at
//     `1 - damageTiming` parks it MID-LUNGE — for Old McDonnell, 98% of the way through
//     his thrust, frozen there until his first blow landed.
//
// Which of the two a rig gets is NOT "does it have a clip": EnemyActor also carries a
// dozen hand-transcribed family poses (poseCrazedWorker, poseMidgetStack, ...) that open
// with `sourceAttackProgress` and so DO have a tail. Getting that wrong the other way
// parks the Circus midget stack at full extension. So the rule is asserted here against
// the real shipped data rather than restated by hand at the call site.
//
// So this asserts the contract itself, over the real shipped data, using the runtime's
// own evaluator: a source clip closes its loop, and nothing else is ever held.
// @ts-ignore - node types are test-environment only, as in rigClips.test.ts
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { poseAt } from "./rigClips.js";
import type { Clip, ClipModel } from "./rigClips.js";
import { attackClipTimeBase, setRigClips, sourceAttackProgress } from "./clipRuntime";
import { enemyProceduralPoseIsSourceRotated } from "./EnemyActor";
import { newAttackPhase, observeAttackTimer, attackProgress, postContactTail } from "./attackPhase";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const MODELS: Record<string, ClipModel> = read("../../public/assets/raids/enemies/models.json");
const CLIPS: Record<string, Record<string, Clip>> = read("../../public/assets/raids/enemies/clips.json");
const STATS: Record<string, { attacks?: { name: string }[] }> =
  read("../../public/assets/raids/enemy_stats.json");
const ATTACKS: Record<string, { damageTiming?: number }> =
  read("../../public/assets/raids/attacks.json");

/** The engine's own rest/swing split for a procedurally posed enemy (EnemyActor). */
const REST_FRAC = 0.28;

/** Every (rig, attack) pair the game can actually field, with its authored contact. */
function attackPairs(): { key: string; attack: string; damageTiming: number }[] {
  const out: { key: string; attack: string; damageTiming: number }[] = [];
  for (const key of Object.keys(MODELS)) {
    for (const a of STATS[key]?.attacks ?? []) {
      const dt = ATTACKS[a.name]?.damageTiming;
      if (typeof dt === "number") out.push({ key, attack: a.name, damageTiming: dt });
    }
  }
  return out;
}

/** Flatten a clip pose to comparable numbers, so two evaluations can be equated. */
function poseNumbers(model: ClipModel, clip: Clip, t: number, wallT: number): number[] {
  const pose = poseAt("enemy", model, clip, t, wallT);
  const out = [pose.root.dx, pose.root.dy, pose.root.rot, pose.root.sx, pose.root.sy];
  for (let i = 0; i < (model.parts?.length ?? 0); i++) {
    const d = pose.parts[i];
    out.push(d?.dx ?? 0, d?.dy ?? 0, d?.rot ?? 0, d?.sx ?? 1, d?.sy ?? 1);
  }
  return out;
}

/** The renderer's rule, in one place: an authored clip says which timeline it runs on;
 *  with no clip it depends on which procedural pose the rig falls to. */
function sourceRotated(key: string, attack: string): boolean {
  const base = attackClipTimeBase("enemy", key, attack);
  return base === null ? enemyProceduralPoseIsSourceRotated(attack) : base === "source";
}

describe("a swing between blows stands at rest", () => {
  beforeAll(() => setRigClips("enemy", CLIPS));

  it("covers every rig the raids field", () => {
    const pairs = attackPairs();
    expect(pairs.length).toBeGreaterThan(25);
    // ...and at least some of them really are clip-driven, or this proves nothing.
    expect(pairs.filter((p) => attackClipTimeBase("enemy", p.key, p.attack) === "source").length)
      .toBeGreaterThan(5);
  });

  it("closes the loop on every source-timeline clip", () => {
    // Clip time 1 and clip time 0 are the same instant on a source timeline: the frame
    // the blow lands and the frame after it. A track that holds different values there
    // teleports the part it drives, once per attack, forever.
    const broken: string[] = [];
    for (const { key, attack } of attackPairs()) {
      if (attackClipTimeBase("enemy", key, attack) !== "source") continue;
      const clip = CLIPS[key]["attack:" + attack] ?? CLIPS[key].attack;
      // A fixed wall clock so the free-running bob and head rock — which are NOT on the
      // clip's timeline and are meant to keep going — contribute equally to both.
      const WALL = 1.234;
      const end = poseNumbers(MODELS[key], clip, 1, WALL);
      const start = poseNumbers(MODELS[key], clip, 0, WALL);
      for (let i = 0; i < end.length; i++) {
        if (Math.abs(end[i] - start[i]) > 1e-6) {
          broken.push(`${key}/${attack}: clip time 1 and 0 differ (channel ${i})`);
          break;
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("parks a source-clip rig exactly on that closed loop", () => {
    // What the renderer actually draws for a rig that has engaged but not yet struck.
    for (const { key, attack, damageTiming } of attackPairs()) {
      if (attackClipTimeBase("enemy", key, attack) !== "source") continue;
      const CYCLE = 2500;
      const phase = newAttackPhase(CYCLE);
      observeAttackTimer(phase, CYCLE, true); // engaged, full timer, nothing struck
      const prog = attackProgress(phase, CYCLE, postContactTail(damageTiming, true));
      // Contact is at clip time `damageTiming`; the park has to be the OTHER end.
      expect(sourceAttackProgress(prog, damageTiming), `${key}/${attack}`).toBeCloseTo(1, 6);
    }
  });

  it("never holds a cooldown-window pose anywhere", () => {
    // The GENERIC EnemyActor swing and a `timeBase: "cycle"` clip both rest at the START
    // of the cycle, so there is nothing to suppress. Holding them at `1 - damageTiming`
    // is what froze McDonnell mid-thrust.
    const held: string[] = [];
    for (const { key, attack, damageTiming } of attackPairs()) {
      if (sourceRotated(key, attack)) continue;
      const tail = postContactTail(damageTiming, false);
      if (tail !== 0) { held.push(`${key}/${attack}: tail ${tail}`); continue; }
      const CYCLE = 2500;
      const phase = newAttackPhase(CYCLE);
      observeAttackTimer(phase, CYCLE, true);
      const prog = attackProgress(phase, CYCLE, tail);
      // A full timer reads as the top of the cycle, which is inside the engine's rest
      // window — the rig stands still instead of holding a lunge.
      if (prog > REST_FRAC) held.push(`${key}/${attack}: parks at ${prog.toFixed(2)}`);
    }
    expect(held).toEqual([]);
  });

  it("gives a hand-transcribed family pose the tail it really has", () => {
    // The other way round from McDonnell, and just as wrong: these open with
    // `sourceAttackProgress`, so progress 0 is their CONTACT pose. Denying them the tail
    // parks the Circus midget stack at full extension instead of at rest — its envelope
    // peaks at 0.2, which is exactly where a denied tail would leave it.
    const KEY = "CircusStageActorMinion2";
    const attack = STATS[KEY].attacks![0].name;
    expect(attackClipTimeBase("enemy", KEY, attack)).toBeNull(); // no clip: procedural
    expect(enemyProceduralPoseIsSourceRotated(attack)).toBe(true);
    const dt = ATTACKS[attack].damageTiming!;
    const CYCLE = 2500;
    const phase = newAttackPhase(CYCLE);
    observeAttackTimer(phase, CYCLE, true);
    const parked = sourceAttackProgress(
      attackProgress(phase, CYCLE, postContactTail(dt, true)), dt
    );
    expect(parked).toBeCloseTo(1, 6); // poseMidgetStack's envelope is 0 there — rest
    // ...where a denied tail would have put it on the peak.
    expect(sourceAttackProgress(attackProgress(phase, CYCLE, 0), dt)).toBeCloseTo(dt, 6);
  });

  it("puts McDonnell's thrust at rest, not at 98% of it", () => {
    // The regression this rule exists for, named and pinned: the Farm boss has no
    // authored clip and connects at 0.4, so the tail a source-rotated pose would use is
    // 0.6 — which lands almost exactly on the peak of his procedural lunge.
    const KEY = "FarmStageActorBoss";
    const dt = ATTACKS[STATS[KEY].attacks![0].name].damageTiming!;
    expect(attackClipTimeBase("enemy", KEY, STATS[KEY].attacks![0].name)).toBeNull();
    expect(dt).toBe(0.4);
    expect(postContactTail(dt, false)).toBe(0);
    expect(postContactTail(dt, true)).toBeCloseTo(0.6, 6); // what it WOULD have been
  });
});
