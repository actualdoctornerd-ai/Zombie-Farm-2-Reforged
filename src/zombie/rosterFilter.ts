// ---------------------------------------------------------------------------
// Owned-roster filtering (My Zombies + the Mausoleum)
// ---------------------------------------------------------------------------
// Purely a display choice, like rosterSort: nothing here touches the save. Kept
// out of the DOM code so the narrowing rules are testable.
//
// Two axes, named the way the Black Market toolbar names them to a player:
//   • class   — the body family (`group`: Regular / Female / Small / ...), shown
//               with the Market's labels (Normal / Girl / Mini / ...).
//   • species — the exact zombie type (`key`), shown by its species name.
// The species list is narrowed by the chosen class, and only ever offers what is
// actually in the rows being filtered — an option that could only produce an
// empty list is noise.
import { BLACK_MARKET_GROUP_FILTERS } from "../blackMarketRules";

export interface RosterFilter {
  /** Body family (`group`), or "" for every class. */
  group: string;
  /** Species `key`, or "" for every species. */
  species: string;
}

export const NO_ROSTER_FILTER: RosterFilter = { group: "", species: "" };

/** Anything filterable here. */
export type FilterableZombie = { key: string; typeName: string; group: string };

export interface RosterFilterOption {
  value: string;
  label: string;
  count: number;
}

export function isFiltered(filter: RosterFilter): boolean {
  return !!(filter.group || filter.species);
}

export function filterZombies<T extends FilterableZombie>(rows: readonly T[], filter: RosterFilter): T[] {
  return rows.filter((z) =>
    (!filter.group || z.group === filter.group) && (!filter.species || z.key === filter.species));
}

/** The classes present in `rows`, in the Black Market's order, each with its count.
 *  A group the Market does not list still gets an option (under its raw name) so a
 *  zombie can never become unreachable by filtering. */
export function classOptions(rows: readonly FilterableZombie[]): RosterFilterOption[] {
  const counts = new Map<string, number>();
  for (const z of rows) counts.set(z.group, (counts.get(z.group) ?? 0) + 1);
  const known = BLACK_MARKET_GROUP_FILTERS
    .filter((o) => counts.has(o.value))
    .map((o) => ({ value: o.value, label: o.label, count: counts.get(o.value)! }));
  const listed = new Set(BLACK_MARKET_GROUP_FILTERS.map((o) => o.value));
  const unknown = [...counts]
    .filter(([group]) => !listed.has(group))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, count]) => ({ value: group, label: group || "Other", count }));
  return [...known, ...unknown];
}

/** The species present in `rows` (within `group`, when one is chosen), by name. */
export function speciesOptions(rows: readonly FilterableZombie[], group = ""): RosterFilterOption[] {
  const byKey = new Map<string, RosterFilterOption>();
  for (const z of rows) {
    if (group && z.group !== group) continue;
    const seen = byKey.get(z.key);
    if (seen) seen.count++;
    else byKey.set(z.key, { value: z.key, label: z.typeName || z.key, count: 1 });
  }
  return [...byKey.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.value.localeCompare(b.value));
}

/** Drop any choice the current rows can no longer satisfy — the last zombie of a
 *  species was sold, or the class changed under a species from another class — so
 *  a remembered filter never strands the player on an empty list with no way to
 *  see why. */
export function settleRosterFilter(rows: readonly FilterableZombie[], filter: RosterFilter): RosterFilter {
  const group = classOptions(rows).some((o) => o.value === filter.group) ? filter.group : "";
  const species = speciesOptions(rows, group).some((o) => o.value === filter.species) ? filter.species : "";
  return { group, species };
}

/** Round-trip through viewState's string store. */
export function encodeRosterFilter(filter: RosterFilter): string {
  return JSON.stringify({ group: filter.group, species: filter.species });
}

export function decodeRosterFilter(raw: string | undefined): RosterFilter {
  if (!raw) return NO_ROSTER_FILTER;
  try {
    const parsed = JSON.parse(raw) as Partial<RosterFilter> | null;
    return {
      group: typeof parsed?.group === "string" ? parsed.group : "",
      species: typeof parsed?.species === "string" ? parsed.species : "",
    };
  } catch {
    return NO_ROSTER_FILTER;
  }
}
