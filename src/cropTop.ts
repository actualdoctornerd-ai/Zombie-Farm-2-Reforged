// Crop "plants-only" texture generation.
//
// Each grown-crop sprite bakes an isometric DIRT diamond into the bottom of its
// art with the plant/produce/creature drawn on top. Because plots are placed
// freely (not snapped to a coarse grid), a plot can sit one tile diagonally in
// FRONT of its neighbour — so by footprint depth that neighbour is legitimately
// nearer and its baked dirt is painted OVER the tall crop/zombie behind it,
// chopping off the part that overhangs its own plot (a risen zombie's head, a
// leek's tops). No whole-sprite reorder fixes it: the neighbour really is in
// front at ground level.
//
// The fix is to stop letting the dirt take part in the depth sort at all. We
// render every crop TWICE: the untouched art in a ground layer BELOW all the
// actors/crops (so its dirt can never cover anything), and this dirt-removed
// copy in the depth-sorted entity layer (so the plants themselves still sort
// correctly against actors and each other). The two copies are pixel-aligned,
// so the plants read as one — but a neighbour's dirt now sits strictly below
// every plant and can no longer clip it.
//
// The soil is a distinct brown/tan hue, so we key it out by colour. But the
// wooden grave cross is a tan close enough to soil that colour alone eats it, so
// we ALSO gate on position: only pixels at or below the dirt diamond's top edge
// are eligible for removal. Everything that overhangs above the soil (a cross's
// arms, a risen zombie, tall foliage) is kept whatever its colour — that
// overhang is exactly the part a neighbour's dirt must never clip. Bright
// produce (carrots, coffee berries) is protected by colour so it survives even
// where it sits down in the soil.
import { Texture } from "pixi.js";

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}

// Bright, saturated warm produce (carrots, coffee cherries) — never soil.
function isProduce(r: number, g: number, b: number): boolean {
  const [h, s, v] = rgbToHsv(r, g, b);
  return h >= 8 && h <= 42 && s >= 0.62 && v >= 0.72;
}
// Near-greyscale (the wooden grave cross) — keep it, it isn't soil.
function isGrey(r: number, g: number, b: number): boolean {
  return rgbToHsv(r, g, b)[1] < 0.16;
}
// Brown/tan soil: warm hue, from dark shadow through light furrow-crest.
function isSoil(r: number, g: number, b: number): boolean {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (h >= 18 && h <= 48) {
    if (v <= 0.72 && s >= 0.18 && s <= 0.85) return true; // dark/mid brown body
    if (v > 0.6 && v <= 0.9 && s >= 0.14 && s <= 0.55 && r > g && g > b) return true; // light rim/crest
  }
  if (v <= 0.28 && r >= g && g >= b && r - b >= 8) return true; // near-black warm shadow
  return false;
}

/** Build a copy of `tex` with the baked soil pixels cleared to transparent.
 *  Returns the original texture unchanged if a canvas isn't available or the
 *  pixels can't be read (e.g. a tainted source) — callers then fall back to the
 *  old single-sprite behaviour rather than crashing. */
export function makeCropTopTexture(tex: Texture): Texture {
  try {
    const src = tex.source?.resource as CanvasImageSource | undefined;
    const W = tex.frame.width, H = tex.frame.height;
    if (!src || !W || !H || typeof document === "undefined") return tex;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    if (!cx) return tex;
    cx.drawImage(src, tex.frame.x, tex.frame.y, W, H, 0, 0, W, H);
    const img = cx.getImageData(0, 0, W, H);
    const d = img.data;
    const n = W * H;
    // Dirt line: the topmost row that carries a wide (>= 20% width) contiguous run
    // of soil — i.e. where the diamond becomes solid ground. Nothing above it is
    // treated as removable, so the overhanging plant/cross/zombie is always kept.
    let dirtLine = H;
    const minRun = W * 0.2;
    for (let y = 0; y < H && dirtLine === H; y++) {
      let run = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (d[i * 4 + 3] > 120 && isSoil(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) {
          if (++run >= minRun) { dirtLine = y; break; }
        } else run = 0;
      }
    }
    const remove = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
      const y = (i / W) | 0;
      if (a > 30 && y >= dirtLine && !isProduce(r, g, b) && !isGrey(r, g, b) && isSoil(r, g, b))
        remove[i] = 1;
    }
    // Erode one pixel into the soil's anti-aliased edge: a kept pixel touching
    // removed soil that is itself a desaturated warm tone is halo, not plant.
    const halo = new Uint8Array(n);
    for (let y = dirtLine; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (remove[i] || d[i * 4 + 3] <= 30) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (remove[ny * W + nx]) { near = true; break; }
          }
        if (!near) continue;
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        if (!isProduce(r, g, b) && !isGrey(r, g, b) && rgbToHsv(r, g, b)[1] < 0.6 && r > g && g >= b)
          halo[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) if (remove[i] || halo[i]) d[i * 4 + 3] = 0;
    cx.putImageData(img, 0, 0);
    return Texture.from(cv);
  } catch {
    return tex;
  }
}
