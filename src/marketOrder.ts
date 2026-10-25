import { PRIZE_CROPS } from "./cropUnlocks";
import { EVERGREEN, themeAvailable } from "./decorThemes";

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

/** A Market entry, crop or item: a plants.json row or crop card (key on `key` or `cfg`), or
 *  a placeable def (its holiday on `theme`). */
interface MarketEntry {
  seasonal?: boolean;
  level: number;
  theme?: string;
  key?: string;
  cfg?: { key: string };
}

/** 0 = in season (its holiday is on ACTIVE_THEMES), 1 = the permanent catalog, 2 = any
 *  other seasonal entry. The holiday's own goods lead the tab while it runs, so they are
 *  not twenty pages deep (owner, 2026-10-25); out of season they drop back to the end. */
function seasonRank(entry: MarketEntry): number {
  const key = entry.key ?? entry.cfg?.key;
  const theme = entry.theme ?? (key ? SEASONAL_CROP_THEMES[key] : undefined);
  if (theme && theme !== EVERGREEN && themeAvailable(theme)) return 0;
  return entry.seasonal ? 2 : 1;
}

/** Market crop order: in-season holiday crops first, then the permanent catalog, then any
 * other holiday crop; unlock level orders entries within each group. Stable sort
 * preserves authored order for entries tied on both keys. */
export function compareCropMarketOrder(a: MarketEntry, b: MarketEntry): number {
  return seasonRank(a) - seasonRank(b) || a.level - b.level;
}

/** Market item order: in-season holiday items first, then permanent items, then other
 * seasonal/event items; unlock level orders entries within each group. */
export function compareItemMarketOrder(a: MarketEntry, b: MarketEntry): number {
  return seasonRank(a) - seasonRank(b) || a.level - b.level;
}
