// Turning flights into a difficulty reading.
//
// The thing this replaces is `weakestWinningArmy` — one number per raid, produced by
// bisecting a stat multiplier on the assumption that winning is monotone in army power.
// It is not: a bulkier, slower army can clear the wave and never reach the boss (the
// settle budget), and on raid 13 the enemy's throw rate tracks the army's own dex, so
// adding dex makes the fight worse. A bisection over a non-monotone predicate returns an
// arbitrary point and says nothing about having done so.
//
// So a reading here is a VECTOR over a grid, not a scalar over a line, and every
// component answers a different question that the loss-less target actually cares about:
//
//   losslessRate  — the headline. Over the era's rosters, how often does the fight end
//                   with everyone coming home? A raid where this is 0 at `expert` is
//                   over-tuned for its slot; one where it is 1 at `idle` has mechanics
//                   nobody needs to engage with.
//   winRate       — the old question, kept, because losing is still losing.
//   timeoutRate   — separated from losing ON PURPOSE. A fight that runs out the
//                   four-minute clock settles as a loss but means something completely
//                   different: it is unfinishable rather than hard, and on the live
//                   service it is the `truncated_transcript` that pays nothing and
//                   explains nothing.
//   cheapestClear — the honest successor to p*: the lowest Strength-Ladder roster on the
//                   grid that wins, and separately the lowest that wins loss-lessly.
//                   Searched over composition and order instead of bisected over one
//                   multiplier.
//   breadth       — how many distinct LINEUPS manage a loss-less clear. A raid only one
//                   build beats is a checklist, not a difficulty.
//   secs          — the median winning clear, against the settle cap.
import { buildFight } from "../buildFight";
import { flyFight, type Flight } from "./pilot";
import { makePilot, type PilotProfile } from "./pilots";
import { harnessFight, type HarnessFightOptions } from "./raidFight";
import { buildRoster } from "./roster";
import type { Archetype } from "./archetypes";

/** One fight to measure: a raid, and the rung / ticket it is fought at. */
export type Target = Pick<HarnessFightOptions, "raidId" | "tier" | "elite" | "hazards"> & {
  label?: string;
};

export interface Cell {
  target: Target;
  pilot: string;
  /** Fraction of flights that ended in a win. */
  winRate: number;
  /** Fraction that ended in a win with ZERO casualties. */
  losslessRate: number;
  /** Fraction that hit the four-minute cap with both sides standing. */
  timeoutRate: number;
  /** Fraction that hit the cap with a LIVING army that could not advance — see
   *  Flight.deadlocked. Non-zero is a rules bug, not a tuning number. */
  deadlockRate: number;
  /** Mean casualties across all flights. */
  meanLosses: number;
  /** Median seconds over the WINNING flights (null if none won). */
  medianWinSecs: number | null;
  /** Lowest-strength archetype that won at all / won loss-lessly, with its strength. */
  cheapestWin: { id: string; strength: number } | null;
  cheapestLossless: { id: string; strength: number } | null;
  /** Distinct lineups with at least one loss-less clear. */
  breadth: number;
  flights: number;
  /** Non-zero means a pilot wanted to tap more than a client could transmit. */
  budgetDropped: number;
}

export interface MeasureOptions {
  seeds?: number;
  /** Cap on simulated ticks. Left at the replay cap by default. */
  maxTicks?: number;
}

/** Fly one archetype against one target with one pilot, over N wave seeds.
 *
 *  `waveLevel` separates the two levels a fight has, which were previously one field and
 *  therefore could not disagree:
 *
 *    · the ROSTER's level (`archetype.spec.playerLevel`) runs the stat ramp and decides
 *      how strong the army is;
 *    · the WAVE's level scales the enemy.
 *
 *  Normally they are the same — an account fights at its own level — and that stays the
 *  default. The strength sweep is the exception and needs them apart: it builds every
 *  roster at one level so the Strength Ladder is comparable down the column, then puts
 *  that fixed army against each raid at the raid's OWN recommended level. Passing the
 *  fight's level in the spec, as it used to, rebuilt the army at the fight's level too —
 *  so a raid with a recommended level under 25 was flown by an army partway up the stat
 *  ramp while the table's column header reported its level-50 strength. */
export function flights(
  target: Target,
  archetype: Archetype,
  profile: PilotProfile,
  seeds: number,
  waveLevel?: number
): { flights: Flight[]; strength: number } {
  const out: Flight[] = [];
  let strength = 0;
  for (let s = 0; s < seeds; s++) {
    // The roster is rebuilt per flight because the sim MUTATES its units — a shared
    // array would carry one fight's damage into the next.
    const roster = buildRoster(archetype.spec);
    strength = roster.strength;
    const seed = `${archetype.id}:${target.raidId}:${target.tier ?? 0}:${s}`;
    const { spec } = harnessFight({
      raidId: target.raidId,
      tier: target.tier,
      elite: target.elite,
      hazards: target.hazards ?? true,
      playerLevel: waveLevel ?? archetype.spec.playerLevel,
      playerUnits: roster.units,
      waveSeed: seed,
    });
    out.push(flyFight(buildFight(spec), makePilot(profile), { seed }));
  }
  return { flights: out, strength };
}

export function measure(
  target: Target,
  grid: readonly Archetype[],
  profile: PilotProfile,
  opts: MeasureOptions = {}
): Cell {
  const seeds = opts.seeds ?? 5;
  let wins = 0;
  let lossless = 0;
  let timeouts = 0;
  let deadlocks = 0;
  let losses = 0;
  let total = 0;
  let budgetDropped = 0;
  const winSecs: number[] = [];
  const losslessLineups = new Set<string>();
  let cheapestWin: Cell["cheapestWin"] = null;
  let cheapestLossless: Cell["cheapestLossless"] = null;

  for (const archetype of grid) {
    const { flights: fs, strength } = flights(target, archetype, profile, seeds);
    // An archetype "clears" a target when it wins on EVERY seed, not on its luckiest
    // one. A roster that beats the Robots' random boss once in five is not a roster
    // that beats the Robots, and `cheapestClear` is a claim about what suffices.
    const allWon = fs.every((f) => f.win);
    const allClean = fs.every((f) => f.win && f.losses === 0);
    if (allWon && (!cheapestWin || strength < cheapestWin.strength)) {
      cheapestWin = { id: archetype.id, strength };
    }
    if (allClean) {
      losslessLineups.add(archetype.lineup);
      if (!cheapestLossless || strength < cheapestLossless.strength) {
        cheapestLossless = { id: archetype.id, strength };
      }
    }
    for (const f of fs) {
      total++;
      if (f.win) { wins++; winSecs.push(f.secs); }
      if (f.win && f.losses === 0) lossless++;
      if (f.timedOut) timeouts++;
      if (f.deadlocked) deadlocks++;
      losses += f.losses;
      budgetDropped += f.budgetDropped;
    }
  }

  winSecs.sort((a, b) => a - b);
  return {
    target,
    pilot: profile.id,
    winRate: total ? wins / total : 0,
    losslessRate: total ? lossless / total : 0,
    timeoutRate: total ? timeouts / total : 0,
    deadlockRate: total ? deadlocks / total : 0,
    meanLosses: total ? losses / total : 0,
    medianWinSecs: winSecs.length ? winSecs[Math.floor(winSecs.length / 2)] : null,
    cheapestWin,
    cheapestLossless,
    breadth: losslessLineups.size,
    flights: total,
    budgetDropped,
  };
}
