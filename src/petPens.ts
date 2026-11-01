// Pet Pen slots, shared by the client and the Worker.
//
// A farm may own up to MAX_PET_PENS pens, each holding PETS_PER_PEN pets. All of
// them live in ONE flat list of slots: pen i owns `slots[i * PETS_PER_PEN ..]`, and
// "" is an empty slot. Emptying a slot never shifts the pets behind it, so taking a
// pet out of the first pen cannot walk one of the second pen's pets into it. A save
// from the one-pen era (at most four keys, no blanks) reads as pen 0 unchanged.
//
// Pens are matched to slot groups by their order on the farm (Field.petPens), so the
// list says "the second pen", not which object that is.
import { MAX_PEN_SLOTS, PETS_PER_PEN } from "./net/protocol";

/** Tidy a slot list: a pet appears once (its first slot wins), a key `keep`
 *  refuses becomes an empty slot, nothing past MAX_PEN_SLOTS survives, and
 *  trailing empties are dropped. */
export function normalizePenSlots(
  slots: readonly unknown[],
  keep: (key: string) => boolean = () => true,
): string[] {
  const seen = new Set<string>();
  const out = slots.slice(0, MAX_PEN_SLOTS).map((key) => {
    if (typeof key !== "string" || !key || seen.has(key) || !keep(key)) return "";
    seen.add(key);
    return key;
  });
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** The pets in pen `pen` (0-based), in slot order. */
export function penOccupants(slots: readonly string[], pen: number): string[] {
  return slots.slice(pen * PETS_PER_PEN, (pen + 1) * PETS_PER_PEN).filter(Boolean);
}

/** Which pen holds `key`, or -1. */
export function penOf(slots: readonly string[], key: string): number {
  const at = slots.indexOf(key);
  return key && at >= 0 ? Math.floor(at / PETS_PER_PEN) : -1;
}

/** Every pet in any pen. */
export function pennedPets(slots: readonly string[]): string[] {
  return slots.filter(Boolean);
}

/** The slots with `key` taken out of whichever pen held it. */
export function withoutPenPet(slots: readonly string[], key: string): string[] {
  return normalizePenSlots(slots.map((slot) => (slot === key ? "" : slot)));
}

/** The slots with `key` moved into the first free slot of `pen` (out of any other
 *  pen it was in). Null when that pen is already full. */
export function withPenPet(slots: readonly string[], pen: number, key: string): string[] | null {
  const next = slots.map((slot) => (slot === key ? "" : slot));
  for (let i = pen * PETS_PER_PEN; i < (pen + 1) * PETS_PER_PEN; i++) {
    if (next[i]) continue;
    while (next.length < i) next.push("");
    next[i] = key;
    return normalizePenSlots(next);
  }
  return null;
}
