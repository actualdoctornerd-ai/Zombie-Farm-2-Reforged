// Where each special zombie ENTERS the game, and at what player level.
//
// A special is not a market crop: it is the prize at the end of some other system —
// an invasion, an Epic Boss event, the Zombie Pot — and that system has its own
// unlock level. This module is the one place that reads those levels back off the
// systems themselves, so a re-tuned invasion or a re-ordered Epic ladder moves the
// zombie's gate with it instead of leaving a hand-copied number behind.
//
// Its consumer today is the Black Market (src/blackMarketRules.ts), which uses the
// source level as the floor a BUYER must clear — trading may bypass a crop's planting
// level, but it must not hand a level-12 farm the Aliens' Cozmonaut. The map is
// deliberately about the SOURCE, not about trading, so anything else that wants to ask
// "how far in is this zombie?" can use it too.
import raidRows from "../../public/assets/raids/raids.json";
import { EPIC_BOSSES, epicBossUnlockLevel } from "../epicBoss/catalog";
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../epicBoss/rewards";
import { RAID_ZOMBIE_SOURCES } from "../raid/zombieDrops";
import { COMBINE_SPECIAL_BY_GROUP, COMBINE_SPECIAL_LEVEL } from "./combineSpecies";

/** Player level that unlocks each invasion (raids.json `unlockLevel`, the same field
 *  RaidCatalog.isUnlocked reads). */
const RAID_UNLOCK_LEVEL: ReadonlyMap<number, number> = new Map(
  (raidRows as Array<{ id: number; unlockLevel?: number }>)
    .map((raid) => [raid.id, Math.max(0, Math.trunc(raid.unlockLevel ?? 0))])
);

/** Which Epic Boss owns each quest id. Derived from the boss catalogs rather than from
 *  the id's numeric prefix: the prefixes happen to be per-boss today, but the catalog
 *  is what actually decides, and an event added later would not have to remember. */
const EPIC_BOSS_BY_QUEST: ReadonlyMap<string, string> = new Map(
  EPIC_BOSSES.flatMap((boss) => boss.questIds.map((questId) => [questId, boss.id] as const))
);

/** The EARLIEST level at which each special can first be obtained, by source. A zombie
 *  with more than one route takes the lowest of them — the gate asks "could this player
 *  have earned one yet?", and any one open route answers yes. */
const SOURCE_LEVEL = new Map<string, number>();
const noteSource = (key: string, level: number): void => {
  const known = SOURCE_LEVEL.get(key);
  if (known === undefined || level < known) SOURCE_LEVEL.set(key, Math.max(0, Math.trunc(level)));
};

// Invasion prizes — ordinary and elite alike. An elite (Brain Ticket) win is a harder
// fight of the SAME invasion, so the promoted prize unlocks with its raid.
for (const source of RAID_ZOMBIE_SOURCES) {
  noteSource(source.drop.key, RAID_UNLOCK_LEVEL.get(source.raidId) ?? 0);
}

// Epic Boss prizes — the event's own unlock level (EPIC_BOSS_UNLOCK_LEVELS, the ladder
// ordered by how strong the prize is).
for (const [questId, key] of Object.entries(EPIC_QUEST_ZOMBIE_REWARDS)) {
  const bossId = EPIC_BOSS_BY_QUEST.get(questId);
  if (bossId !== undefined) noteSource(key, epicBossUnlockLevel(bossId));
}

// Zombie Pot tier-5 promotions — the level at which a combine may promote at all.
for (const key of Object.values(COMBINE_SPECIAL_BY_GROUP)) noteSource(key, COMBINE_SPECIAL_LEVEL);

/** The player level at which `key`'s own source opens, or null when nothing in the game
 *  currently grants it (the orphaned seasonal specials, which exist only in old saves
 *  and as trade goods). Callers decide what an absent source means for them. */
export function specialZombieSourceLevel(key: string): number | null {
  return SOURCE_LEVEL.get(key) ?? null;
}

/** Every special with a known source, for tests and tools. */
export const SPECIAL_ZOMBIE_SOURCE_LEVELS: ReadonlyMap<string, number> = SOURCE_LEVEL;
