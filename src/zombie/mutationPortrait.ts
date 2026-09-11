import { Container, Rectangle, Sprite, type Renderer } from "pixi.js";
import type { GameAssets, ZombieModel } from "../assets";
import { slotOf } from "./mutations";
import {
  backArmPlacement,
  isMutationForegroundPart,
  matchesMutationReplacement,
  mutationCoversFace,
  mutationBitsForRendering,
  mutationPartFor,
  mutationPartZIndex,
  type MutationReplacement,
} from "./mutationVisual";
import {
  BRUTE_EYEBALL_SCALE,
  DEFAULT_ZOMBIE_EYE_TINT,
  displayedAppearance,
  isBruteEyeball,
  zombiePartTint,
} from "./appearance";
import { classify } from "./taxonomy";

const MUT_BASE_FOREGROUND_Z = 30;

/** The sprites in a portrait rig that came from MUTATION art rather than from the
 *  zombie's own parts. A card exists to show what the zombie is wearing, so the
 *  frame that crops a labelled rig (see portraitFrameTop) must never cut these —
 *  several crop hats rear up well above the crown a top label marks. Marked here,
 *  at the one place they are built, rather than re-derived from their placement. */
const MUTATION_SPRITES = new WeakSet<Sprite>();

/** Ensure a renderer extraction contains at least one visible pixel before it is
 * allowed to replace a known-good catalog portrait. Some browser/GPU combinations
 * have returned a valid transparent PNG instead of rejecting the extraction. */
export async function validatePortraitDataUrl(source: string): Promise<string> {
  if (typeof document === "undefined" || typeof Image === "undefined") return source;
  const image = new Image();
  image.src = source;
  if (typeof image.decode === "function") await image.decode();
  else await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("portrait image could not be decoded"));
  });
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("portrait validation canvas unavailable");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0) return source;
  }
  throw new Error("portrait extraction was transparent");
}

/** Assemble the same static rig used by an owned farm zombie, including every
 * mutation overlay/replacement carried in its individual bitmask. */
export function buildZombiePortraitRig(
  assets: GameAssets,
  key: string,
  mutation: number,
  color?: [number, number, number],
): Container {
  const root = new Container();
  root.sortableChildren = true;
  const model: ZombieModel =
    assets.zombieModels[key] ?? assets.zombieModels["ZombieActorRegularTier1"];
  const [r, g, b] = color ?? model.color;
  const tint = (r << 16) | (g << 8) | b;
  const group = classify(key).group;
  const replaceable: Record<MutationReplacement, Sprite[]> = { body: [], armF: [], head: [] };
  const headForeground: Sprite[] = [];

  for (const part of model.parts) {
    const texture = assets.zombiePartTex[part.file];
    if (!texture) continue;
    const sprite = new Sprite(texture);
    sprite.label = part.file;
    sprite.anchor.set(part.ax, part.ay);
    sprite.position.set(part.px, part.py);
    sprite.scale.set(part.scale ?? 1);
    sprite.zIndex = part.z;
    if (part.tint) sprite.tint = zombiePartTint(part.file, tint, group);
    root.addChild(sprite);
    if (matchesMutationReplacement(part.file, "body")) replaceable.body.push(sprite);
    if (matchesMutationReplacement(part.file, "armF")) replaceable.armF.push(sprite);
    if (part.group === "head" && matchesMutationReplacement(part.file, "head")) {
      replaceable.head.push(sprite);
    }
    if (part.group === "head" && isMutationForegroundPart(part.file)) {
      headForeground.push(sprite);
    }

    // Large zombies keep their dark full-size eye disks with a small light eyeball
    // centered inside — the farm and raid rigs both build it, and a portrait without
    // it showed every brute with flat black eyes. Registering it as a foreground part
    // keeps it in front when a head mutation re-layers the face (see below).
    if (isBruteEyeball(group, part.file)) {
      const eyeball = new Sprite(texture);
      eyeball.label = part.file;
      eyeball.anchor.set(part.ax, part.ay);
      eyeball.position.set(part.px, part.py);
      eyeball.scale.set((part.scale ?? 1) * BRUTE_EYEBALL_SCALE);
      eyeball.tint = DEFAULT_ZOMBIE_EYE_TINT;
      eyeball.zIndex = part.z + 0.1;
      root.addChild(eyeball);
      headForeground.push(eyeball);
    }
  }

  for (const bit of mutationBitsForRendering(assets.zombies, key, mutation)) {
    const part = mutationPartFor(assets.mutationParts, model, bit);
    const texture = part ? assets.zombiePartTex[part.file] : undefined;
    if (!part || !texture) continue;
    const sprite = new Sprite(texture);
    sprite.label = part.file;
    sprite.anchor.set(part.ax, part.ay);
    sprite.position.set(
      part.ox + (part.headRel ? model.neck.x : 0),
      -part.oy + (part.headRel ? model.neck.y : 0),
    );
    const replacement: MutationReplacement | undefined =
      part.replaces ?? (slotOf(bit) === "head" ? "head" : undefined);
    if (replacement) {
      for (const basePart of replaceable[replacement]) basePart.visible = false;
      if (replacement === "head") {
        // Same rule as the farm and raid rigs: a head mutation with a face of its
        // own hides the zombie's, rather than sitting behind it.
        const covers = mutationCoversFace(bit);
        for (const basePart of headForeground) {
          if (covers) basePart.visible = false;
          else basePart.zIndex = MUT_BASE_FOREGROUND_Z + basePart.zIndex;
        }
      }
    }
    sprite.zIndex = mutationPartZIndex(bit, part.group, part.z);
    MUTATION_SPRITES.add(sprite);
    root.addChild(sprite);
    // A crop arm claims BOTH arms, so the card shows the same mirrored pair the
    // farm and battlefield rigs assemble.
    if (replacement === "armF") {
      const at = backArmPlacement(model, part);
      if (at) {
        const back = new Sprite(texture);
        back.label = part.file;
        back.anchor.set(at.ax, at.ay);
        back.position.set(at.x, at.y);
        back.scale.set(at.scale);
        back.tint = at.tint;
        back.zIndex = at.z;
        MUTATION_SPRITES.add(back);
        root.addChild(back);
      }
    }
  }

  root.scale.set(model.scale ?? 1);
  return root;
}

/**
 * Top edge of the portrait frame, in the rig's own (scaled) space.
 *
 * A card's portrait box fits the extracted image by `contain`, so a rig that carries
 * something tall — the Admiral's plume, Zomtar's headdress, the Master Ninjombie's
 * banner — is shrunk to squeeze the prop into the box and its face ends up two thirds
 * the size of an ordinary zombie's beside it. A rig with a hand-labelled `topY`
 * (Rig Studio -> assets/zombie/tops.json) is framed to that line instead, so the
 * zombie itself fills the box and the prop is cropped by the frame — the portrait
 * equivalent of the overhang the raid gives it.
 *
 * Two things are never cropped: a label that does not lie inside this rig's art is
 * ignored (the same guard RaidActor.getSizingBounds applies), and mutation art always
 * wins over the label, because showing what a zombie is wearing is the whole job of
 * the card.
 */
export function portraitFrameTop(
  rig: Container, model: ZombieModel, bounds: { y: number; height: number },
): number {
  const label = model.topY;
  if (typeof label !== "number" || !Number.isFinite(label)) return bounds.y;
  const scaled = label * (model.scale ?? 1);
  if (!(scaled > bounds.y && scaled < bounds.y + bounds.height)) return bounds.y;
  let top = scaled;
  for (const child of rig.children) {
    if (!(child instanceof Sprite) || !MUTATION_SPRITES.has(child) || !child.visible) continue;
    top = Math.min(top, child.getBounds().y);
  }
  return Math.max(bounds.y, top);
}

/** How many times one key/mask/color may fail before it stops being retried. A
 *  failing extraction costs as much as a successful one (~30ms of blocked main
 *  thread), and the panels that request portraits rebuild their whole list on every
 *  tap — so without a ceiling a single zombie whose textures never loaded re-pays
 *  that cost on every interaction, forever. */
export const MAX_PORTRAIT_ATTEMPTS = 2;

/** Marks an extraction that was dropped before it ran because every tile waiting on
 *  it had left the DOM. Callers already fall back to the static species portrait on
 *  any rejection, so nothing has to special-case it; the cache checks for it so an
 *  abandoned request does not spend one of the key's retry attempts. */
const ABANDONED = "portrait request was abandoned";

/** Hand the main thread back between extractions. Each one blocks on a GPU→CPU
 *  readback, so a panel that asks for fifty at once used to run them as a single
 *  uninterruptible task (~1.5s frozen on a full roster). Spacing them across frames
 *  keeps input and rendering alive while the portraits fill in. */
function yieldToNextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") {
    // Headless (tests/SSR): still yield, just without a frame to hang it on.
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Cache the GPU extraction for each immutable key/mask/color combination. */
export class MutationPortraits {
  private cache = new Map<string, Promise<string>>();
  /** Consecutive failures per cache key, capped by MAX_PORTRAIT_ATTEMPTS. */
  private failures = new Map<string, number>();
  /** Tail of the extraction chain — see enqueue(). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Liveness tests for the tiles still waiting on an in-flight extraction, per cache
   *  key. One entry per requester, because several panels (or several tiles of one
   *  panel) can be waiting on the same portrait. */
  private wanted = new Map<string, (() => boolean)[]>();

  constructor(private renderer: Renderer, private assets: GameAssets) {}

  /**
   * The portrait for one key/mask/colour, extracted at most once.
   *
   * `wanted` reports whether the tile that asked for it is still on screen. A queued
   * extraction runs one per frame and blocks the main thread for ~30ms, so a panel
   * the player closes mid-burst used to keep paying for portraits nobody could see —
   * on the farm behind it, that reads as a lag spike *after* leaving the panel. The
   * test is checked at the moment the request reaches the head of the queue, so work
   * already started still finishes.
   */
  /**
   * @param forceMutation draw the mask as given, ignoring the "show mutations" display
   *  pref. Only the Mutation Almanac passes this, and it has to: that pref is a
   *  cosmetic choice about the player's own army, but a catalog entry FOR a mutation
   *  with the mutation switched off is a picture of a plain zombie, sixteen times over.
   *  Safe against the cache because the key is built from the mask that will actually
   *  be drawn — a forced portrait and a suppressed one land on different entries, and
   *  when the pref is on they land on the same one, which is correct: same picture.
   */
  get(
    key: string,
    mutation: number,
    color?: [number, number, number],
    wanted?: () => boolean,
    forceMutation = false,
  ): Promise<string> {
    // Normalize through the display prefs BEFORE the cache key is formed: a portrait
    // is cached by what it will look like, so flipping "show mutations" or the body
    // colour mode addresses a different entry instead of returning a stale one.
    const shown = displayedAppearance(mutation, color);
    color = shown.color;
    if (!forceMutation) mutation = shown.mutation;
    const cacheKey = `${key}|${mutation}|${color?.join(",") ?? "default"}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      // A later requester adopts the in-flight extraction, so its liveness test joins
      // the others: the work survives as long as ANY tile waiting on it does.
      if (wanted) this.wanted.get(cacheKey)?.push(wanted);
      return existing;
    }
    if ((this.failures.get(cacheKey) ?? 0) >= MAX_PORTRAIT_ATTEMPTS) {
      return Promise.reject(new Error(`portrait extraction gave up for ${cacheKey}`));
    }
    const watchers = wanted ? [wanted] : [];
    this.wanted.set(cacheKey, watchers);
    const pending = this.enqueue(() => {
      if (watchers.length && !watchers.some((live) => live())) throw new Error(ABANDONED);
      return this.extract(key, mutation, color);
    }).catch((error) => {
      this.cache.delete(cacheKey);
      // Abandoning is not failing: the extraction never ran, so it must not count
      // against the two attempts this portrait gets before it is written off.
      if (!(error instanceof Error && error.message === ABANDONED)) {
        this.failures.set(cacheKey, (this.failures.get(cacheKey) ?? 0) + 1);
      }
      throw error;
    });
    this.cache.set(cacheKey, pending);
    // Settled either way, the watchers have nothing left to answer for.
    void pending.then(() => this.wanted.delete(cacheKey), () => this.wanted.delete(cacheKey));
    return pending;
  }

  /** Run extractions one at a time, each starting on a fresh frame, so a burst of
   *  requests becomes a series of short tasks instead of one long one. The chain's
   *  tail absorbs rejections; callers still see them through their own promise. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(yieldToNextFrame).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async extract(key: string, mutation: number, color?: [number, number, number]): Promise<string> {
    const rig = buildZombiePortraitRig(this.assets, key, mutation, color);
    // Keep the scaled rig as a child so the extraction target's local bounds include
    // the model scale (notably the 1.15x Large silhouette) and nothing is clipped.
    const target = new Container();
    target.addChild(rig);
    const bounds = target.getLocalBounds();
    const model = this.assets.zombieModels[key] ?? this.assets.zombieModels["ZombieActorRegularTier1"];
    const top = model ? portraitFrameTop(rig, model, bounds) : bounds.y;
    const pad = 8;
    const frame = new Rectangle(
      bounds.x - pad,
      top - pad,
      Math.max(1, bounds.width + pad * 2),
      Math.max(1, bounds.y + bounds.height - top + pad * 2),
    );
    try {
      const source = await this.renderer.extract.base64({
        target,
        frame,
        resolution: 2,
        format: "png",
        clearColor: [0, 0, 0, 0],
      });
      return await validatePortraitDataUrl(source);
    } finally {
      target.destroy({ children: true });
    }
  }
}
