// Pure rules for server-owned roster actions — no D1, no Hono. Unit-tested;
// db.applyRosterActions supplies the current roster + balance and persists effects.
//
// A `combine` is expressed as a `casualty` (the two parents) plus a `grant` (the
// result), so there's no separate combine type here.
import { isKnownZombie, isRewardOnlyZombie, MAX_MUTATION, MAX_INVASIONS } from "./rosterCatalog";

// NOTE: there is deliberately no public `grant`. A grant would let a modified client
// add any catalog zombie and then SELL it for server gold (money laundering). Units
// enter the server roster only through a trusted source, each of which pays for or
// earns the unit and names its key from a catalog rather than from the client:
//   • the one-time save migration (seedRoster),
//   • the server-validated Zombie Pot combine (combineStart/collect),
//   • a grown zombie crop (db.applyFarmActions harvest — planted at cost, grow-gated),
//   • a redeemed gift voucher (db.applyInventoryActions use — voucher bought at cost).
export type RosterAction =
  | { id: string; type: "sell"; unitId: string }
  | { id: string; type: "veteran"; unitIds: string[] } // survivors: invasions++
  | { id: string; type: "casualty"; unitIds: string[] } // dead: remove
  // Zombie Pot combine: start consumes both parents (records their keys); collect
  // grants the result, validated to be one of the two parent keys.
  | { id: string; type: "combineStart"; parentAId: string; parentBId: string }
  | { id: string; type: "combineCollect"; unitId: string; key: string; mutation?: number };

/** A validated unit to record. */
export type UnitPlan =
  | { ok: true; unitId: string; key: string; mutation: number; invasions: number }
  | { ok: false; error: string };

function boundInt(v: unknown, max: number): number {
  return Number.isInteger(v) && (v as number) >= 0 ? Math.min(max, v as number) : 0;
}

/** Validate a unit for a TRUSTED write (save migration seed). The unit id must be a
 *  non-empty string and the key a real catalog zombie; mutation/invasions are clamped
 *  to plausibility bounds. The unit's stats aren't stored (they derive from the key),
 *  so a fabricated stat line is irrelevant — only the key drives value, and it must be
 *  legal. Not reachable from a public action — only seedRoster calls it. */
export function validateUnit(
  unitId: unknown,
  key: unknown,
  mutation?: unknown,
  invasions?: unknown
): UnitPlan {
  if (typeof unitId !== "string" || !unitId) return { ok: false, error: "bad_unit" };
  if (typeof key !== "string" || !isKnownZombie(key)) return { ok: false, error: "bad_key" };
  if (isRewardOnlyZombie(key)) return { ok: false, error: "reward_only" };
  return {
    ok: true,
    unitId,
    key,
    mutation: boundInt(mutation, MAX_MUTATION),
    invasions: boundInt(invasions, MAX_INVASIONS),
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
