// Server-side boost (consumable) catalog. Mirrors public/assets/boosts.json so the
// server prices a purchase EXACTLY (client can't underpay) and knows how many uses a
// purchase grants. Consumable boost COUNTS are server-owned (the `inventory` table);
// the save blob's boost list becomes an ignored cache, like currency.
//
// KEEP IN SYNC with boosts.json (10 boosts).
//
// Scope: consumable boosts only. A "gift" boost is a voucher: using one consumes the
// voucher and grants the zombie named by `gift` into the server roster (see
// planGiftRedeem / applyInventoryActions), so a redeemed gift zombie is a legitimately
// sellable unit with verified provenance. Non-boost inventory (placed objects, ground
// skins, farm-size, received loot) is not covered here.

export interface BoostEcon {
  /** Purchase cost, in `brains` if `brains` is true else gold. */
  cost: number;
  brains: boolean;
  /** Uses granted per purchase. */
  perPurchase: number;
  /** Player level required (informational; unlock gating stays client-side for now). */
  level: number;
  /** Voucher boosts only ("gift" effect): the roster zombie key a use redeems into.
   *  Mirrors boosts.json `giftZombieKey`; every value is a real rosterCatalog key. */
  gift?: string;
}

export const BOOSTS: Readonly<Record<string, BoostEcon>> = {
  insta_grow: { cost: 10, brains: true, perPurchase: 20, level: 0 },
  insta_harvest: { cost: 10, brains: true, perPurchase: 4, level: 0 },
  insta_plow: { cost: 10, brains: true, perPurchase: 4, level: 0 },
  crazy_zombie_voucher: { cost: 100, brains: true, perPurchase: 1, level: 25, gift: "ZombieActorRegularCrazy" },
  valentine_gift: { cost: 100, brains: true, perPurchase: 1, level: 25, gift: "ZombieActorGardenCupid" },
  valentine_gift_2012: { cost: 100, brains: true, perPurchase: 1, level: 25, gift: "ZombieActorGardenCupid" },
  flower_zombie_pot: { cost: 50, brains: true, perPurchase: 1, level: 0, gift: "ZombieActorGardenTier3GreenFlower" },
  concentration: { cost: 10, brains: true, perPurchase: 2, level: 0 },
  golden_dice: { cost: 10, brains: true, perPurchase: 1, level: 0 },
  invasion_voucher: { cost: 2000, brains: false, perPurchase: 1, level: 0 },
};

/** The boost that bypasses the raid cooldown — consumed server-side on /raid/start.
 *  Buying one to raid again is intended play, not an exploit. */
export const VOUCHER_KEY = "invasion_voucher";

/** The loot-luck boost spent before a raid (Golden Dice), consumed server-side on
 *  /raid/start and pinned to the session so the server's loot roll uses the real count. */
export const DICE_KEY = "golden_dice";

/** DISPLAY NAME -> boost key. Raid loot tables name their entries the way the UI does
 *  ("Insta-Plow"), so a loot drop that is really a boost has to be resolved by name —
 *  mirroring the client's `assets.boosts.find(b => b.name === drop)`. Six boosts appear
 *  in loot tables (Insta-Grow/Harvest/Plow, Concentration, Golden Dice, Invasion
 *  Voucher); the rest are listed for completeness.
 *  KEEP IN SYNC with boosts.json `name`. */
export const BOOST_BY_NAME: Readonly<Record<string, string>> = {
  "Insta-Grow": "insta_grow",
  "Insta-Harvest": "insta_harvest",
  "Insta-Plow": "insta_plow",
  "Crazy Zombie Voucher": "crazy_zombie_voucher",
  "Valentine Gift": "valentine_gift",
  "Valentine Gift 2012": "valentine_gift_2012",
  "Flower Zombie Pot": "flower_zombie_pot",
  Concentration: "concentration",
  "Golden Dice": "golden_dice",
  "Invasion Voucher": "invasion_voucher",
};

/** The boost a loot entry grants, or undefined if the entry isn't a boost. */
export function boostKeyForName(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(BOOST_BY_NAME, name) ? BOOST_BY_NAME[name] : undefined;
}

/** Every server-owned boost key (the set the inventory table tracks / seeds). */
export const BOOST_KEYS: readonly string[] = Object.keys(BOOSTS);

export function boostEcon(key: string): BoostEcon | undefined {
  return Object.prototype.hasOwnProperty.call(BOOSTS, key) ? BOOSTS[key] : undefined;
}

/** Per-key ceiling on how many a player may hold — a plausibility bound so a modified
 *  client can't seed/grant an absurd stack. Generous vs. legit play. */
export const MAX_STACK = 9999;
