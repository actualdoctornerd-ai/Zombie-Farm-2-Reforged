/**
 * Resolve a selection captured by the army picker against the roster that exists
 * after pending server commands have settled. Optimistic harvests can exchange a
 * local id for a server id; rejected commands can remove the optimistic unit.
 */
export function reconcilePartySelection<T extends { id: string }>(
  selectedIds: string[],
  current: T[],
  authoritativeId: (id: string) => string,
  cap: number
): { ids: string[]; party: T[]; missingIds: string[] } {
  const selected = [...new Set(selectedIds)].slice(0, Math.max(0, cap));
  const byId = new Map(current.map((unit) => [unit.id, unit]));
  const ids: string[] = [];
  const party: T[] = [];
  const missingIds: string[] = [];

  for (const originalId of selected) {
    const id = authoritativeId(originalId);
    const unit = byId.get(id);
    if (!unit) {
      missingIds.push(originalId);
      continue;
    }
    ids.push(id);
    party.push(unit);
  }

  return { ids, party, missingIds };
}

/** Fill an army selection from a remembered order without allowing zombies that
 * are no longer eligible to consume invisible slots. */
export function fillPartySelection(
  selectedIds: string[],
  preferredIds: string[],
  eligibleIds: string[],
  cap: number
): string[] {
  const eligible = new Set(eligibleIds);
  const result: string[] = [];
  for (const id of [...selectedIds, ...preferredIds, ...eligibleIds]) {
    if (result.length >= Math.max(0, cap)) break;
    if (eligible.has(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

/** Put previously-used zombies first, in their saved attack order, then append
 * every other eligible zombie in its existing order (the roster's harvest order). */
export function orderPartyRoster<T extends { id: string }>(
  eligible: T[],
  preferredIds: string[],
): T[] {
  const byId = new Map(eligible.map((unit) => [unit.id, unit]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of [...preferredIds, ...eligible.map((unit) => unit.id)]) {
    const unit = byId.get(id);
    if (unit && !seen.has(id)) {
      ordered.push(unit);
      seen.add(id);
    }
  }
  return ordered;
}
