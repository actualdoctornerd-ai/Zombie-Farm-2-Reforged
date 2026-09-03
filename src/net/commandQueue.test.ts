import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CommandQueue } from "./commandQueue";
import { COMMAND_BATCH_WINDOW_MS } from "./protocol";
import { clearCrumbs, readCrumbs } from "../breadcrumbs";

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `retry()` refuses to send while the browser reports itself offline. The node test
 *  environment has no `navigator.onLine`, which reads as offline. */
const stubOnline = () => vi.stubGlobal("navigator", { userAgent: "node", onLine: true });

describe("protocol v3 command queue", () => {
  it("abandons stale outbox work when another client takes ownership", () => {
    const queue = new CommandQueue("writer-loss-test");
    queue.adoptBootstrap({ ...bootstrap, writer: {
      status: "mine", generation: 1, lastActivityAt: 1,
    }, writerGeneration: 1 });
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    expect(queue.size).toBe(1);
    queue.markWriterLost();
    expect(queue.size).toBe(0);
    expect(queue.available).toBe(false);
    expect(() => queue.enqueue({ type: "farm.plow", oc: 4, or: 0 })).toThrow("gameplay_unavailable");
  });

  it("uses a fixed batch-window deadline that later commands do not extend", async () => {
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
    // Enqueue a second command 1s before the first command's window closes; it must
    // ride the SAME batch and must not push the deadline out.
    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS - 1_000);
    queue.enqueue({ type: "farm.plow", oc: 4, or: 0 });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].commands).toHaveLength(2);
  });

  it("keeps rapid purchases optimistic until the batch window closes", async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      return responseFor(batch);
    });
    const queue = new CommandQueue("batch-cap-test");
    queue.adoptBootstrap(bootstrap);
    for (let i = 0; i < 60; i++) queue.enqueue({ type: "farm.plow", oc: (i % 8) * 4, or: 0 });
    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].commands.map((entry: any) => entry.sequence)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("accepts more than one wire batch optimistically and drains later batches on later windows", async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      return responseFor(batch);
    });
    const queue = new CommandQueue("multi-window-market-test");
    queue.adoptBootstrap(bootstrap);
    for (let i = 0; i < 122; i++) queue.enqueue({ type: "power.buy", key: "insta_grow" });
    expect(queue.size).toBe(122);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].commands).toHaveLength(60);
    expect(queue.size).toBe(62);

    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].commands).toHaveLength(60);
    expect(queue.size).toBe(2);

    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS);
    expect(sent).toHaveLength(3);
    expect(sent[2].commands).toHaveLength(2);
    expect(queue.size).toBe(0);
  });

  it("settles commands queued behind an already in-flight batch", async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      if (sent.length === 1) await firstReleased;
      return responseFor(batch);
    });
    const queue = new CommandQueue("causal-settle-test");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    const firstFlush = queue.flush();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    queue.enqueue({ type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" });
    const settled = queue.settle();
    releaseFirst();
    await firstFlush;
    await settled;
    expect(sent).toHaveLength(2);
    expect(sent.flatMap((batch) => batch.commands.map((entry: any) => entry.sequence))).toEqual([1, 2]);
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

  // The server fences a batch body's deviceId against the X-Writer-Client header AND
  // against the stored writer_device_id. An envelope restored from the outbox may
  // predate the current lease — built by an older client, or with the browser-local
  // client key rebuilt underneath it — so its baked-in id no longer authenticates.
  it("stamps the current writer identity on a restored envelope", async () => {
    vi.spyOn(api, "writerRequestClientId").mockReturnValue("leased-client-id");
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push({ ...batch });
      return responseFor(batch);
    });
    const queue = new CommandQueue("stale-envelope-test");
    queue.adoptBootstrap(bootstrap);
    (queue as any).inFlight = {
      protocolVersion: 3,
      deviceId: "id-from-a-previous-client",
      batchId: "restored-batch-id",
      firstSequence: 1,
      expectedAccountVersion: 0,
      writerGeneration: 0,
      commands: [{ sequence: 1, command: { type: "farm.plow", oc: 0, or: 0 } }],
    };
    await queue.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].deviceId).toBe("leased-client-id");
    // The batchId is what carries idempotency, so re-stamping identity must not
    // disturb it: this batch may already have been applied under that id.
    expect(sent[0].batchId).toBe("restored-batch-id");
  });

  // A batch the server refuses outright was never applied, so it must be rebuilt
  // rather than replayed. Replaying it verbatim is what froze gameplay for good:
  // the envelope persists to localStorage, every recovery tick re-sent the same
  // rejected bytes, and each tap answered "Gameplay paused — reconnect to continue".
  it("rebuilds a refused batch instead of replaying it forever", async () => {
    const seen: any[] = [];
    vi.spyOn(api, "sendCommandBatch")
      .mockImplementationOnce(async (batch) => {
        seen.push({ ...batch });
        throw new api.ApiError(400, "bad_writer_command");
      })
      .mockImplementation(async (batch) => {
        seen.push({ ...batch });
        return responseFor(batch);
      });
    stubOnline();
    const reasons: string[] = [];
    const queue = new CommandQueue("refused-batch-test");
    queue.onUnavailable = (reason) => reasons.push(reason);
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    await queue.flush();
    expect(reasons).toEqual(["bad_writer_command"]);
    expect(queue.available).toBe(false);
    // The player's action survives the rejection rather than being dropped.
    expect(queue.size).toBe(1);

    await queue.retry();
    expect(seen).toHaveLength(2);
    expect(seen[1].batchId).not.toBe(seen[0].batchId);
    expect(seen[1].commands).toEqual(seen[0].commands);
    expect(queue.available).toBe(true);
    expect(queue.size).toBe(0);
  });

  // The whole point of the reason is to identify the branch from a player screenshot,
  // so a path that pauses without naming itself is worse than useless — it reads as
  // "no reason given" exactly when the report matters.
  it("names the cause on every path that pauses the queue", async () => {
    const writerless = { ...bootstrap, writer: { status: "other", generation: 2, lastActivityAt: 1 } };
    const cases: Array<[string, () => CommandQueue | Promise<CommandQueue>]> = [
      ["writer_elsewhere", () => {
        const q = new CommandQueue("reason-writer");
        q.adoptBootstrap(writerless as any);
        return q;
      }],
      ["mutations_disabled", () => {
        const q = new CommandQueue("reason-mutations");
        q.adoptBootstrap({ ...bootstrap, mutationsEnabled: false });
        return q;
      }],
      ["update_required", () => {
        const q = new CommandQueue("reason-protocol");
        q.adoptBootstrap({ ...bootstrap, minimumProtocolVersion: 99 });
        return q;
      }],
      ["writer_lost", () => {
        const q = new CommandQueue("reason-lost");
        q.adoptBootstrap(bootstrap);
        q.markWriterLost();
        return q;
      }],
      ["state_conflict", async () => {
        vi.spyOn(api, "sendCommandBatch").mockRejectedValue(new api.ApiError(409, "conflict"));
        const q = new CommandQueue("reason-conflict");
        q.adoptBootstrap(bootstrap);
        q.enqueue({ type: "farm.plow", oc: 0, or: 0 });
        await q.flush();
        return q;
      }],
      ["writer_replaced", async () => {
        vi.spyOn(api, "sendCommandBatch").mockRejectedValue(new api.ApiError(423, "writer_replaced"));
        const q = new CommandQueue("reason-replaced");
        q.adoptBootstrap(bootstrap);
        q.enqueue({ type: "farm.plow", oc: 0, or: 0 });
        await q.flush();
        return q;
      }],
      ["bad_writer_command", async () => {
        vi.spyOn(api, "sendCommandBatch").mockRejectedValue(new api.ApiError(400, "bad_writer_command"));
        const q = new CommandQueue("reason-fence");
        q.adoptBootstrap(bootstrap);
        q.enqueue({ type: "farm.plow", oc: 0, or: 0 });
        await q.flush();
        return q;
      }],
    ];
    for (const [expected, build] of cases) {
      const queue = await build();
      expect(queue.available, `${expected} should pause`).toBe(false);
      expect(queue.pauseReason, `${expected} should name itself`).toBe(expected);
      vi.restoreAllMocks();
    }
  });

  it("reports no reason while the queue is running", () => {
    const queue = new CommandQueue("reason-running");
    queue.adoptBootstrap(bootstrap);
    expect(queue.available).toBe(true);
    expect(queue.pauseReason).toBe("");
  });

  // A transient failure may have committed with the response lost. Only replaying the
  // SAME batchId collects the server's cached result, so exhausted retries must keep
  // the envelope intact — the opposite of the refused-batch case above.
  it("keeps the envelope intact when transient retries are exhausted", async () => {
    vi.useFakeTimers();
    const seen: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      seen.push({ ...batch });
      throw new api.ApiError(503, "unavailable");
    });
    const queue = new CommandQueue("transient-exhausted-test", { random: () => 0.5 });
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    const flushing = queue.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushing;
    expect(queue.available).toBe(false);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen.map((batch) => batch.batchId)).size).toBe(1);
    expect((queue as any).inFlight?.batchId).toBe(seen[0].batchId);
  });
});

// `retry()` is the one caller that clears a pause without consulting a projection.
// `reloadAfterConflict` calls it straight after a rebase that may have just discovered
// the writer moved, and firing a batch at a lease this document no longer owns answers
// 423, clears the credential and drops the player behind the takeover gate — out of
// what was only ever a version conflict.
describe("retry and the lost lease", () => {
  it("refuses to clear a pause the writer lost", async () => {
    stubOnline();
    const send = vi.spyOn(api, "sendCommandBatch").mockResolvedValue(undefined as any);
    const queue = new CommandQueue("retry-writer-lost");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    queue.markWriterLost();

    await queue.retry();

    expect(send).not.toHaveBeenCalled();
    expect(queue.available).toBe(false);
    expect(queue.pauseReason).toBe("writer_lost");
  });
});

// "Gameplay paused — reconnect to continue" was reported twice on connections that were
// demonstrably fine, and the pastes could not say which of a dozen paths paused the queue,
// whether anything resumed, or how long it had been stuck. The trail answers all three —
// but only if it records the TRANSITION rather than the state: `setPaused` runs on every
// bootstrap, and a healthy session logging "still running" would crowd out everything else.
describe("the queue's pauses are legible in a bug report", () => {
  const stubCrumbStorage = () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  };

  it("records a pause with its reason, and the resume that follows", () => {
    stubCrumbStorage();
    clearCrumbs();
    const queue = new CommandQueue("crumb-pause-test");
    queue.adoptBootstrap(bootstrap); // running
    queue.markWriterLost();          // paused
    expect(queue.available).toBe(false);
    queue.adoptBootstrap({ ...bootstrap, writer: { status: "mine", generation: 1, lastActivityAt: 1 } });
    expect(queue.available).toBe(true);

    const trail = readCrumbs().filter((c) => c.tag.startsWith("queue:"));
    expect(trail.map((c) => c.tag)).toEqual(["queue:paused", "queue:resumed"]);
    expect(trail[0].detail).toBeTruthy();          // ...and it says WHICH pause
    expect(trail[1].detail).toContain("after");    // ...and what it recovered from
  });

  it("says nothing while a healthy session keeps bootstrapping", () => {
    // Every bootstrap calls setPaused(""). A crumb per call would fill the ring in a
    // minute and push out whatever the report was actually about.
    stubCrumbStorage();
    clearCrumbs();
    const queue = new CommandQueue("crumb-quiet-test");
    for (let i = 0; i < 10; i++) queue.adoptBootstrap(bootstrap);
    expect(readCrumbs().filter((c) => c.tag.startsWith("queue:"))).toEqual([]);
  });
});

describe("the sync indicator's send-now press", () => {
  it("sends the waiting batch at once, ignores presses while it is on the wire, and keeps mid-send actions in order", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      if (sent.length === 1) await firstReleased;
      return responseFor(batch);
    });
    const queue = new CommandQueue("send-now-test");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    queue.enqueue({ type: "farm.plow", oc: 4, or: 0 });
    expect(sent).toHaveLength(0);

    // The press does not wait for the batch window.
    expect(queue.sendNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].commands.map((entry: any) => entry.sequence)).toEqual([1, 2]);

    // The player keeps farming while the batch is on the wire, and mashes the badge.
    queue.enqueue({ type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" });
    for (let i = 0; i < 5; i++) expect(queue.sendNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(queue.size).toBe(3);

    // Once it lands, the mid-send command is still waiting (its own window has not
    // elapsed) and a fresh press sends it, after everything that went before.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(queue.size).toBe(1);
    expect(queue.sendNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1].commands.map((entry: any) => entry.sequence)).toEqual([3]);
    expect(queue.size).toBe(0);

    // Nothing waiting: the press is a no-op, not a request.
    expect(queue.sendNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(COMMAND_BATCH_WINDOW_MS);
    expect(sent).toHaveLength(2);
  });

  it("does not send from a paused queue", async () => {
    const sent: any[] = [];
    vi.spyOn(api, "sendCommandBatch").mockImplementation(async (batch) => {
      sent.push(batch);
      return responseFor(batch);
    });
    const queue = new CommandQueue("send-now-paused-test");
    queue.adoptBootstrap(bootstrap);
    queue.enqueue({ type: "farm.plow", oc: 0, or: 0 });
    queue.disable("test_pause");
    expect(queue.sendNow()).toBe(false);
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });
});
