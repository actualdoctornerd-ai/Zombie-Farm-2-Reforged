import { describe, expect, it } from "vitest";
import { zombieBasicAttackName } from "./zombieAttackPresentation";

describe("zombieBasicAttackName", () => {
  it("alternates bite and scratch after every completed attack", () => {
    expect([0, 1, 2, 3].map((count) => zombieBasicAttackName(0, count)))
      .toEqual(["ZombieBite", "ZombieScratch", "ZombieBite", "ZombieScratch"]);
  });

  it("offsets neighboring zombies so a horde uses both presentations together", () => {
    expect([0, 1, 2, 3].map((seed) => zombieBasicAttackName(seed, 0)))
      .toEqual(["ZombieBite", "ZombieScratch", "ZombieBite", "ZombieScratch"]);
  });
});
