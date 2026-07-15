import { describe, expect, it } from "vitest";
import { footprintOrigin, gridToScreen, HH, screenToGrid } from "./iso";

describe("footprintOrigin", () => {
  it("maps a 4x4 plot's visual center back to its origin", () => {
    const origin = { col: 12, row: 9 };
    const top = gridToScreen(origin.col, origin.row);
    const picked = screenToGrid(top.x, top.y + 4 * HH);

    expect(footprintOrigin(Math.round(picked.col), Math.round(picked.row), 4))
      .toEqual({ oc: origin.col, or: origin.row });
  });
});
