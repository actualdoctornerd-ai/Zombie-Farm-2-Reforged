// A field of plowing must travel as a handful of commands, not hundreds.
//
// The farmer emits one plow/plant per plot as it works down the queue, and a drag-paint
// stroke can cover the whole board (289 plots on a 70x70 farm). The Worker's rolling
// budget is counted in SEMANTIC commands — 120 a minute — so unmerged, a single
// full-field pass physically cannot fit through it. The outbox then spends minutes
// draining behind 429s, and `settle()` holds the next invasion launch behind the outbox:
// "I can't start battles if I have a high number of planting/plowing queued".
//
// These tests pin the fold, and the two things the fold must never break: ordering, and
// the optimistic balance.
import { describe, expect, it } from "vitest";
import { GameState } from "../GameState";
import { EconomyClient } from "./economy";
import { FARM_BULK_LIMIT, type SequencedCommand } from "./protocol";

/** The outbox's own pending list, which is what actually goes on the wire. */
const pending = (economy: EconomyClient): SequencedCommand[] =>
  (economy as unknown as { queue: { pending: SequencedCommand[] } }).queue.pending;

const plow = (economy: EconomyClient, oc: number, or: number) =>
  economy.submitFarm({ type: "plow", oc, or }, { gold: -10, xp: 1 });

const plant = (economy: EconomyClient, oc: number, or: number, cropKey = "carrot") =>
  economy.submitFarm({ type: "plant", oc, or, cropKey }, { gold: -5 });

const harvest = (economy: EconomyClient, oc: number, or: number, unitId?: string) =>
  economy.submitFarm({ type: "harvest", oc, or, unitId }, unitId ? { xp: 2 } : { gold: 16, xp: 1 });

/** The optimistic delta layered under a queued command. */
const optimisticOf = (economy: EconomyClient, sequence: number) =>
  (economy as unknown as {
    optimistic: Map<number, { gold: number; xp: number; localUnitId?: string;
      localZombieHarvests?: { id: string; oc: number; or: number }[] }>;
  }).optimistic.get(sequence);

describe("bulk farm commands", () => {
  it("folds a whole field of plowing into a single command", () => {
    const economy = new EconomyClient(new GameState(), "bulk-plow");
    for (let i = 0; i < 200; i++) plow(economy, i * 4, 0);

    const queued = pending(economy);
    expect(queued).toHaveLength(1);
    expect(queued[0].command.type).toBe("farm.plow_many");
    expect((queued[0].command as { plots: unknown[] }).plots).toHaveLength(200);
  });

  it("folds planting only while the crop stays the same", () => {
    const economy = new EconomyClient(new GameState(), "bulk-plant");
    plant(economy, 0, 0, "carrot");
    plant(economy, 4, 0, "carrot");
    plant(economy, 8, 0, "pumpkin");
    plant(economy, 12, 0, "pumpkin");

    const queued = pending(economy);
    expect(queued.map((entry) => entry.command.type))
      .toEqual(["farm.plant_many", "farm.plant_many"]);
    expect(queued.map((entry) => (entry.command as { cropKey: string }).cropKey))
      .toEqual(["carrot", "pumpkin"]);
    expect(queued.map((entry) => (entry.command as { plots: unknown[] }).plots.length))
      .toEqual([2, 2]);
  });

  it("never folds across an unrelated command", () => {
    // The fold only ever offers the LAST pending command, so a plot cannot jump ahead
    // of the harvest queued between it and the earlier plots.
    const economy = new EconomyClient(new GameState(), "bulk-order");
    plow(economy, 0, 0);
    economy.submitFarm({ type: "harvest", oc: 0, or: 0 }, {});
    plow(economy, 4, 0);

    expect(pending(economy).map((entry) => entry.command.type))
      .toEqual(["farm.plow_many", "farm.harvest_many", "farm.plow_many"]);
  });

  it("does not fold plowing into planting or the reverse", () => {
    const economy = new EconomyClient(new GameState(), "bulk-mixed");
    plow(economy, 0, 0);
    plant(economy, 0, 0);
    plow(economy, 4, 0);

    expect(pending(economy).map((entry) => entry.command.type))
      .toEqual(["farm.plow_many", "farm.plant_many", "farm.plow_many"]);
  });

  it("starts a new command once one is full", () => {
    const economy = new EconomyClient(new GameState(), "bulk-cap");
    for (let i = 0; i < FARM_BULK_LIMIT + 3; i++) plow(economy, i * 4, 0);

    const queued = pending(economy);
    expect(queued).toHaveLength(2);
    expect((queued[0].command as { plots: unknown[] }).plots).toHaveLength(FARM_BULK_LIMIT);
    expect((queued[1].command as { plots: unknown[] }).plots).toHaveLength(3);
  });

  it("accumulates every folded plot's cost onto the command it joined", () => {
    // The optimistic balance is what the player sees while the batch is in flight. A
    // fold must still spend per plot, or a field of plowing looks free until the
    // server's answer lands and the money vanishes at once.
    const state = new GameState();
    const economy = new EconomyClient(state, "bulk-optimistic");
    for (let i = 0; i < 5; i++) plow(economy, i * 4, 0);

    const optimistic = (economy as unknown as {
      optimistic: Map<number, { gold: number; xp: number }>;
    }).optimistic;
    expect(optimistic.size).toBe(1);
    const [only] = [...optimistic.values()];
    expect(only.gold).toBe(-50);
    expect(only.xp).toBe(5);
  });

  // Harvest joined plow and plant in the bulk form after "my quests take ages to
  // update": a field harvested by HAND was one semantic command per plot against the
  // Worker's 120-a-minute budget, so a big harvest crossed it inside one window and the
  // outbox backed off behind 429s — the confirmation, and with it every quest count and
  // every daily's progress, arrived minutes late.
  it("folds a hand-harvested field into a single command", () => {
    const economy = new EconomyClient(new GameState(), "bulk-harvest");
    for (let i = 0; i < 56; i++) harvest(economy, (i % 8) * 4, Math.floor(i / 8) * 4);

    const queued = pending(economy);
    expect(queued).toHaveLength(1);
    expect(queued[0].command.type).toBe("farm.harvest_many");
    expect((queued[0].command as { plots: unknown[] }).plots).toHaveLength(56);
    expect(optimisticOf(economy, queued[0].sequence)).toMatchObject({ gold: 56 * 16, xp: 56 });
  });

  it("pairs every harvested zombie with the plot it grew on, never by position", () => {
    // Two zombie crops in one command: aliasing by createdIds[0] would hand both local
    // units the first server id. The pairing rides as plot -> local unit, and the server
    // answers with createdZombieSources keyed the same way.
    const economy = new EconomyClient(new GameState(), "bulk-harvest-zombies");
    // A zombie harvest flushes at once (its mutation is server-owned); hold the flush
    // so the whole field lands in one command and the pairing itself is what is tested.
    (economy as unknown as { queue: { flush: () => Promise<void> } }).queue.flush = async () => {};
    harvest(economy, 0, 0);
    harvest(economy, 4, 0, "local-z1");
    harvest(economy, 8, 0);
    harvest(economy, 12, 0, "local-z2");

    const queued = pending(economy);
    expect(queued).toHaveLength(1);
    expect((queued[0].command as { plots: unknown[] }).plots).toHaveLength(4);
    const delta = optimisticOf(economy, queued[0].sequence)!;
    expect(delta.localUnitId).toBeUndefined();
    expect(delta.localZombieHarvests).toEqual([
      { id: "local-z1", oc: 4, or: 0 },
      { id: "local-z2", oc: 12, or: 0 },
    ]);
  });

  it("does not fold a harvest into a plow, nor a plow into a harvest", () => {
    const economy = new EconomyClient(new GameState(), "bulk-harvest-mixed");
    plow(economy, 0, 0);
    harvest(economy, 4, 0);
    plow(economy, 8, 0);

    expect(pending(economy).map((item) => item.command.type))
      .toEqual(["farm.plow_many", "farm.harvest_many", "farm.plow_many"]);
  });

  it("keeps one plot's plow a plow", () => {
    const economy = new EconomyClient(new GameState(), "bulk-single");
    plow(economy, 8, 8);

    expect(pending(economy)[0].command)
      .toEqual({ type: "farm.plow_many", plots: [{ oc: 8, or: 8 }] });
  });
});
