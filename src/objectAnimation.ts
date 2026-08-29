// Animated decor: the flipbook 26 placed objects play on the farm.
//
// GROUND TRUTH: a TileProperties tile can carry `animationDictionaries`, a list of
// animated LAYERS drawn with the tile. tools/prep_placeables.py bakes each layer
// into a sheet of cells — one cell is the whole object as it looks at that step —
// and hands the runtime a cell count and the duration of one pass. So there is no
// compositing left to do here: layer 0 drives the object's OWN sprite, and a second
// layer (only Skunkarella's Fountain and the Taiko Drum have one) rides along as a
// child sprite, because two layers can run at different speeds and cannot share one
// strip.
//
// Cells share the still sprite's centre line by construction, so a mirrored object
// needs no offset of its own; `dy` (how far the cells hang below the still's ground
// line) is the one correction, and Field applies it to the sprite's y.
//
// Two ways a layer runs:
//   looping  — cycles for ever, holding the last cell for `restMs` before it
//              restarts (the Geyser erupts for a second, then sits still for five).
//   onClick  — plays once when the object is tapped. A `base` layer (its cells ARE
//              the object's sprite) puts the still back at the end, matching cocos'
//              restoreOriginalFrame; an overlay layer has no still to fall back to
//              and rests on cell 0, which is what keeps the Liberty Monument's
//              raised arm on the statue between waves.
//
// The other shape a layer takes is a MOTION PATH: one piece of art walked along a
// keyframed track, and optionally pulsed along a second one. Six objects use it, and
// prep has already turned both source scripts (`moveOffsets`, `moveToOffsets`) into
// the same thing — offsets in screen pixels from the object's ground point — so all
// that is left here is to interpolate and place. A motion part is a child sprite for
// the same reason a second flipbook layer is: it inherits the object's transform and
// draws over it without entering the depth sort.
import { Rectangle, Sprite, Texture } from "pixi.js";
import type { ObjectAnimDef, ObjectAnimLayer, ObjectAnimPart } from "./assets";

/** The still sprite, i.e. "this layer is showing no cell of its own". */
export const REST = -1;

/** The cell a layer rests on when it is not playing. */
export function animRestFrame(layer: ObjectAnimLayer): number {
  return layer.base ? REST : 0;
}

/** The cell a layer shows `elapsed` ms into a run.
 *
 *  A looping layer wraps through `ms` and then holds its last cell for `restMs`; a
 *  tap-played one stops at the end and falls back to its rest cell. */
export function animFrameAt(layer: ObjectAnimLayer, elapsed: number): number {
  const n = Math.max(1, layer.n);
  const run = Math.max(1, layer.ms);
  const at = (t: number) => Math.min(n - 1, Math.max(0, Math.floor((t / run) * n)));
  if (layer.onClick) return elapsed >= run ? animRestFrame(layer) : at(elapsed);
  const cycle = cycleMs(layer);
  const t = ((elapsed % cycle) + cycle) % cycle;
  return t >= run ? n - 1 : at(t);
}

/** One full pass plus the pause held after it. */
export function cycleMs(layer: ObjectAnimLayer): number {
  return Math.max(1, layer.ms) + Math.max(0, layer.restMs ?? 0);
}

/** Does this layer still have cells to show after `elapsed` ms? Only a tap-played
 *  layer ever answers no — that is what takes it off the tick list. */
export function animPlaying(layer: ObjectAnimLayer, elapsed: number): boolean {
  return !layer.onClick || elapsed < Math.max(1, layer.ms);
}

/** Cut a layer's cell sheet into its cells, left to right and top to bottom. */
export function animFrames(layer: ObjectAnimLayer, def: ObjectAnimDef, sheet: Texture): Texture[] {
  return Array.from({ length: layer.n }, (_, i) => new Texture({
    source: sheet.source,
    frame: new Rectangle((i % layer.cols) * def.w, Math.floor(i / layer.cols) * def.h,
      def.w, def.h),
  }));
}

/** Where a part sits `t` ms into its path. Between keys the motion is linear, which
 *  is what cocos' MoveBy/MoveTo do; `t` wraps at the lap length. */
export function partOffsetAt(part: ObjectAnimPart, t: number): { x: number; y: number } {
  const keys = part.keys;
  if (!keys?.length || !part.ms) return { x: 0, y: 0 };
  const at = ((t % part.ms) + part.ms) % part.ms;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (at < a[0] || at > b[0]) continue;
    const f = b[0] === a[0] ? 0 : (at - a[0]) / (b[0] - a[0]);
    return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f };
  }
  const last = keys[keys.length - 1];
  return { x: last[1], y: last[2] };
}

/** How big a part is drawn `t` ms in. The scale track runs on its OWN clock — the
 *  Satellite Dish's twinkle pulses every 0.3 s while it hops every 9.5 s. */
export function partScaleAt(part: ObjectAnimPart, t: number): number {
  const keys = part.scaleKeys;
  if (!keys?.length || !part.scaleMs) return 1;
  const at = ((t % part.scaleMs) + part.scaleMs) % part.scaleMs;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (at < a[0] || at > b[0]) continue;
    const f = b[0] === a[0] ? 0 : (at - a[0]) / (b[0] - a[0]);
    return a[1] + (b[1] - a[1]) * f;
  }
  return keys[keys.length - 1][1];
}

/** One full lap of a part: the longer of its two tracks, since they restart together
 *  (the Ice Cream Truck's drip falls and fades on the same 3.51 s loop). */
export function partLapMs(part: ObjectAnimPart): number {
  return Math.max(part.ms ?? 0, part.scaleMs ?? 0);
}

/** One motion part of one placed object, mid-play. */
export interface AnimPartState {
  readonly part: ObjectAnimPart;
  readonly sprite: Sprite;
  elapsed: number;
  playing: boolean;
  cued: boolean; // this lap's sound has already fired
}

/** One layer of one placed object, mid-play. */
export interface AnimLayerState {
  readonly layer: ObjectAnimLayer;
  readonly frames: Texture[];
  /** The child sprite this layer draws into. Layer 0 has none: it drives the
   *  object's own sprite, so the still it replaces cannot show through. */
  readonly sprite?: Sprite;
  elapsed: number;
  frame: number;
  playing: boolean;
}

export interface ObjectAnimState {
  readonly def: ObjectAnimDef;
  readonly layers: AnimLayerState[];
  readonly parts: AnimPartState[];
  /** The object's art with its motion parts taken out, drawn in place of the still.
   *  Absent when the still holds no parts (the Ice Cream Truck's drip is not in it). */
  readonly base?: Texture;
}

/** Build the play state for one placed object. `cells` resolves a layer's cut cells
 *  (Field caches those per sheet, so ten tiki torches share one set); a layer whose
 *  sheet has not loaded resolves to nothing and is left out rather than blanking the
 *  object, so a failed asset costs the motion and nothing else. */
export function createObjectAnim(
  def: ObjectAnimDef, cells: (layer: ObjectAnimLayer) => Texture[] | undefined,
  art: (file: string) => Texture | undefined = () => undefined,
): ObjectAnimState | undefined {
  const layers: AnimLayerState[] = [];
  for (const [i, layer] of def.layers.entries()) {
    const frames = cells(layer);
    if (!frames?.length) continue;
    // Layers past the first draw into a CHILD of the object's sprite, so they
    // inherit the whole transform it already has — including the negative x scale
    // of a mirrored object — and draw immediately over it without entering the
    // depth sort at all.
    const sprite = i === 0 ? undefined : new Sprite();
    sprite?.anchor.set(0.5, 1);
    // A looping layer is already running the moment the object is placed, so it
    // opens on cell 0 rather than flashing the still for one frame.
    const playing = !layer.onClick;
    layers.push({
      layer, sprite, frames,
      elapsed: 0, frame: playing ? 0 : animRestFrame(layer), playing,
    });
  }

  // Motion parts are all-or-nothing with the base they are lifted out of: drawing
  // them over the ordinary still would leave a second, motionless copy of every one
  // behind. So if that art is missing, the object keeps its still and simply does
  // not move.
  const base = def.base ? art(def.base) : undefined;
  const parts: AnimPartState[] = [];
  if (!def.base || base) {
    for (const part of def.parts ?? []) {
      const tex = art(part.art);
      if (!tex) { parts.length = 0; break; }
      const sprite = new Sprite(tex);
      sprite.anchor.set(part.ax ?? 0, part.ay ?? 0);
      parts.push({ part, sprite, elapsed: 0, playing: !part.onClick, cued: false });
    }
  }
  if (!parts.length && layers.length === 0) return undefined;
  return { def, layers, parts, base: parts.length ? base : undefined };
}

/** Advance one object's animation by `dtMs`, reporting each sound cue it crosses.
 *  Returns true when any layer changed cell (i.e. its texture needs re-applying). */
export function advanceObjectAnim(
  state: ObjectAnimState, dtMs: number, onSound: (file: string) => void,
): boolean {
  let changed = false;
  for (const s of state.layers) {
    if (!s.playing) continue;
    s.elapsed += dtMs;
    s.playing = animPlaying(s.layer, s.elapsed);
    // A looping layer runs for as long as the object is placed, so keep its clock
    // inside one cycle rather than letting it grow all session.
    if (s.playing && !s.layer.onClick) s.elapsed %= cycleMs(s.layer);
    const frame = s.playing ? animFrameAt(s.layer, s.elapsed) : animRestFrame(s.layer);
    if (frame === s.frame) continue;
    // A "playSound" entry in the source's frame list is a cue, not a frame: it
    // fires as the run reaches that point (the Parrot squawks mid-flap, the Taiko
    // Drum lands one hit per stick).
    if (s.playing && s.layer.sound && frame === s.layer.soundFrame) onSound(s.layer.sound);
    s.frame = frame;
    changed = true;
  }
  for (const s of state.parts) {
    if (!s.playing) continue;
    const lap = partLapMs(s.part);
    s.elapsed += dtMs;
    if (s.part.sound && s.part.soundAt !== undefined && !s.cued && s.elapsed >= s.part.soundAt) {
      onSound(s.part.sound);
      s.cued = true;
    }
    if (s.elapsed >= lap) {
      // A looping part starts its next lap (and re-arms its cue); a tap-played one
      // stops back at its home pose, where the Mechanical Egg's lid is shut.
      if (s.part.onClick) { s.elapsed = 0; s.playing = false; } else s.elapsed %= lap || 1;
      s.cued = false;
    }
    changed = true;
  }
  return changed;
}

/** Where a part's sprite belongs right now, in the object's own local space. */
export function posePart(s: AnimPartState): { x: number; y: number; scale: number } {
  const off = partOffsetAt(s.part, s.elapsed);
  return {
    x: s.part.x + off.x, y: s.part.y + off.y,
    scale: partScaleAt(s.part, s.elapsed),
  };
}

/** Start every tap-played layer over. Looping layers are untouched — tapping a
 *  windmill should not jerk its blades back to the top. Returns true if anything
 *  started, so a caller can tell a tap that did something from one that did not. */
export function triggerObjectAnim(state: ObjectAnimState): boolean {
  let started = false;
  for (const s of state.layers) {
    if (!s.layer.onClick || s.playing) continue;
    s.elapsed = 0;
    s.frame = animFrameAt(s.layer, 0);
    s.playing = true;
    started = true;
  }
  for (const s of state.parts) {
    if (!s.part.onClick || s.playing) continue;
    s.elapsed = 0;
    s.cued = false;
    s.playing = true;
    started = true;
  }
  return started;
}
