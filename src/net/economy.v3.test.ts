import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../GameState";
import { EconomyClient, OWNERSHIP_POLL_IDLE_MS } from "./economy";
import type { CommandBatchResponse } from "./protocol";
import * as api from "./api";
import { newFarmStats } from "../stats";
import type { SequencedCommand } from "./protocol";

/** The outbox's own pending list. */
const pending = (economy: EconomyClient): SequencedCommand[] =>
  (economy as unknown as { queue: { pending: SequencedCommand[] } }).queue.pending;

afterEach(() => {
  vi.restoreAllMocks();
  api.setWriterConfirmedHandler(null);
  api.setWriterRejectedHandler(null);
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

const SESSION = {
  token: "session-token", accountId: "account", username: "Player", friendCode: "CODE",
};

const bootstrapFixture = (overrides: Record<string, unknown> = {}): any => ({
  protocolVersion: 3, serverTime: 1, minimumProtocolVersion: 3, raidRulesetVersion: 0,
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
  social: { friends: [], incomingRequestCount: 0, inboxCount: 0 },
  resumableRaid: null,
  ...overrides,
});

// The lifetime tally under the online economy. Every case here is a balance that
// would dip and recover — and used to book on both sides for it.
describe("lifetime tally under the online economy", () => {
  const gameplayWith = (balance: { gold: number; brains: number; xp: number }): any => ({
    ...bootstrapFixture().gameplay, balance,
  });
  const batchResponse = (
    results: CommandBatchResponse["results"],
    balance: { gold: number; brains: number; xp: number },
    serverTime: number,
  ): CommandBatchResponse => ({
    protocolVersion: 3, batchId: `b${serverTime}`, accountVersion: 1, writerGeneration: 1, serverTime,
    results, gameplay: gameplayWith(balance),
    farmVersionBefore: 0, farmVersionAfter: 0, netDelta: { gold: 0, brains: 0, xp: 0 },
    questChanges: [], createdZombieIds: [],
  });
  /** An online client with a settled balance and a clean tally. */
  const settled = (name: string, balance = { gold: 1000, brains: 20, xp: 0 }) => {
    const state = new GameState();
    const economy = new EconomyClient(state, name);
    (economy as any).adoptGameplay(gameplayWith(balance), {}, {}, [], 100);
    state.restoreStats(newFarmStats(0));
    return { state, economy };
  };

  it("nets a refused spend to zero on both sides of the tally", () => {
    const { state, economy } = settled("tally-reject");
    economy.submitInventory({ type: "buy", key: "fertilizer" }, { count: 1, gold: -100 });
    const sequence = pending(economy)[0].sequence;
    expect(state.gold).toBe(900);
    expect(state.stats.goldSpent).toBe(100);

    (economy as any).adoptCommandResponse(batchResponse(
      [{ sequence, status: "rejected", error: "insufficient" }], { gold: 1000, brains: 20, xp: 0 }, 200));

    expect(state.gold).toBe(1000);
    expect(state.stats.goldSpent).toBe(0);
    expect(state.stats.goldEarned).toBe(0);
  });

  it("books an accepted spend once, and never as income", () => {
    const { state, economy } = settled("tally-accept");
    economy.submitInventory({ type: "buy", key: "fertilizer" }, { count: 1, brains: -3 });
    const sequence = pending(economy)[0].sequence;

    (economy as any).adoptCommandResponse(batchResponse(
      [{ sequence, status: "applied" }], { gold: 1000, brains: 17, xp: 0 }, 200));

    expect(state.brains).toBe(17);
    expect(state.stats.brainsSpent).toBe(3);
    expect(state.stats.brainsEarned).toBe(0);
  });

  it("hands the outbox's bookings back when the writer lease is lost", () => {
    // The lease moved to another device: the outbox is discarded, its spends never
    // happen, and the bootstrap that follows carries what the server DID apply.
    const { state, economy } = settled("tally-writer-lost");
    vi.spyOn(api, "clearWriterCredential").mockImplementation(() => {});
    vi.spyOn(api, "bootstrap").mockRejectedValue(new Error("offline"));
    economy.submitInventory({ type: "buy", key: "fertilizer" }, { count: 1, gold: -100 });
    economy.submitInventory({ type: "buy", key: "fertilizer" }, { count: 1, brains: -2 });
    expect(state.stats.goldSpent).toBe(100);
    expect(state.stats.brainsSpent).toBe(2);

    (economy as any).handleWriterLost();
    // Nothing of it landed: the server's balance is the one from before.
    (economy as any).adoptGameplay(gameplayWith({ gold: 1000, brains: 20, xp: 0 }), {}, {}, [], 300);

    expect(state.gold).toBe(1000);
    expect(state.stats.goldSpent).toBe(0);
    expect(state.stats.goldEarned).toBe(0);
    expect(state.stats.brainsSpent).toBe(0);
    expect(state.stats.brainsEarned).toBe(0);
  });

  it("books a spend the server applied before the lease was lost exactly once", () => {
    const { state, economy } = settled("tally-writer-lost-applied");
    vi.spyOn(api, "clearWriterCredential").mockImplementation(() => {});
    vi.spyOn(api, "bootstrap").mockRejectedValue(new Error("offline"));
    economy.submitInventory({ type: "buy", key: "fertilizer" }, { count: 1, gold: -100 });

    (economy as any).handleWriterLost();
    (economy as any).adoptGameplay(gameplayWith({ gold: 900, brains: 20, xp: 0 }), {}, {}, [], 300);

    expect(state.gold).toBe(900);
    expect(state.stats.goldSpent).toBe(100);
    expect(state.stats.goldEarned).toBe(0);
  });

  it("ignores a balance computed before the one already on hand", () => {
    // A batch answered late, after a raid settlement already paid out: adopting its
    // pre-settlement balance would take the brains away and the next response would
    // hand them back — booked as spent AND earned.
    const { state, economy } = settled("tally-stale");
    economy.adoptExternalBalance({ gold: 1000, brains: 26, xp: 0 }, undefined, 500); // the settlement
    expect(state.stats.brainsEarned).toBe(6);

    (economy as any).adoptCommandResponse(batchResponse([], { gold: 1000, brains: 20, xp: 0 }, 400));

    expect(state.brains).toBe(26);
    expect(state.stats.brainsSpent).toBe(0);
    expect(state.stats.brainsEarned).toBe(6);
    // A balance with no timestamp is taken as current, as it always was.
    economy.adoptExternalBalance({ gold: 1000, brains: 27, xp: 0 });
    expect(state.brains).toBe(27);
  });

  it("gives a cancelled request's escrow booking back as the refund lands", async () => {
    const { state, economy } = settled("tally-market-cancel");
    // The post went up: the market took 5 brains, and the refresh booked the spend.
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture({
      serverTime: 200, gameplay: gameplayWith({ gold: 1000, brains: 15, xp: 0 }),
    }));
    await economy.refreshAuthoritative();
    expect(state.stats.brainsSpent).toBe(5);

    // Cancelled: the escrow comes home with the next refresh.
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture({
      serverTime: 300, gameplay: gameplayWith({ gold: 1000, brains: 20, xp: 0 }),
    }));
    await economy.refreshAuthoritative({ unbook: { gold: 0, brains: -5 } });

    expect(state.brains).toBe(20);
    expect(state.stats.brainsSpent).toBe(0);
    expect(state.stats.brainsEarned).toBe(0);
  });
});

describe("v3 raid dependency ids", () => {
  it("postpones the three-minute ownership poll after confirmed gameplay", async () => {
    vi.useFakeTimers();
    let confirmed: (() => void) | null = null;
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
    });
    vi.spyOn(api, "setWriterConfirmedHandler").mockImplementation((handler) => { confirmed = handler; });
    vi.spyOn(api, "getSession").mockReturnValue({
      token: "session-token", accountId: "poll-account", username: "Player", friendCode: "CODE",
    });
    vi.spyOn(api, "hasWriterCredential").mockReturnValue(true);
    const status = vi.spyOn(api, "writerStatus").mockResolvedValue({
      status: "mine", generation: 1, lastActivityAt: 1,
    });
    const economy = new EconomyClient(new GameState(), "poll-account");
    (economy as any).ready = true;
    (economy as any).scheduleOwnershipCheck();

    await vi.advanceTimersByTimeAsync(OWNERSHIP_POLL_IDLE_MS - 60_000);
    expect(status).not.toHaveBeenCalled();
    expect(confirmed).not.toBeNull();
    confirmed!();
    await vi.advanceTimersByTimeAsync(OWNERSHIP_POLL_IDLE_MS - 1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(status).toHaveBeenCalledOnce();
  });

  it("carries the immediate fertilization result in the existing plant command", () => {
    const economy = new EconomyClient(new GameState(), "fertilized-plant");

    economy.submitFarm(
      { type: "plant", oc: 4, or: 4, cropKey: "carrot", fertilized: true },
      { gold: -10 },
    );

    expect((economy as any).queue.pending[0].command).toEqual({
      type: "farm.plant_many", cropKey: "carrot",
      plots: [{ oc: 4, or: 4, fertilized: true }],
    });
  });

  it("sends a plot relocation as a farm.move carrying both origins", () => {
    // Plot POSITIONS are client layout, but which plot exists WHERE is server-owned:
    // without this command the next reconcile drags the plot back to its old origin.
    const economy = new EconomyClient(new GameState(), "plot-move");

    economy.submitFarm({ type: "move", oc: 0, or: 0, toOc: 8, toOr: 4 }, {});

    expect((economy as any).queue.pending[0].command).toEqual({
      type: "farm.move", oc: 0, or: 0, toOc: 8, toOr: 4,
    });
  });

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
      reward: { kind: "brain", amount: 1 },
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
        reward: { kind: "brain", amount: 1 },
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

  it("survives an expired settlement, which carries no balance and no cooldown stamp", async () => {
    // alt0rion, 2026-08-09: a Robot invasion finished 21 minutes past its 15-minute
    // session. The server answers 200 with exactly these five keys and nothing else.
    // Adopting them blindly set `base` to undefined — silently disabling every later
    // reconcile — and pushed NaN through syncRaidCooldown.
    const state = new GameState();
    const economy = new EconomyClient(state, "expired-session-account");
    state.syncRaidCooldown(111_000);
    vi.spyOn(api, "raidFinish").mockResolvedValue({
      expired: true,
      gold: 0,
      xp: 0,
      firstClear: false,
      loot: null,
    });
    const settledHandler = vi.fn();
    economy.onRaidSettled = settledHandler;

    const settled = await economy.submitRaid("expired-session", 4200, [], {
      win: true,
      rounds: 537,
      survivors: ["z1"],
      losses: [],
      enemiesBeaten: 8,
      playerDamage: 900,
    }, {});

    expect(settled.expired).toBe(true);
    // The cooldown clock must not be poisoned by an absent stamp.
    expect(state.lastRaidAt).toBe(111_000);
    expect(Number.isNaN(state.lastRaidAt)).toBe(false);
    // The result still reaches the result panel, which is where the player is finally
    // told the invasion timed out (see invasionSettlementNotice).
    expect(settledHandler).toHaveBeenCalledWith(settled);
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

  it("never retreats the invasion this document is still fighting", async () => {
    // The bug this locks out: any mid-fight bootstrap (the recovery backoff, the writer
    // re-claim, a CAS reload, refreshAuthoritative) used to settle the LIVE session with
    // a tick-0 retreat. The player then won, /raid/finish replayed that stored zero
    // result, and the victory panel showed 0 gold / 0 brains / no loot.
    vi.stubGlobal("localStorage", memoryStorage());
    const gameplay = {
      balance: { gold: 200, brains: 15, xp: 0 },
      farm: { version: 0, plots: {} }, objects: { version: 0, objects: [] },
      quests: { version: 0, completed: [], progress: [] }, inventory: {},
      storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [1], farmerHeadId: 1, ownedPets: [],
      activePet: null, penPets: [], zombieMax: 16, tutorialRewarded: false,
      raids: { progress: {}, lastRaidAt: 0 }, raidRevival: null, epicBoss: null,
    };
    const live = {
      protocolVersion: 3, serverTime: 1, minimumProtocolVersion: 3,
      mutationsEnabled: true, accountVersion: 1, writerGeneration: 1,
      writerDeviceId: "this-device",
      writer: { status: "mine", generation: 1, lastActivityAt: 1 },
      gameplay, presentation: { version: 0 },
      social: { friends: [], incomingRequestCount: 0, inboxCount: 0 },
      resumableRaid: {
        sessionId: "being-played-right-now", raidId: "3", startedAt: 1,
        earliestFinishAt: 16_000, expiresAt: 900_000, rosterIds: ["zombie-1"],
      },
    } as any;
    const bootstrap = vi.spyOn(api, "bootstrap").mockResolvedValue(live);
    const finish = vi.spyOn(api, "raidFinish").mockResolvedValue({
      lastRaidAt: 1, balance: gameplay.balance, gold: 0, xp: 0,
      firstClear: false, raidProgress: {},
    });

    const economy = new EconomyClient(new GameState(), "live-raid-account");
    economy.setLiveRaid("being-played-right-now");
    await economy.refreshAuthoritative();

    expect(finish).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledTimes(1); // no re-fetch: nothing was settled

    // Structural half of the guard: a mid-session bootstrap cannot abandon ANY session,
    // fenced or not. This is what closes the window between /raid/start creating the
    // session and the launch handler learning its id.
    economy.setLiveRaid(null);
    await economy.refreshAuthoritative();
    await (economy as any).recover();
    await (economy as any).reloadAfterConflict();
    expect(finish).not.toHaveBeenCalled();

    // Only the boot bootstrap may retire a session left behind by a previous page load.
    await economy.start();
    expect(finish).toHaveBeenCalledWith("being-played-right-now", 0, [
      { seq: 1, tick: 0, type: "retreat" },
    ]);
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
        "8:6": { state: "spent" as const, zombie: true },
      } } },
      farmVersionBefore: 0, farmVersionAfter: 1, netDelta: { gold: -10, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: [],
    } satisfies CommandBatchResponse);
    expect(projections).toHaveLength(1);
    expect(projections[0].crops.map((crop) => [crop.oc, crop.pr])).toEqual([[4, 6]]);
    expect(projections[0].spent).toEqual([{ oc: 8, pr: 6, zombie: true }]);
  });

  it("translates server crop timestamps into the browser clock domain", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const economy = new EconomyClient(new GameState(), "crop-clock-account");
    let projection: api.FarmState | null = null;
    economy.onFarmState = (farm) => { projection = farm; };
    const gameplay = {
      balance: { gold: 0, brains: 0, xp: 0 },
      farm: { version: 1, plots: {
        "4:6": { state: "planted" as const, cropKey: "carrot", plantedAt: 3_000,
          growMs: 1_000, sell: 1, xp: 1, fertilized: false, zombie: false },
      } },
      objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
      inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
      penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
    };

    (economy as any).adoptGameplay(gameplay, {}, {}, [], 4_000);

    expect(projection!.crops[0].planted_at).toBe(4_000);
    expect(projection!.crops[0].planted_at + projection!.crops[0].grow_ms).toBe(Date.now());
  });

  it("translates fruit-tree and raid timestamps into the browser clock domain", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const state = new GameState();
    const economy = new EconomyClient(state, "server-clock-account");
    let readyAt = 0;
    economy.onObjectState = (objects) => { readyAt = objects[0]?.readyAt ?? 0; };
    const gameplay = {
      balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 0, plots: {} },
      objects: { version: 1, objects: [{ instanceId: "tree-1", catalogKey: "appleTree",
        status: "placed" as const, readyAt: 3_500 }] },
      quests: { version: 0, completed: [], progress: [] }, inventory: {},
      storage: { received: {}, stored: {} }, roster: [], farmSize: 30, climates: ["grass"],
      farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null, penPets: [],
      zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 3_000 },
    };

    (economy as any).adoptGameplay(gameplay, {}, {}, [], 2_000);

    expect(readyAt).toBe(6_500);
    expect(state.lastRaidAt).toBe(6_000);
  });

  // Boss Tokens are rolled by the client on harvest and merely REPORTED here (the
  // server stopped rolling them). Two things have to hold: a field-wide harvest must
  // not become one command per lucky plot, and the count must not visibly fall back
  // between the harvest and the grant reaching the server.
  describe("client-rolled Boss Tokens", () => {
    const epicGameplay = (tokenCount: number, runId = "run-1"): any => ({
      balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 0, plots: {} },
      objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
      inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
      climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
      penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
      epicBoss: {
        runId, bossId: "dr-groundhog", activatedAt: 0, expiresAt: 10_000_000,
        level: 1, maxHp: 2_000, currentHp: 2_000, encounterStartedAt: 0, retryReadyAt: 0,
        tokenCount, completedAt: 0, attackOrder: [],
      },
    });

    it("folds a burst of tokens from one run into a single command", () => {
      const economy = new EconomyClient(new GameState(), "boss-token-fold");

      for (let i = 0; i < 5; i++) economy.submitEpicBossToken("run-1");

      expect((economy as any).queue.pending).toHaveLength(1);
      expect((economy as any).queue.pending[0].command).toEqual({
        type: "epicBoss.token", runId: "run-1", count: 5,
      });
    });

    it("starts a new command for a different run rather than misfiling the token", () => {
      const economy = new EconomyClient(new GameState(), "boss-token-run-change");

      economy.submitEpicBossToken("run-1");
      economy.submitEpicBossToken("run-2");

      expect((economy as any).queue.pending.map((item: any) => item.command)).toEqual([
        { type: "epicBoss.token", runId: "run-1", count: 1 },
        { type: "epicBoss.token", runId: "run-2", count: 1 },
      ]);
    });

    it("keeps unsent tokens on top of a projection that predates them", () => {
      const economy = new EconomyClient(new GameState(), "boss-token-pending");
      const counts: number[] = [];
      economy.onEpicBossState = (run) => { if (run) counts.push(run.tokenCount); };
      // A grant the client has already shown the player, still waiting to be sent. The
      // structural defer gate hides most such projections, so this is written the way a
      // direct adopt (epic boss activate/finish) reaches it: the outbox is not consulted.
      (economy as any).optimistic.set(1, { gold: 0, brains: 0, xp: 0, bossTokens: 2, bossTokenRunId: "run-1" });

      // The server has 3 recorded and knows nothing yet about the two in flight.
      (economy as any).adoptGameplay(epicGameplay(3), {}, {}, [], 1);
      // Once the grant lands, the server's own count already includes them.
      (economy as any).optimistic.clear();
      (economy as any).adoptGameplay(epicGameplay(5), {}, {}, [], 1);

      expect(counts).toEqual([5, 5]);
    });

    it("drops pending tokens belonging to an event that has been replaced", () => {
      const economy = new EconomyClient(new GameState(), "boss-token-stale-run");
      let seen = -1;
      economy.onEpicBossState = (run) => { seen = run?.tokenCount ?? -1; };
      (economy as any).optimistic.set(1, { gold: 0, brains: 0, xp: 0, bossTokens: 4, bossTokenRunId: "old-run" });

      (economy as any).adoptGameplay(epicGameplay(0, "run-2"), {}, {}, [], 1);

      expect(seen).toBe(0);
    });
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
    economy.onObjectState = () => { calls.push("objects"); };
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
    const writerOwned = vi.fn();
    economy.onWriterOwned = writerOwned;
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
    expect(writerOwned).toHaveBeenCalledOnce();
  });

  // A mobile resume finds the lease released by this document's own `pagehide`. It is
  // free, not contested, so gameplay must come back silently instead of stranding the
  // player behind "Gameplay paused — reconnect to continue".
  it("re-claims a free writer lease on resume instead of raising the takeover gate", async () => {
    const economy = new EconomyClient(new GameState(), "resume-free-lease");
    (economy as any).ready = true;
    (economy as any).queue.disable("offline");
    vi.spyOn(economy as any, "adoptGameplay").mockImplementation(() => {});
    const replaced = vi.fn();
    const availableAgain = vi.fn();
    economy.onWriterReplaced = replaced;
    economy.onWriterAvailable = availableAgain;
    vi.spyOn(api, "getSession").mockReturnValue({
      token: "t", accountId: "resume-free-lease", username: "DoctorNerd", friendCode: "CODE",
    });
    vi.spyOn(api, "hasWriterCredential").mockReturnValue(true);
    vi.spyOn(api, "hasLocalWriterLock").mockReturnValue(true);
    vi.spyOn(api, "writerStatus").mockResolvedValue({
      status: "free", generation: 5, lastActivityAt: 1,
    });
    const acquire = vi.spyOn(api, "acquireWriter").mockResolvedValue(undefined);
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture({
      writer: { status: "mine", generation: 6, lastActivityAt: 2 },
    }));

    await (economy as any).checkOwnership();

    expect(acquire).toHaveBeenCalledWith(5, false);
    expect(replaced).not.toHaveBeenCalled();
    expect(availableAgain).toHaveBeenCalledOnce();
    expect(economy.available).toBe(true);
  });

  it("still gates on a lease a second device actually holds", async () => {
    const economy = new EconomyClient(new GameState(), "resume-contested-lease");
    (economy as any).ready = true;
    const replaced = vi.fn();
    economy.onWriterReplaced = replaced;
    vi.spyOn(economy as any, "refreshReadOnly").mockResolvedValue(undefined);
    vi.spyOn(api, "getSession").mockReturnValue({
      token: "t", accountId: "resume-contested-lease", username: "DoctorNerd", friendCode: "CODE",
    });
    vi.spyOn(api, "hasWriterCredential").mockReturnValue(true);
    vi.spyOn(api, "hasLocalWriterLock").mockReturnValue(true);
    vi.spyOn(api, "writerStatus").mockResolvedValue({
      status: "other", generation: 5, lastActivityAt: 1,
    });
    const acquire = vi.spyOn(api, "acquireWriter").mockResolvedValue(undefined);

    await (economy as any).checkOwnership();

    expect(acquire).not.toHaveBeenCalled();
    expect(replaced).toHaveBeenCalledOnce();
    expect(economy.available).toBe(false);
  });

  // Without the reschedule the backoff dies here: no timer, no dialog, and every tap
  // answers the pause toast until the player reloads by hand.
  it("keeps retrying when a recovered bootstrap is still not writable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    // Recovery is for a signed-in client. Signed out there is nothing to recover into
    // and every attempt would answer 401, so the backoff deliberately stands down.
    vi.spyOn(api, "getSession").mockReturnValue(SESSION);
    const economy = new EconomyClient(new GameState(), "recover-still-paused");
    vi.spyOn(economy as any, "adoptGameplay").mockImplementation(() => {});
    const bootstrap = vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture({
      mutationsEnabled: false,
      writer: { status: "mine", generation: 2, lastActivityAt: 1 },
    }));

    await (economy as any).recover();
    expect(economy.available).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(bootstrap.mock.calls.length).toBeGreaterThan(1);
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

  // An object bought under a local id the server already owns comes back under a
  // server-minted instance id, and the alias is the ONLY link back to the local object
  // holding its position. Positions live nowhere else, so dropping the alias while the
  // reconcile was still using it left the player paying for an object that could never
  // be drawn again.
  describe("object alias retention", () => {
    const responseWith = (results: CommandBatchResponse["results"]): CommandBatchResponse => ({
      protocolVersion: 3, batchId: "alias", accountVersion: 1, writerGeneration: 1, serverTime: 1,
      results,
      gameplay: {
        balance: { gold: 0, brains: 0, xp: 0 }, farm: { version: 0, plots: {} },
        objects: { version: 0, objects: [] }, quests: { version: 0, completed: [], progress: [] },
        inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
        climates: ["grass"], farmerHeads: [], farmerHeadId: 1, ownedPets: [], activePet: null,
        penPets: [], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
      },
      farmVersionBefore: 0, farmVersionAfter: 0, netDelta: { gold: 0, brains: 0, xp: 0 },
      questChanges: [], createdZombieIds: [],
    } as any);

    /** Queue an object.buy whose server response renames `o24` to a UUID. */
    const withRenamedBuy = (economy: EconomyClient) => {
      (economy as any).commandsBySequence.set(4, {
        type: "object.buy", catalogKey: "flowerBed", clientInstanceId: "o24",
      });
      (economy as any).optimistic.set(4, { gold: -50, brains: 0, xp: 0, localObjectId: "o24" });
      return responseWith([{ sequence: 4, status: "applied", createdIds: ["uuid-1"] }]);
    };

    it("redelivers the alias when a reconcile pass is superseded before consuming it", async () => {
      const economy = new EconomyClient(new GameState(), "alias-retain");
      const seen: Record<string, string>[] = [];
      // The real handler awaits a texture, then bails because a newer pass bumped its
      // generation. It reports that by resolving false.
      economy.onObjectState = async (_objects, aliases) => {
        seen.push(aliases);
        return false;
      };
      (economy as any).adoptCommandResponse(withRenamedBuy(economy));
      await Promise.resolve();
      await Promise.resolve();

      (economy as any).adoptCommandResponse(responseWith([]));
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual({ "uuid-1": "o24" });
      expect(seen[1]).toEqual({ "uuid-1": "o24" }); // survived the superseded pass
    });

    it("drops the alias once a pass reports it consumed it", async () => {
      const economy = new EconomyClient(new GameState(), "alias-consume");
      const seen: Record<string, string>[] = [];
      economy.onObjectState = async (_objects, aliases) => {
        seen.push(aliases);
        return true;
      };
      (economy as any).adoptCommandResponse(withRenamedBuy(economy));
      await Promise.resolve();
      await Promise.resolve();

      (economy as any).adoptCommandResponse(responseWith([]));
      expect(seen[0]).toEqual({ "uuid-1": "o24" });
      expect(seen[1]).toEqual({});
    });
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

  it("keeps Pot parents available while collection awaits authority", () => {
    const economy = new EconomyClient(new GameState(), "combine-retry-account");
    vi.spyOn((economy as any).queue, "enqueue").mockReturnValueOnce(1);
    economy.restoreCombineParents("pot", "a", "b", 12);

    economy.submitRoster({ type: "combineCollect", potId: "pot", unitId: "child", key: "ignored" });

    expect((economy as any).combineParents.get("pot")).toEqual({
      parentAId: "a", parentBId: "b", playerLevel: 12,
    });
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

  // This string is the whole diagnostic — it's what a player screenshots and what
  // finally distinguishes the branches that all render as "reconnect to continue".
  // If it composes to something empty or shapeless the report is worthless again.
  describe("unavailableReason", () => {
    const signedIn = () => {
      vi.spyOn(api, "getSession").mockReturnValue({
        token: "t", accountId: "diag", username: "DoctorNerd", friendCode: "CODE",
      });
    };

    it("is empty while gameplay is available", () => {
      const economy = new EconomyClient(new GameState(), "diag");
      (economy as any).ready = true;
      expect(economy.available).toBe(true);
      expect(economy.unavailableReason).toBe("");
    });

    it("names the queue's cause, the backlog and the credential state", () => {
      signedIn();
      vi.spyOn(api, "hasLocalWriterLock").mockReturnValue(true);
      vi.spyOn(api, "hasWriterCredential").mockReturnValue(true);
      const economy = new EconomyClient(new GameState(), "diag");
      (economy as any).ready = true;
      (economy as any).queue.adoptBootstrap({
        accountVersion: 0, writerGeneration: 0, writerDeviceId: null,
        mutationsEnabled: true, minimumProtocolVersion: 3,
        writer: { status: "other", generation: 1, lastActivityAt: 1 },
      } as any);
      expect(economy.unavailableReason).toBe("writer_elsewhere");
    });

    it("reports a failed bootstrap as not_ready, with the credential gap", () => {
      signedIn();
      vi.spyOn(api, "hasLocalWriterLock").mockReturnValue(false);
      const economy = new EconomyClient(new GameState(), "diag");
      (economy as any).ready = false;
      (economy as any).queue.disable("bootstrap_failed");
      expect(economy.unavailableReason).toBe("not_ready/bootstrap_failed/nolock");
    });

    it("counts queued work so a stalled outbox is visible", () => {
      signedIn();
      vi.spyOn(api, "hasLocalWriterLock").mockReturnValue(true);
      vi.spyOn(api, "hasWriterCredential").mockReturnValue(false);
      const economy = new EconomyClient(new GameState(), "diag");
      (economy as any).ready = true;
      const queue = (economy as any).queue;
      queue.adoptBootstrap({
        accountVersion: 0, writerGeneration: 0, writerDeviceId: null,
        mutationsEnabled: true, minimumProtocolVersion: 3,
      } as any);
      queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
      queue.enqueue({ type: "farm.plow", oc: 4, or: 0 });
      queue.disable("offline");
      expect(economy.unavailableReason).toBe("offline/q2/nocred");
    });
  });
});

/** Every report of "Gameplay paused — reconnect to continue" that survived a healthy
 *  connection has the same shape underneath: the command queue is paused and NOTHING
 *  is scheduled to unpause it. The lease stays live, because the other writer-protected
 *  routes keep renewing it, so from the server the account looks online while its
 *  version never moves again. These lock down the invariant that makes that state
 *  unreachable — while gameplay is unavailable, a recovery attempt is always pending. */
describe("recovery never stops", () => {
  const arm = (accountId: string) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("navigator", { userAgent: "node", onLine: true });
    vi.spyOn(api, "getSession").mockReturnValue(SESSION);
    const economy = new EconomyClient(new GameState(), accountId);
    vi.spyOn(economy as any, "adoptGameplay").mockImplementation(() => {});
    (economy as any).ready = true;
    const queue = (economy as any).queue;
    queue.adoptBootstrap(bootstrapFixture());
    return { economy, queue };
  };

  // The hole this closes. A 409 pauses the queue through `setPaused`, which emits no
  // `onUnavailable` and therefore schedules nothing; the reload handler was the entire
  // recovery path, and its own bootstrap runs over the same network the batch just
  // failed on. One unlucky pair of failures and the farm was dead until a manual reload.
  it("keeps a retry pending when the reload after a conflict cannot reach the server", async () => {
    vi.useFakeTimers();
    const { economy, queue } = arm("conflict-then-offline");
    vi.spyOn(api, "sendCommandBatch").mockRejectedValue(new api.ApiError(409, "state_conflict"));
    const bootstrap = vi.spyOn(api, "bootstrap").mockRejectedValue(new api.ApiError(0, "offline"));

    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await queue.flush();

    expect(economy.available).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1); // the reload, which failed

    await vi.advanceTimersByTimeAsync(2_000);
    const afterFirstBackoff = bootstrap.mock.calls.length;
    expect(afterFirstBackoff).toBeGreaterThan(1);

    // ...and it stays alive across the whole backoff ladder rather than arming once
    // and giving up, which is the difference between a slow reconnect and a dead farm.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bootstrap.mock.calls.length).toBeGreaterThan(afterFirstBackoff);
  });

  // The supervisor. Whatever branch stranded the queue — including one that does not
  // exist yet — the ownership poll re-arms the backoff, because it re-arms ITSELF for
  // as long as the tab is visible and holds a credential, which is exactly the state a
  // stalled client sits in.
  it("re-arms recovery from the ownership poll when no other path did", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn() });
    vi.spyOn(api, "hasWriterCredential").mockReturnValue(true);
    vi.spyOn(api, "writerStatus").mockResolvedValue({
      status: "mine", generation: 2, lastActivityAt: 1,
    });
    const { economy, queue } = arm("stranded-then-supervised");
    const bootstrap = vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture());

    // Paused with nothing scheduled: the state every stall report has in common.
    queue.setPaused("stranded");
    expect(economy.available).toBe(false);
    expect((economy as any).recoveryTimer).toBeNull();

    (economy as any).scheduleOwnershipCheck();
    await vi.advanceTimersByTimeAsync(OWNERSHIP_POLL_IDLE_MS);
    expect((economy as any).recoveryTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(bootstrap).toHaveBeenCalled();
    expect(economy.available).toBe(true);
  });

  it("pulls the next attempt forward when the player taps a paused farm", async () => {
    vi.useFakeTimers();
    const { economy, queue } = arm("tapped-while-paused");
    const bootstrap = vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture());

    queue.disable("offline");
    expect(bootstrap).not.toHaveBeenCalled(); // the 2s backoff has not elapsed

    economy.nudgeRecovery();
    await vi.advanceTimersByTimeAsync(0);

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(economy.available).toBe(true);
  });

  // The one exclusion. A second live device holding the lease is not a fault to retry
  // out of: the player has been asked what to do and recovery must not fight the answer.
  it("stands down behind the takeover gate and rearms once the lease comes back", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn() });
    const { economy } = arm("gated-then-returned");
    const replaced = vi.fn();
    economy.onWriterReplaced = replaced;
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture({
      writerDeviceId: "another-device",
      writer: { status: "other", generation: 3, lastActivityAt: 1 },
    }));

    await (economy as any).recover();

    expect(replaced).toHaveBeenCalled();
    expect(economy.available).toBe(false);
    expect((economy as any).recoveryTimer).toBeNull();
    economy.nudgeRecovery();
    expect((economy as any).recoveryInFlight).toBe(false);

    // Regaining the lease lowers the gate, and the invariant applies again.
    (economy as any).syncOwnershipPolling("mine");
    (economy as any).ensureRecoveryArmed();
    expect((economy as any).recoveryTimer).not.toBeNull();
  });

  // A conflict that will not clear used to be retried with no backoff at all: reload,
  // rebase, resend, 409, reload... Each turn spent a bootstrap and a batch, applied
  // nothing, and renewed the lease on its way past — a farm frozen at one version while
  // the server saw a busy, healthy client.
  it("hands a conflict that will not clear to the backoff instead of looping on it", async () => {
    vi.useFakeTimers();
    const { queue } = arm("permanent-conflict");
    const send = vi.spyOn(api, "sendCommandBatch")
      .mockRejectedValue(new api.ApiError(409, "batch_in_progress"));
    const bootstrap = vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrapFixture());

    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await queue.flush();
    await vi.advanceTimersByTimeAsync(1);

    // The immediate burst is bounded. A genuine CAS race clears in ONE reload, so a
    // handful is already generous before the conflict is read as standing.
    expect(send.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bootstrap.mock.calls.length).toBeLessThanOrEqual(5);

    // Two full minutes of a conflict that never clears, paced by the recovery ladder
    // instead of spun on. Unpaced this is a bootstrap and a batch per turn, applying
    // nothing and renewing the lease on the way past — which is precisely what an
    // account frozen at one version looks like from the server while its client
    // appears busy and perfectly healthy.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send.mock.calls.length).toBeLessThan(15);
    expect(queue.pauseReason).toBe("state_conflict_loop");
    expect(queue.size).toBe(1); // and the player's plow is still safe
  });
});

/** `recoverResumableRaid` runs inside EVERY bootstrap — boot, the recovery backoff, the
 *  CAS reload, the iOS writer re-claim, refreshAuthoritative. A raid finish that throws
 *  from in there takes the whole bootstrap with it, and because the throw jumps over
 *  `clearPendingRaid` the same transcript is waiting to do it again. Nothing else settles
 *  the session, so the account cannot load at all until the server's own 15-minute TTL
 *  expires the fight. */
describe("a stuck raid finish cannot brick the bootstrap", () => {
  const PENDING = {
    sessionId: "finished-but-refused",
    finalTick: 300,
    inputs: [{ seq: 1, tick: 10, type: "bubble", unitId: "zombie-1" }],
    outcome: { win: true, rounds: 3, survivors: ["zombie-1"], losses: [], enemiesBeaten: 2, playerDamage: 100 },
    savedAt: 10,
  };

  const withPendingRaid = (accountId: string) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(api, "getSession").mockReturnValue(SESSION);
    localStorage.setItem(`zf2r.v3.raid-finish::${accountId}`, JSON.stringify(PENDING));
    const economy = new EconomyClient(new GameState(), accountId);
    vi.spyOn(economy as any, "adoptGameplay").mockImplementation(() => {});
    return economy;
  };

  const live = () => bootstrapFixture({
    resumableRaid: {
      sessionId: "finished-but-refused", raidId: "1", startedAt: 1,
      earliestFinishAt: 16_000, expiresAt: 900_000, rosterIds: ["zombie-1"],
    },
  });

  it("drops a transcript the server will never accept and boots anyway", async () => {
    const accountId = "refused-finish";
    const economy = withPendingRaid(accountId);
    vi.spyOn(api, "bootstrap").mockResolvedValue(live());
    // 400 is not retryable: this body will be refused for as long as it exists.
    const finish = vi.spyOn(api, "raidFinish")
      .mockRejectedValue(new api.ApiError(400, "bad_roster_partition"));

    const result = await (economy as any).recoverResumableRaid(live(), true);

    expect(finish).toHaveBeenCalledOnce();
    expect(result).toBeTruthy(); // a bootstrap came back rather than an exception
    expect(localStorage.getItem(`zf2r.v3.raid-finish::${accountId}`)).toBeNull();
  });

  it("keeps a transcript the wire merely lost, and comes back for it", async () => {
    vi.useFakeTimers();
    const accountId = "offline-finish";
    const economy = withPendingRaid(accountId);
    vi.spyOn(api, "bootstrap").mockResolvedValue(live());
    // Stubbed at the sendRaidFinish seam rather than the wire: its own 16-second retry
    // ladder is long-standing behaviour and not what this covers. What is covered is
    // what the caller does once that ladder has given up.
    vi.spyOn(economy as any, "sendRaidFinish")
      .mockRejectedValue(new api.ApiError(0, "offline"));

    const result = await (economy as any).recoverResumableRaid(live(), true);

    expect(result).toBeTruthy();
    // The fight is still owed: the transcript survives and a retry is pending.
    expect(localStorage.getItem(`zf2r.v3.raid-finish::${accountId}`)).not.toBeNull();
    expect((economy as any).recoveryTimer).not.toBeNull();
  });

  it("boots past an abandon it could not post either", async () => {
    const economy = withPendingRaid("abandon-refused");
    localStorage.removeItem("zf2r.v3.raid-finish::abandon-refused");
    vi.spyOn(api, "bootstrap").mockResolvedValue(live());
    vi.spyOn(api, "raidFinish").mockRejectedValue(new api.ApiError(400, "bad_session"));

    await expect((economy as any).recoverResumableRaid(live(), true)).resolves.toBeTruthy();
  });
});
