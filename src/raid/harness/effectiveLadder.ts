// THE EFFECTIVE LADDER — what the grid bins on now, in place of √(str·dex·con).
//
// The Strength Ladder is a guess. Against armies it was never fitted to it orders results
// at Spearman +0.23; the fitted per-species weights in effectiveWeights.ts order the same
// armies at +0.78. This module turns those weights into a score for any roster.
//
// WHAT THE LADDER ACTUALLY GETS WRONG, stated carefully because an earlier reading of this
// overstated it. Measured over the WHOLE catalog the ladder is positively correlated with
// winning — it does know a Silver beats a Green, which is most of the variance when Greens
// are in the sample. Measured over the TOP TIER ALONE, where every army is Silver or
// Special and the only question left is composition, it comes out at −0.30: actively
// anti-correlated, because it rates a tank and a healer far below a glass cannon and at
// that tier composition is the whole game. Both numbers are real. The second is the one
// that matters for endgame balance, and it is the one that made the grid unreadable.
//
// TWO PIECES, with different standing:
//
//  1. THE WEIGHTS, for the 80 species a level-50 account can obtain — which is all of them.
//     Measured over 2,500 random armies. Validated out of sample. Use with confidence.
//  2. THE EXTRAPOLATION, now only a fallback for a species nothing could earn (and for any
//     future body type). Class mean plus one pooled within-class slope, which beat the
//     alternatives when it was carrying the whole low-tier range:
//
//        per-class ladder multiplier  0.15 Spearman
//        class constant .............0.45
//        class mean + slope (this) . 0.51
//
//     The multiplier model lost because it re-imports the ladder's within-class spread,
//     which the fit says is mostly noise.
import zombiesJson from "../../../public/assets/zombies.json";
import {
  CLASS_EFFECTIVE, CLASS_LADDER, EFFECTIVE_WEIGHT, WITHIN_CLASS_SLOPE,
} from "./effectiveWeights";
import { buildExplicit } from "./roster";
import { EFFECTIVE_ACCOUNT } from "./effectiveStrength";
import type { ZombieDef } from "../../assets";
import type { CombatUnit } from "../types";

const zombieDefs = zombiesJson as unknown as ZombieDef[];
const BY_KEY = new Map(zombieDefs.map((z) => [z.key, z]));

/** The old metric, kept because the extrapolation is expressed relative to it and because
 *  every table still prints both for comparison. */
export function ladderOf(z: Pick<ZombieDef, "str" | "dex" | "con">): number {
  return Math.sqrt(Math.max(0.1, z.str) * Math.max(0.1, z.dex) * Math.max(0.1, z.con));
}

/** Fallback for a class the fit never saw at all — the mean of the class means. Only
 *  reachable if a new body type is added, in which case "about average" is the honest
 *  answer until it has been sampled. */
const GRAND_MEAN =
  Object.values(CLASS_EFFECTIVE).reduce((a, b) => a + b, 0) /
  Math.max(1, Object.keys(CLASS_EFFECTIVE).length);

export interface EffectiveValue {
  key: string;
  effective: number;
  /** True when this came from the sample, false when it was extrapolated. Every table
   *  shows this, because the two are not the same kind of number. */
  measured: boolean;
}

/** What one slot of this species is worth. */
export function effectiveOf(z: Pick<ZombieDef, "key" | "group" | "str" | "dex" | "con">): EffectiveValue {
  const measured = EFFECTIVE_WEIGHT[z.key];
  if (measured !== undefined) return { key: z.key, effective: measured, measured: true };

  const group = z.group ?? "Regular";
  const base = CLASS_EFFECTIVE[group] ?? GRAND_MEAN;
  const anchor = CLASS_LADDER[group] ?? 0;
  // Class mean, adjusted by how far this species sits from the sampled ones of its class
  // on the old metric. Floored at zero: a species weak enough to go negative contributes
  // nothing, it does not contribute harm.
  return {
    key: z.key,
    effective: Math.max(0, base + WITHIN_CLASS_SLOPE * (ladderOf(z) - anchor)),
    measured: false,
  };
}

export function effectiveOfKey(key: string): EffectiveValue {
  const def = BY_KEY.get(key);
  if (!def) return { key, effective: 0, measured: false };
  return effectiveOf(def);
}

/** How much of its species' potential a BUILT unit is carrying, 0..1.
 *
 *  The weights were fitted at ONE account — level 50, Master, best-in-slot mutations, the
 *  farmer's life head — so a weight means "what this species is worth WHEN FULLY BUILT". A
 *  grid whose left half is unmutated, unranked rosters needs that to move or every cohort
 *  scores the same.
 *
 *  THE REFERENCE IS THE SPECIES BUILT AT THAT ACCOUNT, not its raw catalog line. That
 *  distinction is the whole correctness of this function and getting it wrong inverts the
 *  metric: a mutation is a FLAT add (+5 str / +4 dex / +9 con), so measured against raw
 *  stats it multiplies a Green's score by three and an Omega's by half again, and a
 *  fully-mutated Green army came out ahead of a fully-mutated endgame one. Against a
 *  like-for-like reference the ratio is 1.0 at the top and falls away as the Pot, the
 *  veterancy ladder and the level ramp come off, which is the one axis the fit could not
 *  see and the game certainly has. */
const REFERENCE = new Map<string, number>();

function referenceLadder(key: string): number {
  const hit = REFERENCE.get(key);
  if (hit !== undefined) return hit;
  let value = 0;
  try {
    const u = buildExplicit([key], EFFECTIVE_ACCOUNT).units[0];
    value = u ? ladderOf({ str: u.str, dex: u.dex, con: u.con }) : 0;
  } catch {
    value = 0;
  }
  REFERENCE.set(key, value);
  return value;
}

export function quality(unit: Pick<CombatUnit, "sourceKey" | "str" | "dex" | "con">): number {
  const ref = referenceLadder(unit.sourceKey);
  if (ref <= 0) return 1;
  const built = ladderOf({ str: unit.str, dex: unit.dex, con: unit.con });
  // Capped at 1: a unit cannot be more built than the reference build. Team auras can push
  // it a little past on paper, and that is a property of the ARMY rather than of this
  // zombie, so it does not belong in a per-species term.
  return Math.max(0.05, Math.min(1, built / ref));
}

/** THE SCORE the grid bins on: every unit's species value, scaled by how built it is. */
export function effectiveStrength(units: readonly CombatUnit[]): number {
  let sum = 0;
  // `sourceKey` is the species; `id` is the individual. Reading the wrong one silently
  // scores every army at zero, which is how this was first written.
  for (const u of units) sum += effectiveOfKey(u.sourceKey).effective * quality(u);
  return sum;
}

/** Bin edges for the re-binned grid.
 *
 *  Chosen from the measured spread of everything the cohort samplers produce at sixteen
 *  bodies, the same way STRENGTH_EDGES was: min 29, p25 222, p50 388, p75 519, max 901.
 *  Re-derived after mutation tiers were gated by level (roster.mutationTierAt), which
 *  moved every early-era roster sharply down — the early cohorts had been wearing
 *  Silver-class heads on Green bodies.
 *  Eight columns like the old grid, so the two tables line up.
 *
 *  THE RANGE IS NARROWER THAN THE OLD ONE and that is the finding, not a defect. On this
 *  axis the cohorts come out in the order they should — early 618-663, mid 726-745, late
 *  and endgame 818-836, with every unmutated cohort far below its era — where the Strength
 *  Ladder had the top band anti-correlated with winning. Most of the separation is the
 *  account (`quality`) rather than the species, because the fit never flew a Green and the
 *  extrapolation is gentle; see the header. */
export const EFFECTIVE_EDGES: readonly number[] = [
  0, 120, 220, 310, 390, 460, 520, 580, Infinity,
];

export const effectiveBinLabels = (): string[] =>
  EFFECTIVE_EDGES.slice(0, -1).map((lo, i) => {
    const hi = EFFECTIVE_EDGES[i + 1];
    return hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
  });

export function effectiveBin(score: number): number {
  const bin = EFFECTIVE_EDGES.findIndex(
    (lo, i) => score >= lo && score < EFFECTIVE_EDGES[i + 1]
  );
  return bin < 0 ? EFFECTIVE_EDGES.length - 2 : bin;
}
