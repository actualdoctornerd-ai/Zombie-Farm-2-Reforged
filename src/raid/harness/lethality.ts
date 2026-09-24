// HOW HARD SHOULD THESE HIT? — calibrating enemy damage against the benchmark.
//
// The benchmark (tools/benchmark_table.mjs) says which fights are too easy and by how much,
// in casualties. This turns that into a NUMBER: for each fight, the damage multiplier that
// lands it inside its band.
//
// WHY DAMAGE AND NOT HIT POINTS. Three measurements, all already in the harness, point the
// same way. The best builds finish in 40-85 seconds against a four-minute clock, so there
// is no time pressure to lean on; `eliteInvasion.EliteProfile.con` carries its own warning
// that past a point more bulk stops making a fight harder and starts making it
// unfinishable; and the dual invasions are scaled by an HP TARGET whose top is set by the
// settle budget, so bulk is the one axis already spoken for. Casualties are what the owner
// asked to tune on, and damage is the dial that moves them.
//
// WHAT A MULTIPLIER MEANS depends on what the fight already has:
//
//  · an ELITE scales its `ELITE_PROFILES` entry — `str`, `throwDamage`, `specialDamage`.
//    A recommendation of 1.5 on raid 5 means str 2.53 -> 3.80.
//  · a DUAL INVASION scales `tierProfile`'s lethality ramp the same way.
//  · a STORY RAID HAS NO PROFILE AT ALL (`eliteProfile` returns null for non-elite), so a
//    recommendation there is not a number to paste anywhere yet — it is the SIZE of the
//    change, and implementing it means either editing the authored wave or giving
//    non-elite raids a profile of their own. Flagged in the output rather than hidden.
//
// THE SEARCH IS A SWEEP, NOT A SOLVE. Casualties are not smooth in damage — a threshold
// where one more hit kills a zombie moves the count a whole unit — so this flies a ladder
// of multipliers and reports the measured curve alongside the pick. A reader who disagrees
// with the pick can read the curve and choose a different one.
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { CASUAL, EXPERT, makePilot, type PilotProfile } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildRoster } from "./roster";
import { strengthPool, sweepFights, type SweepRoster } from "./strengthSweep";
import { allMarks } from "./unlockArmy";
import { isDualInvasion } from "../dualInvasion";

export const LETHALITY_SHARDS = 6;
/** Wave seeds per roster. */
export const LETHALITY_SEEDS = 2;

/** The ladder of multipliers flown. Starts at 1 so the current state is always the first
 *  row of the curve and a recommendation can be read as a delta from it. */
export const LETHALITY_STEPS: readonly number[] = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The fights the benchmark scored TOO EASY at ruleset 62, by label. Kept as an explicit
 *  list rather than re-deriving it here: the benchmark owns that judgement, this module
 *  owns the arithmetic, and a hand-off between them that can silently disagree is worse
 *  than one that has to be updated on purpose. */
export const TOO_EASY: readonly string[] = [
  "2 Zombies vs Lawyers ★",
  "4 Zombies vs Ninjas",
  "4 Zombies vs Ninjas ★",
  "5 Zombies vs Robots",
  "5 Zombies vs Robots ★",
  "6 Zombies vs Aliens",
  "6 Zombies vs Aliens ★",
  "9 Zombies vs Video Games",
  "9 Zombies vs Video Games ★",
  "12 Zombies vs Lawyers & Farmers t1",
  "12 Zombies vs Lawyers & Farmers t5",
  "15 Zombies vs Aliens & Robots t1",
  "15 Zombies vs Aliens & Robots t5",
];

/** The benchmark's casualty band for a fight, by the level it becomes reachable. Mirrors
 *  the BANDS table in tools/benchmark_table.mjs — the two must agree, and the table there
 *  is the one a designer edits. */
export function targetBite(level: number): readonly [number, number] {
  if (level <= 11) return [0, 0.5];
  if (level <= 25) return [0.5, 3];
  if (level <= 39) return [1.5, 5];
  if (level <= 45) return [3, 7];
  return [5, 10];
}

export interface LethalityPoint {
  lethality: number;
  /** Casual play at the purple mark — the BITE probe the band is stated on. */
  biteLosses: number;
  biteWin: number;
  /** Casual at the blue mark, watched so a fix does not wreck the maxed account. */
  blueLosses: number;
  blueWin: number;
  /** Expert at the purple mark — the ceiling that must stay clearable. */
  expertLosses: number;
  expertWin: number;
}

export interface LethalityRow {
  label: string;
  unlock: number;
  /** Where the recommendation can actually be applied. */
  knob: "elite profile" | "tier profile" | "NO PROFILE (authored wave)";
  target: readonly [number, number];
  curve: LethalityPoint[];
  /** Lowest multiplier whose BITE lands in band without pushing expert-at-purple past its
   *  own ceiling. Null when no step on the ladder does. */
  pick: number | null;
}

function fly(
  fight: ReturnType<typeof sweepFights>[number],
  rosters: readonly SweepRoster[],
  profile: PilotProfile,
  lethality: number
): { losses: number; win: number } {
  let losses = 0, wins = 0, n = 0;
  for (const roster of rosters) {
    for (let s = 0; s < LETHALITY_SEEDS; s++) {
      const built = buildRoster(roster.spec);
      const seed = `leth:${fight.label}:${lethality}:${profile.id}:${roster.effective.toFixed(0)}:${s}`;
      const { spec } = harnessFight({
        raidId: fight.target.raidId,
        tier: fight.target.tier,
        elite: fight.target.elite,
        hazards: true,
        playerLevel: fight.fightLevel,
        playerUnits: built.units,
        waveSeed: seed,
        lethality,
      });
      const f = flyFight(buildFight(spec), makePilot(profile), { seed });
      losses += f.losses;
      if (f.win) wins++;
      n++;
    }
  }
  return { losses: n ? losses / n : 0, win: n ? wins / n : 0 };
}

export function runLethalityShard(shard: number, shards: number): LethalityRow[] {
  const pool = strengthPool();
  const fights = sweepFights().filter((f) => TOO_EASY.includes(f.label));
  const marks = new Map(allMarks(fights).map((m) => [m.label, m]));
  const out: LethalityRow[] = [];

  for (const fight of fights.filter((_, i) => i % shards === shard)) {
    const m = marks.get(fight.label);
    if (!m) continue;
    const purple = pool.filter((r) => r.bin === m.moderate.bin);
    const blue = pool.filter((r) => r.bin === m.ceiling.bin);
    const level = Math.floor(fight.unlock);
    const target = targetBite(level);

    const curve: LethalityPoint[] = [];
    for (const lethality of LETHALITY_STEPS) {
      const bite = fly(fight, purple, CASUAL, lethality);
      const blu = fly(fight, blue, CASUAL, lethality);
      const exp = fly(fight, purple, EXPERT, lethality);
      curve.push({
        lethality,
        biteLosses: bite.losses, biteWin: bite.win,
        blueLosses: blu.losses, blueWin: blu.win,
        expertLosses: exp.losses, expertWin: exp.win,
      });
    }

    // The CHEAPEST step that lands the bite in band and leaves a well-played ordinary
    // account still able to clear it. Cheapest rather than best-fit because every point of
    // added damage is a change to a shipped fight, and the smallest change that works is
    // the one to make.
    const expertCeiling = level <= 45 ? 1 : 2;
    const pick = curve.find((p) =>
      p.biteLosses >= target[0] && p.biteLosses <= target[1] &&
      p.expertLosses <= expertCeiling && p.expertWin >= 0.9)?.lethality ?? null;

    out.push({
      label: fight.label,
      unlock: fight.unlock,
      knob: isDualInvasion(fight.target.raidId) ? "tier profile"
        : fight.target.elite ? "elite profile"
        : "NO PROFILE (authored wave)",
      target,
      curve,
      pick,
    });
  }
  return out;
}
