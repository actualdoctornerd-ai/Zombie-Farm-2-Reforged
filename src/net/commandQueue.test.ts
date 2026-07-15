import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CommandQueue } from "./commandQueue";

const bootstrap = {
  accountVersion: 0,
  writerGeneration: 0,
  writerDeviceId: null,
  mutationsEnabled: true,
  minimumProtocolVersion: 3,
} as any;

const responseFor = (batch: any) => ({
  protocolVersion: 3,
  batchId: batch.batchId,
  accountVersion: batch.expectedAccountVersion + 1,
  writerGeneration: 1,
  serverTime: Date.now(),
  results: batch.commands.map((entry: any) => ({ sequence: entry.sequence, status: "applied" })),
  gameplay: {
    balance: { gold: 200, brains: 15, xp: 0 },
    farm: { version: 0, plots: {} },
    objects: { version: 0, objects: [] },
    quests: { version: 0, completed: [], progress: [] },
    inventory: {}, storage: { received: {}, stored: {} }, roster: [], farmSize: 30,
    climates: ["grass"], zombieMax: 16, tutorialRewarded: false, raids: { progress: {}, lastRaidAt: 0 },
  },
  farmVersionBefore: 0,
  farmVersionAfter: 0,
  netDelta: { gold: 0, brains: 0, xp: 0 },
  questChanges: [],
  createdZombieIds: [],
} as any);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("protocol v3 command queue", () => {
  it("uses a fixed ten-second deadline that later commands do not extend", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      return responseFor(batch);
    });
    const queue = new CommandQueue("fixed-window-test");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await vi.advanceTimersByTimeAsync(9_000);
    queue.enqueue({ type: "farm.plow", oc: 4, or: 0 });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].commands).toHaveLength(2);
  });

  it("flushes at 64 commands and keeps one ordered in-flight batch", async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      return responseFor(batch);
    });
    const queue = new CommandQueue("batch-cap-test");
    queue.adoptBootstrap(bootstrap);
    for (let i = 0; i < 64; i++) queue.enqueue({ type: "farm.plow", oc: (i % 8) * 4, or: 0 });
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0].commands.map((entry: any) => entry.sequence)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it("retries an identical 429 batch and never retries validation 4xx", async () => {
    vi.useFakeTimers();
    const seen: any[] = [];
    const transport = vi.spyOn(api, "sendCommandBatch")
      .mockImplementationOnce(async (batch) => {
        seen.push(batch);
        throw new api.ApiError(429, "rate_limited", { retryAfterMs: 1_000 });
      })
      .mockImplementationOnce(async (batch) => {
        seen.push(batch);
        return responseFor(batch);
      });
    const queue = new CommandQueue("retry-test", { random: () => 0.5 });
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    const flushing = queue.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushing;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);

    transport.mockReset().mockRejectedValue(new api.ApiError(422, "bad_command"));
    const validationQueue = new CommandQueue("validation-test");
    validationQueue.adoptBootstrap(bootstrap);
    validationQueue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await validationQueue.flush();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rebases an unapplied conflict only after authoritative bootstrap", async () => {
    vi.spyOn(api, "deviceId").mockReturnValue("device-aaaaaaaa");
    const seen: any[] = [];
    vi.spyOn(api, "sendCommandBatch")
      .mockImplementationOnce(async (batch) => {
        seen.push(batch);
        throw new api.ApiError(409, "writer_taken");
      })
      .mockImplementationOnce(async (batch) => {
        seen.push(batch);
        return responseFor(batch);
      });
    const queue = new CommandQueue("conflict-rebase-test");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await queue.flush();
    queue.rebaseAfterConflict({ ...bootstrap, accountVersion: 5, writerGeneration: 2,
      writerDeviceId: null });
    await queue.flush();
    expect(seen).toHaveLength(2);
    expect(seen[1].batchId).not.toBe(seen[0].batchId);
    expect(seen[1].expectedAccountVersion).toBe(5);
    expect(seen[1].commands).toEqual(seen[0].commands);
  });
});
