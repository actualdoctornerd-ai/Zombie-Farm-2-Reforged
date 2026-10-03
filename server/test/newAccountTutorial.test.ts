import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import {
  TUTORIAL_CARROT_PLOT, TUTORIAL_GROW_BOOST, TUTORIAL_GROW_USES, TUTORIAL_PLOTS, TUTORIAL_ZOMBIE_PLOT,
} from "../../src/tutorial/freshFarm";
import { applyCommandBatch, freshGameplayState, newAccountGameplayState } from "../src/v3/engine";

// A brand-new account arrives with the tutorial's head start: four plowed plots at the
// centre, two Insta-Grows for Tim to spend, and a one-time guarantee that the first
// zombie takes the carrot planted beside it. None of it may leak into an existing
// account, which is built from the blank `freshGameplayState`.

const CARROT_BIT = 4;
const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));
const ZOMBIE = "ZombieActorRegularTier1";

describe("a new account's starting farm", () => {
  it("has the four tutorial plots, plowed and bare", () => {
    const { plots } = newAccountGameplayState().farm;
    expect(Object.keys(plots).sort()).toEqual(TUTORIAL_PLOTS.map((p) => `${p.oc}:${p.or}`).sort());
    for (const plot of Object.values(plots)) expect(plot).toEqual({ state: "plowed" });
  });

  it("holds two Insta-Grows", () => {
    expect(newAccountGameplayState().inventory).toEqual({ [TUTORIAL_GROW_BOOST]: TUTORIAL_GROW_USES });
  });

  it("is the only start that has them: the blank farm stays blank", () => {
    const blank = freshGameplayState();
    expect(blank.farm.plots).toEqual({});
    expect(blank.inventory).toEqual({});
    expect(blank.tutorialMutation).toBe(false);
  });
});

describe("the tutorial's first zombie", () => {
  const run = () => {
    const state = newAccountGameplayState();
    const z = TUTORIAL_ZOMBIE_PLOT;
    const c = TUTORIAL_CARROT_PLOT;
    const result = applyCommandBatch(state, commands(
      { type: "farm.plant", oc: z.oc, or: z.or, cropKey: ZOMBIE },
      { type: "farm.plant", oc: c.oc, or: c.or, cropKey: "carrot" },
      { type: "power.use", key: TUTORIAL_GROW_BOOST, oc: z.oc, or: z.or },
      { type: "power.use", key: TUTORIAL_GROW_BOOST, oc: c.oc, or: c.or },
      { type: "farm.harvest", oc: z.oc, or: z.or },
    ), { now: 1_000, random: () => 0.999999, id: () => "first-zombie" });
    return { state, result };
  };

  it("plants, speeds up and harvests on the starting plots", () => {
    const { result } = run();
    expect(result.results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "applied", "applied"]);
    expect(result.state.roster).toHaveLength(1);
    expect(result.state.inventory[TUTORIAL_GROW_BOOST] ?? 0).toBe(0);
  });

  it("takes the carrot's mutation even on the worst roll, once", () => {
    const { result } = run();
    expect(result.state.roster[0].mutation & CARROT_BIT).toBe(CARROT_BIT);
    expect(result.state.tutorialMutation).toBe(false);
  });

  it("does not take it again: the next zombie rolls like anyone's", () => {
    const { result } = run();
    const state = result.state;
    state.farm.plots["11:11"] = {
      state: "planted", cropKey: ZOMBIE, plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
    };
    const again = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 11, or: 11 }), {
      now: 1_000, random: () => 0.999999, id: () => "second-zombie",
    });
    expect(again.state.roster).toHaveLength(2);
    expect(again.state.roster[1].mutation & CARROT_BIT).toBe(0);
  });

  it("is not owed to an account that was not created with the head start", () => {
    const state = freshGameplayState();
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: ZOMBIE, plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "0:4": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 4, or: 4 }), {
      now: 1_000, random: () => 0.999999, id: () => "z",
    });
    expect(result.state.roster[0].mutation & CARROT_BIT).toBe(0);
  });
});
