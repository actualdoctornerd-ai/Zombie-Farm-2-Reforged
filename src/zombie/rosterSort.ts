// ---------------------------------------------------------------------------
// My-Zombies roster ordering
// ---------------------------------------------------------------------------
// Purely a display choice over the owned roster — nothing here touches the save,
// so a re-order is never a mutation the server has to hear about. Kept out of the
// DOM code so the comparison is testable.
//
// The stat modes sort by the DISPLAYED total (statBreakdown), not the raw stat:
// the card shows mutation + veterancy + self-ability bonuses folded in, and a list
// that ranked by the raw number would disagree with the tiles the player is reading.
// Every mode falls back to name, then id, so the order is total and re-rendering
// the panel never reshuffles equal rows.
import { STATS } from "./traits";
import type { AbilitySlotGate } from "./abilities";
import { statBreakdown, type StatSource } from "./statDisplay";

export type ZombieSort = "default" | "str" | "dex" | "con" | "focus" | "invasions" | "name";

/** Anything sortable here: the stat source the breakdown needs, plus identity. */
export type SortableZombie = StatSource & { name: string; id?: string };

// Stat labels come from STATS so the picker can never drift from the tiles.
export const ZOMBIE_SORTS: { id: ZombieSort; label: string }[] = [
  { id: "default", label: "Default" },
  ...STATS.map((s) => ({ id: s.key as ZombieSort, label: s.label })),
  { id: "invasions", label: "Invasions" },
  { id: "name", label: "Name" },
];

export const DEFAULT_ZOMBIE_SORT: ZombieSort = "default";

export function isZombieSort(value: unknown): value is ZombieSort {
  return ZOMBIE_SORTS.some((s) => s.id === value);
}

/** Case-insensitive name order; unnamed zombies sink below named ones. */
function byName(a: SortableZombie, b: SortableZombie): number {
  const an = a.name?.trim() ?? "";
  const bn = b.name?.trim() ?? "";
  if (!an !== !bn) return an ? -1 : 1;
  return (
    an.localeCompare(bn, undefined, { sensitivity: "base" }) ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

/** Sort descending by `value` (best first), breaking ties by name. The value is
 *  computed ONCE per row rather than inside the comparator — a stat total costs a
 *  full breakdown, and a comparator would recompute it O(n log n) times. */
function byValueDesc<T extends SortableZombie>(rows: T[], value: (row: T) => number): T[] {
  return rows
    .map((row) => ({ row, v: value(row) }))
    .sort((a, b) => b.v - a.v || byName(a.row, b.row))
    .map((d) => d.row);
}

/** Order the owned roster for display. Never mutates the input — the roster keeps
 *  its own (creation) order, which is also what the "Default" mode shows. */
export function sortZombies<T extends SortableZombie>(
  roster: readonly T[],
  sort: ZombieSort,
  slotUnlocked: AbilitySlotGate
): T[] {
  const rows = [...roster];
  switch (sort) {
    case "name":
      return rows.sort(byName);
    case "invasions":
      return byValueDesc(rows, (z) => z.invasions);
    case "str":
    case "dex":
    case "con":
    case "focus":
      return byValueDesc(rows, (z) => statBreakdown(z, sort, slotUnlocked).total);
    case "default":
    default:
      return rows; // creation order, exactly as the roster is held
  }
}
