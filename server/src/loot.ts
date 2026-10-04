// Pure rules for the SERVER-owned raid loot roll — no D1, no Hono. Unit-tested; the db
// layer (settleRaid) supplies the owned-item counts and persists the grant.
//
// A raid win rolls ONE drop. The rarity tier comes from LootTable.rollLootTier — imported
// from the CLIENT source rather than copied, so the thresholds recovered from the binary
// have exactly one definition and can't drift between the two sides. Within the chosen
// tier one ELIGIBLE entry is picked uniformly; if a tier has nothing eligible the roll
// walks DOWN to commoner tiers, as the binary does.
//
// Why this moved server-side: the drop decides real value (a boost, bonus gold, or a
// placeable), so a client naming its own prize is a mint. Note it was ALSO simply broken
// online — the client's grants routed through the spend-only economy and the removed
// inventory `grant`, so raid loot silently evaporated. This fixes both.
import { rollLootTier, pickLootEntry, lootEntryWeight, extraDropsFor } from "../../src/raid/LootTable";
import { raidLoot, dropEcon } from "./raidLootCatalog";
import { boostKeyForName } from "./boostCatalog";
import { raidBoostBundle } from "../../src/raid/lootBundles";

/** The literal loot entry that pays gold instead of an item. The client keys off this
 *  NAME (`drop === "Bonus Gold"`), NOT drops.json's `gold` flag — and it must, because
 *  Golden Dice and Golden Egg also carry `gold: true` yet are a boost and an item. */
export const BONUS_GOLD = "Bonus Gold";

/** Bonus gold paid by a "Bonus Gold" drop: the raid's level x 100, mirroring the binary's
 *  `getBonusGoldLootForStageLevel:` and the client's `raid.recommendedLevel * 100`. */
export const BONUS_GOLD_PER_LEVEL = 100;

export function bonusGoldFor(recLevel: number): number {
  return Math.max(0, Math.round(recLevel * BONUS_GOLD_PER_LEVEL));
}

/** What a rolled drop turns into. */
export type LootGrant =
  | { kind: "gold"; name: string; gold: number }
  | { kind: "boost"; name: string; key: string; qty: number }
  | { kind: "item"; name: string }
  | { kind: "none" };

/** How many of `name` the account already owns, for the unique/limit filters. */
export type OwnedCount = (name: string) => number;

/** The two item buckets a save keeps: unclaimed loot and the shed. */
export interface LootStorage {
  received?: Record<string, number>;
  stored?: Record<string, number>;
}

/** Build the `OwnedCount` the unique/limit filters need out of a save's item storage and
 *  its objects.
 *
 *  Counting Received ALONE silently disables `unique` altogether, which is what this
 *  exists to prevent: claiming a drop is how a player uses it, and claiming moves the
 *  item OUT of Received (into the shed, or onto the farm as an object), so a unique would
 *  go straight back on the table the moment it was actually taken. Ownership therefore
 *  spans all three places it can sit — Received, the shed, and the placed object it
 *  becomes via its `tile` link. Mirrors the binary's `doesOwnItem:` /
 *  `numberOfItemInStorageWithKey:` pair.
 *
 *  Pass every object the account holds, whatever its status: an object stored off-farm is
 *  owned just as much as a placed one. `tile` may be given explicitly for loot that isn't
 *  in drops.json (epic-boss prizes carry their own); it defaults to the drops.json link. */
export function ownedLootCounter(
  storage: LootStorage,
  objects: readonly { catalogKey: string }[]
): (name: string, tile?: string) => number {
  const owned = new Map<string, number>();
  for (const object of objects) {
    owned.set(object.catalogKey, (owned.get(object.catalogKey) ?? 0) + 1);
  }
  return (name, tile = dropEcon(name)?.tile) =>
    (storage.received?.[name] ?? 0) +
    (storage.stored?.[name] ?? 0) +
    (tile ? owned.get(tile) ?? 0 : 0);
}

/** An entry's share of an ordinary pick (see LootTable.lootEntryWeight): 0 = may not
 *  drop (a `unique` owned, a `limit` reached, or an `extraRate` entry that rolls on its
 *  own), 1 = normal. An entry with no drops.json metadata is allowed (fail-open matches
 *  the client, and every real entry has metadata). */
export function lootWeight(name: string, owned: OwnedCount): number {
  if (!name) return 0;
  const d = dropEcon(name);
  return d ? lootEntryWeight(d, owned(name)) : 1;
}

/** Is this loot entry still allowed to drop at all? Mirrors the client's filter. */
export function lootEligible(name: string, owned: OwnedCount): boolean {
  return lootWeight(name, owned) > 0;
}

/** Roll one drop for a win of `raidId` with `dice` loot-luck (Golden Dice spent).
 *
 *  `roll` and `pick` are injected uniform [0,1) samples — the caller supplies the SERVER's
 *  RNG (and tests supply fixed values). Mirrors RaidManager.rollLoot: choose the tier, then
 *  pick by weight among that tier's entries, walking down to commoner tiers when a tier is
 *  exhausted (LootTable.pickLootEntry). Returns null when nothing at all is eligible.
 *  (A Boss Statue is settled by the caller BEFORE this and replaces the roll — see
 *  src/raid/bossStatues.ts.) */
export function rollLoot(
  raidId: number,
  dice: number,
  owned: OwnedCount,
  roll: number,
  pick: number
): string | null {
  const table = raidLoot(raidId);
  if (!table) return null;
  return pickLootEntry(table, rollLootTier(roll, dice), (n) => lootWeight(n, owned), pick);
}

/** The EXTRA drops of a win — the faction banners, each rolling on its own `extraRate`
 *  (drops.json) in ADDITION to the ordinary drop, owned or not. `roll` is the SERVER's RNG
 *  (tests pass a fixed value). Each name is an item for the Received bucket. */
export function rollExtraLoot(raidId: number, roll: () => number): string[] {
  const table = raidLoot(raidId);
  return table ? extraDropsFor(table, (n) => dropEcon(n)?.extraRate ?? 0, roll) : [];
}

/** Resolve a rolled drop name into the grant it produces. Order mirrors the client:
 *  "Bonus Gold" pays gold; anything whose NAME matches a boost stacks into the boost
 *  inventory (in the raid bundle size — Insta-Grow drops ten at a time, see
 *  raidBoostBundle); everything else is an item for the Received bucket.
 *
 *  A BRAIN-paying item drop is refused here because invasion brains use their own
 *  server-pinned table and are credited only after deterministic replay verifies a win. */
export function resolveLoot(name: string | null, recLevel: number): LootGrant {
  if (!name) return { kind: "none" };
  if (name === BONUS_GOLD) return { kind: "gold", name, gold: bonusGoldFor(recLevel) };
  const key = boostKeyForName(name);
  if (key) return { kind: "boost", name, key, qty: raidBoostBundle(key) };
  const d = dropEcon(name);
  if (d?.brains) return { kind: "none" }; // see above — not reachable from any loot table
  return { kind: "item", name };
}
