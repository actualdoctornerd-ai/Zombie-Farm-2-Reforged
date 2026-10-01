// ---------------------------------------------------------------------------
// What a zombie's mutations look like on its card
// ---------------------------------------------------------------------------
// A mutated zombie used to advertise its mutations only INDIRECTLY: the boosted
// stat tiles render green, and the rig wears the vegetable. Neither says WHICH
// mutations it carries — which is what a player needs to know before pairing it in
// the Zombie Pot (slots are one-per-body-part and the higher bit wins a conflict).
// This module turns a mask into the per-mutation rows the card shows.
//
// Two things are deliberately NOT re-derived here:
//   • the effect is reported in DISPLAYED units, not the raw 1–4 points — the tiles
//     normalize against a per-stat reference, so Carrot's "+1 dex" reads +23 Speed
//     while Tomato's "+1 str" reads +4 Damage (see statDisplay).
//   • each mutation's contribution is measured by chaining through the same
//     rounding boundaries the tile uses, so the rows always SUM to the "Mutation"
//     line in the stat breakdown rather than drifting a point away from it.
//
// A mutation may move SEVERAL stats, and may move one DOWN (mutations.ts
// MutationStats), so an entry carries a list of effects rather than one number, and
// every one of them is written signed.
import { BASE } from "../base";
import {
  mutationBonus, mutationsOf, statEffectsOf,
  type MutationDef, type Slot, type Stat,
} from "./mutations";
import { STATS, displayStat } from "./traits";

// ZF2's own 40x40 mutation icons (MutationIcons.png — the vegetable in a lab flask),
// sliced by tools/prep_mutation_icons.py. The set covers all 13 primaries and both
// Tier-4 variants; only Pumpking, which never had an authored entry, is composed —
// its rig head placed in the same flask.
const MI = BASE + "assets/ui/mutation/";
const iconFile = (name: string) => `${MI}icon_mutation_${name}.png`;

/** mutation KEY (mutations.ts) -> its authored icon. Three names differ from ours:
 *  cauli/dragon are the game's cauliflower/dragonfruit, pumpking is the composed one. */
export const MUTATION_ICON: Record<string, string> = {
  tomato: iconFile("tomato"), onion: iconFile("onion"), carrot: iconFile("carrot"),
  turnip: iconFile("turnip"), potato: iconFile("potato"), coffee: iconFile("coffee"),
  celery: iconFile("celery"), broccoli: iconFile("broccoli"), garlic: iconFile("garlic"),
  cauli: iconFile("cauliflower"), limabean: iconFile("limabean"), flytrap: iconFile("flytrap"),
  dragon: iconFile("dragonfruit"), pumpking: iconFile("pumpking"),
  eyebiscus: iconFile("eyebiscus"), heartichoke: iconFile("heartichoke"),
  // The prize mutations (src/zombie/mutations.ts PRIZE_MUTATIONS). Harmless while they
  // are not in the catalog: nothing looks an absent mutation up.
  goldencarrot: iconFile("goldencarrot"), goldenturnip: iconFile("goldenturnip"),
  obsidibeans: iconFile("obsidibeans"), cauliglower: iconFile("cauliglower"),
  cosmicpotato: iconFile("cosmicpotato"), brainato: iconFile("brainato"),
};

/** One species' replacement art and name for a mutation it shares with others. */
export interface MutationVariant {
  part: string; // mutations.json key for the rig art
  name: string;
  icon: string;
  /** The slot the variant's ART actually occupies, when it differs from the shared
   *  mutation's. Heartichoke rides Cauli-hair's bit but wears a BODY (heartichokeBody
   *  `replaces: "body"`, exactly like Lima Bean), so naming its slot off the shared
   *  mutation called it a hair mutation — the reported bug. Display only: slot
   *  OCCUPANCY is a property of the bit and stays with the shared mutation. */
  slot?: Slot;
}

/** LEGACY. Eyebiscus and Heartichoke used to ride Carrot's and Cauliflower's mutation
 *  for stats and slot occupancy while shipping their OWN art and name, and naming such
 *  a zombie's mutation off the shared one was simply wrong (the reported "Cauli-hair"
 *  text on Heartichoke). Both are catalogued mutations of their own now, so a unit
 *  grown today never reaches this table — but one grown BEFORE still carries the shared
 *  bit until variantMutations upgrades it, and it must read correctly meanwhile.
 *
 *  Species key -> mutation key -> what that species shows instead. MIRRORS
 *  `mutationOverrides` in zombie/models.json — pinned against it by the tests. */
export const MUTATION_VARIANTS: Record<string, Record<string, MutationVariant>> = {
  ZombieActorRegularTier4Eyebiscus: {
    carrot: { part: "eyebiscusHat", name: "Eyebiscus", icon: iconFile("eyebiscus") },
  },
  ZombieActorRegularTier4Heartichoke: {
    cauli: {
      part: "heartichokeBody", name: "Heartichoke", icon: iconFile("heartichoke"),
      slot: "body", // wears Lima Bean's silhouette, not Cauli-hair's
    },
  },
};

const SLOT_LABELS: Record<Slot, string> = {
  head: "Head",
  hair_eye: "Hair & Eyes",
  arm: "Arm",
  body: "Body",
  neck: "Neck",
};

const STAT_LABELS: Record<Stat, string> = {
  str: STATS.find((s) => s.key === "str")!.label,
  dex: STATS.find((s) => s.key === "dex")!.label,
  con: STATS.find((s) => s.key === "con")!.label,
};

/** What one mutation does to one stat, in the units the tiles show. */
export interface MutationCardEffect {
  stat: Stat;
  statLabel: string; // "Damage" / "Speed" / "Life"
  delta: number; // what it moves THIS zombie's displayed stat by; NEGATIVE for a penalty
}

/** One mutation as the card shows it. */
export interface MutationCardEntry {
  bit: number;
  /** mutations.json key for the RIG art — the variant part when the species overrides it. */
  partKey: string;
  icon: string; // the card's 40x40 icon URL
  name: string; // "Onionhead", "Eyebiscus", …
  slotLabel: string; // which body slot it occupies (one mutation per slot)
  /** Every stat this mutation moves, in str/dex/con order. A mutation may trade one
   *  stat for another, so this can mix gains and penalties; it is never empty for a
   *  catalogued mutation, and a stat the mutation leaves alone is simply absent. */
  effects: MutationCardEffect[];
}

/** The minimum a zombie must carry for its mutation rows. `str`/`dex`/`con`
 *  already INCLUDE the mutation bonuses (makeOwned bakes them in). */
export interface MutationSource {
  key: string; // species key — resolves the Tier-4 variant art/name
  str: number;
  dex: number;
  con: number;
  mutation: number; // bitmask
}

/** The mutations a zombie carries, in bit (tier) order. Empty when unmutated. */
export function mutationEntries(z: MutationSource): MutationCardEntry[] {
  const defs = mutationsOf(z.mutation);
  if (!defs.length) return [];
  const bonus = mutationBonus(z.mutation);
  // Strip the mutations back off to recover the species' own stats, then re-apply
  // them one at a time so each row reports its marginal, already-rounded gain.
  return mutationEntriesFrom(defs, {
    str: z.str - bonus.str,
    dex: z.dex - bonus.dex,
    con: z.con - bonus.con,
  }, MUTATION_VARIANTS[z.key]);
}

/** The card rows for an explicit set of mutation defs applied to explicit UNMUTATED
 *  stats. Split out from mutationEntries so the row maths can be exercised against a
 *  mutation the shipped catalog doesn't contain — which is the only way to cover a
 *  multi-stat or penalty-carrying mutation before one ships. */
export function mutationEntriesFrom(
  defs: readonly MutationDef[],
  base: Record<Stat, number>,
  variants?: Record<string, MutationVariant>,
): MutationCardEntry[] {
  const applied: Record<Stat, number> = { str: 0, dex: 0, con: 0 };

  return defs.map((def) => {
    // One row per stat this mutation moves. Each is measured by stepping THROUGH the
    // rounding boundary the tile uses, so a mutation that gives and takes reports both
    // halves at the same fidelity as a single-stat one.
    const effects = statEffectsOf(def).map((effect) => {
      const before = displayStat(effect.stat, base[effect.stat] + applied[effect.stat]);
      applied[effect.stat] += effect.amount;
      const after = displayStat(effect.stat, base[effect.stat] + applied[effect.stat]);
      return {
        stat: effect.stat,
        statLabel: STAT_LABELS[effect.stat],
        delta: after - before,
      };
    });
    const variant = variants?.[def.key];
    return {
      bit: def.bit,
      partKey: variant?.part ?? def.key,
      icon: variant?.icon ?? MUTATION_ICON[def.key],
      name: variant?.name ?? def.name,
      slotLabel: SLOT_LABELS[variant?.slot ?? def.slot],
      effects,
    };
  });
}

/** One effect as the tooltip writes it: always signed, so a penalty reads as a penalty
 *  rather than as a smaller gain. */
export function mutationEffectText(effect: MutationCardEffect): string {
  return `${effect.delta >= 0 ? "+" : ""}${effect.delta} ${effect.statLabel}`;
}

/** The tooltip body for one mutation — the tile itself is unlabelled, so this is where
 *  the effect is read. One line per stat it moves, then the slot. Penalties carry
 *  `zeff-down` so the card can colour a trade-off differently from a pure gain. */
export function mutationTipText(entry: MutationCardEntry): string {
  const lines = entry.effects
    .map((effect) => {
      const cls = effect.delta < 0 ? "zeff zeff-down" : "zeff";
      return `<span class="${cls}">${mutationEffectText(effect)}</span>`;
    })
    .join("<br>");
  return `${lines}<br>${entry.slotLabel} slot`;
}

/** Every mutation name a mask stands for on THIS species, e.g. "Onionhead, Celery-arms".
 *  Variant-aware, unlike the raw `mutationLabel` in mutations.ts. */
export function mutationNames(key: string, mask: number): string[] {
  const variants = MUTATION_VARIANTS[key];
  return mutationsOf(mask).map((def) => variants?.[def.key]?.name ?? def.name);
}

/** A mask written out for THIS species, e.g. "Onionhead, Celery-arms" — empty for an
 *  unmutated zombie. Every place that names a concrete unit's mutations should use
 *  this rather than mutations.ts `mutationLabel`, which knows only the shared
 *  mutation and so calls an Eyebiscus "Carrot-eyes". */
export function mutationLabelFor(key: string, mask: number): string {
  return mutationNames(key, mask).join(", ");
}
