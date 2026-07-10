// 8-neighbour A* on the tile grid. Nothing blocks yet (this milestone), but the
// controller routes through this so obstacles/fences drop in later for free.
export interface Cell {
  col: number;
  row: number;
}

type Passable = (col: number, row: number) => boolean;

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function key(c: number, r: number) {
  return c * 100000 + r;
}

export function findPath(
  start: Cell,
  goal: Cell,
  passable: Passable
): Cell[] {
  if (!passable(goal.col, goal.row)) return [];
  if (start.col === goal.col && start.row === goal.row) return [];

  const open = new Map<number, Cell>();
  const came = new Map<number, number>();
  const g = new Map<number, number>();
  const startK = key(start.col, start.row);
  open.set(startK, start);
  g.set(startK, 0);

  const h = (c: number, r: number) =>
    Math.max(Math.abs(c - goal.col), Math.abs(r - goal.row));

  while (open.size) {
    // pick lowest f = g + h
    let bestK = -1;
    let bestF = Infinity;
    let best: Cell | null = null;
    for (const [k, cell] of open) {
      const f = (g.get(k) ?? Infinity) + h(cell.col, cell.row);
      if (f < bestF) {
        bestF = f;
        bestK = k;
        best = cell;
      }
    }
    if (!best) break;

    if (best.col === goal.col && best.row === goal.row) {
      // reconstruct
      const path: Cell[] = [];
      let ck = bestK;
      let cur: Cell | undefined = best;
      while (cur && ck !== startK) {
        path.push(cur);
        const pk = came.get(ck);
        if (pk === undefined) break;
        cur = { col: Math.floor(pk / 100000), row: pk % 100000 };
        ck = pk;
      }
      path.reverse();
      return path;
    }

    open.delete(bestK);
    for (const [dc, dr] of NEIGHBORS) {
      const nc = best.col + dc;
      const nr = best.row + dr;
      if (!passable(nc, nr)) continue;
      // disallow cutting diagonally between two blocked orthogonals
      if (dc !== 0 && dr !== 0) {
        if (!passable(best.col + dc, best.row) || !passable(best.col, best.row + dr))
          continue;
      }
      const nk = key(nc, nr);
      const step = dc !== 0 && dr !== 0 ? 1.4142 : 1;
      const tentative = (g.get(bestK) ?? Infinity) + step;
      if (tentative < (g.get(nk) ?? Infinity)) {
        came.set(nk, bestK);
        g.set(nk, tentative);
        if (!open.has(nk)) open.set(nk, { col: nc, row: nr });
      }
    }
  }
  return [];
}
