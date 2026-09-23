// The faces in the Lawyer boss's thought bubbles (raid 12).
//
// The objection asks the player to give up one of two CLASSES, and it used to ask in words
// — "Headless" against "Garden". Words are the wrong currency for a decision made in eight
// seconds while a wave is closing: the player does not think of their army as six nouns,
// they think of it as the faces standing in the line. So each bubble now shows the class
// itself — the head of that group's GREEN zombie, the one everybody starts with and can
// recognise instantly.
//
// HEADLESS SHOWS ITS BODY, because it has no head. That is not a special case bolted on; it
// falls out of the rig (`ZombieActorHeadlessTier1` simply has no parts in the `head` group),
// and it is also the right icon — a decapitated torso is exactly how the class reads on the
// field.
//
// The six read apart on three cues at once, which is what makes them legible at 26 pixels:
//
//   | class    | what you see                    | model scale |
//   |----------|---------------------------------|-------------|
//   | Headless | a body, no head                 | 0.765       |
//   | Garden   | a gnome hat (`gnomeFeature`)    | 0.70        |
//   | Small    | heavy brows (`eyeBrowFeature`)  | 0.60        |
//   | Large    | brute brow + jaw, black eyes    | 1.15        |
//   | Regular  | the plain default head          | 0.90        |
//   | Female   | hair (`femaleFeature`)          | 0.80        |
//
// The RELATIVE SIZES are kept (see `iconScaleFor`) rather than fitting every icon to the
// same box, because size is the cue that separates the two pairs a feature alone leaves
// close: Regular's plain head against Small's, and Large's against everyone's. A Small that
// rendered as big as a Large would be a worse icon than the word "Small".
import { Container, Sprite } from "pixi.js";
import type { GameAssets } from "../assets";
import {
  BRUTE_EYEBALL_SCALE, DEFAULT_ZOMBIE_EYE_TINT, isBruteEyeball, zombiePartTint,
} from "../zombie/appearance";
import { classify } from "../zombie/taxonomy";

/** The GREEN zombie of each class — the starter everybody owns, and so the one face a
 *  player reads without having to learn it. Keyed by the same group names the objection
 *  names (dualInvasion.SIGN_GROUPS). */
export const SIGN_ICON_KEY: Readonly<Record<string, string>> = {
  Headless: "ZombieActorHeadlessTier1",
  Garden: "ZombieActorGardenTier1",
  Small: "ZombieActorSmallTier1",
  Large: "ZombieActorLargeTier1",
  Regular: "ZombieActorRegularTier1",
  Female: "ZombieActorGirlTier1",
};

/** Model scale of the biggest of the six (the Large), used to normalise the rest so the
 *  widest icon fills its box and the others stay in proportion to it. */
const BIGGEST_MODEL_SCALE = 1.15;

/** How much of its box an icon's own model scale earns it. Held above a floor so the Small
 *  is visibly the smallest without becoming a smudge. */
function iconScaleFor(modelScale: number): number {
  return Math.max(0.62, Math.min(1, modelScale / BIGGEST_MODEL_SCALE));
}

/** One class's icon, sized to fit a `box`-pixel square and centred on its own origin, or
 *  null for a group with no rig (which cannot happen for the six, but a caller adding a
 *  seventh should get nothing rather than an exception).
 *
 *  Built fresh per call rather than cached: an offer changes twice a fight-minute and this
 *  is eight sprites over shared textures, so a cache would be more lifetime to get wrong
 *  than frames to save. */
export function buildSignIcon(assets: GameAssets, group: string, box: number): Container | null {
  const key = SIGN_ICON_KEY[group];
  const model = key ? assets.zombieModels[key] : undefined;
  if (!model) return null;

  // The head, or the whole body for a class that has no head. `parts` is already z-sorted.
  const head = model.parts.filter((part) => part.group === "head");
  const parts = head.length ? head : model.parts;
  if (!parts.length) return null;

  const [r, g, b] = model.color;
  const tint = (r << 16) | (g << 8) | b;
  const taxon = classify(key).group;

  const rig = new Container();
  rig.sortableChildren = true;
  for (const part of parts) {
    const texture = assets.zombiePartTex[part.file];
    if (!texture) continue;
    const sprite = new Sprite(texture);
    sprite.anchor.set(part.ax, part.ay);
    sprite.position.set(part.px, part.py);
    sprite.scale.set(part.scale ?? 1);
    sprite.zIndex = part.z;
    if (part.tint) sprite.tint = zombiePartTint(part.file, tint, taxon);
    rig.addChild(sprite);
    // A brute's eye is a black disk with a tiny light eyeball centred in it. The farm, the
    // raid and the portrait rigs all build that pair; an icon without it gives the Large
    // flat black holes for eyes, which is the one class whose FACE is its tell.
    if (isBruteEyeball(taxon, part.file)) {
      const eyeball = new Sprite(texture);
      eyeball.anchor.set(part.ax, part.ay);
      eyeball.position.set(part.px, part.py);
      eyeball.scale.set((part.scale ?? 1) * BRUTE_EYEBALL_SCALE);
      eyeball.tint = DEFAULT_ZOMBIE_EYE_TINT;
      eyeball.zIndex = part.z + 0.1;
      rig.addChild(eyeball);
    }
  }
  if (!rig.children.length) return null;

  // Centre the rig on its own art, then scale it into the box. Measured rather than
  // computed from the part offsets: a head sits at a neck position that means nothing once
  // the body is gone, and the Headless body has no neck at all.
  const bounds = rig.getLocalBounds();
  rig.pivot.set(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const longest = Math.max(1, bounds.width, bounds.height);
  rig.scale.set((box / longest) * iconScaleFor(model.scale));

  const holder = new Container();
  holder.addChild(rig);
  return holder;
}
