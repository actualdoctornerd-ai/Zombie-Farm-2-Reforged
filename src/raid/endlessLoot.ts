import type { EndlessLocation, EndlessMode } from "./endless";
import {
  ALIENS_RAID_ID, NINJAS_RAID_ID, OLD_MC_ZOMBIE_RAID_ID, PIRATES_RAID_ID, VIDEO_GAMES_RAID_ID,
  pickRaidZombie, RAID_ELITE_ZOMBIE_DROPS, RAID_ZOMBIE_DROPS,
} from "./zombieDrops";
import { ENDLESS_CRYPT_SLOTS, ENDLESS_EXPANSION_SIZE, ENDLESS_PERK_TIER, ENDLESS_SHED_SLOTS, endlessVictoryBrains } from "./endlessPerks";

export type EndlessBossLoot =
  | { kind: "boost"; name: string; key: string; quantity: number }
  | { kind: "item"; name: string; quantity: 1 }
  | { kind: "zombie"; name: string; key: string; quantity: 1 }
  | { kind: "brains"; name: "Brains"; quantity: number }
  /** A permanent unlock (raid/endlessPerks.ts). Paying it is recording the cleared tier on
   *  the account, which the caps, the Market and the fights all read. */
  | { kind: "perk"; name: string; perk: "crypt" | "shed" | "expansion" | "veterancy"; quantity: 1 };

type Reward = { weight: number; name: string; key?: string; quantity: number };
const AREA_COSMETICS: Readonly<Record<EndlessLocation, readonly string[]>> = {
  farm: ["Haystack", "Scarecrow", "Windmill", "Farmer Banner"],
  ninja: ["Bamboo", "Double Rainbow", "Taiko Drum", "Ninja Banner"],
  alien: ["Crashed UFO", "Pyramid", "Satellite Dish", "Alien Banner"],
  "video-game": ["Pixel Block", "Pixel Campfire", "Pixel Tower", "Pixel Banner"],
  pirate: ["Treasure Chest", "Gallows", "Parrot", "Pirate Banner"],
};

const reward = (weight: number, name: string, key: string, quantity = 1): Reward =>
  ({ weight, name, key, quantity });
const cosmetic = (weight: number): Reward => ({ weight, name: "area-cosmetic", quantity: 1 });

/** One main boss reward roll per tier. Each row's weights sum to 100. The ladder shifts from
 *  farm boosts at the bottom to Dice and Brain Tickets at the top. T5 is the low point for Grow,
 *  with Harvest/Plow bundles at three uses. Grow usually pays ten at a time; every bundle is at
 *  least five, and higher tiers can pay fifteen or twenty (x20 is T8+). T10 is the ceiling.
 *
 *  Retuned 2026-11-08 (owner): Golden Dice doubled (twice the weight to T4, two at a time from
 *  T5), Harvest/Plow a little lower, Grow a little higher. */
const TABLE: Readonly<Record<number, readonly Reward[]>> = {
  1: [
    reward(26, "Insta-Harvest", "insta_harvest", 2), reward(22, "Insta-Plow", "insta_plow", 2),
    reward(27, "Insta-Grow", "insta_grow", 10), reward(10, "Invasion Voucher", "invasion_voucher"),
    reward(10, "Concentration", "concentration"), cosmetic(5),
  ],
  2: [
    reward(22, "Insta-Harvest", "insta_harvest", 3), reward(20, "Insta-Plow", "insta_plow", 3),
    reward(20, "Insta-Grow", "insta_grow", 10), reward(15, "Invasion Voucher", "invasion_voucher"),
    reward(5, "Brain Ticket", "brain_ticket"), reward(10, "Concentration", "concentration"), cosmetic(8),
  ],
  3: [
    reward(17, "Insta-Harvest", "insta_harvest", 3), reward(14, "Insta-Plow", "insta_plow", 3),
    reward(17, "Insta-Grow", "insta_grow", 10),
    reward(15, "Invasion Voucher", "invasion_voucher"), reward(10, "Brain Ticket", "brain_ticket"),
    reward(16, "Golden Dice", "golden_dice"), reward(6, "Concentration", "concentration"), cosmetic(5),
  ],
  4: [
    reward(16, "Insta-Harvest", "insta_harvest", 3), reward(13, "Insta-Plow", "insta_plow", 3),
    reward(16, "Insta-Grow", "insta_grow", 10),
    reward(13, "Invasion Voucher", "invasion_voucher"), reward(12, "Brain Ticket", "brain_ticket"),
    reward(24, "Golden Dice", "golden_dice"), reward(3, "Concentration", "concentration"), cosmetic(3),
  ],
  5: [
    reward(22, "Insta-Harvest", "insta_harvest", 3), reward(17, "Insta-Plow", "insta_plow", 3),
    reward(9, "Insta-Grow", "insta_grow", 10), reward(17, "Invasion Voucher", "invasion_voucher"),
    reward(15, "Brain Ticket", "brain_ticket"), reward(12, "Golden Dice", "golden_dice", 2),
    reward(5, "Concentration", "concentration"), cosmetic(3),
  ],
  6: [
    reward(14, "Insta-Harvest", "insta_harvest", 3), reward(11, "Insta-Plow", "insta_plow", 3),
    reward(12, "Insta-Grow", "insta_grow", 10),
    reward(18, "Invasion Voucher", "invasion_voucher"), reward(20, "Brain Ticket", "brain_ticket"),
    reward(18, "Golden Dice", "golden_dice", 2), reward(4, "Concentration", "concentration"), cosmetic(3),
  ],
  7: [
    reward(12, "Insta-Harvest", "insta_harvest", 3), reward(8, "Insta-Plow", "insta_plow", 3),
    reward(5, "Insta-Grow", "insta_grow", 10), reward(7, "Insta-Grow", "insta_grow", 15),
    reward(15, "Invasion Voucher", "invasion_voucher"), reward(22, "Brain Ticket", "brain_ticket"),
    reward(25, "Golden Dice", "golden_dice", 2), reward(3, "Concentration", "concentration"), cosmetic(3),
  ],
  8: [
    reward(9, "Insta-Harvest", "insta_harvest", 3), reward(7, "Insta-Plow", "insta_plow", 3),
    reward(5, "Insta-Grow", "insta_grow", 10), reward(6, "Insta-Grow", "insta_grow", 15),
    reward(6, "Insta-Grow", "insta_grow", 20), reward(13, "Invasion Voucher", "invasion_voucher"),
    reward(23, "Brain Ticket", "brain_ticket"), reward(27, "Golden Dice", "golden_dice", 2),
    reward(2, "Concentration", "concentration"), cosmetic(2),
  ],
  9: [
    reward(8, "Insta-Harvest", "insta_harvest", 3), reward(6, "Insta-Plow", "insta_plow", 3),
    reward(4, "Insta-Grow", "insta_grow", 10), reward(6, "Insta-Grow", "insta_grow", 15),
    reward(7, "Insta-Grow", "insta_grow", 20), reward(9, "Invasion Voucher", "invasion_voucher"),
    reward(25, "Brain Ticket", "brain_ticket"), reward(30, "Golden Dice", "golden_dice", 2),
    reward(3, "Concentration", "concentration"), cosmetic(2),
  ],
  10: [
    reward(6, "Insta-Harvest", "insta_harvest", 3), reward(5, "Insta-Plow", "insta_plow", 3),
    reward(4, "Insta-Grow", "insta_grow", 10), reward(6, "Insta-Grow", "insta_grow", 15),
    reward(7, "Insta-Grow", "insta_grow", 20), reward(12, "Invasion Voucher", "invasion_voucher"),
    reward(25, "Brain Ticket", "brain_ticket"), reward(30, "Golden Dice", "golden_dice", 2),
    reward(3, "Concentration", "concentration"), cosmetic(2),
  ],
};

/** One small roll for every ordinary floor won (owner, 2026-11-05: loot across the fights, with
 *  a bump at the bosses). Smaller bundles than the same tier's boss roll, no cosmetics and no
 *  Zwamp Thing, which stay boss prizes. Tickets and Dice only start once a run is under way.
 *  Weights sum to 100; retuned with the boss table (2026-11-08). */
const FLOOR_TABLE: readonly { fromTier: number; rewards: readonly Reward[] }[] = [
  { fromTier: 7, rewards: [
    reward(12, "Insta-Harvest", "insta_harvest", 3), reward(12, "Insta-Plow", "insta_plow", 3),
    reward(33, "Insta-Grow", "insta_grow", 10), reward(18, "Invasion Voucher", "invasion_voucher"),
    reward(5, "Concentration", "concentration"), reward(10, "Brain Ticket", "brain_ticket"),
    reward(10, "Golden Dice", "golden_dice", 2),
  ] },
  { fromTier: 5, rewards: [
    reward(21, "Insta-Harvest", "insta_harvest", 2), reward(17, "Insta-Plow", "insta_plow", 2),
    reward(27, "Insta-Grow", "insta_grow", 10), reward(12, "Invasion Voucher", "invasion_voucher"),
    reward(8, "Concentration", "concentration"), reward(5, "Brain Ticket", "brain_ticket"),
    reward(10, "Golden Dice", "golden_dice"),
  ] },
  { fromTier: 3, rewards: [
    reward(27, "Insta-Harvest", "insta_harvest", 2), reward(22, "Insta-Plow", "insta_plow", 2),
    reward(28, "Insta-Grow", "insta_grow", 5), reward(13, "Invasion Voucher", "invasion_voucher"),
    reward(7, "Concentration", "concentration"), reward(3, "Brain Ticket", "brain_ticket"),
  ] },
  { fromTier: 1, rewards: [
    reward(31, "Insta-Harvest", "insta_harvest", 1), reward(26, "Insta-Plow", "insta_plow", 1),
    reward(29, "Insta-Grow", "insta_grow", 5), reward(7, "Invasion Voucher", "invasion_voucher"),
    reward(7, "Concentration", "concentration"),
  ] },
];

/** Server-authoritative floor reward. `tier` is the four-fight section being played (1-based). */
export function rollEndlessFloorLoot(tier: number, roll: number): EndlessBossLoot {
  const rewards = FLOOR_TABLE.find((band) => tier >= band.fromTier)?.rewards ?? FLOOR_TABLE[FLOOR_TABLE.length - 1].rewards;
  const r = Math.max(0, Math.min(0.999999999, roll)) * 100;
  let cumulative = 0;
  const selected = rewards.find((entry) => (cumulative += entry.weight) > r) ?? rewards[rewards.length - 1];
  return { kind: "boost", name: selected.name, key: selected.key!, quantity: selected.quantity };
}

/** Server-authoritative boss reward. T10 and every later tier use the same table row. */
export function rollEndlessBossLoot(
  tier: number,
  location: EndlessLocation,
  roll: number,
  pick: number,
  swampRoll: number,
  /** Zwamp Things this run has already paid (milestones included): T7 guarantees the first. */
  zwampsSoFar = 0,
): EndlessBossLoot[] {
  const rewardTier = Math.max(1, Math.min(10, Math.floor(tier)));
  const rewards = TABLE[rewardTier];
  const r = Math.max(0, Math.min(0.999999999, roll)) * 100;
  let cumulative = 0;
  const selected = rewards.find((entry) => (cumulative += entry.weight) > r) ?? rewards[rewards.length - 1];
  const main: EndlessBossLoot = selected.key
    ? { kind: "boost", name: selected.name, key: selected.key, quantity: selected.quantity }
    : { kind: "item", name: AREA_COSMETICS[location][Math.floor(Math.max(0, Math.min(0.999999999, pick)) * AREA_COSMETICS[location].length)], quantity: 1 };

  return [main, ...(endlessZwampDrops(tier, swampRoll, zwampsSoFar) ? [ZWAMP_THING] : [])];
}

/** Zwamp Thing's chance at each boss from T3 (owner, 2026-11-08): small and rising to T7, where
 *  a run that has not had one yet is given one; one at every boss from T8, the stretch tier. A
 *  repeat run through T8 averages about two (endlessExpectedZwamps). The first T3 clear's
 *  milestone one comes on top, and counts toward the T7 guarantee. */
export const ENDLESS_ZWAMP_ODDS: Readonly<Record<number, number>> = { 3: 0.05, 4: 0.075, 5: 0.1, 6: 0.125, 7: 0.15 };
export const ENDLESS_ZWAMP_PITY_TIER = 7;
export const ENDLESS_ZWAMP_SURE_TIER = 8;
export function endlessZwampDrops(tier: number, swampRoll: number, zwampsSoFar: number): boolean {
  if (tier >= ENDLESS_ZWAMP_SURE_TIER) return true;
  if (tier === ENDLESS_ZWAMP_PITY_TIER && zwampsSoFar <= 0) return true;
  return swampRoll < (ENDLESS_ZWAMP_ODDS[tier] ?? 0);
}

/** The story invasion each Endless location stands in for, for its rare zombies. */
export const ENDLESS_LOCATION_RAID: Readonly<Record<EndlessLocation, number>> = {
  farm: OLD_MC_ZOMBIE_RAID_ID, ninja: NINJAS_RAID_ID, alien: ALIENS_RAID_ID,
  "video-game": VIDEO_GAMES_RAID_ID, pirate: PIRATES_RAID_ID,
};
/** Of a location's rare zombies, the ordinary prize comes this share of the time and the
 *  promoted (elite) one the rest: the rarer of the two, as its rank says. */
export const ENDLESS_ORDINARY_PRIZE_SHARE = 2 / 3;

/** A location's own rare zombies (owner, 2026-11-08): every normal-Endless win there rolls
 *  once, at that invasion's ordinary rate (Pirates 1.4%, Ninjas 1.6%, Aliens and Video Games
 *  2%, the Farm 1%), and a hit pays either of its prizes: the Pirate Ship a MerZombie or a
 *  Poseidon. The Farm has only Old McZombie; the Video Game Boss Zombie keeps its colour split. */
export function rollEndlessLocationZombie(location: EndlessLocation, roll: number, pick: number): EndlessBossLoot | null {
  const raidId = ENDLESS_LOCATION_RAID[location];
  const ordinary = RAID_ZOMBIE_DROPS[raidId];
  if (!ordinary || !(roll < ordinary.rate)) return null;
  const promoted = RAID_ELITE_ZOMBIE_DROPS[raidId];
  const p = Math.max(0, Math.min(0.999999999, pick));
  const prize = promoted && p >= ENDLESS_ORDINARY_PRIZE_SHARE
    ? pickRaidZombie(promoted, (p - ENDLESS_ORDINARY_PRIZE_SHARE) / (1 - ENDLESS_ORDINARY_PRIZE_SHARE))
    : pickRaidZombie(ordinary, promoted ? p / ENDLESS_ORDINARY_PRIZE_SHARE : p);
  return { kind: "zombie", name: prize.name, key: prize.key, quantity: 1 };
}

/** A loot row's total weight; every row is written to sum to 100 (the roll is a percentage). */
export function endlessLootWeightTotal(kind: "boss" | "floor", tier: number): number {
  const rows = kind === "boss"
    ? TABLE[Math.max(1, Math.min(10, tier))]
    : (FLOOR_TABLE.find((band) => tier >= band.fromTier) ?? FLOOR_TABLE[FLOOR_TABLE.length - 1]).rewards;
  return rows.reduce((total, row) => total + row.weight, 0);
}

/** The expected Zwamp Things of a repeat run clearing `tiers` (no milestone). */
export function endlessExpectedZwamps(tiers: number): number {
  let expected = 0;
  let noneYet = 1;
  for (let tier = 1; tier <= tiers; tier++) {
    const odds = ENDLESS_ZWAMP_ODDS[tier] ?? 0;
    if (tier >= ENDLESS_ZWAMP_SURE_TIER) { expected += 1; noneYet = 0; }
    else if (tier === ENDLESS_ZWAMP_PITY_TIER) { expected += noneYet + (1 - noneYet) * odds; noneYet = 0; }
    else { expected += odds; noneYet *= 1 - odds; }
  }
  return expected;
}

const ZWAMP_THING: EndlessBossLoot = { kind: "zombie", name: "Zwamp Thing", key: "ZombieActorZwampThing", quantity: 1 };
const MEDUSA: EndlessBossLoot = { kind: "zombie", name: "Medusa Zombie", key: "ZombieActorMedusa", quantity: 1 };

/** What a tier pays the FIRST time an account beats its boss in a mode, on top of that fight's
 *  loot (docs/ENDLESS_MODE_REWARDS.md). T5-T8 are permanent unlocks, and every tier past T8
 *  adds +16 shed slots the first time it falls. */
export function endlessMilestoneRewards(mode: EndlessMode, tier: number): EndlessBossLoot[] {
  const rewards: EndlessBossLoot[] = [];
  if (tier === 1) rewards.push({ kind: "boost", name: "Brain Ticket", key: "brain_ticket", quantity: 2 });
  if (tier === 2) rewards.push({ kind: "brains", name: "Brains", quantity: 1 });
  if (tier === 3) rewards.push(ZWAMP_THING);
  if (tier === 4) rewards.push({ kind: "brains", name: "Brains", quantity: 3 });
  if (tier === 5 && mode === "nightmare") rewards.push(MEDUSA);
  if (mode === "endless") {
    if (tier === ENDLESS_PERK_TIER.crypt) rewards.push({ kind: "perk", perk: "crypt", name: `+${ENDLESS_CRYPT_SLOTS} Mausoleum Slots`, quantity: 1 });
    if (tier === ENDLESS_PERK_TIER.shed) rewards.push({ kind: "perk", perk: "shed", name: `+${ENDLESS_SHED_SLOTS} Shed Slots`, quantity: 1 });
    if (tier === ENDLESS_PERK_TIER.expansion) rewards.push({ kind: "perk", perk: "expansion", name: `${ENDLESS_EXPANSION_SIZE}×${ENDLESS_EXPANSION_SIZE} Farm Unlocked`, quantity: 1 });
    if (tier === ENDLESS_PERK_TIER.veterancy) rewards.push({ kind: "perk", perk: "veterancy", name: "Legend Veterancy", quantity: 1 });
    // Every new deepest tier past T8: another +16 shed slots (endlessPerksFor counts them).
    if (tier > ENDLESS_PERK_TIER.veterancy) rewards.push({ kind: "perk", perk: "shed", name: `+${ENDLESS_SHED_SLOTS} Shed Slots`, quantity: 1 });
  }
  return rewards;
}

/** What a boss win at `tier` may pay on top of its loot table. Nothing since 2026-11-08: the
 *  T9+ brains became shed slots on each first clear (endlessMilestoneRewards). */
export const ENDLESS_VICTORY_BRAIN_CHANCE = 0.4;
export function endlessVictoryRewards(mode: EndlessMode, tier: number, roll: number): EndlessBossLoot[] {
  const brains = mode === "endless" && roll < ENDLESS_VICTORY_BRAIN_CHANCE ? endlessVictoryBrains(tier) : 0;
  return brains > 0 ? [{ kind: "brains", name: "Brains", quantity: brains }] : [];
}
