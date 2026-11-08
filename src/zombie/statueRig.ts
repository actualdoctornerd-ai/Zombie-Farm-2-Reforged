// The stone statue of a fallen zombie, as it stands on a Memorial Statue's plinth.
//
// It is the SAME rig the inspect-card portrait builds — same species model, same
// mutation replacements and overlays — so a memorial shows the zombie the player
// actually lost, freckle for freckle. Two things differ:
//
//   • It is carved, not alive. Nothing about it animates: no head-nod, no walk, no
//     idle blink. The rig is built once and never ticked.
//   • It is stone. A tint alone cannot do that (tinting multiplies, so a red arm
//     just becomes a darker red), so the colour is stripped with a desaturating
//     colour matrix and the result re-tinted to granite. That happens for the whole
//     rig at once, which is what keeps a carrot arm and a skull the same stone.
//
// The filter is baked with cacheAsTexture: the statue never changes, so paying for
// a filter pass on every frame of every statue would be a farm-wide frame cost for
// a picture that is identical each time.
import { ColorMatrixFilter, Container } from "pixi.js";
import type { GameAssets } from "../assets";
import { displayedAppearance } from "./appearance";
import { zombieFarmScale } from "./displayScale";
import type { FallenZombie } from "./memorial";
import { buildZombiePortraitRig } from "./mutationPortrait";
import { classify } from "./taxonomy";

/** Base tint fed to the rig instead of the unit's own colour, so every species
 *  starts from the same stone value rather than from its living body colour. */
const STONE_BASE: [number, number, number] = [188, 188, 182];
/** Granite, as 0..1 channels. Matches what the plinth art desaturates to (see
 *  tools/memorial_statue.py) so the statue and the plinth read as one block. */
const STONE = [0.82, 0.83, 0.79];
/** Luminance is COMPRESSED into a narrow band, not just desaturated. A plain
 *  desaturation keeps the source's full range, and zombie art uses all of it — so
 *  a dark-bodied species came out near-black and a pale one near-white, neither of
 *  which reads as carved stone. `l -> LUM_OFFSET + LUM_SCALE * l` flattens both
 *  into mid-grey while keeping enough shading to see the sculpt. */
const LUM_SCALE = 0.7;
const LUM_OFFSET = 0.44;
/** Rec.601 luma weights — the same ones the plinth generator desaturates with. */
const LUMA = [0.299, 0.587, 0.114];

/** The colour matrix every statue shares. Filters are stateless here — the rig is
 *  baked to a texture at build time — so one instance can serve every memorial. */
function makeStoneFilter(): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  const row = (channel: number): [number, number, number, number, number] => [
    LUMA[0] * LUM_SCALE * channel, LUMA[1] * LUM_SCALE * channel, LUMA[2] * LUM_SCALE * channel,
    0, LUM_OFFSET * channel,
  ];
  filter.matrix = [
    ...row(STONE[0]), ...row(STONE[1]), ...row(STONE[2]),
    0, 0, 0, 1, 0, // alpha passes through: the silhouette stays the zombie's own
  ];
  return filter;
}
let sharedStone: ColorMatrixFilter | null = null;
/** The one stone look: the statues', and Medusa's victims in battle. */
export function stoneFilter(): ColorMatrixFilter {
  return (sharedStone ??= makeStoneFilter());
}

/**
 * A carved, unanimated copy of `fallen`, scaled to the size the living zombie was
 * on the farm and anchored at its feet (so the caller only has to place the mount
 * point). Returns null when the species has no model at all.
 */
export function buildStatueRig(assets: GameAssets, fallen: FallenZombie): Container | null {
  // Respect the device's "show mutations" preference the same way a live zombie
  // does — a farm that hides mutations should not have statues wearing them. The
  // display colour is discarded: a statue is stone whatever the unit was.
  const shown = displayedAppearance(fallen.mutation, fallen.color);
  const rig = buildZombiePortraitRig(assets, fallen.key, shown.mutation, STONE_BASE);
  if (!rig.children.length) {
    rig.destroy({ children: true });
    return null;
  }
  // buildZombiePortraitRig applies the model's own card scale; the farm sizes every
  // zombie by family instead (see ZombieUnit.build), and a memorial has to match
  // the zombies walking past it. Body type and class come from the species key, the
  // same way the living rig resolves them — a fallen record stores neither.
  const tax = classify(fallen.key);
  rig.scale.set(zombieFarmScale(tax.group, tax.className, fallen.key));

  const statue = new Container();
  statue.addChild(rig);
  statue.filters = [stoneFilter()];
  statue.cacheAsTexture(true);
  return statue;
}
