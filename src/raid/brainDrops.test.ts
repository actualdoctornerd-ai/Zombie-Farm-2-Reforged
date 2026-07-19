import { describe, expect, it } from "vitest";
import { brainDropTable, rollBrainDrop } from "./brainDrops";

describe("invasion brain drops", () => {
  it("doubles rate without changing the 5/3/1 awards", () => {
    expect(brainDropTable(20)).toEqual([
      { amount: 5, chance: 0.02 },
      { amount: 3, chance: 0.04 },
      { amount: 1, chance: 0.1 },
    ]);
  });

  it("rolls rarest-first and awards at most one tier", () => {
    expect(rollBrainDrop(20, () => 0.019)).toBe(5);
    const rolls = [0.5, 0.039];
    expect(rollBrainDrop(20, () => rolls.shift() ?? 1)).toBe(3);
    expect(rollBrainDrop(20, () => 1)).toBe(0);
  });
});
