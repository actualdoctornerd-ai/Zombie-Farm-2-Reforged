import { describe, it, expect } from "vitest";
import {
  ZOMBIE_COST,
  blackMarketPurchaseRequirement,
  isHeadlessZombie,
  isKnownZombie,
  isTradableZombie,
  legalMutation,
  zombieSell,
} from "../src/rosterCatalog";
import { validateUnit, cleanIds } from "../src/roster";
import zombieRows from "../../public/assets/zombies.json";

describe("rosterCatalog", () => {
  it("mirrors every keyed zombie and converts brain prices to gold", () => {
    expect(Object.keys(ZOMBIE_COST)).toHaveLength(new Set(zombieRows.map((row) => row.key)).size);
    expect(zombieSell("ZombieActorRegularTier1")).toBe(17); // floor(35/2)
    expect(zombieSell("ZombieActorGardenTier4")).toBe(150); // floor(300/2)
    expect(zombieSell("ZombieActorGardenCupidPink")).toBe(1); // cost 0 → floor 0, min 1
    expect(zombieSell("nope")).toBe(1); // unknown → 0 → min 1 (only owned units sell anyway)
    expect(zombieSell("ZombieActorZomBetty")).toBe(5_000);
  });
  it("knows real keys and rejects unknown", () => {
    expect(isKnownZombie("ZombieActorLargeTier4")).toBe(true);
    expect(isKnownZombie("ZombieActorMadeUp")).toBe(false);
  });
  it("allows every known zombie type to trade, including reward-only specials", () => {
    expect(isTradableZombie("ZombieActorZomBetty")).toBe(true);
    expect(isTradableZombie("ZombieActorBombie")).toBe(true);
    expect(isTradableZombie("ZombieActorZombug")).toBe(true);
    expect(isTradableZombie("ZombieActorBandido")).toBe(true);
    expect(isTradableZombie("ZombieActorMadeUp")).toBe(false);
  });
  it("strips head and hair/eye mutations from headless species only", () => {
    expect(isHeadlessZombie("ZombieActorHeadlessTier4")).toBe(true);
    expect(isHeadlessZombie("ZombieActorBombie")).toBe(true); // a named headless special
    expect(isHeadlessZombie("ZombieActorRegularTier1")).toBe(false);
    // Party Zombie: carrot eyes (4) + broccoli hair (128) go, turnip arm (8) stays.
    expect(legalMutation("ZombieActorHeadlessTier4", 4 | 8 | 128)).toBe(8);
    expect(legalMutation("ZombieActorHeadlessTier4", 8 | 1024 | 2048)).toBe(8 | 1024 | 2048);
    // Everyone else keeps the whole mask.
    expect(legalMutation("ZombieActorRegularTier1", 4 | 8 | 128)).toBe(4 | 8 | 128);
    expect(legalMutation("ZombieActorMadeUp", 4)).toBe(4); // unknown key: leave it alone
  });
  it("keeps Pumpking on every species — only GROWING it is headless-only", () => {
    // Wearability is what this gate decides, and a Pot combine can hand the pumpkin
    // to a child of any body type (src/zombie/mutations.ts combineMasks). Stripping
    // it here would delete the mutation the player just bred for.
    expect(legalMutation("ZombieActorHeadlessTier1", 8192 | 8)).toBe(8192 | 8);
    expect(legalMutation("ZombieActorRegularTier1", 8192 | 8)).toBe(8192 | 8);
    expect(legalMutation("ZombieActorGardenTier4", 8192)).toBe(8192);
  });
  it("lets EPIC zombies keep a mutation, like every other special (owner's rule, 2026-09-07)", () => {
    // "Epic" is the Almanac's own Epic page: the Epic Boss event prizes
    // (EPIC_QUEST_ZOMBIE_REWARDS / isRewardOnlyZombie). The Zombie Pot is their one
    // route to a mutation (slot 1, wearing slot 2's mask), and the mask the Pot
    // hands them has to survive this scrub or the child collects unmutated.
    expect(legalMutation("ZombieActorVagabond", 4 | 8 | 128)).toBe(4 | 8 | 128);
    expect(legalMutation("ZombieActorScrooge", 8192)).toBe(8192);
    expect(legalMutation("ZombieActorAdmiral", 1024)).toBe(1024);
    // The seed path still refuses to mint an epic at all — they are earned, never
    // seeded — so a trusted write cannot conjure one, mutated or not.
    expect(validateUnit("epic", "ZombieActorMadame", 9, 0))
      .toEqual({ ok: false, error: "reward_only" });
    // SPECIALS ARE NOT EPICS. The tier-5s, Pot promotions and brain-market legends
    // are Special-class and may carry mutations exactly like a common zombie.
    expect(legalMutation("ZombieActorRegularTier5", 4 | 8 | 128)).toBe(4 | 8 | 128);
    expect(legalMutation("ZombieActorBombie", 8 | 1024)).toBe(8 | 1024);
    expect(legalMutation("ZombieActorSheriff", 4 | 8 | 128)).toBe(4 | 8 | 128);
  });
  it("defines Black Market gates independently of planting levels", () => {
    expect(blackMarketPurchaseRequirement("ZombieActorRegularTier1")).toEqual({});
    expect(blackMarketPurchaseRequirement("ZombieActorSmallTier2")).toEqual({ minLevel: 1 });
    expect(blackMarketPurchaseRequirement("ZombieActorRegularTier3")).toEqual({ minLevel: 15 });
    expect(blackMarketPurchaseRequirement("ZombieActorLargeTier4")).toEqual({ minLevel: 25 });
    // A special takes its OWN source's unlock level less three, over a level-20 floor, so
    // the authoritative gate matches the lock the client draws on the card.
    expect(blackMarketPurchaseRequirement("ZombieActorGardenTier3GreenFlower")).toEqual({ minLevel: 20 });
    expect(blackMarketPurchaseRequirement("ZombieActorZomBetty")).toEqual({ minLevel: 20 });
    expect(blackMarketPurchaseRequirement("ZombieActorZastronaut")).toEqual({ minLevel: 33 }); // Aliens at 36
    expect(blackMarketPurchaseRequirement("ZombieActorVagabond")).toEqual({ minLevel: 39 }); // Loco Locust at 42
    expect(blackMarketPurchaseRequirement("ZombieActorMadeUp")).toBeNull();
  });
});

// validateUnit backs the one-time save-migration seed (there is no public grant).
describe("validateUnit — validate a seeded unit", () => {
  it("accepts a real catalog unit and clamps mutation/invasions", () => {
    expect(validateUnit("z9", "ZombieActorRegularTier1", 7, 3)).toEqual({
      ok: true, unitId: "z9", key: "ZombieActorRegularTier1", mutation: 7, invasions: 3,
    });
    // Absent / negative → 0.
    expect(validateUnit("z9", "ZombieActorRegularTier1")).toMatchObject({ ok: true, mutation: 0, invasions: 0 });
    expect(validateUnit("z9", "ZombieActorRegularTier1", 0, -5)).toMatchObject({ ok: true, invasions: 0 });
    // Absurd values are clamped, not rejected.
    expect(validateUnit("z9", "ZombieActorRegularTier1", 0, 1e12).ok).toBe(true);
    // A seeded headless unit cannot bring head/hair-eye mutations across.
    expect(validateUnit("z9", "ZombieActorHeadlessTier3", 4 | 8, 0))
      .toMatchObject({ ok: true, mutation: 8 });
  });
  it("rejects a fabricated key or a missing unit id", () => {
    expect(validateUnit("z9", "ZombieActorSuperCheat")).toMatchObject({ ok: false, error: "bad_key" });
    expect(validateUnit("z9", "ZombieActorBandido")).toMatchObject({ ok: false, error: "reward_only" });
    expect(validateUnit("", "ZombieActorRegularTier1")).toMatchObject({ ok: false, error: "bad_unit" });
  });
});

describe("cleanIds — veteran/casualty batches", () => {
  it("dedups, drops non-strings, and caps length", () => {
    expect(cleanIds(["a", "b", "a", 5, "", "c"])).toEqual(["a", "b", "c"]);
    expect(cleanIds("nope")).toEqual([]);
    expect(cleanIds(Array.from({ length: 100 }, (_, i) => `z${i}`), 10)).toHaveLength(10);
  });
});
