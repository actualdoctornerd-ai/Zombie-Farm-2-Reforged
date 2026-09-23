// Four kinds of army a real account actually has.
//
// The era grid (archetypes.ts) asks "can the best roster of this point in the game clear
// this fight". That is the ceiling question, and it is only half of what matters: most
// players are not carrying the best roster of their own level. They are carrying the one
// they built a while ago, or the one the Pot has not got round to yet. The gap between
// those and the ceiling is what difficulty FEELS like, and nothing in the harness could
// express it until now.
//
// So a cohort is a way of answering ONE question — "what is in this player's army?" —
// along the two axes an account actually drifts on:
//
//   · MUTATION. The Pot is slow and does not take requests, so an unmutated line is the
//     honest default and a fully mutated one is an achievement. Mutations are flat ADDS
//     applied last (+5 str / +4 dex / +9 con best-in-slot), so they matter most to the
//     weakest bodies — which is exactly the interaction a single power multiplier lost.
//   · AGE. A zombie bought ten levels ago is not merely weaker: its COLOUR CLASS is
//     lower, and a unit shows ability tiers 1..its class rank (`activeAbilities`). An
//     outdated Red zombie shows three abilities however much the account has unlocked.
//     Age therefore costs stats AND kit, and the harness gets that for free by picking
//     species from an older catalog slice rather than by scaling anything.
//
// "LEVEL APPROPRIATE" is read as the owner stated it: not one canonical best species per
// class, but any of the few strongest available to that class at the time — so the
// variation within a cohort is a real spread of plausible armies, not one army repeated.
import { seededRandom } from "../RaidCatalog";
import type { Era } from "./archetypes";
import {
  enforceFloor, fitTo, NAMED_MIXES, orderOf, ORDER_POLICIES, sampleComposition,
  type Composition,
} from "./composition";
import { appropriateAt, bestCarrierOf, isHealer, type Group, type RosterSpec } from "./roster";

// "Level appropriate" lives in roster.ts (`appropriateAt`), because the difficulty grid
// and the cohort sweep have to mean the same thing by it. It is the few strongest species
// of a class a player at that level could have OBTAINED — which since this was corrected
// includes the specials, and post-level-25 means almost exclusively the specials.

export interface Cohort {
  id: string;
  label: string;
  /** Whether the Pot has been through this army. */
  mutation: "best" | "none";
  /** How many levels behind the account the ARMY is, as an inclusive range. A roster is
   *  drawn from the catalog as it stood that far back. */
  lag: readonly [number, number];
  /** Most copies of any one species. Unset = a min-maxed ceiling roster that may field
   *  twenty of the best thing it owns. */
  maxPerSpecies?: number;
}

/** Abilities a player deliberately builds FOR, and how often a sampled army does.
 *
 *  Owner, 2026-09-21: "people may still use the mini zombies with explosion, or garden
 *  zombies with revive … people may want more revives in a fight like the Pirates, where
 *  several zombie deaths are expected if they're not careful." Both of those are picks
 *  AGAINST the stat ranking — at the top of the ladder the Doctors trade Resurrect for a
 *  laser and the Zombug and Proto trade Explode for Resurrect and Smash — so a sampler
 *  that only ever takes the strongest species of a class can never produce them.
 *
 *  `appropriateAt` already keeps the best carrier of an orphaned ability on the
 *  shortlist; this decides how often a sample reaches for it on purpose. */
const BUILD_FOR: readonly { ability: string; group: Group; chance: number }[] = [
  { ability: "ressurect", group: "Garden", chance: 0.35 },
  { ability: "ressurect", group: "Small", chance: 0.25 },
  { ability: "explode", group: "Small", chance: 0.35 },
];

export const COHORTS: readonly Cohort[] = [
  {
    id: "powerful",
    label: "Powerful — current, mutated, Master",
    mutation: "best", lag: [0, 0],
  },
  {
    id: "unmutated",
    label: "Unmutated — current, no Pot, Master",
    mutation: "none", lag: [0, 0],
  },
  {
    id: "outdated",
    label: "Outdated — army from 5–10 levels ago, mutated",
    mutation: "best", lag: [5, 10],
  },
  {
    id: "veryOutdated",
    label: "Very outdated — army from 10–15 levels ago, mutated",
    mutation: "best", lag: [10, 15],
  },
  {
    // The realistic middle, and the reason it exists: every cohort above may stack twenty
    // copies of one species, but an Epic event pays ONE prize per rung and an invasion
    // drop is 1–4.5%, so an army of twenty Vagabonds is a ceiling rather than a player.
    // Capped at two, a roster has to reach down its class shortlists — which is also how
    // the ability picks (Resurrect, Explode) get on the field at all.
    id: "capped",
    label: "Capped — current, mutated, at most 2 of any species",
    mutation: "best", lag: [0, 0], maxPerSpecies: 2,
  },
];

export interface CohortRoster {
  id: string;
  cohort: string;
  era: string;
  /** How the composition was laid out — one of ORDER_POLICIES. */
  order: string;
  /** Which named mix it came from, or "random". */
  mix: string;
  /** The account level the army is drawn from — the era's level minus this sample's lag. */
  catalogLevel: number;
  spec: RosterSpec;
}

/** Sample `count` distinct plausible armies for one cohort at one era.
 *
 *  Five things are re-rolled independently, because they are five separate decisions two
 *  players at the same level with the same idea of a good army would make differently:
 *
 *    1. the COMPOSITION — how many of each class. Half the samples take a named mix
 *       (roster shapes with an argument behind them, including the owner's "20 normals"
 *       and "8 brute, 8 mini, 2 headless, 2 garden"); half draw a random lopsided one.
 *    2. the ORDER — how that composition is laid out in the deploy queue.
 *    3. the SIZE — what the farm supports at this era.
 *    4. the AGE — how far back the catalog slice is, within the cohort's lag range.
 *    5. the SPECIES per slot — one of the class's level-appropriate options, sometimes
 *       chosen for an ABILITY rather than for stats (see BUILD_FOR).
 *
 *  Seeded, so a cohort's sample is the same set every run and a difficulty number from
 *  one ruleset can be compared with the next. */
export function sampleCohort(
  cohort: Cohort,
  era: Era,
  count: number,
  seed = "cohort",
  /** Force every sampled army to this many bodies, instead of drawing from the era's own
   *  sizes. The strength sweep pins it, because the Strength Ladder sums over the roster
   *  and so bundles ARMY SIZE into the same number as army quality — an eight-zombie
   *  roster of Omegas and a twenty-zombie roster of Blues land in the same band and
   *  behave nothing alike. Holding the size still makes the column mean one thing. */
  sizeOverride?: number
): CohortRoster[] {
  const rand = seededRandom(`${seed}:${cohort.id}:${era.id}`);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];
  const mixNames = Object.keys(NAMED_MIXES);
  // The account's own level is what the FIGHT is scaled against and what the stat ramp
  // reads; only the catalog the army was bought from moves back.
  const accountLevel = era.base.playerLevel ?? 45;

  const out: CohortRoster[] = [];
  const seen = new Set<string>();
  // Sampling with rejection rather than enumerating the product: the space of
  // composition x order x size x age x species is far larger than any useful sample, and
  // a duplicate says nothing twice.
  for (let attempt = 0; attempt < count * 60 && out.length < count; attempt++) {
    const size = sizeOverride ?? pick(era.sizes);
    const lag = cohort.lag[0] + Math.floor(rand() * (cohort.lag[1] - cohort.lag[0] + 1));
    // An account cannot have bought anything before level 1, so a deep lag at an early
    // era simply bottoms out — and that is the honest answer: a level-12 player does not
    // have a fifteen-level-old army.
    const catalogLevel = Math.max(1, accountLevel - lag);

    const named = rand() < 0.5;
    const mixName = named ? pick(mixNames) : "random";
    const wanted: Composition = named
      ? fitTo(NAMED_MIXES[mixName], size)
      : sampleComposition(rand, size, catalogLevel);
    // A named mix can ask for a class this account has not unlocked. Drop those and
    // re-fit, so an early roster is short of classes rather than short of bodies.
    const composition: Composition = {};
    for (const [g, n] of Object.entries(wanted)) {
      if (n && appropriateAt(g as Group, catalogLevel).length) composition[g as Group] = n;
    }
    // THE PARTY FLOOR (composition.ts): two healers and a body, always. Applied after the
    // mix is fitted to the army size and before the duplicate cap is checked, so the cap
    // is tested against the composition that will actually be built.
    const fitted = enforceFloor(fitTo(composition, size), size, catalogLevel);
    if (!fitted) continue;
    // A duplicate cap and a lopsided composition can be flatly incompatible: a class with
    // three obtainable species and a cap of two cannot fill fourteen slots. That is not a
    // roster to approximate, it is a roster the player could not own — so the sample is
    // re-rolled rather than quietly overflowing onto one species. It is also why `capped`
    // never draws a mono-class army: twenty of anything needs ten distinct species.
    if (cohort.maxPerSpecies !== undefined) {
      const feasible = Object.entries(fitted).every(([g, n]) =>
        !n || n <= appropriateAt(g as Group, catalogLevel).length * cohort.maxPerSpecies!);
      if (!feasible) continue;
    }
    const policy = pick(ORDER_POLICIES);
    const order = orderOf(fitted, policy, rand);
    if (!order.length) continue;

    // One species PREFERENCE per class, best first. A player buys a kind of zombie; the
    // duplicate cap in buildRoster is what makes a capped roster reach past its first
    // choice, so the rest of the class's shortlist has to be behind it.
    const species: Partial<Record<Group, readonly string[]>> = {};
    for (const group of new Set(order)) {
      // A Garden slot exists to HEAL (the floor is a healer floor, not a class quota), so
      // the class's shortlist is narrowed to carriers before anything picks from it. With
      // today's catalog this filters nothing — every Garden, the Doctors included, carries
      // `heal` at tier 1 — and that is the point: adding a non-healing Garden later cannot
      // quietly empty the floor, it drops the sample instead.
      const shortlist = appropriateAt(group, catalogLevel);
      const options = group === "Garden" ? shortlist.filter(isHealer) : shortlist;
      if (!options.length) continue;
      const built = BUILD_FOR.find((b) => b.group === group && rand() < b.chance);
      const carrier = built ? bestCarrierOf(group, catalogLevel, built.ability) : undefined;
      const head = carrier ?? pick(options);
      species[group] = [head.key, ...options.filter((z) => z.key !== head.key).map((z) => z.key)];
    }
    if (new Set(order).size !== Object.keys(species).length) continue;
    const fingerprint = `${policy}/${order.join("")}/${Object.entries(species).sort().map(([g, k]) => `${g}=${k[0]}`).join(",")}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    out.push({
      id: `${cohort.id}/${era.id}/${out.length}`,
      cohort: cohort.id,
      era: era.id,
      order: policy,
      mix: mixName,
      catalogLevel,
      spec: {
        ...era.base,
        // `order` IS the full deploy order, so passing it as the pattern with
        // `size === order.length` lays it down verbatim rather than repeating a block.
        pattern: order,
        size: order.length,
        species,
        mutation: cohort.mutation,
        maxPerSpecies: cohort.maxPerSpecies,
        // The account is at its own level whatever the army's age — the whole point of an
        // outdated roster is that the PLAYER moved on and the zombies did not.
        playerLevel: accountLevel,
        catalogLevel,
      },
    });
  }
  return out;
}
