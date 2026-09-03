import { describe, it, expect } from "vitest";
import { GameState } from "./GameState";
import { encodeReceivedZombie } from "./zombie/receivedReward";

// The shed's contents are owned by the OBJECT projection: a packed decoration is a
// server object with status "stored", adopted through syncObjectStorage. The legacy
// `storage.stored` bucket that syncStorage carries is empty for every account that
// packs things away that way, and syncStorage runs FIRST on every authoritative
// response — so adopting it verbatim emptied the shed and relied on the (async,
// supersedable) object reconcile to put it back. These pin that it no longer can.

describe("GameState item storage projections", () => {
  it("does not empty the shed when the legacy storage bucket is empty", () => {
    const s = new GameState();
    s.syncObjectStorage({ beachBall: 2, windmill: 1 });
    expect(s.storedItemTotal()).toBe(3);

    // A later authoritative response (balance change, raid settle, upgrade...).
    s.syncStorage({ "Rusty Fragment": 1 }, {});

    expect(s.storedItems).toEqual([{ key: "beachBall", count: 2 }, { key: "windmill", count: 1 }]);
    expect(s.received).toEqual(["Rusty Fragment"]);
  });

  it("still adopts a legacy bucket that actually holds items", () => {
    const s = new GameState();
    s.syncObjectStorage({ beachBall: 2 });
    s.syncStorage({}, { windmill: 3 });
    expect(s.storedItems).toEqual([{ key: "windmill", count: 3 }]);
  });

  it("lets the object projection empty the shed when the last item is retrieved", () => {
    const s = new GameState();
    s.syncObjectStorage({ beachBall: 1 });
    s.syncObjectStorage({});
    expect(s.storedItems).toEqual([]);
  });

  it("keeps the shed intact across a capacity upgrade", () => {
    const s = new GameState();
    s.syncObjectStorage({ beachBall: 1 });
    s.syncShedCapacity(16);
    s.syncCapacities(16, 16);
    expect(s.storageItemCap).toBe(16);
    expect(s.storedItems).toEqual([{ key: "beachBall", count: 1 }]);
  });
});

// The Almanac is a collection of what the player OWNS, and an earned reward parked in
// Received is owned — it just has not been moved into a slot yet. A grant path that
// filed one there used to leave the species silhouetted until it was claimed.
describe("Almanac counts unclaimed reward zombies", () => {
  const marker = (key: string, id = "r1") =>
    encodeReceivedZombie({ id, key, mutation: 0, invasions: 0 });

  it("counts a reward zombie sitting in the online Received bucket", () => {
    const s = new GameState();
    s.syncStorage({ [marker("ZombieActorOmegaDrZombie")]: 1 }, {});
    expect(s.zombieDiscovered.ZombieActorOmegaDrZombie).toBe(1);
  });

  it("counts every unclaimed copy", () => {
    const s = new GameState();
    s.syncStorage({
      [marker("ZombieActorDrZombie", "a")]: 1,
      [marker("ZombieActorDrZombie", "b")]: 1,
    }, {});
    expect(s.zombieDiscovered.ZombieActorDrZombie).toBe(2);
  });

  it("is a floor, not an increment — repeated syncs cannot inflate the tally", () => {
    const s = new GameState();
    const received = { [marker("ZombieActorOmegaDrZombie")]: 1 };
    s.syncStorage(received, {});
    s.syncStorage(received, {});
    s.syncStorage(received, {});
    expect(s.zombieDiscovered.ZombieActorOmegaDrZombie).toBe(1);
  });

  it("never lowers a count already earned at grant time", () => {
    const s = new GameState();
    for (let i = 0; i < 6; i++) s.recordZombieDiscovered("ZombieActorDrZombie", 0);
    s.syncStorage({ [marker("ZombieActorDrZombie")]: 1 }, {});
    expect(s.zombieDiscovered.ZombieActorDrZombie).toBe(6);
  });

  it("counts an offline award the moment it lands in Received", () => {
    const s = new GameState();
    s.receiveItem(marker("ZombieActorOmegaDrZombie"));
    expect(s.zombieDiscovered.ZombieActorOmegaDrZombie).toBe(1);
  });

  it("ignores ordinary decor entries", () => {
    const s = new GameState();
    s.syncStorage({ "Dr. Groundhog's Tricycle": 1 }, {});
    expect(s.zombieDiscovered).toEqual({});
  });
});
