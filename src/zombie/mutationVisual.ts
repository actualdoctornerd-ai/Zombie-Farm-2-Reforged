import type { MutationPart, ZombieDef, ZombieModel } from "../assets";
import { bitOf, bitsOf, mutationOf, slotOf } from "./mutations";

/** The base silhouette a mutation takes over. `"armF"` is the authored NAME of the
 *  arm slot (it is what mutations.json and every mod write) — a crop arm claims the
 *  whole pair, front and back. See backArmPlacement. */
export type MutationReplacement = "body" | "armF" | "head";

const CARROT_MUTATION_BIT = bitOf("carrot");
const EYEBISCUS_MUTATION_BIT = bitOf("eyebiscus");
const PUMPKING_BIT = bitOf("pumpking");

/** The eye attachments: Carrot-eyed and the Eyebiscus that used to ride its bit. */
const EYE_MUTATION_BITS: ReadonlySet<number> = new Set([CARROT_MUTATION_BIT, EYEBISCUS_MUTATION_BIT]);

/**
 * The art a mutation draws on a given model, or undefined when this build ships no
 * part for it (an incomplete asset never removes a base part — see the rigs).
 *
 * Both mutations.json and a model's `mutationOverrides` are keyed by the mutation's
 * KEY ("pumpking"). A raw bit key ("8192") is still accepted as a fallback so art
 * authored against the old numeric form — including an existing mod's — keeps
 * resolving. Overrides are how the Tier-4 variants show their own art for a mutation
 * they share (carrot -> eyebiscusHat, cauli -> heartichokeBody).
 *
 * A flipbook rig (the Video Game Zombie) draws NO mutation art at all: every
 * vegetable is authored against the paper-doll skeleton's head, arm and body slots,
 * and a pre-drawn pixel frame has none of them to attach to. The mutation stays on
 * the unit and keeps its stat bonus; only the drawing is skipped — the same rule the
 * masked-face specials apply to their head slot, applied to every slot. All three
 * rigs (farm, raid, portrait) resolve their art through here, so this is the one seam.
 */
export function mutationPartFor(
  parts: Readonly<Record<string, MutationPart>>,
  model: Pick<ZombieModel, "mutationOverrides" | "flipbook"> | undefined,
  bit: number,
): MutationPart | undefined {
  if (model?.flipbook) return undefined;
  const key = mutationOf(bit)?.key;
  const overrides = model?.mutationOverrides;
  const named = (key ? overrides?.[key] : undefined) ?? overrides?.[String(bit)];
  if (named) return parts[named];
  return (key ? parts[key] : undefined) ?? parts[String(bit)];
}

/**
 * Does this mutation replace the whole head, face and all?
 *
 * The vegetable heads are worn AROUND the zombie's own face: an Onionhead keeps its
 * eyes, jaw and teeth in front of the onion, which is the entire reason head parts
 * are re-layered rather than hidden. The pumpkin is not one of those — it is a
 * carved head with a face already on it, so a zombie showing its own eyes and jaw
 * through it would be wearing two faces at once.
 *
 * Only matters for a zombie that HAS a face: the headless family it was authored for
 * has no head parts to hide.
 */
export function mutationCoversFace(bit: number): boolean {
  return bit === PUMPKING_BIT;
}

/** Carrot-eyed and Eyebiscus are eye attachments, so they must remain visible above
 * every authored body part, mutation, and actor FX. */
export const EYE_MUTATION_FOREGROUND_Z = 100;

export function mutationPartZIndex(
  bit: number,
  group: "head" | "root",
  authoredZ: number,
): number {
  if (EYE_MUTATION_BITS.has(bit)) return EYE_MUTATION_FOREGROUND_Z;
  if (group === "head") return 4.5;
  return authoredZ;
}

/**
 * Species whose head-slot mutations are worn but never DRAWN.
 *
 * Their face is a mask — Old McZombie's beard, the Zastronaut's helmet, the Forest
 * Zombie's wall of leaves — layered over an ordinary head. A head mutation hides that
 * head and pushes the face parts in front of the vegetable, so the mask ends up behind
 * a pumpkin with a spare set of eyes floating on it. There is no layer order that
 * reads correctly, so these keep the silhouette they were drawn with.
 *
 * The mask is unchanged data: the bit stays on the zombie, and its stats, its Pot
 * inheritance and its market description are all exactly as they would be otherwise.
 * Only the rig skips the art.
 *
 * This is the SINGLE list of masked actors. It answers two questions that must never
 * disagree: whether head-mutation art is drawn (here) and whether the actor inherits the
 * default mouth that would show below its mask (assets.mergeSpecialZombieModel, which
 * reads it through hidesHeadMutationArt). Add a masked actor once, here.
 */
const MASKED_FACE_KEYS: ReadonlySet<string> = new Set([
  "ZombieActorOldMcZombie",
  "ZombieActorZastronaut",
  "ZombieActorZosmonaut", // a derived recolour of the Zastronaut: same helmet
  "ZombieActorForest",
]);

/** Does this species hide (but still wear) head-slot mutations? */
export function hidesHeadMutationArt(key: string): boolean {
  return MASKED_FACE_KEYS.has(key);
}

/**
 * Mutation bits that should contribute artwork for this species. Named special
 * zombies already have authored faces, so the generic eye attachments (Carrot-eyed
 * and Eyebiscus, which is the same part in a different vegetable) are intentionally
 * omitted there. The bit remains on the zombie and still affects stats; this only
 * controls the rendered rig.
 */
export function mutationBitsForRendering(
  zombies: readonly Pick<ZombieDef, "key" | "category" | "rewardOnly">[] | undefined,
  key: string,
  mutation: number,
): number[] {
  const def = zombies?.find((zombie) => zombie.key === key);
  const isSpecial = def?.category === "special";
  // An Epic Boss prize (the reward-only species) can now WEAR mutations — it takes
  // them in the Zombie Pot like any other special — but draws none of them yet. Its
  // art is a complete authored actor (a doctor's coat, a pirate's hat, a bug's shell)
  // with no mutation art of its own, and the generic vegetables land on it as badly
  // as they do on the pixel zombie. The bits stay on the unit with their full stat
  // bonus; only the drawing waits for per-actor art.
  if (def?.rewardOnly) return [];
  const maskedFace = hidesHeadMutationArt(key);
  return bitsOf(mutation).filter((bit) =>
    !(isSpecial && EYE_MUTATION_BITS.has(bit))
    && !(maskedFace && slotOf(bit) === "head")
  );
}

/**
 * Authored face/accessory layers that remain in front when a crop mutation
 * replaces the skull. Features cover species-specific hair, hats, glasses,
 * ears, and similar decorations (notably every Garden-zombie topper).
 */
export function isMutationForegroundPart(file: string): boolean {
  return /(?:Eye[LR]|Jaw|LowerTeeth|Hair|Hat|Feature|Beard|Mustache)(?:\.png)?$/i.test(file);
}

/** True when a base-model part should be hidden by a replacement mutation.
 *
 * The arm slot covers BOTH arms: a Celery-arms zombie (the name is plural for a
 * reason) grows the crop on each side, so the base front AND back arms give way. */
export function matchesMutationReplacement(
  file: string,
  replacement: MutationReplacement,
): boolean {
  return replacement === "body"
    ? /Body(?:\.png)?$/i.test(file)
    : replacement === "armF"
      ? /Arm[FB](?:\.png)?$/i.test(file)
      : /(?:Head|UpperTeeth|Scar)(?:\.png)?$/i.test(file)
        && !isMutationForegroundPart(file);
}

/** Depth cue the base rigs bake into their own back arm: it is drawn SMALLER and
 *  DIMMER than the front one (defaultArmB is 27x14 against defaultArmF's 32x17, and
 *  ~6% darker in the atlas). Crop arms ship a single texture, so the mirrored copy
 *  reproduces that cue from the front art rather than needing its own drawing. */
export const BACK_ARM_SCALE = 0.84;
export const BACK_ARM_TINT = 0xf0f0f0;

export interface BackArmPlacement {
  x: number;
  y: number;
  ax: number;
  ay: number;
  z: number;
  scale: number;
  tint: number;
}

/**
 * Where a crop arm's mirrored BACK copy sits on this model, or undefined when the
 * rig has no back arm to mirror onto.
 *
 * Derived from the model's OWN ArmF/ArmB pair rather than a hardcoded offset, for
 * two reasons: the copy lands on the real back shoulder whatever a rig does with
 * its arms, and a rig with no arm parts at all (every named special) gets no back
 * copy instead of one floating behind its body.
 */
export function backArmPlacement(
  model: Pick<ZombieModel, "parts">,
  part: Pick<MutationPart, "ox" | "oy" | "ax" | "ay">,
): BackArmPlacement | undefined {
  const front = model.parts.find((p) => /ArmF(?:\.png)?$/i.test(p.file));
  const back = model.parts.find((p) => /ArmB(?:\.png)?$/i.test(p.file));
  if (!front || !back) return undefined;
  // The authored mutation offset is tuned against the FRONT shoulder; shifting it by
  // the rig's own front->back delta puts the copy on the back shoulder. Anchors move
  // with it so the sprite still pivots (and scales) about the joint, not the claw.
  return {
    x: part.ox + (back.px - front.px),
    y: -part.oy + (back.py - front.py),
    ax: part.ax + (back.ax - front.ax),
    ay: part.ay + (back.ay - front.ay),
    z: back.z,
    scale: BACK_ARM_SCALE,
    tint: BACK_ARM_TINT,
  };
}
