import { EPIC_QUEST_ZOMBIE_REWARDS } from "../../src/epicBoss/rewards";
import zombieRows from "../../public/assets/zombies.json";
import {
  BLACK_MARKET_CLASS_FILTERS,
  BLACK_MARKET_GROUP_FILTERS,
  type BlackMarketFilterOption,
} from "../../src/blackMarketRules";
import { OBJECTS } from "./objectCatalog";
import { applyBodyTypeRestriction } from "../../src/zombie/mutations";
import { upgradeVariantMutations } from "../../src/zombie/variantMutations";

// Server-side zombie catalog. Mirrors the `cost` of each unit in
// public/assets/zombies.json so the server can price a SELL exactly (sell = the
// client's zombieSellValue and validate that a granted unit
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
export const ZOMBIE_BRAINS: Readonly<Record<string, boolean>> = Object.fromEntries(
  (zombieRows as Array<{ key: string; brainsNeeded?: boolean }>).map((zombie) => [zombie.key, !!zombie.brainsNeeded])
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

const HEADLESS_ZOMBIES = new Set(
  (zombieRows as Array<{ key: string; group?: string }>)
    .filter((zombie) => zombie.group === "Headless")
    .map((zombie) => zombie.key)
);

/** A headless species has no head to mutate. */
/** A zombie's GROUP (Regular / Female / Small / Large / Headless / Garden). The
 *  formation defense fills one job per group, so this is what the one-per-class rule
 *  is checked against. Undefined for a key the catalog does not know. */
const ZOMBIE_GROUP = new Map(
  (zombieRows as Array<{ key: string; group?: string }>).map((zombie) => [zombie.key, zombie.group])
);

export function zombieGroup(key: string): string | undefined {
  return ZOMBIE_GROUP.get(key);
}

export function isHeadlessZombie(key: string): boolean {
  return HEADLESS_ZOMBIES.has(key);
}

/** The mutation mask a unit of `key` may legally carry ON A TRUSTED WRITE.
 *
 *  EPIC zombies never carry mutations (owner's rule, 2026-08-24). Epics are the
 *  Almanac's own Epic page — the Epic Boss event prizes, `EPIC_QUEST_ZOMBIE_REWARDS`,
 *  the same set `isRewardOnlyZombie` names. Every ORGANIC path to a mutated epic is
 *  already shut: mutations only grow on crop-grown zombies, epics are refused as
 *  Zombie Pot parents (both at start and at collect), and the Pot's promotion child
 *  is always a tier-5 Special, never an epic. This strip closes the one remaining
 *  door — a trusted write that supplies its own mask (the one-time save migration,
 *  a dev fixture) — so the rule holds structurally rather than by coincidence.
 *
 *  SPECIALS ARE NOT COVERED, deliberately: the tier-5s, the Pot promotions and the
 *  brain-market legends may all carry mutations, and a special in Pot slot 1 still
 *  inherits its partner's. Only the Epic page is exempt.
 *
 *  For everyone else: head and hair/eye bits are dropped for the headless family
 *  (a Party Zombie can't be carrot-eyed), except the Pumpking that stands in for the
 *  head it hasn't got. Everyone else keeps whatever they are given — including a
 *  Pumpking inherited in the Pot, which is the only way a zombie with a head of its
 *  own can get one (it cannot be grown on them). The headless scrub is the
 *  server-side twin of the client's makeOwned, which scrubs the same bits wherever a
 *  mask lands on a unit — both must agree or the unit's stats diverge. */
export function legalMutation(key: string, mask: number): number {
  if (isRewardOnlyZombie(key)) return 0;
  return applyBodyTypeRestriction(upgradeVariantMutations(key, mask), isHeadlessZombie(key));
}

const TRADABLE_ZOMBIES = new Set(
  (zombieRows as Array<{ key: string }>).map((zombie) => zombie.key)
);

export const BLACK_MARKET_SPECIAL_LEVEL = 20;

export interface BlackMarketPurchaseRequirement {
  minLevel?: number;
}

const BLACK_MARKET_COLOR_GRAVESTONES = {
  Blue: "gravestoneBlue",
  Red: "gravestoneRed",
  Silver: "gravestoneSilver",
} as const;

const BLACK_MARKET_REQUIREMENTS = new Map(
  (zombieRows as Array<{ key: string; category?: string; className?: string }>).map((zombie) => {
    const color = zombie.className === "Blue" || zombie.className === "Red" || zombie.className === "Silver"
      ? zombie.className
      : undefined;
    const colorLevel = color ? OBJECTS[BLACK_MARKET_COLOR_GRAVESTONES[color]].level : 0;
    const minLevel = Math.max(
      zombie.category === "special" ? BLACK_MARKET_SPECIAL_LEVEL : 0,
      colorLevel
    );
    return [zombie.key, {
      ...(minLevel > 0 ? { minLevel } : {}),
    } satisfies BlackMarketPurchaseRequirement] as const;
  })
);

/** Requirements for receiving a zombie through the Black Market. Ordinary catalog
 * level requirements intentionally do not apply. Colored classes use the level that
 * unlocks their gravestone; special zombies additionally require level 20. */
export function blackMarketPurchaseRequirement(key: string): BlackMarketPurchaseRequirement | null {
  return BLACK_MARKET_REQUIREMENTS.get(key) ?? null;
}

/** Server-owned Black Market allowlist. `marketHidden` controls visibility in the
 * ordinary crop market, while `rewardOnly` controls acquisition. Neither prevents
 * an authoritatively owned zombie from trading. */
export function isTradableZombie(key: string): boolean {
  return TRADABLE_ZOMBIES.has(key);
}

// ---- Browse filters ------------------------------------------------------
// Browsing filters by colour class and body family, but orders store only a zombie
// key, so each filter value resolves to the catalog keys carrying it. The buckets
// are derived from zombies.json once at module load; a request only ever picks a
// bucket by name, so no request value reaches SQL.

const keysByField = (
  field: "className" | "group",
  options: readonly BlackMarketFilterOption[]
): ReadonlyMap<string, readonly string[]> => {
  const rows = zombieRows as Array<{ key: string; className?: string; group?: string }>;
  return new Map(options.map((option) => {
    const wanted = new Set<string>([option.value, ...(option.also ?? [])]);
    return [option.value, rows.filter((zombie) => wanted.has(zombie[field] ?? "")).map((z) => z.key)];
  }));
};
const CLASS_FILTER_KEYS = keysByField("className", BLACK_MARKET_CLASS_FILTERS);
const GROUP_FILTER_KEYS = keysByField("group", BLACK_MARKET_GROUP_FILTERS);

/** Catalog keys selected by the browse filters. Null when neither filter narrows
 * anything (including an unrecognized value, which is ignored the same way an
 * unknown zombieKey is). An empty array means the two filters are disjoint — no
 * zombie is both — which is a real, empty result rather than "no filter". */
export function blackMarketFilterKeys(
  className: string | undefined,
  group: string | undefined
): string[] | null {
  const byClass = className ? CLASS_FILTER_KEYS.get(className) : undefined;
  const byGroup = group ? GROUP_FILTER_KEYS.get(group) : undefined;
  if (!byClass) return byGroup ? [...byGroup] : null;
  if (!byGroup) return [...byClass];
  const groupKeys = new Set(byGroup);
  return byClass.filter((key) => groupKeys.has(key));
}

// ---- Garden-zombie fertilization probability ----------------------------
// A deployed Garden zombie has a per-tier chance to fertilize a freshly-planted veggie
// crop (2x harvest). GROUND TRUTH: fertilizeChance by combat tier — t1 .04, t2 .06,
// t3/t4 .08, t5 .12 (client ZombieField.FERTILIZE_BY_TIER). The live client owns
// the roll so the farm animation is immediate; these helpers retain the shared math.
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
  if (ZOMBIE_BRAINS[key]) return Math.max(0, Math.trunc(cost)) * 1_000;
  return Math.max(1, Math.floor(cost / 2));
}

/** The mutation mask we accept on a granted/seeded unit: exactly the bits the shared
 *  catalog defines, with anything else dropped.
 *
 *  This used to be a magnitude clamp (`Math.min(0xffff, mask)`), which capped the
 *  system at 16 mutations and — worse — turned an out-of-range value into 0xffff, a
 *  mask of arbitrary *other* mutations rather than none. Intersecting against the
 *  catalog is both the tighter check and the one that never needs revisiting: it
 *  widens on its own as mutations are added (see src/zombie/mutations.ts). */
export { sanitizeMutationMask } from "../../src/zombie/mutations";
/** Max veterancy invasions we accept (plausibility bound). */
export const MAX_INVASIONS = 100_000;
