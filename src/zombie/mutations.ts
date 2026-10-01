// ---------------------------------------------------------------------------
// Mutation system (data-derived from ZF2's Market.plist).
// ---------------------------------------------------------------------------
// A zombie's mutations are stored as a BITMASK: the game's `mutation` field is a
// power of two per mutation (Tomato=1, Onion=2, Carrot=4, ...). A zombie's full
// set is the bitwise-OR of its mutation bits, so the whole thing is one integer.
//
// Rules (locked in — see MUTATION_CATALOG_CORRECTED.md §4):
//   * One mutation per SLOT (head / hair_eye / arm / body / neck). The bitmask
//     alone would permit two head mutations at once (Tomato|Onion); that state
//     is ILLEGAL and every write here refuses it.
//   * Max 5 mutations (one per slot).
//   * Stat bonuses map: power/attack -> str, life -> con, speed -> dex.
//
// Acquisition: grow a zombie beside mutation-bearing crops, buy a pre-mutated
// Market zombie, or combine two zombies in the Zombie Pot.
//
// ADDING A MUTATION
// -----------------
// Append one row to CATALOG below — key, display name, slot, and the stats it moves
// (any mix of str/dex/con, negatives allowed) — and the bit is assigned for you from
// its position. Then:
//   1. art: an entry in public/assets/zombie/mutations.json keyed by the SAME key,
//      with either an atlas frame name or a loose "<name>.png" (see assets.ts).
//   2. crops (optional): a `cropKey: "yourKey"` line in cropMutations.ts.
// Nothing else needs to know the bit; every consumer resolves through this module.
//
// The mask arithmetic runs through mutationMask.ts rather than `&`/`|`, because
// JavaScript's bitwise operators are 32-bit and would wrap. The catalog can hold
// MAX_MASK_BITS (53) mutations; past that the representation has to change and
// mutationMask.ts throws rather than corrupting a neighbouring bit.
// ---------------------------------------------------------------------------

import { PRIZE_CROPS } from "../cropUnlocks";
import {
  bitValue, isMaskBit, MAX_MASK_BITS, maskBits, maskHas,
  maskIntersect, maskUnion, maskWithout,
} from "./mutationMask";

export type Slot = "head" | "hair_eye" | "arm" | "body" | "neck";
export const SLOTS: Slot[] = ["head", "hair_eye", "arm", "body", "neck"];

export type Stat = "str" | "con" | "dex";

/** A mutation's stable string id — the name to use in code and in mutations.json. */
export type MutationKey = string;

/** Anything that names one mutation: its key, or its raw bit. Code and data should
 *  prefer the key; the bit is accepted so persisted values and older call sites
 *  (and any external data keyed by bit) keep resolving through one path. */
export type MutationRef = MutationKey | number;

/** What a mutation does to a zombie's stats. Any combination of str/con/dex, and a
 *  NEGATIVE value is a real penalty — a mutation may trade one stat for another. An
 *  absent stat is untouched (not zero: the difference matters to the card, which only
 *  lists the stats a mutation actually moves). */
export type MutationStats = Partial<Record<Stat, number>>;

/** A mutation's rank, 1-4, as ZF2 authored it: the market mutant that carries each
 *  mutation names its own tier in its actor key (`…Tier1Tomatoes`, `…Tier4Eyebiscus`),
 *  and MUTATION_CATALOG_CORRECTED.md tabulates the full set.
 *
 *  Presentation only — nothing in combat or the Pot reads it. It exists so the
 *  Mutation Almanac can draw each mutation on a zombie of matching rank (Green for
 *  tier 1 through Silver for tier 4, see classForTier) rather than picking one body
 *  arbitrarily. Note it is NOT the `tier` baked onto a mutant ZombieDef in
 *  zombies.json: that one was re-derived by the Reforged rebalance from unlock level
 *  and runs 1/3/4 with no tier 2 at all, which would leave a colour missing from the
 *  ladder. This is the source's own number. */
export type MutationTier = 1 | 2 | 3 | 4;

/** One mutation as authored. The bit is assigned from catalog position, not written
 *  by hand — see CATALOG and PINNED_ORDER. */
export interface MutationSpec {
  key: MutationKey; // stable id
  name: string; // display name of the resulting zombie
  slot: Slot;
  stats: MutationStats; // e.g. { con: 8, dex: -2 }
  tier: MutationTier;
}

export interface MutationDef extends MutationSpec {
  bit: number; // power-of-two mask value, derived from catalog position
}

/** A mutation's effects as an ordered list, skipping stats it leaves alone. Ordered by
 *  STATS so two mutations never list the same pair of effects in a different order. */
export function statEffectsOf(def: Pick<MutationDef, "stats">): { stat: Stat; amount: number }[] {
  return STAT_ORDER
    .filter((stat) => !!def.stats[stat])
    .map((stat) => ({ stat, amount: def.stats[stat]! }));
}

const STAT_ORDER: Stat[] = ["str", "dex", "con"];

// The authored catalog, in BIT ORDER. Entry N owns bit 2^N.
//
// APPEND ONLY. A bit is a persisted value — it is written into every save, into
// D1's roster_v3.mutation, and into Black Market orders — so reordering or removing
// a row would silently re-label every mutated zombie in the world. PINNED_ORDER below
// turns that mistake into a startup failure instead of a data corruption.
//
// The first 13 are ZF2's primary mutations; slot is authoritative from the bit (that
// is how ZF2 stores/enforces it) and the stat mapping is power/attack->str,
// life->con, speed->dex. Eyebiscus and Heartichoke are Tier-4 visual variants that
// reuse carrot's and cauli's mutation, so they need no separate entry.
//
// `stats` takes any mix, and a NEGATIVE is a genuine penalty — nothing here uses one
// (ZF2's were all pure upside), but a new mutation may trade stats:
//   { key: "cornhead", name: "Cornhead", slot: "head", stats: { con: 8, dex: -2 } }
// Penalties apply to the RAW stat and are floored where the stat becomes combat
// behaviour, not here — see MIN_COMBAT_STAT in raid/CombatEngine.
const BASE_CATALOG: readonly MutationSpec[] = [
  { key: "tomato", name: "Tomatohead", slot: "head", stats: { str: 1 }, tier: 1 },
  { key: "onion", name: "Onionhead", slot: "head", stats: { con: 1 }, tier: 1 },
  { key: "carrot", name: "Carrot-eyed", slot: "hair_eye", stats: { dex: 1 }, tier: 1 },
  { key: "turnip", name: "Turnip-Arm", slot: "arm", stats: { str: 2 }, tier: 1 },
  { key: "potato", name: "Potatohead", slot: "head", stats: { con: 2 }, tier: 1 },
  { key: "coffee", name: "Coffeehead", slot: "head", stats: { dex: 2 }, tier: 1 },
  { key: "celery", name: "Celery-arms", slot: "arm", stats: { str: 3 }, tier: 2 },
  { key: "broccoli", name: "Broccohair", slot: "hair_eye", stats: { con: 3 }, tier: 2 },
  { key: "garlic", name: "Garlichead", slot: "head", stats: { str: 3 }, tier: 2 },
  // +4, not the +3 it shipped with. Cauliflower is a level-29 crop and Broccoli a
  // level-23 one; while both paid +3 con in the same slot, the dearer, later crop
  // granted nothing the earlier one didn't, and lost every Pot conflict to nothing.
  { key: "cauli", name: "Cauli-hair", slot: "hair_eye", stats: { con: 4 }, tier: 2 },
  { key: "limabean", name: "Lima Bean", slot: "body", stats: { con: 3 }, tier: 2 },
  { key: "flytrap", name: "Flytrap", slot: "neck", stats: { con: 4 }, tier: 3 },
  { key: "dragon", name: "Dragon-arm", slot: "arm", stats: { str: 4 }, tier: 3 },
  // The headless family's own head (see HEADLESS_HEAD_MASK). Pumpking never had a
  // MutationIcons entry or a market mutant in ZF2 — it shipped as a crop-adjacency-only
  // mutation and the one head exception the headless family could wear
  // (MUTATION_CATALOG_CORRECTED.md §"Legacy / crop-adjacency-only", report §11), so its
  // bonus is ours to choose.
  //
  // It was +3 attack, matching Garlichead exactly — which made the level-39 capstone
  // crop (380g a seed) pay what garlic pays at level 25, and made the Pumpking a
  // Regular inherits in the Pot worth nothing over the Garlichead it evicts. +4 makes
  // it the best head in the game, which is what a capstone should be, and is the
  // headless family's compensation for being locked out of two slots entirely.
  //
  // Its `tier` is ours for the same reason — with no market mutant there is no authored
  // `TierN` to read it off. Tier 4, to sit with the two Tier-4 variants: it grows from
  // the level-39 capstone crop and pays what the sentence above says it pays, so filing
  // it among the Tier-1 heads it out-values fourfold would be the misleading choice.
  { key: "pumpking", name: "Pumpking", slot: "head", stats: { str: 4 }, tier: 4 },
  // The two Tier-4 crops. They USED to ride carrot's and cauli's bits — a Tier-4 crop
  // that cost several times as much and grew for a day granted exactly the Tier-1
  // mutation, so there was never a reason to plant one. ZF2 itself disagreed with that:
  // Market.json advertises "+3" on Eyebiscus against Carrot's "+1" (see the note in
  // tools/prep_market.py). They are their own mutations now, and appending puts each at
  // the TOP of its slot's ladder, which is where a Tier-4 belongs.
  //
  // Eyebiscus is the eye attachment Carrot-eyed is, so it stays in hair_eye. Heartichoke
  // is NOT: heartichokeBody `replaces: "body"` exactly as limaBeanBody does, so it sits
  // in the BODY slot with Lima Bean — the slot the art always drew it in, and the one a
  // player reported it filing itself under wrongly while it wore Cauli-hair's bit.
  { key: "eyebiscus", name: "Eyebiscus", slot: "hair_eye", stats: { str: 1, dex: 2 }, tier: 4 },
  { key: "heartichoke", name: "Heartichoke", slot: "body", stats: { con: 5 }, tier: 4 },
];

// THE SIX PRIZE MUTATIONS (docs/PRIZE_CROPS.md) — written, tested, and NOT in the game.
//
// Each is the late-game upgrade of a base crop's mutation, grown by a prize crop that a
// dual-invasion tier clear unlocks (src/cropUnlocks.ts). They are appended to the catalog
// ONLY when PRIZE_CROPS.live — read once, at module load — so while it is off no bit is
// assigned, and the almanac, the Pot, the Black Market, the roster validators and the
// difficulty harness all behave exactly as they did before these existed.
//
// Shape (owner, 2026-10-01): ONE significant stat plus ONE minor one, a total only a
// little above the old best in the slot (Pumpking 4, Cauli-hair 4, Dragon-arm 4,
// Heartichoke 5), and the two crops that share a slot fill DIFFERENT roles: Brainato is
// the attack head, Cosmic Potatohead the tank head; Golden Carrot-eyed is the quick,
// hard-hitting eye, Cauliglower the tough one. DEX is deliberately rare: today's best
// dex is already 4 (Coffeehead 2 + Eyebiscus 2), and these keep that ceiling.
//
// APPEND-ONLY applies from the day this ships: once live, these keys' positions are
// persisted bits like any other, so never reorder this list afterwards.
export const PRIZE_MUTATIONS: readonly MutationSpec[] = [
  { key: "goldencarrot", name: "Golden Carrot-eyed", slot: "hair_eye", stats: { str: 2, dex: 2 }, tier: 4 },
  { key: "goldenturnip", name: "Golden Turnip-Arm", slot: "arm", stats: { str: 4, con: 1 }, tier: 4 },
  { key: "obsidibeans", name: "Obsidibeans", slot: "body", stats: { con: 5, str: 1 }, tier: 4 },
  { key: "cauliglower", name: "Cauliglower", slot: "hair_eye", stats: { con: 4, str: 1 }, tier: 4 },
  { key: "cosmicpotato", name: "Cosmic Potatohead", slot: "head", stats: { con: 3, str: 2 }, tier: 4 },
  { key: "brainato", name: "Brainato", slot: "head", stats: { str: 3, dex: 2 }, tier: 4 },
];

const CATALOG: readonly MutationSpec[] = PRIZE_CROPS.live
  ? [...BASE_CATALOG, ...PRIZE_MUTATIONS]
  : BASE_CATALOG;

// The order that has already shipped. A row inserted, removed, or moved in CATALOG
// shifts the bit of every row below it, which would re-label every mutated zombie in
// every live save — so CATALOG must still START with exactly this sequence, checked at
// module load, and the game refuses to boot rather than corrupt data.
//
// Appending is always safe and needs no edit here: the check is a PREFIX match, so a
// new mutation simply lands past the end of this list. Add a key below only when
// pinning a mutation that has shipped and must never move again.
const PINNED_ORDER: readonly MutationKey[] = [
  "tomato", "onion", "carrot", "turnip", "potato", "coffee", "celery",
  "broccoli", "garlic", "cauli", "limabean", "flytrap", "dragon", "pumpking",
  "eyebiscus", "heartichoke",
];

/** Ordered mutation defs, bit assigned from catalog position. */
export const MUTATION_LIST: readonly MutationDef[] = CATALOG.map((spec, index) => ({
  ...spec,
  bit: bitValue(index),
}));

(function assertCatalogIntegrity() {
  if (CATALOG.length > MAX_MASK_BITS) {
    throw new RangeError(
      `mutation catalog holds ${CATALOG.length} entries; the integer mask tops out at ` +
      `${MAX_MASK_BITS}. Widening past this needs a representation change — see mutationMask.ts`
    );
  }
  const seen = new Set<MutationKey>();
  for (const def of MUTATION_LIST) {
    if (seen.has(def.key)) throw new Error(`duplicate mutation key "${def.key}"`);
    seen.add(def.key);
  }
  // CATALOG must still open with the shipped sequence. The bit each of those keys
  // resolves to is a function of its position, so an unchanged prefix IS an unchanged
  // set of persisted values — checking the order says the same thing as checking the
  // numbers, without anybody having to write a number.
  for (const [index, key] of PINNED_ORDER.entries()) {
    if (CATALOG[index]?.key === key) continue;
    const moved = MUTATION_LIST.find((def) => def.key === key);
    throw new Error(
      `mutation "${key}" is no longer catalog entry #${index}` +
      (moved ? ` (it is now #${CATALOG.findIndex((e) => e.key === key)})` : " (it was removed)") +
      `. Position determines the persisted bit, so CATALOG is APPEND-ONLY: a row may ` +
      `not be inserted, removed, or reordered without re-labelling every mutated ` +
      `zombie in every save and in roster_v3.mutation. Restore the order and append instead.`
    );
  }
})();

/** Every mutation by key — the lookup to reach for. */
export const MUTATIONS_BY_KEY: Readonly<Record<MutationKey, MutationDef>> =
  Object.fromEntries(MUTATION_LIST.map((def) => [def.key, def]));

// Every mutation by bit. Deliberately NOT exported: a bit is a storage detail, and
// code that holds one should come back through mutationOf/slotOf/resolveMutationBit
// rather than index a table by a number it had to know.
const BY_BIT: Readonly<Record<number, MutationDef>> =
  Object.fromEntries(MUTATION_LIST.map((def) => [def.bit, def]));

/** All known mutation bits (the ones we resolve), low bit first. */
export const ALL_BITS: number[] = MUTATION_LIST.map((def) => def.bit);

/** The union of every known bit. A mask outside this carries bits we cannot resolve —
 *  see sanitizeMutationMask, which is the bound the server applies to untrusted input. */
export const ALL_MUTATIONS_MASK: number = ALL_BITS.reduce(maskUnion, 0);

/** Bitmask of every mutation belonging to a slot. Used to test slot occupancy. */
export const SLOT_MASK: Record<Slot, number> = (() => {
  const m: Record<Slot, number> = { head: 0, hair_eye: 0, arm: 0, body: 0, neck: 0 };
  for (const def of MUTATION_LIST) m[def.slot] = maskUnion(m[def.slot], def.bit);
  return m;
})();

/** The bit a ref names, or null when it names nothing we know. Accepts a key
 *  ("pumpking") or a raw persisted bit; unknown keys and unknown/compound bits resolve
 *  to null, so a typo fails closed rather than landing on a neighbour. */
export function resolveMutationBit(ref: MutationRef): number | null {
  if (typeof ref === "string") return MUTATIONS_BY_KEY[ref]?.bit ?? null;
  if (!isMaskBit(ref)) return null;
  return BY_BIT[ref] ? ref : null;
}

/** The def a ref names, or null. */
export function mutationOf(ref: MutationRef): MutationDef | null {
  const bit = resolveMutationBit(ref);
  return bit === null ? null : BY_BIT[bit];
}

/** The bit a KNOWN mutation key occupies. Throws on an unknown key, so it is the way
 *  to name a specific mutation in code — `bitOf("pumpking")` instead of `8192`, which
 *  is both readable and checked. Use resolveMutationBit where the name is untrusted. */
export function bitOf(key: MutationKey): number {
  const def = MUTATIONS_BY_KEY[key];
  if (!def) throw new Error(`unknown mutation "${key}" — see CATALOG in mutations.ts`);
  return def.bit;
}

/** The display name a ref stands for, or "" when it names nothing we know. Species
 *  that override a shared mutation's name (the Tier-4 variants) go through
 *  mutationDisplay.mutationNames instead. */
export function mutationName(ref: MutationRef): string {
  return mutationOf(ref)?.name ?? "";
}

/** Drop bits this build cannot resolve. The bound applied wherever a mask arrives
 *  from outside (a save file, a client command): an unknown bit contributes no stats
 *  and no art, and keeping it would let it collide with a mutation added later. */
export function sanitizeMutationMask(mask: unknown): number {
  if (typeof mask !== "number" || !Number.isSafeInteger(mask) || mask <= 0) return 0;
  return maskIntersect(mask, ALL_MUTATIONS_MASK);
}

/** The slot a mutation bit occupies, or null if the bit is unknown. */
export function slotOf(bit: number): Slot | null {
  return BY_BIT[bit]?.slot ?? null;
}

/** The slot a ref occupies, or null. Key- or bit-addressed. */
export function slotOfRef(ref: MutationRef): Slot | null {
  return mutationOf(ref)?.slot ?? null;
}

/** Every known individual mutation bit set in a mask, low bit first. */
export function bitsOf(mask: number): number[] {
  return ALL_BITS.filter((b) => maskHas(mask, b));
}

/** Every bit set in a mask, known or not — the raw digits. */
export { maskBits };

/** Resolved mutation defs present in a mask (skips unknown/unmapped bits). */
export function mutationsOf(mask: number): MutationDef[] {
  return bitsOf(mask).map((b) => BY_BIT[b]);
}

/** Which slots are already filled in a mask. */
export function occupiedSlots(mask: number): Set<Slot> {
  const s = new Set<Slot>();
  for (const slot of SLOTS) if (maskIntersect(mask, SLOT_MASK[slot]) !== 0) s.add(slot);
  return s;
}

/** Number of mutations carried (0..5). */
export function mutationCount(mask: number): number {
  return bitsOf(mask).length;
}

/** A mask is fully mutated when all five slots are filled. */
export function isFullyMutated(mask: number): boolean {
  return occupiedSlots(mask).size === SLOTS.length;
}

// A HEADLESS zombie has no head to mutate: it can only carry body, arm, and neck
// mutations — never head or hair/eye (report §11). These are the slots it MAY hold.
export const HEADLESS_SLOTS: ReadonlySet<Slot> = new Set<Slot>(["body", "arm", "neck"]);

// ...with one exception, which runs the other way: Pumpking is the head mutation
// authored FOR the headless family — the pumpkin becomes the head they never had, so
// it is the one head bit a headless zombie may hold. It is the only bit in this mask.
//
// ANYONE can WEAR it, but only a headless zombie can GROW it: a crop-adjacency roll
// refuses the pumpkin on a zombie that already has a head (see bitGrowable). Every
// other zombie reaches it through the Zombie Pot, inheriting it from a headless
// parent — that route, and only that route, is how a Regular ends up wearing one.
export const HEADLESS_HEAD_MASK = MUTATIONS_BY_KEY.pumpking.bit;

/** Head/hair-eye bits a headless zombie may NOT hold (Pumpking excluded — see above).
 *  Pinned by server/migrations/0035_headless_mutation_repair.sql. */
export const HEADLESS_FORBIDDEN_MASK =
  maskWithout(maskUnion(SLOT_MASK.head, SLOT_MASK.hair_eye), HEADLESS_HEAD_MASK);

/** Can this body type WEAR `bit` at all? Only the headless family is restricted, and
 *  only in the two slots it hasn't got — the pumpkin that stands in for its head is
 *  wearable by everyone. Unknown bits are never allowed. */
export function bitAllowed(bit: number, isHeadless: boolean): boolean {
  const slot = slotOf(bit);
  if (slot === null) return false;
  if (!isHeadless) return true;
  return HEADLESS_SLOTS.has(slot) || maskHas(HEADLESS_HEAD_MASK, bit);
}

/** Can this body type GROW `bit` from an adjacent crop? The wearing rule, minus the
 *  pumpkin: a zombie that already has a head never grows one, whatever it is planted
 *  beside. The Zombie Pot is the only way it reaches them. */
export function bitGrowable(bit: number, isHeadless: boolean): boolean {
  if (!bitAllowed(bit, isHeadless)) return false;
  return isHeadless || !maskHas(HEADLESS_HEAD_MASK, bit);
}

/**
 * Drop the mutations this body type can't hold: head + hair/eye for a headless
 * zombie, nothing for anybody else. Applied wherever a mask lands on a unit, so a
 * combine result never carries a mutation it can't show.
 */
export function applyBodyTypeRestriction(mask: number, isHeadless: boolean): number {
  return isHeadless ? maskWithout(mask, HEADLESS_FORBIDDEN_MASK) : mask;
}

/**
 * Can `bit` legally be added to `mask`? False if the bit is unknown, its slot is
 * already occupied (one-per-slot), or this body type can't wear it (see bitAllowed).
 * Adding a bit already present is a no-op and reported legal.
 */
export function canReceive(mask: number, bit: number, isHeadless = false): boolean {
  const slot = slotOf(bit);
  if (slot === null) return false;
  if (!bitAllowed(bit, isHeadless)) return false;
  if (maskHas(mask, bit)) return true; // already have exactly this one
  return maskIntersect(mask, SLOT_MASK[slot]) === 0; // slot must be empty
}

/**
 * Add `bit` to `mask`, enforcing one-per-slot (and the headless restriction when
 * `isHeadless`). If the write is illegal `mask` is returned unchanged (the caller
 * decides conflict resolution — see combineMasks). Returns the new mask.
 */
export function addMutation(mask: number, bit: number, isHeadless = false): number {
  return canReceive(mask, bit, isHeadless) ? maskUnion(mask, bit) : mask;
}

/** Human-readable list, e.g. "Onionhead, Celery-arms". "" when unmutated. */
export function mutationLabel(mask: number): string {
  return mutationsOf(mask)
    .map((m) => m.name)
    .join(", ");
}

// The Market's guaranteed-mutation line lives in zombie/statDisplay
// (mutationMarketDescription). It belongs there because the number it shows must be
// NORMALIZED — a mutation's raw 1–4 points are never what the player sees on a stat
// tile — and this module deliberately knows nothing about display normalization.

/** Summed stat changes from all mutations in a mask. Any component may be NEGATIVE
 *  when the mask carries a mutation that trades one stat for another; the sum is
 *  deliberately NOT floored here, because it is applied and peeled back off in equal
 *  and opposite places (makeOwned bakes it in, buildPlayerUnits subtracts it to
 *  recover the species' raw stat). Clamping at one end and not the other would make
 *  the two disagree — the floor belongs where a stat becomes combat behaviour. */
export function mutationBonus(mask: number): { str: number; con: number; dex: number } {
  const b = { str: 0, con: 0, dex: 0 };
  for (const m of mutationsOf(mask)) {
    for (const { stat, amount } of statEffectsOf(m)) b[stat] += amount;
  }
  return b;
}

/**
 * Zombie Pot slot-inheritance: combine two parent masks into a child mask.
 *   - Non-conflicting slot (only one parent has it): child inherits it.
 *   - Same mutation on both: child inherits it.
 *   - Different mutations in the same slot: the one LATER IN THE CATALOG wins.
 * One-per-slot always holds. This is DETERMINISTIC — no RNG.
 *
 * GROUND TRUTH (from the shipped iOS binary — `ZFZombieCombiner
 * combineZombieMutationFlag:withZombieFlag:` + `randMutation:flag1:flag2:controlFlag:`;
 * see docs/mechanics/BINARY_RE_METHODOLOGY.md): the real `randMutation:` contains no
 * `rand`/`arc4random` call. A same-slot conflict resolves via `cmp; movle` = MAX of the
 * two mutation bits. ZF2 numbered its bits in TIER order — Tomatohead first, Dragon-arm
 * last — so "higher bit" meant "higher tier", and the better mutation always won its
 * slot. (Earlier builds guessed a 50/50 coin flip here; that was wrong.)
 *
 * CATALOG preserves that: position sets the bit, so a mutation appended later beats
 * every earlier one in its slot. Author a new mutation knowing it lands at the TOP of
 * its slot's tier ladder — that is the one design consequence of append-only ordering.
 */
export function combineMasks(a: number, b: number, isHeadlessChild = false): number {
  // Each parent first loses what the CHILD's body type can't wear, so a mutation the
  // child could keep never loses its slot to one that is about to be stripped (a
  // headless child must keep a Pumpking parent's head rather than lose the slot to
  // the garlic head it is about to shed).
  //
  // This is also the ONE way the pumpkin reaches a zombie that has a head of its own:
  // it can't be grown on one (bitGrowable), but nothing stops it being inherited, and
  // as the highest head bit it wins the slot outright.
  const maskA = applyBodyTypeRestriction(a, isHeadlessChild);
  const maskB = applyBodyTypeRestriction(b, isHeadlessChild);
  let child = 0;
  for (const slot of SLOTS) {
    const am = maskIntersect(maskA, SLOT_MASK[slot]);
    const bm = maskIntersect(maskB, SLOT_MASK[slot]);
    if (am === 0 && bm === 0) continue; // neither -> empty slot
    if (am === 0) { child = maskUnion(child, bm); continue; } // only B
    if (bm === 0) { child = maskUnion(child, am); continue; } // only A
    child = maskUnion(child, Math.max(am, bm)); // both -> higher-tier bit wins
  }
  return child;
}
