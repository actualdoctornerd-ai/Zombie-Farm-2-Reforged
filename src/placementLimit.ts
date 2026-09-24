// How many copies of a placeable the farm still has room for.
//
// Most Market items can be placed over and over, so buying one enters a placement
// mode that persists across taps. The one-per-farm functional items (the coloured
// graves, the monoliths, the Zombie Patch, the shed, the Mausoleum) and the
// three-Pot cap are the exceptions: once the last allowed copy is down, further
// taps do nothing. Placement mode has to end there, or the player is left dragging
// a ghost of something they can never put down.
import type { PlaceableDef } from "./assets";

/** Zombie Pots allowed on one farm. Mirrored by placeablePurchaseLimit. */
export const MAX_ZOMBIE_POTS = 3;

/** The bit of the farm a placement limit depends on — structurally a Field. */
export interface PlacementFarm {
  shedId(): string | null;
  mausoleumId(): string | null;
  patchId(): string | null;
  hasGrave(color: "Blue" | "Red" | "Silver" | "Obsidian"): boolean;
  hasPlowFree(): boolean;
  hasFastWork(): boolean;
  hasMutantMonolith(): boolean;
  hasCombineMonolith(): boolean;
  zombiePotCount(): number;
}

/** True when the farm already holds every copy of `def` it is allowed. Checked
 *  before a placement to reject it, and again right after one so the placement
 *  ghost can be dismissed the moment the last allowed copy goes down. */
export function noRoomForAnother(def: PlaceableDef, farm: PlacementFarm): boolean {
  if (def.storageSlots && farm.shedId()) return true; // only one shed on the farm
  if (def.zombieStorage && farm.mausoleumId()) return true; // only one Mausoleum
  if (def.zombiePatch && farm.patchId()) return true; // only one Zombie Patch
  if (def.graveColor && farm.hasGrave(def.graveColor)) return true; // one of each grave
  if (def.plowFree && farm.hasPlowFree()) return true; // only one Plowing Monolith
  if (def.fastWork && farm.hasFastWork()) return true; // only one Speed Monolith
  if (def.mutantMonolith && farm.hasMutantMonolith()) return true; // only one Mutant Monolith
  if (def.combineFast && farm.hasCombineMonolith()) return true; // only one Clay Monolith
  if (def.zombiePot && farm.zombiePotCount() >= MAX_ZOMBIE_POTS) return true;
  return false;
}
