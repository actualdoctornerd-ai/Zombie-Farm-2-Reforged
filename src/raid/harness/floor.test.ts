// Every party the harness measures is a party somebody would field.
//
// Owner, 2026-09-21: "all parties always have at least 2 healers and 1 headless."
//
// The floor lives in composition.ts as a CLASS quota, because that is the only vocabulary
// the composition layer has. What it is defending is not a class quota though — it is the
// two jobs those classes do, and a class can stop doing its job without the quota noticing
// (the Doctors are the precedent: a Garden that traded Resurrect away and kept `heal`, but
// the reverse was equally possible). So these assertions are made on the BUILT roster's
// unit abilities rather than on the composition, and they are made over the whole sampler
// output rather than over a hand-picked spec.
import { describe, expect, it } from "vitest";
import { ERAS } from "./archetypes";
import { COHORTS, sampleCohort } from "./cohorts";
import { enforceFloor, MIN_HEALERS, MIN_LINE, PARTY_FLOOR } from "./composition";
import { SWEEP_SIZE } from "./strengthSweep";
import { appropriateAt, buildRoster, HEAL_ABILITIES, isHealer } from "./roster";
import type { CombatUnit } from "../types";

const healers = (units: readonly CombatUnit[]) =>
  units.filter((u) => u.abilities.some((a) => HEAL_ABILITIES.includes(a))).length;

const line = (units: readonly CombatUnit[]) =>
  units.filter((u) => u.group === "Headless").length;

describe("the party floor", () => {
  it("holds on every sampled army, in every cohort, at every era", () => {
    let checked = 0;
    for (const era of ERAS) {
      for (const cohort of COHORTS) {
        for (const sample of sampleCohort(cohort, era, 40, "floor", SWEEP_SIZE)) {
          const { units } = buildRoster(sample.spec);
          checked++;
          expect(units).toHaveLength(SWEEP_SIZE);
          // A class that is not obtainable yet cannot be required — the floor is what a
          // player CAN field, not a wish. Every era here is past both unlocks, so both
          // requirements bind; the guard is here so an earlier era added later fails
          // loudly rather than being silently exempt.
          for (const r of PARTY_FLOOR) {
            if (!appropriateAt(r.group, sample.spec.catalogLevel ?? 45).length) continue;
            const have = r.group === "Garden" ? healers(units) : line(units);
            expect(
              have,
              `${sample.id} (${sample.mix}/${sample.order}) fielded ${have} ${r.role}`
            ).toBeGreaterThanOrEqual(r.min);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    // Eight hundred rosters built from scratch; well past vitest's 5 s default, and worth
    // it — the floor is only as good as the breadth it is checked over.
  }, 60_000);

  it("pays for the floor without changing the army SIZE", () => {
    // The whole table is binned on the Strength Ladder, which sums over the roster, so a
    // floor that quietly added bodies would move every army up a column.
    for (const size of [8, 12, 16, 20]) {
      const out = enforceFloor({ Regular: size }, size, 45);
      expect(out).not.toBeNull();
      expect(Object.values(out!).reduce((a, b) => a + b, 0)).toBe(size);
      expect(out!.Garden).toBe(MIN_HEALERS);
      expect(out!.Headless).toBe(MIN_LINE);
    }
  });

  it("takes the slots from the LARGEST class, so a lopsided mix keeps its shape", () => {
    // 8 brute / 8 mini (the owner's second example) should pay out of one of the blocks
    // and stay recognisably itself, not be rebalanced into a broad roster.
    const out = enforceFloor({ Large: 8, Small: 8 }, 16, 45)!;
    expect(out.Garden).toBe(2);
    expect(out.Headless).toBe(1);
    expect((out.Large ?? 0) + (out.Small ?? 0)).toBe(13);
    expect(Math.abs((out.Large ?? 0) - (out.Small ?? 0))).toBeLessThanOrEqual(1);
  });

  it("refuses an army too small to hold the floor rather than approximating it", () => {
    expect(enforceFloor({ Regular: 2 }, 2, 45)).toBeNull();
    expect(enforceFloor({ Regular: 3 }, 3, 45)).not.toBeNull();
  });

  it("counts a healer by its ABILITY, and only the granted few heal outside the Garden", () => {
    // Healing LEFT the Garden on 2026-09-24 (ruleset v62, docs/ABILITY_IDEAS.md): the
    // Forest Zombie took `heal` on a Female body and Old McZombie took Heal All on a
    // Regular one. The floor itself is untouched and still fills its healer quota out of
    // the Garden — what stopped being true is that the Garden is the ONLY place the job
    // turns up. So the assertion is no longer "nowhere else", it is "nowhere else by
    // ACCIDENT": anything outside the Garden that heals must be one of the two that were
    // deliberately given it, or the floor has stopped meaning what it says and PARTY_FLOOR
    // needs to name whichever class took the job over.
    const GRANTED = ["ZombieActorForest", "ZombieActorOldMcZombie"];
    for (const group of ["Headless", "Regular", "Female", "Large", "Small"] as const) {
      for (const stray of appropriateAt(group, 50).filter(isHealer)) {
        expect(GRANTED, `${group}: ${stray.key}`).toContain(stray.key);
      }
    }
    const gardens = appropriateAt("Garden", 50);
    expect(gardens.length).toBeGreaterThan(0);
    expect(gardens.every(isHealer)).toBe(true);
  });
});
