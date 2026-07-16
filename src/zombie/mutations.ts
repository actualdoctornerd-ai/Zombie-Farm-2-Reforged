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
// Acquisition in ZF2 (crop-adjacency was removed): buy a pre-mutated Market
// zombie (guaranteed mutation), or combine two zombies in the Zombie Pot.
// ---------------------------------------------------------------------------

export type Slot = "head" | "hair_eye" | "arm" | "body" | "neck";
export const SLOTS: Slot[] = ["head", "hair_eye", "arm", "body", "neck"];

export type Stat = "str" | "con" | "dex";

export interface MutationDef {
  bit: number; // power-of-two mask value
  key: string; // stable id
  name: string; // display name of the resulting zombie
  slot: Slot;
  stat: Stat; // which combat stat the bonus adds to
  amount: number; // bonus magnitude
}

// The 13 primary mutations, keyed by bit. Slot is authoritative from the bit
// (that is how ZF2 stores/enforces it); the stat mapping is power/attack->str,
// life->con, speed->dex. Eyebiscus (bit 4) and Heartichoke (bit 512) are Tier-4
// visual variants that reuse an existing bit, so they need no separate entry.
export const MUTATIONS: Record<number, MutationDef> = {
  1: { bit: 1, key: "tomato", name: "Tomatohead", slot: "head", stat: "str", amount: 1 },
  2: { bit: 2, key: "onion", name: "Onionhead", slot: "head", stat: "con", amount: 1 },
  4: { bit: 4, key: "carrot", name: "Carrot-eyed", slot: "hair_eye", stat: "dex", amount: 1 },
  8: { bit: 8, key: "turnip", name: "Turnip-Arm", slot: "arm", stat: "str", amount: 2 },
  16: { bit: 16, key: "potato", name: "Potatohead", slot: "head", stat: "con", amount: 2 },
  32: { bit: 32, key: "coffee", name: "Coffeehead", slot: "head", stat: "dex", amount: 2 },
  64: { bit: 64, key: "celery", name: "Celery-arms", slot: "arm", stat: "str", amount: 3 },
  128: { bit: 128, key: "broccoli", name: "Broccohair", slot: "hair_eye", stat: "con", amount: 3 },
  256: { bit: 256, key: "garlic", name: "Garlichead", slot: "head", stat: "str", amount: 3 },
  512: { bit: 512, key: "cauli", name: "Cauli-hair", slot: "hair_eye", stat: "con", amount: 3 },
  1024: { bit: 1024, key: "limabean", name: "Lima Bean", slot: "body", stat: "con", amount: 3 },
  2048: { bit: 2048, key: "flytrap", name: "Flytrap", slot: "neck", stat: "con", amount: 4 },
  4096: { bit: 4096, key: "dragon", name: "Dragon-arm", slot: "arm", stat: "str", amount: 4 },
};

/** All known mutation bits (the ones we resolve). */
export const ALL_BITS: number[] = Object.keys(MUTATIONS).map(Number);

/** Bitmask of every mutation belonging to a slot. Used to test slot occupancy. */
export const SLOT_MASK: Record<Slot, number> = (() => {
  const m: Record<Slot, number> = { head: 0, hair_eye: 0, arm: 0, body: 0, neck: 0 };
  for (const bit of ALL_BITS) m[MUTATIONS[bit].slot] |= bit;
  return m;
})();

/** The slot a mutation bit occupies, or null if the bit is unknown. */
export function slotOf(bit: number): Slot | null {
  return MUTATIONS[bit]?.slot ?? null;
}

/** Every individual mutation bit set in a mask, low bit first. */
export function bitsOf(mask: number): number[] {
  return ALL_BITS.filter((b) => (mask & b) !== 0);
}

/** Resolved mutation defs present in a mask (skips unknown/unmapped bits). */
export function mutationsOf(mask: number): MutationDef[] {
  return bitsOf(mask).map((b) => MUTATIONS[b]);
}

/** Which slots are already filled in a mask. */
export function occupiedSlots(mask: number): Set<Slot> {
  const s = new Set<Slot>();
  for (const slot of SLOTS) if ((mask & SLOT_MASK[slot]) !== 0) s.add(slot);
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
// mutations — never head or hair/eye (report §11). These are the slots it MAY hold
// and the bitmask of everything it may NOT.
export const HEADLESS_SLOTS: ReadonlySet<Slot> = new Set<Slot>(["body", "arm", "neck"]);
export const HEADLESS_FORBIDDEN_MASK = SLOT_MASK.head | SLOT_MASK.hair_eye;

/** Is a slot allowed on a (possibly headless) zombie? Headless bars head/hair_eye. */
export function slotAllowed(slot: Slot, isHeadless: boolean): boolean {
  return !isHeadless || HEADLESS_SLOTS.has(slot);
}

/**
 * Drop mutations a headless zombie can't hold (head + hair/eye). A no-op for a
 * normal zombie. Applied wherever a mask lands on a unit, so a headless combine
 * result simply never carries a head/hair-eye mutation.
 */
export function applyHeadlessRestriction(mask: number, isHeadless: boolean): number {
  return isHeadless ? mask & ~HEADLESS_FORBIDDEN_MASK : mask;
}

/**
 * Can `bit` legally be added to `mask`? False if the bit is unknown, its slot is
 * already occupied (one-per-slot), or the zombie is headless and the slot is a
 * head/hair-eye slot. Adding a bit already present is a no-op and reported legal.
 */
export function canReceive(mask: number, bit: number, isHeadless = false): boolean {
  const slot = slotOf(bit);
  if (slot === null) return false;
  if (!slotAllowed(slot, isHeadless)) return false; // headless: no head/hair_eye
  if ((mask & bit) !== 0) return true; // already have exactly this one
  return (mask & SLOT_MASK[slot]) === 0; // slot must be empty
}

/**
 * Add `bit` to `mask`, enforcing one-per-slot (and the headless restriction when
 * `isHeadless`). If the write is illegal `mask` is returned unchanged (the caller
 * decides conflict resolution — see combineMasks). Returns the new mask.
 */
export function addMutation(mask: number, bit: number, isHeadless = false): number {
  return canReceive(mask, bit, isHeadless) ? mask | bit : mask;
}

/** Human-readable list, e.g. "Onionhead, Celery-arms". "" when unmutated. */
export function mutationLabel(mask: number): string {
  return mutationsOf(mask)
    .map((m) => m.name)
    .join(", ");
}

/** Market-facing summary for a pre-mutated zombie's guaranteed combat bonus. */
export function mutationDescription(mask: number): string | undefined {
  const labels: Record<Stat, string> = { str: "strength", con: "life", dex: "speed" };
  const effects = mutationsOf(mask).map((m) => `${m.name} (+${m.amount} ${labels[m.stat]})`);
  return effects.length
    ? `Starts with a guaranteed mutation: ${effects.join(", ")}. Mutations carry into Zombie Pot combinations.`
    : undefined;
}

/** Summed stat bonuses from all mutations in a mask. */
export function mutationBonus(mask: number): { str: number; con: number; dex: number } {
  const b = { str: 0, con: 0, dex: 0 };
  for (const m of mutationsOf(mask)) b[m.stat] += m.amount;
  return b;
}

/**
 * Zombie Pot slot-inheritance: combine two parent masks into a child mask.
 *   - Non-conflicting slot (only one parent has it): child inherits it.
 *   - Same mutation on both: child inherits it.
 *   - Different mutations in the same slot: keep the HIGHER bit value.
 * One-per-slot always holds. This is DETERMINISTIC — no RNG.
 *
 * GROUND TRUTH (from the shipped iOS binary — `ZFZombieCombiner
 * combineZombieMutationFlag:withZombieFlag:` + `randMutation:flag1:flag2:controlFlag:`;
 * see docs/mechanics/BINARY_RE_METHODOLOGY.md): the real `randMutation:` contains no
 * `rand`/`arc4random` call. A same-slot conflict resolves via `cmp; movle` = MAX of the
 * two mutation bits. Because bits are numbered in tier order (Tomato=1 … Dragon=0x1000,
 * variants higher), the higher bit is the higher-tier mutation — so the better mutation
 * always wins its slot. (Earlier builds guessed a 50/50 coin flip here; that was wrong.)
 */
export function combineMasks(a: number, b: number): number {
  let child = 0;
  for (const slot of SLOTS) {
    const am = a & SLOT_MASK[slot];
    const bm = b & SLOT_MASK[slot];
    if (am === 0 && bm === 0) continue; // neither -> empty slot
    if (am === 0) { child |= bm; continue; } // only B
    if (bm === 0) { child |= am; continue; } // only A
    child |= Math.max(am, bm); // both -> higher-tier bit wins (deterministic)
  }
  return child;
}
