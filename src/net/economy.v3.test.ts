import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../GameState";
import { EconomyClient } from "./economy";
import type { CommandBatchResponse } from "./protocol";
import * as api from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};

describe("v3 raid dependency ids", () => {
  it("flushes a zombie harvest immediately so its server-owned mutation is visible", () => {
    const economy = new EconomyClient(new GameState(), "zombie-harvest-flush");
    const flush = vi.spyOn((economy as any).queue, "flush").mockResolvedValue(undefined);

    economy.submitFarm(
      { type: "harvest", oc: 4, or: 4, unitId: "local-zombie" },
      { xp: 1 },
    );

    expect(flush).toHaveBeenCalledOnce();
  });

  it("keeps ordinary crop harvests in the batching window", () => {
    const economy = new EconomyClient(new GameState(), "crop-harvest-batch");
    const flush = vi.spyOn((economy as any).queue, "flush").mockResolvedValue(undefined);

    economy.submitFarm({ type: "harvest", oc: 4, or: 4 }, { gold: 16, xp: 1 });

    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes Insta-Harvest immediately when it creates zombies", () => {
    const economy = new EconomyClient(new GameState(), "bulk-zombie-harvest-flush");
    const flush = vi.spyOn((economy as any).queue, "flush").mockResolvedValue(undefined);

    economy.submitInventory({
      type: "use",
      key: "insta_harvest",
      localZombieHarvests: [{ id: "local-zombie", oc: 4, or: 4 }],
    }, { count: -1 });

    expect(flush).toHaveBeenCalledOnce();
  });

  it("adopts a gift claim balance while preserving pending optimistic deltas", () => {
    const state = new GameState();
    const economy = new EconomyClient(state, "gift-balance-account");
    (economy as any).optimistic.set(1, { gold: -10, brains: 0, xp: 0 });

    economy.adoptExternalBalance({ gold: 200, brains: 16, xp: 0 }, 7);

    expect(state.gold).toBe(190);
    expect(state.brains).toBe(16);
    expect((economy as any).queue.accountVersion).toBe(7);
  });

  it("claims a gift without waiting on a paused gameplay writer queue", async () => {
    const state = new GameState();
    const economy = new EconomyClient(state, "gift-independent-account");
    const queue = (economy as any).queue;
    queue.adoptBootstrap({
      accountVersion: 1, writerGeneration: 1, mutationsEnabled: true,
      minimumProtocolVersion: 3,
      writer: { status: "mine", generation: 1, lastActivityAt: 1 },
    } as any);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    queue.disable("offline");
    const settle = vi.spyOn(queue, "settle");
    const claim = vi.spyOn(api, "claimGift").mockResolvedValue({
      balance: { gold: 200, brains: 16, xp: 0 },
      accountVersion: 2,
      alreadyClaimed: false,
      credited: true,
    });

    await expect(economy.claimGift("gift-1")).resolves.toMatchObject({ credited: true });

    expect(claim).toHaveBeenCalledWith("gift-1");
    expect(settle).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
    expect(queue.accountVersion).toBe(2);
    expect(state.brains).toBe(16);
  });

  it("retries a gift claim that briefly collides with an account mutation", async () => {
    vi.useFakeTimers();
    const state = new GameState();
    const economy = new EconomyClient(state, "gift-retry-account");
    const claim = vi.spyOn(api, "claimGift")
      .mockRejectedValueOnce(new api.ApiError(409, "operation_in_progress"))
      .mockRejectedValueOnce(new api.ApiError(409, "operation_in_progress"))
      .mockResolvedValue({
        balance: { gold: 200, brains: 16, xp: 0 },
        accountVersion: 3,
        alreadyClaimed: false,
        credited: true,
      });

    const claimed = economy.claimGift("gift-retry");
    await vi.runAllTimersAsync();

    await expect(claimed).resolves.toMatchObject({ credited: true });
    expect(claim).toHaveBeenCalledTimes(3);
    expect(state.brains).toBe(16);
  });

  it("translates a selected optimistic harvest id after the batch settles", () => {
    const economy = new EconomyClient(new GameState(), "alias-test-account");
    (economy as any).optimistic.set(1, {
      gold: 0, brains: 0, xp: 1, localUnitId: "z1",
    });
    const response: CommandBatchResponse = {
      protocolVersion: 3,
      batchId: "batch-alias-test",
      accountVersion: 1,
      writerGeneration: 1,
      serverTime: 1,
      results: [{ sequence: 1, status: "applied", createdIds: ["server-zombie"] }],
      gameplay: {
        balance: { gold: 200, brains: 15, xp: 1 },
        farm: { version: 1, plots: { "1:1": { state: "spent", zombie: true } } },
        objects: { version: 0, objects: [] },
        quests: { version: 0, completed: [], progress: [] },
        inventory: {}, storage: { received: {}, stored: {} },
        roster: [{ id: "server-zombie", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false }],
        farmSize: 30, climates: ["grass"], farmerHeads: [0, 1, 4, 5, 10, 11], farmerHeadId: 1,
        ownedPets: [], activePet: null, penPets: [],
        zombieMax: 16, tutorialRewarded: false,
        raids: { progress: {}, lastRaidAt: 0 },
      },
      farmVersionBefore: 0,
      farmVersionAfter: 1,
      netDelta: { gold: 0, brains: 0, xp: 1 },
      questChanges: [],
      createdZombieIds: ["server-zombie"],
    };
    (economy as any).adoptCommandResponse(response);
    expect(economy.authoritativeUnitId("z1")).toBe("server-zombie");
    expect(economy.authoritativeUnitId("already-server-owned")).toBe("already-server-owned");
  });

  it("adopts the authoritative cooldown immediately after raid finish", async () => {
    const state = new GameState();
    const economy = new EconomyClient(state, "cooldown-test-account");
    vi.spyOn(api, "raidFinish").mockResolvedValue({
      lastRaidAt: 123_456,
      balance: { gold: 200, brains: 15, xp: 0 },
      gold: 0,
      xp: 0,
      firstClear: false,
      raidProgress: {},
    });

    await economy.submitRaid("raid-session", 100, [], {
      win: false,
      rounds: 1,
      survivors: [],
      losses: [],
      enemiesBeaten: 0,
      playerDamage: 0,
    }, {});

    expect(state.lastRaidAt).toBe(123_456);
  });

  it("keeps retrying a fast tutorial invasion until the minimum duration passes", async () => {
    vi.useFakeTimers();
    const economy = new EconomyClient(new GameState(), "tutorial-raid-account");
    const finish = vi.spyOn(api, "raidFinish")
      .mockRejectedValueOnce(new api.ApiError(425, "too_early", { retryAfterMs: 10 }))
      .mockRejectedValueOnce(new api.ApiError(425, "too_early", { retryAfterMs: 1 }))
      .mockResolvedValue({
        lastRaidAt: 123_456,
        balance: { gold: 200, brains: 15, xp: 0 },
        gold: 0,
        xp: 0,
        firstClear: false,
        raidProgress: {},
      });

    const settled = economy.submitRaid("tutorial-session", 20, [], {
      win: true,
      rounds: 1,
      survivors: ["tutorial-zombie"],
      losses: [],
      enemiesBeaten: 1,
      playerDamage: 100,
    }, {});
    await vi.runAllTimersAsync();
    await settled;

    expect(finish).toHaveBeenCalledTimes(3);
  });

  it("retries an invasion finish when its committed response is lost", async () => {
    vi.useFakeTimers();
    const state = new GameState();
    const economy = new EconomyClient(state, "lost-raid-response-account");
    const committed = {
      lastRaidAt: 123_456,
      balance: { gold: 325, brains: 16, xp: 10 },
      gold: 125,
      brains: 1,
      xp: 10,
      firstClear: true,
      raidProgress: { "1": 1 },
      outcome: { win: true, rounds: 1, survivors: ["survivor"], losses: ["casualty"], enemiesBeaten: 1, playerDamage: 100 },
    };
    const finish = vi.spyOn(api, "raidFinish")
      .mockRejectedValueOnce(new api.ApiError(0, "offline"))
      .mockResolvedValue(committed);
    const settledHandler = vi.fn();
    economy.onRaidSettled = settledHandler;

    const settled = economy.submitRaid("committed-session", 100, [], committed.outcome, {});
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(committed);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(settledHandler).toHaveBeenCalledWith(committed);
    expect(state.lastRaidAt).toBe(123_456);
    expect(state.gold).toBe(325);
    expect(state.brains).toBe(16);
  });

  it("retries writer-operation contention instead of discarding the invasion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", memoryStorage());
    const economy = new EconomyClient(new GameState(), "raid-writer-contention");
    const result = {
      lastRaidAt: 123_456,
      balance: { gold: 300, brains: 15, xp: 10 },
      gold: 100,
      xp: 10,
      firstClear: true,
      raidProgress: { "1": 1 },
    };
    const finish = vi.spyOn(api, "raidFinish")
      .mockRejectedValueOnce(new api.ApiError(409, "operation_in_progress", { retryAfterMs: 0 }))
      .mockResolvedValue(result);

    const settled = economy.submitRaid("contended-session", 100, [], {
      win: true, rounds: 1, survivors: ["z1"], losses: [], enemiesBeaten: 1, playerDamage: 100,
    }, {});
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(result);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("zf2r.v3.raid-finish::raid-writer-contention")).toBeNull();
  });

  it("keeps the completed transcript durable after all live network retries fail", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", memoryStorage());
    const accountId = "durable-offline-invasion";
    const economy = new EconomyClient(new GameState(), accountId);
    vi.spyOn(api, "raidFinish").mockRejectedValue(new api.ApiError(0, "offline"));
    const outcome = {
      win: true, rounds: 2, survivors: ["z1"], losses: [], enemiesBeaten: 1, playerDamage: 200,
    };

    const settled = economy.submitRaid("offline-finish-session", 200, [], outcome, {});
    const rejected = expect(settled).rejects.toMatchObject({ status: 0, code: "offline" });
    await vi.runAllTimersAsync();
    await rejected;

    expect(JSON.parse(localStorage.getItem(`zf2r.v3.raid-finish::${accountId}`) ?? "null"))
      .toMatchObject({ sessionId: "offline-finish-session", finalTick: 200, outcome });
  });

  it("does not retry a rejected invasion replay", async () => {
    const economy = new EconomyClient(new GameState(), "bad-raid-replay-account");
    const finish = vi.spyOn(api, "raidFinish")
      .mockRejectedValue(new api.ApiError(422, "replay_mismatch"));

    await expect(economy.submitRaid("bad-session", 100, [], {
      win: false, rounds: 1, survivors: [], losses: [], enemiesBeaten: 0, playerDamage: 0,
    }, {})).rejects.toMatchObject({ status: 422, code: "replay_mismatch" });
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("abandons a raid session left open by a previous page load", async () => {
    const gameplay = {
      balance: { gold: 200, brains: 15, xp: 0 },
      farm: { version: 0, plots: {} }, objects: { version: 0, objects: [] },
      quests: { version: 0, completed: [], progress: [] }, inventory: {},
      storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [1], farmerHeadId: 1, ownedPets: [],
      activePet: null, penPets: [], zombieMax: 16, tutorialRewarded: false,
      raids: { progress: {}, lastRaidAt: 0 }, raidRevival: null, epicBoss: null,
    };
    const stale = {
      protocolVersion: 3, serverTime: 1, minimumProtocolVersion: 3,
      mutationsEnabled: true, accountVersion: 1, writerGeneration: 1,
      writerDeviceId: "this-device",
      writer: { status: "mine", generation: 1, lastActivityAt: 1 },
      gameplay, presentation: { version: 0 },
      social: { friends: [], incomingRequestCount: 0, inboxCount: 0 },
      resumableRaid: {
        sessionId: "abandoned-tutorial", raidId: "1", startedAt: 1,
        earliestFinishAt: 16_000, expiresAt: 900_000, rosterIds: ["zombie-1"],
      },
    } as any;
    const bootstrap = vi.spyOn(api, "bootstrap")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ...stale, resumableRaid: null });
    const finish = vi.spyOn(api, "raidFinish").mockResolvedValue({
      lastRaidAt: 1, balance: gameplay.balance, gold: 0, xp: 0,
      firstClear: false, raidProgress: {},
    });

    await new EconomyClient(new GameState(), "recovery-account").start();

    expect(finish).toHaveBeenCalledWith("abandoned-tutorial", 0, [
      { seq: 1, tick: 0, type: "retreat" },
    ]);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("replays a durable completed invasion after reload instead of retreating", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const accountId = "durable-raid-recovery";
    const outcome = {
      win: true, rounds: 4, survivors: ["zombie-1"], losses: [], enemiesBeaten: 2, playerDamage: 500,
    };
    localStorage.setItem(`zf2r.v3.raid-finish::${accountId}`, JSON.stringify({
      sessionId: "completed-before-reload",
      finalTick: 321,
      inputs: [{ seq: 1, tick: 12, type: "bubble", unitId: "zombie-1" }],
      outcome,
      savedAt: 10,
    }));
    const gameplay = {
      balance: { gold: 200, brains: 15, xp: 0 },
      farm: { version: 0, plots: {} }, objects: { version: 0, objects: [] },
      quests: { version: 0, completed: [], progress: [] }, inventory: {},
      storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [1], farmerHeadId: 1, ownedPets: [],
      activePet: null, penPets: [], zombieMax: 16, tutorialRewarded: false,
      raids: { progress: {}, lastRaidAt: 0 }, raidRevival: null, epicBoss: null,
    };
    const stale = {
      protocolVersion: 3, serverTime: 1, minimumProtocolVersion: 3,
      mutationsEnabled: true, accountVersion: 1, writerGeneration: 1,
      writerDeviceId: "this-device",
      writer: { status: "mine", generation: 1, lastActivityAt: 1 },
      gameplay, presentation: { version: 0 },
      social: { friends: [], incomingRequestCount: 0, inboxCount: 0 },
      resumableRaid: {
        sessionId: "completed-before-reload", raidId: "1", startedAt: 1,
        earliestFinishAt: 16_000, expiresAt: 900_000, rosterIds: ["zombie-1"],
      },
    } as any;
    const bootstrap = vi.spyOn(api, "bootstrap")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ...stale, resumableRaid: null });
    const finish = vi.spyOn(api, "raidFinish").mockResolvedValue({
      lastRaidAt: 1, balance: gameplay.balance, gold: 100, xp: 10,
      firstClear: true, raidProgress: { "1": 1 },
    });

    await new EconomyClient(new GameState(), accountId).start();

    expect(finish).toHaveBeenCalledWith(
      "completed-before-reload",
      321,
      [{ seq: 1, tick: 12, type: "bubble", unitId: "zombie-1" }],
      outcome,
    );
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(`zf2r.v3.raid-finish::${accountId}`)).toBeNull();
  });

  it("matches bulk-harvest aliases by plot rather than array order", () => {
    const economy = new EconomyClient(new GameState(), "bulk-alias-account");
    (economy as any).optimistic.set(7, {
      gold: 0, brains: 0, xp: 0,
      localZombieHarvests: [
        { id: "local-b", oc: 8, or: 4 },
        { id: "local-a", oc: 1, or: 2 },
      ],
    });
    let aliases: Record<string, string> = {};
    economy.onRosterState = (_roster, next) => { aliases = next; };
    const response: CommandBatchResponse = {
      protocolVersion: 3, batchId: "bulk", accountVersion: 1, writerGeneration: 1, serverTime: 1,
      results: [{ sequence: 7, status: "applied", createdIds: ["server-a", "server-b"],
        createdZombieSources: [
          { id: "server-a", oc: 1, or: 2 },
          { id: "server-b", oc: 8, or: 4 },
        ] }],
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 1, plots: {} },
        objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
        inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
        climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
        penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
      },
      farmVersionBefore: 0, farmVersionAfter: 1, netDelta: { gold: 0, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: ["server-a", "server-b"],
    };
    (economy as any).adoptCommandResponse(response);
    expect(aliases).toEqual({ "server-a": "local-a", "server-b": "local-b" });
  });

  it("does not let an older batch overwrite a newer pending farm projection", () => {
    const economy = new EconomyClient(new GameState(), "pending-farm-account");
    (economy as any).commandsBySequence.set(2, {
      type: "farm.plant", oc: 4, or: 6, cropKey: "carrot",
    });
    (economy as any).optimistic.set(2, { gold: -10, brains: 0, xp: 0 });
    const projections: api.FarmState[] = [];
    economy.onFarmState = (farm) => projections.push(farm);
    const gameplay = {
      balance: { gold: 200, brains: 15, xp: 0 }, farm: { version: 0, plots: {} },
      objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
      inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
      penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
    };

    (economy as any).adoptCommandResponse({
      protocolVersion: 3, batchId: "older", accountVersion: 1, writerGeneration: 1, serverTime: 1,
      results: [{ sequence: 1, status: "applied" }], gameplay,
      farmVersionBefore: 0, farmVersionAfter: 0, netDelta: { gold: 0, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: [],
    } satisfies CommandBatchResponse);
    expect(projections).toEqual([]);

    (economy as any).adoptCommandResponse({
      protocolVersion: 3, batchId: "newer", accountVersion: 2, writerGeneration: 1, serverTime: 2,
      results: [{ sequence: 2, status: "applied" }],
      gameplay: { ...gameplay, farm: { version: 1, plots: {
        "4:6": { state: "planted" as const, cropKey: "carrot", plantedAt: 2, growMs: 100,
          sell: 1, xp: 1, fertilized: false, zombie: false },
      } } },
      farmVersionBefore: 0, farmVersionAfter: 1, netDelta: { gold: -10, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: [],
    } satisfies CommandBatchResponse);
    expect(projections).toHaveLength(1);
    expect(projections[0].crops.map((crop) => [crop.oc, crop.pr])).toEqual([[4, 6]]);
  });

  it("carries harvest id aliases across a deferred roster projection", () => {
    const economy = new EconomyClient(new GameState(), "pending-roster-account");
    (economy as any).commandsBySequence.set(1, { type: "farm.harvest", oc: 1, or: 1 });
    (economy as any).optimistic.set(1, { gold: 0, brains: 0, xp: 1, localUnitId: "local-a" });
    (economy as any).commandsBySequence.set(2, { type: "farm.harvest", oc: 2, or: 2 });
    (economy as any).optimistic.set(2, { gold: 0, brains: 0, xp: 1, localUnitId: "local-b" });
    const rosterCalls: Record<string, string>[] = [];
    economy.onRosterState = (_roster, aliases) => rosterCalls.push(aliases);
    const baseGameplay = {
      balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 0, plots: {} },
      objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
      inventory: {}, storage: { received: {}, stored: {} }, farmSize: 30, climates: ["grass"],
      farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null, penPets: [], zombieMax: 16,
      tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 }, roster: [],
    };
    const response = (sequence: number, id: string, roster: any[]): CommandBatchResponse => ({
      protocolVersion: 3, batchId: `batch-${sequence}`, accountVersion: sequence,
      writerGeneration: 1, serverTime: sequence,
      results: [{ sequence, status: "applied", createdIds: [id] }],
      gameplay: { ...baseGameplay, roster }, farmVersionBefore: 0, farmVersionAfter: 0,
      netDelta: { gold: 0, brains: 0, xp: 1 }, questChanges: [], createdZombieIds: [id],
    });

    (economy as any).adoptCommandResponse(response(1, "server-a", [
      { id: "server-a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
    ]));
    expect(rosterCalls).toEqual([]);
    (economy as any).adoptCommandResponse(response(2, "server-b", [
      { id: "server-a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
      { id: "server-b", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
    ]));
    expect(rosterCalls).toEqual([{ "server-a": "local-a", "server-b": "local-b" }]);
  });

  it("defers every structural projection while any newer command is pending", () => {
    const state = new GameState();
    const economy = new EconomyClient(state, "pending-structure-account");
    (economy as any).commandsBySequence.set(2, { type: "farmer.equip", headId: 9 });
    (economy as any).optimistic.set(2, { gold: 0, brains: 0, xp: 0 });
    const calls: string[] = [];
    economy.onShopState = () => calls.push("shop");
    economy.onFarmerState = () => calls.push("farmer");
    economy.onPetState = () => calls.push("pet");
    economy.onQuestState = () => calls.push("quest");
    economy.onFarmState = () => calls.push("farm");
    economy.onObjectState = () => calls.push("objects");
    economy.onRosterState = () => calls.push("roster");
    economy.onEpicBossState = () => calls.push("epic");
    const gameplay = {
      balance: { gold: 200, brains: 15, xp: 0 }, farm: { version: 0, plots: {} },
      objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
      inventory: {}, storage: { received: { Windmill: 1 }, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [1], farmerHeadId: 1, ownedPets: [], activePet: null,
      penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
    };
    const response = (sequence: number): CommandBatchResponse => ({
      protocolVersion: 3, batchId: `structure-${sequence}`, accountVersion: sequence,
      writerGeneration: 1, serverTime: sequence, results: [{ sequence, status: "applied" }],
      gameplay, farmVersionBefore: 0, farmVersionAfter: 0,
      netDelta: { gold: 0, brains: 0, xp: 0 }, questChanges: [], createdZombieIds: [],
    });

    (economy as any).adoptCommandResponse(response(1));
    expect(calls).toEqual([]);
    expect(state.received).toEqual([]);
    (economy as any).adoptCommandResponse(response(2));
    expect(calls).toEqual(["shop", "farmer", "pet", "quest", "farm", "objects", "roster", "epic"]);
    expect(state.received).toEqual(["Windmill"]);
  });

  it("submits Received claims through the authoritative command queue", () => {
    const economy = new EconomyClient(new GameState(), "storage-claim-account");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue").mockReturnValueOnce(1).mockReturnValueOnce(2);
    expect(economy.submitStorageClaim("Insta-Plow", { inventoryKey: "insta_plow" })).toBe(true);
    expect(economy.submitStorageClaim("Windmill", { localObjectId: "local-windmill" })).toBe(true);
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      type: "storage.claim", itemName: "Insta-Plow", clientInstanceId: undefined,
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      type: "storage.claim", itemName: "Windmill", clientInstanceId: "local-windmill",
    });
  });

  it("settles the ordered lane before an out-of-band dependency", async () => {
    const economy = new EconomyClient(new GameState(), "writer-claim-account");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue").mockReturnValue(1);
    const settle = vi.spyOn((economy as any).queue, "settle").mockResolvedValue(undefined);
    await economy.settleBeforeDependency();
    expect(enqueue).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("recovers an empty paused queue before an out-of-band dependency", async () => {
    const economy = new EconomyClient(new GameState(), "gift-recovery-account");
    (economy as any).queue.disable("offline");
    vi.spyOn(api, "bootstrap").mockResolvedValue({
      protocolVersion: 3, serverTime: 1, minimumProtocolVersion: 3,
      mutationsEnabled: true, accountVersion: 4, writerGeneration: 2,
      writerDeviceId: "this-device",
      writer: { status: "mine", generation: 2, lastActivityAt: 1 },
      gameplay: {
        balance: { gold: 200, brains: 15, xp: 0 },
        farm: { version: 0, plots: {} }, objects: { version: 0, objects: [] },
        quests: { version: 0, completed: [], progress: [] }, inventory: {},
        storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
        climates: ["grass"], farmerHeads: [1], farmerHeadId: 1,
        ownedPets: [], activePet: null, penPets: [], zombieMax: 16,
        tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
        raidRevival: null, epicBoss: null,
      },
      presentation: { version: 0 },
      social: { friends: [], incomingRequestCount: 0, inboxCount: 1 },
      resumableRaid: null,
    } as any);

    await expect(economy.settleBeforeDependency()).resolves.toBeUndefined();
    expect(api.bootstrap).toHaveBeenCalledWith(true);
    expect(economy.available).toBe(true);
  });

  it("does not bypass a paused queue that still has unresolved commands", async () => {
    const economy = new EconomyClient(new GameState(), "gift-pending-account");
    const queue = (economy as any).queue;
    queue.adoptBootstrap({
      accountVersion: 1, writerGeneration: 1, mutationsEnabled: true,
      minimumProtocolVersion: 3,
      writer: { status: "mine", generation: 1, lastActivityAt: 1 },
    } as any);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    queue.disable("offline");
    const bootstrap = vi.spyOn(api, "bootstrap");

    await expect(economy.settleBeforeDependency()).rejects.toThrow("gameplay_unavailable");
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("reports rejected commands and identifies rejected optimistic objects", () => {
    const economy = new EconomyClient(new GameState(), "reject-account");
    const command = { type: "object.buy" as const, catalogKey: "mausoleum3", clientInstanceId: "o7" };
    (economy as any).commandsBySequence.set(9, command);
    (economy as any).optimistic.set(9, { gold: -100, brains: 0, xp: 0, localObjectId: "o7" });
    let rejected = "";
    let rejectedObjects: string[] = [];
    economy.onCommandRejected = (_command, error) => { rejected = error; };
    economy.onObjectState = (_objects, _aliases, _base, ids) => { rejectedObjects = ids; };
    const response: CommandBatchResponse = {
      protocolVersion: 3, batchId: "reject", accountVersion: 1, writerGeneration: 1, serverTime: 1,
      results: [{ sequence: 9, status: "rejected", error: "insufficient" }],
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 0, plots: {} },
        objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
        inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
        climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
        penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
      },
      farmVersionBefore: 0, farmVersionAfter: 0, netDelta: { gold: 0, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: [],
    };
    (economy as any).adoptCommandResponse(response);
    expect(rejected).toBe("insufficient");
    expect(rejectedObjects).toEqual(["o7"]);
  });

  it("translates roster status, sell, and restored combine parent ids", () => {
    const economy = new EconomyClient(new GameState(), "roster-action-account");
    (economy as any).authoritativeUnitIds.set("local-a", "server-a");
    (economy as any).authoritativeUnitIds.set("local-b", "server-b");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue")
      .mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);

    economy.submitRosterStatus("local-a", true);
    economy.submitRoster({ type: "sell", unitId: "local-b" });
    economy.restoreCombineParents("local-a", "local-b");
    economy.submitRoster({ type: "combineCollect", unitId: "local-child", key: "ignored", mutation: 0 });

    expect(enqueue).toHaveBeenNthCalledWith(1, { type: "roster.status", unitId: "server-a", stored: true });
    expect(enqueue).toHaveBeenNthCalledWith(2, { type: "roster.sell", unitId: "server-b" });
    expect(enqueue).toHaveBeenNthCalledWith(3, {
      type: "roster.combine", potId: "legacy", parentAId: "server-a", parentBId: "server-b",
    });
  });

  it("keeps concurrent Zombie Pot parent pairs independent", () => {
    const economy = new EconomyClient(new GameState(), "multi-pot-account");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue")
      .mockReturnValueOnce(1).mockReturnValueOnce(2);
    economy.restoreCombineParents("pot-a", "a1", "a2");
    economy.restoreCombineParents("pot-b", "b1", "b2");

    economy.submitRoster({ type: "combineCollect", potId: "pot-b", unitId: "child-b", key: "ignored" });
    economy.submitRoster({ type: "combineCollect", potId: "pot-a", unitId: "child-a", key: "ignored" });

    expect(enqueue).toHaveBeenNthCalledWith(1, { type: "roster.combine", potId: "pot-b", parentAId: "b1", parentBId: "b2" });
    expect(enqueue).toHaveBeenNthCalledWith(2, { type: "roster.combine", potId: "pot-a", parentAId: "a1", parentBId: "a2" });
  });

  it("carries the persisted combine-start level into collection", () => {
    const economy = new EconomyClient(new GameState(), "combine-level-account");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue").mockReturnValueOnce(1);
    economy.restoreCombineParents("pot", "a", "b", 24);

    economy.submitRoster({ type: "combineCollect", potId: "pot", unitId: "child", key: "ignored" });

    expect(enqueue).toHaveBeenCalledWith({
      type: "roster.combine", potId: "pot", parentAId: "a", parentBId: "b", playerLevel: 24,
    });
  });

  it("reserves both authoritative parents as soon as combining starts", () => {
    const economy = new EconomyClient(new GameState(), "combine-start-account");
    (economy as any).authoritativeUnitIds.set("local-a", "server-a");
    (economy as any).authoritativeUnitIds.set("local-b", "server-b");
    const enqueue = vi.spyOn((economy as any).queue, "enqueue").mockReturnValueOnce(1);

    economy.submitRoster({
      type: "combineStart", potId: "pot-1", parentAId: "local-a", parentBId: "local-b", playerLevel: 12,
    });

    expect(enqueue).toHaveBeenCalledWith({
      type: "roster.combine_start", potId: "pot-1",
      parentAId: "server-a", parentBId: "server-b", playerLevel: 12,
    });
  });

  it("charges the authoritative brain balance when a casualty is revived", async () => {
    const state = new GameState();
    const economy = new EconomyClient(state, "revive-test-account");
    vi.spyOn(api, "raidRevive").mockResolvedValue({
      ok: true,
      revivedIds: ["z-dead"],
      balance: { gold: 200, brains: 14, xp: 0 },
    });

    const result = await economy.resolveRaidRevival("raid-session", ["z-dead"]);

    expect(result.revivedIds).toEqual(["z-dead"]);
    expect(state.brains).toBe(14);
    expect(api.raidRevive).toHaveBeenCalledWith("raid-session", ["z-dead"]);
  });
});
