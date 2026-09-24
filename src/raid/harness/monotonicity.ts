// DOES A BETTER ARMY ACTUALLY DO BETTER? — per fight, measured directly.
//
// The grid answers this in binned form and binning hides things: twenty-five rosters
// averaged into one cell can move the wrong way for reasons that have nothing to do with
// the fight (an unlucky seed, one outlier, a column whose population differs in some
// respect nobody looked at). A cell-to-cell comparison is also only seven observations per
// row, which is not enough to tell a real inversion from noise.
//
// So this drops the bins. Every roster in the pool is flown against every fight, and the
// question is asked as a RANK CORRELATION between how good the army is and how well it
// did. One number per fight, computed over two hundred armies instead of eight cells.
//
// TWO METRICS ARE SCORED SIDE BY SIDE — effective strength and the old Strength Ladder —
// because "is this fight monotone" and "is this axis any good" are the same measurement
// from different ends, and running them together means neither can be blamed for the
// other's failures.
//
// WHERE NON-MONOTONICITY IS EXPECTED, and is the game rather than the metric:
//
//   · raid 13 taxes the army's own DEXTERITY — the perched ninja throws faster the more
//     total dex is deployed (dualInvasion.dexTaxedInterval), so some stronger armies make
//     the fight harder for themselves, on purpose.
//   · raid 14 COPIES the player's own zombies behind the line, at full hit points and
//     keeping passives at the top rung. A better army is copied into a better enemy.
//
// Everything else should climb. A fight outside those two that does not is either a metric
// failure or a balance bug, and this is the report that tells them apart.
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildRoster } from "./roster";
import { effectiveStrength } from "./effectiveLadder";
import { pearson, spearman } from "./regression";
import { scoreFlight } from "./effectiveStrength";
import { strengthPool, sweepFights, SWEEP_SIZE } from "./strengthSweep";
import { CHARGE_RAID_ID, COPY_RAID_ID } from "../dualInvasion";

export const MONOTONIC_SHARDS = 6;
/** Wave seeds per roster. Two, averaged, so one unlucky draw does not read as the army. */
export const MONOTONIC_SEEDS = 2;

/** Fights whose own mechanic reads the player's army and turns it against them. A dip here
 *  is a design decision, not a defect — see the header. */
export function expectedNonMonotone(raidId: number): boolean {
  return raidId === CHARGE_RAID_ID || raidId === COPY_RAID_ID;
}

export interface MonotonicRow {
  label: string;
  raidId: number;
  unlock: number;
  rosters: number;
  /** Rank correlation between army quality and how well it did. THE number. */
  effectiveSpearman: number;
  effectivePearson: number;
  /** The same, for the metric the grid used to bin on. */
  ladderSpearman: number;
  /** Win rate by bin, in column order — where a dip happens, if one does. */
  binWinRate: (number | null)[];
  /** True when this fight's mechanic is designed to punish a stronger army. */
  expectedDip: boolean;
}

/** Fraction of the enemy's hit points the army got through. Copies and converted zombies
 *  are excluded: both are built FROM the player's units, so counting them would charge a
 *  strong army for the strong enemies it created. */
function enemyProgress(sim: ReturnType<typeof buildFight>): number {
  let total = 0, left = 0;
  for (const u of sim.units) {
    if (u.team !== "enemy" || u.isCopy || u.isTurned) continue;
    total += u.maxHp;
    left += Math.max(0, u.hp);
  }
  return total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
}

export function runMonotonicShard(shard: number, shards: number): MonotonicRow[] {
  const pool = strengthPool();
  const out: MonotonicRow[] = [];

  for (const fight of sweepFights().filter((_, i) => i % shards === shard)) {
    const eff: number[] = [];
    const lad: number[] = [];
    const score: number[] = [];
    const bins = new Map<number, { wins: number; n: number }>();

    for (const roster of pool) {
      let sum = 0;
      let wins = 0;
      let effective = 0;
      for (let s = 0; s < MONOTONIC_SEEDS; s++) {
        // Rebuilt per flight: the sim mutates its units.
        const built = buildRoster(roster.spec);
        effective = effectiveStrength(built.units);
        const seed = `mono:${fight.target.raidId}:${fight.target.tier ?? 0}:${roster.effective.toFixed(0)}:${s}`;
        const { spec } = harnessFight({
          raidId: fight.target.raidId,
          tier: fight.target.tier,
          elite: fight.target.elite,
          hazards: true,
          playerLevel: fight.fightLevel,
          playerUnits: built.units,
          waveSeed: seed,
        });
        const sim = buildFight(spec);
        const f = flyFight(sim, makePilot(EXPERT), { seed });
        // The graded score, not the win bit: two armies that both lost are not equally bad
        // if one of them nearly finished, and a rank correlation over a binary outcome
        // throws most of the sample's information away.
        sum += scoreFlight(f.win, f.survivors, SWEEP_SIZE, enemyProgress(sim));
        if (f.win) wins++;
      }
      eff.push(effective);
      lad.push(roster.strength);
      score.push(sum / MONOTONIC_SEEDS);
      const b = bins.get(roster.bin) ?? { wins: 0, n: 0 };
      b.wins += wins;
      b.n += MONOTONIC_SEEDS;
      bins.set(roster.bin, b);
    }

    out.push({
      label: fight.label,
      raidId: fight.target.raidId,
      unlock: fight.unlock,
      rosters: pool.length,
      effectiveSpearman: spearman(eff, score),
      effectivePearson: pearson(eff, score),
      ladderSpearman: spearman(lad, score),
      binWinRate: Array.from({ length: 8 }, (_, i) => {
        const b = bins.get(i);
        return b && b.n ? b.wins / b.n : null;
      }),
      expectedDip: expectedNonMonotone(fight.target.raidId),
    });
  }
  return out;
}
