import { describe, it, expect } from "vitest";
import { rollLootTier } from "./LootTable";

// Ground truth: -[ZFFightSummary rollForDrop:] cumulative threshold ladder, with a
// distinct bracket per Golden Dice spent (docs/mechanics/COMBAT_STATS_RECOVERED.md).
// roll r in [0,1); bonus B = dice spent.

describe("rollLootTier — bracket 0 (no dice)", () => {
  // r<.09→t0, r<.24→t1, r<.84→t2, r<.92→t3, else t4
  it("maps each band to its tier", () => {
    expect(rollLootTier(0.05, 0)).toBe(0);
    expect(rollLootTier(0.2, 0)).toBe(1);
    expect(rollLootTier(0.5, 0)).toBe(2);
    expect(rollLootTier(0.88, 0)).toBe(3);
    expect(rollLootTier(0.97, 0)).toBe(4);
  });
  it("uses < (a roll exactly on a threshold falls to the next band)", () => {
    expect(rollLootTier(0.09, 0)).toBe(1); // not t0
    expect(rollLootTier(0.24, 0)).toBe(2); // not t1
  });
});

describe("rollLootTier — bracket 1 (one die) shifts the whole table rarer", () => {
  // r<.14→t1, r<.74→t2, r<.84→t3, r<.92→t4, else t5
  it("makes the common tier unreachable and puts t5 on the table", () => {
    expect(rollLootTier(0.05, 1)).toBe(1); // no more t0
    expect(rollLootTier(0.5, 1)).toBe(2);
    expect(rollLootTier(0.8, 1)).toBe(3);
    expect(rollLootTier(0.88, 1)).toBe(4);
    expect(rollLootTier(0.97, 1)).toBe(5);
  });
});

describe("rollLootTier — bracket 2 (two dice)", () => {
  // r<.59→t2, r<.79→t3, r<.89→t4, else t5
  it("only tiers 2–5 remain", () => {
    expect(rollLootTier(0.1, 2)).toBe(2);
    expect(rollLootTier(0.7, 2)).toBe(3);
    expect(rollLootTier(0.85, 2)).toBe(4);
    expect(rollLootTier(0.95, 2)).toBe(5);
  });
});

describe("rollLootTier — bracket 3+ (over-luck) compresses toward t5", () => {
  it("only tiers 3–5 remain and t5 grows with more dice", () => {
    expect(rollLootTier(0.1, 3)).toBe(3);
    expect(rollLootTier(0.5, 3)).toBe(4);
    expect(rollLootTier(0.95, 3)).toBe(5);
    // A high roll is always the rarest tier regardless of how many dice.
    expect(rollLootTier(0.99, 7)).toBe(5);
  });
  it("normalizes negative/fractional bonus like 0", () =>
    expect(rollLootTier(0.05, -2)).toBe(0));
});
