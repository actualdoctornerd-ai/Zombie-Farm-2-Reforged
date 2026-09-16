import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../net/api";
import { SaveManager } from "./SaveManager";
import { activeSaveKey } from "./profiles";
import { SAVE_VERSION } from "./schema";
import { MAX_REMEMBERED_FALLEN } from "../zombie/memorial";
import { mergeFarmStats, newFarmStats } from "../stats";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
};

describe("SaveManager presentation conflicts", () => {
  it("adopts the committed server version after a lost PUT response", async () => {
    const manager = new SaveManager(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new Map(),
      new Map(),
      async () => undefined,
    );
    const first = { camera: { x: 1, y: 2 } };
    const second = { camera: { x: 3, y: 4 } };
    const put = vi.spyOn(api, "putPresentationV3")
      .mockRejectedValueOnce(new api.ApiError(409, "presentation_conflict"))
      .mockResolvedValueOnce({ version: 2, data: second });
    vi.spyOn(api, "bootstrap").mockResolvedValue({
      presentation: { version: 1, data: first },
    } as never);

    await (manager as any).push(first);
    await (manager as any).push(second);

    expect(api.bootstrap).toHaveBeenCalledWith(true);
    expect(put).toHaveBeenNthCalledWith(2, {
      protocolVersion: 3,
      expectedVersion: 1,
      data: second,
    });
    expect((manager as any).presentationDirty).toBe(false);
  });
});

describe("SaveManager object layout races", () => {
  it("retains a removed object's position until authoritative settlement", () => {
    const field = {
      serializeObjects: vi.fn()
        .mockReturnValueOnce([{ id: "candle-1", key: "candle", oc: 8, or: 9 }])
        .mockReturnValueOnce([]),
    };
    const manager = new SaveManager(
      {} as never, field as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    vi.spyOn(manager, "serialize").mockImplementation(() => ({
      version: 1,
      savedAt: 1,
      player: { name: "Tester", farmerAppearance: {} },
      farm: { fieldId: "default", w: 30, h: 30, climate: "grass", plots: [] },
      objects: field.serializeObjects(),
    } as never));

    expect((manager as any).presentation().objectLayout).toEqual([
      { id: "candle-1", oc: 8, or: 9, rotation: undefined },
    ]);
    expect((manager as any).presentation().objectLayout).toEqual([
      { id: "candle-1", oc: 8, or: 9, rotation: undefined },
    ]);

    manager.reconcileObjectLayouts(new Set());
    expect((manager as any).presentation().objectLayout).toEqual([]);
  });

  // The shed's chosen look rides the layout row, beside its position and rotation,
  // because it is the same kind of fact: client-authored decoration of an object
  // whose real type the server owns. The row must never restate that type — a skin
  // that arrived as `key` would be a second, contradictory answer to "what tier is
  // standing here", and capacity is read from the first.
  it("carries a shed's appearance override without touching its real key", () => {
    const field = {
      serializeObjects: vi.fn().mockReturnValue(
        [{ id: "shed-1", key: "storage07", oc: 3, or: 4, skin: "storage01" }]),
    };
    const manager = new SaveManager(
      {} as never, field as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    vi.spyOn(manager, "serialize").mockImplementation(() => ({
      version: 1,
      savedAt: 1,
      player: { name: "Tester", farmerAppearance: {} },
      farm: { fieldId: "default", w: 30, h: 30, climate: "grass", plots: [] },
      objects: field.serializeObjects(),
    } as never));

    const [row] = (manager as any).presentation().objectLayout;
    expect(row.skin).toBe("storage01");
    expect(row.key).toBeUndefined(); // only the free starter shed ever writes one
  });
});

describe("SaveManager mode isolation", () => {
  it("replays an Online Farm journal only after the command channel is ready", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue({ accountId: "restore-owner" } as never);
    const jobs = {
      restorePending: vi.fn().mockReturnValue(true),
      serializePending: vi.fn().mockReturnValue(undefined),
    };
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map([["carrot", { key: "carrot" } as never]]), new Map(),
      async () => undefined, "online", jobs as never,
    );
    const journal = {
      savedAt: 123,
      jobs: [{ kind: "plant" as const, oc: 4, or: 6, cx: 10, cy: 20, cropKey: "carrot" }],
    };
    (manager as any).pendingOnlineJobs = journal;

    expect(jobs.restorePending).not.toHaveBeenCalled();
    manager.restoreOnlineJobs();
    manager.restoreOnlineJobs();

    expect(jobs.restorePending).toHaveBeenCalledOnce();
    expect(jobs.restorePending).toHaveBeenCalledWith(journal, expect.any(Function));
  });

  it("re-offers a parked journal that JobSystem refused because the queue was busy", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue({ accountId: "busy-owner" } as never);
    // A plow tapped while the tab was still booting leaves the queue busy, so
    // restorePending declines the first offer and accepts once that job finishes.
    const restorePending = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const jobs = { restorePending, serializePending: vi.fn().mockReturnValue(undefined) };
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online", jobs as never,
    );
    const journal = {
      savedAt: 123,
      jobs: [{ kind: "plant" as const, oc: 4, or: 6, cx: 10, cy: 20, cropKey: "carrot" }],
    };
    (manager as any).pendingOnlineJobs = journal;
    const key = `${(manager as any).cacheKey()}::farm-jobs`;
    localStorage.setItem(key, JSON.stringify(journal)); // as hydration left it on disk

    manager.restoreOnlineJobs();
    expect((manager as any).pendingOnlineJobs).toBe(journal);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(journal);

    manager.checkpointJobs(); // the live job completed -> queue change -> retry
    expect(restorePending).toHaveBeenCalledTimes(2);
    expect((manager as any).pendingOnlineJobs).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("keeps a parked Online Farm journal through pre-writer checkpoints", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue({ accountId: "parked-owner" } as never);
    vi.spyOn(api, "isConfigured").mockReturnValue(false);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
      { serializePending: vi.fn().mockReturnValue(undefined) } as never,
    );
    const journal = {
      savedAt: 123,
      jobs: [{ kind: "plant" as const, oc: 4, or: 6, cx: 10, cy: 20, cropKey: "carrot" }],
    };
    (manager as any).pendingOnlineJobs = journal;
    vi.spyOn(manager, "serialize").mockReturnValue({ farmJobs: undefined } as never);

    manager.save();

    const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .find((candidate) => candidate.endsWith("::farm-jobs"));
    expect(JSON.parse(localStorage.getItem(key!) ?? "null")).toEqual(journal);
  });

  it("keeps a parked journal retryable when restoration throws", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue({ accountId: "retry-owner" } as never);
    const jobs = { restorePending: vi.fn(() => { throw new Error("restore failed"); }) };
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online", jobs as never,
    );
    const journal = { savedAt: 123, jobs: [{ kind: "plow" as const, oc: 1, or: 2, cx: 3, cy: 4 }] };
    (manager as any).pendingOnlineJobs = journal;

    expect(() => manager.restoreOnlineJobs()).toThrow("restore failed");
    expect((manager as any).pendingOnlineJobs).toBe(journal);
  });

  it("translates authoritative timers before hydrating the first online frame", () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    const save = (manager as any).fromBootstrap({
      serverTime: 10_000,
      presentation: { data: { objectLayout: [{ id: "tree-1", oc: 4, or: 5 }] } },
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, zombieMax: 16, zombiePotBought: false,
        farmerHeads: [1], farmerHeadId: 1, ownedPets: [], activePet: null, penPets: [],
        farmSize: 30, climates: ["grass"], inventory: {},
        storage: { stored: {}, received: {} },
        farm: { plots: { "1:2": { state: "planted", cropKey: "carrot", zombie: false,
          plantedAt: 9_000, growMs: 60_000, fertilized: false } } },
        objects: { objects: [{ status: "placed", instanceId: "tree-1", catalogKey: "fruitTreeApple",
          readyAt: 12_000 }] },
        roster: [], quests: { progress: [], completed: [] },
        raids: { progress: {}, lastRaidAt: 8_000 }, epicBoss: null, tutorialRewarded: false,
      },
      social: { friends: [] },
    });

    expect(save.farm.plots[0].crop.plantedAt).toBe(19_000);
    expect(save.objects[0].readyAt).toBe(22_000);
    expect(save.raids.lastRaidAt).toBe(18_000);
  });

  // A placed object with no layout entry used to be fabricated onto (0,0). Several at
  // once all landed on that one tile, Field.restoreObjects kept the first and silently
  // dropped the rest, and the next presentation — written from the field — erased them
  // for good. They must be left for the reconcile's re-home path instead.
  it("omits placed objects that have no saved position instead of stacking them on 0,0", () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    const save = (manager as any).fromBootstrap({
      serverTime: 10_000,
      presentation: { data: { objectLayout: [{ id: "placed-1", oc: 7, or: 9 }] } },
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, zombieMax: 16, zombiePotBought: false,
        farmerHeads: [1], farmerHeadId: 1, ownedPets: [], activePet: null, penPets: [],
        farmSize: 30, climates: ["grass"], inventory: {},
        storage: { stored: {}, received: {} }, farm: { plots: {} },
        objects: { objects: [
          { status: "placed", instanceId: "placed-1", catalogKey: "flowerBed" },
          { status: "placed", instanceId: "no-layout-1", catalogKey: "flowerBed" },
          { status: "placed", instanceId: "no-layout-2", catalogKey: "flowerBed" },
        ] },
        roster: [], quests: { progress: [], completed: [] },
        raids: { progress: {}, lastRaidAt: 0 }, epicBoss: null, tutorialRewarded: false,
      },
      social: { friends: [] },
    });

    expect(save.objects).toEqual([
      { id: "placed-1", key: "flowerBed", oc: 7, or: 9, rotation: undefined, readyAt: undefined },
    ]);
  });

  // The graveyard cap counts the zombies WAITING for a statue. Capping the projection
  // as one list dropped whatever was oldest, and a statue's occupant is exactly the
  // record most likely to be old — so a memorial bought long ago hydrated as a bare
  // plinth once MAX_REMEMBERED_FALLEN more zombies had died behind it, and the client
  // would then let the player re-enshrine a plinth the server refuses as occupied.
  it("keeps a statue's occupant however far past the graveyard cap it died", () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    // The occupant is the OLDEST loss on the account, buried under a full graveyard.
    const occupant = { id: "old-friend", key: "ZombieActorRegularTier1", name: "Rufus",
      mutation: 0, invasions: 7, diedAt: 1, memorialObjectId: "statue-1" };
    const recent = Array.from({ length: MAX_REMEMBERED_FALLEN + 5 }, (_, i) => ({
      id: `z${i}`, key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, diedAt: 1_000 + i,
    }));
    const save = (manager as any).fromBootstrap({
      serverTime: 10_000,
      presentation: { data: { objectLayout: [{ id: "statue-1", oc: 2, or: 3 }] } },
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, zombieMax: 16, zombiePotBought: false,
        farmerHeads: [1], farmerHeadId: 1, ownedPets: [], activePet: null, penPets: [],
        farmSize: 30, climates: ["grass"], inventory: {},
        storage: { stored: {}, received: {} }, farm: { plots: {} },
        objects: { objects: [
          { status: "placed", instanceId: "statue-1", catalogKey: "memorialStatue" },
        ] },
        roster: [], fallen: [occupant, ...recent], quests: { progress: [], completed: [] },
        raids: { progress: {}, lastRaidAt: 0 }, epicBoss: null, tutorialRewarded: false,
      },
      social: { friends: [] },
    });

    expect(save.objects[0].memorial).toMatchObject({ id: "old-friend", name: "Rufus" });
    // …and the graveyard is still capped, with the enshrined one kept out of it.
    expect(save.fallen).toHaveLength(MAX_REMEMBERED_FALLEN);
    expect(save.fallen.map((unit: { id: string }) => unit.id)).not.toContain("old-friend");
  });

  it("keeps online farmer intentions in an account-scoped device journal", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue({ accountId: "queue-owner" } as never);
    const jobs = {
      serializePending: vi.fn().mockReturnValue({
        savedAt: 123,
        jobs: [{ kind: "plant", oc: 4, or: 6, cx: 10, cy: 20, cropKey: "carrot" }],
      }),
    };
    const manager = new SaveManager(
      { name: "Tester", ownedFarmerHeads: [], ownedFarmerBodies: [], farmerHeadId: 1, farmerBodyId: 0,
        ownedPets: [], activePet: null, penPets: [], ownedClimates: [], boostInv: [], storageItemCap: 8,
        storedItems: [], received: [], raidsCompleted: {}, lastRaidAt: 0, raidAttackOrder: [], friends: [] } as never,
      { w: 30, h: 30, climate: "grass", serialize: () => [], serializeObjects: () => [] } as never,
      { tile: { col: 0, row: 0 } } as never,
      { serialize: () => [], serializePots: () => undefined, isGathered: false } as never,
      { serialize: () => undefined } as never,
      new Map(), new Map(), async () => undefined, "online", jobs as never,
    );

    const pending = manager.serialize().farmJobs;
    (manager as any).writeJobJournal(pending);

    const journalKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .find((key) => key.endsWith("::farm-jobs"));
    expect(journalKey).toContain("queue-owner");
    expect(JSON.parse(localStorage.getItem(journalKey!) ?? "null")).toEqual({
      savedAt: 123,
      jobs: [{ kind: "plant", oc: 4, or: 6, cx: 10, cy: 20, cropKey: "carrot" }],
    });
  });

  it("exports an Online Farm as a file Local Farm's import accepts", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const online = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    vi.spyOn(online, "serialize").mockReturnValue({
      version: SAVE_VERSION,
      savedAt: 5,
      player: { name: "Tester", gold: 900, brains: 4, xp: 1200 },
      farm: { fieldId: "default", w: 34, h: 34, plots: [] },
      ownedZombies: [{ id: "z-1", key: "regular" }],
      // Account-scoped: the online friends list is the server's, the journal's
      // commands may already have committed, and `reserved` is a server-held lock.
      social: { friends: [{ id: "f-1", name: "Friend" }] },
      farmJobs: { savedAt: 5, jobs: [{ kind: "harvest", oc: 1, or: 2, cx: 3, cy: 4 }] },
      zombiePots: { "pot-1": { keyA: "regular", keyB: "regular", maskA: 0, maskB: 0,
        reserved: true, startedAt: 1, finishAt: 9 } },
    } as never);

    const raw = online.exportOnline();
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw!);
    expect(blob.player.gold).toBe(900);
    expect(blob.ownedZombies).toEqual([{ id: "z-1", key: "regular" }]);
    expect(blob.social).toBeUndefined();
    expect(blob.farmJobs).toBeUndefined();
    expect(blob.zombiePots["pot-1"].reserved).toBeUndefined();
    expect(blob.zombiePots["pot-1"].finishAt).toBe(9);

    const local = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );
    expect(local.importLocal(raw!)).toBe(true);
    expect(JSON.parse(localStorage.getItem(activeSaveKey()) ?? "null")).toMatchObject({
      player: { gold: 900 },
      farm: { w: 34 },
    });
  });

  // Export is one-way: a file leaves the account, and nothing loads one back into it.
  it("keeps each farm's export/import on its own side", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const online = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    const local = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );
    const file = JSON.stringify({
      version: SAVE_VERSION, savedAt: 1,
      player: { name: "Tester", gold: 1 }, farm: { fieldId: "default", w: 30, h: 30, plots: [] },
    });

    expect(online.importLocal(file)).toBe(false);
    expect(online.exportLocal()).toBeNull();
    expect(local.exportOnline()).toBeNull();
    expect(localStorage.getItem(activeSaveKey())).toBeNull();
  });

  it("never falls back to a Local Farm write from Online Farm", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "isConfigured").mockReturnValue(false);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    vi.spyOn(manager, "serialize").mockReturnValue({ version: 1, savedAt: 1 } as never);

    manager.save();

    expect(localStorage.length).toBe(0);
  });

  it("rotates a last-known-good backup for Local Farm", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );
    const first = { version: 1, savedAt: 1 };
    const second = { version: 1, savedAt: 2 };

    (manager as any).writeLocal(first);
    (manager as any).writeLocal(second);

    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!);
    const primary = keys.find((key) => !key.endsWith(".backup") && !key.endsWith(".tmp") && key.includes("local.save"));
    expect(primary).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(primary!) ?? "null")).toMatchObject(second);
    expect(JSON.parse(localStorage.getItem(`${primary}.backup`) ?? "null")).toMatchObject(first);
  });

  it("does not rewrite a farm after persistence is suspended for a switch or reset", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );
    const write = vi.spyOn(manager as any, "writeLocal");

    manager.suspend();
    manager.flushCritical();

    expect(write).not.toHaveBeenCalled();
  });

  it("does not treat an existing but unreadable Local Farm as a new farm", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );
    const key = activeSaveKey();
    const stored = JSON.stringify({
      version: 1,
      savedAt: 123,
      player: { name: "Preserve Me" },
      farm: { plots: [] },
    });
    localStorage.setItem(key, stored);
    vi.spyOn(manager as any, "applySave").mockRejectedValue(new Error("temporary hydrate failure"));

    await expect(manager.load()).resolves.toEqual({
      kind: "local-unavailable",
      reason: "save_unreadable",
    });
    expect(localStorage.getItem(key)).toBe(stored);
  });

  it("reports unavailable storage instead of creating a disposable Local Farm", async () => {
    const blocked = memoryStorage();
    blocked.getItem = () => { throw new Error("storage blocked"); };
    vi.stubGlobal("localStorage", blocked);
    const manager = new SaveManager(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "local",
    );

    await expect(manager.load()).resolves.toEqual({
      kind: "local-unavailable",
      reason: "storage_unavailable",
    });
  });
});

// The lifetime tally (src/stats.ts) is counted by this client and stored by nobody
// else: there is no server table it could be rebuilt from, so if it does not ride
// the presentation blob it is simply lost at every online sign-in.
describe("SaveManager lifetime statistics", () => {
  it("carries the tally in the presentation blob", () => {
    const manager = new SaveManager(
      {} as never, { serializeObjects: () => [] } as never, {} as never, {} as never,
      {} as never, new Map(), new Map(), async () => undefined, "online",
    );
    const stats = newFarmStats(1_800_000_000_000);
    stats.harvested = { carrot: 412 };
    stats.plowed = 480;
    vi.spyOn(manager, "serialize").mockReturnValue({
      version: SAVE_VERSION,
      savedAt: 1,
      player: { name: "Tester", farmerAppearance: {} },
      farm: { fieldId: "default", w: 30, h: 30, climate: "grass", plots: [] },
      objects: [],
      stats,
    } as never);

    const ui = ((manager as any).presentation() as { ui: { stats?: unknown } }).ui;

    expect(ui.stats).toEqual(stats);
  });

  // The blob is written WHOLESALE. Losing the version CAS means another device wrote
  // in between — the one case where the server holds counts this device has never
  // seen — so re-pushing our own tally verbatim would roll the account back to
  // whatever this browser happened to have counted.
  it("keeps the other device's higher counts when a write loses the CAS", async () => {
    const mine = newFarmStats(2_000);
    mine.plowed = 40;
    mine.harvested = { carrot: 100 };
    const theirs = newFarmStats(1_000);
    theirs.plowed = 12;         // this device is ahead here…
    theirs.raidsWon = 7;        // …and behind here
    theirs.harvested = { carrot: 90, pumpkin: 60 };
    const state = { stats: mine, mergeStats: (incoming: never) => (state.stats = mergeFarmStats(state.stats, incoming)) };
    const manager = new SaveManager(
      state as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    const put = vi.spyOn(api, "putPresentationV3")
      .mockRejectedValueOnce(new api.ApiError(409, "presentation_conflict"))
      .mockResolvedValueOnce({ version: 6, data: {} } as never);
    vi.spyOn(api, "bootstrap").mockResolvedValue({
      presentation: { version: 5, data: { camera: { x: 9 }, ui: { stats: theirs } } },
    } as never);

    await (manager as any).push({ ui: { attackOrder: [], teams: [], stats: mine } });

    const sent = put.mock.calls[1][0].data as { ui: { stats: typeof mine } };
    expect(sent.ui.stats).toMatchObject({
      startedAt: 1_000, // the earlier claim: counting began then
      plowed: 40,       // ours survives
      raidsWon: 7,      // theirs is adopted
      harvested: { carrot: 100, pumpkin: 60 },
    });
  });

  // A blob written by a client older than the tally has no `ui.stats` at all. There is
  // nothing to merge, and treating its silence as zeroes would be the very rollback
  // the merge exists to prevent.
  it("does not read an older client's silence as a reset", async () => {
    const mine = newFarmStats(2_000);
    mine.plowed = 40;
    const state = { stats: mine, mergeStats: vi.fn() };
    const manager = new SaveManager(
      state as never, {} as never, {} as never, {} as never, {} as never,
      new Map(), new Map(), async () => undefined, "online",
    );
    const put = vi.spyOn(api, "putPresentationV3")
      .mockRejectedValueOnce(new api.ApiError(409, "presentation_conflict"))
      .mockResolvedValueOnce({ version: 6, data: {} } as never);
    vi.spyOn(api, "bootstrap").mockResolvedValue({
      presentation: { version: 5, data: { ui: { attackOrder: [], teams: [] } } },
    } as never);

    await (manager as any).push({ ui: { attackOrder: [], teams: [], stats: mine } });

    expect(state.mergeStats).not.toHaveBeenCalled();
    const sent = put.mock.calls[1][0].data as { ui: { stats: typeof mine } };
    expect(sent.ui.stats.plowed).toBe(40);
  });
});

// The other half of the round trip. Signing in on a second device rebuilds the farm
// from `/bootstrap`, and the tally rides that response's presentation blob — nothing
// on the server can reconstruct it, so a read path that quietly dropped it would lose
// the account's whole history the first time it was opened somewhere else.
describe("SaveManager online statistics round trip", () => {
  const boot = (presentation: Record<string, unknown>) => ({
    serverTime: 1_800_000_000_000,
    presentation: { version: 3, data: presentation },
    gameplay: {
      balance: { gold: 400, brains: 1, xp: 0 },
      zombieMax: 16, zombiePotBought: false, farmSize: 30, climates: ["grass"],
      farmerHeads: [1], farmerHeadId: 1, farmerBonusHeadId: null,
      ownedPets: [], activePet: null, penPets: [],
      farm: { plots: {} }, objects: { objects: [] }, roster: [], fallen: [],
      storage: { stored: {}, received: {} }, inventory: {},
      quests: { progress: [], completed: [] },
      raids: { progress: { "1": 4, "2": 2 }, lastRaidAt: 0 },
      epicBoss: null, tutorialRewarded: false,
    },
    social: { friends: [] },
  });
  const manager = () => new SaveManager(
    {} as never, {} as never, {} as never, {} as never, {} as never,
    new Map(), new Map(), async () => undefined, "online",
  );

  it("restores the tally the last device wrote", () => {
    const stats = newFarmStats(1_700_000_000_000);
    stats.harvested = { carrot: 412 };
    stats.plowed = 480;

    const blob = (manager() as any).fromBootstrap(boot({ ui: { attackOrder: [], teams: [], stats } }));

    expect(blob.stats).toEqual(stats);
  });

  it("leaves an account that has never had one to be seeded on apply", () => {
    // `undefined` is not the same as an all-zero tally: only the absence tells
    // applySave that this farm predates the field and should be seeded (see the
    // invasions-won backfill there).
    const blob = (manager() as any).fromBootstrap(boot({ ui: { attackOrder: [], teams: [] } }));

    expect(blob.stats).toBeUndefined();
    expect(blob.raids.completed).toEqual({ "1": 4, "2": 2 });
  });

  it("reads a damaged tally back as a usable one", () => {
    const blob = (manager() as any).fromBootstrap(
      boot({ ui: { stats: { plowed: "many", harvested: { carrot: 9 } } } })
    );

    expect(blob.stats.plowed).toBe(0);
    expect(blob.stats.harvested).toEqual({ carrot: 9 });
  });
});
