import { describe, expect, it } from "vitest";
import placeables from "../../public/assets/placeables.json";
import type { GameAssets, PlaceableDef, ZombieDef } from "../assets";
import type { Field } from "../Field";
import { GameState } from "../GameState";
import { ZombieField } from "./ZombieField";

const tombs = (placeables as PlaceableDef[])
  .filter((entry) => /^mausoleum/.test(entry.key))
  .sort((a, b) => (a.zombieSlots ?? 0) - (b.zombieSlots ?? 0));

const def = { key: "ordinary", name: "Regular Zombie", group: "Regular" } as ZombieDef;

/** A ZombieField whose farm holds the given Mausoleum tier (undefined = none). */
const withMausoleum = (tier?: PlaceableDef, stored = 0) => {
  const field = {
    zombiePotId: () => "pot",
    mausoleumId: () => (tier ? "tomb" : null),
    objectDefOf: () => tier,
    inBounds: () => true,
    isPassable: () => true, // positionless saves arrive on the farmer's tile
    isOpenGround: () => true,
  } as unknown as Field;
  const zombies = new ZombieField(
    {} as GameAssets, field, new GameState(), (key) => (key === def.key ? def : undefined)
  );
  zombies.restore(Array.from({ length: stored }, (_, i) => ({ id: `z${i}`, key: def.key, stored: true })));
  return zombies;
};

describe("Mausoleum upgrade ladder", () => {
  it("ships ten tiers, each adding five slots for brains", () => {
    // Only the base building is bought (8 brains); every rung above it costs the
    // same flat 4, so the ladder never prices itself out of reach.
    expect(tombs.map((tier) => [tier.key, tier.cost, tier.zombieSlots])).toEqual([
      ["mausoleum3", 8, 15],
      ["mausoleum4", 4, 20],
      ["mausoleum5", 4, 25],
      ["mausoleum6", 4, 30],
      ["mausoleum7", 4, 35],
      ["mausoleum8", 4, 40],
      ["mausoleum9", 4, 45],
      ["mausoleum10", 4, 50],
      ["mausoleum11", 4, 55],
      ["mausoleum12", 4, 60],
    ]);
    // Every tier is a brain-priced functional building sharing the base art, so an
    // upgrade swaps capacity in place without changing how the farm looks.
    for (const tier of tombs) {
      expect(tier, tier.key).toMatchObject({
        category: "functional", brainsNeeded: true,
        sprite: tombs[0].sprite, tileW: tombs[0].tileW, tileH: tombs[0].tileH,
      });
    }
  });

  it("takes its capacity from the placed building's tier", () => {
    expect(withMausoleum(undefined).mausoleumCap).toBe(0);
    expect(withMausoleum(tombs[0]).mausoleumCap).toBe(15);
    expect(withMausoleum(tombs[1]).mausoleumCap).toBe(20);
    expect(withMausoleum(tombs[4]).mausoleumCap).toBe(35);
    expect(withMausoleum(tombs[tombs.length - 1]).mausoleumCap).toBe(60);
  });

  it("frees five more slots as soon as the building is upgraded", () => {
    expect(withMausoleum(tombs[0], 15).mausoleumFull).toBe(true);
    expect(withMausoleum(tombs[1], 15).mausoleumFull).toBe(false);
    // With no Mausoleum placed there is nowhere to store a zombie at all.
    expect(withMausoleum(undefined).mausoleumFull).toBe(true);
    expect(withMausoleum(undefined).store("z0")).toBe(false);
  });
});

describe("grantReward Almanac accounting", () => {
  /** Same stub farm as above, but keeping the GameState so the tally is readable.
   *  Grants are forced into the Mausoleum (`serverStored`) because the asset stub
   *  carries no zombie models to build a deployed actor from. */
  const harness = () => {
    const state = new GameState();
    const field = {
      zombiePotId: () => "pot",
      mausoleumId: () => "tomb",
      objectDefOf: () => tombs[0],
      inBounds: () => true,
      isPassable: () => true,
      isOpenGround: () => true,
    } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets, field, state, (key) => (key === def.key ? def : undefined)
    );
    return { zombies, state };
  };

  it("counts the species by default, at the moment the reward is earned", () => {
    const { zombies, state } = harness();
    zombies.grantReward(def.key, 0, 0, "earned", true);
    expect(state.zombieDiscovered[def.key]).toBe(1);
  });

  it("does not count again when a Received reward is claimed into a slot", () => {
    const { zombies, state } = harness();
    // Earned earlier and filed in Received, so the Almanac already holds it.
    state.recordZombieDiscovered(def.key, 0);
    zombies.grantReward(def.key, 0, 0, "claimed", true, { recordDiscovery: false });
    expect(state.zombieDiscovered[def.key]).toBe(1);
    expect(zombies.roster().map((unit) => unit.id)).toContain("claimed");
  });
});
