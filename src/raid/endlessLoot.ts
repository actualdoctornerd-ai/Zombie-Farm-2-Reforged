import type { EndlessLocation, EndlessMode } from "./endless";

export type EndlessBossLoot =
  | { kind: "boost"; name: string; key: string; quantity: number }
  | { kind: "item"; name: string; quantity: 1 }
  | { kind: "zombie"; name: string; key: string; quantity: 1 }
  | { kind: "brains"; name: "Brains"; quantity: number };

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

/** One main boss reward roll per tier. The ladder shifts from farm boosts at the
 *  bottom to Dice and Brain Tickets at the top. T5 is the low point for Grow (5%),
 *  with Harvest/Plow bundles at three uses. Grow usually pays ten at a time; every
 *  bundle is at least five, and higher tiers can pay fifteen or twenty. Grow returns later in larger
 *  five-use steps; ×20 is reserved for T8+. T10 is the permanent loot ceiling. */
const TABLE: Readonly<Record<number, readonly Reward[]>> = {
  1: [
    reward(30, "Insta-Harvest", "insta_harvest", 2), reward(25, "Insta-Plow", "insta_plow", 2),
    reward(20, "Insta-Grow", "insta_grow", 10), reward(10, "Invasion Voucher", "invasion_voucher"),
    reward(10, "Concentration", "concentration"), cosmetic(5),
  ],
  2: [
    reward(25, "Insta-Harvest", "insta_harvest", 3), reward(22, "Insta-Plow", "insta_plow", 3),
    reward(15, "Insta-Grow", "insta_grow", 10), reward(15, "Invasion Voucher", "invasion_voucher"),
    reward(5, "Brain Ticket", "brain_ticket"), reward(10, "Concentration", "concentration"), cosmetic(8),
  ],
  3: [
    reward(22, "Insta-Harvest", "insta_harvest", 3), reward(18, "Insta-Plow", "insta_plow", 3),
    reward(15, "Insta-Grow", "insta_grow", 10),
    reward(15, "Invasion Voucher", "invasion_voucher"), reward(10, "Brain Ticket", "brain_ticket"),
    reward(8, "Golden Dice", "golden_dice"), reward(7, "Concentration", "concentration"), cosmetic(5),
  ],
  4: [
    reward(23, "Insta-Harvest", "insta_harvest", 3), reward(18, "Insta-Plow", "insta_plow", 3),
    reward(13, "Insta-Grow", "insta_grow", 10),
    reward(15, "Invasion Voucher", "invasion_voucher"), reward(12, "Brain Ticket", "brain_ticket"),
    reward(12, "Golden Dice", "golden_dice"), reward(4, "Concentration", "concentration"), cosmetic(3),
  ],
  5: [
    reward(25, "Insta-Harvest", "insta_harvest", 3), reward(20, "Insta-Plow", "insta_plow", 3),
    reward(5, "Insta-Grow", "insta_grow", 10), reward(15, "Invasion Voucher", "invasion_voucher"),
    reward(15, "Brain Ticket", "brain_ticket"), reward(12, "Golden Dice", "golden_dice"),
    reward(5, "Concentration", "concentration"), cosmetic(3),
  ],
  6: [
    reward(18, "Insta-Harvest", "insta_harvest", 3), reward(14, "Insta-Plow", "insta_plow", 3),
    reward(9, "Insta-Grow", "insta_grow", 10),
    reward(15, "Invasion Voucher", "invasion_voucher"), reward(20, "Brain Ticket", "brain_ticket"),
    reward(18, "Golden Dice", "golden_dice"), reward(3, "Concentration", "concentration"), cosmetic(3),
  ],
  7: [
    reward(15, "Insta-Harvest", "insta_harvest", 3), reward(10, "Insta-Plow", "insta_plow", 3),
    reward(5, "Insta-Grow", "insta_grow", 10), reward(5, "Insta-Grow", "insta_grow", 15),
    reward(12, "Invasion Voucher", "invasion_voucher"), reward(22, "Brain Ticket", "brain_ticket"),
    reward(25, "Golden Dice", "golden_dice"), reward(3, "Concentration", "concentration"), cosmetic(3),
  ],
  8: [
    reward(12, "Insta-Harvest", "insta_harvest", 3), reward(9, "Insta-Plow", "insta_plow", 3),
    reward(5, "Insta-Grow", "insta_grow", 10), reward(5, "Insta-Grow", "insta_grow", 15),
    reward(5, "Insta-Grow", "insta_grow", 20), reward(10, "Invasion Voucher", "invasion_voucher"),
    reward(23, "Brain Ticket", "brain_ticket"), reward(27, "Golden Dice", "golden_dice"),
    reward(2, "Concentration", "concentration"), cosmetic(2),
  ],
  9: [
    reward(10, "Insta-Harvest", "insta_harvest", 3), reward(8, "Insta-Plow", "insta_plow", 3),
    reward(4, "Insta-Grow", "insta_grow", 10), reward(5, "Insta-Grow", "insta_grow", 15),
    reward(6, "Insta-Grow", "insta_grow", 20), reward(8, "Invasion Voucher", "invasion_voucher"),
    reward(25, "Brain Ticket", "brain_ticket"), reward(30, "Golden Dice", "golden_dice"),
    reward(2, "Concentration", "concentration"), cosmetic(2),
  ],
  10: [
    reward(8, "Insta-Harvest", "insta_harvest", 3), reward(7, "Insta-Plow", "insta_plow", 3),
    reward(4, "Insta-Grow", "insta_grow", 10), reward(5, "Insta-Grow", "insta_grow", 15),
    reward(6, "Insta-Grow", "insta_grow", 20), reward(10, "Invasion Voucher", "invasion_voucher"),
    reward(25, "Brain Ticket", "brain_ticket"), reward(30, "Golden Dice", "golden_dice"),
    reward(3, "Concentration", "concentration"), cosmetic(2),
  ],
};

/** One small roll for every ordinary floor won (owner, 2026-11-05: loot across the fights, with
 *  a bump at the bosses). Smaller bundles than the same tier's boss roll, no cosmetics and no
 *  Zwamp Thing, which stay boss prizes. Tickets and Dice only start once a run is under way. */
const FLOOR_TABLE: readonly { fromTier: number; rewards: readonly Reward[] }[] = [
  { fromTier: 7, rewards: [
    reward(15, "Insta-Harvest", "insta_harvest", 3), reward(15, "Insta-Plow", "insta_plow", 3),
    reward(30, "Insta-Grow", "insta_grow", 10), reward(15, "Invasion Voucher", "invasion_voucher"),
    reward(5, "Concentration", "concentration"), reward(10, "Brain Ticket", "brain_ticket"),
    reward(10, "Golden Dice", "golden_dice"),
  ] },
  { fromTier: 5, rewards: [
    reward(25, "Insta-Harvest", "insta_harvest", 2), reward(20, "Insta-Plow", "insta_plow", 2),
    reward(25, "Insta-Grow", "insta_grow", 10), reward(12, "Invasion Voucher", "invasion_voucher"),
    reward(8, "Concentration", "concentration"), reward(5, "Brain Ticket", "brain_ticket"),
    reward(5, "Golden Dice", "golden_dice"),
  ] },
  { fromTier: 3, rewards: [
    reward(30, "Insta-Harvest", "insta_harvest", 2), reward(25, "Insta-Plow", "insta_plow", 2),
    reward(25, "Insta-Grow", "insta_grow", 5), reward(10, "Invasion Voucher", "invasion_voucher"),
    reward(7, "Concentration", "concentration"), reward(3, "Brain Ticket", "brain_ticket"),
  ] },
  { fromTier: 1, rewards: [
    reward(35, "Insta-Harvest", "insta_harvest", 1), reward(30, "Insta-Plow", "insta_plow", 1),
    reward(25, "Insta-Grow", "insta_grow", 5), reward(5, "Invasion Voucher", "invasion_voucher"),
    reward(5, "Concentration", "concentration"),
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
): EndlessBossLoot[] {
  const rewardTier = Math.max(1, Math.min(10, Math.floor(tier)));
  const rewards = TABLE[rewardTier];
  const r = Math.max(0, Math.min(0.999999999, roll)) * 100;
  let cumulative = 0;
  const selected = rewards.find((entry) => (cumulative += entry.weight) > r) ?? rewards[rewards.length - 1];
  const main: EndlessBossLoot = selected.key
    ? { kind: "boost", name: selected.name, key: selected.key, quantity: selected.quantity }
    : { kind: "item", name: AREA_COSMETICS[location][Math.floor(Math.max(0, Math.min(0.999999999, pick)) * AREA_COSMETICS[location].length)], quantity: 1 };

  // Rising odds from T3, on top of the first T3 clear's guaranteed one (a milestone), then one
  // guaranteed per boss from T7 with a chance of a second: about 1.5 across a full T7 run.
  const swampOdds = tier >= 7 ? 0.25 : tier >= 3 ? 0.05 * (tier - 2) : 0;
  const extraZwamp = swampRoll < swampOdds;
  const guaranteedZwamp = tier >= 7;
  return [
    main,
    ...(extraZwamp ? [ZWAMP_THING] : []),
    ...(guaranteedZwamp ? [ZWAMP_THING] : []),
  ];
}

const ZWAMP_THING: EndlessBossLoot = { kind: "zombie", name: "Zwamp Thing", key: "ZombieActorZwampThing", quantity: 1 };
const MEDUSA: EndlessBossLoot = { kind: "zombie", name: "Medusa Zombie", key: "ZombieActorMedusa", quantity: 1 };

/** What a tier pays the FIRST time an account beats its boss in a mode, on top of that fight's
 *  loot. See docs/ENDLESS_MODE_REWARDS.md: T4-T7's capacity and farm prizes are not built. */
export function endlessMilestoneRewards(mode: EndlessMode, tier: number): EndlessBossLoot[] {
  const rewards: EndlessBossLoot[] = [];
  if (tier === 1) rewards.push({ kind: "boost", name: "Brain Ticket", key: "brain_ticket", quantity: 2 });
  if (tier === 2) rewards.push({ kind: "brains", name: "Brains", quantity: 1 });
  if (tier === 3) rewards.push(ZWAMP_THING);
  if (tier === 5 && mode === "nightmare") rewards.push(MEDUSA);
  if (tier >= 8) rewards.push({ kind: "brains", name: "Brains", quantity: 3 });
  return rewards;
}
