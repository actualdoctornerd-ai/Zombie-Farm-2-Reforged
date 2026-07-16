import { EPIC_QUEST_ZOMBIE_REWARDS } from "../../src/epicBoss/rewards";
import zombieRows from "../../public/assets/zombies.json";

// Server-side zombie catalog. Mirrors the `cost` of each unit in
// public/assets/zombies.json so the server can price a SELL exactly (sell = the
// client's zombieSellValue = max(1, floor(cost/2))) and validate that a granted unit
// is a real catalog zombie. A unit's stats aren't needed here — the roster records
// only id/key/mutation/invasions, and stats derive from the key on the client.
//
// KEEP IN SYNC with zombies.json (plantable crops plus reward-only roster units).

const LEGACY_ZOMBIE_COST: Readonly<Record<string, number>> = {
  ZombieActorRegularTier1: 35,
  ZombieActorGardenTier3GreenFlower: 50,
  ZombieActorGardenTier5: 50,
  ZombieActorLarge2Tier5: 50,
  ZombieActorLarge3Tier5: 50,
  ZombieActorSmallTier5: 50,
  ZombieActorGirlTier5: 50,
  ZombieActorHeadlessTier5: 50,
  ZombieActorHeadless2Tier5: 50,
  ZombieActorRegular2Tier5: 50,
  ZombieActorRegular3Tier5: 50,
  ZombieActorRegular4Tier5: 50,
  ZombieActorHeadlessTier1: 40,
  ZombieActorGirlTier1: 45,
  ZombieActorRegularTier1Carrots: 55,
  ZombieActorRegularTier1Tomatoes: 60,
  ZombieActorRegularTier1Onions: 70,
  ZombieActorRegularTier1Turnips: 75,
  ZombieActorSmallTier1: 55,
  ZombieActorLargeTier1: 80,
  ZombieActorRegularTier1Potatoes: 90,
  ZombieActorGardenTier1: 150,
  ZombieActorSmallTier2: 70,
  ZombieActorGirlTier2: 55,
  ZombieActorRegularTier1Coffee: 70,
  ZombieActorRegularTier2: 45,
  ZombieActorHeadlessTier2: 50,
  ZombieActorLargeTier2: 100,
  ZombieActorRegularTier2Celery: 100,
  ZombieActorGardenTier2: 190,
  ZombieActorRegularTier5: 50,
  ZombieActorSmallTier3: 80,
  ZombieActorRegularTier2Broccoli: 125,
  ZombieActorGirlTier3: 70,
  ZombieActorRegularTier2Garlic: 105,
  ZombieActorHeadlessTier3: 60,
  ZombieActorRegularTier3: 50,
  ZombieActorRegularTier2Cauliflower: 140,
  ZombieActorLargeTier3: 120,
  ZombieActorLargeTier5: 50,
  ZombieActorGardenCupid: 100,
  ZombieActorRegularCrazy: 100,
  ZombieActorRegularTier2LimaBeans: 165,
  ZombieActorGardenTier3: 225,
  ZombieActorRegularTier3VenusFlytrap: 150,
  ZombieActorRegularTier3DragonFruit: 190,
  ZombieActorGardenCupidPink: 0,
  ZombieActorGardenTier4: 300,
  ZombieActorLargeTier4: 160,
  ZombieActorSmallTier4: 110,
  ZombieActorGirlTier4: 90,
  ZombieActorHeadlessTier4: 80,
  ZombieActorRegularTier4: 70,
  ZombieActorRegularTier4Eyebiscus: 200,
  ZombieActorRegularTier4Heartichoke: 250,
  // Epic-event quest rewards retain their source sell values but are deliberately
  // absent from ZOMBIE_CROPS, so no purchase/plant command can create them.
  ZombieActorDrZombie: 200,
  ZombieActorOmegaDrZombie: 400,
  ZombieActorBandido: 200,
  ZombieActorVagabond: 400,
  ZombieActorCaptain: 200,
  ZombieActorAdmiral: 400,
  ZombieActorChristmasGhost: 200,
  ZombieActorScrooge: 400,
  ZombieActorDiva: 200,
};

export const ZOMBIE_COST: Readonly<Record<string, number>> = Object.fromEntries(
  (zombieRows as Array<{ key: string; cost: number }>).map((zombie) => [zombie.key, zombie.cost])
);
void LEGACY_ZOMBIE_COST;

/** Whether `key` is a real catalog zombie (a granted unit must be one). */
export function isKnownZombie(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ZOMBIE_COST, key);
}

const REWARD_ONLY_ZOMBIES = new Set(Object.values(EPIC_QUEST_ZOMBIE_REWARDS));

export function isRewardOnlyZombie(key: string): boolean {
  return REWARD_ONLY_ZOMBIES.has(key);
}

// ---- Garden-zombie fertilization (server-owned roll) --------------------
// A deployed Garden zombie has a per-tier chance to fertilize a freshly-planted veggie
// crop (2x harvest). GROUND TRUTH: fertilizeChance by combat tier — t1 .04, t2 .06,
// t3/t4 .08, t5 .12 (client ZombieField.FERTILIZE_BY_TIER). The server owns the roll
// so a modified client can't force fertilization.
const GARDEN_TIER: Readonly<Record<string, number>> = {
  ZombieActorGardenTier1: 1,
  ZombieActorGardenTier2: 2,
  ZombieActorGardenTier3: 3,
  ZombieActorGardenTier3GreenFlower: 3,
  ZombieActorGardenTier4: 4,
  ZombieActorGardenTier5: 5,
  ZombieActorGardenCupid: 5,
  ZombieActorGardenCupidPink: 5,
};
const FERTILIZE_BY_TIER: Readonly<Record<number, number>> = { 1: 0.04, 2: 0.06, 3: 0.08, 4: 0.08, 5: 0.12 };

/** A single Garden zombie's fertilize chance (0 for non-Garden keys). */
export function gardenChance(key: string): number {
  const tier = GARDEN_TIER[key];
  return tier ? (FERTILIZE_BY_TIER[tier] ?? 0) : 0;
}

/** The probability that AT LEAST ONE of a player's Garden zombies fertilizes a crop —
 *  1 - Π(1 - chance_i), matching the client's "each rolls, first success wins". */
export function fertilizeProbability(keys: string[]): number {
  let miss = 1;
  for (const k of keys) miss *= 1 - gardenChance(k);
  return 1 - miss;
}

/** Gold a unit sells for, mirroring the client's zombieSellValue. */
export function zombieSell(key: string): number {
  const cost = ZOMBIE_COST[key] ?? 0;
  return Math.max(1, Math.floor(cost / 2));
}

/** Max mutation bitmask we accept on a granted/seeded unit (mutations.ts uses a small
 *  bitfield; this is a generous plausibility bound, not the exact legal set). */
export const MAX_MUTATION = 0xffff;
/** Max veterancy invasions we accept (plausibility bound). */
export const MAX_INVASIONS = 100_000;
