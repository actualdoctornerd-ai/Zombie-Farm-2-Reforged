// The measuring grid: what a player plausibly HAS, at each point in the game.
//
// The loss-less target is "a powerful army available AT THE TIME", so a difficulty
// reading needs two halves: which fight, and which era of account is bringing a roster
// to it. The old harness had neither — it measured every raid in the game, from the
// tutorial to the hardest dual-invasion rung, against one level-45 army with every
// ability unlocked and a stat multiplier bisected over a continuous range. Raid 1 was
// being asked whether a maxed endgame roster could beat it.
//
// AN ERA IS NOT A POWER LEVEL. It is five channels that move together and are not
// interchangeable:
//   · which species    — what the account can have OBTAINED by now (roster.appropriateAt).
//                        Not just a stat band: an ordinary zombie shows ability tiers
//                        1..its colour rank, so a Green army has ONE ability per zombie
//                        however much the account has unlocked — while every SPECIAL is
//                        class "Special" and shows all four. Specials are also 1.4x-4x
//                        their class's best ordinary, so which of them the level opens up
//                        is by far the largest single step an era takes.
//   · ability tiers    — what the account has unlocked globally (each gated on a boss).
//   · army size        — how many bodies the farm supports.
//   · veterancy        — how many invasions the roster has survived.
//   · mutations        — whether the Pot has been feeding the army.
// A single multiplier cannot express "Silvers with nothing unlocked" or "Greens with
// everything", and those are real accounts.
//
// THE GRID IS SMALL AND NAMED ON PURPOSE. This is the CI half of the plan: a fixed,
// readable set of rosters that means the same thing run to run, so a difficulty table
// can be diffed between rulesets. The search layer permutes around it; it does not
// replace it.
import { LINEUPS, type Group, type RosterSpec } from "./roster";

export interface Era {
  id: string;
  /** Roughly the account levels this describes. */
  levels: string;
  /** Everything except the lineup and the size, which the grid varies. */
  base: Omit<RosterSpec, "pattern" | "size">;
  /** Army sizes a farm at this point plausibly supports. */
  sizes: readonly number[];
}

/** Four eras, anchored on what gates each channel rather than on taste.
 *
 *  Ability tiers are gated on bosses — t1 Old McDonnell, t2 the Lawyers, t3 the Pirates,
 *  t4 the Ninjas (traits.TIER_BOSS) — so an account that has just reached raid N has
 *  roughly the tiers those bosses hand out, and no more. The colour ladder and the level
 *  ramp (full stats at 25) move alongside. Veterancy tops out at Master after five
 *  survived invasions, so it saturates early for anyone who replays; the low values here
 *  describe a roster that has been rebuilt after losses, which is the point. */
export const ERAS: readonly Era[] = [
  {
    id: "early",
    levels: "L1–12",
    // Green/Blue bodies, the first two ability tiers, nothing from the Pot, a farm that
    // supports eight or ten. The level ramp is still climbing hard here.
    base: { abilityTiers: 2, invasions: 1, mutation: "none", playerLevel: 12 },
    sizes: [8, 10],
  },
  {
    id: "mid",
    levels: "L16–26",
    base: { abilityTiers: 3, invasions: 3, mutation: "none", playerLevel: 26 },
    sizes: [12, 14],
  },
  {
    id: "late",
    levels: "L31–45",
    // Silvers, everything unlocked, Master rank, and the Pot has been running. The
    // farmer head is a real +10%, on life rather than strength because that is the
    // choice an army trying not to lose anybody makes.
    base: { abilityTiers: 4, invasions: 5, mutation: "best", playerLevel: 45, farmerLifeMult: 1.1 },
    sizes: [16, 18],
  },
  {
    id: "endgame",
    levels: "L46–50",
    base: { abilityTiers: 4, invasions: 5, mutation: "best", playerLevel: 50, farmerLifeMult: 1.1 },
    sizes: [20],
  },
];

export const ERA_BY_ID: Readonly<Record<string, Era>> =
  Object.fromEntries(ERAS.map((e) => [e.id, e]));

/** The era a raid is FOR, from its own `recommendedLevel`. This is what makes "doable
 *  loss-less with a powerful army available at the time" a testable sentence: the raid
 *  names its own audience and the grid brings that audience's best. */
export function eraForLevel(recommendedLevel: number): Era {
  if (recommendedLevel <= 13) return ERA_BY_ID.early;
  if (recommendedLevel <= 28) return ERA_BY_ID.mid;
  if (recommendedLevel <= 45) return ERA_BY_ID.late;
  return ERA_BY_ID.endgame;
}

/** One named roster in the grid. */
export interface Archetype {
  id: string;
  era: string;
  lineup: string;
  spec: RosterSpec;
}

/** Every lineup × every size the era supports. Small (6 × 2 = 12 per era, 6 at endgame),
 *  readable, and it spans the axis that turned out to matter most — where the support
 *  sits in the deploy order. */
export function gridFor(era: Era): Archetype[] {
  const out: Archetype[] = [];
  for (const [lineup, pattern] of Object.entries(LINEUPS)) {
    for (const size of era.sizes) {
      out.push({
        id: `${era.id}/${lineup}/${size}`,
        era: era.id,
        lineup,
        spec: { ...era.base, pattern: pattern as readonly Group[], size },
      });
    }
  }
  return out;
}

/** Rotations of a lineup block — the cheapest slice of the deploy-order space, and the
 *  one that answers "does it matter WHERE in the block the support sits". Four rotations
 *  of `headless > garden > dps > dps` are four genuinely different armies. */
export function rotationsOf(archetype: Archetype): Archetype[] {
  const pattern = archetype.spec.pattern;
  return pattern.map((_, i) => ({
    ...archetype,
    id: `${archetype.id}/rot${i}`,
    spec: { ...archetype.spec, pattern: [...pattern.slice(i), ...pattern.slice(0, i)] },
  }));
}
