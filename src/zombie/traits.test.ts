import { describe, it, expect } from "vitest";
import {
  veterancyLevel,
  veterancyMultiplier,
  veterancy,
  VET_STAT_STEP,
  MAX_VET_RANK,
} from "./traits";

// Ground truth: -[ZombieActor modifyStatWithRank:] = stat × (1 + 0.05 × rank).
// The 6-rung ladder (Newbie → Veteran 1..4 → Master), one rank per survived invasion.

describe("veterancy rank ladder", () => {
  it("ranks up one rung per survived invasion, capping at Master", () => {
    expect(veterancyLevel(0)).toBe(0);
    expect(veterancyLevel(1)).toBe(1);
    expect(veterancyLevel(5)).toBe(5);
    expect(veterancyLevel(50)).toBe(MAX_VET_RANK); // never exceeds Master
  });
  it("names the rank", () => {
    expect(veterancy(0)).toBe("Newbie");
    expect(veterancy(5)).toBe("Master");
  });
});

describe("veterancy stat multiplier — +5% per rank", () => {
  it("uses the 0.05 coefficient from the binary", () => expect(VET_STAT_STEP).toBe(0.05));
  it("is 1.0 at rank 0 and 1.25 at Master", () => {
    expect(veterancyMultiplier(0)).toBe(1);
    expect(veterancyMultiplier(5)).toBeCloseTo(1.25);
  });
});
