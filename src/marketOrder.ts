import { PRIZE_CROPS } from "./cropUnlocks";
import { themeAvailable } from "./decorThemes";

/** The holiday a seasonal seed belongs to. A seasonal crop is sold while its theme is on
 *  decorThemes.ACTIVE_THEMES, the same switch that puts that holiday's decor in the
 *  market, and never otherwise; one with no entry here stays withheld. Client-only: the
 *  Worker's crop catalog already prices every seed, seasonal or not. */
export const SEASONAL_CROP_THEMES: Readonly<Record<string, string>> = {
  candy_corn: "halloween",
};

/** Whether a seed is on sale. Seasonal seeds follow their theme (SEASONAL_CROP_THEMES);
 *  planted crops still use the complete asset catalog for save restore and harvest.
 *  Takes a plants.json row (`key`) or a Market card (MenuCard, whose key is on `cfg`): the
 *  Market filters its CARDS, and a card has no top-level key. */
export function cropAvailableInMarket(
  crop: { key?: string; cfg?: { key: string }; seasonal?: boolean; prize?: boolean },
): boolean {
  if (crop.seasonal) {
    const key = crop.key ?? crop.cfg?.key;
    const theme = key ? SEASONAL_CROP_THEMES[key] : undefined;
    return !!theme && themeAvailable(theme);
  }
  // A prize crop (src/cropUnlocks.ts) has no shop card at all until the prize crops are
  // live — and it also keeps it out of the quest pool, which asks this same question.
  return !crop.prize || PRIZE_CROPS.live;
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
