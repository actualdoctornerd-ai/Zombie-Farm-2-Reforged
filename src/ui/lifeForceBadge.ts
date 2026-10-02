import { UI } from "./uiAsset";

/** A small leaf-and-number badge: the Life Force one placed copy of an object adds to the
 *  farm. Shown on Market cards, Storage slots and the object sheet, wherever decor is. */
export function lifeForceBadge(value: number): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "lf-mini";
  badge.title = value > 0
    ? `Adds ${value} Life Force while placed on your farm`
    : "Adds no Life Force";
  const leaf = document.createElement("img");
  leaf.src = UI("lifeForce.png");
  leaf.alt = "";
  badge.append(leaf, String(value));
  return badge;
}

/** The text a screen reader / test sees for a badge. */
export function lifeForceBadgeText(value: number): string {
  return `Life Force ${value}`;
}
