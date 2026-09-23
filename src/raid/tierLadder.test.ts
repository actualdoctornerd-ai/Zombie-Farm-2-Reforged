// The dual invasions' tier ladder, and the budget it has to live inside.
//
// `tierProfile` is a placeholder and its numbers will move, so this does not pin them. It
// pins the two things that must hold whatever they become: that the ladder actually climbs,
// and that the top of it can still SETTLE.
//
// The settle one is not theoretical. An earlier cut of this table ramped `con` to 8.5 and
// measured beautifully on every roster that kills quickly — then hung a 20-strong wall
// roster at exactly 240 s in the Raid Lab, with the whole 181,900-point wave cleared and the
// boss still untouched on its perch. That fight LOSES on the clock — cleanly, and the player
// is told so (see timeLimit.test.ts) — but losing a fight you were winning the whole way, to
// an arithmetic you cannot go faster than, is a broken rung rather than a hard one.
import { describe, expect, it } from "vitest";
import { buildEnemyUnits } from "./CombatEngine";
import {
  DUAL_INVASION_IDS, DUAL_SETTLE_REFERENCE_DPS, MAX_TIER, MIN_TIER, raidProfile, signFor,
  STACK_MAX_HEIGHT,
} from "./dualInvasion";
import {
  circusStacksFor, farmerSquadFor, pirateCaptainFor, robotEscortFor,
} from "./fightConfig";
import { fightStage, resolveStageWave, seededRandom } from "./RaidCatalog";
import { RAID_MAX_TICKS, RAID_TICK_MS } from "./replay";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const raids = raidsJson as RaidDef[];
const assets = {
  enemyStats: enemyStatsJson as Record<string, EnemyStat>,
  raidAttacks: attacksJson as Record<string, AttackDef>,
};
const duals = raids.filter((r) => (DUAL_INVASION_IDS as readonly number[]).includes(r.id));

/** What the measured base table says each wave weighs at 1.0x, mirrored here so the test
 *  is asserting against a written-down number rather than against the code under test. */
const DUAL_BASE_HP_FOR_TEST: Record<number, { wave: number; boss: number }> = {
  12: { wave: 21_400, boss: 4_500 },
  13: { wave: 58_500, boss: 25_000 },
  14: { wave: 82_600, boss: 1_500 }, // Circus wave + three towers at full height
  15: { wave: 91_000, boss: 25_000 }, // alien wave + the one robot heavy
};

/** Everything the fight fields at this rung, built exactly as both sides build it.
 *  Pass `null` for the profile to see the raid's own wave, unscaled. */
function fightAt(raid: RaidDef, tier: number, override?: null): CombatUnit[] {
  const profile = override === null ? null : raidProfile(raid.id, { tier });
  const stage = resolveStageWave(
    fightStage(raid, raid.recommendedLevel)!, seededRandom(`ladder:${raid.id}`)
  );
  return [
    ...buildEnemyUnits(stage, assets.enemyStats, assets.raidAttacks, {
      raidId: raid.id, playerLevel: raid.recommendedLevel, elite: profile,
    }),
    ...farmerSquadFor(assets, raid, signFor(raid.id, tier, "ladder"), profile, raid.recommendedLevel),
    ...pirateCaptainFor(assets, raid, tier, profile, raid.recommendedLevel),
    // Counted AT FULL HEIGHT: a tower left alone climbs to STACK_MAX_HEIGHT, and it is
    // the grown weight the settle budget has to carry. Counting the unit as built would
    // understate raid 14 by two thirds of every tower.
    ...circusStacksFor(assets, raid, tier, profile, raid.recommendedLevel)
      .map((u) => ({ ...u, maxHp: u.maxHp * STACK_MAX_HEIGHT })),
    ...robotEscortFor(assets, raid, profile, raid.recommendedLevel),
  ];
}

const totalHp = (units: CombatUnit[]) => units.reduce((sum, u) => sum + u.maxHp, 0);
const totalStr = (units: CombatUnit[]) => units.reduce((sum, u) => sum + u.str, 0);

describe("the tier ladder", () => {
  it("lands every invasion on the SAME curve, so a rung means one thing", () => {
    // The four borrow four stages that are nowhere near each other in bulk, so the rung
    // names a hit-point target and solves `con` backwards from each raid's own wave. If
    // that ever stops holding, tier 7 means something different in each fight.
    for (const raid of duals) {
      for (const [rung, wave, boss] of [[MIN_TIER, 70_000, 12_000], [MAX_TIER, 110_000, 20_000]] as const) {
        const units = fightAt(raid, rung);
        const bossHp = units.filter((u) => u.isBoss).reduce((sum, u) => sum + u.maxHp, 0);
        expect(totalHp(units) - bossHp, `raid ${raid.id} t${rung} wave`)
          .toBeCloseTo(wave, -3.7); // within ~2,500 points
        expect(bossHp, `raid ${raid.id} t${rung} boss`).toBeCloseTo(boss, -3.4);
      }
    }
  });

  it("knows what each wave really weighs, and notices when one is re-composed", () => {
    // DUAL_BASE_HP is measured, and the whole ladder divides by it — so a wave that is
    // re-composed (a weight changed, a unit swapped, a guest squad resized) silently moves
    // every rung of that invasion until this fails. Raid 15 is the cautionary one: it was
    // 409,000 points of cloned alien swarm — four times the settle budget — until Stage 4
    // re-composed the wave rather than letting the ladder divide the problem away.
    for (const raid of duals) {
      const base = fightAt(raid, MIN_TIER, null);
      const bossHp = base.filter((u) => u.isBoss).reduce((sum, u) => sum + u.maxHp, 0);
      const declared = DUAL_BASE_HP_FOR_TEST[raid.id];
      expect(totalHp(base) - bossHp, `raid ${raid.id} base wave`)
        .toBeCloseTo(declared.wave, -3.4); // within ~1,250 points
      expect(bossHp, `raid ${raid.id} base boss`).toBeCloseTo(declared.boss, -2.4);
    }
  });

  it("climbs on every rung, in both bulk and lethality", () => {
    for (const raid of duals) {
      for (let rung = MIN_TIER; rung < MAX_TIER; rung++) {
        const here = fightAt(raid, rung);
        const next = fightAt(raid, rung + 1);
        expect(totalHp(next), `raid ${raid.id}: t${rung + 1} hp`).toBeGreaterThan(totalHp(here));
        expect(totalStr(next), `raid ${raid.id}: t${rung + 1} damage`).toBeGreaterThan(totalStr(here));
      }
    }
  });

  it("leaves the slowest winning roster room to finish inside the settle cap", () => {
    // The binding case is the WEAKEST roster that still wins — bodies and sustain with
    // almost nothing that ends anything. DUAL_SETTLE_REFERENCE_DPS is its measured
    // wall-clock rate, so it already carries the walk-in, the drip, the boss's descent and
    // the objection benching part of the army off and on; 0.85 is the margin on top.
    //
    // Calibration: raid 12 at t10 is 128,940 points, which this predicts at 188 s. The real
    // run in the Raid Lab took 188 s. Keep them honest — if a change here makes the
    // prediction and the measurement disagree, the model is wrong and not just the numbers.
    const capMs = RAID_MAX_TICKS * RAID_TICK_MS;
    for (const raid of duals) {
      const secondsToClear = totalHp(fightAt(raid, MAX_TIER)) / DUAL_SETTLE_REFERENCE_DPS;
      expect(secondsToClear * 1000, `raid ${raid.id} at t${MAX_TIER} must still settle`)
        .toBeLessThan(capMs * 0.85);
    }
  });

  it("is the same ladder on both sides, from the rung alone", () => {
    // `raidProfile` is what the client, the Worker and the Raid Lab all call. If it ever
    // read anything but the raid id and the rung, the two simulations would build different
    // fights from the same pinned config and diverge on tick 0.
    for (const raid of duals) {
      for (const rung of [MIN_TIER, 4, MAX_TIER]) {
        expect(raidProfile(raid.id, { tier: rung })).toEqual(raidProfile(raid.id, { tier: rung }));
        // …and a Brain Ticket cannot reach them, so `elite` must change nothing here.
        expect(raidProfile(raid.id, { tier: rung, elite: true }))
          .toEqual(raidProfile(raid.id, { tier: rung }));
      }
    }
  });
});
