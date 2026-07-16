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
        ownedPets: [], activePet: null,
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
});
