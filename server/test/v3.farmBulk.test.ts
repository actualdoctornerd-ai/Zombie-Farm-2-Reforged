// The bulk forms of the two farm commands a drag-paint stroke produces by the hundred.
//
// `farm.plow_many` / `farm.plant_many` exist because the Worker's rolling-minute budget
// counts SEMANTIC commands, and one plot per command means a single full-field pass
// cannot fit through it. Applying them must be indistinguishable from sending the plots
// one at a time — including the parts that depend on what the earlier plots in the SAME
// command already did.
import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState, PLOW_COST_V3 } from "../src/v3/engine";

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

/** `count` non-overlapping 4x4 plot origins laid out inside a 30-tile farm. */
const plots = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ oc: (i % 6) * 4, or: Math.floor(i / 6) * 4 }));

/** A farm with room and money for anything these tests ask of it. */
const richFarm = () => {
  const state = freshGameplayState();
  state.balance.gold = 10_000;
  return state;
};

describe("bulk farm commands", () => {
  it("plows every plot in one command and charges for each", () => {
    const state = richFarm();
    const result = applyCommandBatch(
      state, commands({ type: "farm.plow_many", plots: plots(20) }), { now: 1 }
    );

    expect(result.results[0]).toEqual({ sequence: 1, status: "applied" });
    expect(Object.keys(result.state.farm.plots)).toHaveLength(20);
    expect(result.state.balance.gold).toBe(10_000 - 20 * PLOW_COST_V3);
  });

  it("matches sending the same plots one at a time", () => {
    // The whole contract in one assertion: bulk is a transport change, not a rules
    // change. Anything a future edit does to one form has to hold for the other.
    const bulkResult = applyCommandBatch(
      richFarm(), commands({ type: "farm.plow_many", plots: plots(12) }), { now: 1 }
    );
    const singleResult = applyCommandBatch(
      richFarm(),
      commands(...plots(12).map((plot) => ({ type: "farm.plow" as const, ...plot }))),
      { now: 1 }
    );

    expect(bulkResult.state.farm.plots).toEqual(singleResult.state.farm.plots);
    expect(bulkResult.state.balance).toEqual(singleResult.state.balance);
    expect(bulkResult.state.quests).toEqual(singleResult.state.quests);
  });

  it("plants every plot in one command", () => {
    const result = applyCommandBatch(richFarm(), commands(
      { type: "farm.plow_many", plots: plots(3) },
      { type: "farm.plant_many", cropKey: "carrot", plots: [
        { oc: 0, or: 0 }, { oc: 4, or: 0, fertilized: true }, { oc: 8, or: 0 },
      ] },
    ), { now: 1_000, random: () => 1 });

    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "planted", fertilized: false });
    expect(result.state.farm.plots["4:0"]).toMatchObject({ state: "planted", fertilized: true });
    expect(result.state.farm.plots["8:0"]).toMatchObject({ state: "planted" });
  });

  it("lays the soil it can afford and reports the rest, rather than failing whole", () => {
    // A stroke that outruns the player's gold must still plow what the gold covers —
    // the same outcome the per-plot commands gave — and say how many it skipped.
    const state = freshGameplayState();
    state.balance.gold = PLOW_COST_V3 * 3;
    const result = applyCommandBatch(
      state, commands({ type: "farm.plow_many", plots: plots(10) }), { now: 1 }
    );

    expect(result.results[0].status).toBe("applied");
    expect(result.results[0].rejectedPlots).toBe(7);
    expect(result.results[0].rejectedPlotError).toBe("insufficient");
    expect(Object.keys(result.state.farm.plots)).toHaveLength(3);
    expect(result.state.balance.gold).toBe(0);
  });

  it("rejects the whole command when no plot at all could be applied", () => {
    // Nothing happened, so the player gets the ordinary rejection toast.
    const state = freshGameplayState();
    state.balance.gold = 0;
    const result = applyCommandBatch(
      state, commands({ type: "farm.plow_many", plots: plots(5) }), { now: 1 }
    );

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(result.state.farm.plots).toEqual({});
  });

  it("judges overlap against soil laid earlier in the same command", () => {
    // Plots are 4x4. A second plot two tiles over collides with the first, and must be
    // refused exactly as it would if the two arrived as separate commands.
    const result = applyCommandBatch(richFarm(), commands(
      { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 2, or: 0 }] }
    ), { now: 1 });

    expect(result.results[0].rejectedPlots).toBe(1);
    expect(result.results[0].rejectedPlotError).toBe("plot_overlap");
    expect(Object.keys(result.state.farm.plots)).toEqual(["0:0"]);
  });

  it("applies XP plot by plot, so a level crossed mid-command counts", () => {
    // A level-up zeroes the invasion cooldown. Counting the command's XP in one lump at
    // the end would still cross the threshold here, but a bulk command that only ALMOST
    // reaches it plot by plot must not, so the per-plot application is what is pinned.
    const state = richFarm();
    state.balance.xp = 24;
    state.raids.lastRaidAt = 123_456;
    const singles = richFarm();
    singles.balance.xp = 24;
    singles.raids.lastRaidAt = 123_456;

    const bulk = applyCommandBatch(
      state, commands({ type: "farm.plow_many", plots: plots(4) }), { now: 1 }
    );
    const oneAtATime = applyCommandBatch(
      singles,
      commands(...plots(4).map((plot) => ({ type: "farm.plow" as const, ...plot }))),
      { now: 1 }
    );

    expect(bulk.state.balance.xp).toBe(oneAtATime.state.balance.xp);
    expect(bulk.state.raids.lastRaidAt).toBe(0); // the level-up zeroed the cooldown
  });

  // The harvest half. Same contract as plowing — a transport change, not a rules
  // change — plus the one thing a harvest has that a plow does not: what it grew.
  it("harvests every ripe plot in one command and matches one at a time", () => {
    const grow = (state: ReturnType<typeof richFarm>) => {
      const planted = applyCommandBatch(state, commands(
        { type: "farm.plow_many", plots: plots(12) },
        { type: "farm.plant_many", cropKey: "carrot", plots: plots(12) },
      ), { now: 1 });
      expect(planted.results.every((r) => r.status === "applied")).toBe(true);
      return planted.state;
    };
    const ripeAt = 1 + 24 * 3_600_000;

    const bulk = applyCommandBatch(grow(richFarm()),
      commands({ type: "farm.harvest_many", plots: plots(12) }), { now: ripeAt });
    expect(bulk.results[0]).toEqual({ sequence: 1, status: "applied" });
    expect(Object.values(bulk.state.farm.plots).every((plot) => plot.state === "spent")).toBe(true);

    const single = applyCommandBatch(grow(richFarm()),
      commands(...plots(12).map((plot) => ({ type: "farm.harvest" as const, ...plot }))), { now: ripeAt });
    expect(single.results.every((r) => r.status === "applied")).toBe(true);
    expect(bulk.state.balance).toEqual(single.state.balance);
    expect(bulk.state.farm.plots).toEqual(single.state.farm.plots);
    // And the same quest events, in the same order — the counts a daily reads.
    expect(bulk.questChanges).toEqual(single.questChanges);
  });

  it("pairs the zombies a bulk harvest grows to the plots they grew on", () => {
    const state = richFarm();
    state.balance.brains = 500;
    state.balance.xp = 20_500; // level 25: every crop here is unlocked
    const planted = applyCommandBatch(state, commands(
      { type: "farm.plow_many", plots: plots(3) },
      { type: "farm.plant_many", cropKey: "carrot", plots: [plots(3)[0]] },
      { type: "farm.plant_many", cropKey: "ZombieActorRegularTier1", plots: [plots(3)[1], plots(3)[2]] },
    ), { now: 1 });
    expect(planted.results.every((r) => r.status === "applied"), JSON.stringify(planted.results)).toBe(true);

    const reaped = applyCommandBatch(planted.state,
      commands({ type: "farm.harvest_many", plots: plots(3) }), { now: 1 + 7 * 86_400_000 });
    const result = reaped.results[0];
    expect(result.status).toBe("applied");
    expect(result.createdIds).toHaveLength(2);
    expect(result.createdZombieSources).toEqual([
      { id: result.createdIds![0], oc: plots(3)[1].oc, or: plots(3)[1].or },
      { id: result.createdIds![1], oc: plots(3)[2].oc, or: plots(3)[2].or },
    ]);
    expect(reaped.createdZombieIds).toEqual(result.createdIds);
  });

  it("harvests what is ripe and reports the plots that are not", () => {
    const planted = applyCommandBatch(richFarm(), commands(
      { type: "farm.plow_many", plots: plots(2) },
      { type: "farm.plant_many", cropKey: "carrot", plots: plots(2) },
    ), { now: 1 });
    // Only the first plot is planted early enough to be ripe by `now`.
    (planted.state.farm.plots["0:0"] as { plantedAt: number }).plantedAt = -10_000_000;
    const reaped = applyCommandBatch(planted.state,
      commands({ type: "farm.harvest_many", plots: plots(2) }), { now: 2 });
    expect(reaped.results[0]).toMatchObject({ status: "applied", rejectedPlots: 1, rejectedPlotError: "not_grown" });
    expect(reaped.state.farm.plots["0:0"].state).toBe("spent");
    expect(reaped.state.farm.plots["4:0"].state).toBe("planted");
  });

  it("applies nothing, and refuses nothing, for an empty plot list", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(
      state, commands({ type: "farm.plow_many", plots: [] }), { now: 1 }
    );

    expect(result.results[0]).toEqual({ sequence: 1, status: "applied" });
    expect(result.state.farm.plots).toEqual({});
  });
});
