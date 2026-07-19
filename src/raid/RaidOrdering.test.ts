import { describe, it, expect } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";

// The Army screen lets the player set an attack order (click order = attack
// order) and preserves it across raids. partyView().orderedSelectedIds is the
// read side of that contract: it restores the saved order for both the cards and
// selection, drops zombies that are no longer deployed, and clamps selection to
// the current army cap. beginRaid writes state.raidAttackOrder; here we drive that
// field directly to pin the restore.

function fakeZombie(id: string, power: number, mutation = 0) {
  // partyView reads id/name/typeName/key/str/dex/con/focus and `stored`.
  return {
    id,
    key: "ZombieActorRegularTier1",
    name: id,
    typeName: "Zombie",
    str: power,
    dex: 1,
    con: 1,
    focus: 0,
    mutation,
    color: mutation ? [120, 140, 160] as [number, number, number] : undefined,
    stored: false,
  };
}

function makeManager(ids: string[]) {
  const state = new GameState();
  // roster() = every zombie; deployed() = the !stored ones. Its array order is
  // the harvest-order fallback shown after any surviving previous-raid units.
  const roster = ids.map((id, i) => fakeZombie(id, ids.length - i));
  const zombies = { roster: () => roster } as any;
  const raids = new RaidManager({} as any, state, zombies, { save: () => {} });
  return { state, raids };
}

describe("raid attack ordering — partyView restore", () => {
  it("preserves per-unit mutation appearance data for army-card portraits", () => {
    const state = new GameState();
    const zombie = fakeZombie("mutant", 5, 1 | 8);
    const raids = new RaidManager(
      {} as any,
      state,
      { roster: () => [zombie] } as any,
      { save: () => {} },
    );

    expect(raids.partyView().eligible[0]).toMatchObject({
      id: "mutant",
      key: "ZombieActorRegularTier1",
      mutation: 1 | 8,
      color: [120, 140, 160],
    });
  });

  it("starts empty on a first-ever raid", () => {
    const { raids } = makeManager(["a", "b", "c", "d"]);
    expect(raids.partyView().orderedSelectedIds).toEqual([]);
  });

  it("puts the saved raid order first in both selection and visual order", () => {
    const { state, raids } = makeManager(["a", "b", "c", "d"]);
    // A deliberately non-power order the player chose last time.
    state.raidAttackOrder = ["c", "a", "d", "b"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["c", "a", "d", "b"]);
    expect(raids.partyView().eligible.map((z) => z.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("drops zombies that are no longer deployed", () => {
    const { state, raids } = makeManager(["a", "b", "c"]);
    // "x" was in the party last raid but has since died/been sold.
    state.raidAttackOrder = ["b", "x", "a"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["b", "a"]);
    expect(raids.partyView().eligible.map((z) => z.id)).toEqual(["b", "a", "c"]);
  });

  it("clamps the restored order to the current army cap", () => {
    const { state, raids } = makeManager(["a", "b", "c", "d", "e"]);
    state.zombieMax = 3; // cap = min(ARMY_CAP, zombieMax) = 3
    state.raidAttackOrder = ["e", "d", "c", "b", "a"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["e", "d", "c"]);
  });
});
