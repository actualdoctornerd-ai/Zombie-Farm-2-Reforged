// What the storage shed will and will not take, and why.
//
// Two entry points ask the same question and need the same answer: the object
// action sheet (which greys out its Store button) and the Move tool's drop-onto-
// the-shed gesture (which refuses the drop and says so). Keeping the rule here
// means they cannot drift apart, and that the reason a refusal gives is the reason
// the check actually used.
import type { PlaceableDef } from "./assets";

/** Why the shed will not take something. `null` = it will. */
export type StoreBlock = "holds" | "potInUse" | "full";

/** The part of a def this rule reads. Deliberately narrow: a Received reward has a
 *  def but no object on the farm yet, and asks the same question. */
export type StorableDef = Pick<
  PlaceableDef, "storageSlots" | "zombieStorage" | "zombiePot"
>;

/** How full the shed is right now. */
export interface ShedSpace {
  used: number;
  cap: number;
}

/** What the particular copy being shelved is in the middle of. Omitted when there
 *  is no copy yet (a reward still sitting in Received). */
export interface StoreSubject {
  /** This object is a Zombie Pot with a combine in it — running, or finished and
   *  not yet collected. The shed holds a key and a count and nothing else, so
   *  shelving it would throw away a job that has already eaten two zombies. */
  potInUse?: boolean;
}

/** Why this cannot go in the shed, or null when it can.
 *
 *  Order matters: a Mausoleum is never storable however empty the shed is, and a
 *  busy Pot is refused for its own reason rather than being lumped in with a full
 *  shed — the two have completely different fixes. */
export function storeBlock(
  def: StorableDef,
  shed: ShedSpace,
  subject: StoreSubject = {},
): StoreBlock | null {
  // A building that HOLDS things cannot itself be put away: the shed cannot contain
  // itself, and packing the Mausoleum would take the crypt out from under its
  // occupants. Mirrored authoritatively by the Worker's object.status rule.
  if (def.storageSlots || def.zombieStorage) return "holds";
  if (def.zombiePot && subject.potInUse) return "potInUse";
  if (shed.used >= shed.cap) return "full";
  return null;
}

/** Label for a disabled Store button — short enough to sit on one. */
export function storeBlockLabel(block: StoreBlock): string {
  switch (block) {
    case "holds": return "Can't be stored";
    case "potInUse": return "Pot in use";
    case "full": return "Storage full";
  }
}

/** Full sentence for a refused drop, which has room to explain the fix. */
export function storeBlockMessage(block: StoreBlock, name: string): string {
  switch (block) {
    case "holds":
      return `${name} can't go in the shed — it holds things of its own.`;
    case "potInUse":
      return `${name} can't go in the shed — collect the combine inside it first.`;
    case "full":
      return `${name} can't go in the shed — your shed is full.`;
  }
}
