import { describe, expect, it } from "vitest";
import { lifeForceLevelRows } from "../../lifeForce";
import { levelEffectLines } from "./lifeForce";

describe("levelEffectLines", () => {
  const rows = lifeForceLevelRows();
  it("names the mutation chance, fertilize boost, the tier that stops being lifeless and the ability slot", () => {
    expect(levelEffectLines(rows[0])).toEqual([
      "Mutation chance 20%",
      "Garden fertilize chance x1.01",
      "Blue zombies are never lifeless",
      "Ability slot 1 works",
    ]);
    expect(levelEffectLines(rows[3])).toEqual([
      "Mutation chance 50%",
      "Garden fertilize chance x1.10",
      "Obsidian and special zombies are never lifeless",
      "Ability slot 4 works",
    ]);
  });
  it("shows the late-game crop and brain bonuses, and flags the max", () => {
    expect(levelEffectLines(rows[5])).toEqual(["Mutation chance 70%", "Garden fertilize chance x1.21", "Fertilized crop value +2.5%"]);
    expect(levelEffectLines(rows[9])).toEqual(["Mutation chance 100%", "Garden fertilize chance x1.55", "Fertilized crop value +12.5%"]);
    expect(levelEffectLines(rows[10])).toEqual(["Mutation chance 100%", "Garden fertilize chance x1.55", "Invasion brain drop chance +2.5%", "Fertilized crop value +15%"]);
    expect(levelEffectLines(rows[19])).toEqual(["Mutation chance 100%", "Garden fertilize chance x1.55", "Invasion brain drop chance +25%", "Fertilized crop value +37.5%", "Maximum level"]);
  });
});
