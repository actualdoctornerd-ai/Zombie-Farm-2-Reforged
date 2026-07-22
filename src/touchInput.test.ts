import { describe, expect, it } from "vitest";
import {
  captureTouchPointer,
  gestureMoved,
  isDeferredTouchMode,
  isTouchPointer,
  isZombieHold,
  MOUSE_TAP_SLOP,
  TOUCH_TAP_SLOP,
  TOUCH_ZOMBIE_HOLD_MS,
} from "./touchInput";

describe("farm touch gesture classification", () => {
  it("keeps ordinary finger jitter classified as a tap", () => {
    expect(gestureMoved(100, 100, 108, 108, "touch")).toBe(false);
    expect(gestureMoved(100, 100, 100 + TOUCH_TAP_SLOP, 100, "touch")).toBe(false);
  });

  it("turns a deliberate finger drag into movement", () => {
    expect(gestureMoved(100, 100, 100 + TOUCH_TAP_SLOP + 1, 100, "touch")).toBe(true);
  });

  it("retains the precise desktop mouse threshold", () => {
    expect(gestureMoved(0, 0, MOUSE_TAP_SLOP, 0, "mouse")).toBe(false);
    expect(gestureMoved(0, 0, MOUSE_TAP_SLOP + 1, 0, "mouse")).toBe(true);
  });

  it("does not treat a pen or mouse as a touch pointer", () => {
    expect(isTouchPointer("touch")).toBe(true);
    expect(isTouchPointer("pen")).toBe(false);
    expect(isTouchPointer("mouse")).toBe(false);
  });

  it("captures Android touch pointers on the game canvas", () => {
    const captured: number[] = [];
    const target = { setPointerCapture: (id: number) => captured.push(id) };
    expect(captureTouchPointer(target, 17, "touch")).toBe(true);
    expect(captured).toEqual([17]);
  });

  it("leaves non-touch and legacy touch-event paths alone", () => {
    const target = { setPointerCapture: () => { throw new Error("no active pointer"); } };
    expect(captureTouchPointer(target, 1, "mouse")).toBe(false);
    expect(captureTouchPointer(target, 2, "touch")).toBe(false);
  });

  it("defers every irreversible edit tool until a touch is confirmed", () => {
    for (const mode of ["place", "move", "remove", "instagrow", "rotate"])
      expect(isDeferredTouchMode(mode), mode).toBe(true);
    for (const mode of ["walk", "till", "plant"])
      expect(isDeferredTouchMode(mode), mode).toBe(false);
  });

  it("reserves zombie selection for an unmoved touch hold", () => {
    expect(isZombieHold("touch", TOUCH_ZOMBIE_HOLD_MS - 1, false)).toBe(false);
    expect(isZombieHold("touch", TOUCH_ZOMBIE_HOLD_MS, false)).toBe(true);
    expect(isZombieHold("touch", TOUCH_ZOMBIE_HOLD_MS + 100, true)).toBe(false);
    expect(isZombieHold("mouse", TOUCH_ZOMBIE_HOLD_MS, false)).toBe(false);
  });
});
