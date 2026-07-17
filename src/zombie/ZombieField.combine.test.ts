import { describe, expect, it } from "vitest";
import type { GameAssets, ZombieDef } from "../assets";
import type { Field } from "../Field";
import { GameState } from "../GameState";
import type { ZombiePotSave } from "../save/schema";
import { ZombieField } from "./ZombieField";

const legacyJob = (): ZombiePotSave => ({
  parentAId: "parent-a",
  parentBId: "parent-b",
  keyA: "ordinary",
  keyB: "mutant",
  maskA: 0,
  maskB: 1,
  startedAt: 1,
  finishAt: 2,
});

describe("ZombieField combine save migration", () => {
  it("hydrates legacy jobs and falls back when the multi-pot map is empty", () => {
    const state = new GameState();
    state.xp = 20_500;
    const defs = new Map<string, Partial<ZombieDef>>([
      ["ordinary", { key: "ordinary", tier: 3, group: "Large", category: "normal" }],
      ["mutant", { key: "mutant", tier: 2, group: "Small", category: "mutant" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets,
      field,
      state,
      (key) => defs.get(key) as ZombieDef | undefined
    );

    zombies.restorePots({}, legacyJob());

    expect(zombies.potFor("pot").pending).toMatchObject({
      tierA: 3,
      tierB: 2,
      baseA: false,
      baseB: true,
      groupA: "Large",
      groupB: "Small",
      specialA: false,
      specialB: false,
      playerLevel: 25,
    });
  });
});
