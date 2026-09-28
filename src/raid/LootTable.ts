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

/** Pick one entry from a raid's 6-tier loot table, starting at `tier` (from
 *  rollLootTier) and walking DOWN to commoner tiers when a tier has nothing to give.
 *  `pick` is a uniform [0,1) sample; both sides inject their own (the server's RNG
 *  online, Math.random offline), so this is the ONE definition of the pick.
 *
 *  `weightOf` is each entry's share of an ordinary pick: 1 for a normal entry, 0 for
 *  one that may not drop (a `unique` already owned, a `limit` reached), and a
 *  fraction for a REPEAT — an owned banner keeps `repeatWeight` of a normal pick.
 *  With every weight 1 this is exactly the binary's uniform pick. When a tier's
 *  weights sum to less than one whole pick (a tier holding only an owned banner),
 *  the unclaimed share falls through to the next tier down, so the repeat really is
 *  rarer rather than guaranteed whenever its tier comes up. Returns null only when
 *  nothing at all can drop. */
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
  /** Share of a normal pick an entry keeps once owned (0/absent = no change). */
  repeatWeight?: number;
}

/** An entry's weight for pickLootEntry, given how many the player already owns.
 *  Unknown entries (no metadata) are allowed — fail-open, as both sides always were. */
export function lootEntryWeight(rule: LootEntryRule | undefined, owned: number): number {
  if (!rule) return 1;
  if (rule.limit > 0 && owned >= rule.limit) return 0;
  if (owned > 0) {
    if (rule.unique) return 0;
    if (rule.repeatWeight && rule.repeatWeight > 0) return Math.min(1, rule.repeatWeight);
  }
  return 1;
}