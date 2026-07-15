import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState } from "../src/v3/engine";

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

describe("protocol v3 command engine", () => {
  it("accepts the freely placed, non-grid-aligned plot used by the tutorial", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 15, or: 12 },
      { type: "farm.plant", oc: 15, or: 12, cropKey: "ZombieActorRegularTier1" },
      { type: "power.buy", key: "insta_grow" },
    ), { now: 1_000 });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied", "applied"]);
    expect(result.state.farm.plots["15:12"]).toMatchObject({
      state: "planted", cropKey: "ZombieActorRegularTier1", zombie: true,
    });
    expect(result.state.balance).toMatchObject({ gold: 155, brains: 5 });
  });

  it("rejects a new free-placed plot whose footprint overlaps another plot", () => {
    const state = freshGameplayState();
    state.farm.plots["5:5"] = { state: "spent" };
    const result = applyCommandBatch(state, commands({ type: "farm.plow", oc: 7, or: 7 }), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "plot_overlap" });
  });

  it("applies a causally ordered mixed farm batch with server timestamps", () => {
    const state = freshGameplayState();
    const now = 1_000_000;
    const planted = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.harvest", oc: 0, or: 0 },
    ), { now, random: () => 1, id: () => "unit" });

    expect(planted.results.map((result) => result.status)).toEqual(["applied", "applied", "rejected"]);
    expect(planted.results[2].error).toBe("not_grown");
    expect(planted.state.balance.gold).toBe(185);
    expect(planted.state.farm.plots["0:0"]).toMatchObject({
      state: "planted",
      cropKey: "carrot",
      plantedAt: now,
      growMs: 900_000,
      sell: 16,
    });
  });

  it("marks same-resource followers dependency_failed while independent commands continue", () => {
    const state = freshGameplayState();
    state.balance.gold = 0;
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.remove", oc: 4, or: 0 },
    ), { now: 1 });
    expect(result.results).toEqual([
      { sequence: 1, status: "rejected", error: "insufficient" },
      { sequence: 2, status: "dependency_failed", error: "prior_command_failed" },
      { sequence: 3, status: "rejected", error: "nothing_to_remove" },
    ]);
  });

  it("removing a visual plot deletes its paid soil and crop without refund", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.remove", oc: 0, or: 0 },
    ), { now: 10_000, random: () => 1 });
    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
    expect(result.state.farm.plots["0:0"]).toBeUndefined();
    expect(result.state.balance.gold).toBe(185);
  });

  it("Harvest power is one atomic command, orders zombies oldest-first, and leaves excess planted", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.zombieMax = 1;
    state.farm.plots = {
      "0:0": { state: "planted", cropKey: "carrot", plantedAt: 100, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:0": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 10, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "8:0": { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 20, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    };
    const ids = ["server-z1", "server-z2"];
    const result = applyCommandBatch(state, commands({ type: "power.use", key: "insta_harvest" }), {
      now: 1_000,
      id: () => ids.shift() ?? "unexpected",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("applied");
    expect(result.state.inventory.insta_harvest).toBe(0);
    expect(result.state.roster.find((unit) => unit.id === "server-z1")).toMatchObject({ key: "ZombieActorRegularTier1", stored: false });
    expect(result.state.farm.plots["4:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.farm.plots["8:0"]).toMatchObject({ state: "planted", cropKey: "ZombieActorGirlTier1" });
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "spent", zombie: false });
  });

  it("does not consume Harvest power when capacity blocks its only ripe zombie", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.zombieMax = 1;
    state.roster.push({ id: "existing", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false });
    state.farm.plots["0:0"] = { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true };
    const result = applyCommandBatch(state, commands({ type: "power.use", key: "insta_harvest" }), { now: 1_000 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "no_effect" });
    expect(result.state.inventory.insta_harvest).toBe(1);
    expect(result.state.farm.plots["0:0"].state).toBe("planted");
  });

  it("Plow power changes spent plots only and is not consumed on no-op", () => {
    const state = freshGameplayState();
    state.inventory.insta_plow = 2;
    state.farm.plots = {
      "0:0": { state: "spent" },
      "4:0": { state: "plowed" },
      "8:0": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
    };
    const first = applyCommandBatch(state, commands({ type: "power.use", key: "insta_plow" }), { now: 1 });
    expect(first.results[0].status).toBe("applied");
    expect(first.state.inventory.insta_plow).toBe(1);
    expect(first.state.farm.plots["0:0"].state).toBe("plowed");
    expect(first.state.farm.plots["8:0"].state).toBe("planted");
    const second = applyCommandBatch(first.state, commands({ type: "power.use", key: "insta_plow" }), { now: 2 });
    expect(second.results[0]).toMatchObject({ status: "rejected", error: "no_effect" });
    expect(second.state.inventory.insta_plow).toBe(1);
  });

  it("coalesces duplicate tree ids and aggregates rewards into state once", () => {
    const state = freshGameplayState();
    state.objects.objects.push({ instanceId: "tree-1", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 });
    const result = applyCommandBatch(state, commands({ type: "object.harvest_trees", instanceIds: ["tree-1", "tree-1"] }), { now: 100 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.gold).toBeGreaterThan(200);
    expect(result.state.objects.objects[0].readyAt).toBeGreaterThan(100);
  });

  it("derives combine output and id from server-held parents", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 1, invasions: 5, stored: false },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 2, invasions: 9, stored: false },
    ];
    const result = applyCommandBatch(state, commands({ type: "roster.combine", parentAId: "a", parentBId: "b" }), {
      now: 1,
      random: () => 0,
      id: () => "server-child",
    });
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["server-child"] });
    expect(result.state.roster).toEqual([
      { id: "server-child", key: "ZombieActorGirlTier1", mutation: 3, invasions: 0, stored: false },
    ]);
  });

  it("grants the tutorial completion bonus exactly once", () => {
    const state = freshGameplayState();
    const first = applyCommandBatch(state, commands({ type: "tutorial.complete" }), { now: 1 });
    expect(first.results[0].status).toBe("applied");
    expect(first.state.balance.gold).toBe(400);
    expect(first.state.tutorialRewarded).toBe(true);
    const repeated = applyCommandBatch(first.state, commands({ type: "tutorial.complete" }), { now: 2 });
    expect(repeated.results[0]).toMatchObject({ status: "rejected", error: "already_claimed" });
    expect(repeated.state.balance.gold).toBe(400);
  });
});
