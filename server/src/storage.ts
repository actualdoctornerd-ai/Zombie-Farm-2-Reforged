// Pure rules for server-owned item storage (the Received bucket + the shed) — no D1, no
// Hono. Unit-tested; db.applyStorageActions supplies the current counts and persists.
//
// These are MOVES, not grants: every action takes an item the server already recorded you
// owning and puts it somewhere else (or turns it into the boost/placeable it represents).
// Nothing here can create value — the only way an item enters storage is a server-rolled
// raid drop (loot.ts) or the one-time save import.
//
// Why it exists: raid loot now lands server-side, so claiming/placing it has to be a
// server action too. The old client path turned a claimed Received boost into an
// inventory `grant` — the action Phase 0 removed — so online it deleted the item and
// granted nothing.
import { boostKeyForName } from "./boostCatalog";
import { dropEcon } from "./raidLootCatalog";

export type StorageAction =
  // Received -> the thing it represents. A boost stacks into the boost inventory; a
  // placeable becomes an owned object (ready to place). Consumes the Received entry.
  | { id: string; type: "claim"; name: string }
  // Shed <-> owned objects: pack a placed object away, or take one back out.
  | { id: string; type: "store"; name: string }
  | { id: string; type: "retrieve"; name: string };

export type StoragePlan =
  | { ok: true; kind: "boost"; boostKey: string }
  | { ok: true; kind: "object"; objectKey: string }
  | { ok: false; error: string };

/** Claim a Received entry. `have` is how many of it sit in the Received bucket.
 *
 *  A BRAIN entry is refused: no raid loot table contains one today (the brain drop is a
 *  separate roll that stays deferred while `win` is client-asserted), so a brain entry in
 *  Received could only have come from a pre-T2 save — and honouring it would let an
 *  edited blob mint premium currency. */
export function planClaim(name: string, have: number): StoragePlan {
  if (!name) return { ok: false, error: "bad_item" };
  if (have < 1) return { ok: false, error: "none_owned" };
  const boostKey = boostKeyForName(name);
  if (boostKey) return { ok: true, kind: "boost", boostKey };
  const d = dropEcon(name);
  if (!d) return { ok: false, error: "bad_item" };
  if (d.brains) return { ok: false, error: "brains_deferred" };
  if (!d.tile) return { ok: false, error: "not_claimable" }; // a trophy (e.g. Rusty Fragment)
  return { ok: true, kind: "object", objectKey: d.tile };
}

/** Pack an owned object away into the shed, or take one back out. `haveObject` /
 *  `haveStored` are the counts on each side; the move is refused if the source is empty.
 *  `cap`/`used` bound the shed (its size comes from the shed the account owns). */
export function planStore(name: string, haveObject: number, used: number, cap: number): StoragePlan {
  const d = dropEcon(name);
  if (!d?.tile) return { ok: false, error: "bad_item" };
  if (haveObject < 1) return { ok: false, error: "none_owned" };
  if (used >= cap) return { ok: false, error: "shed_full" };
  return { ok: true, kind: "object", objectKey: d.tile };
}

export function planRetrieve(name: string, haveStored: number): StoragePlan {
  const d = dropEcon(name);
  if (!d?.tile) return { ok: false, error: "bad_item" };
  if (haveStored < 1) return { ok: false, error: "none_owned" };
  return { ok: true, kind: "object", objectKey: d.tile };
}
