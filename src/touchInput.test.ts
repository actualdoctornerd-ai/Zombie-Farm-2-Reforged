import { describe, expect, it } from "vitest";
import {
  gestureMoved,
  isDeferredTouchMode,
  isTouchPointer,
  MOUSE_TAP_SLOP,
  TOUCH_TAP_SLOP,
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

  it("defers every irreversible edit tool until a touch is confirmed", () => {
    for (const mode of ["place", "move", "remove", "instagrow", "rotate"])
      expect(isDeferredTouchMode(mode), mode).toBe(true);
    for (const mode of ["walk", "till", "plant"])
      expect(isDeferredTouchMode(mode), mode).toBe(false);
  });
});
