// Omni-Farmer: the level-44 quest whose completion puts the 90x90 farm up for sale
// (owner, 2026-11-11). The quest's own objectives live in quests_reforged.json; this
// file holds the facts the Market (client) and shop.size (Worker) both gate on, and the
// Almanac split its two zombie objectives count by.
//
// KEEP IN SYNC with QUEST_SIZE_TIERS in tools/reforge_economy.py (the tier's `quest`),
// pinned by quest/omniFarmer.test.ts.
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../epicBoss/rewards";
import { RAID_ZOMBIE_SOURCES } from "../raid/zombieDrops";

export const OMNI_FARMER_QUEST_ID = "20018";
export const OMNI_FARMER_EXPANSION_SIZE = 90;
/** The zombie the quest's Green Flower Ticket plants (public/assets/zombies.json `ticket`). */
export const OMNI_FARMER_PRIZE_ZOMBIE = "ZombieActorGardenTier3GreenFlower";

/** Is the Omni-Farmer farm size open to this account? */
export const omniFarmerUnlocked = (completedQuestIds: Iterable<string>): boolean => {
  for (const id of completedQuestIds) if (id === OMNI_FARMER_QUEST_ID) return true;
  return false;
};

/** Which zombies count toward Omni-Farmer's "discover 50 zombies" objective (owner,
 *  2026-11-11: basics — green, blue, red, silver, obsidian — and specials from epics,
 *  invasions and the 5 plantable specials; "just 50 total", any mix of the two).
 *
 *  - basic:   the catalog's `normal` species — six body types at Green, Blue, Red,
 *             Silver and Obsidian (30 in all).
 *  - special: a `special` species won from an Epic Boss event, dropped by an invasion
 *             (ordinary or elite), or grown from one of the Market's special
 *             gravestones (Bombie, Dapper, Granny, Cupid, Crazy).
 *
 *  Everything else does not count: mutant base species (the Almanac does not list
 *  them), Zombie Pot tier-5 promotions, and specials with no source wired up. */
export type AlmanacClass = "basic" | "special";

export interface AlmanacClassRow {
  key: string;
  category?: string;
  marketHidden?: boolean;
  rewardOnly?: boolean | null;
}

const EARNED_SPECIALS = new Set<string>([
  ...Object.values(EPIC_QUEST_ZOMBIE_REWARDS),
  ...RAID_ZOMBIE_SOURCES.map((source) => source.drop.key),
]);

/** Build the classifier once from the zombie catalog (zombies.json rows). */
export function omniAlmanacClassifier(
  rows: readonly AlmanacClassRow[]
): (key: string) => AlmanacClass | undefined {
  const classes = new Map<string, AlmanacClass>();
  for (const row of rows) {
    if (row.category === "normal") classes.set(row.key, "basic");
    else if (row.category === "special" &&
      (EARNED_SPECIALS.has(row.key) || (!row.marketHidden && !row.rewardOnly))) {
      classes.set(row.key, "special");
    }
  }
  return (key) => classes.get(key);
}
