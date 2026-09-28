// The dual invasions' tier ladder, and the budget it has to live inside.
//
// `tierProfile` is placeholder numbers, so this does not pin them. It pins the SHAPE agreed
// in docs/POST_45_PROGRESSION.md Part 2B — one change per tier, the stat steps on t2/t4/t6/t8
// only, hit points flat — and the one thing that must hold whatever the numbers become:
// that the fight can still SETTLE inside the four-minute clock.
import { describe, expect, it } from "vitest";
import { composeFight } from "./composeFight";
import {
  dualBossHp, dualBulk, DUAL_DAMAGE_STEP, DUAL_INVASION_IDS, DUAL_SETTLE_REFERENCE_DPS, DUAL_SPEED_STEP,
  DUAL_TIME_LIMIT_MS, DUAL_WAVE_HP, MAX_TIER, MIN_TIER, raidProfile, STAT_TIERS, statSteps, tierProfile,
} from "./dualInvasion";
import { fightStage, resolveStageWave, seededRandom } from "./RaidCatalog";
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
  12: { wave: 18_500, boss: 4_500 },
  13: { wave: 46_500, boss: 25_000 },
  14: { wave: 77_200, boss: 1_500 },
  15: { wave: 60_000, boss: 25_000 }, // the alien wave; robots are summoned, not scheduled
};

/** Everything the fight fields at this rung, built exactly as both sides build it. Pass
 *  `null` for the profile to see the raid's own wave, unscaled. Counted at FULL HEIGHT for
 *  anything that grows, which is the weight the settle budget has to carry. */
function fightAt(raid: RaidDef, tier: number, override?: null): CombatUnit[] {
  const profile = override === null ? null : raidProfile(raid.id, { tier });
  const stage = resolveStageWave(
    fightStage(raid, raid.recommendedLevel)!, seededRandom(`ladder:${raid.id}`)
  );
  return composeFight(assets, raid, stage, {
    playerLevel: raid.recommendedLevel, tier, elite: profile, priorWins: 5,
    waveSeed: "ladder", hazards: false,
  }).enemyUnits.map((u) => (u.stack ? { ...u, maxHp: u.maxHp * u.stack.maxHeight } : u));
}

const totalHp = (units: CombatUnit[]) => units.reduce((sum, u) => sum + u.maxHp, 0);
/** A unit a MECHANIC brings on (the farmer mob, the captain, the towers) rather than one of
 *  the wave's own bodies. The flat hit-point target is the wave's; these ride on top of it. */
const isArrival = (u: CombatUnit) =>
  u.deployAtMs !== undefined || u.deployAtWaveFrac !== undefined || !!u.stack;
const waveOnly = (units: CombatUnit[]) => units.filter((u) => !isArrival(u));

describe("the tier ladder", () => {
  it("puts the stat steps on t2, t4, t6 and t8, alternating damage and speed", () => {
    expect(STAT_TIERS).toEqual({ 2: "damage", 4: "speed", 6: "damage", 8: "speed" });
    expect(statSteps(1)).toEqual({ damage: 0, speed: 0 });
    expect(statSteps(2)).toEqual({ damage: 1, speed: 0 });
    expect(statSteps(4)).toEqual({ damage: 1, speed: 1 });
    expect(statSteps(8)).toEqual({ damage: 2, speed: 2 });
    expect(statSteps(10)).toEqual({ damage: 2, speed: 2 });
  });

  it("moves the profile on a stat rung and ONLY on a stat rung", () => {
    for (const raid of duals) {
      for (let rung = MIN_TIER + 1; rung <= MAX_TIER; rung++) {
        const prev = tierProfile(raid.id, rung - 1);
        const here = tierProfile(raid.id, rung);
        const kind = STAT_TIERS[rung];
        if (kind === "damage") {
          expect(here.str / prev.str, `raid ${raid.id} t${rung}`).toBeCloseTo(DUAL_DAMAGE_STEP, 6);
          expect(here.dex, `raid ${raid.id} t${rung}`).toBe(prev.dex);
        } else if (kind === "speed") {
          expect(here.dex / prev.dex, `raid ${raid.id} t${rung}`).toBeCloseTo(DUAL_SPEED_STEP, 6);
          expect(here.str, `raid ${raid.id} t${rung}`).toBe(prev.str);
        } else {
          expect(here, `raid ${raid.id} t${rung} is a mechanic rung`).toEqual(prev);
        }
      }
    }
  });

  it("lands every invasion on the SAME flat hit points, so a rung means one thing", () => {
    for (const raid of duals) {
      for (const rung of [MIN_TIER, 5, MAX_TIER]) {
        const units = waveOnly(fightAt(raid, rung));
        const bossHp = units.filter((u) => u.isBoss).reduce((sum, u) => sum + u.maxHp, 0);
        expect(totalHp(units) - bossHp, `raid ${raid.id} t${rung} wave`)
          .toBeCloseTo(DUAL_WAVE_HP * dualBulk(raid.id, rung), -3.7); // within ~2,500 points
        expect(bossHp, `raid ${raid.id} t${rung} boss`)
          .toBeCloseTo(dualBossHp(raid.id) * dualBulk(raid.id, rung), -3.4);
      }
    }
  });

  it("knows what each wave really weighs, and notices when one is re-composed", () => {
    // DUAL_BASE_HP is measured, and the whole ladder divides by it — so a wave that is
    // re-composed silently moves every rung of that invasion until this fails.
    for (const raid of duals) {
      const base = waveOnly(fightAt(raid, MIN_TIER, null));
      const bossHp = base.filter((u) => u.isBoss).reduce((sum, u) => sum + u.maxHp, 0);
      const declared = DUAL_BASE_HP_FOR_TEST[raid.id];
      expect(totalHp(base) - bossHp, `raid ${raid.id} base wave`)
        .toBeCloseTo(declared.wave, -3.4); // within ~1,250 points
      expect(bossHp, `raid ${raid.id} base boss`).toBeCloseTo(declared.boss, -2.4);
    }
  });

  it("leaves the slowest winning roster room to finish inside the settle cap", () => {
    // The binding case is the WEAKEST roster that still wins. DUAL_SETTLE_REFERENCE_DPS is
    // its measured wall-clock rate; 0.85 is the margin on top.
    const capMs = DUAL_TIME_LIMIT_MS;
    for (const raid of duals) {
      const secondsToClear = totalHp(fightAt(raid, MAX_TIER)) / DUAL_SETTLE_REFERENCE_DPS;
      expect(secondsToClear * 1000, `raid ${raid.id} at t${MAX_TIER} must still settle`)
        .toBeLessThan(capMs * 0.85);
    }
  });

  it("is the same ladder on both sides, from the rung alone", () => {
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
