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
import { rollLootTier } from "../../src/raid/LootTable";
import { raidLoot, dropEcon } from "./raidLootCatalog";
import { boostKeyForName } from "./boostCatalog";

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
  | { kind: "boost"; name: string; key: string }
  | { kind: "item"; name: string }
  | { kind: "none" };

/** How many of `name` the account already owns, for the unique/limit filters. */
export type OwnedCount = (name: string) => number;

/** Is this loot entry still allowed to drop? Mirrors the client's eligibleIn(): a
 *  `unique` entry is filtered out once owned at all, and a `limit`ed one once the cap is
 *  reached. An entry with no drops.json metadata is allowed (fail-open matches the
 *  client, and every real entry has metadata). */
export function lootEligible(name: string, owned: OwnedCount): boolean {
  if (!name) return false;
  const d = dropEcon(name);
  if (!d) return true;
  if (d.unique && owned(name) > 0) return false;
  if (d.limit > 0 && owned(name) >= d.limit) return false;
  return true;
}

/** Roll one drop for a win of `raidId` with `dice` loot-luck (Golden Dice spent).
 *
 *  `roll` and `pick` are injected uniform [0,1) samples — the caller supplies the SERVER's
 *  RNG (and tests supply fixed values). Mirrors RaidManager.rollLoot: choose the tier,
 *  then pick uniformly among that tier's eligible entries, walking down to commoner tiers
 *  when a tier is exhausted. Returns null when nothing at all is eligible. */
export function rollLoot(
  raidId: number,
  dice: number,
  owned: OwnedCount,
  roll: number,
  pick: number
): string | null {
  const table = raidLoot(raidId);
  if (!table) return null;
  let tier = rollLootTier(roll, dice);
  for (; tier >= 0; tier--) {
    const items = (table[tier] ?? []).filter((n) => lootEligible(n, owned));
    if (items.length) return items[Math.min(items.length - 1, Math.floor(pick * items.length))];
  }
  return null;
}

/** Resolve a rolled drop name into the grant it produces. Order mirrors the client:
 *  "Bonus Gold" pays gold; anything whose NAME matches a boost stacks into the boost
 *  inventory; everything else is an item for the Received bucket.
 *
 *  A BRAIN-paying item drop is refused here because invasion brains use their own
 *  server-pinned table and are credited only after deterministic replay verifies a win. */
export function resolveLoot(name: string | null, recLevel: number): LootGrant {
  if (!name) return { kind: "none" };
  if (name === BONUS_GOLD) return { kind: "gold", name, gold: bonusGoldFor(recLevel) };
  const key = boostKeyForName(name);
  if (key) return { kind: "boost", name, key };
  const d = dropEcon(name);
  if (d?.brains) return { kind: "none" }; // see above — not reachable from any loot table
  return { kind: "item", name };
}
