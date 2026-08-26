/** Render a fixed-step value between its previous and current simulation samples. */
export function interpolateFixedStep(
  previous: number,
  current: number,
  accumulatorMs: number,
  tickMs: number
): number {
  const alpha = Math.max(0, Math.min(1, accumulatorMs / Math.max(1, tickMs)));
  return previous + (current - previous) * alpha;
}

/** Interpolate a unit position, snapping genuine teleports/state jumps. */
export function interpolatePosition(
  previous: { x: number; y: number },
  current: { x: number; y: number },
  accumulatorMs: number,
  tickMs: number,
  teleportPx: number
): { x: number; y: number } {
  if (Math.hypot(current.x - previous.x, current.y - previous.y) > teleportPx) return { ...current };
  return {
    x: interpolateFixedStep(previous.x, current.x, accumulatorMs, tickMs),
    y: interpolateFixedStep(previous.y, current.y, accumulatorMs, tickMs),
  };
}

/**
 * Keep the presentation-only left staging offset when a zombie is released, then
 * ease it out as the simulator advances from the focus slot. This preserves the
 * original-game staging position without snapping to the simulator's older slot.
 */
export function playerStagingOffset(
  state: string,
  x: number,
  chargeX: number,
  offset: number
): number {
  if (state === "waiting" || state === "charging") return offset;
  if (state !== "advance") return 0;
  return Math.max(0, offset - Math.max(0, x - chargeX));
}

/**
 * The ordinary raid boss changes from its elevated exit route to its ground-level
 * re-entry route in one simulation step. Keep that transition offstage for the
 * remainder of the render interval so a wide boss cannot flash at ground level
 * before its walk back in begins.
 */
export function isOffstageBossReentryFrame(
  state: string,
  previousY: number,
  currentY: number,
  structureY: number
): boolean {
  return state === "emerging" && previousY === structureY && currentY !== structureY;
}

/** Where a SHOVED zombie is drawn, given where the simulation has slid it to.
 *
 *  The simulation's knockback is a linear slide at the source's `force * 60` px/s. That
 *  is ground truth and the server re-runs it, so neither its speed nor its duration is
 *  ours to change: how long a zombie is out of melee is a rule, not a look.
 *
 *  What IS ours is the curve. A constant-velocity slide reads as travel — the zombie
 *  looks like it decided to back off — where a shove is violent at the moment of impact
 *  and settles. So the drawn position runs an ease-out over the very same interval:
 *  same start, same end, same instant of arrival, but twice the speed off the mark and
 *  slowing into the landing. Both curves agree exactly at t=0 and t=1, so the handover
 *  in and out of the slide has nothing to snap.
 *
 *  Presentation only. The simulation's `x` is untouched and no combat distance moves. */
export function knockBackDrawX(simX: number, fromX: number, toX: number): number {
  const span = toX - fromX;
  if (!span) return simX;
  const t = Math.max(0, Math.min(1, (simX - fromX) / span));
  return fromX + span * (1 - (1 - t) * (1 - t));
}

/** Advance a visual-only countdown through the unsimulated fraction of a tick. */
export function visualCountdown(valueMs: number, accumulatorMs: number, tickMs: number): number {
  return Math.max(0, valueMs - Math.max(0, Math.min(tickMs, accumulatorMs)));
}

/** Extrapolate a projectile over the unsimulated fraction of a tick. */
export function extrapolatePosition(
  x: number,
  y: number,
  vx: number,
  vy: number,
  accumulatorMs: number,
  tickMs: number
): { x: number; y: number } {
  const dt = Math.max(0, Math.min(tickMs, accumulatorMs)) / 1000;
  return { x: x + vx * dt, y: y + vy * dt };
}
