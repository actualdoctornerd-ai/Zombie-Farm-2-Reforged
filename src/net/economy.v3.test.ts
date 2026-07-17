import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../GameState";
import { EconomyClient } from "./economy";
import type { CommandBatchResponse } from "./protocol";
import * as api from "./api";

afterEach(() => vi.restoreAllMocks());

describe("v3 raid dependency ids", () => {
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
      type: "roster.combine", parentAId: "server-a", parentBId: "server-b",
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
