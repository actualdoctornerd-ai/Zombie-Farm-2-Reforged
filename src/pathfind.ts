// 8-neighbour weighted A* on the tile grid. Solid placed objects are the only hard
// blockers (see Field.isPassable); everything else has a PRICE instead — a road is
// cheaper than grass, a pond dearer, a hedge ruinous. src/pathCosts.ts owns those
// numbers; this module only knows that a tile costs something and that `Infinity`
// means no.
//
// Actors can end up STANDING on a blocked tile — a bought zombie lands on a tile
// an object already covers, or an object is moved on top of one that was standing
// there. A plain A* from such a tile finds nothing (every neighbour inside a
// multi-tile object is blocked too) and the actor is stuck for good. So a search
// that starts inside an obstruction first walks OUT through it, then paths
// normally from the open ground it reaches.
//
// A route may also step through a PORTAL: a pair of wormhole pads links two distant
// tiles as if they were neighbours. That edge is a deliberate part of the graph, not
// an accident of standing on one — the search picks it because it is short, and the
// step it produces is the one place a route jumps (see `isWarpStep`).
export interface Cell {
  col: number;
  row: number;
}

type Passable = (col: number, row: number) => boolean;
type TileCost = (col: number, row: number) => number;

export interface PathOptions {
  /** Bounds the escape search when the start tile is blocked — without it the
   *  search drifts off the field, where nothing is ever walkable. */
  inBounds?: Passable;
  /** How far, in tiles, an escape may look for open ground. Comfortably clears
   *  the largest placeable (10x10) from anywhere inside it. */
  escapeRadius?: number;
  /** Price of entering a tile. Defaults to a flat 1, i.e. plain shortest-hop A*. */
  cost?: TileCost;
  /** Where stepping onto this tile comes out, for the tiles that are wormhole pads.
   *  Supplying it turns the heuristic off — see `search`. */
  portal?: (col: number, row: number) => Cell | null;
  /** The cheapest any tile can cost. The heuristic is scaled by it, and is only
   *  admissible while nothing undercuts it: pass the minimum of whatever table
   *  `cost` reads from (Field passes COST_PATH). */
  minTileCost?: number;
  /** At or above this a tile is a BARRIER — a hedge, a shut gate — and the search
   *  will not route through one while any barrier-free route exists. Pricing them
   *  dearly is not enough on its own: a walker fenced into a pen has no cheaper
   *  option, so it strolls out through the fence, which is the whole thing a fence
   *  is for. See `findPath`. */
  avoidCost?: number;
  /** May the route cross a barrier when there is no way round at all? True for a
   *  walker under orders — the farmer told to go somewhere only reachable through a
   *  fence has to obey, and he takes the cheapest way through, which is why a shut
   *  gate is priced below the fence it sits in. False (the default) for anything
   *  choosing its own destination: a wandering zombie simply stays in its pen. */
  crossBarriers?: boolean;
}

const DEFAULT_ESCAPE_RADIUS = 16;
const DIAGONAL = 1.4142;

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Cell key. The offset keeps negative coordinates (which the escape search can
// probe on its way around a corner) packing and unpacking correctly.
const KEY_SPAN = 100000;
const KEY_OFFSET = 50000;

function key(c: number, r: number) {
  return (c + KEY_OFFSET) * KEY_SPAN + (r + KEY_OFFSET);
}

function unkey(k: number): Cell {
  return { col: Math.floor(k / KEY_SPAN) - KEY_OFFSET, row: (k % KEY_SPAN) - KEY_OFFSET };
}

// Walk `came` back from `endK` to `startK`, returning the cells after the start
// in travel order (the start itself is where the actor already stands).
function reconstruct(came: Map<number, number>, startK: number, endK: number): Cell[] {
  const path: Cell[] = [];
  let k = endK;
  while (k !== startK) {
    path.push(unkey(k));
    const prev = came.get(k);
    if (prev === undefined) break;
    k = prev;
  }
  path.reverse();
  return path;
}

/** The shortest run of tiles from a blocked `start` to the nearest walkable tile,
 *  passing only through blocked tiles on the way. Empty when `start` is already
 *  walkable, or when no open ground lies within the escape radius. */
export function findEscape(
  start: Cell,
  passable: Passable,
  opts: PathOptions = {}
): Cell[] {
  if (passable(start.col, start.row)) return [];
  const inBounds = opts.inBounds ?? (() => true);
  const radius = opts.escapeRadius ?? DEFAULT_ESCAPE_RADIUS;
  const startK = key(start.col, start.row);
  const came = new Map<number, number>();
  const seen = new Set<number>([startK]);
  let frontier: Cell[] = [start];

  // Breadth-first, so the first walkable tile reached is the closest way out —
  // and every tile before it is blocked, i.e. still inside the obstruction.
  while (frontier.length) {
    const next: Cell[] = [];
    for (const cell of frontier) {
      const ck = key(cell.col, cell.row);
      for (const [dc, dr] of NEIGHBORS) {
        const nc = cell.col + dc;
        const nr = cell.row + dr;
        if (Math.abs(nc - start.col) > radius || Math.abs(nr - start.row) > radius) continue;
        if (!inBounds(nc, nr)) continue;
        const nk = key(nc, nr);
        if (seen.has(nk)) continue;
        seen.add(nk);
        came.set(nk, ck);
        if (passable(nc, nr)) return reconstruct(came, startK, nk);
        next.push({ col: nc, row: nr });
      }
    }
    frontier = next;
  }
  return [];
}

// Binary min-heap of cell keys ordered by f, with lazy deletion (a cell can sit in
// it more than once; the stale copies are skipped when they surface).
//
// The open set used to be a Map scanned linearly for its minimum, which was fine
// while every step cost 1 and the frontier was a thin corridor of tiles. Weighted
// terrain widened it a lot: to decide that squeezing through a 10000-cost hedge
// really is the cheapest way out, the search first has to exhaust every tile on the
// near side of it, and that scan went quadratic.
class OpenSet {
  private ks: number[] = [];
  private fs: number[] = [];

  get size(): number {
    return this.ks.length;
  }

  push(k: number, f: number) {
    this.ks.push(k);
    this.fs.push(f);
    let i = this.ks.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p] <= this.fs[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.ks[0];
    const k = this.ks.pop()!;
    const f = this.fs.pop()!;
    if (this.ks.length) {
      this.ks[0] = k;
      this.fs[0] = f;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.fs.length && this.fs[l] < this.fs[m]) m = l;
        if (r < this.fs.length && this.fs[r] < this.fs[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const k = this.ks[a]; this.ks[a] = this.ks[b]; this.ks[b] = k;
    const f = this.fs[a]; this.fs[a] = this.fs[b]; this.fs[b] = f;
  }
}

/** One goal tile, or a set of them: the search stops at whichever it reaches first. */
type Goal = Cell | readonly Cell[];

const goalList = (goal: Goal): readonly Cell[] => (Array.isArray(goal) ? goal : [goal as Cell]);
const isGoal = (goals: readonly Cell[], c: number, r: number) =>
  goals.some((g) => g.col === c && g.row === r);

// Weighted A* from a walkable tile to the nearest of one or more walkable goal tiles.
function search(start: Cell, goalOrGoals: Goal, passable: Passable, opts: PathOptions): Cell[] {
  const goals = goalList(goalOrGoals);
  if (!goals.length || isGoal(goals, start.col, start.row)) return [];

  const cost = opts.cost ?? (() => 1);
  const portal = opts.portal;
  // A wormhole makes the goal one hop away from somewhere that looks a very long way
  // off, so a distance heuristic can overestimate badly and talk the search out of
  // the shortcut it is supposed to find. With portals in play the heuristic drops to
  // zero (plain Dijkstra) — correct at every farm size we ship.
  const scale = portal ? 0 : (opts.minTileCost ?? 1);
  // Octile rather than Chebyshev: a diagonal step really does cover 1.4142 of the
  // remaining distance, and saying so is both admissible and tighter, so the search
  // opens fewer cells. (It does NOT make the route look straight — see straighten.)
  // With several goals, the distance to the nearest one: a minimum of consistent
  // heuristics is itself consistent, so the settle-once rule below still holds.
  const h = (c: number, r: number) => {
    let best = Infinity;
    for (const goal of goals) {
      const dc = Math.abs(c - goal.col);
      const dr = Math.abs(r - goal.row);
      const lo = Math.min(dc, dr);
      best = Math.min(best, Math.max(dc, dr) - lo + DIAGONAL * lo);
    }
    return scale * best;
  };
  const goalKeys = new Set(goals.map((goal) => key(goal.col, goal.row)));

  const startK = key(start.col, start.row);
  const cells = new Map<number, Cell>([[startK, start]]);
  const came = new Map<number, number>();
  const g = new Map<number, number>([[startK, 0]]);
  const closed = new Set<number>();
  const open = new OpenSet();
  open.push(startK, h(start.col, start.row));

  // The heuristic is consistent (one step moves the Chebyshev distance by at most 1
  // and costs at least `scale`), so a cell is final the first time it is popped and
  // a closed cell never needs relaxing again.
  const relax = (fromK: number, fromG: number, nc: number, nr: number, step: number) => {
    const nk = key(nc, nr);
    if (closed.has(nk)) return;
    const tentative = fromG + step;
    if (tentative >= (g.get(nk) ?? Infinity)) return;
    g.set(nk, tentative);
    came.set(nk, fromK);
    cells.set(nk, { col: nc, row: nr });
    open.push(nk, tentative + h(nc, nr));
  };

  while (open.size) {
    const bestK = open.pop();
    if (closed.has(bestK)) continue; // a stale copy of an already-settled cell
    closed.add(bestK);
    const best = cells.get(bestK)!;
    if (goalKeys.has(bestK)) return reconstruct(came, startK, bestK);
    const bestG = g.get(bestK)!;

    for (const [dc, dr] of NEIGHBORS) {
      const nc = best.col + dc;
      const nr = best.row + dr;
      if (!passable(nc, nr)) continue;
      let tile = cost(nc, nr);
      if (!Number.isFinite(tile) || tile <= 0) continue;
      let move = 1;
      if (dc !== 0 && dr !== 0) {
        // disallow cutting diagonally past a solid orthogonal
        if (!passable(best.col + dc, best.row) || !passable(best.col, best.row + dr))
          continue;
        move = DIAGONAL;
        // Slipping between two corners is only as easy as the easier corner. In iso a
        // fence run is a DIAGONAL line of tiles, so charging a corner-cut nothing but
        // the destination's price let walkers thread straight through one for free.
        tile = Math.max(
          tile,
          Math.min(cost(best.col + dc, best.row), cost(best.col, best.row + dr))
        );
      }
      relax(bestK, bestG, nc, nr, move * tile);
    }

    // Wormhole: the far pad is a neighbour of this tile, priced as an ordinary step
    // onto it. Walking to the pad is what costs — the hop across is the reward.
    const exit = portal?.(best.col, best.row);
    if (exit && passable(exit.col, exit.row)) {
      const tile = cost(exit.col, exit.row);
      if (Number.isFinite(tile) && tile > 0) relax(bestK, bestG, exit.col, exit.row, tile);
    }
  }
  return [];
}

// ─── straightening ──────────────────────────────────────────────────────────────
//
// A* returns A shortest route, not the one that looks like a person walked it. Every
// interleaving of the same diagonals and sideways steps costs exactly the same, and
// the search settles on whichever the frontier reached first — usually the L: all the
// sideways steps, then all the diagonals. It is the right length and it looks absurd,
// and it is why walkers used to set off at the wrong angle before cutting the corner.
//
// So the route is pulled straight afterwards. A run is replaced by the straight line
// between its ends whenever every tile that line crosses costs no more than the
// CHEAPEST tile in the run it replaces: the straight line is the octile-shortest way
// between two tiles, so its price is at most that cheapest cost times the octile
// distance, and no route between the same two tiles can beat that. Never dearer,
// then — and never over terrain the original route was avoiding, which is what keeps
// a road-hugging route on its road instead of pulling it onto the grass.

// The straight raster line from `a` to `b`, excluding `a`. Exactly one king-move per
// cell, and exactly min(|dc|,|dr|) of them diagonal, i.e. the octile-shortest run.
function straightLine(a: Cell, b: Cell): Cell[] {
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  const steps = Math.max(Math.abs(dc), Math.abs(dr));
  const out: Cell[] = [];
  for (let i = 1; i <= steps; i++) {
    out.push({
      col: a.col + Math.round((dc * i) / steps),
      row: a.row + Math.round((dr * i) / steps),
    });
  }
  return out;
}

// Is the straight line from `a` to `b` provably no dearer than `run` — the stretch of
// route it would replace? `run` ends at `b`.
function straightNoWorse(
  a: Cell, b: Cell, run: Cell[], passable: Passable, cost: TileCost
): boolean {
  let cheapest = Infinity;
  for (const c of run) {
    const t = cost(c.col, c.row);
    // An escape walks THROUGH solid ground on its way out of an object. There is no
    // "no dearer" line across that, so those stretches are left exactly as found.
    if (!Number.isFinite(t)) return false;
    if (t < cheapest) cheapest = t;
  }
  let prev = a;
  for (const c of straightLine(a, b)) {
    if (!passable(c.col, c.row)) return false;
    let t = cost(c.col, c.row);
    if (prev.col !== c.col && prev.row !== c.row) {
      if (!passable(c.col, prev.row) || !passable(prev.col, c.row)) return false;
      // Same corner charge the search itself applies, so a straightened diagonal
      // cannot slip between two hedge tiles the searched route went around.
      t = Math.max(t, Math.min(cost(c.col, prev.row), cost(prev.col, c.row)));
    }
    if (t > cheapest) return false;
    prev = c;
  }
  return true;
}

/** Pull `route` (which leaves `start`) straight wherever that is provably free. */
function straighten(
  start: Cell, route: Cell[], passable: Passable, cost: TileCost
): Cell[] {
  if (route.length < 2) return route;
  const out: Cell[] = [];
  let anchor = start;
  let i = 0;
  while (i < route.length) {
    // A wormhole hop is not a walk and can never be pulled through: carry it over
    // untouched and start the next run from where it comes out.
    if (isWarpStep(anchor, route[i])) {
      out.push(route[i]);
      anchor = route[i];
      i++;
      continue;
    }
    let end = i;
    while (
      end + 1 < route.length &&
      !isWarpStep(route[end], route[end + 1]) &&
      straightNoWorse(anchor, route[end + 1], route.slice(i, end + 2), passable, cost)
    ) {
      end++;
    }
    out.push(...(end > i ? straightLine(anchor, route[end]) : [route[i]]));
    anchor = route[end];
    i = end + 1;
  }
  return out;
}

/** Does the route jump from `a` to `b` rather than walk? Only a wormhole edge is
 *  ever non-adjacent, so this is how the movement code spots one: it snaps the
 *  actor across in a single frame instead of sliding it over everything between. */
export function isWarpStep(a: Cell, b: Cell): boolean {
  return Math.abs(a.col - b.col) > 1 || Math.abs(a.row - b.row) > 1;
}

/** Route from `start` to `goal` as tile waypoints (excluding `start`). Empty when
 *  the goal is blocked or unreachable. `goal` may be several tiles: the route then
 *  ends at whichever is cheapest to reach, in ONE search — a caller trying each of a
 *  set in turn pays a whole failed search per tile when none is reachable.
 *
 *  Barriers (`opts.avoidCost`) are searched in TWO passes: once with them treated as
 *  solid, and only if that finds nothing — and only for a caller that set
 *  `crossBarriers` — again with them merely expensive. Pricing a fence dearly is
 *  enough to make a route go round one when going round is possible, but a walker
 *  shut inside a pen has no cheaper option and would calmly stroll out through the
 *  wall, which is exactly what a pen is built to stop. Leaving the second pass in
 *  reach is what still gets a walker out of somewhere it has been sealed into by
 *  accident, through the shut gate if there is one.
 *
 *  When `start` itself is blocked the route begins with an escape THROUGH the
 *  obstruction. If the goal still can't be reached from the far side, the escape
 *  alone is returned — getting the actor onto open ground beats leaving it stuck,
 *  and it can pick a fresh destination from there. */
export function findPath(
  start: Cell,
  goal: Goal,
  passable: Passable,
  opts: PathOptions = {}
): Cell[] {
  const goals = goalList(goal).filter((g) => passable(g.col, g.row));
  if (!goals.length) return [];
  if (isGoal(goals, start.col, start.row)) return [];
  const cost = opts.cost ?? (() => 1);

  if (!passable(start.col, start.row)) {
    const escape = findEscape(start, passable, opts);
    if (!escape.length) return [];
    const exit = escape[escape.length - 1];
    if (isGoal(goals, exit.col, exit.row)) return escape;
    const rest = search(exit, goals, passable, opts);
    if (!rest.length) return escape;
    return [...escape, ...straighten(exit, rest, passable, cost)];
  }

  const avoid = opts.avoidCost;
  // Standing ON a barrier is not crossing one, it is leaving one — an actor that a
  // hedge was dropped on top of always gets to step off, whoever it is.
  if (avoid !== undefined && cost(start.col, start.row) < avoid) {
    const solid: Passable = (c, r) => passable(c, r) && cost(c, r) < avoid;
    const open = goals.filter((g) => solid(g.col, g.row));
    if (open.length) {
      const route = search(start, open, solid, opts);
      if (route.length) return straighten(start, route, solid, cost);
    }
    if (!opts.crossBarriers) return [];
  }

  return straighten(start, search(start, goals, passable, opts), passable, cost);
}
