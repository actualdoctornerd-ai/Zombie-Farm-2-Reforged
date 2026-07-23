export const BLACK_MARKET_SPECIAL_LEVEL = 20;

export type BlackMarketPurchaseLock =
  | { kind: "level"; level: number; label: string }
  | { kind: "grave"; grave: "Blue" | "Red" | "Silver"; label: string };

export interface BlackMarketZombieRequirement {
  category?: "normal" | "special" | "mutant";
  unlockGrave?: "Blue" | "Red" | "Silver";
}

/** Black Market purchases ignore ordinary crop unlock levels. Colored-class zombies
 * still need their grave placed, while every special zombie shares the level-20 gate. */
export function blackMarketPurchaseLock(
  zombie: BlackMarketZombieRequirement,
  playerLevel: number,
  hasGrave: (grave: "Blue" | "Red" | "Silver") => boolean
): BlackMarketPurchaseLock | null {
  if (zombie.category === "special" && playerLevel < BLACK_MARKET_SPECIAL_LEVEL) {
    return {
      kind: "level",
      level: BLACK_MARKET_SPECIAL_LEVEL,
      label: `Level ${BLACK_MARKET_SPECIAL_LEVEL} required`,
    };
  }
  if (zombie.unlockGrave && !hasGrave(zombie.unlockGrave)) {
    return {
      kind: "grave",
      grave: zombie.unlockGrave,
      label: `${zombie.unlockGrave} Gravestone required`,
    };
  }
  return null;
}

/** A specific request matches when the bit is present, even if the zombie carries
 * other mutations too. Without a specific bit, preserve the any/none behavior. */
export function matchesBlackMarketMutation(
  mutationMask: number,
  mutated: boolean,
  mutationRequired?: number
): boolean {
  if (mutationRequired === undefined) return (mutationMask !== 0) === mutated;
  return SLOTS.every((slot) => {
    const requestedInSlot = mutationRequired & SLOT_MASK[slot];
    return requestedInSlot === 0 || (mutationMask & requestedInSlot) !== 0;
  });
}

/** Human-readable grouped expression: alternatives within one anatomical slot use
 * "or", while requirements spanning separate slots use "+". */
export function blackMarketMutationRequirementLabel(mask: number): string {
  return SLOTS
    .map((slot) => Object.values(MUTATIONS)
      .filter((mutation) => mutation.slot === slot && (mask & mutation.bit) !== 0)
      .map((mutation) => mutation.name)
      .join(" or "))
    .filter(Boolean)
    .join(" + ");
}
import { MUTATIONS, SLOTS, SLOT_MASK } from "./zombie/mutations";
