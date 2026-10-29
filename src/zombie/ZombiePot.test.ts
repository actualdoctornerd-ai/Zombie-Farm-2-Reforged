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

const snap = (key: string, extra: Partial<{
  mutation: number; tier: number; isBaseClass: boolean; group: string; className: string; isSpecial: boolean;
}> = {}) => ({
  key,
  mutation: extra.mutation ?? 0,
  tier: extra.tier,
  isBaseClass: extra.isBaseClass,
  group: extra.group,
  isSpecial: extra.isSpecial,
});

describe("combine timer", () => {
  it("persists parent identities for an online reload", () => {
    const { pot } = makePot();
    pot.start({ ...snap("A"), id: "server-a" }, { ...snap("B"), id: "server-b" }, false);
    expect(pot.serialize()).toMatchObject({ parentAId: "server-a", parentBId: "server-b" });

    const restored = new ZombiePot(() => 0, () => 0);
    restored.restore(pot.serialize());
    expect(restored.pending).toMatchObject({ parentAId: "server-a", parentBId: "server-b" });
  });

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

describe("ready-to-collect preview", () => {
  it("hides the result until the combine is done", () => {
    const { pot, tick } = makePot();
    expect(pot.preview()).toBeNull(); // idle pot
    pot.start(snap("A", { mutation: 1 }), snap("B", { mutation: 8 }), false);
    tick(POT_DURATION_MS - 1);
    expect(pot.preview()).toBeNull(); // still combining
  });

  it("shows the finished zombie without collecting it", () => {
    const { pot, finish } = makePot();
    pot.start(snap("A", { mutation: 1 }), snap("B", { mutation: 8 }), false);
    finish(POT_DURATION_MS + 1);
    expect(pot.preview()).toEqual({ key: "A", mutation: 9, color: undefined });
    // Non-destructive: the job is still there, and previewing twice is stable.
    expect(pot.busy).toBe(true);
    expect(pot.preview()).toEqual(pot.preview());
    // ...and it is exactly what collection hands over.
    expect(pot.collect()).toEqual({ key: "A", mutation: 9, color: undefined });
    expect(pot.busy).toBe(false);
    expect(pot.preview()).toBeNull(); // back to an empty pot
  });
});

describe("species selection (determineBaseClass)", () => {
  const collectKey = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>, rng = 0) => {
    const { pot, finish } = makePot(rng);
    pot.start(a, b, false);
    finish(POT_DURATION_MS + 1);
    return pot.collect()!.key;
  };

  it("uses the first parent species regardless of mutant or combat tier", () => {
    expect(collectKey(snap("veg", { isBaseClass: true }), snap("ordinary", { tier: 5 }))).toBe("veg");
    expect(collectKey(snap("low", { tier: 1 }), snap("high", { tier: 5 }))).toBe("low");
  });

  it("does not use the ordinary-species random source", () => {
    const a = snap("A", { isBaseClass: false, tier: 2 });
    const b = snap("B", { isBaseClass: false, tier: 2 });
    expect(collectKey(a, b, 0.4)).toBe("A");
    expect(collectKey(a, b, 0.6)).toBe("A");
  });

  it("preserves slot-1 specials and lets pot-bred specials donate from slot 2", () => {
    const { pot } = makePot();
    expect(pot.start(
      snap("A", { isSpecial: true }),
      snap("B"),
      false
    )).toBe(true);
    pot.finishNow();
    expect(pot.collect()?.key).toBe("A");

    const second = makePot().pot;
    expect(second.start(snap("A"), snap("B", { isSpecial: true }), false)).toBe(false);
    expect(second.busy).toBe(false);

    const donor = makePot().pot;
    expect(donor.start(
      snap("ZombieActorRegularTier1", { mutation: 1, group: "Regular" }),
      snap("ZombieActorRegularTier5", { mutation: 8, group: "Regular", className: "Special", isSpecial: true }),
      false
    )).toBe(true);
    donor.finishNow();
    expect(donor.collect()).toMatchObject({ key: "ZombieActorRegularTier1", mutation: 9 });
  });

  it("persists the level and type needed for the rare-special roll", () => {
    const { pot } = makePot(0.05);
    pot.start(
      snap("A", { group: "Headless" }),
      snap("B", { group: "Headless" }),
      false,
      POT_DURATION_MS,
      25
    );
    expect(pot.pending).toMatchObject({
      groupA: "Headless", groupB: "Headless", playerLevel: 25,
    });
  });

  it("derives persisted parent rolls independently of the local Math.random source", () => {
    const first = makePot(0).pot;
    const second = makePot(0.999).pot;
    const a = { ...snap("A", { group: "Regular", tier: 2 }), id: "parent-a" };
    const b = { ...snap("B", { group: "Large", tier: 2 }), id: "parent-b" };
    first.start(a, b, false, 0, 25);
    second.start(a, b, false, 0, 25);
    expect(first.collect()?.key).toBe(second.collect()?.key);
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
