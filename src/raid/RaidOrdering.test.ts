import { describe, it, expect } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";

// The Army screen lets the player set an attack order (click order = attack
// order) and preserves it across raids. partyView().orderedSelectedIds is the
// read side of that contract: it restores the saved order, drops zombies that
// are no longer deployed, and clamps to the current army cap. beginRaid writes
// state.raidAttackOrder; here we drive that field directly to pin the restore.

function fakeZombie(id: string, power: number) {
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
    stored: false,
  };
}

function makeManager(ids: string[]) {
  const state = new GameState();
  // roster() = every zombie; deployed() = the !stored ones. Give each a distinct
  // power (descending) so eligible's power-sort order is predictable = id order.
  const roster = ids.map((id, i) => fakeZombie(id, ids.length - i));
  const zombies = { roster: () => roster } as any;
  const raids = new RaidManager({} as any, state, zombies, { save: () => {} });
  return { state, raids };
}

describe("raid attack ordering — partyView restore", () => {
  it("starts empty on a first-ever raid", () => {
    const { raids } = makeManager(["a", "b", "c", "d"]);
    expect(raids.partyView().orderedSelectedIds).toEqual([]);
  });

  it("restores the saved order verbatim (not the power-sort)", () => {
    const { state, raids } = makeManager(["a", "b", "c", "d"]);
    // A deliberately non-power order the player chose last time.
    state.raidAttackOrder = ["c", "a", "d", "b"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["c", "a", "d", "b"]);
    // Sanity: the eligible list is still strongest-first, independent of order.
    expect(raids.partyView().eligible.map((z) => z.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops zombies that are no longer deployed", () => {
    const { state, raids } = makeManager(["a", "b", "c"]);
    // "x" was in the party last raid but has since died/been sold.
    state.raidAttackOrder = ["b", "x", "a"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["b", "a"]);
  });

  it("clamps the restored order to the current army cap", () => {
    const { state, raids } = makeManager(["a", "b", "c", "d", "e"]);
    state.zombieMax = 3; // cap = min(ARMY_CAP, zombieMax) = 3
    state.raidAttackOrder = ["e", "d", "c", "b", "a"];
    expect(raids.partyView().orderedSelectedIds).toEqual(["e", "d", "c"]);
  });
});
