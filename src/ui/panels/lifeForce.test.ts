import { describe, expect, it } from "vitest";
import { lifeForceLevelRows } from "../../lifeForce";
import { levelEffectLines } from "./lifeForce";

describe("levelEffectLines", () => {
  const rows = lifeForceLevelRows();
  it("names the mutation chance, fertilize boost, the tier that stops being lifeless and the ability slot", () => {
    expect(levelEffectLines(rows[0])).toEqual([
      "Mutation chance 20%",
      "Garden fertilize chance x1.03",
      "Blue zombies are never lifeless",
      "Ability slot 1 works",
    ]);
    expect(levelEffectLines(rows[3])).toEqual([
      "Mutation chance 50%",
      "Garden fertilize chance x1.12",
      "Obsidian and special zombies are never lifeless",
      "Ability slot 4 works",
    ]);
  });
  it("lists only the mutation and fertilize lines on the levels that add nothing else, and flags the max", () => {
    expect(levelEffectLines(rows[5])).toEqual(["Mutation chance 70%", "Garden fertilize chance x1.18"]);
    expect(levelEffectLines(rows[9])).toEqual(["Mutation chance 100%", "Garden fertilize chance x1.30", "Maximum level"]);
  });
});
