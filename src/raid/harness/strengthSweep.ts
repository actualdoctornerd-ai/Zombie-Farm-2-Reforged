// Every invasion against every level of army, at every level of play.
//
// The cohort sweep asks "what happens to THIS kind of player". This one drops that frame
// entirely and asks the flatter question: given a party of a certain strength, what does
// each fight in the game do to it? One axis, one number per cell, and the whole ladder
// visible at once — which is what you need to see whether difficulty actually climbs.
//
// TWO THINGS ARE HELD STILL so that strength is genuinely the only thing varying.
//
//  1. Every roster is built at ONE player level (`SWEEP_PLAYER_LEVEL`). The level ramp
//     (`modifyStatWithLevelScale`) is still climbing below 25, so a roster built at 12 and
//     one built at 50 are not on the same scale even before their species differ — and a
//     Strength Ladder number that mixes the two is not comparable to itself. Strength here
//     comes from what the army IS (species, size, mutations, veterancy), not from where
//     the ramp happened to stop.
//  2. Every fight is scaled to ITS OWN recommended level, not to the roster's. A raid is a
//     fixed obstacle in this table; the player is the variable. Scaling the wave to a weak
//     roster's level would soften the fight in step with the army and flatten the very
//     gradient the table exists to show.
//  3. Every roster is the SAME SIZE (`SWEEP_SIZE`). The Strength Ladder sums over the
//     army, so it folds size into the same number as quality: at mixed sizes an
//     eight-zombie roster of Omegas and a twenty-zombie roster of Blues land in the same
//     band and behave nothing alike, and a column stops meaning one thing. Pinned at 16,
//     a band is a statement about how good the zombies are.
//  4. Every roster meets the PARTY FLOOR (composition.ts) — two healers and a body. This
//     was added after the first run of this table showed win rate FALLING with strength on
//     three rungs, which turned out to be the sampler rather than the fights: the Strength
//     Ladder is √(str·dex·con), the healer and the tank are the two classes with the worst
//     dex, and so the top band was selecting for armies with neither. The band that scored
//     highest averaged one Headless and one Garden out of sixteen, and pooled across the
//     top three bands the WINNERS scored lower than the losers. A column is only a
//     difficulty reading if every army in it is an army somebody would field.
//
// ELITE ROWS ARE ORDERED BY WHEN THEY BECOME REACHABLE (roster.eliteReachableAt): the
// raid's unlock plus that raid's delay — 10 early, 5 at the Ninjas, 4 at the Robots, 3
// from the Aliens on — and never below level 20, which is where Brain Tickets unlock and
// so where any elite fight becomes possible at all. A Brain Ticket fight is not content
// you meet when the raid opens, so filing it there would put it above things it is
// harder than.
import raidsJson from "../../../public/assets/raids/raids.json";
import { ERAS } from "./archetypes";
import { COHORTS, sampleCohort } from "./cohorts";
import { flights, type Target } from "./measure";
import { PILOT_LADDER, type PilotProfile } from "./pilots";
import { seededRandom } from "../RaidCatalog";
import { buildRoster, eliteReachableAt, type RosterSpec } from "./roster";
import {
  EFFECTIVE_EDGES, effectiveBin, effectiveBinLabels, effectiveStrength,
} from "./effectiveLadder";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

export const STRENGTH_SHARDS = 6;
/** The level every roster in the sweep is built at, so the stat ramp is not a hidden
 *  second axis. 50 is the cap — full ramp, nothing still climbing. */
export const SWEEP_PLAYER_LEVEL = 50;
/** Every roster in the sweep fields this many zombies — see the header. */
export const SWEEP_SIZE = 16;
/** Rosters per strength bin. */
export const PER_BIN = 25;
/** Wave seeds per roster. */
export const SWEEP_SEEDS = 2;
/** Candidate rosters generated before binning. The top bins are rare — a mono-class army
 *  of the strongest species — so the pool has to be much larger than what it keeps. */
const CANDIDATES_PER_POOL = 250;

/** Bin edges on the Strength Ladder √(Σ str·dex·con), re-derived for the pinned
 *  sixteen-zombie roster. Measured over everything the cohort samplers produce at that
 *  size: min 13, p5 61, p25 150, p50 270, p75 378, p95 492, p99 641, max ~1010. The last
 *  bin is open-ended because under 4% of plausible armies reach it — a roster of nothing
 *  but top specials — and splitting it further would leave columns of three or four. */
export const STRENGTH_EDGES: readonly number[] = [0, 60, 110, 170, 240, 320, 410, 520, Infinity];

/** The grid's columns. Effective strength since 2026-09-23 — see effectiveLadder.ts. The
 *  Strength Ladder is still computed and still reported per cell, as the comparison. */
export const binLabels = (): string[] => effectiveBinLabels();

export interface SweepRoster {
  spec: RosterSpec;
  /** Strength Ladder √(Σ str·dex·con) — kept for the comparison column only. */
  strength: number;
  /** Effective strength, fitted from play. THE axis the columns are built on. */
  effective: number;
  bin: number;
}

/** A pool of rosters spanning the strength range, evenly filled per bin.
 *
 *  Drawn from every cohort at every era — which is what produces the spread: an early
 *  unmutated line of Greens and a capped endgame roster of Omegas are two ends of the
 *  same sampler. Rebuilt at one player level (see the header) before its strength is
 *  taken, so the number that bins it is the number the table reports. */
export function strengthPool(perBin = PER_BIN): SweepRoster[] {
  // EVERY candidate first, then a spread from each bin — not greedy fill. Filling as the
  // samples arrive lets whichever era is iterated first monopolise a band: the late era
  // (sizes 16 and 18) took every top-bin slot before the endgame era (size 20) was asked,
  // so the strongest column contained no full-size army at all. A seeded shuffle inside
  // each bin keeps the columns representative of everything that can reach them.
  const candidates: SweepRoster[] = [];
  for (const era of ERAS) {
    for (const cohort of COHORTS) {
      for (const sample of sampleCohort(cohort, era, CANDIDATES_PER_POOL, "cohort", SWEEP_SIZE)) {
        const spec: RosterSpec = { ...sample.spec, playerLevel: SWEEP_PLAYER_LEVEL };
        const roster = buildRoster(spec);
        const effective = effectiveStrength(roster.units);
        candidates.push({
          spec, effective, strength: roster.strength, bin: effectiveBin(effective),
        });
      }
    }
  }

  const rand = seededRandom("strength-pool");
  const out: SweepRoster[] = [];
  EFFECTIVE_EDGES.slice(0, -1).forEach((_, bin) => {
    const inBin = candidates.filter((c) => c.bin === bin);
    for (let i = inBin.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [inBin[i], inBin[j]] = [inBin[j], inBin[i]];
    }
    out.push(...inBin.slice(0, perBin));
  });
  return out;
}

export interface SweepFight {
  target: Target;
  label: string;
  /** Where this fight sits in the game — the value the rows are sorted by. For an elite
   *  row it is the raid's unlock plus that raid's elite-prize delay. */
  unlock: number;
  /** The level the WAVE is scaled to. The raid's own recommended level, always. */
  fightLevel: number;
}

export function sweepFights(): SweepFight[] {
  const out: SweepFight[] = [];
  const ordinary = raids.filter((r) => r.playable && r.id <= 11);
  for (const raid of ordinary) {
    const unlock = (raid as { unlockLevel?: number }).unlockLevel ?? 0;
    out.push({
      target: { raidId: raid.id },
      label: `${raid.id} ${raid.name}`,
      unlock,
      fightLevel: raid.recommendedLevel,
    });
    out.push({
      target: { raidId: raid.id, elite: true },
      label: `${raid.id} ${raid.name} ★`,
      unlock: eliteReachableAt(raid.id),
      fightLevel: raid.recommendedLevel,
    });
  }
  for (const id of [12, 13, 14, 15]) {
    const raid = raids.find((r) => r.id === id);
    if (!raid) continue;
    const unlock = (raid as { unlockLevel?: number }).unlockLevel ?? 0;
    for (const tier of [1, 5, 10]) {
      out.push({
        target: { raidId: id, tier },
        label: `${id} ${raid.name} t${tier}`,
        // Rungs share an unlock; the fraction only keeps them in ladder order.
        unlock: unlock + tier / 100,
        fightLevel: raid.recommendedLevel,
      });
    }
  }
  return out.sort((a, b) => a.unlock - b.unlock || a.label.localeCompare(b.label));
}

export interface SweepCell {
  bin: number;
  /** Mean EFFECTIVE strength of the rosters flown in this bin — the column's own axis. */
  meanEffective: number;
  /** Mean Strength Ladder score of the same rosters, so the two metrics can be compared
   *  column by column. Expect it NOT to climb with the columns: that is the point. */
  meanStrength: number;
  rosters: number;
  flights: number;
  winRate: number;
  meanLosses: number;
  losslessRate: number;
  /** Fraction of flights that hit the four-minute cap with both sides standing.
   *
   *  Recorded separately from the win rate because the benchmark cannot tell the two
   *  apart without it, and was scoring them the same. A fight that runs the clock out
   *  settles as a loss, but it is not a HARD fight — it is an unfinishable one, and it
   *  costs nothing: `7 Summer Break` at idle measured 84% wins with 0.00 mean casualties,
   *  which is only possible if every one of the sixteen failures was a stall. Tuning
   *  damage at a stall does nothing except make the fights that DO finish worse. */
  timeoutRate: number;
  /** Fraction that hit the cap with a LIVING army that could not advance (the all-Garden
   *  deadlock). A subset of `timeoutRate`, reported apart because it is a rules bug
   *  rather than a tuning number. */
  deadlockRate: number;
}

export interface SweepRow {
  label: string;
  unlock: number;
  pilot: string;
  cells: SweepCell[];
}

export function runStrengthShard(shard: number, shards: number): SweepRow[] {
  const pool = strengthPool();
  const out: SweepRow[] = [];

  for (const fight of sweepFights().filter((_, i) => i % shards === shard)) {
    for (const profile of PILOT_LADDER as readonly PilotProfile[]) {
      const cells: SweepCell[] = EFFECTIVE_EDGES.slice(0, -1).map((_, bin) => ({
        bin, meanEffective: 0, meanStrength: 0, rosters: 0, flights: 0,
        winRate: 0, meanLosses: 0, losslessRate: 0, timeoutRate: 0, deadlockRate: 0,
      }));
      const tally = cells.map(() => ({
        wins: 0, clean: 0, losses: 0, n: 0, strength: 0, effective: 0, rosters: 0,
        timeouts: 0, deadlocks: 0,
      }));

      for (const roster of pool) {
        const { flights: fs } = flights(
          fight.target,
          // The spec keeps its OWN level (SWEEP_PLAYER_LEVEL) so the army flown is the
          // army the column header measured; the fight's level rides the separate
          // `waveLevel` argument and scales the enemy only. Folding it into the spec, as
          // this did, silently rebuilt the roster partway up the stat ramp on every raid
          // recommended below 25.
          { id: "sweep", era: "sweep", lineup: "sweep", spec: roster.spec },
          profile,
          SWEEP_SEEDS,
          fight.fightLevel
        );
        const t = tally[roster.bin];
        t.rosters++;
        t.strength += roster.strength;
        t.effective += roster.effective;
        for (const f of fs) {
          t.n++;
          if (f.win) t.wins++;
          if (f.win && f.losses === 0) t.clean++;
          if (f.timedOut) t.timeouts++;
          if (f.deadlocked) t.deadlocks++;
          t.losses += f.losses;
        }
      }

      cells.forEach((cell, i) => {
        const t = tally[i];
        cell.rosters = t.rosters;
        cell.flights = t.n;
        cell.meanStrength = t.rosters ? t.strength / t.rosters : 0;
        cell.meanEffective = t.rosters ? t.effective / t.rosters : 0;
        cell.winRate = t.n ? t.wins / t.n : 0;
        cell.losslessRate = t.n ? t.clean / t.n : 0;
        cell.meanLosses = t.n ? t.losses / t.n : 0;
        cell.timeoutRate = t.n ? t.timeouts / t.n : 0;
        cell.deadlockRate = t.n ? t.deadlocks / t.n : 0;
      });
      out.push({ label: fight.label, unlock: fight.unlock, pilot: profile.id, cells });
    }
  }
  return out;
}
