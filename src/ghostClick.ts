// Touch "ghost clicks". A finger tap on the farm canvas resolves on pointerup, and
// many taps open a DOM panel right then (Mausoleum, Zombie Pot, Storage, …). The
// browser's compatibility mouse events — mousedown/mouseup/click — arrive AFTER
// pointerup and are hit-tested at dispatch time, so they land on whatever the new
// panel put under the finger: a Mausoleum slot, a Pot tile, a dropdown. One tap,
// two actions.
//
// The guard remembers where and when the last canvas touch ended and swallows the
// compatibility mouse events that follow it on anything that is not the canvas.
// It matches on position as well as time so a real second tap is never eaten.

export interface TouchRelease {
  x: number;
  y: number;
  t: number;
}

/** How long after a canvas touch release its compatibility events can still arrive. */
export const GHOST_WINDOW_MS = 700;
/** How far from the release point they may land (finger wobble, sub-pixel rounding). */
export const GHOST_RADIUS_PX = 30;

/** Is a mouse event at (x, y) at time t the trailing echo of `last`? */
export function isGhostClick(last: TouchRelease | null, x: number, y: number, t: number): boolean {
  if (!last) return false;
  const dt = t - last.t;
  if (dt < 0 || dt > GHOST_WINDOW_MS) return false;
  return Math.hypot(x - last.x, y - last.y) <= GHOST_RADIUS_PX;
}

/** Install the guard for taps that end on `canvas`. Capture phase on window, so it
 *  runs before any panel's own handler. */
export function installGhostClickGuard(canvas: HTMLCanvasElement) {
  let last: TouchRelease | null = null;
  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") return;
    // Touch pointers are implicitly captured, so a tap that began on the farm
    // reports the canvas as its target even if a panel is now on top.
    last = e.target === canvas ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  }, true);
  window.addEventListener("pointerdown", (e) => {
    // A new contact anywhere ends the echo window: its own events are real.
    if (e.pointerType !== "mouse") last = null;
  }, true);
  const swallow = (e: MouseEvent) => {
    if (e.target === canvas) return;
    if (!isGhostClick(last, e.clientX, e.clientY, performance.now())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click") last = null;
  };
  for (const type of ["mousedown", "mouseup", "click"] as const)
    window.addEventListener(type, swallow, true);
}
