// Mouse-wheel zoom, sized by how far the wheel turned rather than by how many events
// the browser split the turn into. A classic notched wheel reports one event of about
// 100 px per notch. A free-spinning or high-resolution wheel (Logitech's hyper-fast
// scroll, Windows smooth scrolling, a trackpad) reports the same notch as a burst of
// small events, and a fixed step per event zoomed that burst straight to the limit.

/** Zoom factor of one notch of a classic wheel. */
export const ZOOM_PER_NOTCH = 1.12;
/** Wheel travel of one classic notch, in px (Chrome and Edge report 100 per notch). */
const NOTCH_PX = 100;
/** Firefox reports lines (deltaMode 1), three per notch. */
const PX_PER_LINE = NOTCH_PX / 3;
/** The page mode (deltaMode 2) is a keyboard-style page: a handful of notches. */
const PX_PER_PAGE = NOTCH_PX * 5;
/** The most one event may zoom, in notches. A free spin at full speed reports large
 *  deltas per event; past this the next event carries on, so speed shows as a smooth
 *  run rather than a jump. */
const MAX_NOTCHES_PER_EVENT = 3;

/** The factor to scale the camera by for one wheel event. Wheel up (a negative
 *  deltaY) zooms in; a notch split across many events multiplies to the same factor
 *  as a notch delivered in one. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * PX_PER_LINE
    : deltaMode === 2 ? deltaY * PX_PER_PAGE
    : deltaY;
  const notches = Math.max(-MAX_NOTCHES_PER_EVENT, Math.min(MAX_NOTCHES_PER_EVENT, px / NOTCH_PX));
  return Math.pow(ZOOM_PER_NOTCH, -notches);
}
