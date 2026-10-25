// The Count's slam (raid 16): the pirate captain's charge, priced off his own hit.
import { describe, expect, it } from "vitest";
import { composeFight } from "./composeFight";
import { COUNT_KEY, COUNT_SLAM_MULT, COUNT_SLAM_RECOVERY_MS, COUNT_SLAM_WINDUP_MS, countHitDamage } from "./countSlam";
import { raidProfile } from "./dualInvasion";
import { fightStage, resolveStageWave, seededRandom } from "./RaidCatalog";
import { HALLOWEEN_RAID_ID } from "./zombieDrops";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const raids = raidsJson as RaidDef[];
const assets = {
  enemyStats: enemyStatsJson as Record<string, EnemyStat>,
  raidAttacks: attacksJson as Record<string, AttackDef>,
};

function unitsOf(raidId: number, night = 1): CombatUnit[] {
  const raid = raids.find((r) => r.id === raidId)!;
  const stage = resolveStageWave(fightStage(raid, raid.recommendedLevel)!, seededRandom("slam"));
  return composeFight(assets, raid, stage, {
    playerLevel: raid.recommendedLevel, tier: 1, elite: raidProfile(raid.id, { night }), priorWins: 5,
    waveSeed: "slam", hazards: false, nightStage: night,
  }).enemyUnits;
}

describe("the Count's slam", () => {
  it("is a 3 s wind-up for eight of his hits on the front zombie, on the Count alone", () => {
    const units = unitsOf(HALLOWEEN_RAID_ID);
    const count = units.find((u) => u.sourceKey === COUNT_KEY)!;
    expect(count.charge).toBeTruthy();
    expect(count.charge!.windupMs).toBe(COUNT_SLAM_WINDUP_MS);
    expect(COUNT_SLAM_WINDUP_MS).toBe(3_000);
    expect(count.charge!.recoveryMs).toBe(COUNT_SLAM_RECOVERY_MS);
    expect(count.charge!.damage).toBe(Math.round(COUNT_SLAM_MULT * countHitDamage(count)));
    expect(COUNT_SLAM_MULT).toBe(8);
    expect(count.charge!.target).toBe("front-deployed");
    expect(units.filter((u) => u.charge)).toHaveLength(1);
  });

  it("scales with the night chain, because it is priced off his scaled hit", () => {
    const n1 = unitsOf(HALLOWEEN_RAID_ID, 1).find((u) => u.sourceKey === COUNT_KEY)!;
    const n3 = unitsOf(HALLOWEEN_RAID_ID, 3).find((u) => u.sourceKey === COUNT_KEY)!;
    expect(n3.charge!.damage / n1.charge!.damage).toBeCloseTo(3, 1);
  });

  it("leaves every other invasion alone", () => {
    for (const raid of raids) {
      if (raid.id === HALLOWEEN_RAID_ID || raid.id === 13 || !fightStage(raid, raid.recommendedLevel)) continue;
      expect(unitsOf(raid.id).some((u) => u.charge), `raid ${raid.id}`).toBe(false);
    }
  });
});
