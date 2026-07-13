// Isometric painter's-order sorting for the shared entity layer (crops, placed
// objects, foliage, the farmer, wandering zombies).
//
// GROUND TRUTH (recovered from the ZF2 iOS binary): the original does NOT sort by
// a single depth scalar. Static tiles are keyed at their FRONT (south) corner
// depth = tileX + tileY, but the game then SCANS the tiles neighbouring an
// object's footprint and splices the sprite into the layer at the exact child
// index that keeps footprints ordered (`-[ZFTileManager addTile:toTileCoordinate:]`
// -> `insertChild:atIndex:z:`). A lone scalar can't express that, which is why a
// character standing on/near a multi-tile object used to be painted over.
//
// We reproduce the footprint ordering directly: every entity registers the tile
// RANGE it occupies, and each frame we topologically sort the layer using the
// standard isometric separating rule (A is behind B if A lies entirely on the far
// side of B along either grid axis). Non-separated (overlapping) pairs fall back
// to a depth key so a character on an object's own tiles draws in front of it.
import { Container } from "pixi.js";

export interface Footprint {
  c0: number; // min tile column (north-west corner)
  r0: number; // min tile row
  c1: number; // max tile column (south-east / front corner)
  r1: number; // max tile row
  bias: number; // tie-break nudge for overlapping footprints (actors > statics)
}

const FP = Symbol("depthFootprint");

/** Register the tile footprint an entity occupies (call whenever it moves/relays).
 *  A point entity (actor/zombie) passes the same tile for both corners. */
export function setFootprint(
  node: Container, c0: number, r0: number, c1: number, r1: number, bias = 0
) {
  (node as unknown as { [FP]?: Footprint })[FP] = { c0, r0, c1, r1, bias };
}

function getFootprint(node: Container): Footprint | undefined {
  return (node as unknown as { [FP]?: Footprint })[FP];
}

// A is behind B (must be drawn first) when A sits entirely on the far, camera-away
// side of B along one grid axis — the isometric separating-axis test. Inclusive
// ranges, so touching footprints (shared edge) are treated as overlapping and left
// to the depth-key tie-break rather than forced apart.
function behind(a: Footprint, b: Footprint): boolean {
  return a.c1 < b.c0 || a.r1 < b.r0;
}

const key = (f: Footprint) => f.c0 + f.r0 + f.bias;

// Deterministic paint order among entities the topo-sort leaves ambiguous
// (overlapping or perpendicular footprints, and any cycle leftovers). We load them
// back-to-front by depth key, then TOP-TO-BOTTOM (north row first) and LEFT-TO-RIGHT
// (west column first). This is the reading order of the grid, so a crop patch and a
// placed object on the same diagonal always stack the same way frame to frame — no
// popping when a plot relays or an object is added. `a` sorts before `b` here means
// `a` is painted first (further back / lower zIndex).
function before(a: Footprint, b: Footprint): boolean {
  const ka = key(a), kb = key(b);
  if (ka !== kb) return ka < kb;   // back-to-front depth (the isometric anti-diagonal)
  if (a.r0 !== b.r0) return a.r0 < b.r0; // top-to-bottom: north row loads first
  return a.c0 < b.c0;                    // left-to-right: west column loads first
}

/** Assign zIndex to every footprint-registered child of `layer` so painter's order
 *  respects isometric footprints (multi-tile objects and moving actors alike).
 *  Children without a footprint are ignored (they keep whatever zIndex they had). */
export function sortLayer(layer: Container) {
  const kids = layer.children as Container[];
  const nodes: Container[] = [];
  const fps: Footprint[] = [];
  for (const k of kids) {
    const fp = getFootprint(k);
    if (fp) { nodes.push(k); fps.push(fp); }
  }
  const n = nodes.length;
  if (n === 0) return;

  // "after[i]" = entities that must be drawn AFTER i (i is behind them).
  const after: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (behind(fps[a], fps[b])) { after[a].push(b); indeg[b]++; }
      else if (behind(fps[b], fps[a])) { after[b].push(a); indeg[a]++; }
    }
  }

  // Kahn's algorithm; among the currently-drawable set pick the one that loads first
  // by `before` (depth key, then top-to-bottom, then left-to-right) so overlapping/
  // perpendicular ties resolve deterministically back-to-front. If a cycle remains
  // (interlocking footprints — rare on a farm) we break it by the same order among
  // all leftovers.
  const done = new Array<boolean>(n).fill(false);
  let placed = 0;
  let z = 0;
  while (placed < n) {
    let pick = -1;
    let cycleFallback = -1;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      if (cycleFallback === -1 || before(fps[i], fps[cycleFallback])) cycleFallback = i;
      if (indeg[i] !== 0) continue;
      if (pick === -1 || before(fps[i], fps[pick])) pick = i;
    }
    if (pick === -1) pick = cycleFallback; // cycle: force-place the most-behind leftover
    done[pick] = true;
    placed++;
    nodes[pick].zIndex = z++;
    for (const b of after[pick]) indeg[b]--;
  }
}
