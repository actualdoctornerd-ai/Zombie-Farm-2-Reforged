import { PRIZE_CROPS } from "./cropUnlocks";

/** Seasonal seeds are temporarily unavailable from every crop-purchase surface.
 * Planted crops still use the complete asset catalog for save restore and harvest. */
export function cropAvailableInMarket(crop: { seasonal?: boolean; prize?: boolean }): boolean {
  // A prize crop (src/cropUnlocks.ts) has no shop card at all until the prize crops are
  // live — and it also keeps it out of the quest pool, which asks this same question.
  return !crop.seasonal && (!crop.prize || PRIZE_CROPS.live);
}

/** Market crop order: permanent catalog first, holiday/seasonal catalog last;
 * unlock level orders entries within each group. Stable sort preserves authored
 * order for entries tied on both keys. */
export function compareCropMarketOrder(
  a: { seasonal?: boolean; level: number },
  b: { seasonal?: boolean; level: number }
): number {
  return Number(!!a.seasonal) - Number(!!b.seasonal) || a.level - b.level;
}

/** Market item order: permanent items first, seasonal/event items last; unlock
 * level orders entries within each group. */
export function compareItemMarketOrder(
  a: { seasonal?: boolean; level: number },
  b: { seasonal?: boolean; level: number }
): number {
  return Number(!!a.seasonal) - Number(!!b.seasonal) || a.level - b.level;
}
