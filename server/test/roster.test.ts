import { describe, it, expect } from "vitest";
import { ZOMBIE_COST, isKnownZombie, zombieSell } from "../src/rosterCatalog";
import { validateUnit, cleanIds } from "../src/roster";

describe("rosterCatalog", () => {
  it("mirrors 55 keyed costs and prices sell as max(1, floor(cost/2))", () => {
    expect(Object.keys(ZOMBIE_COST).length).toBe(55);
    expect(zombieSell("ZombieActorRegularTier1")).toBe(17); // floor(35/2)
    expect(zombieSell("ZombieActorGardenTier4")).toBe(150); // floor(300/2)
    expect(zombieSell("ZombieActorGardenCupidPink")).toBe(1); // cost 0 → floor 0, min 1
    expect(zombieSell("nope")).toBe(1); // unknown → 0 → min 1 (only owned units sell anyway)
  });
  it("knows real keys and rejects unknown", () => {
    expect(isKnownZombie("ZombieActorLargeTier4")).toBe(true);
    expect(isKnownZombie("ZombieActorMadeUp")).toBe(false);
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
  });
  it("rejects a fabricated key or a missing unit id", () => {
    expect(validateUnit("z9", "ZombieActorSuperCheat")).toMatchObject({ ok: false, error: "bad_key" });
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
