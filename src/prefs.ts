// Player-facing preferences (as opposed to the developer flags in devSettings.ts).
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

const SPRITE_KEY = "zf2r.spriteSet";
const EDITION_KEY = "zf2r.edition";

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

/** Convenience gate for the modern additions (brain gifting, online, …). The
 *  feature checks that consume this are not wired yet — see the module note. */
export function isReforged(): boolean {
  return getEdition() === "reforged";
}
