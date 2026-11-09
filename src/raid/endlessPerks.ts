// What beating Endless's bosses unlocks for good (owner, 2026-11-08). One rule, read by the
// Worker (caps it enforces, fights it verifies) and the client (caps it shows, fights it
// simulates), keyed off one number: the deepest normal-Endless tier the account has cleared,
// `endlessBestTier` on the gameplay core document. See docs/ENDLESS_MODE_REWARDS.md.
//
//   T5  +8 Mausoleum slots (while a Mausoleum stands; it adds to the building, not a crypt of its own)
//   T6  +16 shed slots
//   T7  the 80x80 farm goes on sale
//   T8  +1 max veterancy: a sixth rank, Legend, one more +5% step (+30% in all, Master +25%)
//   T9+ +16 more shed slots for each new deepest tier (owner, 2026-11-08: storage, not brains)
//
// T8 is the stretch tier, the last real reward (owner, 2026-11-08: higher tiers are for
// leaderboard chasers, and this content is in part designed to push people's builds).

export const ENDLESS_PERK_TIER = { crypt: 5, shed: 6, expansion: 7, veterancy: 8 } as const;
export const ENDLESS_CRYPT_SLOTS = 8;
export const ENDLESS_SHED_SLOTS = 16;
/** The farm size only Endless unlocks (it still has to be bought, like every other size). */
export const ENDLESS_EXPANSION_SIZE = 80;
/** The tier from which every boss win pays brains. */
export const ENDLESS_VICTORY_BRAINS_FROM = 9;

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
    shedSlots: (t >= ENDLESS_PERK_TIER.shed ? ENDLESS_SHED_SLOTS : 0)
      + ENDLESS_SHED_SLOTS * Math.max(0, t - ENDLESS_PERK_TIER.veterancy),
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

/** Retired 2026-11-08 (owner: storage past T8, not brains). Kept so old callers compile. */
export function endlessVictoryBrains(_tier: number): number {
  return 0;
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
