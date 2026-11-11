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
// Halloween ended 2026-11-10 (owner): its decor, Candy Corn and its invasion all went off sale
// with this one line. Put "halloween" back to bring the whole event back.
export const ACTIVE_THEMES: readonly string[] = [EVERGREEN];

/** Invasions that belong to a holiday, by raid id: playable only while their theme is on
 *  ACTIVE_THEMES, on both the client and the server, and left off the invasion list
 *  otherwise. Empty since 2026-11-11 (owner): the Halloween invasion (raid 16, Count von
 *  Uberbiss) stays year-round, with its rewards cut (halloweenNights.HALLOWEEN_REWARD_SCALE),
 *  while its decor and Candy Corn stay off sale. Put `16: "halloween"` back to season it. */
export const SEASONAL_INVASION_THEMES: Readonly<Record<number, string>> = {};

/** Is this invasion in season? Every invasion not tied to a holiday always is. */
export function invasionInSeason(raidId: number): boolean {
  const theme = SEASONAL_INVASION_THEMES[raidId];
  return !theme || themeAvailable(theme);
}

/** Quests that can only be done on a holiday invasion, by quest id: off the quest rail (and
 *  frozen, progress kept) while that invasion is out of season, on the client and the server.
 *  48 Down for the Count, 49 Six Feet Under (its coffins), 50 Uber Loser: all raid 16. */
export const SEASONAL_QUEST_INVASIONS: Readonly<Record<string, number>> = { 48: 16, 49: 16, 50: 16 };

/** Is this quest in season? Every quest not tied to a holiday invasion always is. */
export function questInSeason(questId: string): boolean {
  const raidId = SEASONAL_QUEST_INVASIONS[questId];
  return raidId === undefined || invasionInSeason(raidId);
}

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
