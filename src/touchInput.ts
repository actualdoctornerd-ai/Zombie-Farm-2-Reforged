// Shared gesture thresholds. Mouse movement is precise enough for the original
// three-pixel cutoff; a finger naturally wanders farther while making a tap.
export const MOUSE_TAP_SLOP = 3;
export const TOUCH_TAP_SLOP = 14;
export const TOUCH_SELECT_TAP_SLOP = 32;
export const TOUCH_ZOMBIE_HOLD_MS = 450;

export function isTouchPointer(pointerType: string): boolean {
  return pointerType === "touch";
}

/** Keep a touch gesture owned by the game canvas until pointer-up. Mobile HUD
 * changes can otherwise move a DOM control under the finger after pointer-down,
 * causing Android to retarget the release and Pixi to miss the tap entirely.
 * Legacy TouchEvent browsers do not have an active PointerEvent to capture, so
 * setPointerCapture may throw there; falling back to Pixi's normal path is safe. */
export function captureTouchPointer(
  target: Pick<Element, "setPointerCapture">,
  pointerId: number,
  pointerType: string,
): boolean {
  if (!isTouchPointer(pointerType)) return false;
  try {
    target.setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

const DEFERRED_TOUCH_MODES = new Set(["place", "move", "remove", "instagrow", "rotate"]);

/** Mutating tools that must wait for finger-up because their effects cannot be
 * reliably rolled back if a second finger begins a pinch. */
export function isDeferredTouchMode(mode: string): boolean {
  return DEFERRED_TOUCH_MODES.has(mode);
}

/** Plant-mode drags normally paint plots, but a finger that starts beyond the
 * farm has no valid planting target and should retain the camera-pan affordance. */
export function isOutsideFarmPanGesture(
  pointerType: string,
  mode: string,
  inFarmBounds: boolean,
): boolean {
  return isTouchPointer(pointerType) && mode === "plant" && !inFarmBounds;
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

/** Zombies use a distinct hold gesture on touch screens so an overlapping unit
 * can never steal a quick tap intended for the plot beneath it. */
export function isZombieHold(pointerType: string, heldMs: number, moved: boolean): boolean {
  return isTouchPointer(pointerType) && !moved && heldMs >= TOUCH_ZOMBIE_HOLD_MS;
}

/** Select-tool taps get a little more forgiveness than camera/tool gestures.
 * Quick finger contact often wanders after crossing the pan threshold, but a
 * short wobble should still activate the plot beneath the release point. */
export function isSelectTapGesture(pointerType: string, moved: boolean, maxDistance: number): boolean {
  return !moved || (isTouchPointer(pointerType) && maxDistance <= TOUCH_SELECT_TAP_SLOP);
}
