// Server mirror of each raid's LOOT TABLE (public/assets/raids/raids.json `loot`).
// GENERATED — KEEP IN SYNC. Six rarity tiers per raid, tier 0 commonest; the tier is
// chosen by LootTable.rollLootTier (imported from the client source, so the recovered
// thresholds have exactly one definition), then one ELIGIBLE entry in that tier is
// picked uniformly. The server rolls this — a win's loot is real value, so it can't be
// a client assertion.
//
// The table below is GENERATED from that asset: `npm run catalogs` (server/
// scripts/gen-catalogs.mjs) rewrites the `#region generated:` block, and
// `npm run catalogs:check` fails CI and the deploy:prod gate when the two drift.
// Edit the ASSET, not the region. Everything outside the region is hand-written
// and is not touched.

export const RAID_LOOT: Readonly<Record<number, readonly (readonly string[])[]>> = {
  // #region generated:RAID_LOOT
  // Source: public/assets/raids/raids.json — regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit
  1: [["Bonus Gold"], ["Haystack"], ["Insta-Plow", "Insta-Harvest"], ["Farmer Banner"], ["Scarecrow"], ["Windmill"]], // Old McDonnell's Farm
  2: [["Bonus Gold"], ["Zombie Sign"], ["Insta-Harvest", "Insta-Plow", "Invasion Voucher"], ["Corporate Banner"], ["Street Light"], ["Monument"]], // Zombies vs Lawyers
  3: [["Bonus Gold"], ["Treasure Chest"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Pirate Banner"], ["Gallows"], ["Parrot"]], // Zombies vs Pirates
  4: [["Bonus Gold"], ["Bamboo"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Ninja Banner"], ["Double Rainbow"], ["Taiko Drum"]], // Zombies vs Ninjas
  5: [["Bonus Gold"], ["Hazard Fence"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Robot Banner", "Broken Tractor"], ["Toxic Drum"], ["Mechanical Bull"]], // Zombies vs Robots
  6: [["Bonus Gold"], ["Bike"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Alien Banner", "Crashed UFO"], ["Pyramid"], ["Satellite Dish"]], // Zombies vs Aliens
  7: [["Bonus Gold"], ["Sand Dollar"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Ice Cream Stand"], ["Rock Lobster"], ["Giant Clam"]], // Summer Break
  8: [["Bonus Gold"], ["Concentration", "Insta-Grow", "Invasion Voucher"], ["Circus Flag: Green", "Circus Flag: Yellow", "Circus Flag: Blue"], ["Bonus Gold"], ["Circus Tent"], ["Ring of Fire"]], // Zombies vs Circus
  9: [["Bonus Gold"], ["Pixel Block", "Pixel Floating Block"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Pixel Banner", "Pixel Tree"], ["Pixel Campfire"], ["Pixel Tower"]], // Zombies vs Video Games
  10: [["Bonus Gold"], ["Bunnypig Bush"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Cobrahawk Bush", "Mosscrab Bush"], ["Phoenix Statue"], ["Poppy's House"]], // Tree World
  11: [["Bonus Gold"], ["Invasion Voucher", "Golden Dice", "Invasion Voucher"], ["Heart Hedge"], ["Heart Candle"], ["Teddy Valentine"], ["Love Shack"]], // Valentine's Day
  12: [["Bonus Gold"], ["Zombie Sign"], ["Insta-Harvest", "Insta-Plow", "Invasion Voucher"], ["Corporate Banner"], ["Street Light"], ["Monument"]], // Zombies vs Lawyers & Farmers
  13: [["Bonus Gold"], ["Bamboo"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Ninja Banner"], ["Double Rainbow"], ["Taiko Drum"]], // Zombies vs Ninjas & Pirates
  14: [["Bonus Gold"], ["Concentration", "Insta-Grow", "Invasion Voucher"], ["Circus Flag: Green", "Circus Flag: Yellow", "Circus Flag: Blue"], ["Bonus Gold"], ["Circus Tent"], ["Ring of Fire"]], // Zombies vs Circus & Video Games
  15: [["Bonus Gold"], ["Bike"], ["Invasion Voucher", "Insta-Grow", "Insta-Plow", "Insta-Harvest"], ["Alien Banner", "Crashed UFO"], ["Pyramid"], ["Satellite Dish"]], // Zombies vs Aliens & Robots
  // #endregion generated:RAID_LOOT
};

/** The 6-tier loot table for a raid, or undefined for an unknown id. */
export function raidLoot(id: number): readonly (readonly string[])[] | undefined {
  return Object.prototype.hasOwnProperty.call(RAID_LOOT, id) ? RAID_LOOT[id] : undefined;
}

/** Loot metadata (public/assets/raids/drops.json). Only the fields that decide VALUE or
* eligibility are mirrored: what the entry pays out, and how often it may ever drop.
 *  `unique` entries drop only once; `limit` caps total copies (only Rusty Fragment: 3).
 *  `tile` links a loot name to the placeable it becomes once placed, which is how the
 *  server can tell you already own one. */
export interface DropEcon {
  brains: boolean; // pays brains (the amount is the entry's name, e.g. "10 Brains")
  gold: boolean;   // pays bonus gold
  unique: boolean;
  limit: number;   // 0 = unlimited
  tile: string;    // linked placeable key ("" = none)
}

export const DROPS: Readonly<Record<string, DropEcon>> = {
  // #region generated:DROPS
  // Source: public/assets/raids/drops.json — regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit
  "10 Brains": { brains: true, gold: false, unique: false, limit: 0, tile: "" },
  "Alien Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "alienBanner" },
  "Bamboo": { brains: false, gold: false, unique: false, limit: 0, tile: "bambooTree" },
  "Bike": { brains: false, gold: false, unique: true, limit: 0, tile: "bike" },
  "Bonus Gold": { brains: false, gold: true, unique: false, limit: 0, tile: "" },
  "Boss Farmer Snowman": { brains: false, gold: false, unique: false, limit: 0, tile: "snowOlMcDonnell" },
  "Broken Tractor": { brains: false, gold: false, unique: false, limit: 0, tile: "brokenTractor" },
  "Bully Frog's Carnivorous Plants": { brains: false, gold: false, unique: false, limit: 0, tile: "carnivorousPlants" },
  "Bully Frog's Fireflies": { brains: false, gold: false, unique: false, limit: 0, tile: "fireflies" },
  "Bully Frog's Lily Jukebox": { brains: false, gold: false, unique: false, limit: 0, tile: "lilyJukebox" },
  "Bully Frog's Mossy Couch": { brains: false, gold: false, unique: false, limit: 0, tile: "mossyCouch" },
  "Bully Frog's Muddy Pool": { brains: false, gold: false, unique: false, limit: 0, tile: "muddyPool" },
  "Bully Frog's Squirmy Worms": { brains: false, gold: false, unique: false, limit: 0, tile: "squirmyWorms" },
  "Bully Frog's Swamp Cabin": { brains: false, gold: false, unique: false, limit: 0, tile: "swamp_Cabin" },
  "Bully Frog's Toad Stool": { brains: false, gold: false, unique: false, limit: 0, tile: "toadStool" },
  "Bunny Rock": { brains: false, gold: false, unique: false, limit: 0, tile: "rockBunny" },
  "Bunnypig Bush": { brains: false, gold: false, unique: false, limit: 0, tile: "treeWorldPigling" },
  "Chocolate Cone": { brains: false, gold: false, unique: false, limit: 0, tile: "iceCreamConeChocolate" },
  "Circus Flag: Blue": { brains: false, gold: false, unique: false, limit: 0, tile: "circusFlagBlue" },
  "Circus Flag: Green": { brains: false, gold: false, unique: false, limit: 0, tile: "circusFlagGreen" },
  "Circus Flag: Yellow": { brains: false, gold: false, unique: false, limit: 0, tile: "circusFlagYellow" },
  "Circus Popcorn": { brains: false, gold: false, unique: false, limit: 0, tile: "circusPopcorn" },
  "Circus Tent": { brains: false, gold: false, unique: false, limit: 0, tile: "circusTent" },
  "Cobrahawk Bush": { brains: false, gold: false, unique: false, limit: 0, tile: "treeWorldCobraHawk" },
  "Coffin 1": { brains: false, gold: false, unique: false, limit: 0, tile: "coffin1" },
  "Coffin 2": { brains: false, gold: false, unique: false, limit: 0, tile: "coffin2" },
  "Coffin 3": { brains: false, gold: false, unique: false, limit: 0, tile: "coffin3" },
  "Concentration": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Corporate Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "corporatevilleBanner" },
  "Crashed UFO": { brains: false, gold: false, unique: false, limit: 0, tile: "crashedUFO" },
  "Double Rainbow": { brains: false, gold: false, unique: false, limit: 0, tile: "doubleRainbow_01" },
  "Dr. Groundhog's Burrow": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogBurrow" },
  "Dr. Groundhog's Distillery": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogDistillery" },
  "Dr. Groundhog's Evil Device": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogEvilDevice" },
  "Dr. Groundhog's Lab": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogEvilLab" },
  "Dr. Groundhog's Lab Shelves": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogLabShelves" },
  "Dr. Groundhog's Lab Table": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogLabTable" },
  "Dr. Groundhog's Nut Stash": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogNutStash" },
  "Dr. Groundhog's Tricycle": { brains: false, gold: false, unique: false, limit: 0, tile: "drgroundhogTricycle" },
  "Easter Grass": { brains: false, gold: false, unique: false, limit: 0, tile: "easterGrass" },
  "Farmer Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "oldMcDonnellBanner" },
  "Farmhand Snowman": { brains: false, gold: false, unique: false, limit: 0, tile: "snowFarmhand" },
  "Foul Owl's Colossal Snowman": { brains: false, gold: false, unique: false, limit: 0, tile: "snowOwl" },
  "Foul Owl's Evil Carriage": { brains: false, gold: false, unique: false, limit: 0, tile: "evilCarriage" },
  "Foul Owl's Gift Incinerator": { brains: false, gold: false, unique: false, limit: 0, tile: "antiHolidayIncinerator" },
  "Foul Owl's Gift Vault": { brains: false, gold: false, unique: false, limit: 0, tile: "antiHolidayVault" },
  "Gallows": { brains: false, gold: false, unique: false, limit: 0, tile: "gallows" },
  "General Larvaelus' Banner": { brains: false, gold: false, unique: false, limit: 0, tile: "generalLarvaelusBanner" },
  "General Larvaelus' Blue Portal": { brains: false, gold: false, unique: false, limit: 0, tile: "generalLarvaelusTeleporterA" },
  "General Larvaelus' Portal": { brains: false, gold: false, unique: false, limit: 0, tile: "teleporter" },
  "General Larvaelus' Red Portal": { brains: false, gold: false, unique: false, limit: 0, tile: "generalLarvaelusTeleporterB" },
  "Giant Clam": { brains: false, gold: false, unique: true, limit: 0, tile: "giantClamClosed" },
  "Golden Dice": { brains: false, gold: true, unique: false, limit: 0, tile: "" },
  "Golden Egg": { brains: false, gold: true, unique: true, limit: 0, tile: "goldEgg" },
  "Green Gift Box": { brains: false, gold: false, unique: false, limit: 0, tile: "greenGift" },
  "Haunted Clocktower": { brains: false, gold: false, unique: false, limit: 0, tile: "hauntedClocktower" },
  "Haystack": { brains: false, gold: false, unique: false, limit: 0, tile: "haystack" },
  "Hazard Fence": { brains: false, gold: false, unique: false, limit: 0, tile: "hazardFence" },
  "Heart Candle": { brains: false, gold: false, unique: false, limit: 0, tile: "heartCandle" },
  "Heart Hedge": { brains: false, gold: false, unique: false, limit: 0, tile: "heartHedge" },
  "Ice Cream Stand": { brains: false, gold: false, unique: false, limit: 0, tile: "iceCreamStand" },
  "Ice Cream Truck": { brains: false, gold: false, unique: true, limit: 0, tile: "iceCreamTruck" },
  "Insta-Grow": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Insta-Harvest": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Insta-Plow": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Invasion Voucher": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Loco Locust's Banjo": { brains: false, gold: false, unique: false, limit: 0, tile: "banjo" },
  "Loco Locust's Boots": { brains: false, gold: false, unique: false, limit: 0, tile: "boots" },
  "Loco Locust's Cactus Target": { brains: false, gold: false, unique: false, limit: 0, tile: "cactusTarget" },
  "Loco Locust's Gun Rack": { brains: false, gold: false, unique: false, limit: 0, tile: "gunRack" },
  "Loco Locust's Hideout": { brains: false, gold: false, unique: false, limit: 0, tile: "hideout" },
  "Loco Locust's Rocking Horse": { brains: false, gold: false, unique: false, limit: 0, tile: "rockingHorse" },
  "Loco Locust's Saddle": { brains: false, gold: false, unique: false, limit: 0, tile: "saddle" },
  "Loco Locust's Saloon": { brains: false, gold: false, unique: false, limit: 0, tile: "saloon" },
  "Love Shack": { brains: false, gold: false, unique: false, limit: 0, tile: "loveShack" },
  "Lumberjack Snowman": { brains: false, gold: false, unique: false, limit: 0, tile: "snowLumberjack" },
  "Mechanical Bull": { brains: false, gold: false, unique: true, limit: 0, tile: "mechanicalBull" },
  "Monument": { brains: false, gold: false, unique: true, limit: 0, tile: "monument" },
  "Mosscrab Bush": { brains: false, gold: false, unique: false, limit: 0, tile: "treeWorldMossCrab" },
  "Mystical Mamba Banner": { brains: false, gold: false, unique: false, limit: 0, tile: "mysticalMambaBanner" },
  "Mystical Mamba's Wish Machine": { brains: false, gold: false, unique: false, limit: 0, tile: "mysticalMambasWishMachineLeft" },
  "Ninja Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "ninjaBanner" },
  "Parrot": { brains: false, gold: false, unique: true, limit: 0, tile: "parrot" },
  "Phoenix Statue": { brains: false, gold: false, unique: false, limit: 0, tile: "treeWorldPhoenix" },
  "Pirate Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "pirateBanner" },
  "Pixel Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "pixelBanner" },
  "Pixel Block": { brains: false, gold: false, unique: false, limit: 0, tile: "pixelBrick" },
  "Pixel Campfire": { brains: false, gold: false, unique: false, limit: 0, tile: "pixelCampfire" },
  "Pixel Floating Block": { brains: false, gold: false, unique: false, limit: 0, tile: "pixelBrickFloating" },
  "Pixel Tower": { brains: false, gold: false, unique: false, limit: 0, tile: "pixelTower" },
  "Pixel Tree": { brains: false, gold: false, unique: false, limit: 0, tile: "pixelTree" },
  "Popcorn Machine": { brains: false, gold: false, unique: false, limit: 0, tile: "circusPopcorn" },
  "Poppy's House": { brains: false, gold: false, unique: true, limit: 0, tile: "treeWorldPoppyHouse" },
  "Pyramid": { brains: false, gold: false, unique: false, limit: 0, tile: "pyramid" },
  "Red Gift Box": { brains: false, gold: false, unique: false, limit: 0, tile: "redGift" },
  "Refresher": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Ring of Fire": { brains: false, gold: false, unique: false, limit: 0, tile: "fireRing" },
  "Robot Banner": { brains: false, gold: false, unique: true, limit: 0, tile: "robotBanner" },
  "Rock Lobster": { brains: false, gold: false, unique: false, limit: 0, tile: "rockLobster" },
  "Rocky Rhino's Banner": { brains: false, gold: false, unique: false, limit: 0, tile: "rockyRhinosBanner" },
  "Rocky Rhino's Cave": { brains: false, gold: false, unique: false, limit: 0, tile: "rockyRhinosCave" },
  "Rocky Rhino's Gong": { brains: false, gold: false, unique: false, limit: 0, tile: "rockyRhinosGong" },
  "Rocky Rhino's Sculpture": { brains: false, gold: false, unique: false, limit: 0, tile: "rockyRhinosSculpture" },
  "Rusty Fragment": { brains: false, gold: false, unique: false, limit: 3, tile: "" },
  "Sand Dollar": { brains: false, gold: false, unique: false, limit: 0, tile: "sandDollar" },
  "Satellite Dish": { brains: false, gold: false, unique: true, limit: 0, tile: "setiDish" },
  "Scarecrow": { brains: false, gold: false, unique: false, limit: 0, tile: "scarecrowNormal" },
  "Skunkarella's Car": { brains: false, gold: false, unique: false, limit: 0, tile: "diamondCar" },
  "Skunkarella's Fountain": { brains: false, gold: false, unique: false, limit: 0, tile: "fancyFountain" },
  "Skunkarella's Gazebo": { brains: false, gold: false, unique: false, limit: 0, tile: "crystalGazebo" },
  "Skunkarella's Gravestone": { brains: false, gold: false, unique: false, limit: 0, tile: "bedazzledGravestone" },
  "Skunkarella's Home": { brains: false, gold: false, unique: false, limit: 0, tile: "jewelHome" },
  "Skunkarella's Mirror": { brains: false, gold: false, unique: false, limit: 0, tile: "evilMirror" },
  "Skunkarella's Perfume": { brains: false, gold: false, unique: false, limit: 0, tile: "perfumeVat" },
  "Skunkarella's Scarecrow": { brains: false, gold: false, unique: false, limit: 0, tile: "fashionableScarecrow" },
  "Spooky Tree": { brains: false, gold: false, unique: false, limit: 0, tile: "treeSpooky" },
  "Strawberry Cone": { brains: false, gold: false, unique: false, limit: 0, tile: "iceCreamConeStrawberry" },
  "Street Light": { brains: false, gold: false, unique: false, limit: 0, tile: "streetLight" },
  "Taiko Drum": { brains: false, gold: false, unique: true, limit: 0, tile: "taikoDrum" },
  "Teddy Bear": { brains: false, gold: false, unique: false, limit: 0, tile: "teddyBear" },
  "Teddy Valentine": { brains: false, gold: false, unique: false, limit: 0, tile: "teddyValentine" },
  "Toxic Drum": { brains: false, gold: false, unique: false, limit: 0, tile: "toxicDrum" },
  "Treasure Chest": { brains: false, gold: false, unique: false, limit: 0, tile: "treasureChest" },
  "Valentine Gift": { brains: false, gold: false, unique: false, limit: 0, tile: "" },
  "Vanilla Cone": { brains: false, gold: false, unique: false, limit: 0, tile: "iceCreamConeVanilla" },
  "Windmill": { brains: false, gold: false, unique: true, limit: 0, tile: "windmill" },
  "Witch's Cauldron": { brains: false, gold: false, unique: true, limit: 0, tile: "witchsCauldron" },
  "Yellow Gift Box": { brains: false, gold: false, unique: false, limit: 0, tile: "yellowGift" },
  "Zombie Sign": { brains: false, gold: false, unique: false, limit: 0, tile: "zombieXingSign" },
  "Zombie Snowman": { brains: false, gold: false, unique: false, limit: 0, tile: "snowZombie" },
  // #endregion generated:DROPS
};

export function dropEcon(name: string): DropEcon | undefined {
  return Object.prototype.hasOwnProperty.call(DROPS, name) ? DROPS[name] : undefined;
}

/** Ceiling on items imported from one save's storage — a DoS bound on the batch, not a
 *  game rule (the shed caps at 64 and Received is unlimited but small in practice).
 *  Entries that aren't real drops.json names are dropped regardless. */
export const MAX_SEED_ITEMS = 4096;
