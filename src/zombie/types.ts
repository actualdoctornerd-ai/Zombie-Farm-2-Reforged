// An owned zombie unit grown from a harvested zombie crop (Phase 3). Only `id`,
// `key`, and its farm tile are source-of-truth (persisted); the taxonomy + stats
// are derived from the zombie catalog (zombies.json) by key at spawn/restore.
import type { ZombieDef } from "../assets";
import { classify } from "./taxonomy";
import { applyHeadlessRestriction, mutationBonus } from "./mutations";
import { randomZombieName } from "./names";

// A roster listing entry: an owned zombie plus whether it is stored (off the
// farm) or deployed (wandering). Used by the Zombies menu.
export type RosterEntry = OwnedZombie & { stored: boolean };

export interface OwnedZombie {
  id: string; // unique instance id, e.g. "z3"
  key: string; // ZombieActor* type key
  name: string; // the zombie's individual (random) name, e.g. "Bob"
  typeName: string; // its species/type name, e.g. "Crazy Zombie"
  group: string; // Regular / Female / Small / Large / Headless / Garden
  className: string; // Green / Blue / Red / Silver / Special / Yellow
  classColor: string; // "#rrggbb"
  /** Optional inherited body tint. Combined zombies mix their parents' colors;
   *  ordinary zombies leave this undefined and use the model catalog color. */
  color?: [number, number, number];
  /** Mutation BITMASK (see mutations.ts). 0 = unmutated. Persisted; str/dex/con
   *  below already INCLUDE the mutation stat bonuses (derived at build time). */
  mutation: number;
  str: number;
  dex: number;
  con: number;
  focus: number;
  invasions: number; // survived invasions (drives veterancy rank + its +5%/rank stat bonus)
  col: number; // farm tile (resting/spawn position)
  row: number;
}

// Build an OwnedZombie from its catalog def (falls back to the key taxonomy if a
// field is missing — e.g. an older zombies.json without baked stats).
//
// `mutation` overrides the def's own mutation bit — pass it when the unit's set
// isn't the species default (e.g. a Zombie Pot combine result, or restoring a
// saved mask). When omitted, a market mutant grows in with its guaranteed bit
// (def.mutation), so buying a Carrot Zombie yields a Carrot-eyed owned unit.
// Combat stats bake in the mutation bonuses so downstream code reads str/dex/con
// directly. Headless zombies have head/hair-eye mutations stripped here (report
// §11), so a headless combine result never carries a mutation it can't show.
export function makeOwned(
  id: string,
  def: ZombieDef,
  col: number,
  row: number,
  invasions = 0,
  mutation?: number,
  color?: [number, number, number]
): OwnedZombie {
  const tax = classify(def.key);
  const group = def.group ?? tax.group;
  // Enforce the headless restriction at the one place a mask lands on a unit.
  const mask = applyHeadlessRestriction(mutation ?? def.mutation ?? 0, group === "Headless");
  const bonus = mutationBonus(mask);
  return {
    id,
    key: def.key,
    name: randomZombieName(group, id) || def.name, // individual name (falls back to type)
    typeName: def.name,
    group,
    className: def.className ?? tax.className,
    classColor: def.classColor ?? tax.classColor,
    color,
    mutation: mask,
    str: (def.str ?? 1) + bonus.str,
    dex: (def.dex ?? 1) + bonus.dex,
    con: (def.con ?? 1) + bonus.con,
    focus: def.focus ?? 0,
    invasions,
    col,
    row,
  };
}
