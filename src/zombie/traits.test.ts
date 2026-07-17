import { describe, it, expect } from "vitest";
import {
  veterancyLevel,
  veterancyMultiplier,
  veterancy,
  VET_STAT_STEP,
  MAX_VET_RANK,
  displayStat,
  STAT_DISPLAY_MAX,
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

// Ground truth (user-verified 2026-07-17): the card shows each str/con/dex as a
// 0–100 bar = raw / STAT_DISPLAY_MAX × 100, rounded; focus is shown raw. Denominators
// are the per-stat maxima across the six standard group tier-5s.
describe("stat display normalization", () => {
  it("uses the tier-5 per-stat ceilings as denominators", () => {
    expect(STAT_DISPLAY_MAX).toEqual({ str: 23.32, con: 29.7, dex: 4.4 });
  });

  // [name, str, con, dex, focus, expectedPower, expectedSpeed, expectedLife, expectedFocus]
  const cases: [string, number, number, number, number, number, number, number, number][] = [
    ["Zombarian (Large T4)", 21.2, 15.0, 1.3, 75, 91, 30, 51, 75],
    ["Zombee (Garden T4)", 5.5, 5.5, 2.0, 70, 24, 45, 19, 70],
    ["Zombielocks (Female T4)", 8.3, 13.0, 3.5, 85, 36, 80, 44, 85],
    ["Zombelly Dancer (Female T5)", 8.71, 14.3, 3.67, 100, 37, 83, 48, 100],
    ["Flytrap (Regular T3 Venus, base)", 8.0, 10.0, 2.0, 70, 34, 45, 34, 70],
  ];
  it.each(cases)("%s reproduces the game's shown bars", (_n, str, con, dex, focus, p, s, l, f) => {
    expect(displayStat("str", str)).toBe(p);
    expect(displayStat("dex", dex)).toBe(s);
    expect(displayStat("con", con)).toBe(l);
    expect(displayStat("focus", focus)).toBe(f);
  });

  it("scales linearly with veterancy — Master Zombarian's dex/focus", () => {
    // Master = ×1.25 on all four stats before normalization. Base Zombarian dex 1.3
    // and focus 75 (the swapped-in parts add no dex) → the game's 37 speed / 94 focus.
    expect(displayStat("dex", 1.3 * veterancyMultiplier(5))).toBe(37);
    expect(displayStat("focus", 75 * veterancyMultiplier(5))).toBe(94);
  });

  it("clamps an over-ceiling special to 100 so an OP zombie can't overflow or rescale others", () => {
    expect(displayStat("str", 40)).toBe(100); // Brock Coley str 40 → 171% → clamped
    expect(displayStat("str", 30)).toBe(100); // George Washington str 30 → 129% → clamped
    // A hypothetical future OP unit still just reads 100 — existing bars are unchanged.
    expect(displayStat("con", 999)).toBe(100);
  });
});
