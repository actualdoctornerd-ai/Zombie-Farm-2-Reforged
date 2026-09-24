// WHAT IS A ZOMBIE ACTUALLY WORTH? — an empirical replacement for the Strength Ladder.
//
// The Strength Ladder is √(Σ str·dex·con), which is √(DPS × HP) with the constants dropped.
// It is a reasonable first guess and it is measurably wrong in one specific way: dexterity
// carries the same exponent as constitution, so it rates a tank and a healer far below a
// glass cannon. Measured consequences, both already in the harness: the ladder's top band
// selected for armies with no support at all, and within any band the WINNERS scored lower
// than the losers. A ladder that anti-correlates with winning inside a band is not a
// ladder.
//
// THE FIX IS NOT A BETTER FORMULA, it is to stop guessing. Fly a large sample of RANDOM
// armies, score how each one did, and regress the score on which zombies were in it. The
// coefficient on a species is then what one slot of it is worth, in units of outcome —
// derived from the sim rather than from an intuition about what stats mean.
//
// WHY THE PARTIES ARE UNCONSTRAINED. No party floor here, unlike everywhere else in the
// harness. The floor exists to stop the SAMPLER producing armies nobody would field; but
// the whole question here is how much a healer is worth, and that can only be answered by
// a sample that contains armies with no healer. Constraining the sample would hide exactly
// the effect being measured.
//
// WHAT THIS CANNOT SEE, stated plainly because the number will be used as a ladder:
//
//  · IT IS LINEAR. One weight per species, summed. A fourth healer is genuinely worth less
//    than the first, and a linear fit charges them the same — so the fitted weight is an
//    AVERAGE marginal value over the compositions sampled, not a universal constant.
//  · IT IS PER-BATTERY. The weights are fitted against the fights in `BATTERY` at the
//    difficulties listed. A species that only shines on a mechanic none of those fights
//    has will be undervalued, and the honest fix is to widen the battery.
//  · IT IGNORES ORDER. The genome that the search layer cares about most does not appear
//    in the design matrix at all. Deploy order is worth roughly a doubling of clean-clear
//    rate, so a good deal of the residual variance is order and should be expected to stay
//    unexplained.
//
// The validation at the end is therefore the load-bearing part: fitted weights and the
// Strength Ladder are both scored on HELD-OUT armies, and the fit is only worth adopting
// if it predicts better there.
import { seededRandom } from "../RaidCatalog";
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildExplicit, CATALOG, obtainableAt, type AccountSpec } from "./roster";
import { pearson, ridgeSolve, spearman } from "./regression";
import raidsJson from "../../../public/assets/raids/raids.json";
import type { RaidDef } from "../types";
import type { ZombieDef } from "../../assets";

const raids = raidsJson as RaidDef[];

export const EFFECTIVE_SHARDS = 6;
/** Random armies drawn in total. Has to comfortably exceed the number of species (~30
 *  after the shortlist) for the regression to be identified, with room to spare for the
 *  noise a three-seed fight carries. */
export const PARTIES = 2_500;
export const PARTY_SIZE = 16;
/** Ridge term. Small: the sampler is uniform over species so collinearity is mild, and the
 *  term is here to guarantee invertibility rather than to shrink anything meaningfully. */
export const RIDGE = 1e-3;

export const EFFECTIVE_ACCOUNT: AccountSpec = {
  playerLevel: 50, invasions: 5, mutation: "best", abilityTiers: 4, farmerLifeMult: 1.1,
};

/** The fights each army is scored against.
 *
 *  Chosen for HEADROOM rather than for coverage: a fight every random army wins and one
 *  no random army survives both carry zero information about which zombies are good, and
 *  averaging them in only dilutes the fights that discriminate. These six sit where a
 *  random sixteen is genuinely uncertain. */
export const BATTERY: readonly { raidId: number; tier?: number; elite?: boolean }[] = [
  // An easy fight, added when the pool widened to the whole catalog: a sample full of
  // Green armies needs somewhere they can still tell each other apart, or every weak party
  // scores the same zero and the bottom of the range carries no information.
  { raidId: 2 },
  { raidId: 3, elite: true },
  { raidId: 6, elite: true },
  { raidId: 12, tier: 5 },
  { raidId: 13, tier: 1 },
  { raidId: 14, tier: 1 },
  { raidId: 15, tier: 5 },
];

/** Every species a party may contain.
 *
 *  THE WHOLE OBTAINABLE CATALOG, not `appropriateAt`'s shortlist. The first run of this fit
 *  sampled only the top three species of each class — 18 of 80 — and every one of them was
 *  a Silver or a Special. That produced weights that were right about the species they
 *  covered and blind to everything else, and the blindness showed up twice downstream: the
 *  grid's fourth column (74% extrapolated species, 25 of 34 rows falling entering it) and
 *  the "ordinary account" mark on every row freezing solid from level 26, because after
 *  that point the only thing that changes for a player IS which species they field.
 *
 *  So the sampler now draws from everything a level-50 account could have earned, Greens
 *  included. Most of those parties are bad, which is the point: a metric has to be able to
 *  tell a bad army from a good one, and it can only learn that from bad armies. */
export function speciesPool(level = 50): ZombieDef[] {
  return CATALOG.filter((z) => {
    const at = obtainableAt(z);
    return at !== null && at <= level;
  });
}

/** One army and how it did. */
export interface Observation {
  /** Species counts, indexed against `speciesPool()` order. */
  counts: number[];
  /** Mean score across the battery, 0..1. See `scoreFlight`. */
  score: number;
  /** The Strength Ladder's opinion of the same army, for the comparison at the end. */
  ladder: number;
}

/** One flight, as a number that moves across the WHOLE range.
 *
 *  A win/lose bit throws away most of what a fight tells you: two armies that both lost
 *  are not equally bad if one of them nearly finished. So losses are scored on how much of
 *  the enemy they got through and wins on how many zombies came home, with the two ranges
 *  stacked so that every win outranks every loss.
 *
 *    loss  →  0.00 .. 0.50   (half the fraction of enemy hit points destroyed)
 *    win   →  0.50 .. 1.00   (half, plus half the fraction of the army still standing)
 *
 *  Monotone in army quality at both ends, which is all a regression target needs. */
export function scoreFlight(
  win: boolean, survivors: number, size: number, enemyProgress: number
): number {
  return win ? 0.5 + 0.5 * (survivors / Math.max(1, size)) : 0.5 * enemyProgress;
}

/** Fraction of the enemy's hit points the army got through.
 *
 *  Copies and converted zombies are excluded: both are made FROM the player's own units,
 *  so counting them would charge a strong army for the strong enemies it created and read
 *  as the army being worse. */
function enemyProgress(sim: ReturnType<typeof buildFight>): number {
  let total = 0, left = 0;
  for (const u of sim.units) {
    if (u.team !== "enemy" || u.isCopy || u.isTurned) continue;
    total += u.maxHp;
    left += Math.max(0, u.hp);
  }
  return total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
}

/** A uniformly random army: every slot an independent draw from the whole pool.
 *
 *  Uniform over SPECIES rather than over classes, so the design matrix is as close to
 *  balanced as the sampler can make it and no species is systematically rarer than another
 *  (which would show up as a noisier weight, not a smaller one, but still). */
export function randomParty(rand: () => number, pool: readonly ZombieDef[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < PARTY_SIZE; i++) {
    out.push(pool[Math.floor(rand() * pool.length) % pool.length].key);
  }
  return out;
}

export function runEffectiveShard(shard: number, shards: number): Observation[] {
  const pool = speciesPool(EFFECTIVE_ACCOUNT.playerLevel ?? 50);
  const index = new Map(pool.map((z, i) => [z.key, i]));
  const out: Observation[] = [];

  for (let p = shard; p < PARTIES; p += shards) {
    // Seeded per PARTY index rather than per shard, so the sample is the same set of
    // armies however the work is divided — a shard count change must not change the fit.
    const rand = seededRandom(`effective:${p}`);
    const party = randomParty(rand, pool);
    const counts = new Array<number>(pool.length).fill(0);
    for (const key of party) counts[index.get(key)!]++;

    let sum = 0;
    let ladder = 0;
    for (const fight of BATTERY) {
      const raid = raids.find((r) => r.id === fight.raidId)!;
      const roster = buildExplicit(party, EFFECTIVE_ACCOUNT);
      ladder = roster.strength;
      const seed = `effective:${p}:${fight.raidId}:${fight.tier ?? 0}`;
      const { spec } = harnessFight({
        raidId: fight.raidId,
        tier: fight.tier,
        elite: fight.elite,
        hazards: true,
        playerLevel: raid.recommendedLevel,
        playerUnits: roster.units,
        waveSeed: seed,
      });
      const sim = buildFight(spec);
      const f = flyFight(sim, makePilot(EXPERT), { seed });
      sum += scoreFlight(f.win, f.survivors, PARTY_SIZE, enemyProgress(sim));
    }
    out.push({ counts, score: sum / BATTERY.length, ladder });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE FIT
// ---------------------------------------------------------------------------

export interface SpeciesWeight {
  key: string;
  name: string;
  group: string;
  /** Score contributed per slot — the fitted effective strength. */
  weight: number;
  /** Rescaled so the numbers sit on the Strength Ladder's own scale and the two tables can
   *  be read side by side. Purely cosmetic; the ordering is what matters. */
  effective: number;
  /** What the Strength Ladder says the same species is worth: √(str·dex·con). */
  ladder: number;
  /** Times this species appeared across the sample — a weight from few appearances is
   *  noise and should be read as such. */
  appearances: number;
}

export interface EffectiveFit {
  species: SpeciesWeight[];
  parties: number;
  /** Held-out predictive power, fitted weights vs the Strength Ladder. THE result: a new
   *  metric is only worth adopting if it orders unseen armies better than the old one. */
  validation: {
    heldOut: number;
    fittedPearson: number;
    fittedSpearman: number;
    ladderPearson: number;
    ladderSpearman: number;
  };
}

export function fitEffective(observations: readonly Observation[]): EffectiveFit {
  const pool = speciesPool(EFFECTIVE_ACCOUNT.playerLevel ?? 50);
  // THE SAMPLE AND THE FIT MUST AGREE ON THE ALPHABET. An observation's `counts` is
  // positional against `speciesPool()`, so if the catalog grows between the sampling pass
  // and this one — a new colour class landing in zombies.json mid-run, which has happened —
  // every added column reads `undefined`, the solver returns NaN for it, and the frozen
  // weights come out `null` for species that look fine in the table. Fail here instead.
  const stale = observations.find((o) => o.counts.length !== pool.length);
  if (stale) {
    throw new Error(
      `effective fit: observations carry ${stale.counts.length} species but the catalog now ` +
      `has ${pool.length}. The sampling pass ran against a different catalog — re-run it ` +
      `(npm run test:effective) rather than fitting across the change.`
    );
  }
  // Deterministic split on index, so the held-out set is the same between runs.
  const train = observations.filter((_, i) => i % 5 !== 0);
  const test = observations.filter((_, i) => i % 5 === 0);

  const w = ridgeSolve(train.map((o) => o.counts), train.map((o) => o.score), RIDGE);
  const predict = (o: Observation) => o.counts.reduce((s, n, i) => s + n * w[i], 0);

  const actual = test.map((o) => o.score);
  const fitted = test.map(predict);
  const ladder = test.map((o) => o.ladder);

  const appearances = new Array<number>(pool.length).fill(0);
  for (const o of observations) for (let i = 0; i < pool.length; i++) appearances[i] += o.counts[i];

  // Rescale onto the ladder's range so the two columns are comparable at a glance. An
  // affine map, so it changes nothing about the ordering or the relative gaps.
  const ladderOf = (z: ZombieDef) =>
    Math.sqrt(Math.max(0.1, z.str) * Math.max(0.1, z.dex) * Math.max(0.1, z.con));
  const maxW = Math.max(...w.map((x) => Math.abs(x)), 1e-9);
  const maxL = Math.max(...pool.map(ladderOf));

  return {
    parties: observations.length,
    species: pool.map((z, i) => ({
      key: z.key,
      name: z.name,
      group: z.group ?? "Regular",
      weight: w[i],
      effective: (w[i] / maxW) * maxL,
      ladder: ladderOf(z),
      appearances: appearances[i],
    })).sort((a, b) => b.weight - a.weight),
    validation: {
      heldOut: test.length,
      fittedPearson: pearson(fitted, actual),
      fittedSpearman: spearman(fitted, actual),
      ladderPearson: pearson(ladder, actual),
      ladderSpearman: spearman(ladder, actual),
    },
  };
}
