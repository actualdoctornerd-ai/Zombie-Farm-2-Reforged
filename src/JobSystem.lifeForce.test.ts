import { describe, expect, it, vi } from "vitest";
import { GameState } from "./GameState";
import { JobSystem } from "./JobSystem";
import { QuestBus, QuestEvent } from "./quest/events";

// OFFLINE harvest of a zombie crop can fail for lack of Life Force: the crop is spent and
// pays its XP, but no zombie is grown, nothing counts as a zombie harvested, and the player
// is told. (Online the server rolls it; see server/test/lifeForceHarvest.test.ts.)

function harness(failsFor: (key: string) => boolean) {
  const state = new GameState();
  const floats: string[] = [];
  const spawned: string[] = [];
  const quest = new QuestBus();
  const post = vi.spyOn(quest, "post");
  const field = {
    ripeZombieAt: () => true,
    harvestAt: () => ({
      key: "ZombieActorRegularTier1", name: "Zombie", zombieKey: "ZombieActorRegularTier1", isZombie: true,
      sell: 0, xp: 1, fertilized: false, growMs: 1, mutationContext: { cropKeys: [], guaranteed: false },
    }),
    hasPlowFree: () => false,
  };
  const fx = vi.fn();
  const jobs = new JobSystem(
    field as never, {} as never, {} as never, state,
    (_x, _y, msg) => floats.push(msg),
    () => {},
    (key) => { spawned.push(key); return { id: "unit-1", subjectAliases: [] }; },
    quest, () => null, () => {}, () => false, () => {}, fx, () => 5, failsFor
  );
  const harvest = () =>
    (jobs as any).apply({ kind: "harvest", oc: 0, or: 0, cx: 10, cy: 10 }) as boolean;
  return { state, floats, spawned, post, fx, harvest };
}

describe("offline zombie harvest and Life Force", () => {
  it("grows the zombie as before when the roll passes", () => {
    const h = harness(() => false);
    h.harvest();
    expect(h.spawned).toEqual(["ZombieActorRegularTier1"]);
    expect(h.state.stats.zombiesGrown).toBe(1);
    expect(h.post).toHaveBeenCalledWith(QuestEvent.ZombieHarvested, "Zombie", 1, expect.anything());
    expect(h.floats).not.toContain("It didn't make it!");
  });

  it("spends the crop and pays the XP but grows nothing when the roll fails", () => {
    const h = harness(() => true);
    const xpBefore = h.state.xp;
    expect(h.harvest()).toBe(true);
    expect(h.spawned).toEqual([]);
    expect(h.state.xp).toBeGreaterThan(xpBefore);
    expect(h.state.stats.zombiesGrown).toBe(0);
    expect(h.floats).toContain("It didn't make it!");
    expect(h.fx).not.toHaveBeenCalled(); // no crop-pop for a zombie that never rose
  });

  it("does not count a failed zombie harvest toward 'harvest a zombie' quests", () => {
    const h = harness(() => true);
    h.harvest();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("still counts the crop itself as harvested", () => {
    const h = harness(() => true);
    h.harvest();
    expect(h.state.stats.harvested.ZombieActorRegularTier1).toBe(1);
  });
});
