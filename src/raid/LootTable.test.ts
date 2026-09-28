import { describe, it, expect } from "vitest";
import { rollLootTier, pickLootEntry, lootEntryWeight } from "./LootTable";

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

describe("pickLootEntry — weighted pick, walking down", () => {
  const table = [["Gold"], ["Common"], ["A", "B"], ["Banner"]];
  const all = () => 1;

  it("is the binary's uniform pick when every weight is 1", () => {
    expect(pickLootEntry(table, 2, all, 0)).toBe("A");
    expect(pickLootEntry(table, 2, all, 0.49)).toBe("A");
    expect(pickLootEntry(table, 2, all, 0.5)).toBe("B");
    expect(pickLootEntry(table, 2, all, 0.999999)).toBe("B");
  });

  it("walks down past a tier with nothing eligible", () => {
    const noBanner = (n: string) => (n === "Banner" ? 0 : 1);
    expect(pickLootEntry(table, 3, noBanner, 0.7)).toBe("B");
  });

  it("lets a partial-weight tier pay only its share, and rescales the rest", () => {
    const rare = (n: string) => (n === "Banner" ? 0.25 : 1);
    expect(pickLootEntry(table, 3, rare, 0.2)).toBe("Banner");
    // 0.25 + 0.75 * 0.4 = 0.55 -> 0.4 of the tier below -> "A".
    expect(pickLootEntry(table, 3, rare, 0.55)).toBe("A");
    // 0.25 + 0.75 * 0.6 = 0.7 -> 0.6 of the tier below -> "B".
    expect(pickLootEntry(table, 3, rare, 0.7)).toBe("B");
  });

  it("falls back to the partial entry rather than nothing when nothing is below", () => {
    const only = [["Banner"]];
    expect(pickLootEntry(only, 0, () => 0.25, 0.9)).toBe("Banner");
    expect(pickLootEntry(only, 0, () => 0, 0.9)).toBeNull();
  });
});

describe("lootEntryWeight", () => {
  it("prices unique, limit and repeat rules", () => {
    expect(lootEntryWeight(undefined, 5)).toBe(1);
    expect(lootEntryWeight({ unique: true, limit: 0 }, 0)).toBe(1);
    expect(lootEntryWeight({ unique: true, limit: 0 }, 1)).toBe(0);
    expect(lootEntryWeight({ unique: false, limit: 3 }, 3)).toBe(0);
    expect(lootEntryWeight({ unique: false, limit: 0, repeatWeight: 0.25 }, 0)).toBe(1);
    expect(lootEntryWeight({ unique: false, limit: 0, repeatWeight: 0.25 }, 2)).toBe(0.25);
  });
});