import { describe, expect, it } from "vitest";
import { matchesMutationRequirement } from "../src/v3/blackMarket";

describe("Black Market mutation matching", () => {
  it("ORs alternatives in one slot", () => {
    const broccoliOrCauliflower = 128 | 512;
    expect(matchesMutationRequirement(128, 1, broccoliOrCauliflower)).toBe(true);
    expect(matchesMutationRequirement(512, 1, broccoliOrCauliflower)).toBe(true);
    expect(matchesMutationRequirement(4, 1, broccoliOrCauliflower)).toBe(false);
  });

  it("ANDs requirements across different slots", () => {
    const carrotEyesAndTurnipArm = 4 | 8;
    expect(matchesMutationRequirement(4, 1, carrotEyesAndTurnipArm)).toBe(false);
    expect(matchesMutationRequirement(8, 1, carrotEyesAndTurnipArm)).toBe(false);
    expect(matchesMutationRequirement(4 | 8 | 1024, 1, carrotEyesAndTurnipArm)).toBe(true);
  });

  it("preserves broad any-mutation and no-mutation requests", () => {
    expect(matchesMutationRequirement(4, 1, null)).toBe(true);
    expect(matchesMutationRequirement(0, 0, null)).toBe(true);
    expect(matchesMutationRequirement(0, 1, null)).toBe(false);
  });
});
