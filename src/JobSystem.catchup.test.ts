import { afterEach, describe, expect, it, vi } from "vitest";
import { Container } from "pixi.js";
import { JobSystem } from "./JobSystem";

class FakeWalk {
  moving = false;
  private remaining = 0;
  private onArrive: (() => void) | null = null;
  readonly arrivals: number[] = [];

  goToPoint(x: number, _y: number, onArrive?: () => void) {
    this.moving = true;
    this.remaining = 0.1;
    this.onArrive = onArrive ?? null;
    this.arrivals.push(x);
    return true;
  }

  update(dt: number) {
    if (!this.moving) return;
    this.remaining -= dt;
    if (this.remaining > 0) return;
    this.moving = false;
    const callback = this.onArrive;
    this.onArrive = null;
    callback?.();
  }
}

describe("JobSystem elapsed-time catch-up", () => {
  afterEach(() => vi.useRealTimers());

  it("crosses movement callbacks and completes multiple queued jobs", () => {
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never,
      {} as never,
      walk as never,
      {} as never,
      () => {},
    );

    jobs.enqueueWalk(10, 10);
    jobs.enqueueWalk(20, 20);
    jobs.advanceElapsed(1);

    expect(walk.arrivals).toEqual([10, 20]);
    expect(walk.moving).toBe(false);
    expect(jobs.busy).toBe(false);
    expect(jobs.pendingWork).toBe(0);
  });

  it("counts the active job and the queue as pending work, for the sync badge", () => {
    // Online, a queued plot becomes a command only when the farmer reaches it, so the
    // badge reads this count as work still waiting rather than SYNCED.
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never, {} as never, walk as never, {} as never, () => {},
    );
    expect(jobs.pendingWork).toBe(0);
    jobs.enqueueWalk(10, 10);
    jobs.enqueueWalk(20, 20);
    jobs.enqueueWalk(30, 30);
    expect(jobs.pendingWork).toBe(3); // one active, two queued
    jobs.advanceElapsed(1);
    expect(jobs.pendingWork).toBe(0);
  });

  it("reports whether a restore was accepted, so a refused journal can be retried", () => {
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never, {} as never, walk as never, {} as never, () => {},
    );
    const save = { savedAt: 1, jobs: [{ kind: "walk" as const, oc: -1, or: -1, cx: 10, cy: 10 }] };

    jobs.enqueueWalk(5, 5); // a tap that landed before the journal could be replayed
    expect(jobs.busy).toBe(true);
    expect(jobs.restorePending(save, () => undefined)).toBe(false);

    jobs.advanceElapsed(1); // the live job finishes and the queue drains
    expect(walk.arrivals).toEqual([5]); // the refused journal queued nothing
    expect(jobs.busy).toBe(false);

    // The retry is accepted and replays the journal from its own elapsed time.
    expect(jobs.restorePending(save, () => undefined)).toBe(true);
    expect(walk.arrivals).toEqual([5, 10]);

    // An unusable save is consumed rather than retried forever.
    expect(jobs.restorePending(undefined, () => undefined)).toBe(true);
  });

  it("consumes walking and work time across multiple farm jobs in queue order", () => {
    const walk = new FakeWalk();
    const tilled: string[] = [];
    const feedback: { message: string; delay?: number }[] = [];
    const field = {
      highlightLayer: new Container(),
      plowHighlightLayer: new Container(),
      labelLayer: new Container(),
      resolveTill: (col: number, row: number) => ({ valid: true, oc: col, or: row }),
      reserveTill: () => {},
      unreserveTill: () => {},
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      hasPlowFree: () => false,
      tillAt: (col: number, row: number) => { tilled.push(`${col},${row}`); return true; },
    };
    const state = {
      gold: 100,
      spendGold: (amount: number) => { state.gold -= amount; },
      addXp: () => {},
      // Lifetime tally (GameState.record*): counted on every applied job.
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: null,
      onTreeHarvest: null,
      canMutateOnline: null,
    };
    const actor = { setWorking: () => {} };
    const jobs = new JobSystem(
      field as never,
      actor as never,
      walk as never,
      state as never,
      (_x, _y, message, delay) => feedback.push({ message, delay }),
    );

    expect(jobs.enqueue("till", 10, 10)).toBe(true);
    expect(jobs.enqueue("till", 20, 20)).toBe(true);
    expect(field.plowHighlightLayer.children).toHaveLength(2);
    expect(field.highlightLayer.children).toHaveLength(0);
    jobs.advanceElapsed(3);

    expect(tilled).toEqual(["10,10", "20,20"]);
    expect(state.gold).toBe(80);
    expect(feedback).toEqual([
      { message: "-10g", delay: undefined },
      { message: "+1xp", delay: 0.42 },
      { message: "-10g", delay: undefined },
      { message: "+1xp", delay: 0.42 },
    ]);
    expect(jobs.busy).toBe(false);
  });

  it("does not start queued work when no time elapsed", () => {
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never,
      {} as never,
      walk as never,
      {} as never,
      () => {},
    );

    jobs.enqueueWalk(10, 10);
    jobs.advanceElapsed(0);

    expect(walk.arrivals).toEqual([]);
    expect(jobs.busy).toBe(true);
  });

  it("holds queued farm work through a raid, then replays the raid's own duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never,
      {} as never,
      walk as never,
      {} as never,
      () => {},
    );

    jobs.enqueueWalk(10, 10);
    jobs.setPaused(true);

    // Nothing runs while the battle owns the screen — not the foreground tick, and not
    // the background clock the hidden-tab catch-up feeds in.
    jobs.advanceElapsed(30);
    jobs.update(30);
    expect(walk.arrivals).toEqual([]);
    expect(jobs.busy).toBe(true);

    // Three minutes of invasion. Coming back off it settles the queue up in one pass,
    // with no caller needing to know how long the fight took.
    vi.setSystemTime(1_180_000);
    jobs.setPaused(false);

    expect(walk.arrivals).toEqual([10]);
    expect(jobs.busy).toBe(false);
  });

  it("charges a raid's catch-up only once, and only for the paused interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const walk = new FakeWalk();
    const jobs = new JobSystem(
      {} as never, {} as never, walk as never, {} as never, () => {},
    );

    jobs.enqueueWalk(1, 1);
    jobs.setPaused(true);
    jobs.setPaused(true); // a nested pause must not restart the clock
    vi.setSystemTime(2_060_000);
    jobs.setPaused(false);
    expect(walk.arrivals).toEqual([1]);

    // Resuming an already-running queue replays nothing — only a real pause has time to
    // give back, so an unpaired setPaused(false) cannot fast-forward the farm.
    jobs.enqueueWalk(2, 2);
    vi.setSystemTime(2_120_000);
    jobs.setPaused(false);
    expect(walk.arrivals).toEqual([1]);
    expect(jobs.busy).toBe(true);
  });

  it("replays the raid silently, so a drained queue does not burst its one-shots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const sounds: string[] = [];
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      resolveTill: (col: number, row: number) => ({ valid: true, oc: col, or: row }),
      reserveTill: () => {}, unreserveTill: () => {},
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false, hasPlowFree: () => false,
      tillAt: () => true,
    };
    const state = {
      gold: 100, spendGold: (amount: number) => { state.gold -= amount; }, addXp: () => {},
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: null, onTreeHarvest: null, canMutateOnline: null,
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, new FakeWalk() as never, state as never,
      () => {}, (sound) => sounds.push(sound),
    );

    jobs.enqueue("till", 2, 2);
    jobs.enqueue("till", 6, 6);
    jobs.setPaused(true);
    vi.setSystemTime(3_180_000);
    jobs.setPaused(false);

    expect(jobs.busy).toBe(false); // both plots plowed while the player was fighting
    expect(state.gold).toBe(80);
    expect(sounds).toEqual([]);
  });

  it("suppresses one-shot audio while completing background catch-up work", () => {
    const walk = new FakeWalk();
    const sounds: string[] = [];
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      resolveTill: (col: number, row: number) => ({ valid: true, oc: col, or: row }),
      reserveTill: () => {}, unreserveTill: () => {},
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false, hasPlowFree: () => false,
      tillAt: () => true,
    };
    const state = {
      gold: 100, spendGold: () => {}, addXp: () => {},
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: null, onTreeHarvest: null, canMutateOnline: null,
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never, state as never,
      () => {}, (sound) => sounds.push(sound)
    );

    jobs.enqueue("till", 2, 2);
    jobs.advanceElapsed(3, true);

    expect(jobs.busy).toBe(false);
    expect(sounds).toEqual([]);
  });

  it("drops rejected walk destinations instead of freezing the job queue", () => {
    const walk = {
      moving: false,
      goToPoint: () => false,
      update: () => {},
    };
    const jobs = new JobSystem(
      {} as never,
      {} as never,
      walk as never,
      {} as never,
      () => {},
    );

    jobs.enqueueWalk(10, 10);
    jobs.enqueueWalk(20, 20);
    jobs.advanceElapsed(1);

    expect(jobs.busy).toBe(false);
  });

  it("walks to a queued zombie but skips harvesting when capacity filled before arrival", () => {
    const walk = new FakeWalk();
    const messages: string[] = [];
    const harvestAt = vi.fn();
    const setWorking = vi.fn();
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      isRipe: () => true, ripeZombieAt: () => true,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      harvestAt,
    };
    const state = {
      onFarm: null, onTreeHarvest: null, canMutateOnline: null,
    };
    // Room at the tap, none by the time the farmer gets there.
    let room = 1;
    const jobs = new JobSystem(
      field as never, { setWorking } as never, walk as never, state as never,
      (_x, _y, message) => messages.push(message),
      () => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => room,
    );

    expect(jobs.enqueue("harvest", 4, 8)).toBe(true);
    jobs.enqueueWalk(20, 20);
    room = 0;
    jobs.update(0);
    walk.update(0.2);
    // The next queued task starts on the following foreground tick.
    jobs.update(0);

    expect(walk.arrivals).toEqual([4, 20]);
    expect(messages).toEqual(["Army full!"]);
    expect(setWorking).not.toHaveBeenCalled();
    expect(harvestAt).not.toHaveBeenCalled();
    expect(jobs.busy).toBe(true);
  });

  it("refuses to queue more zombie harvests than the farm has room for", () => {
    const walk = new FakeWalk();
    const messages: string[] = [];
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      isRipe: () => true, ripeZombieAt: () => true,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      harvestAt: vi.fn(),
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never,
      { onFarm: null, onTreeHarvest: null, canMutateOnline: null } as never,
      (_x, _y, message) => messages.push(message),
      () => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => 1, // one free slot on a 16-cap farm holding 15
    );

    expect(jobs.enqueue("harvest", 4, 8)).toBe(true);
    // The first queued crop has already claimed the only slot.
    expect(jobs.enqueue("harvest", 12, 8)).toBe(false);
    expect(jobs.enqueue("harvest", 20, 8)).toBe(false);
    expect(messages).toEqual(["Army full!", "Army full!"]);
  });

  it("leaves the crop in the ground when the last slot is taken during the work phase", () => {
    const walk = new FakeWalk();
    const messages: string[] = [];
    const harvestAt = vi.fn();
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      isRipe: () => true, ripeZombieAt: () => true,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      harvestAt,
    };
    let room = 1;
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never,
      { onFarm: null, onTreeHarvest: null, canMutateOnline: null } as never,
      (_x, _y, message) => messages.push(message),
      () => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => room,
    );

    expect(jobs.enqueue("harvest", 4, 8)).toBe(true);
    jobs.update(0);      // walk phase
    walk.update(0.2);    // arrives with room, starts hoeing
    room = 0;            // a combine is collected mid-swing
    jobs.update(2);      // work phase completes

    expect(harvestAt).not.toHaveBeenCalled();
    expect(messages).toEqual(["Army full!"]);
    expect(jobs.busy).toBe(false);
  });

  it("retains each planting's logical completion time during catch-up", () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const walk = new FakeWalk();
    const plantedAt: number[] = [];
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      canPlant: () => true, isRipe: () => false,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      plantAt: (_oc: number, _or: number, _cfg: unknown, at: number) => {
        plantedAt.push(at);
        return true;
      },
    };
    const state = {
      gold: 100, brains: 0, level: 1,
      spendGold: (amount: number) => { state.gold -= amount; },
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: null, onTreeHarvest: null, canMutateOnline: null,
    };
    const cfg = {
      key: "carrot", name: "Carrot", stages: [], growMs: 60_000,
      cost: 1, sell: 1, xp: 1, unlockLevel: 1,
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never, state as never,
      () => {},
    );

    expect(jobs.enqueue("plant", 0, 0, cfg)).toBe(true);
    expect(jobs.enqueue("plant", 4, 0, cfg)).toBe(true);
    jobs.advanceElapsed(10, true);

    expect(plantedAt).toHaveLength(2);
    expect(plantedAt[0]).toBeLessThan(plantedAt[1]);
    expect(plantedAt[0]).toBeLessThan(now - 5_000);
    expect(plantedAt[1]).toBeLessThan(now - 5_000);
  });

  it("stamps a replayed ONLINE planting at now, the clock the server will give it", () => {
    // The mirror of the test above. Online the server is the crop's clock and it stamps
    // the plant when the command applies — for a journal replayed on return, NOW. A
    // player who planted a whole field, saw SYNCED between plots and left came back to
    // find the farmer's catch-up back-dating every remaining plot: half the field read
    // grown locally while the server had only just started its timers, the harvest was
    // refused as not grown, and the resync snapped those plots to fresh timers.
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const walk = new FakeWalk();
    const plantedAt: number[] = [];
    const farmActions: unknown[] = [];
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      canPlant: () => true, isRipe: () => false,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      plantAt: (_oc: number, _or: number, _cfg: unknown, at: number) => {
        plantedAt.push(at);
        return true;
      },
    };
    const state = {
      gold: 100, brains: 0, level: 1,
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: (action: unknown) => farmActions.push(action),
      onTreeHarvest: null, canMutateOnline: () => true,
    };
    const cfg = {
      key: "carrot", name: "Carrot", stages: [], growMs: 60_000,
      cost: 1, sell: 1, xp: 1, unlockLevel: 1,
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never, state as never,
      () => {},
    );

    expect(jobs.enqueue("plant", 0, 0, cfg)).toBe(true);
    expect(jobs.enqueue("plant", 4, 0, cfg)).toBe(true);
    jobs.advanceElapsed(10, true);

    // Both plots are planted (and both commands go to the server)...
    expect(farmActions).toHaveLength(2);
    // ...at the wall clock, not the replay cursor: nothing is back-dated online.
    expect(plantedAt).toEqual([now, now]);
  });

  it("rolls online fertilization immediately and includes it in the plant action", () => {
    const walk = new FakeWalk();
    const farmActions: unknown[] = [];
    const fertilize = vi.fn(() => "Zombee");
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      plotOriginAt: (col: number, row: number) => ({ oc: col, or: row }),
      canPlant: () => true, isRipe: () => false,
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false,
      plantAt: () => true,
    };
    const state = {
      gold: 100, brains: 0, level: 1,
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: (action: unknown) => farmActions.push(action),
      onTreeHarvest: null, canMutateOnline: () => true,
    };
    const jobs = new JobSystem(
      field as never, { setWorking: () => {} } as never, walk as never, state as never,
      () => {}, () => {}, undefined, undefined, fertilize,
    );

    expect(jobs.enqueue("plant", 0, 0, {
      key: "carrot", name: "Carrot", stages: [], growMs: 1, cost: 1, sell: 1, xp: 1,
      unlockLevel: 1,
    })).toBe(true);
    jobs.advanceElapsed(3);

    expect(fertilize).toHaveBeenCalledWith(0, 0, expect.objectContaining({ key: "carrot" }));
    expect(farmActions).toEqual([
      { type: "plant", oc: 0, or: 0, cropKey: "carrot", fertilized: true },
    ]);
  });

  it("reports the currency needed when an affordable-looking action is rejected", () => {
    const notices: [string, number][] = [];
    const field = {
      resolveTill: () => ({ valid: true, oc: 0, or: 0 }),
      hasPlowFree: () => false,
      plotOriginAt: () => ({ oc: 0, or: 0 }),
      canPlant: () => true,
      isRipe: () => false,
    };
    const jobs = new JobSystem(
      field as never, {} as never, {} as never, { gold: 0, brains: 0, level: 1 } as never,
      () => {}, () => {}, undefined, undefined, undefined, undefined, undefined,
      (currency, needed) => notices.push([currency, needed])
    );

    expect(jobs.enqueue("till", 0, 0)).toBe(false);
    expect(jobs.enqueue("plant", 0, 0, {
      key: "carrot", name: "Carrot", stages: [], growMs: 1, cost: 25, sell: 1, xp: 1,
      unlockLevel: 1,
    })).toBe(false);
    expect(notices).toEqual([["gold", 10], ["gold", 25]]);
  });

  it("serializes pending Local Farm intent and replays it after reopening", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const firstWalk = new FakeWalk();
    const field = {
      highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
      resolveTill: (col: number, row: number) => ({ valid: true, oc: col, or: row }),
      reserveTill: () => {}, unreserveTill: () => {},
      plotCenterOf: (col: number, row: number) => ({ x: col, y: row }),
      hasFastWork: () => false, hasPlowFree: () => false,
      tillAt: () => true,
    };
    const state = {
      gold: 100, spendGold: (amount: number) => { state.gold -= amount; }, addXp: () => {},
      recordPlowed: () => {}, recordPlanted: () => {}, recordHarvest: () => {}, recordTreeHarvest: () => {},
      onFarm: null, onTreeHarvest: null, canMutateOnline: null,
    };
    const first = new JobSystem(
      field as never, { setWorking: () => {} } as never, firstWalk as never, state as never, () => {},
    );
    first.enqueue("till", 4, 8);
    const saved = first.serializePending();
    expect(saved?.jobs).toMatchObject([{ kind: "till", oc: 4, or: 8 }]);

    vi.setSystemTime(1_010_000);
    const restored = new JobSystem(
      field as never, { setWorking: () => {} } as never, new FakeWalk() as never, state as never, () => {},
    );
    restored.restorePending(saved, () => undefined);

    expect(restored.busy).toBe(false);
    expect(state.gold).toBe(90);
  });
});
