/** Recovered invasion brain table. Amounts stay fixed; the live game uses a 2x
 * drop-rate event multiplier across every tier. Tiers roll rarest-first so a boss
 * can award at most one stack. */
export const BRAIN_DROP_RATE_MULTIPLIER = 2;

/** The recommended level at which a tier's chance reaches its `upper` rate. It is a
 *  RAMP REFERENCE, not a ceiling: the ramp keeps climbing at the same slope above it
 *  (see brainDropTable). The old behaviour clamped here, which parked every invasion
 *  from the Pirates (rec 21) to the Video Games (rec 43) on identical brain odds — six
 *  raids, twenty-two levels of progression, and no reason for a late-game player to
 *  invade anything harder. */
export const BRAIN_RAMP_LEVEL = 20;

// Post-brainflation revert: amounts are 1/10 of the old 50/30/10 stacks (a brain is now
// ~10x more valuable). Drop CHANCES are unchanged — only the stack sizes shrank.
const BASE_BRAIN_DROP_TABLE = [
  { amount: 5, lower: 0.005, upper: 0.01 },
  { amount: 3, lower: 0.01, upper: 0.02 },
  { amount: 1, lower: 0.025, upper: 0.05 },
] as const;

/** Hard ceiling on any single tier's chance. Nothing in the catalog comes close (the
 *  Video Games' commonest tier reaches ~16%, and 4x elite luck ~63%); it exists so a
 *  future raid or a fatter luck multiplier can't roll a chance past certainty. */
const MAX_TIER_CHANCE = 0.95;

/** This invasion's brain tiers, rarest first.
 *
 *  `recommendedLevel` drives a LINEAR ramp with no upper clamp: each tier starts at its
 *  `lower` rate and gains `(upper - lower)` for every BRAIN_RAMP_LEVEL of recommended
 *  level, so a harder invasion always pays better than an easier one. The rates stay
 *  deliberately stingy — the Video Games' 1-brain tier lands near 16% — but they no
 *  longer flatline halfway up the ladder.
 *
 *  `luck` multiplies every tier (1 = ordinary invasion, ELITE_BRAIN_LUCK for a Brain
 *  Ticket run). */
export function brainDropTable(recommendedLevel: number, luck = 1) {
  const frac = Math.max(0, recommendedLevel / BRAIN_RAMP_LEVEL);
  const scale = BRAIN_DROP_RATE_MULTIPLIER * Math.max(0, luck);
  return BASE_BRAIN_DROP_TABLE.map((tier) => ({
    amount: tier.amount,
    chance: Math.min(MAX_TIER_CHANCE, (tier.lower + (tier.upper - tier.lower) * frac) * scale),
  }));
}

/** Chance (0..1) that a brain-eligible win pays ANY brains. The tiers above are rolled
 *  independently, rarest first, and the first hit ends the roll — so the odds of walking
 *  away empty-handed are the product of every tier's miss. Display only. */
export function brainDropChance(recommendedLevel: number, luck = 1): number {
  return 1 - brainDropTable(recommendedLevel, luck).reduce((miss, tier) => miss * (1 - tier.chance), 1);
}

export function rollBrainDrop(
  recommendedLevel: number,
  random: () => number = Math.random,
  luck = 1
): number {
  for (const tier of brainDropTable(recommendedLevel, luck)) {
    if (random() < tier.chance) return tier.amount;
  }
  return 0;
}

/** The FIRST-ever clear of an invasion pays a guaranteed brain on top of the rolled
 *  drop: 1 brain below this unlock level, 2 from it up. 21 is the Pirates' unlock
 *  level, so "the Pirates and every harder raid" (Ninjas, Robots, Aliens, Video Games)
 *  pay double; the starter, Circus, Lawyers, and the level-8 seasonal raids pay one.
 *  Paid even on a boss-less stage (a first clear is a first clear), and shared by the
 *  server (/raid/finish) and the offline build so both price it identically. */
export const FIRST_CLEAR_BRAIN_DOUBLE_LEVEL = 21;

export function firstClearBrains(unlockLevel: number): number {
  return unlockLevel >= FIRST_CLEAR_BRAIN_DOUBLE_LEVEL ? 2 : 1;
}

/** Brain-eligible invasions a player may settle without a single brain before the next
 *  one is guaranteed to pay. At the top of the table a win drops something ~24% of the
 *  time, so an unlucky-but-perfectly-ordinary player can otherwise go a very long dry
 *  spell; this puts a floor under it.
 *
 *  DELIBERATELY INVISIBLE. Nothing in the UI counts this out, names it, or hints that a
 *  drop was floored rather than rolled — a pity brain must be indistinguishable from a
 *  lucky one. Keep it that way when touching the result panel or the fight's brain
 *  pickup. */
export const BRAIN_PITY_INVASIONS = 8;

/** What the floor pays: the commonest tier's stack, i.e. the smallest real drop. The
 *  guarantee is "at least one brain", not a jackpot. */
export const BRAIN_PITY_AMOUNT = BASE_BRAIN_DROP_TABLE[BASE_BRAIN_DROP_TABLE.length - 1].amount;

/** Roll a win's brain drop with the dry-streak floor applied. `dryStreak` is how many
 *  brain-eligible invasions have settled since the last brain (see nextBrainDryStreak);
 *  `luck` is the tier multiplier (see brainDropTable). A natural roll always wins — the
 *  floor only fills in a zero. */
export function rollBrainDropWithPity(
  recommendedLevel: number,
  dryStreak: number,
  random: () => number = Math.random,
  luck = 1
): number {
  const rolled = rollBrainDrop(recommendedLevel, random, luck);
  if (rolled > 0) return rolled;
  return dryStreak >= BRAIN_PITY_INVASIONS ? BRAIN_PITY_AMOUNT : 0;
}

/** Advance the dry streak for ONE settled brain-eligible invasion (a win against a boss —
 *  the only fight that can pay). A paid invasion resets it; a dry one adds to it, clamped
 *  at the threshold so the stored number stays bounded.
 *
 *  Only count fights that actually had a chance: a loss pays nothing at all, and a
 *  boss-less stage (the low-level McDonnell's ladder) never rolls brains, so neither
 *  should charge the counter towards a guarantee it can't honour. */
export function nextBrainDryStreak(dryStreak: number, brainsAwarded: number): number {
  if (brainsAwarded > 0) return 0;
  return Math.min(Math.max(0, Math.trunc(dryStreak)) + 1, BRAIN_PITY_INVASIONS);
}
