// What a prize you can never buy is worth when sold.
//
// All three families here are AWARDED, never purchased, so every one of them carries
// `cost: 0` in the catalog (a free item must not refund a price nobody paid — see
// objectRefund). The side effect was that a signature trophy off the rarest tier of
// the hardest invasion, or an Epic Boss's forty-brain showpiece, sold for the game's
// one-gold minimum. These tables give them a real number.
//
// AUTHORED, not derived. The three families use different rules because they are
// earned differently — see each table. Between them they must cover EVERY award-only
// placeable: `cost: 0` plus no entry here is the one-gold floor, which is the bug
// each table exists to close. Guarded by server/test/awardSellValue.test.ts.
//
// A prize that is ALSO a Market item is deliberately absent from both: it already has
// a price, and its sell-back is the ordinary SELL_BACK_RATIO of that price.
//
// KEEP IN SYNC with server/src/objectCatalog.ts (which imports this file).

/** Invasion loot. Shape follows each raid's own priced siblings and its tier ladder
 *  (tier 1 common … tier 5 rarest): a common drop sells at or below the raid's other
 *  tier-1/2 loot, tier 3 sits between, and the rare tier-4/5 signature pieces sell for
 *  MORE than anything else that invasion drops. Raids with no priced drops at all
 *  (Robots, Summer Break, Circus, Video Games, Tree World) are anchored to the raid's
 *  recommended level instead, so a level-43 invasion pays better than a level-8 one. */
export const RAID_DROP_SELL: Readonly<Record<string, number>> = {
  // --- 1 · Old McDonnell's Farm (rec 5; Haystack 500, Scarecrow 2,400) --------
  oldMcDonnellBanner: 900,
  windmill: 3_000,

  // --- 2 · Zombies vs Lawyers (rec 16; Zombie Sign 1,000, Street Light 600) ---
  corporatevilleBanner: 900,
  monument: 2_500,

  // --- 3 · Zombies vs Pirates (rec 21; Treasure Chest 1,000, Gallows 2,000) ---
  pirateBanner: 1_200,
  parrot: 3_000,

  // --- 4 · Zombies vs Ninjas (rec 26; Bamboo 2,260, Double Rainbow 2,000) -----
  ninjaBanner: 1_800,
  taikoDrum: 3_500,

  // --- 5 · Zombies vs Robots (rec 31; nothing priced) ------------------------
  hazardFence: 1_000,
  robotBanner: 1_800,
  brokenTractor: 1_800,
  toxicDrum: 2_400,
  mechanicalBull: 3_600,

  // --- 6 · Zombies vs Aliens (rec 36; Bike 2,000, Pyramid 40,000) ------------
  // The Pyramid is a 200,000-gold Market showpiece that happens to sit on this
  // table; it is an outlier, not the raid's rate. The Dish is priced above the
  // raid's ordinary drops, not above that.
  alienBanner: 1_800,
  crashedUFO: 1_800,
  setiDish: 4_500,

  // --- 7 · Summer Break (rec 8) ---------------------------------------------
  sandDollar: 400,
  iceCreamStand: 900,
  rockLobster: 1_200,
  giantClamClosed: 1_800,

  // --- 8 · Zombies vs Circus (rec 12) ---------------------------------------
  circusFlagGreen: 500,
  circusFlagYellow: 500,
  circusFlagBlue: 500,
  circusTent: 1_500,
  fireRing: 2_200,

  // --- 9 · Zombies vs Video Games (rec 43) -----------------------------------
  pixelBrick: 1_500,
  pixelBrickFloating: 1_500,
  pixelBanner: 2_400,
  pixelTree: 2_400,
  pixelCampfire: 3_000,
  pixelTower: 4_500,

  // --- 10 · Tree World (rec 8) ----------------------------------------------
  treeWorldPigling: 400,
  treeWorldCobraHawk: 900,
  treeWorldMossCrab: 900,
  treeWorldPhoenix: 1_200,
  treeWorldPoppyHouse: 1_800,

  // --- 11 · Valentine's Day (rec 8; Heart Hedge / Heart Candle 1,000) --------
  teddyValentine: 1_500,
  loveShack: 2_200,
};

/** Epic Boss prizes. One flat rule, at the owner's request: a quarter of what the
 *  prize would cost in brains, converted at the game's own 1,000-gold-per-brain rate.
 *  The source sells these for 10/20/40 brains, which Reforged's brainflation retune
 *  divides by ten (1/2/4 brains) — so a prize is worth 250, 500 or 1,000 gold.
 *  Deliberately well under a straight brain conversion: these are earned by beating a
 *  limited event boss, and cashing a hoard of them in must not out-earn playing.
 *  The comment on each row is that prize's Reforged brain price. */
export const EPIC_PRIZE_SELL: Readonly<Record<string, number>> = {
  drgroundhogEvilDevice: 250, // 1b · Dr. Groundhog's Evil Device
  drgroundhogTricycle: 250, // 1b · Dr. Groundhog's Tricycle
  drgroundhogNutStash: 250, // 1b · Dr. Groundhog's Nut Stash
  drgroundhogLabShelves: 250, // 1b · Dr. Groundhog's Lab Shelves
  drgroundhogLabTable: 250, // 1b · Dr. Groundhog's Lab Table
  drgroundhogEvilLab: 1_000, // 4b · Dr. Groundhog's Lab
  drgroundhogBurrow: 1_000, // 4b · Dr. Groundhog's Burrow
  drgroundhogDistillery: 500, // 2b · Dr. Groundhog's Distillery
  cactusTarget: 250, // 1b · Loco Locust's Cactus Target
  saddle: 250, // 1b · Loco Locust's Saddle
  rockingHorse: 250, // 1b · Loco Locust's Rocking Horse
  boots: 250, // 1b · Loco Locust's Boots
  banjo: 250, // 1b · Loco Locust's Banjo
  saloon: 1_000, // 4b · Loco Locust's Saloon
  hideout: 1_000, // 4b · Loco Locust's Hideout
  gunRack: 500, // 2b · Loco Locust's Gun Rack
  lilyJukebox: 250, // 1b · Bully Frog's Lily Jukebox
  mossyCouch: 500, // 2b · Bully Frog's Mossy Couch
  toadStool: 250, // 1b · Bully Frog's Toad Stool
  muddyPool: 500, // 2b · Bully Frog's Muddy Pool
  carnivorousPlants: 1_000, // 4b · Bully Frog's Carnivorous Plants
  fireflies: 250, // 1b · Bully Frog's Fireflies
  swamp_Cabin: 1_000, // 4b · Bully Frog's Swamp Cabin
  squirmyWorms: 250, // 1b · Bully Frog's Squirmy Worms
  snowFarmhand: 250, // 1b · Farmhand Snowman
  snowLumberjack: 250, // 1b · Lumberjack Snowman
  snowOlMcDonnell: 250, // 1b · Boss Farmer Snowman
  snowZombie: 250, // 1b · Zombie Snowman
  snowOwl: 1_000, // 4b · Foul Owl's Colossal Snowman
  antiHolidayIncinerator: 1_000, // 4b · Foul Owl's Gift Incinerator
  evilCarriage: 1_000, // 4b · Foul Owl's Evil Carriage
  antiHolidayVault: 1_000, // 4b · Foul Owl's Gift Vault
  bedazzledGravestone: 250, // 1b · Skunkarella's Gravestone
  fancyFountain: 250, // 1b · Skunkarella's Fountain
  crystalGazebo: 1_000, // 4b · Skunkarella's Gazebo
  diamondCar: 500, // 2b · Skunkarella's Car
  evilMirror: 250, // 1b · Skunkarella's Mirror
  fashionableScarecrow: 250, // 1b · Skunkarella's Scarecrow
  jewelHome: 1_000, // 4b · Skunkarella's Home
  perfumeVat: 250, // 1b · Skunkarella's Perfume
  rockyRhinosBanner: 250, // 1b · Rocky Rhino's Banner
  rockyRhinosCave: 1_000, // 4b · Rocky Rhino's Cave
  rockyRhinosGong: 500, // 2b · Rocky Rhino's Gong
  rockyRhinosSculpture: 500, // 2b · Rocky Rhino's Sculpture
  generalLarvaelusBanner: 250, // 1b · General Larvaelus' Banner
  generalLarvaelusTeleporterA: 500, // 2b · General Larvaelus' Blue Portal
  generalLarvaelusTeleporterB: 500, // 2b · General Larvaelus' Red Portal
  teleporter: 1_000, // 4b · General Larvaelus' Portal
  mysticalMambaBanner: 250, // 1b · Mystical Mamba Banner
  mysticalMambasWishMachineLeft: 1_000, // 4b · Mystical Mamba's Wish Machine
};

/** Quest and seasonal-event prizes: the third award-only family, and the one that
 *  fell through both tables above. These are not on any invasion's tier ladder and
 *  are not Epic Boss loot, so neither rule reached them and all sixteen sold for the
 *  one-gold floor — a Circus Popcorn earned by beating the Circus three times paid
 *  the same as a weed.
 *
 *  Priced at the owner's request in a flat 500-1,000 band, by footprint, because
 *  there is no rarity ladder here to shape them against: a 1x1 trinket pays 500, a
 *  2x2 pays 750, and a 3x3-or-larger showpiece pays 1,000. Deliberately below the
 *  rare invasion drops (1,200-4,500) — a quest prize is a one-off, not a grind. */
export const QUEST_REWARD_SELL: Readonly<Record<string, number>> = {
  // 1x1 trinkets ------------------------------------------------------------
  circusPopcorn: 500, // quest 45 "Big Top Bash"
  teddyBear: 500,
  witchsCauldron: 500,
  greenGift: 500,
  redGift: 500,
  yellowGift: 500,
  iceCreamConeChocolate: 500,
  iceCreamConeStrawberry: 500,
  iceCreamConeVanilla: 500,
  coffin1: 500,
  coffin2: 500,
  coffin3: 500,

  // 2x2 -------------------------------------------------------------------
  rockBunny: 750,

  // 3x3 and larger showpieces ----------------------------------------------
  hauntedClocktower: 1_000, // 2x2 footprint, but a full-height tower
  treeSpooky: 1_000, // quest 48 "Down for the Count"
  iceCreamTruck: 1_000,
};

/** Boss Statues (src/raid/bossStatues.ts): an invasion's 15-win (stone) and 50-win
 *  (golden) milestone prizes, then a 2% / 1% chance per win. One flat price per kind,
 *  because the milestones are the same everywhere: the stone statue out-sells every
 *  invasion's own tier-5 showpiece (the dearest is 4,500), the golden one triples it.
 *  Kept modest against the rate: after the milestones a statue is a 1-in-50 win. */
const STATUE_TILES = [
  "bossStatueOldMcDonnell", "bossStatueCorporateVille", "bossStatueArrrnold",
  "bossStatueMrWhiskers", "bossStatueBroBot", "bossStatueAlien", "bossStatueSquiDude",
  "bossStatueRingmaster", "bossStatueZedzox", "bossStatueGoffy", "bossStatueFelixWonky",
  // The epic bosses' statues (tools/boss_statues.py EPIC_STATUES) — items only for now, no drop yet.
  "epicStatueDrGroundhog", "epicStatueBullyFrog", "epicStatueRockyRhino",
  "epicStatueGeneralLarvaelus", "epicStatueMysticalMamba", "epicStatueFoulOwl",
  "epicStatueSkunkarella", "epicStatueLocoLocust",
];
export const BOSS_STATUE_SELL: Readonly<Record<string, number>> = Object.fromEntries(
  STATUE_TILES.flatMap((tile) => [[tile, 5_000], [`${tile}Golden`, 15_000]])
);

/** The authored sell price of an award-only prize, or undefined for anything that
 *  isn't one (every purchasable item, and every reward with no authored value — both
 *  keep the ordinary cost-derived refund). */
export function awardedSellValue(key: string): number | undefined {
  if (Object.prototype.hasOwnProperty.call(RAID_DROP_SELL, key)) return RAID_DROP_SELL[key];
  if (Object.prototype.hasOwnProperty.call(EPIC_PRIZE_SELL, key)) return EPIC_PRIZE_SELL[key];
  if (Object.prototype.hasOwnProperty.call(QUEST_REWARD_SELL, key)) return QUEST_REWARD_SELL[key];
  if (Object.prototype.hasOwnProperty.call(BOSS_STATUE_SELL, key)) return BOSS_STATUE_SELL[key];
  return undefined;
}
