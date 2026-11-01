import { describe, expect, it } from "vitest";
import { GHOST_RADIUS_PX, GHOST_WINDOW_MS, isGhostClick } from "./ghostClick";

describe("isGhostClick", () => {
  const last = { x: 100, y: 200, t: 1000 };

  it("swallows the echo of a canvas tap at the same spot", () => {
    expect(isGhostClick(last, 102, 199, 1100)).toBe(true);
  });

  it("lets a tap elsewhere through", () => {
    expect(isGhostClick(last, 100 + GHOST_RADIUS_PX + 5, 200, 1100)).toBe(false);
  });

  it("lets a later tap at the same spot through", () => {
    expect(isGhostClick(last, 100, 200, 1000 + GHOST_WINDOW_MS + 1)).toBe(false);
  });

  it("does nothing without a recent canvas touch", () => {
    expect(isGhostClick(null, 100, 200, 1100)).toBe(false);
  });
});
