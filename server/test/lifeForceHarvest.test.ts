import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState, type MutableGameplayState } from "../src/v3/engine";

// A zombie harvest can come out lifeless: 10% for each colour tier above Green, less 10%
// for each Life Force level. Green never fails. The harvest still goes through (the crop is spent and pays its
// XP) but no zombie is made. A farm with no zombies yet never fails.

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

const TIER1 = "ZombieActorRegularTier1";   // Green, tier 1
const TIER2 = "ZombieActorSmallTier2";     // Blue, tier 2
const OBSIDIAN = "ZombieActorGardenTier6"; // Obsidian, counts as tier 5
const SPECIAL = "ZombieActorZomBetty";     // special, counts as tier 5

/** `levels` Life Force levels worth of decor: 20, 45, 75, 110, 155, ... */
const gazebos = (state: MutableGameplayState, count: number) => {
  for (let i = 0; i < count; i++) {
    state.objects.objects.push({ instanceId: `g-${i}`, catalogKey: "gazeboNormal", status: "placed" });
  }
};
const level0 = () => freshGameplayState();
const level1 = () => { const s = freshGameplayState(); gazebos(s, 2); return s; };      // 32
const level5 = () => { const s = freshGameplayState(); gazebos(s, 13); return s; };     // 208

/** A farm that already owns a zombie (so the first-zombie exemption is spent) with one
 *  ripe zombie crop on the plot at 0:0. */
function withRipe(state: MutableGameplayState, cropKey: string): MutableGameplayState {
  state.roster.push({ id: "owned", key: TIER1, mutation: 0, invasions: 0, stored: false });
  state.farm.plots["0:0"] = {
    state: "planted", cropKey, plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
  };
  return state;
}

const harvest = (state: MutableGameplayState, roll: number) =>
  applyCommandBatch(state, commands({ type: "farm.harvest", oc: 0, or: 0 }), {
    now: 1_000, random: () => roll, id: () => "new-zombie",
  });

describe("zombie harvest failure from Life Force", () => {
  it("fails a tier-2 zombie 10% of the time at level 0, and still spends the crop and pays XP", () => {
    const state = withRipe(level0(), TIER2);
    const xpBefore = state.balance.xp;
    const result = harvest(state, 0.09);
    expect(result.results[0]).toMatchObject({
      status: "applied", failedZombiePlots: [{ oc: 0, or: 0 }],
    });
    expect(result.results[0].createdIds ?? []).toEqual([]);
    expect(result.state.roster.map((u) => u.id)).toEqual(["owned"]);
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.balance.xp).toBeGreaterThan(xpBefore);
    expect(result.createdZombieIds).toEqual([]);
  });

  it("succeeds when the roll is at or above the chance", () => {
    const result = harvest(withRipe(level0(), TIER2), 0.1);
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["new-zombie"] });
    expect(result.results[0].failedZombiePlots).toBeUndefined();
    expect(result.state.roster.map((u) => u.id)).toEqual(["owned", "new-zombie"]);
  });

  it("never fails the farm's first zombie, whatever the roll", () => {
    const state = level0();
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: TIER1, plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
    };
    const result = harvest(state, 0);
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["new-zombie"] });
  });

  it("never fails a Green zombie, at any level, whatever the roll", () => {
    for (const make of [level0, level1, level5]) {
      expect(harvest(withRipe(make(), TIER1), 0).results[0].failedZombiePlots).toBeUndefined();
    }
  });

  it("is safe once the level reaches tier - 1: level 1 for a Blue", () => {
    expect(harvest(withRipe(level0(), TIER2), 0).results[0].failedZombiePlots).toEqual([{ oc: 0, or: 0 }]);
    expect(harvest(withRipe(level1(), TIER2), 0).results[0].failedZombiePlots).toBeUndefined();
  });

  it("counts Obsidian and special zombies as tier 5: 40% at level 0, safe from level 4", () => {
    const level4 = () => { const s = freshGameplayState(); gazebos(s, 9); return s; }; // 144 + 9 shed = 153
    for (const key of [OBSIDIAN, SPECIAL]) {
      expect(harvest(withRipe(level0(), key), 0.399).results[0].failedZombiePlots).toEqual([{ oc: 0, or: 0 }]);
      expect(harvest(withRipe(level0(), key), 0.4).results[0].failedZombiePlots).toBeUndefined();
      expect(harvest(withRipe(level4(), key), 0).results[0].failedZombiePlots).toBeUndefined();
    }
  });

  it("counts only PLACED decor toward the level", () => {
    const state = level0();
    for (let i = 0; i < 4; i++) {
      state.objects.objects.push({ instanceId: `s-${i}`, catalogKey: "gazeboNormal", status: "stored" });
    }
    expect(harvest(withRipe(state, TIER2), 0).results[0].failedZombiePlots).toEqual([{ oc: 0, or: 0 }]);
  });

  it("reports the failed plots of a bulk harvest and an Insta-Harvest", () => {
    const farm = (): MutableGameplayState => {
      const state = level0();
      state.roster.push({ id: "owned", key: TIER1, mutation: 0, invasions: 0, stored: false });
      for (const [i, oc] of [0, 4].entries()) {
        state.farm.plots[`${oc}:0`] = {
          state: "planted", cropKey: TIER2, plantedAt: i, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
        };
      }
      return state;
    };
    const bulk = applyCommandBatch(farm(), commands({ type: "farm.harvest_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] }),
      { now: 1_000, random: () => 0, id: () => "x" });
    expect(bulk.results[0].failedZombiePlots).toEqual([{ oc: 0, or: 0 }, { oc: 4, or: 0 }]);
    expect(bulk.state.roster).toHaveLength(1);

    const state = farm();
    state.inventory.insta_harvest = 1;
    const power = applyCommandBatch(state, commands({ type: "power.use", key: "insta_harvest" }),
      { now: 1_000, random: () => 0, id: () => "y" });
    expect(power.results[0].failedZombiePlots).toHaveLength(2);
    expect(power.state.roster).toHaveLength(1);
  });

  it("does not touch ordinary crops", () => {
    const state = level0();
    state.roster.push({ id: "owned", key: TIER1, mutation: 0, invasions: 0, stored: false });
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false,
    };
    const result = harvest(state, 0);
    expect(result.results[0].failedZombiePlots).toBeUndefined();
    expect(result.state.balance.gold).toBeGreaterThan(state.balance.gold);
  });
});
