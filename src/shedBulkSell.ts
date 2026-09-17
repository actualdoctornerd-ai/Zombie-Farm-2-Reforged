/** Turning a shed multi-select into the exact stored copies a sale consumes.
 *
 *  The Storage grid selects SLOTS, and a slot only knows its catalog key — three
 *  Hedges are three identical-looking slots. The sale itself has to name an
 *  instance: both the count projection and the identity projection are consumed
 *  together (see storedObjectOwnership.ts), and two copies of one key can be
 *  worth different gold (one bought with brains, one an award-only raid prize).
 *  So the plan walks each key's identities in shed order and prices every copy on
 *  its own, rather than multiplying one price by a count. */

/** One stored copy, resolved to the object the sale will actually consume. */
export interface StoredSaleLot {
  key: string;
  instanceId: string;
  /** Gold this copy pays out. */
  refund: number;
}

export interface StoredSalePlan {
  lots: StoredSaleLot[];
  /** Selected copies that no longer resolve to a stored object — the shed moved
   *  underneath the selection. They are dropped, never guessed at. */
  missing: number;
  /** Gold the resolvable lots pay in total. */
  gold: number;
}

/** Resolve `keys` (one entry per selected slot; repeat a key to sell several
 *  copies) into priced lots. `idsFor` returns a key's stored instance ids in shed
 *  order; each id is handed out at most once, so selecting two Hedges sells two
 *  different Hedges. */
export function planStoredSale(
  keys: readonly string[],
  idsFor: (key: string) => readonly string[],
  refundOf: (key: string, instanceId: string) => number,
): StoredSalePlan {
  const wanted = new Map<string, number>();
  for (const key of keys) wanted.set(key, (wanted.get(key) ?? 0) + 1);

  const lots: StoredSaleLot[] = [];
  let missing = 0;
  let gold = 0;
  for (const [key, count] of wanted) {
    const ids = idsFor(key);
    for (let i = 0; i < count; i++) {
      const instanceId = ids[i];
      if (instanceId === undefined) { missing++; continue; }
      const refund = refundOf(key, instanceId);
      lots.push({ key, instanceId, refund });
      gold += refund;
    }
  }
  return { lots, missing, gold };
}

/** "3 x Hedge, 2 x Crate and 2 more" — the line the confirm dialog shows so a
 *  bulk sale names what it is about to destroy. Ordered by count, then by name. */
export function describeStoredSale(
  lots: readonly StoredSaleLot[],
  nameOf: (key: string) => string,
  limit = 4,
): string {
  const counts = new Map<string, number>();
  for (const lot of lots) counts.set(lot.key, (counts.get(lot.key) ?? 0) + 1);
  const rows = [...counts].map(([key, count]) => ({ name: nameOf(key), count }));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const shown = rows.slice(0, limit).map((r) => (r.count > 1 ? `${r.count} \u00d7 ${r.name}` : r.name));
  const hidden = rows.slice(limit).reduce((sum, r) => sum + r.count, 0);
  if (hidden) shown.push(`${hidden} more`);
  return shown.join(", ");
}
