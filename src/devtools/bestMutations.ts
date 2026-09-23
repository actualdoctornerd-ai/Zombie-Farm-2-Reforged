// "Best in slot" for a zombie — the strongest legal mutation in every slot at once.
//
// A lab convenience, not a game rule: nothing in the game hands a player a maxed mask, and
// the Zombie Pot's whole design is that you do not get to choose. It exists so a difficulty
// question can be asked at the ceiling — "does this rung still hold up against a roster that
// has everything?" — instead of only against the unmutated line the presets field.
//
// WHAT "BEST" MEANS HERE. Two slots offer a choice of STAT rather than a bigger number of
// the same one, so there is a real question to answer:
//
//   head      Pumpking +4 str · Garlichead +3 str · Potatohead +2 con · Coffeehead +2 dex …
//   hair_eye  Cauli-hair +4 con · Broccohair +3 con · Eyebiscus +1 str +2 dex · Carrot +1 dex
//
// A player's damage is `str` a swing at `2.0 / dex` seconds and its life is `con` (see
// combatStats), so a zombie's strength is the PRODUCT str x dex x con — the Strength Ladder
// the project already measures rosters with. That is what this maximises, per zombie,
// because a stat multiplies hardest where the zombie is weakest in it.
//
// The search is EXHAUSTIVE rather than greedy. The slots interact (a +4 str arm changes
// what the head's +2 dex is worth), so picking each slot's best in isolation is not
// guaranteed to pick the best SET, and at 6x4x3x2x1 = 144 combinations being exact costs
// nothing.
//
// AND YET, WITH TODAY'S CATALOG, IT COMES OUT THE SAME FOR EVERY ZOMBIE WITH A HEAD:
// Coffeehead, Eyebiscus, Dragon-arm, Heartichoke, Flytrap (+5 str, +4 dex, +9 con). Only
// the Headless answers differently — Pumpking, Dragon-arm, Heartichoke, Flytrap — and only
// because two of its slots do not exist.
//
// That is worth knowing, and it is a statement about the CATALOG rather than about this
// function. Dex is the scarcest stat in it (three mutations, +1 or +2) and it is also the
// stat every zombie has least of — 1.3 on a Zombarian against 21 strength — so a couple of
// dex points is the largest proportional gain available to anything, and the same two
// mutations win everywhere. Mutations are not currently a build decision. Keep the search
// general anyway: one new mutation with a real trade-off turns that back into a question,
// and then this answers it without being rewritten.
import {
  addMutation, bitAllowed, MUTATION_LIST, mutationLabel, mutationsOf, SLOTS,
  type MutationDef,
} from "../zombie/mutations";
import type { ZombieDef } from "../assets";

/** The Strength Ladder: sqrt(DPS x HP), with the constants dropped because only the
 *  ORDERING matters here. Guarded like the sim guards them, so a zero stat scores low
 *  rather than collapsing the whole product to nothing and making every mask look equal. */
function strength(str: number, dex: number, con: number): number {
  return Math.sqrt(Math.max(0.1, str) * Math.max(0.1, dex) * Math.max(0.1, con));
}

/** Every mutation this body type may WEAR, grouped by slot and in slot order. Headless
 *  zombies are missing two slots outright (they get the Pumpking and nothing else up
 *  there), and `bitAllowed` is the one place that rule lives. */
function candidatesBySlot(isHeadless: boolean): MutationDef[][] {
  return SLOTS
    .map((slot) => MUTATION_LIST.filter((m) => m.slot === slot && bitAllowed(m.bit, isHeadless)))
    .filter((options) => options.length > 0);
}

/** The strongest legal mutation mask for this species. 0 when it can wear nothing. */
export function bestMutationMask(def: Pick<ZombieDef, "key" | "group" | "str" | "dex" | "con">): number {
  const isHeadless = (def.group ?? "") === "Headless";
  const slots = candidatesBySlot(isHeadless);
  if (!slots.length) return 0;

  let bestMask = 0;
  let bestScore = strength(def.str, def.dex, def.con);

  // Exhaustive walk over one choice per slot. Every slot is optional — a slot whose only
  // options are bad for this zombie should stay EMPTY rather than take the least bad, and
  // a catalog with a genuine penalty mutation (the type allows one) makes that real.
  const walk = (index: number, mask: number, str: number, dex: number, con: number) => {
    if (index === slots.length) {
      const score = strength(str, dex, con);
      if (score > bestScore) { bestScore = score; bestMask = mask; }
      return;
    }
    walk(index + 1, mask, str, dex, con); // take nothing in this slot
    for (const option of slots[index]) {
      const next = addMutation(mask, option.bit, isHeadless);
      if (next === mask) continue; // refused: slot taken, or this body cannot wear it
      walk(
        index + 1,
        next,
        str + (option.stats.str ?? 0),
        dex + (option.stats.dex ?? 0),
        con + (option.stats.con ?? 0),
      );
    }
  };
  walk(0, 0, def.str, def.dex, def.con);
  return bestMask;
}

/** What that mask did, for a readout: the mutation names and the stat delta. */
export function bestMutationSummary(
  def: Pick<ZombieDef, "key" | "group" | "str" | "dex" | "con">
): { mask: number; label: string; str: number; dex: number; con: number } {
  const mask = bestMutationMask(def);
  // `mutationsOf`, never `mask & bit`: the mask is 53 bits wide and JavaScript's bitwise
  // operators are 32, so a hand-rolled test silently starts lying the moment the catalog
  // grows past bit 31. Every read of a mask goes through the module that owns it.
  const delta = { str: 0, dex: 0, con: 0 };
  for (const m of mutationsOf(mask)) {
    delta.str += m.stats.str ?? 0;
    delta.dex += m.stats.dex ?? 0;
    delta.con += m.stats.con ?? 0;
  }
  return { mask, label: mutationLabel(mask), ...delta };
}
