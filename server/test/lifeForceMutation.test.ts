import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState, type MutableGameplayState } from "../src/v3/engine";

// A crop's mutation chance on a zombie harvest is set by the farm's Life Force level:
// 5% + 10% per level per adjacent crop. The server derives the level from the objects it
// holds as PLACED, so a stored decoration adds nothing and a client cannot claim a level.

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

const gazebos = (state: MutableGameplayState, n: number, status: "placed" | "stored" = "placed") => {
  for (let i = 0; i < n; i++) {
    state.objects.objects.push({ instanceId: `g-${status}-${i}`, catalogKey: "gazeboNormal", status });
  }
};

/** A ripe zombie plot with ONE carrot beside it: one adjacent crop, so the roll is the
 *  per-crop chance itself. */
function harvestBesideOneCarrot(state: MutableGameplayState, roll: number): number {
  state.farm.plots = {
    "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    "0:4": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
  };
  const result = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 4, or: 4 }), {
    now: 1_000, random: () => roll, id: () => "lf-zombie",
  });
  return result.state.roster[0].mutation;
}

describe("Life Force sets the server's crop mutation chance", () => {
  it("is 5% with no Life Force", () => {
    expect(harvestBesideOneCarrot(freshGameplayState(), 0.049)).toBe(4);
    expect(harvestBesideOneCarrot(freshGameplayState(), 0.05)).toBe(0);
  });

  it("rises 10 points a level: 15% at level 1, 55% at level 5", () => {
    const level1 = freshGameplayState();
    gazebos(level1, 2); // 32 Life Force
    expect(harvestBesideOneCarrot(level1, 0.149)).toBe(4);
    const level1b = freshGameplayState();
    gazebos(level1b, 2);
    expect(harvestBesideOneCarrot(level1b, 0.151)).toBe(0);

    const level5 = freshGameplayState();
    gazebos(level5, 13); // 208 Life Force
    expect(harvestBesideOneCarrot(level5, 0.549)).toBe(4);
    const level5b = freshGameplayState();
    gazebos(level5b, 13);
    expect(harvestBesideOneCarrot(level5b, 0.551)).toBe(0);
  });

  it("is certain from level 10", () => {
    const state = freshGameplayState();
    gazebos(state, 29); // 464 Life Force
    expect(harvestBesideOneCarrot(state, 0.999999)).toBe(4);
  });

  it("ignores decorations that are stored rather than placed", () => {
    const state = freshGameplayState();
    gazebos(state, 29, "stored");
    expect(harvestBesideOneCarrot(state, 0.5)).toBe(0);
  });
});
