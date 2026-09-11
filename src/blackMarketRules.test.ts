import { describe, expect, it } from "vitest";
import {
  BLACK_MARKET_SPECIAL_FLOOR_LEVEL,
  blackMarketComposeDefaults,
  blackMarketMutationRequirementLabel,
  blackMarketPurchaseLock,
  matchesBlackMarketMutation,
  REQUESTABLE_MUTATION_MASK,
} from "./blackMarketRules";
import { DEPUTY_ZOMBIE_KEY, ZASTRONAUT_KEY, ZOSMONAUT_KEY } from "./raid/zombieDrops";
import { ALL_BITS, HEADLESS_HEAD_MASK } from "./zombie/mutations";
import { maskHas, maskUnion } from "./zombie/mutationMask";

describe("Black Market compose defaults", () => {
  it("opens a roster-originated sale with that zombie selected", () => {
    expect(blackMarketComposeDefaults("SELL_ZOMBIE", "unit-2", ["unit-1", "unit-2"]))
      .toEqual({ kind: "SELL_ZOMBIE", assetId: "unit-2" });
  });

  it("does not carry an unavailable unit into the form", () => {
    expect(blackMarketComposeDefaults("SELL_ZOMBIE", "missing", ["unit-1"]))
      .toEqual({ kind: "SELL_ZOMBIE" });
  });
});

describe("Black Market purchase requirements", () => {
  it("allows ordinary zombies without applying their planting level", () => {
    expect(blackMarketPurchaseLock({ category: "normal" }, 1)).toBeNull();
  });

  it("unlocks colored zombies at the matching gravestone's level", () => {
    expect(blackMarketPurchaseLock(
      { category: "normal", unlockGrave: "Red" },
      14
    )).toMatchObject({ kind: "level", level: 15 });
    expect(blackMarketPurchaseLock(
      { category: "normal", unlockGrave: "Red" },
      15
    )).toBeNull();
    expect(blackMarketPurchaseLock(
      { category: "normal", unlockGrave: "Silver" },
      25
    )).toBeNull();
  });

  it("holds a sourceless special at the floor", () => {
    // The orphaned seasonals (ZomBetty and friends) have no live grant of any kind;
    // they trade only because old saves hold them, so the bare floor is their gate.
    expect(blackMarketPurchaseLock(
      { key: "ZombieActorZomBetty", category: "special" },
      BLACK_MARKET_SPECIAL_FLOOR_LEVEL - 1
    )).toMatchObject({ kind: "level", level: 25 });
    expect(blackMarketPurchaseLock(
      { key: "ZombieActorZomBetty", category: "special" },
      BLACK_MARKET_SPECIAL_FLOOR_LEVEL
    )).toBeNull();
  });

  it("gates a special at the level its own source opens", () => {
    // Aliens unlock at 36, so their prizes do — buying one at 30 was the shortcut.
    expect(blackMarketPurchaseLock({ key: ZASTRONAUT_KEY, category: "special" }, 35))
      .toMatchObject({ kind: "level", level: 36 });
    expect(blackMarketPurchaseLock({ key: ZOSMONAUT_KEY, category: "special" }, 36)).toBeNull();
    // Loco Locust's Vagabond is the strongest zombie in the game; its event opens at 42.
    expect(blackMarketPurchaseLock({ key: "ZombieActorVagabond", category: "special" }, 41))
      .toMatchObject({ kind: "level", level: 42 });
    // An early source is raised to the floor rather than lowered to its own level: the
    // Lawyers unlock at 16, but no special is deliverable before 25.
    expect(blackMarketPurchaseLock({ key: DEPUTY_ZOMBIE_KEY, category: "special" }, 24))
      .toMatchObject({ kind: "level", level: 25 });
  });

  it("uses the stricter requirement for a special colored zombie", () => {
    expect(blackMarketPurchaseLock(
      { key: "ZombieActorGardenTier3GreenFlower", category: "special", unlockGrave: "Red" },
      24
    )).toMatchObject({ kind: "level", level: 25 });
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

  it("makes every catalogued mutation requestable, including ones added later", () => {
    // Migration 0030's CHECK used to cap this at the 13 bits that existed then, which
    // excluded Pumpking (8192) and would have excluded every mutation after it. Since
    // 0044 the column only requires `> 0` and the catalog is the bound — so this must
    // track ALL_BITS rather than a hard-coded number.
    expect(REQUESTABLE_MUTATION_MASK).toBe(ALL_BITS.reduce(maskUnion, 0));
    for (const bit of ALL_BITS) {
      expect(maskHas(REQUESTABLE_MUTATION_MASK, bit)).toBe(true);
    }
    expect(maskHas(REQUESTABLE_MUTATION_MASK, HEADLESS_HEAD_MASK)).toBe(true);
  });
});
