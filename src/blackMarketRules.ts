/** The Black Market itself opens at level 10. Trading is a late-opening surface: it
 *  needs a roster worth posting and brains worth spending, and a brand-new farm that
 *  wanders in can only be sold to. Client-side the Social hub locks the entry; the
 *  Worker enforces the same floor on the two calls that actually move anything
 *  (create + fulfill), so the lock is real rather than a hidden button. */
export const BLACK_MARKET_MIN_LEVEL = 10;

/** Floor under every special-zombie purchase.
 *
 *  The Black Market was the game's shortcut past its own progression: one level-20 gate
 *  covered the whole special category, so a farm that had just cleared the Lawyers could
 *  buy an Aliens Cozmonaut or a Loco Locust Vagabond outright — the two strongest things
 *  in the game — for gold someone else had earned. A special is now gated at the level its
 *  OWN source opens (`specialZombieSourceLevel`: the invasion's unlock level, the Epic
 *  Boss event's, the Zombie Pot's), less BLACK_MARKET_SPECIAL_HEAD_START and held under
 *  this floor. Trading still bypasses crop planting levels and still saves a player the
 *  grind; what it no longer does is skip the ladder.
 *
 *  The floor stays at 20 — where the flat gate was, and where the five brain-market
 *  specials plant — so the trade is never stricter than growing your own. */
export const BLACK_MARKET_SPECIAL_FLOOR_LEVEL = 20;

/** Levels a special may be bought AHEAD of its own source.
 *
 *  The gate is meant to stop the market selling the end of the game, not to make the
 *  market the last place a zombie turns up. Three levels means the trade is a way to reach
 *  a prize slightly early — the Aliens' Zastronaut at 33 rather than 36 — instead of an
 *  identical copy of a wall the player is already standing at. It is the same three levels
 *  everywhere, so the ladder keeps the shape its sources give it. */
export const BLACK_MARKET_SPECIAL_HEAD_START = 3;
export const BLACK_MARKET_COLOR_LEVELS = {
  Blue: 1,
  Red: 15,
  Silver: 25,
} as const;

export type BlackMarketPurchaseLock = { kind: "level"; level: number; label: string };

export interface BlackMarketZombieRequirement {
  /** Catalog key — what decides a special's own source level. */
  key?: string;
  category?: "normal" | "special" | "mutant";
  unlockGrave?: "Blue" | "Red" | "Silver";
}

export type BlackMarketComposeKind = "BUY_ZOMBIE" | "SELL_ZOMBIE";

// ---- Browse filters ------------------------------------------------------
// The catalog has two real axes, and the toolbar cuts along both: the colour class
// (the tier ladder Green -> Blue -> Red -> Silver, then the specials) and the body
// family. Beware the vocabulary crossover — the player calls the colour axis the
// "category" and the family axis the "class", while the catalog data calls them
// `className` and `group`. The wire values below are the DATA's words so no
// translation table is needed server-side; only `label` is the player's.

export interface BlackMarketFilterOption {
  /** Value sent to the server; matches the catalog field exactly. */
  value: string;
  /** Toolbar text. */
  label: string;
  /** Extra catalog values folded into this option. */
  also?: readonly string[];
}

/** Colour-class options — the toolbar's "category" dropdown. */
export const BLACK_MARKET_CLASS_FILTERS: readonly BlackMarketFilterOption[] = [
  { value: "Green", label: "Green" },
  { value: "Blue", label: "Blue" },
  { value: "Red", label: "Red" },
  { value: "Silver", label: "Silver" },
  // Yellow is the tier-less uniques (Crazy, Cupid). There is no Yellow rung on the
  // ladder and a player reads them as specials, so they file under Special.
  { value: "Special", label: "Special", also: ["Yellow"] },
];

/** Body-family options — the toolbar's "class" dropdown. */
export const BLACK_MARKET_GROUP_FILTERS: readonly BlackMarketFilterOption[] = [
  { value: "Regular", label: "Normal" },
  { value: "Female", label: "Girl" },
  { value: "Large", label: "Large" },
  { value: "Garden", label: "Garden" },
  { value: "Headless", label: "Headless" },
  { value: "Small", label: "Mini" },
];

/** Initial values for the Create Post form. A roster-originated sale keeps the
 * concrete unit selected when the Black Market opens. */
export function blackMarketComposeDefaults(
  kind: BlackMarketComposeKind,
  selectedUnitId: string | undefined,
  availableUnitIds: readonly string[],
): { kind: BlackMarketComposeKind; assetId?: string } {
  return {
    kind,
    ...(kind === "SELL_ZOMBIE" && selectedUnitId && availableUnitIds.includes(selectedUnitId)
      ? { assetId: selectedUnitId }
      : {}),
  };
}

/** The level a BUYER must have reached to receive `key`, if it is a special: three levels
 *  under the one its own invasion / Epic Boss event / the Zombie Pot opens at, never below
 *  BLACK_MARKET_SPECIAL_FLOOR_LEVEL. A special with no live source (the orphaned
 *  seasonals, tradable only because old saves hold them) takes the bare floor. */
export function blackMarketSpecialLevel(key: string | undefined): number {
  const sourceLevel = (key !== undefined ? specialZombieSourceLevel(key) : null) ?? 0;
  return Math.max(
    BLACK_MARKET_SPECIAL_FLOOR_LEVEL,
    sourceLevel - BLACK_MARKET_SPECIAL_HEAD_START
  );
}

/** Black Market purchases ignore ordinary crop unlock levels. Colored classes unlock at
 * their gravestone's level, while a special is gated just under its own source's level
 * (see blackMarketSpecialLevel). The stricter of the two applies. */
export function blackMarketPurchaseLock(
  zombie: BlackMarketZombieRequirement,
  playerLevel: number
): BlackMarketPurchaseLock | null {
  const requiredLevel = Math.max(
    zombie.category === "special" ? blackMarketSpecialLevel(zombie.key) : 0,
    zombie.unlockGrave ? BLACK_MARKET_COLOR_LEVELS[zombie.unlockGrave] : 0
  );
  if (playerLevel < requiredLevel) {
    return {
      kind: "level",
      level: requiredLevel,
      label: `Level ${requiredLevel} required`,
    };
  }
  return null;
}

/** Mutations a wanted post may name: every mutation the catalog knows.
 *
 * `black_market_orders.mutation_required` used to CHECK `BETWEEN 1 AND 8191` — the OR
 * of the 13 bits that existed at migration 0030 — which silently made each new
 * mutation unrequestable until someone rebuilt the table. Migration 0044 replaced it
 * with a plain `> 0` bound and moved the exact legal set here, where the catalog is,
 * so a mutation added to mutations.ts is requestable the moment it exists. */
export const REQUESTABLE_MUTATION_MASK = ALL_MUTATIONS_MASK;

/** A specific request matches when the bit is present, even if the zombie carries
 * other mutations too. Without a specific bit, preserve the any/none behavior. */
export function matchesBlackMarketMutation(
  mutationMask: number,
  mutated: boolean,
  mutationRequired?: number
): boolean {
  if (mutationRequired === undefined) return (mutationMask !== 0) === mutated;
  return SLOTS.every((slot) => {
    const requestedInSlot = maskIntersect(mutationRequired, SLOT_MASK[slot]);
    return requestedInSlot === 0 || maskIntersect(mutationMask, requestedInSlot) !== 0;
  });
}

/** Human-readable grouped expression: alternatives within one anatomical slot use
 * "or", while requirements spanning separate slots use "+". */
export function blackMarketMutationRequirementLabel(mask: number): string {
  return SLOTS
    .map((slot) => MUTATION_LIST
      .filter((mutation) => mutation.slot === slot && maskHas(mask, mutation.bit))
      .map((mutation) => mutation.name)
      .join(" or "))
    .filter(Boolean)
    .join(" + ");
}
import { ALL_MUTATIONS_MASK, MUTATION_LIST, SLOTS, SLOT_MASK } from "./zombie/mutations";
import { maskHas, maskIntersect } from "./zombie/mutationMask";
import { specialZombieSourceLevel } from "./zombie/specialUnlock";
