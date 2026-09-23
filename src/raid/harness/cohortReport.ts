// The cohort sweep: every fight against four kinds of army a real account has.
//
// The era report (report.ts) answers the ceiling question — CAN the best roster of this
// point in the game clear this fight. This one answers the distribution question: what
// happens to the players who are not carrying that roster. Same fights, same pilots, but
// instead of a dozen named archetypes it flies hundreds of sampled armies per cohort and
// reports the spread.
//
// WHY THE SPREAD IS THE POINT. A single roster gives a single answer and no sense of how
// close it was. Two hundred gives a win rate, a loss-less rate, and — more useful than
// either — the fraction of plausible armies for which this fight is a wall. A rung where
// `powerful` sails through and `unmutated` cannot win is not a hard fight, it is a
// mutation gate, and the two want completely different fixes.
//
// Run with `npm run test:cohorts`.
import raidsJson from "../../../public/assets/raids/raids.json";
import { eraForLevel, ERA_BY_ID, type Era } from "./archetypes";
import { COHORTS, sampleCohort, type Cohort, type CohortRoster } from "./cohorts";
import { flights } from "./measure";
import { COMPETENT, EXPERT, type PilotProfile } from "./pilots";
import { buildRoster } from "./roster";
import type { Target } from "./measure";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

export const COHORT_SHARDS = 6;
/** Armies sampled per cohort per era. Capped by what the catalog can actually produce —
 *  an early account has only a handful of distinct level-appropriate rosters, and that
 *  is a fact about the game rather than a sampling failure. */
export const COHORT_SAMPLE = 200;
/** Wave seeds per army. Two: the sample size is doing the averaging here, not the seeds. */
export const COHORT_SEEDS = 2;

export const COHORT_PILOTS: readonly PilotProfile[] = [COMPETENT, EXPERT];

export interface CohortFight {
  target: Target;
  era: string;
  label: string;
  order: number;
}

/** The fights the sweep covers: a spread across the whole game rather than every rung,
 *  because the question here is about ARMIES and a fourth sample of the same ladder adds
 *  nothing. One early, mid and late cluster, the hardest ordinary invasion and its Brain
 *  Ticket, and one rung from each dual invasion. */
export function cohortFights(): CohortFight[] {
  const mk = (raidId: number, tier?: number, elite?: boolean): CohortFight => {
    const raid = raids.find((r) => r.id === raidId)!;
    const era = tier ? "endgame" : eraForLevel(raid.recommendedLevel).id;
    return {
      target: { raidId, tier, elite },
      era,
      label: `${raidId} ${raid.name}${tier ? ` t${tier}` : ""}${elite ? " ★" : ""}`,
      order: raid.recommendedLevel + (tier ?? 0) / 100 + (elite ? 0.5 : 0),
    };
  };
  return [
    mk(1), mk(7), mk(8), mk(11),
    mk(2), mk(3), mk(4),
    mk(5), mk(6), mk(9), mk(9, undefined, true),
    mk(12, 5), mk(13, 5), mk(14, 1), mk(15, 5),
  ].sort((a, b) => a.order - b.order);
}

export interface CohortCell {
  cohort: string;
  pilot: string;
  /** How many distinct armies were flown (the catalog may not offer `COHORT_SAMPLE`). */
  rosters: number;
  flights: number;
  winRate: number;
  losslessRate: number;
  deadlockRate: number;
  meanLosses: number;
  medianWinSecs: number | null;
  /** Fraction of ARMIES that won on every seed / won clean on every seed. The rate above
   *  counts flights; this counts armies, which is the number a player is inside. */
  armiesClearing: number;
  armiesClean: number;
  /** Strength Ladder span of the sample, for reading the cohorts against each other. */
  strength: { min: number; median: number; max: number };
}

export interface CohortRow {
  label: string;
  era: string;
  order: number;
  cells: CohortCell[];
}

/** Sampled once per (cohort, era) and shared by every fight in that era, so a difference
 *  between two rows is a difference between the FIGHTS and not between their armies. */
function poolFor(cohort: Cohort, era: Era): CohortRoster[] {
  return sampleCohort(cohort, era, COHORT_SAMPLE);
}

export function runCohortShard(shard: number, shards: number): CohortRow[] {
  const pools = new Map<string, CohortRoster[]>();
  const pool = (cohort: Cohort, eraId: string) => {
    const key = `${cohort.id}/${eraId}`;
    let p = pools.get(key);
    if (!p) { p = poolFor(cohort, ERA_BY_ID[eraId]); pools.set(key, p); }
    return p;
  };

  return cohortFights()
    .filter((_, i) => i % shards === shard)
    .map((fight) => {
      const cells: CohortCell[] = [];
      for (const cohort of COHORTS) {
        const rosters = pool(cohort, fight.era);
        const strengths = rosters.map((r) => buildRoster(r.spec).strength).sort((a, b) => a - b);
        for (const profile of COHORT_PILOTS) {
          let wins = 0, clean = 0, deadlocks = 0, losses = 0, total = 0;
          let armiesClearing = 0, armiesClean = 0;
          const winSecs: number[] = [];
          for (const roster of rosters) {
            const { flights: fs } = flights(
              fight.target,
              { id: roster.id, era: roster.era, lineup: `${roster.mix}/${roster.order}`, spec: roster.spec },
              profile,
              COHORT_SEEDS
            );
            if (fs.every((f) => f.win)) armiesClearing++;
            if (fs.every((f) => f.win && f.losses === 0)) armiesClean++;
            for (const f of fs) {
              total++;
              if (f.win) { wins++; winSecs.push(f.secs); }
              if (f.win && f.losses === 0) clean++;
              if (f.deadlocked) deadlocks++;
              losses += f.losses;
            }
          }
          winSecs.sort((a, b) => a - b);
          cells.push({
            cohort: cohort.id,
            pilot: profile.id,
            rosters: rosters.length,
            flights: total,
            winRate: total ? wins / total : 0,
            losslessRate: total ? clean / total : 0,
            deadlockRate: total ? deadlocks / total : 0,
            meanLosses: total ? losses / total : 0,
            medianWinSecs: winSecs.length ? winSecs[Math.floor(winSecs.length / 2)] : null,
            armiesClearing: rosters.length ? armiesClearing / rosters.length : 0,
            armiesClean: rosters.length ? armiesClean / rosters.length : 0,
            strength: {
              min: strengths[0] ?? 0,
              median: strengths[strengths.length >> 1] ?? 0,
              max: strengths[strengths.length - 1] ?? 0,
            },
          });
        }
      }
      return { label: fight.label, era: fight.era, order: fight.order, cells };
    });
}
