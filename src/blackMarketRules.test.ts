import { describe, expect, it } from "vitest";
import {
  BLACK_MARKET_SPECIAL_LEVEL,
  blackMarketMutationRequirementLabel,
  blackMarketPurchaseLock,
  matchesBlackMarketMutation,
} from "./blackMarketRules";

describe("Black Market purchase requirements", () => {
  const noGraves = () => false;

  it("allows ordinary zombies without applying their planting level", () => {
    expect(blackMarketPurchaseLock({ category: "normal" }, 1, noGraves)).toBeNull();
  });

  it("requires the matching colored gravestone to be placed", () => {
    expect(blackMarketPurchaseLock(
      { category: "normal", unlockGrave: "Red" },
      1,
      () => false
    )).toMatchObject({ kind: "grave", grave: "Red" });
    expect(blackMarketPurchaseLock(
      { category: "normal", unlockGrave: "Red" },
      1,
      (grave) => grave === "Red"
    )).toBeNull();
  });

  it("unlocks special-zombie purchases at level 20", () => {
    expect(blackMarketPurchaseLock(
      { category: "special" },
      BLACK_MARKET_SPECIAL_LEVEL - 1,
      noGraves
    )).toMatchObject({ kind: "level", level: 20 });
    expect(blackMarketPurchaseLock(
      { category: "special" },
      BLACK_MARKET_SPECIAL_LEVEL,
      noGraves
    )).toBeNull();
  });

  it("ORs requested mutations in one slot and ANDs requirements across slots", () => {
    expect(matchesBlackMarketMutation(128, true, 128 | 512)).toBe(true);
    expect(matchesBlackMarketMutation(512, true, 128 | 512)).toBe(true);
    expect(matchesBlackMarketMutation(4, true, 4 | 8)).toBe(false);
    expect(matchesBlackMarketMutation(4 | 8 | 1024, true, 4 | 8)).toBe(true);
    expect(blackMarketMutationRequirementLabel(128 | 512 | 8))
      .toBe("Broccohair or Cauli-hair + Turnip-Arm");
    expect(matchesBlackMarketMutation(4, true)).toBe(true);
    expect(matchesBlackMarketMutation(0, false)).toBe(true);
  });
});
