// Mutation tiers gate on level, like the colour classes they are.
//
// This exists because they did not, and the consequence was invisible until somebody
// looked at the grid and said a level-10 army could not possibly be beating the Robots.
// It was: `mutation: "best"` handed every roster the tier-4 mask at every level, and a
// mutation is a flat ADD, so it matters most to the weakest body. A Green at 3/1/4 is
// Strength Ladder 3.5; best-in-slot it is 22.8. Six and a half times, on the zombies the
// early columns of the difficulty grid are made of.
import { describe, expect, it } from "vitest";
import { bestMutationMask } from "../../devtools/bestMutations";
import { mutationsOf } from "../../zombie/mutations";
import { buildRoster, CATALOG, mutationTierAt, MUTATION_TIER_LEVEL } from "./roster";
import { markRoster } from "./unlockArmy";
import { effectiveStrength } from "./effectiveLadder";

const GREEN_GARDEN = CATALOG.find((z) => z.group === "Garden" && z.className === "Green")!;

describe("the mutation tier gate", () => {
  it("is derived from the colour classes, not written down", () => {
    // mutations.ts: the ladder runs "tier 1 through Silver for tier 4". So each tier's
    // level is the level its colour class unlocks at, straight off zombies.json.
    expect(MUTATION_TIER_LEVEL[1]).toBe(1);
    expect(MUTATION_TIER_LEVEL[2]).toBe(8);
    expect(MUTATION_TIER_LEVEL[3]).toBe(15);
    expect(MUTATION_TIER_LEVEL[4]).toBe(25);
    expect(mutationTierAt(1)).toBe(1);
    expect(mutationTierAt(10)).toBe(2);
    expect(mutationTierAt(20)).toBe(3);
    expect(mutationTierAt(50)).toBe(4);
  });

  it("gives a low-level account a strictly weaker mask", () => {
    const early = bestMutationMask(GREEN_GARDEN, 2);
    const late = bestMutationMask(GREEN_GARDEN, 4);
    expect(early).not.toBe(late);
    // Every mutation in the capped mask is within the cap. This is the assertion that
    // actually fails if the cap is dropped again.
    for (const m of mutationsOf(early)) expect(m.tier).toBeLessThanOrEqual(2);
    for (const m of mutationsOf(bestMutationMask(GREEN_GARDEN, 1))) expect(m.tier).toBe(1);
  });

  it("stops a level-10 ceiling roster from wearing Silver-class heads", () => {
    const spec = markRoster("ceiling", 10);
    expect(spec.mutationTier).toBe(2);
    for (const owned of buildRoster(spec).party) {
      for (const m of mutationsOf(owned.mutation)) expect(m.tier).toBeLessThanOrEqual(2);
    }
  });

  it("makes the ceiling climb with level instead of starting maxed", () => {
    // The symptom, as a number: before the gate a level-10 ceiling scored within a third
    // of a level-49 one, because the mutations were the same and they dominate a weak body.
    const at = (lv: number) => effectiveStrength(buildRoster(markRoster("ceiling", lv)).units);
    expect(at(10)).toBeLessThan(at(26));
    expect(at(26)).toBeLessThan(at(43));
    expect(at(10)).toBeLessThan(at(49) * 0.4);
  });
});
