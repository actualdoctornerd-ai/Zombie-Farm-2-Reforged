// Best-in-slot masks for the Raid Lab. See bestMutations.ts.
//
// This is a dev tool, so what needs pinning is not the exact picks (a new mutation should
// be free to change them) but that the thing it hands the sim is LEGAL and is genuinely the
// strongest set — a maxed roster that quietly wore an illegal mask, or a merely-good one,
// would make every difficulty reading taken against it wrong in a direction nobody checks.
import { describe, expect, it } from "vitest";
import { bestMutationMask, bestMutationSummary } from "./bestMutations";
import {
  applyBodyTypeRestriction, bitsOf, MUTATION_LIST, mutationsOf, occupiedSlots, SLOTS,
} from "../zombie/mutations";
import zombiesJson from "../../public/assets/zombies.json";

interface Species { key: string; name: string; group: string; str: number; dex: number; con: number }
const species = zombiesJson as Species[];
const find = (key: string) => species.find((z) => z.key === key)!;

/** The same ladder the builder maximises, restated here so the test is checking the claim
 *  rather than re-running the implementation. */
const strength = (s: number, d: number, c: number) =>
  Math.sqrt(Math.max(0.1, s) * Math.max(0.1, d) * Math.max(0.1, c));

function scoreOf(def: Species, mask: number): number {
  let [s, d, c] = [def.str, def.dex, def.con];
  for (const m of mutationsOf(mask)) {
    s += m.stats.str ?? 0; d += m.stats.dex ?? 0; c += m.stats.con ?? 0;
  }
  return strength(s, d, c);
}

describe("best-in-slot", () => {
  it("hands out a legal mask for every species in the game", () => {
    for (const def of species) {
      const mask = bestMutationMask(def);
      // One per slot, and nothing a headless zombie cannot wear. `applyBodyTypeRestriction`
      // would silently strip an illegal bit inside makeOwned, so a mask that needs
      // stripping is a mask whose slots we wasted.
      expect(bitsOf(mask).length, `${def.key}: one mutation per slot at most`)
        .toBe(occupiedSlots(mask).size);
      expect(occupiedSlots(mask).size).toBeLessThanOrEqual(SLOTS.length);
      expect(applyBodyTypeRestriction(mask, def.group === "Headless"), `${def.key} survives the body-type filter`)
        .toBe(mask);
    }
  });

  it("really is the strongest set, not just a good one", () => {
    // Brute-force every legal combination independently of the builder and check nothing
    // beats what it chose. The builder searches exhaustively too, so this is a check that
    // the SCORE and the legality rules are what they claim — the two searches share no code.
    for (const key of ["ZombieActorRegularTier4", "ZombieActorLargeTier4", "ZombieActorHeadlessTier4", "ZombieActorVagabond"]) {
      const def = find(key);
      const chosen = scoreOf(def, bestMutationMask(def));
      const isHeadless = def.group === "Headless";
      const legal = MUTATION_LIST.filter((m) => applyBodyTypeRestriction(m.bit, isHeadless) === m.bit);
      let best = strength(def.str, def.dex, def.con);
      const walk = (i: number, mask: number, used: Set<string>) => {
        if (i === legal.length) { best = Math.max(best, scoreOf(def, mask)); return; }
        walk(i + 1, mask, used);
        const m = legal[i];
        if (used.has(m.slot)) return;
        walk(i + 1, mask + m.bit, new Set([...used, m.slot]));
      };
      walk(0, 0, new Set());
      expect(chosen, `${key} takes the best available set`).toBeCloseTo(best, 6);
    }
  });

  it("never makes a zombie weaker than leaving it alone", () => {
    // Every slot is optional in the search, which matters the day the catalog gains a
    // mutation that trades a stat away (`MutationStats` allows a negative on purpose).
    for (const def of species) {
      expect(scoreOf(def, bestMutationMask(def))).toBeGreaterThanOrEqual(
        strength(def.str, def.dex, def.con) - 1e-9,
      );
    }
  });

  it("gives a Headless the slots it has and the one head it may wear", () => {
    const summary = bestMutationSummary(find("ZombieActorHeadlessTier4"));
    const slots = [...occupiedSlots(summary.mask)].sort();
    expect(slots, "body, arm, neck — and the Pumpking that stands in for its head")
      .toEqual(["arm", "body", "head", "neck"]);
    expect(summary.label).toContain("Pumpking");
    // And never the two slots it hasn't got.
    expect(slots).not.toContain("hair_eye");
  });

  it("reports what it did, in names and in numbers", () => {
    const summary = bestMutationSummary(find("ZombieActorRegularTier4"));
    expect(summary.mask).toBeGreaterThan(0);
    expect(summary.label.split(", ").length).toBe(occupiedSlots(summary.mask).size);
    expect(summary.str + summary.dex + summary.con).toBeGreaterThan(0);
  });
});
