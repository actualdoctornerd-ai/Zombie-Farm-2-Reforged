// What an army is MADE OF, and in what order it walks out.
//
// The six named lineups (roster.ts) are shapes players describe parties in, and they were
// the right thing to start with. They are not the space. Owner, 2026-09-21: "a valid army
// could be something like 20 normals, or 8 brute, 8 mini, 2 headless, and 2 garden."
// Neither of those is a repeating block, and a sweep that only flies repeating blocks is
// measuring six points in a space with thousands.
//
// So composition and order are separated here, because they are separate decisions:
//
//   · COMPOSITION — how many of each class. This decides the team AURAS, which scale with
//     carrier count (chivalry, grace, protect, fortitude each add 10% per holder), which
//     abilities are present at all, and how much sustain the army has.
//   · ORDER — the sequence they deploy in. The array IS the formation, only one zombie
//     charges at a time (3.6 s each, so twenty take ~72 s), and the damage band pays the
//     front five 1.0 then 0.85 / 0.7 / 0.55. Measured earlier in the rebuild: the same
//     twenty zombies reordered went from a two-casualty clear to a loss-less one.
//
// The same composition ordered two ways is two genuinely different armies, so the sampler
// rolls them independently.
import { appropriateAt, GROUPS, type Group } from "./roster";

/** How many of each class. Classes at zero simply do not appear. */
export type Composition = Partial<Record<Group, number>>;

// ---------------------------------------------------------------------------
// THE PARTY FLOOR
// ---------------------------------------------------------------------------
//
// Owner, 2026-09-21: "all parties always have at least 2 healers and 1 headless."
//
// This is a statement about what a PLAYER is, not about what the sampler can express. A
// support-less army is constructible and the sampler was happily constructing them —
// `sampleComposition` draws a random subset of the classes, so roughly a third of its
// mixes contained no Garden at all, and the named `allRegular` / `noSupport` mixes contain
// none by definition. Those armies were then filling the top of the Strength Ladder,
// because the ladder is √(str·dex·con) and the healer and the tank are the two classes
// with the worst dex — so the strongest COLUMN of the difficulty table was systematically
// the one with no healer in it, and read as "stronger armies do worse".
//
// Nobody plays that. A floor of two healers and one body is the minimum a party actually
// leaves the farm with, so it is applied to every sample and the table goes back to
// comparing armies somebody might field.
//
// TWO CONSEQUENCES, both deliberate:
//   · `allRegular`, `allHeadless` and `noSupport` are no longer literally what they say.
//     A sixteen-strong `allRegular` is now 13 Regular / 2 Garden / 1 Headless. They stay
//     in the mix list because their POINT — a roster that is nearly all one class — still
//     survives the floor, and a mix that cannot be fielded is not a control.
//   · a class that is not obtainable yet cannot be required. An account before the Garden
//     unlock fields no healers, and the floor says so rather than inventing one.
export const MIN_HEALERS = 2;
export const MIN_LINE = 1;

/** What every party must contain, and the job each entry is there to do.
 *
 *  Named by CLASS rather than by ability because the composition layer only knows about
 *  classes — but the invariant being defended is the ability (`heal` / `healAOE` at t1 on
 *  every Garden including the Doctors, `hitPointsBuff` + `protect` on every Headless), and
 *  that is what floor.test.ts asserts on the BUILT roster. If a class ever gains a member
 *  that does not do its class's job, the test fails here rather than the table quietly
 *  drifting. */
export const PARTY_FLOOR: readonly { group: Group; min: number; role: string }[] = [
  { group: "Garden", min: MIN_HEALERS, role: "healer" },
  { group: "Headless", min: MIN_LINE, role: "line" },
];

/** Raise a composition to the party floor, keeping the body count exactly `size`.
 *
 *  Slots are taken from the LARGEST class that is above its own floor, so a lopsided mix
 *  pays for its healers out of the block it was lopsided towards and keeps its shape. Null
 *  when the floor cannot be met at all — an army too small to hold it, or a mix whose only
 *  classes are floor classes already at their minimum. The sampler re-rolls rather than
 *  approximating, for the same reason it re-rolls an infeasible duplicate cap: an army the
 *  player could not field is not an army to measure. */
export function enforceFloor(
  composition: Composition,
  size: number,
  level: number
): Composition | null {
  const required = PARTY_FLOOR.filter((r) => appropriateAt(r.group, level).length > 0);
  if (required.reduce((a, r) => a + r.min, 0) > size) return null;
  const floorOf = (g: Group) => required.find((r) => r.group === g)?.min ?? 0;

  const out: Composition = { ...composition };
  for (const r of required) {
    while ((out[r.group] ?? 0) < r.min) {
      const donor = GROUPS
        .filter((g) => g !== r.group && (out[g] ?? 0) > floorOf(g))
        .sort((a, b) => (out[b] ?? 0) - (out[a] ?? 0))[0];
      if (!donor) return null;
      out[donor] = (out[donor] ?? 0) - 1;
      if (!out[donor]) delete out[donor];
      out[r.group] = (out[r.group] ?? 0) + 1;
    }
  }
  return out;
}

/** How a composition becomes a deploy order. */
export type OrderPolicy = "interleave" | "frontLoad" | "grouped" | "shuffled";

export const ORDER_POLICIES: readonly OrderPolicy[] = [
  // The standard line: spread every class evenly through the queue, so the army rebuilds
  // its shape as the front rank turns over instead of fielding one good block and a tail.
  "interleave",
  // Tanks and support first, damage behind. Gets the sustain out early — which on a fight
  // shorter than the ~72 s the queue needs is the difference between having healers and
  // not having them.
  "frontLoad",
  // One class at a time, in strength order. The shape a player gets by tidying their
  // roster screen, and the one that strands whatever is last.
  "grouped",
  // No policy at all. The control: if a deliberate order is worth anything, it beats this.
  "shuffled",
];

/** Front-load ordering puts the line and the support out first, then the damage. */
const FRONT_FIRST: readonly Group[] = ["Headless", "Garden", "Large", "Female", "Regular", "Small"];

/** Lay a composition out under a policy. */
export function orderOf(
  composition: Composition,
  policy: OrderPolicy,
  rand: () => number
): Group[] {
  const remaining = new Map<Group, number>(
    GROUPS
      .map((g) => [g, Math.max(0, Math.trunc(composition[g] ?? 0))] as [Group, number])
      .filter(([, n]) => n > 0)
  );
  const total = [...remaining.values()].reduce((a, b) => a + b, 0);
  const out: Group[] = [];

  if (policy === "grouped") {
    for (const g of FRONT_FIRST) {
      for (let i = 0; i < (remaining.get(g) ?? 0); i++) out.push(g);
    }
    return out;
  }
  if (policy === "shuffled") {
    for (const [g, n] of remaining) for (let i = 0; i < n; i++) out.push(g);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  if (policy === "frontLoad") {
    // Everything that holds a line or heals goes out first, in class order; the damage
    // follows, interleaved among itself so no single species monopolises the tail.
    const front: Group[] = [];
    const back: Group[] = [];
    for (const g of FRONT_FIRST) {
      const n = remaining.get(g) ?? 0;
      const into = g === "Headless" || g === "Garden" ? front : back;
      for (let i = 0; i < n; i++) into.push(g);
    }
    return [...front, ...back];
  }

  // interleave: largest-remainder round robin, so a class with four of twenty slots lands
  // one every five rather than four in a row. Classes are visited in FRONT_FIRST order so
  // a tie puts the body and the healer ahead of the damage.
  const credit = new Map<Group, number>([...remaining.keys()].map((g) => [g, 0]));
  while (out.length < total) {
    let best: Group | null = null;
    let bestScore = -Infinity;
    for (const g of FRONT_FIRST) {
      const left = remaining.get(g) ?? 0;
      if (left <= 0) continue;
      const score = (credit.get(g) ?? 0) + left / total;
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (!best) break;
    out.push(best);
    remaining.set(best, (remaining.get(best) ?? 0) - 1);
    for (const g of credit.keys()) {
      credit.set(g, (credit.get(g) ?? 0) + (remaining.get(g) ?? 0) / total);
    }
    credit.set(best, 0);
  }
  return out;
}

/** Named compositions worth measuring on purpose, as fractions of the army.
 *
 *  These are shapes with an argument behind them, not a grid: a sweep also draws random
 *  mixes (see `sampleComposition`), and these exist so the named ones are always in the
 *  sample and can be pointed at afterwards. */
export const NAMED_MIXES: Readonly<Record<string, Composition>> = {
  /** Everything in one class. The owner's "20 normals" — and the shape that tells you
   *  what a class is worth with no aura partners and no support at all. */
  allRegular: { Regular: 1 },
  allHeadless: { Headless: 1 },
  /** The owner's second example: 8 brute, 8 mini, 2 headless, 2 garden. Heavy on the two
   *  classes that carry the activated moves, with a token line and a token healer. */
  brutesAndMinis: { Large: 8, Small: 8, Headless: 2, Garden: 2 },
  /** The standard line's ratio — a body, a healer, two damage. */
  standard: { Headless: 5, Garden: 5, Regular: 10 },
  /** Support-heavy, for the fights where casualties are expected. */
  sustain: { Headless: 4, Garden: 6, Regular: 6, Large: 4 },
  /** Every class present, so every aura and every activated move is on the field. */
  broad: { Headless: 4, Garden: 3, Regular: 4, Large: 3, Female: 3, Small: 3 },
  /** No support whatsoever. */
  noSupport: { Headless: 5, Large: 5, Regular: 10 },
};

/** Scale a composition to exactly `size` bodies, largest-remainder, never dropping a
 *  class the mix explicitly asked for while any slot is left. */
export function fitTo(composition: Composition, size: number): Composition {
  const entries = GROUPS
    .map((g) => [g, Math.max(0, composition[g] ?? 0)] as [Group, number])
    .filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (!total) return {};
  const out: Composition = {};
  let placed = 0;
  const remainders: { g: Group; r: number }[] = [];
  for (const [g, w] of entries) {
    const exact = (w / total) * size;
    const n = Math.floor(exact);
    out[g] = n;
    placed += n;
    remainders.push({ g, r: exact - n });
  }
  remainders.sort((a, b) => b.r - a.r);
  for (let i = 0; placed < size && remainders.length; i++, placed++) {
    const { g } = remainders[i % remainders.length];
    out[g] = (out[g] ?? 0) + 1;
  }
  // A class the mix asked for but rounding squeezed out gets one slot back off the
  // largest class — the point of naming it was that it should be there.
  for (const [g] of entries) {
    if ((out[g] ?? 0) > 0) continue;
    const biggest = GROUPS.reduce((a, b) => ((out[b] ?? 0) > (out[a] ?? 0) ? b : a), GROUPS[0]);
    if ((out[biggest] ?? 0) > 1) { out[biggest] = (out[biggest] ?? 0) - 1; out[g] = 1; }
  }
  return out;
}

/** A random plausible mix: between one and all six classes, weighted so lopsided armies
 *  (the "8 brute 8 mini" shape) turn up as often as balanced ones. Classes with nothing
 *  obtainable at `level` are dropped, so an early account cannot sample a Garden it has
 *  not unlocked. */
export function sampleComposition(rand: () => number, size: number, level: number): Composition {
  const available = GROUPS.filter((g) => appropriateAt(g, level).length > 0);
  if (!available.length) return {};
  const count = 1 + Math.floor(rand() * Math.min(available.length, 6));
  const chosen = [...available].sort(() => rand() - 0.5).slice(0, count);
  const weights: Composition = {};
  for (const g of chosen) {
    // Squared uniform: most classes get a small share and one or two dominate, which is
    // what a real roster looks like. A flat draw makes every army a balanced one.
    const u = rand();
    weights[g] = Math.max(0.05, u * u);
  }
  return fitTo(weights, size);
}
