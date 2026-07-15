// Isometric coordinate math for a 2:1 diamond grid.
// Tile is TILE_W x TILE_H (48 x 24 in ZF2R). Half-extents drive all conversions.

// Base tile diamond size (2:1). Small tiles: a farming PLOT is 4x4 of these
// (see Field.PLOT), and a full plot ends up ~the size a single tile used to be,
// so the farmer stays "a bit shorter than a plot" while the land grid is finer.
export const TILE_W = 47; // ~10% smaller than the old 52 (keeps the 2:1 ratio)
export const TILE_H = 23.5;
export const HW = TILE_W / 2; // 23.5
export const HH = TILE_H / 2; // 11.75

// Grid (col,row) -> world-space pixel of the tile's TOP-CENTER point.
// Ground sprites are anchored at (0.5, 0) so their diamond sits on this point.
export function gridToScreen(col: number, row: number): { x: number; y: number } {
  return {
    x: (col - row) * HW,
    y: (col + row) * HH,
  };
}

// Center of a tile's diamond in world space (used to place/route the actor).
export function tileCenter(col: number, row: number): { x: number; y: number } {
  const p = gridToScreen(col, row);
  return { x: p.x, y: p.y + HH };
}

/** Origin of an even-sized square footprint visually centered on a picked tile. */
export function footprintOrigin(col: number, row: number, size: number): { oc: number; or: number } {
  return { oc: col - size / 2, or: row - size / 2 };
}

// World-space pixel -> fractional grid coords. Invert gridToScreen, accounting
// for the tile-center offset (we pick against tile centers, not top points).
export function screenToGrid(x: number, y: number): { col: number; row: number } {
  const yy = y - HH; // shift from top-point space into center space
  const col = (x / HW + yy / HH) / 2;
  const row = (yy / HH - x / HW) / 2;
  return { col, row };
}

// Depth key for painter's-algorithm sorting: larger = drawn later (more "south").
export function depth(col: number, row: number): number {
  return col + row;
}
