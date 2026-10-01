import { describe, expect, it } from "vitest";
import { lifeForceLevelRows } from "../../lifeForce";
import { levelEffectLines } from "./lifeForce";

describe("levelEffectLines", () => {
  const rows = lifeForceLevelRows();
  it("names the mutation chance, the tier that stops failing and the ability slot", () => {
    expect(levelEffectLines(rows[0])).toEqual([
      "Mutation chance 15%",
      "Green zombies never fail to harvest",
      "Ability slot 1 works",
    ]);
    expect(levelEffectLines(rows[4])).toEqual([
      "Mutation chance 55%",
      "Obsidian and special zombies never fail to harvest",
    ]);
  });
  it("lists only the mutation chance on the levels that add nothing else, and flags the max", () => {
    expect(levelEffectLines(rows[5])).toEqual(["Mutation chance 65%"]);
    expect(levelEffectLines(rows[9])).toEqual(["Mutation chance 100%", "Maximum level"]);
  });
});
