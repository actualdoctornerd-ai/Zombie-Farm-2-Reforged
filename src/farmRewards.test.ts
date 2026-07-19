import { describe, expect, it } from "vitest";
import { harvestXp, plowXp } from "./farmRewards";

describe("Plowing Monolith XP rewards", () => {
  it("preserves normal rewards without the monolith", () => {
    expect(plowXp(false)).toBe(1);
    expect(harvestXp(3, false)).toBe(3);
  });

  it("moves plow XP to harvests while the monolith is active", () => {
    expect(plowXp(true)).toBe(0);
    expect(harvestXp(3, true)).toBe(4);
    expect(harvestXp(0, true)).toBe(1);
  });
});
