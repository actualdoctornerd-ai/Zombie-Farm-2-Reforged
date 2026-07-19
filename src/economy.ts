// ---------------------------------------------------------------------------
// Economy rules — the single recorded source of truth for buy/sell/XP balancing.
// ---------------------------------------------------------------------------
// Keep tunable economy numbers here (not scattered as magic numbers) so the
// balance is easy to find, reason about, and adjust.
//
// Design intent (placeable items — decor / trees / functional):
//   - BUYING an item costs its full price and grants exactly the XP authored in
//     the source Market catalog. A missing/zero XP field grants no XP.
//   - SELLING an item refunds only a small fraction of its price, so churning
//     buy->sell is a real loss, not a free way to farm money.
// ---------------------------------------------------------------------------

export const ECONOMY = {
  /**
   * Fraction of an item's purchase price refunded when it is sold. Selling is
   * meant to be a significant loss versus buying, so this is well below 1.
   * (Was 0.5; lowered so sell value is "significantly less than bought for".)
   */
  SELL_BACK_RATIO: 0.2,

} as const;

/** XP granted for buying/placing an item that cost `cost` and whose source data
 *  declares `sourceXp` (0/absent when the source has none). */
export function buyXp(_cost: number, sourceXp = 0): number {
  return Math.max(0, sourceXp);
}

/** Gold/brains refunded when selling an item that was bought for `cost`. */
export function sellBack(cost: number): number {
  return Math.max(1, Math.floor(cost * ECONOMY.SELL_BACK_RATIO));
}

/** Gold paid for selling an owned zombie. GROUND TRUTH (binary
 *  `-[ZFToolManager sellZombie:]`, docs/mechanics/COMBAT_STATS_RECOVERED.md): the
 *  sell value is simply `floor(baseMarketCost / 2)` — HALF the unit's base buy
 *  price, flat. It is NOT scaled by stats, mutations, or veterancy (the earlier
 *  stat-scaled model was a guess). `baseCost` is the zombie type's market cost
 *  (ZombieDef.cost); pass 0 for a type with no price to floor the payout at 1. */
export function zombieSellValue(baseCost: number): number {
  return Math.max(1, Math.floor((baseCost || 0) / 2));
}
