// What a brand-new farm starts with, shared by the client and the Worker so the two
// can never disagree about it: four plowed plots in a 2x2 block at the centre of the
// farm, and two Insta-Grows for Tim to spend on the tutorial's first crops.
//
// The Worker seeds these into a new account's state (v3/engine.freshGameplayState) and
// the offline build seeds the same plots locally (main.ts), so both start identically.
// Nothing here is a balance rule for an existing farm — it is only ever applied to an
// account/save that has no farm yet.

/** Tiles per plot side. Mirrors Field's PLOT; kept here so the Worker needs no Pixi. */
const PLOT_TILES = 4;
/** Farm side length of a new farm (a 30x30 grid). */
const FRESH_FARM_SIZE = 30;
/** Where the 2x2 block begins, so it sits dead centre: (30 - 2 * 4) / 2. */
const BLOCK_START = (FRESH_FARM_SIZE - 2 * PLOT_TILES) / 2;

export interface TutorialPlot { readonly oc: number; readonly or: number }

/** The four starting plots. Every pair of them touches (edge or corner), which is what
 *  lets a carrot in one of them mutate a zombie growing in any other. */
export const TUTORIAL_PLOTS: readonly TutorialPlot[] = [
  { oc: BLOCK_START, or: BLOCK_START },
  { oc: BLOCK_START + PLOT_TILES, or: BLOCK_START },
  { oc: BLOCK_START, or: BLOCK_START + PLOT_TILES },
  { oc: BLOCK_START + PLOT_TILES, or: BLOCK_START + PLOT_TILES },
];

/** The plot the tutorial grows its first zombie in, and the one beside it for the carrot. */
export const TUTORIAL_ZOMBIE_PLOT: TutorialPlot = TUTORIAL_PLOTS[2];
export const TUTORIAL_CARROT_PLOT: TutorialPlot = TUTORIAL_PLOTS[3];

/** The Insta-Grow boost key, and how many a new account starts with (zombie + carrot). */
export const TUTORIAL_GROW_BOOST = "insta_grow";
export const TUTORIAL_GROW_USES = 2;

const plotId = (oc: number, or: number) => `${oc}:${or}`;
const SEED_IDS = new Set(TUTORIAL_PLOTS.map((p) => plotId(p.oc, p.or)));

/** Is this a farm nobody has played yet? A new account now arrives with the four
 *  starting plots already plowed, so "has any plot" no longer means "has been played":
 *  a farm is untouched while it holds nothing but those plots, bare, and no objects or
 *  zombies. `plots` is the Worker's projection (keyed "oc:or"). */
export function isUntouchedFreshFarm(
  plots: Readonly<Record<string, { state: string }>>,
  objectCount: number,
  rosterCount: number
): boolean {
  if (objectCount > 0 || rosterCount > 0) return false;
  return Object.entries(plots).every(([id, plot]) => SEED_IDS.has(id) && plot.state === "plowed");
}
