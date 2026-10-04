// The invasion DROP TABLE: everything a win can pay, as numbers, for the "Drop table" panel
// on the invasion select screen (ui/panels/dropTable.ts).
//
// DISPLAY ONLY. Every figure here is derived from the same functions the settlement uses
// (rollLootTier's closed form, brainDropTable, raidZombieDropRate, the statue constants), so
// the panel cannot disagree with what a win pays; the module rolls nothing and grants
// nothing.
//
// What is deliberately NOT here: the brain and rare-zombie dry-streak floors. Those are
// invisible by design (see brainDrops.BRAIN_PITY_INVASIONS) — a floored drop must be
// indistinguishable from a lucky one.
import { lootTierChances } from "./LootTable";
import {
  BOSS_STATUE_RATE, BOSS_STATUE_WINS, GOLDEN_STATUE_RATE, GOLDEN_STATUE_WINS, bossStatueFor,
} from "./bossStatues";

/** What the six rarity tiers are called on screen. The source names none of them. */
export const LOOT_TIER_LABELS = [
  "Common", "Uncommon", "Rare", "Very rare", "Super rare", "Ultra rare",
] as const;

/** A 0..1 chance as a short percentage. Drop rates run from 0.5% to ~60%, so keep enough
 *  precision at the low end to tell 0.8% from 1% without printing "63.00%" at the high end. */
export function formatOdds(chance: number): string {
  const v = Math.max(0, chance) * 100;
  const s = v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
  return `${s.includes(".") ? s.replace(/\.?0+$/, "") : s}%`;
}

export interface LootRow {
  /** The drop's name as the loot table spells it ("Bonus Gold" is the gold bonus). */
  name: string;
  /** What this ONE row is worth per win, at the bracket's tier odds. Display-rounded by
   *  the caller. */
  chance: number;
  /** Units paid by one drop: Insta-Grow pays a bundle; "Bonus Gold" pays its gold. */
  qty: number;
}

export interface LootTierRow {
  /** 0-5, index into LOOT_TIER_LABELS. */
  tier: number;
  /** The chance this tier is the one a win's single item roll lands on (empty tiers
   *  hand their share down, exactly as pickLootEntry's walk-down does). */
  chance: number;
  rows: LootRow[];
}

export interface DropTableInput {
  /** raids.json `loot`: six tiers of names. */
  loot: readonly (readonly string[])[];
  /** Golden Dice spent — the loot-luck bracket. */
  dice: number;
  /** Faction banners and the like roll on their own, at this per-win chance, and never take
   *  a slot in the tier pick (drops.json `extraRate`; LootTable.extraDropsFor). 0 = ordinary. */
  extraRateOf: (name: string) => number;
  /** How many of a boost one drop pays (lootBundles.raidBoostBundle by NAME). */
  bundleOf: (name: string) => number;
  /** What "Bonus Gold" pays: the raid's recommended level x 100. */
  bonusGold: number;
}

export interface ItemLootTable {
  /** Tiers a win can land on at this luck, rarest first; zero-chance tiers are left out. */
  tiers: LootTierRow[];
  /** Entries that roll separately on top of the ordinary drop, each at its own chance. */
  extras: LootRow[];
}

/** The single weighted item drop of a win, laid out per tier and per item.
 *
 *  Mirrors pickLootEntry on a FRESH account (nothing owned): a tier is chosen from the
 *  luck bracket's odds (lootTierChances), then one entry in it uniformly — a name listed
 *  twice counts twice. A tier left with no ordinary entries hands its whole share to the
 *  next tier down. What it cannot show is the player's own inventory: an item they already
 *  own that is `unique` (or at its `limit`) stops dropping, and its share goes to the
 *  tier's other items. The panel says so in a footnote. */
export function itemLootTable(input: DropTableInput): ItemLootTable {
  const { loot, dice, extraRateOf, bundleOf, bonusGold } = input;
  const odds = lootTierChances(dice);
  const extras: LootRow[] = [];
  const seenExtra = new Set<string>();
  const ordinary: string[][] = loot.map((names) => {
    const kept: string[] = [];
    for (const name of names) {
      if (!name) continue;
      const rate = extraRateOf(name);
      if (rate > 0) {
        if (!seenExtra.has(name)) {
          seenExtra.add(name);
          extras.push({ name, chance: Math.min(1, rate), qty: 1 });
        }
      } else kept.push(name);
    }
    return kept;
  });

  // Walk rarest -> commonest, carrying the share of any tier with nothing to give down to
  // the next populated one.
  const share = new Array<number>(ordinary.length).fill(0);
  let carry = 0;
  for (let t = ordinary.length - 1; t >= 0; t--) {
    const own = (odds[t] ?? 0) + carry;
    if (ordinary[t].length) { share[t] = own; carry = 0; } else carry = own;
  }

  const tiers: LootTierRow[] = [];
  for (let t = ordinary.length - 1; t >= 0; t--) {
    if (share[t] <= 1e-9) continue;
    const counts = new Map<string, number>();
    for (const name of ordinary[t]) counts.set(name, (counts.get(name) ?? 0) + 1);
    const rows: LootRow[] = [...counts].map(([name, n]) => ({
      name,
      chance: share[t] * n / ordinary[t].length,
      qty: name === "Bonus Gold" ? bonusGold : bundleOf(name),
    }));
    tiers.push({ tier: t, chance: share[t], rows });
  }
  return { tiers, extras };
}

export interface StatueRule {
  name: string;
  goldenName: string;
  stoneWins: number;
  goldenWins: number;
  stoneRate: number;
  goldenRate: number;
}

/** The invasion's boss statues (bossStatues.ts), or null where it carves none — the four
 *  dual invasions and the epic bosses. */
export function statueRule(raidId: number): StatueRule | null {
  const s = bossStatueFor(raidId);
  return s ? {
    name: s.name,
    goldenName: s.goldenName,
    stoneWins: BOSS_STATUE_WINS,
    goldenWins: GOLDEN_STATUE_WINS,
    stoneRate: BOSS_STATUE_RATE,
    goldenRate: GOLDEN_STATUE_RATE,
  } : null;
}
