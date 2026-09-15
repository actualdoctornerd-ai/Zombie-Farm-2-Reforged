import { describe, it, expect } from "vitest";
import { gardenChance, fertilizeProbability } from "../src/rosterCatalog";
import zombieRows from "../../public/assets/zombies.json";

// The live client rolls deployed Garden zombies immediately so the animation is not
// delayed by command batching. These server-side catalog helpers retain the same
// ground-truth probability math for auditing and non-visual simulations.

const approx = (a: number, b: number) => expect(a).toBeCloseTo(b, 10);

// Ground truth, as it appears in the client's ZombieField.FERTILIZE_BY_TIER.
const TIER_CHANCE: Readonly<Record<number, number>> = { 1: 0.04, 2: 0.06, 3: 0.08, 4: 0.08, 5: 0.12 };

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

  // The tier table is hand-keyed, and the two Dr. Zombies were missed by it for
  // exactly that reason: they are Garden tier-5 specials whose keys do not start
  // with ZombieActorGarden, so a table written by eye off the prefix left them
  // fertilizing at nothing. (The client never had the fault — it reads the tier off
  // the roster row.) Derive the expectation from zombies.json so the next Garden
  // unit cannot be silently left out either.
  it("covers every Garden unit in zombies.json, whatever its key is called", () => {
    const garden = (zombieRows as { key: string; group?: string; tier?: number }[])
      .filter((z) => z.group === "Garden");
    expect(garden.length).toBe(10); // fails loudly when the roster gains one
    for (const z of garden) {
      expect.soft(gardenChance(z.key), z.key).toBe(TIER_CHANCE[z.tier ?? 0] ?? 0);
    }
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
