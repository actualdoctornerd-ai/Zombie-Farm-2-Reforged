import { describe, expect, it } from "vitest";
import { wheelZoomFactor, ZOOM_PER_NOTCH } from "./wheelZoom";

describe("wheel zoom", () => {
  it("zooms one notch per classic notch, in on wheel up and out on wheel down", () => {
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(ZOOM_PER_NOTCH, 10);
    expect(wheelZoomFactor(100, 0)).toBeCloseTo(1 / ZOOM_PER_NOTCH, 10);
  });

  it("zooms a notch split into a burst of small events by the same amount as one event", () => {
    // A free-spinning or high-resolution wheel reports a notch as many small deltas.
    let factor = 1;
    for (let i = 0; i < 10; i++) factor *= wheelZoomFactor(10, 0);
    expect(factor).toBeCloseTo(1 / ZOOM_PER_NOTCH, 10);
    // A trackpad's tiny drift barely moves the camera, instead of a full step.
    expect(wheelZoomFactor(2, 0)).toBeCloseTo(Math.pow(ZOOM_PER_NOTCH, -0.02), 10);
  });

  it("reads Firefox's line mode as the same notch", () => {
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(100, 0), 10);
    expect(wheelZoomFactor(-1, 2)).toBeCloseTo(wheelZoomFactor(-500, 0), 10);
  });

  it("caps what one event may do, so a fast spin runs rather than jumps", () => {
    expect(wheelZoomFactor(100_000, 0)).toBeCloseTo(Math.pow(ZOOM_PER_NOTCH, -3), 10);
    expect(wheelZoomFactor(-100_000, 0)).toBeCloseTo(Math.pow(ZOOM_PER_NOTCH, 3), 10);
  });
});
