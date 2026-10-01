import { describe, expect, it } from "vitest";
import plants from "../public/assets/plants.json";
import { CROP_UNLOCKS, PRIZE_CROPS, cropUnlockOf, cropUnlocked, newlyUnlockedCrops, type CropUnlock } from "./cropUnlocks";

const TABLE: Record<string, CropUnlock> = {
  goldcrop: { raidId: 12, tier: 5 },
  darkcrop: { raidId: 13, tier: 10 },
};

describe("crop tier unlocks", () => {
  it("leaves an ordinary crop unlocked whatever the ladder says", () => {
    expect(cropUnlockOf("carrot", TABLE)).toBeNull();
    expect(cropUnlocked("carrot", undefined, TABLE, true)).toBe(true);
    expect(cropUnlocked("carrot", {}, TABLE, true)).toBe(true);
  });

  it("needs the tier CLEARED on the named raid, not one above or on another raid", () => {
    expect(cropUnlocked("goldcrop", undefined, TABLE, true)).toBe(false);
    expect(cropUnlocked("goldcrop", { "12": 4 }, TABLE, true)).toBe(false);
    expect(cropUnlocked("goldcrop", { "13": 10 }, TABLE, true)).toBe(false);
    expect(cropUnlocked("goldcrop", { "12": 5 }, TABLE, true)).toBe(true);
    expect(cropUnlocked("goldcrop", { "12": 10 }, TABLE, true)).toBe(true);
  });

  it("treats a garbled ladder entry as nothing cleared", () => {
    const tiers = { "12": Number.NaN, "13": "9" as unknown as number };
    expect(cropUnlocked("goldcrop", tiers, TABLE, true)).toBe(false);
    expect(cropUnlocked("darkcrop", tiers, TABLE, true)).toBe(false);
  });

  it("announces a crop once: only the clear that crosses its tier", () => {
    expect(newlyUnlockedCrops({ "12": 4 }, { "12": 5 }, TABLE, true)).toEqual(["goldcrop"]);
    // A replay cannot move the ladder, so nothing is announced twice.
    expect(newlyUnlockedCrops({ "12": 5 }, { "12": 5 }, TABLE, true)).toEqual([]);
    // Skipping straight past the tier still announces it once.
    expect(newlyUnlockedCrops({}, { "12": 7 }, TABLE, true)).toEqual(["goldcrop"]);
    expect(newlyUnlockedCrops({ "12": 5 }, { "12": 6, "13": 10 }, TABLE, true)).toEqual(["darkcrop"]);
  });

  it("keeps every prize crop locked while the prize crops are not live", () => {
    expect(PRIZE_CROPS.live).toBe(false);
    const cleared = { "12": 10, "13": 10, "14": 10, "15": 10 };
    for (const crop of Object.keys(CROP_UNLOCKS)) {
      expect(cropUnlocked(crop, cleared), `${crop} must stay locked`).toBe(false);
    }
    expect(newlyUnlockedCrops({}, cleared)).toEqual([]);
    // ...and an ordinary crop is never touched by the switch.
    expect(cropUnlocked("carrot", {})).toBe(true);
  });

  it("only ever names real crops on a dual invasion's ladder", () => {
    const keys = new Set(plants.map((p) => p.key));
    for (const [crop, need] of Object.entries(CROP_UNLOCKS)) {
      expect(keys.has(crop), `${crop} is not in plants.json`).toBe(true);
      expect([12, 13, 14, 15]).toContain(need.raidId);
      expect(need.tier).toBeGreaterThanOrEqual(1);
      expect(need.tier).toBeLessThanOrEqual(10);
    }
  });
});
