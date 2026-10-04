// Loot rarity-tier selection — recovered from the iOS binary
// (`ZFFightSummary rollForDrop:`, method BINARY_RE_METHODOLOGY.md).
//
// A raid win rolls ONE item drop. Each raid's `loot` is 6 rarity tiers
// (tier 0 = common "Bonus Gold" … tier 5 = rarest signature decoration). The
// tier is chosen by a percentage roll against cumulative thresholds; the whole
// distribution shifts RARER as the loot-luck bonus (Golden Dice spent) rises.
// Within the chosen tier, one eligible alternative is picked uniformly.
//
// Ground truth of the thresholds (roll r in [0,1), bonus B = dice spent):
//   B = 0 : r<.09→t0, r<.24→t1, r<.84→t2, r<.92→t3, else t4   (tiers 0–4)
//   B = 1 : r<.14→t1, r<.74→t2, r<.84→t3, r<.92→t4, else t5   (tiers 1–5)
//   B = 2 : r<.59→t2, r<.79→t3, r<.89→t4, else t5             (tiers 2–5)
//   B ≥ 3 : n=B-3; r' = r + 0.10n; d = 0.9^n;
//           r'<0.39d→t3, r'<0.79d→t4, else t5                  (tiers 3–5)
// So one die makes the common tiers unreachable and puts tier 5 on the table;
// each further die keeps compressing the roll toward the rarest tiers.

type Threshold = readonly [cum: number, tier: number];

// Ascending cumulative thresholds per bracket + the fall-through tier.
const BRACKET_0: readonly Threshold[] = [
  [0.09, 0],
  [0.24, 1],
  [0.84, 2],
  [0.92, 3],
];
const BRACKET_1: readonly Threshold[] = [
  [0.14, 1],
  [0.74, 2],
  [0.84, 3],
  [0.92, 4],
];
const BRACKET_2: readonly Threshold[] = [
  [0.59, 2],
  [0.79, 3],
  [0.89, 4],
];

function pickFromTable(roll: number, table: readonly Threshold[], fallthrough: number): number {
  for (const [cum, tier] of table) if (roll < cum) return tier;
  return fallthrough;
}

/** Choose a loot rarity tier (0–5) for a win. `roll` is a uniform [0,1) sample;
 *  `bonus` is the loot-luck bracket (Golden Dice spent, 0 = none). Mirrors the
 *  binary's `rollForDrop:` tier selection exactly. */
export function rollLootTier(roll: number, bonus: number): number {
  const b = Math.max(0, Math.floor(bonus));
  if (b === 0) return pickFromTable(roll, BRACKET_0, 4);
  if (b === 1) return pickFromTable(roll, BRACKET_1, 5);
  if (b === 2) return pickFromTable(roll, BRACKET_2, 5);
  // Bracket 3+: over-luck. Push the roll up by 0.10 per extra die and decay the
  // tier-3/4 windows by 0.9 each, so tier 5 grows ever more likely (tiers 3–5).
  const n = b - 3;
  const rp = roll + 0.1 * n;
  const decay = Math.pow(0.9, n);
  if (rp < 0.39 * decay) return 3;
  if (rp < 0.79 * decay) return 4;
  return 5;
}

/** The chance of each rarity tier (index 0-5, summing to 1) at a luck bracket — the closed
 *  form of rollLootTier, for DISPLAY (the drop table). Pinned against rollLootTier itself by
 *  LootTable.test.ts, so the two cannot drift. */
export function lootTierChances(bonus: number): number[] {
  const b = Math.max(0, Math.floor(bonus));
  const out = [0, 0, 0, 0, 0, 0];
  const table = b === 0 ? BRACKET_0 : b === 1 ? BRACKET_1 : b === 2 ? BRACKET_2 : null;
  if (table) {
    let prev = 0;
    for (const [cum, tier] of table) { out[tier] += cum - prev; prev = cum; }
    out[b === 0 ? 4 : 5] += 1 - prev;
    return out;
  }
  const n = b - 3;
  const decay = Math.pow(0.9, n);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const c3 = clamp(0.39 * decay - 0.1 * n);
  const c4 = clamp(0.79 * decay - 0.1 * n);
  out[3] = c3;
  out[4] = c4 - c3;
  out[5] = 1 - c4;
  return out;
}

/** Pick one entry from a raid's 6-tier loot table, starting at `tier` (from
 *  rollLootTier) and walking DOWN to commoner tiers when a tier has nothing to give.
 *  `pick` is a uniform [0,1) sample; both sides inject their own (the server's RNG
 *  online, Math.random offline), so this is the ONE definition of the pick.
 *
 *  `weightOf` is each entry's share of an ordinary pick: 1 for a normal entry, 0 for
 *  one that may not drop (a `unique` already owned, a `limit` reached, an `extraRate`
 *  entry that rolls on its own), and a fraction for a partial share. With every weight
 *  1 this is exactly the binary's uniform pick. When a tier's weights sum to less than
 *  one whole pick, the unclaimed share falls through to the next tier down. Returns
 *  null only when nothing at all can drop. */
export function pickLootEntry(
  table: readonly (readonly string[])[],
  tier: number,
  weightOf: (name: string) => number,
  pick: number,
): string | null {
  let p = Math.min(Math.max(pick, 0), 1 - Number.EPSILON);
  let fallback: string | null = null;
  for (let t = Math.min(tier, table.length - 1); t >= 0; t--) {
    const entries: [string, number][] = [];
    let total = 0;
    for (const name of table[t] ?? []) {
      const w = name ? Math.max(0, weightOf(name)) : 0;
      if (w > 0) { entries.push([name, w]); total += w; }
    }
    if (!entries.length) continue;
    fallback ??= entries[0][0];
    const span = Math.max(1, total);
    let x = p * span;
    for (const [name, w] of entries) {
      if (x < w) return name;
      x -= w;
    }
    // A whole-pick tier always pays out; this only catches float rounding at its end.
    if (total >= 1) return entries[entries.length - 1][0];
    // Only reachable when total < 1: the rest of the pick walks down a tier, rescaled
    // so the sample stays uniform there.
    p = (p - total) / (1 - total);
  }
  // Every tier below came up empty: better the rare repeat than nothing at all.
  return fallback;
}

/** Drop metadata the pick weight depends on (drops.json / the server's DROPS). */
export interface LootEntryRule {
  unique: boolean;
  limit: number;
  /** Per-win chance of an EXTRA drop on top of the ordinary roll (the faction banners).
   *  An entry with one never takes a slot in the pick. */
  extraRate?: number;
}

/** An entry's weight for pickLootEntry, given how many the player already owns.
 *  Unknown entries (no metadata) are allowed — fail-open, as both sides always were. */
export function lootEntryWeight(rule: LootEntryRule | undefined, owned: number): number {
  if (!rule) return 1;
  if (rule.extraRate && rule.extraRate > 0) return 0; // rolls on its own — see extraDropsFor
  if (rule.limit > 0 && owned >= rule.limit) return 0;
  if (owned > 0 && rule.unique) return 0;
  return 1;
}

/** The EXTRA drops of a win: every entry in the raid's loot table that carries an
 *  `extraRate` (the faction banners) rolls independently at that chance and pays on top of
 *  the ordinary drop, however often it has dropped before. `roll` supplies a fresh uniform
 *  [0,1) sample per entry (the server's RNG online, Math.random offline), so this is the
 *  ONE definition of the rule for both sides. An entry listed twice in a table rolls once. */
export function extraDropsFor(
  table: readonly (readonly string[])[],
  rateOf: (name: string) => number,
  roll: () => number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tier of table) {
    for (const name of tier) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const rate = rateOf(name);
      if (rate > 0 && roll() < rate) out.push(name);
    }
  }
  return out;
}