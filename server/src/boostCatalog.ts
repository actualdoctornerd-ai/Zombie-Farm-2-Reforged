// Server-side boost (consumable) catalog. Mirrors public/assets/boosts.json so the
// server prices a purchase EXACTLY (client can't underpay) and knows how many uses a
// purchase grants. Consumable boost COUNTS are server-owned (the `inventory` table);
// the save blob's boost list becomes an ignored cache, like currency.
//
// KEEP IN SYNC with boosts.json (8 boosts).
//
// The table below is GENERATED from that asset: `npm run catalogs` (server/
// scripts/gen-catalogs.mjs) rewrites the `#region generated:` block, and
// `npm run catalogs:check` fails CI and the deploy:prod gate when the two drift.
// Edit the ASSET, not the region. Everything outside the region is hand-written
// and is not touched.
//
// Scope: consumable boosts only. Zombie-purchase "gift" powers are intentionally
// omitted. Non-boost inventory (placed objects, ground skins, farm-size, received
// loot) is not covered here.

export interface BoostEcon {
  /** Purchase cost, in `brains` if `brains` is true else gold. */
  cost: number;
  brains: boolean;
  /** Uses granted per purchase. */
  perPurchase: number;
  /** Player level required. ENFORCED — `v3/engine.ts` rejects a `power.buy` below it with
   *  `locked`, so this is not informational and must track boosts.json's `level`.
   *  `boostCatalogSync.test.ts` holds the two tables together. */
  level: number;
  /** Voucher boosts only ("gift" effect): the roster zombie key a use redeems into.
   *  Mirrors boosts.json `giftZombieKey`; every value is a real rosterCatalog key. */
  gift?: string;
  /** Never sold (boosts.json `notForSale`): power.buy refuses it with `not_for_sale`. It
   *  reaches an inventory only as a grant — the Green Flower Ticket is a quest prize. */
  notForSale?: boolean;
}

export const BOOSTS: Readonly<Record<string, BoostEcon>> = {
  // #region generated:BOOSTS
  // Source: public/assets/boosts.json — regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit
  insta_grow: { cost: 1, brains: true, perPurchase: 20, level: 0 },
  insta_harvest: { cost: 1, brains: true, perPurchase: 4, level: 0 },
  insta_plow: { cost: 1, brains: true, perPurchase: 4, level: 0 },
  concentration: { cost: 1, brains: true, perPurchase: 2, level: 0 },
  golden_dice: { cost: 1, brains: true, perPurchase: 1, level: 0 },
  invasion_voucher: { cost: 2000, brains: false, perPurchase: 1, level: 0 },
  brain_ticket: { cost: 10000, brains: false, perPurchase: 1, level: 20 },
  green_flower_ticket: { cost: 0, brains: false, perPurchase: 1, level: 0, notForSale: true },
  // #endregion generated:BOOSTS
};

/** The boost that bypasses the raid cooldown — consumed server-side on /raid/start.
 *  Buying one to raid again is intended play, not an exploit. */
export const VOUCHER_KEY = "invasion_voucher";

/** The Invasion Voucher's expensive cousin, also consumed server-side on /raid/start.
 *  It skips the cooldown the same way, quadruples the fight's brain and rare-zombie odds,
 *  and promotes the invasion to ELITE — the wave fought at the scaled stats in
 *  src/raid/eliteInvasion.ts. Whether a session was elite is pinned to it at /raid/start
 *  (boosts_json), so the reward roll and the verifier's replay read the same fact. */
export const BRAIN_TICKET_KEY = "brain_ticket";

/** The loot-luck boost spent before a raid (Golden Dice), consumed server-side on
 *  /raid/start and pinned to the session so the server's loot roll uses the real count. */
export const DICE_KEY = "golden_dice";
export const CONCENTRATION_KEY = "concentration";

/** DISPLAY NAME -> boost key. Raid loot tables name their entries the way the UI does
 *  ("Insta-Plow"), so a loot drop that is really a boost has to be resolved by name —
 *  mirroring the client's `assets.boosts.find(b => b.name === drop)`. Six boosts appear
 *  in loot tables (Insta-Grow/Harvest/Plow, Concentration, Golden Dice, Invasion
 *  Voucher).
 *  KEEP IN SYNC with boosts.json `name`. */
export const BOOST_BY_NAME: Readonly<Record<string, string>> = {
  // #region generated:BOOST_BY_NAME
  // Source: public/assets/boosts.json — regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit
  "Insta-Grow": "insta_grow",
  "Insta-Harvest": "insta_harvest",
  "Insta-Plow": "insta_plow",
  Concentration: "concentration",
  "Golden Dice": "golden_dice",
  "Invasion Voucher": "invasion_voucher",
  "Brain Ticket": "brain_ticket",
  "Green Flower Ticket": "green_flower_ticket",
  // #endregion generated:BOOST_BY_NAME
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
