// Shared gesture thresholds. Mouse movement is precise enough for the original
// three-pixel cutoff; a finger naturally wanders farther while making a tap.
export const MOUSE_TAP_SLOP = 3;
export const TOUCH_TAP_SLOP = 14;

export function isTouchPointer(pointerType: string): boolean {
  return pointerType === "touch";
}

const DEFERRED_TOUCH_MODES = new Set(["place", "move", "remove", "instagrow", "rotate"]);

/** Mutating tools that must wait for finger-up because their effects cannot be
 * reliably rolled back if a second finger begins a pinch. */
export function isDeferredTouchMode(mode: string): boolean {
  return DEFERRED_TOUCH_MODES.has(mode);
}

export function gestureMoved(
  startX: number,
  startY: number,
  x: number,
  y: number,
  pointerType: string
): boolean {
  const slop = isTouchPointer(pointerType) ? TOUCH_TAP_SLOP : MOUSE_TAP_SLOP;
  return Math.hypot(x - startX, y - startY) > slop;
}
