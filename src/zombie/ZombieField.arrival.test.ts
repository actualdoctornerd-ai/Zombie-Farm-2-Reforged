import { describe, expect, it, vi } from "vitest";
import { ZombieField } from "./ZombieField";
import type { ZombieDef } from "../assets";

const DEF = {
  key: "ZombieActorRegularTier1",
  name: "Regular Zombie",
  str: 1, dex: 1, con: 1, focus: 0, cost: 10,
} as unknown as ZombieDef;

// A field where the listed tiles are covered by an object, everything else walkable.
function fieldStub(blocked: string[], w = 30, h = 30) {
  const keys = new Set(blocked);
  const open = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < w && r < h && !keys.has(`${c},${r}`);
  return {
    inBounds: (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h,
    isPassable: open,
    isOpenGround: open, // no priced terrain in the stub: walkable == somewhere to stand
  };
}

// A ZombieField with only the collaborators the arrival path touches. Units land
// in `stored` so no real ZombieUnit (and no renderer) is built.
function subject(field: unknown, farmerTile: () => { col: number; row: number }) {
  const zombies = Object.create(ZombieField.prototype) as ZombieField;
  Object.assign(zombies, {
    units: [], stored: [], selected: null, harvesting: false, rosterLive: true,
    field,
    farmerTile,
    resolve: (key: string) => (key === DEF.key ? DEF : undefined),
    state: { setZombieCount: vi.fn(), recordZombieDiscovered: vi.fn(), recordMutationsDiscovered: vi.fn() },
  });
  return zombies;
}

const purchase = { id: "srv-1", key: DEF.key, mutation: 0, invasions: 0, stored: true };

describe("where a server-granted zombie turns up", () => {
  it("places a purchase the client never spawned on the farmer's tile", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));

    zombies.reconcileServerRoster([purchase]);

    const [unit] = zombies.roster();
    expect({ col: unit.col, row: unit.row }).toEqual({ col: 12, row: 9 });
  });

  it("snaps to open ground when the farmer is standing under an object", () => {
    // A 4x4 object over cols 10-13 / rows 8-11, with the farmer inside it.
    const blocked: string[] = [];
    for (let r = 8; r < 12; r++) for (let c = 10; c < 14; c++) blocked.push(`${c},${r}`);
    const zombies = subject(fieldStub(blocked), () => ({ col: 12, row: 9 }));

    zombies.reconcileServerRoster([purchase]);

    const [unit] = zombies.roster();
    expect(blocked).not.toContain(`${unit.col},${unit.row}`);
    // Nearest way out of that footprint, not the old (0,0) corner.
    expect(Math.abs(unit.col - 12)).toBeLessThanOrEqual(3);
    expect(Math.abs(unit.row - 9)).toBeLessThanOrEqual(3);
  });

  it("keeps the remembered position of a unit the reconcile already knows", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));
    Object.assign(zombies, {
      stored: [{ ...DEF, id: "srv-1", key: DEF.key, mutation: 0, invasions: 0, col: 3, row: 4 }],
    });

    // Same id, but a changed field forces the record to be rebuilt.
    zombies.reconcileServerRoster([{ ...purchase, invasions: 2 }]);

    const [unit] = zombies.roster();
    expect({ col: unit.col, row: unit.row }).toEqual({ col: 3, row: 4 });
  });

  it("credits the Almanac for a unit the client never spawned", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));

    zombies.reconcileServerRoster([purchase]);

    expect((zombies as never as { state: { recordZombieDiscovered: ReturnType<typeof vi.fn> } })
      .state.recordZombieDiscovered).toHaveBeenCalledWith(DEF.key, purchase.mutation);
  });

  // The mask rides along so the Mutation Almanac is credited by the same call. A
  // server-granted mutant is the case that has no other route: nothing on this client
  // spawned it, so nothing else would ever see what it is wearing.
  it("credits the mutations a server-granted zombie arrives wearing", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));

    zombies.reconcileServerRoster([{ ...purchase, mutation: 5 }]);

    expect((zombies as never as { state: { recordZombieDiscovered: ReturnType<typeof vi.fn> } })
      .state.recordZombieDiscovered).toHaveBeenCalledWith(DEF.key, 5);
  });

  // The online harvest. The client spawns the zombie the moment it is picked, with
  // mutation 0, and counts its species; the server rolls the crop mutations and hands
  // the unit back under its own id, aliased to the optimistic one. That arrival has a
  // source, so the species is (rightly) not counted again — and, before this, neither
  // was anything else: a Tomatohead grown online never lit its Almanac entry.
  it("credits the server's mask when an aliased optimistic harvest is reconciled", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));
    Object.assign(zombies, {
      stored: [{ ...DEF, id: "local-7", key: DEF.key, mutation: 0, invasions: 0, col: 3, row: 4 }],
    });

    zombies.reconcileServerRoster([{ ...purchase, id: "srv-9", mutation: 5 }], { "srv-9": "local-7" });

    const state = (zombies as never as {
      state: { recordZombieDiscovered: ReturnType<typeof vi.fn>; recordMutationsDiscovered: ReturnType<typeof vi.fn> };
    }).state;
    expect(state.recordMutationsDiscovered).toHaveBeenCalledWith(5);
    expect(state.recordZombieDiscovered).not.toHaveBeenCalled();
    // And it is still the same zombie, in the same place.
    const [unit] = zombies.roster();
    expect({ id: unit.id, col: unit.col, row: unit.row, mutation: unit.mutation })
      .toEqual({ id: "srv-9", col: 3, row: 4, mutation: 5 });
  });

  it("credits only the bits a known unit gained, not the ones it already wore", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));
    Object.assign(zombies, {
      stored: [{ ...DEF, id: "srv-1", key: DEF.key, mutation: 1, invasions: 0, col: 3, row: 4 }],
    });

    zombies.reconcileServerRoster([{ ...purchase, mutation: 1 + 4 }]);

    const state = (zombies as never as {
      state: { recordMutationsDiscovered: ReturnType<typeof vi.fn> };
    }).state;
    expect(state.recordMutationsDiscovered).toHaveBeenCalledTimes(1);
    expect(state.recordMutationsDiscovered).toHaveBeenCalledWith(4);
  });

  it("credits nothing when a known unit comes back with the mask it already had", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));
    Object.assign(zombies, {
      stored: [{ ...DEF, id: "srv-1", key: DEF.key, mutation: 5, invasions: 0, col: 3, row: 4 }],
    });

    // A changed field forces the record to be rebuilt; the mask is unchanged.
    zombies.reconcileServerRoster([{ ...purchase, mutation: 5, invasions: 2 }]);

    const state = (zombies as never as {
      state: { recordZombieDiscovered: ReturnType<typeof vi.fn>; recordMutationsDiscovered: ReturnType<typeof vi.fn> };
    }).state;
    expect(state.recordMutationsDiscovered).not.toHaveBeenCalled();
    expect(state.recordZombieDiscovered).not.toHaveBeenCalled();
  });

  it("does not credit the Almanac for a zombie returned by a cancelled sale", () => {
    // Listing on the Black Market escrows the unit (the reconcile removes it) and
    // cancelling hands it back under a NEW server id, so it looks like a first-time
    // arrival. Counting it let list/cancel cycles inflate the lifetime count.
    const zombies = subject(fieldStub([]), () => ({ col: 12, row: 9 }));

    zombies.reconcileServerRoster([{ ...purchase, id: "srv-restored", restored: true }]);

    expect(zombies.roster()).toHaveLength(1);
    expect((zombies as never as { state: { recordZombieDiscovered: ReturnType<typeof vi.fn> } })
      .state.recordZombieDiscovered).not.toHaveBeenCalled();
  });

  it("restores a legacy save with no stored position onto the farmer", () => {
    const zombies = subject(fieldStub([]), () => ({ col: 7, row: 6 }));

    zombies.restore([
      { id: "z1", key: DEF.key, name: "Old One", invasions: 0, mutation: 0, stored: true },
    ] as never);

    const [unit] = zombies.roster();
    expect({ col: unit.col, row: unit.row }).toEqual({ col: 7, row: 6 });
  });
});

// A zombie collected from a Zombie Pot belongs to the POT, not to whoever pressed
// the button. Collecting from across the farm used to hand the child to the farmer,
// which reads as the farmer having grown it himself.
describe("where a zombie collected from an object turns up", () => {
  // The Pot covers cols 10-11 / rows 8-9; its anchor tile is the front corner (11,9).
  function potField() {
    const blocked: string[] = [];
    for (let r = 8; r < 10; r++) for (let c = 10; c < 12; c++) blocked.push(`${c},${r}`);
    return {
      ...fieldStub(blocked),
      objectAnchorTile: (id: string) => (id === "pot-1" ? { col: 11, row: 9 } : null),
    };
  }

  it("puts the child on open ground beside the pot, not on the farmer", () => {
    const field = potField();
    const zombies = subject(field, () => ({ col: 2, row: 2 }));

    const at = zombies.objectArrivalTile("pot-1");

    expect(field.isOpenGround(at.col, at.row)).toBe(true);
    expect(Math.abs(at.col - 11)).toBeLessThanOrEqual(1);
    expect(Math.abs(at.row - 9)).toBeLessThanOrEqual(1);
  });

  it("falls back to the farmer when the pot is gone", () => {
    // Sold, or dropped by an object reconcile, between opening the panel and the
    // collection landing. (0,0) is not an answer — see arrivalTile.
    const zombies = subject(potField(), () => ({ col: 2, row: 3 }));

    expect(zombies.objectArrivalTile("pot-gone")).toEqual({ col: 2, row: 3 });
    expect(zombies.objectArrivalTile(null)).toEqual({ col: 2, row: 3 });
  });
});
