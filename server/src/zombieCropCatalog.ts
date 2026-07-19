// Server mirror of the PLANTABLE zombie-crop economics in public/assets/zombies.json.
// GENERATED — KEEP IN SYNC. In this game a zombie is grown from a zombie CROP: you
// plant a seed of key K (paying cost in gold or brains), it grows for growMs, and the
// harvest yields an owned zombie UNIT of the same key K. The crop key IS the zombie key.
//
// The server prices the plant + gates the harvest by real server grow time + grants the
// resulting unit into the roster — so a client can no longer fast-grow zombies or spawn
// an unearned (then sellable) unit. Veggie crops live in catalog.ts; the two key-sets are
// disjoint, so a plot is a zombie crop iff its key is in THIS table. (zombies.json has one
// duplicate key, ZombieActorGardenTier3 — deduped last-wins, matching the client catalog.)

export interface ZombieCropEcon {
  cost: number;    // plant cost
  brains: boolean; // cost paid in brains, not gold
  growMs: number;  // real grow time — server gates harvest against this
  xp: number;      // xp awarded on harvest
  level: number;   // player level required (informational)
}

import zombieRows from "../../public/assets/zombies.json";

const LEGACY_ZOMBIE_CROPS: Readonly<Record<string, ZombieCropEcon>> = {
  "ZombieActorGardenCupid": { cost: 10, brains: true, growMs: 86400000, xp: 2, level: 20 },
  "ZombieActorGardenCupidPink": { cost: 0, brains: false, growMs: 86400000, xp: 2, level: 25 },
  "ZombieActorGardenTier1": { cost: 150, brains: false, growMs: 86400000, xp: 2, level: 6 },
  "ZombieActorGardenTier2": { cost: 190, brains: false, growMs: 86400000, xp: 2, level: 13 },
  "ZombieActorGardenTier3": { cost: 225, brains: false, growMs: 86400000, xp: 2, level: 20 },
  "ZombieActorGardenTier3GreenFlower": { cost: 5, brains: true, growMs: 86400000, xp: 2, level: 1 },
  "ZombieActorGardenTier4": { cost: 300, brains: false, growMs: 86400000, xp: 2, level: 25 },
  "ZombieActorGardenTier5": { cost: 5, brains: true, growMs: 86400000, xp: 2, level: 1 },
  "ZombieActorGirlTier1": { cost: 45, brains: false, growMs: 600000, xp: 1, level: 3 },
  "ZombieActorGirlTier2": { cost: 55, brains: false, growMs: 14400000, xp: 1, level: 9 },
  "ZombieActorGirlTier3": { cost: 70, brains: false, growMs: 14400000, xp: 1, level: 16 },
  "ZombieActorGirlTier4": { cost: 90, brains: false, growMs: 14400000, xp: 1, level: 28 },
  "ZombieActorGirlTier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorHeadless2Tier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorHeadlessTier1": { cost: 40, brains: false, growMs: 600000, xp: 1, level: 2 },
  "ZombieActorHeadlessTier2": { cost: 50, brains: false, growMs: 14400000, xp: 1, level: 11 },
  "ZombieActorHeadlessTier3": { cost: 60, brains: false, growMs: 14400000, xp: 1, level: 17 },
  "ZombieActorHeadlessTier4": { cost: 80, brains: false, growMs: 14400000, xp: 1, level: 29 },
  "ZombieActorHeadlessTier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorLarge2Tier5": { cost: 5, brains: true, growMs: 21600000, xp: 2, level: 1 },
  "ZombieActorLarge3Tier5": { cost: 5, brains: true, growMs: 21600000, xp: 2, level: 1 },
  "ZombieActorLargeTier1": { cost: 80, brains: false, growMs: 1200000, xp: 1, level: 5 },
  "ZombieActorLargeTier2": { cost: 100, brains: false, growMs: 21600000, xp: 1, level: 12 },
  "ZombieActorLargeTier3": { cost: 120, brains: false, growMs: 21600000, xp: 1, level: 19 },
  "ZombieActorLargeTier4": { cost: 160, brains: false, growMs: 21600000, xp: 1, level: 26 },
  "ZombieActorLargeTier5": { cost: 5, brains: true, growMs: 21600000, xp: 2, level: 20 },
  "ZombieActorRegular2Tier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorRegular3Tier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorRegular4Tier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 1 },
  "ZombieActorRegularCrazy": { cost: 10, brains: true, growMs: 86400000, xp: 2, level: 20 },
  "ZombieActorRegularTier1": { cost: 35, brains: false, growMs: 600000, xp: 1, level: 1 },
  "ZombieActorRegularTier1Carrots": { cost: 55, brains: false, growMs: 21600000, xp: 1, level: 3 },
  "ZombieActorRegularTier1Coffee": { cost: 70, brains: false, growMs: 28800000, xp: 1, level: 9 },
  "ZombieActorRegularTier1Onions": { cost: 70, brains: false, growMs: 21600000, xp: 1, level: 3 },
  "ZombieActorRegularTier1Potatoes": { cost: 90, brains: false, growMs: 28800000, xp: 1, level: 6 },
  "ZombieActorRegularTier1Tomatoes": { cost: 60, brains: false, growMs: 21600000, xp: 1, level: 3 },
  "ZombieActorRegularTier1Turnips": { cost: 75, brains: false, growMs: 28800000, xp: 1, level: 3 },
  "ZombieActorRegularTier2": { cost: 45, brains: false, growMs: 14400000, xp: 1, level: 10 },
  "ZombieActorRegularTier2Broccoli": { cost: 125, brains: false, growMs: 36000000, xp: 1, level: 15 },
  "ZombieActorRegularTier2Cauliflower": { cost: 140, brains: false, growMs: 36000000, xp: 1, level: 18 },
  "ZombieActorRegularTier2Celery": { cost: 100, brains: false, growMs: 36000000, xp: 1, level: 12 },
  "ZombieActorRegularTier2Garlic": { cost: 105, brains: false, growMs: 36000000, xp: 1, level: 16 },
  "ZombieActorRegularTier2LimaBeans": { cost: 165, brains: false, growMs: 36000000, xp: 1, level: 20 },
  "ZombieActorRegularTier3": { cost: 50, brains: false, growMs: 14400000, xp: 1, level: 18 },
  "ZombieActorRegularTier3DragonFruit": { cost: 190, brains: false, growMs: 43200000, xp: 1, level: 24 },
  "ZombieActorRegularTier3VenusFlytrap": { cost: 150, brains: false, growMs: 43200000, xp: 1, level: 22 },
  "ZombieActorRegularTier4": { cost: 70, brains: false, growMs: 14400000, xp: 1, level: 30 },
  "ZombieActorRegularTier4Eyebiscus": { cost: 200, brains: false, growMs: 21600000, xp: 1, level: 42 },
  "ZombieActorRegularTier4Heartichoke": { cost: 250, brains: false, growMs: 21600000, xp: 1, level: 44 },
  "ZombieActorRegularTier5": { cost: 5, brains: true, growMs: 14400000, xp: 2, level: 15 },
  "ZombieActorSmallTier1": { cost: 55, brains: false, growMs: 300000, xp: 1, level: 4 },
  "ZombieActorSmallTier2": { cost: 70, brains: false, growMs: 600000, xp: 1, level: 8 },
  "ZombieActorSmallTier3": { cost: 80, brains: false, growMs: 600000, xp: 1, level: 15 },
  "ZombieActorSmallTier4": { cost: 110, brains: false, growMs: 600000, xp: 1, level: 27 },
  "ZombieActorSmallTier5": { cost: 5, brains: true, growMs: 600000, xp: 1, level: 1 },
};

/** Generated at module load from the shared catalog so hidden voucher zombies and
 * event rewards can never drift back into the server's plantable crop surface. */
export const ZOMBIE_CROPS: Readonly<Record<string, ZombieCropEcon>> = Object.fromEntries(
  (zombieRows as Array<{
    key: string; cost: number; brainsNeeded?: boolean; growMs: number; xp: number;
    level: number; rewardOnly?: boolean; marketHidden?: boolean;
  }>)
    .filter((zombie) => !zombie.rewardOnly && !zombie.marketHidden)
    .map((zombie) => [zombie.key, {
      cost: zombie.cost, brains: !!zombie.brainsNeeded, growMs: zombie.growMs,
      xp: zombie.xp, level: zombie.level,
    }])
);

// Keep the old literal checked by TypeScript while transitioning generated data;
// it also documents the original core economy in source review.
void LEGACY_ZOMBIE_CROPS;

export function zombieCropEcon(key: string): ZombieCropEcon | undefined {
  return Object.prototype.hasOwnProperty.call(ZOMBIE_CROPS, key) ? ZOMBIE_CROPS[key] : undefined;
}
