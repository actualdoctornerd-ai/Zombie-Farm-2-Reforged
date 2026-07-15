import { describe, it, expect } from "vitest";
import { ZombiePot, POT_DURATION_MS, MONOLITH_MULT } from "./ZombiePot";

// Ground truth: ZFZombieCombiner getCombineTime (3600s, or 900s = 0.25× with the
// Clay Monolith / purchase flag 28) + determineBaseClass species selection +
// deterministic mask combine. See zombie-pot-ground-truth memory / COMBAT_STATS_RECOVERED.

/** A pot with a controllable clock and rng, for deterministic assertions. */
function makePot(rng = 0) {
  let t = 0;
  const pot = new ZombiePot(
    () => t,
    () => rng
  );
  return { pot, tick: (ms: number) => (t += ms), finish: (dur: number) => (t += dur) };
}

const snap = (key: string, extra: Partial<{ mutation: number; tier: number; isBaseClass: boolean }> = {}) => ({
  key,
  mutation: extra.mutation ?? 0,
  tier: extra.tier,
  isBaseClass: extra.isBaseClass,
});

describe("combine timer", () => {
  it("defaults to 1 hour", () => {
    const { pot } = makePot();
    pot.start(snap("A"), snap("B"), false);
    expect(pot.totalMs()).toBe(POT_DURATION_MS);
    expect(POT_DURATION_MS).toBe(60 * 60 * 1000);
  });

  it("the Clay Monolith cuts it to 0.25× (15 min), not 0.5×", () => {
    const { pot } = makePot();
    pot.start(snap("A"), snap("B"), true);
    expect(MONOLITH_MULT).toBe(0.25);
    expect(pot.totalMs()).toBe(POT_DURATION_MS * 0.25);
  });

  it("refuses a second combine while one is running", () => {
    const { pot } = makePot();
    expect(pot.start(snap("A"), snap("B"), false)).toBe(true);
    expect(pot.start(snap("C"), snap("D"), false)).toBe(false);
  });

  it("Insta-Grow finishes an active timer without collecting it", () => {
    const { pot } = makePot();
    pot.start(snap("A"), snap("B"), false);
    expect(pot.finishNow()).toBe(true);
    expect(pot.ready).toBe(true);
    expect(pot.busy).toBe(true);
    expect(pot.finishNow()).toBe(false);
  });
});

describe("offline completion", () => {
  it("is not ready until the finish epoch passes, then collects", () => {
    const { pot, tick, finish } = makePot();
    pot.start(snap("A"), snap("B"), false);
    tick(POT_DURATION_MS - 1);
    expect(pot.ready).toBe(false);
    finish(2); // cross the finish line (as if the game was closed)
    expect(pot.ready).toBe(true);
    expect(pot.collect()).not.toBeNull();
    expect(pot.busy).toBe(false); // cleared after collect
  });
});

describe("species selection (determineBaseClass)", () => {
  const collectKey = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>, rng = 0) => {
    const { pot, finish } = makePot(rng);
    pot.start(a, b, false);
    finish(POT_DURATION_MS + 1);
    return pot.collect()!.key;
  };

  it("mixed veggie + non-veggie: the NON-veggie parent wins", () => {
    expect(collectKey(snap("veg", { isBaseClass: true }), snap("special", { isBaseClass: false }))).toBe("special");
    expect(collectKey(snap("special", { isBaseClass: false }), snap("veg", { isBaseClass: true }))).toBe("special");
  });

  it("both non-veggie: the higher combat tier wins (deterministic)", () => {
    expect(
      collectKey(snap("hi", { isBaseClass: false, tier: 3 }), snap("lo", { isBaseClass: false, tier: 1 }))
    ).toBe("hi");
  });

  it("equal-tier non-veggie: the ONLY coin flip in the system", () => {
    const a = snap("A", { isBaseClass: false, tier: 2 });
    const b = snap("B", { isBaseClass: false, tier: 2 });
    expect(collectKey(a, b, 0.4)).toBe("A"); // rng < 0.5 -> A
    expect(collectKey(a, b, 0.6)).toBe("B"); // rng >= 0.5 -> B
  });
});

describe("mutation inheritance on collect", () => {
  it("merges parent masks deterministically (per-slot)", () => {
    const { pot, finish } = makePot();
    pot.start(snap("A", { mutation: 1 }), snap("B", { mutation: 8 }), false); // head + arm
    finish(POT_DURATION_MS + 1);
    expect(pot.collect()!.mutation).toBe(9);
  });
});
