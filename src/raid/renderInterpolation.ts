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
