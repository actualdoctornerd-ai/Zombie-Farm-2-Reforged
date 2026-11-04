import { msg as trMsg, t as tr } from "./i18n/translate";
// Turning the lifetime tally (stats.ts) plus the farm's current standing into the
// rows the Statistics panel prints. Pure: the panel does no arithmetic and no
// name-resolution of its own, so what a player reads is testable here.

import { favouriteCrop, totalHarvested, type FarmStats } from "./stats";

export interface StatRow {
  label: string;
  value: string;
  /** A short clarification under the value, when the number alone would mislead. */
  note?: string;
}

export interface StatSection {
  title: string;
  rows: StatRow[];
}

export interface StatsViewInput {
  stats: FarmStats;
  /** Epoch ms, for "keeping count since". */
  now: number;
  name: string;
  level: number;
  xp: number;
  gold: number;
  brains: number;
  /** Zombies standing on the farm, the cap they stand against, and the Mausoleum. */
  zombiesDeployed: number;
  zombieMax: number;
  zombiesStored: number;
  speciesDiscovered: number;
  speciesTotal: number;
  mutationsDiscovered: number;
  mutationsTotal: number;
  /** Display name for a crop key. Undefined for a key this catalog no longer knows —
   *  a seasonal crop, or one renamed since it was harvested. */
  cropName: (key: string) => string | undefined;
}

/** Thousands-grouped, written out by hand rather than through toLocaleString: the
 *  panel must read the same in every locale the game runs in, and a test must be
 *  able to assert the string. */
export function formatCount(n: number): string {
  const value = Math.max(0, Math.round(n));
  const digits = String(value);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** Whole days between two epoch ms, never negative (a clock that went backwards is
 *  not a farm from the future). */
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

const DAY_LABEL = (days: number): string =>
  days === 0 ? tr("Today") : days === 1 ? tr("1 day") : trMsg`${formatCount(days)} days`;

/** Every row the Statistics panel shows, in the order it shows them. */
export function buildStatsView(input: StatsViewInput): StatSection[] {
  const s = input.stats;
  const harvested = totalHarvested(s);
  const favourite = favouriteCrop(s);
  const raids = s.raidsWon + s.raidsLost;

  const farm: StatRow[] = [
    { label: "Farmer", value: input.name },
    { label: "Level", value: formatCount(input.level) },
    { label: "Total XP", value: formatCount(input.xp) },
    { label: "Keeping count for", value: DAY_LABEL(daysBetween(s.startedAt, input.now)) },
  ];

  const farming: StatRow[] = [
    { label: "Crops harvested", value: formatCount(harvested) },
    {
      label: "Favourite crop",
      // The key is the fallback on purpose: a crop the catalog has dropped is still
      // the one this farm grew most, and "—" would read as "you have no favourite".
      value: favourite ? tr(input.cropName(favourite.key) ?? favourite.key) : "—",
      note: favourite ? `${formatCount(favourite.count)} harvested` : "Nothing harvested yet",
    },
    { label: "Crops planted", value: formatCount(s.planted) },
    { label: "Plots plowed", value: formatCount(s.plowed) },
    { label: "Trees picked", value: formatCount(s.treesHarvested) },
  ];

  const wealth: StatRow[] = [
    { label: "Gold", value: formatCount(input.gold), note: "in the bank right now" },
    { label: "Gold earned", value: formatCount(s.goldEarned) },
    { label: "Gold spent", value: formatCount(s.goldSpent) },
    { label: "Brains", value: formatCount(input.brains), note: "in the bank right now" },
    { label: "Brains earned", value: formatCount(s.brainsEarned) },
    { label: "Brains spent", value: formatCount(s.brainsSpent) },
  ];

  const zombies: StatRow[] = [
    {
      label: "Zombies on the farm",
      value: `${formatCount(input.zombiesDeployed)} / ${formatCount(input.zombieMax)}`,
      note: input.zombiesStored > 0
        ? `${formatCount(input.zombiesStored)} more in the Mausoleum`
        : undefined,
    },
    { label: "Grown from crops", value: formatCount(s.zombiesGrown) },
    { label: "Combined in the Pot", value: formatCount(s.zombiesCombined) },
    { label: "Sold", value: formatCount(s.zombiesSold) },
    { label: "Lost in battle", value: formatCount(s.zombiesLost) },
    {
      label: "Species discovered",
      value: `${formatCount(input.speciesDiscovered)} / ${formatCount(input.speciesTotal)}`,
    },
    {
      label: "Mutations discovered",
      value: `${formatCount(input.mutationsDiscovered)} / ${formatCount(input.mutationsTotal)}`,
    },
  ];

  const invasions: StatRow[] = [
    { label: "Invasions won", value: formatCount(s.raidsWon) },
    {
      label: "Invasions lost",
      value: formatCount(s.raidsLost),
      // A retreat is a loss here: the army came home beaten either way.
      note: s.raidsLost > 0 ? "retreats included" : undefined,
    },
    {
      label: "Win rate",
      value: raids > 0 ? `${Math.round((s.raidsWon / raids) * 100)}%` : "—",
      note: raids > 0 ? trMsg`${formatCount(raids)} fought` : "No invasions fought yet",
    },
  ];

  return [
    { title: tr("Farm"), rows: farm },
    { title: tr("Farming"), rows: farming },
    { title: tr("Wealth"), rows: wealth },
    { title: tr("Zombies"), rows: zombies },
    { title: tr("Invasions"), rows: invasions },
  ];
}
