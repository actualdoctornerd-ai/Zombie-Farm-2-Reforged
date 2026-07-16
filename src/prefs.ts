// Player-facing preferences persisted in local storage.
// These are persisted to localStorage and read at the points that care about them.
//
// Two toggles live here today, both surfaced in Settings:
//
//   • Sprite set — "zf1" (original Zombie Farm art) vs "zf2" (the sequel's art
//     this reimplementation is built from). This is a PLACEHOLDER: the value is
//     persisted and exposed, but nothing swaps art on it yet. Wiring the ZF1 art
//     pack in is future work (see README "Current Gaps").
//
//   • Edition — "traditional" vs "reforged". "reforged" is the full modern build
//     (online account, brain gifting, and any other additions layered on top of
//     the original single-player game); "traditional" is intended to give the OG
//     experience by hiding those additions. Like the sprite toggle, the choice is
//     persisted and exposed but NOT yet enforced anywhere — the feature gates it
//     will drive are future work. isReforged() is the seam those gates read.

export type SpriteSet = "zf1" | "zf2";
export type Edition = "traditional" | "reforged";
// How lush the decorative foliage ringing the farm is. All three fill the whole
// camera view out to the max zoom-out edge; they differ only in tree density.
export type FarmBackground = "deep-forest" | "woodland" | "light-meadow";
export const DEFAULT_FARM_BACKGROUND: FarmBackground = "woodland";

export function isFarmBackground(value: unknown): value is FarmBackground {
  return value === "deep-forest" || value === "woodland" || value === "light-meadow";
}

const SPRITE_KEY = "zf2r.spriteSet";
const EDITION_KEY = "zf2r.edition";
const FARM_BG_KEY = "zf2r.farmBackground";

/** Which sprite pack to render with. Defaults to ZF2 (the only pack wired today). */
export function getSpriteSet(): SpriteSet {
  return localStorage.getItem(SPRITE_KEY) === "zf1" ? "zf1" : "zf2";
}

export function setSpriteSet(set: SpriteSet): void {
  localStorage.setItem(SPRITE_KEY, set);
}

/** Which edition the player wants. Defaults to Reforged (all features on). */
export function getEdition(): Edition {
  return localStorage.getItem(EDITION_KEY) === "traditional" ? "traditional" : "reforged";
}

export function setEdition(edition: Edition): void {
  localStorage.setItem(EDITION_KEY, edition);
}

// Foliage density per background, as a fraction of the base (Deep Forest) tree
// count. Light Meadow is ~1/10 as dense. Because the three share the same seeded
// layout, the sets nest (meadow ⊂ woodland ⊂ deep forest) — switching thins or
// thickens the same forest rather than reshuffling it.
export const FARM_BG_DENSITY: Record<FarmBackground, number> = {
  "deep-forest": 1,
  woodland: 0.45,
  "light-meadow": 0.1,
};

// Ordered options + display labels for the Settings picker.
export const FARM_BACKGROUNDS: { id: FarmBackground; label: string }[] = [
  { id: "deep-forest", label: "Deep Forest" },
  { id: "woodland", label: "Woodland" },
  { id: "light-meadow", label: "Light Meadow" },
];

/** How lush the farm's foliage ring is. Defaults to Woodland (the medium density). */
export function getFarmBackground(): FarmBackground {
  const v = localStorage.getItem(FARM_BG_KEY);
  return isFarmBackground(v) ? v : DEFAULT_FARM_BACKGROUND;
}

export function setFarmBackground(bg: FarmBackground): void {
  localStorage.setItem(FARM_BG_KEY, bg);
}

/** Convenience gate for the modern additions (brain gifting, online, …). The
 *  feature checks that consume this are not wired yet — see the module note. */
export function isReforged(): boolean {
  return getEdition() === "reforged";
}
