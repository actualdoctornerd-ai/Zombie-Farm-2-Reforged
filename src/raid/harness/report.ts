// The difficulty report: every fight in the game, against the roster its own audience
// could bring, at four levels of play.
//
// This is the SLOW half of the plan and it is deliberately not part of `vitest run`. The
// fast half is `difficulty.test.ts`, which asserts relations on a tiny grid in seconds;
// this one runs thousands of fights and produces a table to read, diff and argue with.
// Keeping them apart is the point: a report you tune numbers against stops being a
// measurement, and the standing instruction on this project is not to hand-tune to
// satisfy a harness.
//
// Run it with `npm run test:difficulty`, which shards it across physical cores via
// vitest's file parallelism (measured: ~48 fights/s at six shards on a 6C/12T laptop;
// twelve shards is SLOWER because hyperthreads contend). Each shard writes its own JSON
// and `tools/difficulty_table.mjs` merges them into the table.
import raidsJson from "../../../public/assets/raids/raids.json";
import { eraForLevel, ERA_BY_ID, gridFor, type Archetype } from "./archetypes";
import { measure, type Cell, type Target } from "./measure";
import { PILOT_LADDER } from "./pilots";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

/** How the report is split across processes. Six, not twelve: measured on a 6C/12T
 *  laptop, six shards run ~48 fights/s wall clock and twelve run ~30, because the
 *  hyperthread pairs contend. Keep it in step with `vitest.difficulty.config.ts`. */
export const SHARDS = 6;

/** Wave seeds per cell. The Robots draw a random boss and the dual invasions draw their
 *  placard rotation, so one seed is one evening; five is enough to see a 20% split and
 *  cheap enough to run the whole table in a couple of minutes. */
export const REPORT_SEEDS = 5;

export interface ReportTarget {
  target: Target;
  /** Which era's grid measures it — the audience the fight is FOR. */
  era: string;
  label: string;
  /** For ordering the table by where the fight sits in the game. */
  recommendedLevel: number;
}

/** Every fight worth a row.
 *
 *  The ELITE rows are measured at `late` or above rather than at the raid's own era,
 *  because a Brain Ticket comes off an Epic Boss and an early account does not have one
 *  to spend. Fighting the tutorial's elite wave with a level-12 grid would be measuring
 *  something nobody can do.
 *
 *  The dual invasions are sampled at rungs 1 / 5 / 10 rather than all ten: the ladder is
 *  built to be smooth (`dualInvasion.tierProfile` solves `con` backwards from a shared
 *  hit-point target), so three points say whether it is, and ten points cost three times
 *  as much to say the same thing. */
export function reportTargets(): ReportTarget[] {
  const out: ReportTarget[] = [];
  for (const raid of raids.filter((r) => r.playable && r.id <= 11)) {
    const era = eraForLevel(raid.recommendedLevel);
    out.push({
      target: { raidId: raid.id },
      era: era.id,
      label: `${raid.id} ${raid.name}`,
      recommendedLevel: raid.recommendedLevel,
    });
  }
  for (const raid of raids.filter((r) => r.playable && r.id <= 11)) {
    const own = eraForLevel(raid.recommendedLevel);
    const era = own.id === "early" || own.id === "mid" ? "late" : own.id;
    out.push({
      target: { raidId: raid.id, elite: true },
      era,
      label: `${raid.id} ${raid.name} ★`,
      recommendedLevel: raid.recommendedLevel + 0.5,
    });
  }
  for (const id of [12, 13, 14, 15]) {
    const raid = raids.find((r) => r.id === id);
    if (!raid) continue;
    for (const tier of [1, 5, 10]) {
      out.push({
        target: { raidId: id, tier },
        era: "endgame",
        label: `${id} ${raid.name} t${tier}`,
        recommendedLevel: raid.recommendedLevel + tier / 100,
      });
    }
  }
  return out.sort((a, b) => a.recommendedLevel - b.recommendedLevel);
}

export interface Row {
  label: string;
  era: string;
  recommendedLevel: number;
  cells: Cell[];
}

/** Measure one slice of the target list. `shard`/`shards` splits it across processes. */
export function runShard(shard: number, shards: number, seeds = 5): Row[] {
  const gridCache = new Map<string, Archetype[]>();
  const grid = (era: string) => {
    let g = gridCache.get(era);
    if (!g) { g = gridFor(ERA_BY_ID[era]); gridCache.set(era, g); }
    return g;
  };
  return reportTargets()
    .filter((_, i) => i % shards === shard)
    .map((rt) => ({
      label: rt.label,
      era: rt.era,
      recommendedLevel: rt.recommendedLevel,
      cells: PILOT_LADDER.map((profile) => measure(rt.target, grid(rt.era), profile, { seeds })),
    }));
}
