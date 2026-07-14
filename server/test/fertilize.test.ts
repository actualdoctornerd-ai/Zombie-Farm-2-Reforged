import { describe, it, expect } from "vitest";
import { gardenChance, fertilizeProbability } from "../src/rosterCatalog";

// P13 — server owns the Garden-zombie fertilize roll. The probability that a freshly
// planted crop comes up fertilized (2x harvest) is 1 - Π(1 - chance_i) over the
// player's owned Garden units. This is the pure math the /farm plant path rolls against
// (db.applyFarmActions: `Math.random() < fertilizeProbability(gardenKeys)`), so the
// bounds here directly gate how much free gold fertilization can produce.

const approx = (a: number, b: number) => expect(a).toBeCloseTo(b, 10);

describe("gardenChance — per-unit fertilize chance by tier", () => {
  it("maps each Garden key to its ground-truth tier chance", () => {
    expect(gardenChance("ZombieActorGardenTier1")).toBe(0.04);
    expect(gardenChance("ZombieActorGardenTier2")).toBe(0.06);
    expect(gardenChance("ZombieActorGardenTier3")).toBe(0.08);
    expect(gardenChance("ZombieActorGardenTier3GreenFlower")).toBe(0.08);
    expect(gardenChance("ZombieActorGardenTier4")).toBe(0.08);
    expect(gardenChance("ZombieActorGardenTier5")).toBe(0.12);
    expect(gardenChance("ZombieActorGardenCupid")).toBe(0.12); // tier-5 chance
    expect(gardenChance("ZombieActorGardenCupidPink")).toBe(0.12);
  });

  it("is zero for any non-Garden or unknown key (no fertilization from combat units)", () => {
    expect(gardenChance("ZombieActorRegularTier1")).toBe(0);
    expect(gardenChance("ZombieActorLargeTier4")).toBe(0);
    expect(gardenChance("ZombieActorMadeUp")).toBe(0);
    expect(gardenChance("")).toBe(0);
    expect(gardenChance("__proto__")).toBe(0);
  });
});

describe("fertilizeProbability — 1 - Π(1 - chance)", () => {
  it("is exactly 0 with no Garden units (empty or all-combat roster)", () => {
    expect(fertilizeProbability([])).toBe(0);
    expect(fertilizeProbability(["ZombieActorRegularTier1", "ZombieActorLargeTier4"])).toBe(0);
  });

  it("equals the single unit's chance for a one-Garden roster", () => {
    approx(fertilizeProbability(["ZombieActorGardenTier1"]), 0.04);
    approx(fertilizeProbability(["ZombieActorGardenTier5"]), 0.12);
  });

  it("combines independent chances multiplicatively (not additively)", () => {
    // Two tier-1 units: 1 - 0.96^2 = 0.0784, NOT 0.08.
    approx(fertilizeProbability(["ZombieActorGardenTier1", "ZombieActorGardenTier1"]), 1 - 0.96 * 0.96);
    // Mixed tiers: 1 - (0.96)(0.94)(0.88).
    approx(
      fertilizeProbability(["ZombieActorGardenTier1", "ZombieActorGardenTier2", "ZombieActorGardenTier5"]),
      1 - 0.96 * 0.94 * 0.88
    );
  });

  it("is order-independent", () => {
    const a = fertilizeProbability(["ZombieActorGardenTier1", "ZombieActorGardenTier5", "ZombieActorGardenTier3"]);
    const b = fertilizeProbability(["ZombieActorGardenTier5", "ZombieActorGardenTier3", "ZombieActorGardenTier1"]);
    approx(a, b);
  });

  it("stays a probability in [0,1) and rises monotonically with more units, never reaching 1", () => {
    let prev = 0;
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) {
      keys.push("ZombieActorGardenTier5"); // strongest, 0.12 each
      const p = fertilizeProbability(keys);
      expect(p).toBeGreaterThan(prev);
      expect(p).toBeLessThan(1); // asymptotic — never a guaranteed fertilize
      prev = p;
    }
    // 50 tier-5 units is still short of certainty (1 - 0.88^50 ≈ 0.998).
    expect(prev).toBeLessThan(0.999);
  });

  it("ignores non-Garden units mixed into the roster", () => {
    const withJunk = fertilizeProbability([
      "ZombieActorGardenTier2",
      "ZombieActorRegularTier1",
      "ZombieActorLargeTier4",
    ]);
    approx(withJunk, 0.06);
  });
});
