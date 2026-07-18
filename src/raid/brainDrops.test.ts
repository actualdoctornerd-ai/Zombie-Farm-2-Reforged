import { describe, expect, it } from "vitest";
import { brainDropTable, rollBrainDrop } from "./brainDrops";

describe("invasion brain drops", () => {
  it("doubles rate without changing the 10/30/50 awards", () => {
    expect(brainDropTable(20)).toEqual([
      { amount: 50, chance: 0.02 },
      { amount: 30, chance: 0.04 },
      { amount: 10, chance: 0.1 },
    ]);
  });

  it("rolls rarest-first and awards at most one tier", () => {
    expect(rollBrainDrop(20, () => 0.019)).toBe(50);
    const rolls = [0.5, 0.039];
    expect(rollBrainDrop(20, () => rolls.shift() ?? 1)).toBe(30);
    expect(rollBrainDrop(20, () => 1)).toBe(0);
  });
});
