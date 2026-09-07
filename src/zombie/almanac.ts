// Zombie Almanac: the collection ("dex") behind the Zombies menu's second tab.
// Pure data logic — which species belong in the almanac, how each is obtained,
// and the lifetime-discovery counter shape persisted in the save. Rendering
// lives in ui/panels/zombies.ts; discovery increments in ZombieField/GameState.
import type { ZombieDef } from "../assets";
import { purchasableZombies } from "../assets";
import { COMBINE_SPECIAL_BY_GROUP, COMBINE_SPECIAL_LEVEL } from "./combineSpecies";
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../epicBoss/rewards";
import { RAID_ZOMBIE_SOURCES, type RaidZombieSource } from "../raid/zombieDrops";

/** Lifetime obtained count per species key. Persisted (local save / online
 *  presentation — see save/schema.ts AlmanacSave). A key's presence with a
 *  count >= 1 means "discovered". */
export type DiscoveredMap = Record<string, number>;

/** Names looked up by the caller (main.ts owns the raid + epic boss catalogs). */
export interface ObtainSources {
  raidNameById: (raidId: number) => string | undefined;
  epicBossNameByQuestId: (questId: string) => string | undefined;
}

// Reverse maps: species key -> where it comes from. Ordinary and elite invasion prizes
// both count (a Sheriff comes only from an elite Lawyers fight).
const RAID_BY_ZOMBIE: Readonly<Record<string, RaidZombieSource>> = Object.fromEntries(
  RAID_ZOMBIE_SOURCES.map((source) => [source.drop.key, source])
);
const EPIC_QUEST_BY_ZOMBIE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EPIC_QUEST_ZOMBIE_REWARDS).map(([questId, key]) => [key, questId])
);
const POT_SPECIALS = new Set(Object.values(COMBINE_SPECIAL_BY_GROUP));

/** Is this species currently acquirable through any real path? Orphaned seasonal
 *  specials (no market seed, no reward source wired yet) stay OUT of the almanac
 *  until they gain one — the almanac lists obtainable zombies only. */
export function isObtainable(def: ZombieDef): boolean {
  return (
    (!def.rewardOnly && !def.marketHidden) ||
    POT_SPECIALS.has(def.key) ||
    def.key in EPIC_QUEST_BY_ZOMBIE ||
    def.key in RAID_BY_ZOMBIE
  );
}

/** Is this species an Epic Boss exclusive? They are the Almanac's third group: a
 *  timed-event source no other zombie shares, which read as noise while it was
 *  scattered through Special among the Pot/raid/market specials. */
export const isEpicZombie = (def: ZombieDef): boolean => def.key in EPIC_QUEST_BY_ZOMBIE;

// Group order down the Almanac: Normal, Special, then Epic. (Mutant base species are
// filtered out entirely — see almanacEntries.)
const CATEGORY_ORDER: Record<string, number> = { normal: 0, mutant: 1, special: 2 };
const EPIC_ORDER = 3;
const groupOrder = (def: ZombieDef): number =>
  isEpicZombie(def) ? EPIC_ORDER : CATEGORY_ORDER[def.category] ?? 4;

/** Sort key WITHIN the Epic group. Quest ids run 1000, 2000, … 10000 in the same
 *  order the boss catalog lists its bosses, and each boss's ids ascend from its base
 *  prize to its omega one — so the raw number keeps a boss's pair of zombies side by
 *  side, in event order, instead of scattering them alphabetically. */
const epicOrder = (def: ZombieDef): number => Number(EPIC_QUEST_BY_ZOMBIE[def.key] ?? 0);

/** The almanac's entry list: every obtainable species, plus any species the
 *  player has already discovered even if it has no current source (a legacy or
 *  event grant must never vanish from the collection). Mutant BASE species are
 *  excluded for now: players usually acquire mutations indirectly (mutation
 *  crops / Pot masks on other species), so a dex of mutant gravestones reads
 *  strangely — revisit alongside the future mutation almanac. Sorted for
 *  display into the panel's three groups: normal -> special -> epic, each by
 *  unlock level then name (the epic group by its own event order instead). */
export function almanacEntries(
  zombies: readonly ZombieDef[],
  discovered: DiscoveredMap
): ZombieDef[] {
  return zombies
    .filter((def) => def.category !== "mutant")
    .filter((def) => isObtainable(def) || (discovered[def.key] ?? 0) > 0)
    .sort(
      (a, b) =>
        groupOrder(a) - groupOrder(b) ||
        epicOrder(a) - epicOrder(b) ||
        a.level - b.level ||
        a.name.localeCompare(b.name)
    );
}

/** One-line "how do I get this?" hint, shown for undiscovered entries. Sources are
 *  checked in specificity order — a raid/epic exclusive names its exact source. */
export function obtainHint(def: ZombieDef, sources: ObtainSources): string {
  const source = RAID_BY_ZOMBIE[def.key];
  if (source !== undefined) {
    const raid = sources.raidNameById(source.raidId);
    const fight = source.elite ? "an elite (Brain Ticket) invasion" : "an invasion";
    return raid
      ? `Rarely found after winning ${fight} of ${raid}.`
      : `Rarely found after winning ${fight}.`;
  }
  const questId = EPIC_QUEST_BY_ZOMBIE[def.key];
  if (questId !== undefined) {
    const boss = sources.epicBossNameByQuestId(questId);
    return boss
      ? `Earned by fighting ${boss} during an Epic Boss event.`
      : "Earned during an Epic Boss event.";
  }
  if (POT_SPECIALS.has(def.key)) {
    return `A rare Zombie Pot result: combine two ${def.group} zombies at level ${COMBINE_SPECIAL_LEVEL}+.`;
  }
  if (!def.rewardOnly && !def.marketHidden) {
    const price = def.brainsNeeded ? `${def.cost} brains` : `${def.cost} gold`;
    return `Grow it from a Market gravestone (level ${Math.max(1, def.level)}, ${price}).`;
  }
  return "Obtained from special events.";
}

/** Seed the discovery map from an existing roster (first run after the almanac
 *  ships, or a save written before it existed): every currently owned species
 *  counts at least the number of copies owned right now. */
export function backfillDiscovered(roster: readonly { key: string }[]): DiscoveredMap {
  const discovered: DiscoveredMap = {};
  for (const unit of roster) discovered[unit.key] = (discovered[unit.key] ?? 0) + 1;
  return discovered;
}

/** Sanitize a persisted discovery map: keep finite counts >= 1 only. */
export function sanitizeDiscovered(raw: unknown): DiscoveredMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const discovered: DiscoveredMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
      discovered[key] = Math.floor(value);
    }
  }
  return discovered;
}

// purchasableZombies is re-exported so panel/test code has one almanac import
// surface for "what the market sells" vs "what the almanac lists".
export { purchasableZombies };
