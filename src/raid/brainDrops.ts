/** Recovered invasion brain table. Amounts stay fixed; the live game uses a 2x
 * drop-rate event multiplier across every tier. Tiers roll rarest-first so a boss
 * can award at most one stack. */
export const BRAIN_DROP_RATE_MULTIPLIER = 2;
export const BRAIN_OPTIMAL_LEVEL = 20;

const BASE_BRAIN_DROP_TABLE = [
  { amount: 50, lower: 0.005, upper: 0.01 },
  { amount: 30, lower: 0.01, upper: 0.02 },
  { amount: 10, lower: 0.025, upper: 0.05 },
] as const;

export function brainDropTable(recommendedLevel: number) {
  const frac = Math.max(0, Math.min(1, recommendedLevel / BRAIN_OPTIMAL_LEVEL));
  return BASE_BRAIN_DROP_TABLE.map((tier) => ({
    amount: tier.amount,
    chance: (tier.lower + (tier.upper - tier.lower) * frac) * BRAIN_DROP_RATE_MULTIPLIER,
  }));
}

export function rollBrainDrop(recommendedLevel: number, random: () => number = Math.random): number {
  for (const tier of brainDropTable(recommendedLevel)) {
    if (random() < tier.chance) return tier.amount;
  }
  return 0;
}
