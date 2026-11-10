// The pirate captain's tempo in a real Endless fight (owner, 2026-11-07): his invasion's
// mirror, against the body in front of him, from the first swing at every new arrival on,
// with nothing else on his clock.
import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { makeOwned } from "../zombie/types";
import { buildPlayerUnits } from "./CombatEngine";
import { pirateBossSlamIntervalSec } from "./combatStats";
import { beginEndlessRun } from "./endless";
import { endlessFightConfig, endlessSimFor } from "./endlessFight";

const ALL = zombiesJson as ZombieDef[];

/** Seconds between the captain's swings against a line of six of one body, both sides
 *  unkillable, so only his clock decides the gaps. Gaps longer than a swing are a new zombie walking up. */
function captainSwingGaps(body: string): { gaps: number[]; speciesSec: number } {
  const def = ALL.find((z) => z.key.includes(body))!;
  const party = Array.from({ length: 6 }, (_, i) => makeOwned(`z${i}`, def, 0, 0, 0, 0));
  const units = buildPlayerUnits(party, { abilitySlotUnlocked: () => false, playerLevel: 45 })
    .map((u) => ({ ...u, maxHp: 1e9, hp: 1e9, con: 1e7 }));
  // The captain walks in at the Ninja Dojo from the sixth location (his own ship perches him).
  const run = { ...beginEndlessRun("endless", units, "0", 1), nextWave: 16, stop: { location: "ninja" as const, modifier: null } };
  const config = endlessFightConfig(run, 45);
  config.enemyUnits = config.enemyUnits.filter((u) => u.sourceKey === "PirateStageActorBoss").slice(0, 1)
    .map((u) => ({ ...u, maxHp: 1e9, hp: 1e9, con: 1e7 }));
  expect(config.enemyUnits).toHaveLength(1);
  // Nothing else on the field: the Dojo's smoke bomb would drop a flanker in.
  config.endlessMechanics = { ...config.endlessMechanics, cooldownsMs: {} };
  const sim = endlessSimFor(config);
  const internals = sim as unknown as { tryAttack(u: { team: string; timerMs: number }, foe: unknown, dt: number): void };
  const original = internals.tryAttack.bind(sim);
  const swings: number[] = [];
  let now = 0;
  internals.tryAttack = (u, foe, dt) => {
    const before = u.timerMs;
    original(u, foe, dt);
    if (u.team === "enemy" && u.timerMs > before) swings.push(now);
  };
  for (let i = 0; i < 1600; i++) {
    now += 50;
    sim.step(50);
  }
  return {
    gaps: swings.slice(1).map((t, i) => (t - swings[i]) / 1000),
    speciesSec: (units[0].speciesCycleMs ?? 0) / 1000,
  };
}

describe("Endless pirate captain tempo", () => {
  for (const body of ["Headless", "Regular", "Small"]) {
    it(`swings at his invasion's mirrored tempo against a ${body}`, () => {
      const { gaps, speciesSec } = captainSwingGaps(body);
      const intended = pirateBossSlamIntervalSec(speciesSec);
      expect(gaps.length).toBeGreaterThan(4);
      // Every gap is the mirror (to a tick), or longer: a fresh zombie still walking in.
      // Never shorter, which is what his own clock and the old Endless slam both produced.
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(intended - 0.051);
      expect(gaps.filter((g) => Math.abs(g - intended) <= 0.051).length).toBeGreaterThan(gaps.length / 2);
    });
  }
});
