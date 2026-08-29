// Animated decor: the timing rules recovered from the source, and the art the
// generator has to keep in step with them.
//
// Both halves are worth pinning. The timing because `animationSpeed` is the whole
// LOOP's duration, not a per-frame delay — read it the other way and the Water Mill
// blinks once every seventy seconds. The art because the runtime slices a sheet by
// arithmetic (`cols`, `w`, `h`) rather than by a frame table: a sheet that is a row
// short does not fail to load, it silently flips through transparent cells.
import { describe, expect, it } from "vitest";
// The app has no @types/node (it only ever runs in a browser); the node test
// environment provides this at runtime. Same treatment as objectSpriteSize.test.ts.
// @ts-ignore
import { readFileSync } from "node:fs";
import placeables from "../public/assets/placeables.json";
import type { ObjectAnimDef, ObjectAnimLayer, ObjectAnimPart } from "./assets";
import {
  advanceObjectAnim, animFrameAt, animPlaying, animRestFrame, cycleMs,
  partLapMs, partOffsetAt, partScaleAt, REST, triggerObjectAnim,
  type ObjectAnimState,
} from "./objectAnimation";

const rows = placeables as {
  key: string; sprite: string; nativeW: number; nativeH: number; rotations?: number;
  anim?: ObjectAnimDef;
}[];
const animated = rows.filter((row) => row.anim);
const OBJECTS = new URL("../public/assets/objects/", import.meta.url);

/** A PNG's dimensions, straight out of the IHDR chunk (bytes 16..24). */
function pngSize(file: string): { w: number; h: number } {
  const bytes = readFileSync(new URL(file, OBJECTS));
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

const layer = (over: Partial<ObjectAnimLayer> = {}): ObjectAnimLayer =>
  ({ sheet: "x.png", n: 4, cols: 4, ms: 400, ...over });

/** A one-layer state with no textures — enough for the pure clock. */
function state(l: ObjectAnimLayer): ObjectAnimState {
  return {
    def: { w: 1, h: 1, layers: [l] },
    layers: [{ layer: l, frames: [], elapsed: 0, frame: animRestFrame(l), playing: !l.onClick }],
    parts: [],
  };
}

/** A one-part state. The pure clock never touches the sprite. */
function partState(part: ObjectAnimPart): ObjectAnimState {
  return {
    def: { w: 1, h: 1, layers: [], parts: [part] },
    layers: [],
    parts: [{ part, sprite: null as never, elapsed: 0, playing: !part.onClick, cued: false }],
  };
}

describe("flipbook timing", () => {
  it("spreads the cells evenly across one loop", () => {
    const l = layer({ n: 4, ms: 400 });
    expect([0, 99, 100, 250, 399].map((t) => animFrameAt(l, t))).toEqual([0, 0, 1, 2, 3]);
  });

  it("wraps a looping layer for ever", () => {
    const l = layer({ n: 3, ms: 180 }); // the Windmill
    expect(animFrameAt(l, 180)).toBe(0);
    expect(animFrameAt(l, 1_000_000 * 180 + 61)).toBe(1);
    expect(animPlaying(l, 1e9)).toBe(true);
  });

  it("holds the last cell through the rest before restarting", () => {
    // The Geyser: 19 cells over a second, then five seconds sitting still.
    const l = layer({ n: 19, ms: 1000, restMs: 5000 });
    expect(cycleMs(l)).toBe(6000);
    expect(animFrameAt(l, 999)).toBe(18);
    expect(animFrameAt(l, 3000)).toBe(18); // mid-rest, still on the last cell
    expect(animFrameAt(l, 6000)).toBe(0); // erupts again
  });

  it("stops a tap-played layer at the end of its one pass", () => {
    const l = layer({ n: 7, ms: 500, onClick: true });
    expect(animPlaying(l, 499)).toBe(true);
    expect(animFrameAt(l, 499)).toBe(6);
    expect(animPlaying(l, 500)).toBe(false);
  });

  it("rests an overlay layer on its own first cell and a base layer on the still", () => {
    // The Liberty Monument's raised arm lives ONLY in its animation, so an overlay
    // layer that rested on nothing would leave the statue standing there armless.
    expect(animRestFrame(layer({ onClick: true }))).toBe(0);
    // The Box o' Lantern's cells ARE its sprite, so a finished pop puts the still
    // back — cocos' restoreOriginalFrame.
    expect(animRestFrame(layer({ onClick: true, base: true }))).toBe(REST);
    expect(animFrameAt(layer({ onClick: true, base: true }), 9999)).toBe(REST);
  });

  it("fires a sound cue once as the run reaches it", () => {
    const l = layer({ n: 7, ms: 700, onClick: true, sound: "parrot.wav", soundFrame: 2 });
    const s = state(l);
    triggerObjectAnim(s);
    const heard: string[] = [];
    for (let t = 0; t < 700; t += 10) advanceObjectAnim(s, 10, (f) => heard.push(f));
    expect(heard).toEqual(["parrot.wav"]);
  });

  it("restarts tap-played layers only, leaving a loop where it stands", () => {
    const tapped = state(layer({ n: 4, ms: 400, onClick: true }));
    expect(triggerObjectAnim(tapped)).toBe(true);
    expect(tapped.layers[0].playing).toBe(true);
    // Already running: a second tap mid-pop is ignored rather than snapping back.
    expect(triggerObjectAnim(tapped)).toBe(false);

    const looping = state(layer({ n: 4, ms: 400 }));
    advanceObjectAnim(looping, 250, () => {});
    expect(triggerObjectAnim(looping)).toBe(false);
    expect(looping.layers[0].frame).toBe(2); // the blades did not jump back to the top
  });

  it("keeps a looping clock bounded however long the farm is left open", () => {
    const s = state(layer({ n: 4, ms: 400, restMs: 200 }));
    for (let i = 0; i < 2000; i++) advanceObjectAnim(s, 100, () => {});
    expect(s.layers[0].elapsed).toBeLessThan(cycleMs(s.layers[0].layer));
  });
});

describe("motion paths", () => {
  // The Mechanical Egg's lid: up 32 over half a second, held, then slammed shut in
  // 50 ms with a thunk. Its y is NEGATIVE because prep has already turned the
  // source's y-up `moveOffsets` into screen pixels.
  const lid: ObjectAnimPart = {
    art: "goldEgg_part0.png", x: -38, y: -100, ms: 1050, onClick: true,
    sound: "block.wav", soundAt: 1050,
    keys: [[0, 0, 0], [500, 0, -32], [1000, 0, -32], [1050, 0, 0]],
  };

  it("interpolates between keys and wraps at the lap", () => {
    expect(partOffsetAt(lid, 0)).toEqual({ x: 0, y: 0 });
    expect(partOffsetAt(lid, 250)).toEqual({ x: 0, y: -16 });
    expect(partOffsetAt(lid, 500)).toEqual({ x: 0, y: -32 });
    expect(partOffsetAt(lid, 750)).toEqual({ x: 0, y: -32 }); // the hold
    expect(partOffsetAt(lid, 1025)).toEqual({ x: 0, y: -16 }); // the slam
    expect(partOffsetAt(lid, 1050 + 250)).toEqual({ x: 0, y: -16 }); // wrapped
  });

  it("leaves a part with no path sitting at home", () => {
    // Two of the Skeleton Couple's 21 bones are its feet, which do not move.
    const foot: ObjectAnimPart = { art: "f.png", x: 1, y: 2 };
    expect(partOffsetAt(foot, 999)).toEqual({ x: 0, y: 0 });
    expect(partScaleAt(foot, 999)).toBe(1);
    expect(partLapMs(foot)).toBe(0);
  });

  it("runs the scale track on its own clock", () => {
    // The Satellite Dish: the twinkle pulses every 0.3 s while it hops every 9.5 s.
    const twinkle: ObjectAnimPart = {
      art: "t.png", x: 18, y: -34, ms: 9504, scaleMs: 300,
      keys: [[0, 0, 0], [9504, 0, 0]], scaleKeys: [[0, 0.8], [150, 1.2], [300, 0.8]],
    };
    expect(partLapMs(twinkle)).toBe(9504);
    expect(partScaleAt(twinkle, 0)).toBeCloseTo(0.8);
    expect(partScaleAt(twinkle, 150)).toBeCloseTo(1.2);
    expect(partScaleAt(twinkle, 450)).toBeCloseTo(1.2); // second pulse, same lap
  });

  it("plays a tapped part once and parks it back home", () => {
    const s = partState(lid);
    expect(s.parts[0].playing).toBe(false); // shut until tapped
    expect(triggerObjectAnim(s)).toBe(true);
    const heard: string[] = [];
    for (let t = 0; t < 1200; t += 25) advanceObjectAnim(s, 25, (f) => heard.push(f));
    expect(heard).toEqual(["block.wav"]); // one thunk, as the lid lands
    expect(s.parts[0].playing).toBe(false);
    expect(s.parts[0].elapsed).toBe(0);
  });

  it("loops a part for ever and re-arms its cue each lap", () => {
    const s = partState({ ...lid, onClick: undefined, soundAt: 500 });
    const heard: string[] = [];
    for (let t = 0; t < 1050 * 3; t += 25) advanceObjectAnim(s, 25, (f) => heard.push(f));
    expect(heard.length).toBe(3);
    expect(s.parts[0].playing).toBe(true);
    expect(s.parts[0].elapsed).toBeLessThan(1050);
  });
});

describe("motion-path art", () => {
  const motion = rows.filter((row) => row.anim?.parts?.length);

  it("moves the six decorations the source moves", () => {
    expect(motion.map((row) => row.key).sort()).toEqual([
      "fireflies", "goldEgg", "iceCreamTruck", "mechanicalBull", "setiDish",
      "skeletonCouple",
    ]);
  });

  it("ships the art every part draws", () => {
    const missing: string[] = [];
    for (const row of motion) {
      for (const file of [row.anim!.base, ...row.anim!.parts!.map((p) => p.art)]) {
        if (file && !pngSize(file).w) missing.push(row.key + ": " + file);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives a part that leaves the still a base with it taken out", () => {
    // Without that residual art a part draws over a copy of itself frozen at home —
    // a lid that lifts off a lid. The four whose still bakes their parts in have
    // one; the Truck's drip and the Dish's twinkle are not in the still, so do not.
    const withBase = motion.filter((row) => row.anim!.base).map((row) => row.key).sort();
    expect(withBase).toEqual(["fireflies", "goldEgg", "mechanicalBull", "skeletonCouple"]);
    for (const row of motion.filter((r) => r.anim!.base)) {
      const base = pngSize(row.anim!.base!);
      expect([base.w, base.h]).toEqual([row.nativeW, row.nativeH]);
    }
  });

  it("keeps every path a closed loop", () => {
    // A moveOffsets script returns to where it started, so a part cannot walk off
    // the object over time. Prep seeds key 0 with the script's END value, which is
    // also what makes the Truck's drip spring back up rather than teleport.
    const wrong: string[] = [];
    for (const row of motion) {
      for (const p of row.anim!.parts!) {
        if (!p.keys?.length) continue;
        const first = p.keys[0], last = p.keys[p.keys.length - 1];
        if (first[1] !== last[1] || first[2] !== last[2])
          wrong.push(row.key + "/" + p.art + ": starts and ends apart");
        if (last[0] !== p.ms) wrong.push(row.key + "/" + p.art + ": last key is not the lap");
        for (let i = 1; i < p.keys.length; i++)
          if (p.keys[i][0] < p.keys[i - 1][0]) wrong.push(row.key + "/" + p.art + ": keys out of order");
      }
    }
    expect(wrong).toEqual([]);
  });

  it("fixes the two decorations that shipped as empty stands", () => {
    // The Mechanical Egg's still was its bottom half (the lid is an animated part)
    // and the Mechanical Bull's was the little plinth under an absent bull. Both are
    // baked now, so the market card and the placed still show the whole object.
    const egg = rows.find((row) => row.key === "goldEgg")!;
    expect(egg.nativeH).toBeGreaterThan(90); // was 76: the bottom half only
    const bull = rows.find((row) => row.key === "mechanicalBull")!;
    expect(bull.nativeW).toBeGreaterThan(120); // was 54: the plinth alone
  });
});

describe("flipbook art", () => {
  it("animates the decor the source animates", () => {
    // 44 tiles carry animationDictionaries. 32 of them are decor this game ships,
    // and all 32 animate: 26 flipbooks and 6 motion paths. The other 12 are tiles
    // that were never brought over.
    expect(animated.length).toBe(32);
    expect(animated.filter((row) => row.anim!.layers.length).length).toBe(26);
    for (const key of ["windmill", "geyser", "koiPond", "tikiTorch", "parrot"]) {
      expect(animated.map((row) => row.key)).toContain(key);
    }
  });

  it("cuts every sheet into exactly the cells the catalog claims", () => {
    const wrong: string[] = [];
    for (const row of animated) {
      const { w, h, layers } = row.anim!;
      for (const l of layers) {
        const size = pngSize(l.sheet);
        const rows_ = Math.ceil(l.n / l.cols);
        if (size.w !== l.cols * w || size.h !== rows_ * h) {
          wrong.push(`${row.key}/${l.sheet}: ${l.n} cells of ${w}x${h} in ${l.cols} `
            + `columns needs ${l.cols * w}x${rows_ * h}, sheet is ${size.w}x${size.h}`);
        }
        if (l.cols > l.n || l.cols < 1) wrong.push(`${row.key}/${l.sheet}: ${l.cols} columns for ${l.n} cells`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("gives every cell room for the still it stands in for", () => {
    // The cell canvas is built around the still (same centre line, same ground line
    // once `dy` is paid) and only grows. A cell SMALLER than the still would mean the
    // generator cropped the object's own art away the moment it started animating.
    const wrong = animated.filter((row) => row.anim!.w < row.nativeW || row.anim!.h < row.nativeH);
    expect(wrong.map((row) => row.key)).toEqual([]);
  });

  it("gives every layer a runnable clock", () => {
    const wrong: string[] = [];
    for (const row of animated) {
      for (const l of row.anim!.layers) {
        if (!(l.ms > 0) || !(l.n > 0)) wrong.push(`${row.key}: ${l.n} cells in ${l.ms}ms`);
        // A tap-played layer ends, so a rest after it would never be seen.
        if (l.onClick && l.restMs) wrong.push(`${row.key}: tap-played layer carries restMs`);
        if (l.sound === undefined && l.soundFrame !== undefined) wrong.push(`${row.key}: cue with no sound`);
        if (l.soundFrame !== undefined && (l.soundFrame < 0 || l.soundFrame >= l.n))
          wrong.push(`${row.key}: cue at cell ${l.soundFrame} of ${l.n}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never asks for a mirror it cannot draw", () => {
    // Cells are symmetric about the still's centre so a flip would be free, but a
    // motion part's path is NOT mirrored, and no animated object can be rotated
    // today (every one is rotations: 1). If that ever changes, the flip has to be
    // taught to negate a part's x — this is the test that will say so.
    const turnable = rows.filter((row) => row.anim && (row.rotations ?? 1) > 1);
    expect(turnable.map((row) => row.key)).toEqual([]);
  });

  it("keeps a second layer as an overlay, never a second base", () => {
    // Only layer 0 can carry the object's own art: the runtime draws every other
    // layer into a child sprite ON TOP of it, so a `base` layer there would paint the
    // whole object over itself.
    const wrong = animated.filter((row) => row.anim!.layers.slice(1).some((l) => l.base));
    expect(wrong.map((row) => row.key)).toEqual([]);
  });
});
