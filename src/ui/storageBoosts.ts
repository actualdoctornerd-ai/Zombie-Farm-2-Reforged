import type { BoostDef } from "../assets";

export interface StorageBoostRow {
  def: BoostDef;
  count: number;
}

/** Storage is a catalog browser as well as an inventory view: retain catalog
 * order and fill absent inventory entries with a visible zero count. A boost that is
 * never sold (the Green Flower Ticket) shows only while you hold one — a zero row
 * would offer a "Buy" the Market cannot honour. */
export function storageBoostRows(
  catalog: readonly BoostDef[],
  inventory: readonly { key: string; count: number }[],
): StorageBoostRow[] {
  const counts = new Map(inventory.map((entry) => [entry.key, Math.max(0, entry.count)]));
  return catalog
    .filter((def) => !def.notForSale || (counts.get(def.key) ?? 0) > 0)
    .map((def) => ({ def, count: counts.get(def.key) ?? 0 }));
}
