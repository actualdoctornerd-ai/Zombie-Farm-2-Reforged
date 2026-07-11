// Runtime device autodetection for the single responsive build.
//
// We do NOT sniff the user-agent string (fragile, spoofable, and wrong for
// hybrids like touch laptops). Instead we ask the browser what it can actually
// do: `(pointer: coarse)` is true for finger/stylus input, and a narrow
// viewport tells us to use the compact HUD. Either signal flips us to "mobile".
//
// The result is published as `data-platform="mobile" | "desktop"` on <html>, so
// CSS can key layout off it (see the responsive block in hud.ts) and game logic
// can read it via isMobile(). The class is re-evaluated on resize / orientation
// change, so rotating a phone or resizing a desktop window updates live.

// A viewport this narrow (CSS px) uses the compact HUD even on a mouse device
// (e.g. a small desktop window), matching the CSS media-query breakpoint.
const COMPACT_MAX_WIDTH = 760;

const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** True when the device has a touch/stylus primary pointer. Harmless to enable
 *  touch gestures (pinch-zoom) whenever this is true. */
export function isTouch(): boolean {
  return coarsePointer() || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
}

/** True when we should present the compact, touch-friendly layout. A width of 0
 *  (a not-yet-measured viewport) is treated as unknown, not mobile, so a transient
 *  during boot can't wrongly collapse the desktop HUD. */
export function isMobile(): boolean {
  const w = window.innerWidth;
  return coarsePointer() || (w > 0 && w <= COMPACT_MAX_WIDTH);
}

/** Write the current platform to <html data-platform> and keep it in sync with
 *  viewport/orientation changes. Call once at startup. Returns the initial mode. */
export function initPlatform(): "mobile" | "desktop" {
  const apply = () => {
    const mode = isMobile() ? "mobile" : "desktop";
    if (document.documentElement.dataset.platform !== mode) {
      document.documentElement.dataset.platform = mode;
    }
    return mode;
  };
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  return apply();
}
