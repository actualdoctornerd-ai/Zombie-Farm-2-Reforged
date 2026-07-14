// Pure rules for server-owned roster actions — no D1, no Hono. Unit-tested;
// db.applyRosterActions supplies the current roster + balance and persists effects.
//
// A `combine` is expressed as a `casualty` (the two parents) plus a `grant` (the
// result), so there's no separate combine type here.
import { isKnownZombie, MAX_MUTATION, MAX_INVASIONS } from "./rosterCatalog";

export type RosterAction =
  | { id: string; type: "sell"; unitId: string }
  | { id: string; type: "grant"; unitId: string; key: string; mutation?: number; invasions?: number }
  | { id: string; type: "veteran"; unitIds: string[] } // survivors: invasions++
  | { id: string; type: "casualty"; unitIds: string[] } // dead: remove
  // Zombie Pot combine: start consumes both parents (records their keys); collect
  // grants the result, validated to be one of the two parent keys.
  | { id: string; type: "combineStart"; parentAId: string; parentBId: string }
  | { id: string; type: "combineCollect"; unitId: string; key: string; mutation?: number };

/** A validated unit to record. */
export type GrantPlan =
  | { ok: true; unitId: string; key: string; mutation: number; invasions: number }
  | { ok: false; error: string };

function boundInt(v: unknown, max: number): number {
  return Number.isInteger(v) && (v as number) >= 0 ? Math.min(max, v as number) : 0;
}

/** Validate a grant: the unit id must be a non-empty string and the key a real
 *  catalog zombie; mutation/invasions are clamped to plausibility bounds. The unit's
 *  stats aren't stored (they derive from the key), so a fabricated stat line is
 *  irrelevant — only the key drives value, and it must be legal. */
export function planGrant(a: Extract<RosterAction, { type: "grant" }>): GrantPlan {
  if (typeof a.unitId !== "string" || !a.unitId) return { ok: false, error: "bad_unit" };
  if (!isKnownZombie(a.key)) return { ok: false, error: "bad_key" };
  return {
    ok: true,
    unitId: a.unitId,
    key: a.key,
    mutation: boundInt(a.mutation, MAX_MUTATION),
    invasions: boundInt(a.invasions, MAX_INVASIONS),
  };
}

/** Bound a list of unit ids (dedup, drop non-strings, cap length) for a veteran /
 *  casualty batch. */
export function cleanIds(ids: unknown, cap = 64): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  for (const x of ids) {
    if (typeof x === "string" && x && !seen.has(x)) seen.add(x);
    if (seen.size >= cap) break;
  }
  return [...seen];
}
