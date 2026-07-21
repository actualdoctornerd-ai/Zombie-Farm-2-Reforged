import { describe, expect, it } from "vitest";
import { clampPointToGrid, footprintOrigin, gridToScreen, HH, screenToGrid, tileCenter } from "./iso";

describe("footprintOrigin", () => {
  it("maps a 4x4 plot's visual center back to its origin", () => {
    const origin = { col: 12, row: 9 };
    const top = gridToScreen(origin.col, origin.row);
    const picked = screenToGrid(top.x, top.y + 4 * HH);

    expect(footprintOrigin(Math.round(picked.col), Math.round(picked.row), 4))
      .toEqual({ oc: origin.col, or: origin.row });
  });
});

describe("clampPointToGrid", () => {
  it("moves a work point beyond the far farm edge onto the nearest tile", () => {
    const outside = tileCenter(30, 30);

    expect(clampPointToGrid(outside.x, outside.y, 30, 30)).toEqual(tileCenter(29, 29));
  });

  it("does not alter an in-bounds authored work point", () => {
    const point = { x: 123.5, y: 234.25 };

    expect(clampPointToGrid(point.x, point.y, 30, 30)).toEqual(point);
  });
});
