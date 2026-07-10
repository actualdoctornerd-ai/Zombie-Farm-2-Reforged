// Zombie taxonomy (Phase 3). Every zombie belongs to a GROUP family (Regular,
// Female, Small, Large, Headless, Garden) and a colour CLASS derived from its
// tier: Green (T1) -> Blue (T2) -> Red (T3) -> Silver/Combined (T4) -> Special
// (T5); named uniques with no tier (Crazy, Cupid) are Yellow. This mirrors the
// Python classifier in tools/prep_market.py — the baked group/className/classColor
// in zombies.json are authoritative; this is the runtime fallback + colour source.

export type ZClass = "Green" | "Blue" | "Red" | "Silver" | "Special" | "Yellow";

const GROUP_FAMILY: Record<string, string> = {
  Regular: "Regular", Girl: "Female", Small: "Small",
  Large: "Large", Headless: "Headless", Garden: "Garden",
};
const TIER_CLASS: Record<string, ZClass> = {
  "1": "Green", "2": "Blue", "3": "Red", "4": "Silver", "5": "Special",
};

// Display + tint colour per class (hex string for CSS, number for Pixi tint).
export const CLASS_COLOR: Record<ZClass, string> = {
  Green: "#7bd84a", Blue: "#5aa8ff", Red: "#ff5a4a",
  Silver: "#cfd4dd", Special: "#c077ff", Yellow: "#ffd24a",
};

export function classColorHex(cls: ZClass): number {
  return parseInt(CLASS_COLOR[cls].slice(1), 16);
}

// Numeric rank of a colour class, used to gate which ability tiers a zombie
// shows: it sees ability tiers 1..rank. Green=1 (t1 only), Blue=2, Red=3,
// Silver=4 (all four); Special (T5 mutants) and Yellow (tier-less uniques) also
// see all four, so they clamp to the top. Unknown strings fall back to 1.
const CLASS_RANK: Record<string, number> = {
  Green: 1, Blue: 2, Red: 3, Silver: 4, Special: 4, Yellow: 4,
};
export function classTierRank(className: string): number {
  return CLASS_RANK[className] ?? 1;
}

export interface Taxon {
  group: string;
  className: ZClass;
  classColor: string;
}

// Classify a ZombieActor* key -> group family + colour class.
export function classify(key: string): Taxon {
  const body = key.replace(/^ZombieActor/, "");
  let group = "Regular";
  for (const fam of Object.keys(GROUP_FAMILY).sort((a, b) => b.length - a.length)) {
    if (body.startsWith(fam)) { group = GROUP_FAMILY[fam]; break; }
  }
  const m = /Tier(\d)/.exec(body);
  const className: ZClass = (m && TIER_CLASS[m[1]]) || "Yellow";
  return { group, className, classColor: CLASS_COLOR[className] };
}
