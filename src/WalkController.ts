// Drives the farmer: walks to the exact world point clicked (not a tile center),
// updates facing/animation, keeps depth (zIndex) in sync, and fires an optional
// callback on arrival (used to till/plant/harvest the destination).
//
// Movement is a straight line by default. If that straight line would cross a
// placed object, the farmer instead routes around it via A* over the occupancy
// grid (tile-center waypoints), then does a final straight approach to the exact
// point. Routing is skipped when the destination tile itself is blocked (e.g. the
// base of a tree he's harvesting) so those interactions still reach their target.
import { Actor } from "./Actor";
import { Field } from "./Field";
import { screenToGrid, tileCenter } from "./iso";
import { setFootprint } from "./depthSort";
import { findPath } from "./pathfind";

const SPEED_PX = 174; // world px/sec (1.2x the previous 145, user tuning)

export class WalkController {
  private wx = 0;
  private wy = 0;
  private target: { x: number; y: number } | null = null;
  private queue: { x: number; y: number }[] = []; // remaining waypoints after target
  private onArrive: (() => void) | null = null;

  constructor(
    private actor: Actor,
    private field: Field,
    startCol: number,
    startRow: number
  ) {
    const c = tileCenter(startCol, startRow);
    this.wx = c.x;
    this.wy = c.y;
    this.syncActor();
  }

  // Does the straight segment (x0,y0)->(x1,y1) cross a non-passable tile?
  private lineBlocked(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / 12)); // ~half-tile sampling
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const g = screenToGrid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (!this.field.isPassable(Math.round(g.col), Math.round(g.row))) return true;
    }
    return false;
  }

  // Walk to an exact world-space point. Optional onArrive runs on arrival. Ignored
  // if the point is off-field. Routes around objects when the direct path is blocked.
  goToPoint(x: number, y: number, onArrive?: () => void) {
    const g = screenToGrid(x, y);
    const goalC = Math.round(g.col);
    const goalR = Math.round(g.row);
    if (!this.field.inBounds(goalC, goalR)) return;
    this.onArrive = onArrive ?? null;
    this.queue = [];

    // Route around obstacles only if the straight line is blocked AND the goal
    // tile is itself walkable (else A* can't reach it — fall back to direct).
    if (this.lineBlocked(this.wx, this.wy, x, y) && this.field.isPassable(goalC, goalR)) {
      const sg = screenToGrid(this.wx, this.wy);
      const cells = findPath(
        { col: Math.round(sg.col), row: Math.round(sg.row) },
        { col: goalC, row: goalR },
        (c, r) => this.field.isPassable(c, r)
      );
      if (cells.length) {
        // Waypoints = intermediate tile centers, then the exact destination point.
        const pts = cells.slice(0, -1).map((c) => tileCenter(c.col, c.row));
        pts.push({ x, y });
        this.target = pts.shift()!;
        this.queue = pts;
        this.actor.setMoving(true);
        return;
      }
    }
    this.target = { x, y };
    this.actor.setMoving(true);
  }

  get tile(): { col: number; row: number } {
    const g = screenToGrid(this.wx, this.wy);
    return { col: Math.round(g.col), row: Math.round(g.row) };
  }

  /** True while the farmer has a destination (including queued path waypoints).
   *  JobSystem uses this to stop elapsed-time catch-up as soon as all useful
   *  movement and work has completed. */
  get moving(): boolean {
    return this.target !== null;
  }

  teleport(col: number, row: number) {
    const c = tileCenter(col, row);
    this.wx = c.x;
    this.wy = c.y;
    this.target = null;
    this.queue = [];
    this.onArrive = null;
    this.actor.setMoving(false);
    this.syncActor();
  }

  stop() {
    this.target = null;
    this.queue = [];
    this.onArrive = null;
    this.actor.setMoving(false);
  }

  update(dt: number) {
    if (this.target) {
      const dx = this.target.x - this.wx;
      const dy = this.target.y - this.wy;
      const dist = Math.hypot(dx, dy);
      const step = SPEED_PX * dt;
      if (dist <= step || dist === 0) {
        this.wx = this.target.x;
        this.wy = this.target.y;
        if (this.queue.length) {
          this.target = this.queue.shift()!; // advance to the next waypoint
        } else {
          this.target = null;
          this.actor.setMoving(false);
          const cb = this.onArrive;
          this.onArrive = null;
          if (cb) cb();
        }
      } else {
        this.wx += (dx / dist) * step;
        this.wy += (dy / dist) * step;
        this.actor.setFacingFromDelta(dx);
      }
    }
    this.actor.update(dt);
    this.syncActor();
  }

  private syncActor() {
    this.actor.container.position.set(this.wx, this.wy);
    const g = screenToGrid(this.wx, this.wy);
    const c = Math.round(g.col);
    const r = Math.round(g.row);
    // Point footprint on the farmer's foot tile; bias 0.6 > zombie 0.5 so the
    // farmer draws in front of a zombie sharing his tile.
    setFootprint(this.actor.container, c, r, c, r, 0.6);
  }
}
