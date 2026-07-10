// Developer toggle: Fast Mode.
//
// Fast Mode compresses every real-world WAIT clock down to seconds so the game
// can be playtested without waiting hours/days:
//   - crop & zombie grow times      (scaled to 8-45s, see main.ts scaleGrow)
//   - the placeable object regrow    (same scaleGrow)
//   - the zombie-pot combine timer   (scaleGrow of POT_DURATION_MS)
//   - the between-invasions cooldown  (60s instead of 2h)
// It intentionally does NOT touch real-time animation/movement/combat speeds —
// walking, hoeing and battles run at their normal rate either way. This mirrors
// exactly the behaviour we've been using for testing.
//
// Default is ON. Turning it OFF uses the real hour/day timescales.
//
// The value is read once at startup (durations are baked into the catalog and
// cooldowns at load), so changing it requires a page reload to take effect.

const KEY = "zf2r.fastMode";
const LEGACY_KEY = "zf2r.realGrow"; // old hidden flag: "1" meant real time.

export function isFastMode(): boolean {
  const v = localStorage.getItem(KEY);
  if (v !== null) return v !== "0";
  // Back-compat: honour the old hidden flag if the new one was never set.
  return localStorage.getItem(LEGACY_KEY) !== "1";
}

export function setFastMode(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
  // Keep the legacy key in sync so any stray reader stays consistent.
  localStorage.setItem(LEGACY_KEY, on ? "0" : "1");
}
