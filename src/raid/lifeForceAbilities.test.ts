import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { abilitySlotUnlocked } from "../lifeForce";
import { activeAbilities } from "../zombie/abilities";
import { makeOwned } from "../zombie/types";
import { buildPlayerUnits } from "./CombatEngine";

// Ability slot k works when the farm's Life Force level is at least k. The gate is the SLOT
// a zombie carries the ability in; beating the matching boss no longer unlocks anything.

const defs = zombieRows as unknown as ZombieDef[];
const silver = defs.find((z) => z.className === "Silver" && z.group === "Regular" && z.category === "normal")!;
const green = defs.find((z) => z.className === "Green" && z.group === "Regular" && z.category === "normal")!;
const gateAt = (level: number) => (slot: number) => abilitySlotUnlocked(slot, level);

describe("ability slots follow the Life Force level", () => {
  it("opens one slot per level on a Silver zombie, which has all four", () => {
    const unit = makeOwned("a", silver as never, 0, 0, 0, 0);
    expect([0, 1, 2, 3, 4, 7].map((level) => activeAbilities(unit, gateAt(level)).length))
      .toEqual([0, 1, 2, 3, 4, 4]);
    // The abilities that open are the SLOTS in order, so slot 1's ability always comes first.
    expect(activeAbilities(unit, gateAt(2))).toEqual(activeAbilities(unit, gateAt(4)).slice(0, 2));
  });

  it("limits a Green zombie to its one slot, however high the level", () => {
    const unit = makeOwned("g", green as never, 0, 0, 0, 0);
    expect(activeAbilities(unit, gateAt(0))).toEqual([]);
    expect(activeAbilities(unit, gateAt(1)).length).toBe(1);
    expect(activeAbilities(unit, gateAt(10)).length).toBe(1);
  });

  it("does not depend on any boss having been beaten", () => {
    // The gate is a function of the slot alone: nothing about raids is in its signature.
    const unit = makeOwned("a", silver as never, 0, 0, 0, 0);
    const keys = activeAbilities(unit, (slot) => slot <= 3);
    expect(keys.length).toBe(3);
  });

  it("builds fighting units whose abilities match the slots that are open", () => {
    const unit = makeOwned("a", silver as never, 0, 0, 0, 0);
    const closed = buildPlayerUnits([unit], { abilitySlotUnlocked: gateAt(0) })[0];
    const open = buildPlayerUnits([unit], { abilitySlotUnlocked: gateAt(4) })[0];
    expect(closed.abilities ?? []).toEqual([]);
    expect(open.abilities?.length ?? 0).toBeGreaterThan(0);
  });

  it("runs with abilities off when no gate is supplied", () => {
    const unit = makeOwned("a", silver as never, 0, 0, 0, 0);
    expect(buildPlayerUnits([unit])[0].abilities ?? []).toEqual([]);
  });
});
