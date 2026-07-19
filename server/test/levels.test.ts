import { describe, it, expect } from "vitest";
import { XP_THRESHOLDS, levelForXp, levelUpBrains } from "../src/levels";

describe("levelForXp — server XP→level curve", () => {
  it("is level 1 at 0 xp and below the first real threshold", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(24)).toBe(1);
  });
  it("advances a level exactly at each threshold", () => {
    expect(levelForXp(25)).toBe(2); // threshold[1]
    expect(levelForXp(74)).toBe(2);
    expect(levelForXp(75)).toBe(3); // threshold[2]
    expect(levelForXp(150)).toBe(4);
  });
  it("caps at the top tier", () => {
    const top = XP_THRESHOLDS.length; // 45
    expect(levelForXp(XP_THRESHOLDS[top - 1])).toBe(top);
    expect(levelForXp(9_999_999)).toBe(top);
  });
  it("matches the client curve length (45 tiers)", () => {
    expect(XP_THRESHOLDS.length).toBe(45);
  });
});

describe("levelUpBrains — no brains post-brainflation revert", () => {
  it("grants no brains when leveling up (the +1-per-level drip was removed)", () => {
    expect(levelUpBrains(1, 2)).toBe(0);
    expect(levelUpBrains(1, 5)).toBe(0);
  });
  it("grants nothing when the level didn't rise either", () => {
    expect(levelUpBrains(5, 5)).toBe(0);
    expect(levelUpBrains(5, 3)).toBe(0);
  });
});
