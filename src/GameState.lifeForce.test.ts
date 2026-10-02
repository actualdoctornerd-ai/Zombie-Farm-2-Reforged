import { describe, it, expect } from "vitest";
import { GameState } from "./GameState";
import { farmLifeForce } from "./lifeForce";

// Life Force is DERIVED from the placed objects (main.ts refreshLifeForce) and handed to
// GameState, which only holds it for the HUD. These pin that the hand-off is idempotent,
// and quiet when nothing changed. SaveManager lists the persisted fields
// explicitly and does not include it.

describe("GameState life force", () => {
  it("starts at zero", () => {
    expect(new GameState().lifeForce).toBe(0);
  });

  it("adopts a derived total and tells listeners once", () => {
    const s = new GameState();
    let emitted = 0;
    s.onChange(() => emitted++);
    s.syncLifeForce(112);
    expect(s.lifeForce).toBe(112);
    expect(emitted).toBe(1);
    s.syncLifeForce(112); // nothing changed: no redraw
    expect(emitted).toBe(1);
  });

  it("floors and clamps whatever it is given", () => {
    const s = new GameState();
    s.syncLifeForce(29.9);
    expect(s.lifeForce).toBe(29);
    s.syncLifeForce(-4);
    expect(s.lifeForce).toBe(0);
  });

  it("is recomputed from the objects standing on the farm, not accumulated", () => {
    const of = (k: string) => ({ crate: 1, gazeboNormal: 16 }[k] ?? 0);
    const s = new GameState();
    s.syncLifeForce(farmLifeForce(["crate", "gazeboNormal"], of));
    expect(s.lifeForce).toBe(17);
    s.syncLifeForce(farmLifeForce(["crate"], of)); // the gazebo was stored away
    expect(s.lifeForce).toBe(1);
  });

  it("unlocks ability slot k from Life Force level k, not from boss wins", () => {
    const s = new GameState();
    expect([1, 2, 3, 4].map((k) => s.abilitySlotUnlocked(k))).toEqual([false, false, false, false]);
    s.syncLifeForce(30); // level 1
    expect([1, 2, 3, 4].map((k) => s.abilitySlotUnlocked(k))).toEqual([true, false, false, false]);
    s.syncLifeForce(150); // level 4
    expect([1, 2, 3, 4].map((k) => s.abilitySlotUnlocked(k))).toEqual([true, true, true, true]);
    expect(s.lifeForceLevel).toBe(4);
  });

  it("takes back the zombie a failed harvest had booked as grown and discovered", () => {
    const s = new GameState();
    s.recordHarvest("ZombieActorRegularTier1", true);
    s.recordZombieDiscovered("ZombieActorRegularTier1", 0);
    expect(s.stats.zombiesGrown).toBe(1);
    expect(s.zombieDiscovered.ZombieActorRegularTier1).toBe(1);

    s.unrecordZombieGrown("ZombieActorRegularTier1");
    expect(s.stats.zombiesGrown).toBe(0);
    expect(s.zombieDiscovered.ZombieActorRegularTier1).toBeUndefined();
  });

  it("only takes back one of several of the same species, and never goes below zero", () => {
    const s = new GameState();
    s.recordZombieDiscovered("ZombieActorRegularTier1", 0);
    s.recordZombieDiscovered("ZombieActorRegularTier1", 0);
    s.unrecordZombieGrown("ZombieActorRegularTier1");
    expect(s.zombieDiscovered.ZombieActorRegularTier1).toBe(1);
    s.unrecordZombieGrown("ZombieActorGardenTier1"); // never discovered: nothing to go negative
    expect(s.stats.zombiesGrown).toBe(0);
    expect(s.zombieDiscovered.ZombieActorGardenTier1).toBeUndefined();
  });
});
