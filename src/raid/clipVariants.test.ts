// Cosmetic attack variants (`attack:Foo~2`, ...): the actor rolls one per swing.
import { afterEach, describe, expect, it } from "vitest";
import type { Clip, ClipModel } from "./rigClips.js";
import { attackClipPhase, poseForFrame, setRigClips, variantBase } from "./clipRuntime";

const MODEL: ClipModel = {
  parts: [{ rx: 0, ry: 0, rw: 10, rh: 10, px: 0, py: 0, ax: 0, ay: 0, z: 0, rot: 0, group: "body", back: false }],
} as unknown as ClipModel;

/** A source clip whose root x at mid-swing is `dx`, so the drawn variant is readable. */
const clip = (dx: number, over: Partial<Clip> = {}): Clip => ({
  duration: 1, loop: true, timeBase: "source", damageTiming: 0.5,
  tracks: [{ name: "x", target: "root", channel: "x", keys: [[0, 0], [0.5, dx], [1, 0]] }],
  ...over,
} as Clip);

/** Root x drawn at the contact frame (atkProg 0 = source time damageTiming). */
const drawn = (roll: number, attackName = "Foo") =>
  poseForFrame("enemy", "Rig", MODEL, false, attackName, 0, 0, undefined, roll)?.root.dx;

afterEach(() => setRigClips("enemy", null));

describe("attack variants", () => {
  it("parses the ~n suffix and nothing else", () => {
    expect(variantBase("attack:Foo~2")).toBe("attack:Foo");
    expect(variantBase("attack~3")).toBe("attack");
    expect(variantBase("attack:Foo")).toBe("attack:Foo");
    expect(variantBase("attack:A~b")).toBe("attack:A~b");
  });

  it("splits the roll evenly across the base and its alternates", () => {
    setRigClips("enemy", { Rig: { "attack:Foo": clip(-1), "attack:Foo~2": clip(-2), "attack:Foo~3": clip(-3) } });
    expect(drawn(0)).toBe(-1);
    expect(drawn(0.34)).toBe(-2);
    expect(drawn(0.99)).toBe(-3);
  });

  it("varies the plain `attack` fallback the same way", () => {
    setRigClips("enemy", { Rig: { attack: clip(-1), "attack~2": clip(-2) } });
    expect(drawn(0.1)).toBe(-1);
    expect(drawn(0.9)).toBe(-2);
  });

  it("drops an alternate whose hit or timeline differs from its base", () => {
    setRigClips("enemy", {
      Rig: {
        "attack:Foo": clip(-1),
        "attack:Foo~2": clip(-2, { damageTiming: 0.7 }),
        "attack:Bar": clip(-5),
        "attack:Bar~2": clip(-6, { timeBase: "cycle" }),
        "attack:Baz~2": clip(-9), // no base at all
      },
    });
    expect(drawn(0.9, "Foo")).toBe(-1);
    expect(drawn(0.9, "Bar")).toBe(-5);
    expect(drawn(0.9, "Baz")).toBeUndefined();
  });

  it("does not vary idle or move", () => {
    setRigClips("enemy", { Rig: { idle: clip(-1, { timeBase: "free" }), "idle~2": clip(-2, { timeBase: "free" }) } });
    const dx = poseForFrame("enemy", "Rig", MODEL, false, undefined, null, 0.5, undefined, 0.99)?.root.dx;
    expect(dx).toBe(-1);
  });

  it("reports the shared phase, which wraps once per swing", () => {
    setRigClips("enemy", { Rig: { "attack:Foo": clip(-1), "attack:Foo~2": clip(-2) } });
    expect(attackClipPhase("enemy", "Rig", "Foo", 0, 0)).toBeCloseTo(0.5); // contact
    expect(attackClipPhase("enemy", "Rig", "Foo", 0.6, 0)).toBeCloseTo(0.1); // wrapped
    expect(attackClipPhase("enemy", "Other", "Foo", 0, 0)).toBeNull();
  });
});
