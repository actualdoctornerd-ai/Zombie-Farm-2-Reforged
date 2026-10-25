// Which decor is on sale right now.
//
// Every placeable carries at most one `theme` label (authored in
// tools/prep_placeables.py — the source data has none). A row with no label is
// `evergreen` and always sold. A labelled row is sold only while its label is on
// ACTIVE_THEMES.
//
// The allow-list is deliberately a plain array rather than a date computation.
// Whatever eventually drives it — fixed calendar windows, a server-pushed list, an
// enableDate-style field — it drives THIS array, and every call site is already
// correct. Editing it is the whole gating action.
//
// Client and server both import this, so the market and the buy command agree.
// See docs/DECOR_RESTORATION_PLAN.md (D2).

export const EVERGREEN = "evergreen";

/** Every theme label in the catalog, for validation and for the market's badge. */
export const DECOR_THEMES = [
  "christmas", "winter", "newYear", "lunarNewYear", "valentines", "easter",
  "stPatricks", "halloween", "harvest", "independence", "anniversary", "summer",
  "pirate",
] as const;

export type DecorTheme = (typeof DECOR_THEMES)[number] | typeof EVERGREEN;

/** Human-readable label for the market card badge. */
const THEME_LABELS: Record<string, string> = {
  christmas: "Christmas",
  winter: "Winter",
  newYear: "New Year",
  lunarNewYear: "Lunar New Year",
  valentines: "Valentine's",
  easter: "Easter",
  stPatricks: "St. Patrick's",
  halloween: "Halloween",
  harvest: "Harvest",
  independence: "Independence Day",
  anniversary: "Anniversary",
  summer: "Summer",
  pirate: "Pirate",
};

/**
 * Themes currently on sale. EDITING THIS ARRAY IS THE GATING ACTION — add
 * "christmas" and every Christmas decor returns to the market, on both the client
 * and the server, with no other change.
 *
 * Gating applies to BUYING only. An owned seasonal decor still places, stores and
 * re-places whatever the season, so nobody loses a farm they built.
 */
export const ACTIVE_THEMES: readonly string[] = [EVERGREEN, "halloween"];

/** This row's label, defaulting to evergreen when the field is absent. */
export function themeOf(def: { theme?: string } | undefined | null): string {
  return def?.theme || EVERGREEN;
}

/** Is this theme currently buyable? */
export function themeAvailable(theme: string): boolean {
  return ACTIVE_THEMES.includes(theme || EVERGREEN);
}

/** Can this catalog row be bought right now? */
export function decorAvailable(def: { theme?: string } | undefined | null): boolean {
  return themeAvailable(themeOf(def));
}

/** Badge text for a themed market card ("" for evergreen). */
export function themeLabel(theme: string): string {
  return theme && theme !== EVERGREEN ? THEME_LABELS[theme] ?? theme : "";
}
