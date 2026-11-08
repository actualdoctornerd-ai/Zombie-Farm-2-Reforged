// What beating Endless's bosses unlocks for good (owner, 2026-11-08). One rule, read by the
// Worker (caps it enforces, fights it verifies) and the client (caps it shows, fights it
// simulates), keyed off one number: the deepest normal-Endless tier the account has cleared,
// `endlessBestTier` on the gameplay core document. See docs/ENDLESS_MODE_REWARDS.md.
//
//   T4  +8 Mausoleum slots (while a Mausoleum stands; it adds to the building, not a crypt of its own)
//   T5  +16 shed slots
//   T6  the 80x80 farm goes on sale
//   T7  +1 max veterancy: a sixth rank, Legend, one more +5% step (+30% in all, Master +25%)
//   T8+ brains on every boss win: 4 at T8, 5 at T9, one more each tier (endlessVictoryBrains)

export const ENDLESS_PERK_TIER = { crypt: 4, shed: 5, expansion: 6, veterancy: 7 } as const;
export const ENDLESS_CRYPT_SLOTS = 8;
export const ENDLESS_SHED_SLOTS = 16;
/** The farm size only Endless unlocks (it still has to be bought, like every other size). */
export const ENDLESS_EXPANSION_SIZE = 80;
/** The tier from which every boss win pays brains. */
export const ENDLESS_VICTORY_BRAINS_FROM = 8;

export interface EndlessPerks {
  cryptSlots: number;
  shedSlots: number;
  expansion: boolean;
  /** Extra veterancy ranks above Master. */
  vetRanks: number;
}

export function endlessPerksFor(bestTier: number): EndlessPerks {
  const t = Number.isFinite(bestTier) ? bestTier : 0;
  return {
    cryptSlots: t >= ENDLESS_PERK_TIER.crypt ? ENDLESS_CRYPT_SLOTS : 0,
    shedSlots: t >= ENDLESS_PERK_TIER.shed ? ENDLESS_SHED_SLOTS : 0,
    expansion: t >= ENDLESS_PERK_TIER.expansion,
    vetRanks: t >= ENDLESS_PERK_TIER.veterancy ? 1 : 0,
  };
}

/** The best tier recorded on a gameplay core document (absent = none cleared). */
export function endlessBestTierOf(core: unknown): number {
  const value = (core as { endlessBestTier?: unknown } | null)?.endlessBestTier;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Master, the veterancy rank every account reaches (zombie/traits MAX_VET_RANK; this module
 *  cannot import traits, which imports it, and endlessPerks.test.ts pins the two equal). */
export const BASE_MAX_VET_RANK = 5;

/** The veterancy ceiling of the account owning `core`: what a Worker fight passes as
 *  buildPlayerUnits' `maxVetRank`. */
export function endlessMaxVetRankOf(core: unknown): number {
  return BASE_MAX_VET_RANK + endlessPerksFor(endlessBestTierOf(core)).vetRanks;
}

/** Brains a boss win at `tier` pays, every time: 4 at T8, 5 at T9, and so on. The real
 *  prize that deep is the leaderboard; this keeps the runs paying for themselves. */
export function endlessVictoryBrains(tier: number): number {
  return tier >= ENDLESS_VICTORY_BRAINS_FROM ? tier - (ENDLESS_VICTORY_BRAINS_FROM - 4) : 0;
}

// ---- The signed-in account, client side only ------------------------------------------
// The client plays one account, so its caps and cards read this. The Worker never sets it:
// it reads each account's own core document and passes the numbers explicitly.
let accountBestTier = 0;
const listeners = new Set<() => void>();

export function setAccountEndlessBestTier(tier: number): void {
  const next = Math.max(0, Math.floor(Number.isFinite(tier) ? tier : 0));
  if (next === accountBestTier) return;
  accountBestTier = next;
  for (const listener of listeners) listener();
}
export function accountEndlessPerks(): EndlessPerks {
  return endlessPerksFor(accountBestTier);
}
export function accountEndlessBestTier(): number {
  return accountBestTier;
}
/** Called whenever the account's perks change (to re-derive caps). */
export function onAccountEndlessPerks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
