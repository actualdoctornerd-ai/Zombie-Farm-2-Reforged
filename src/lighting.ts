// Night lighting — the FAITHFUL model, matching ZF2's `AmbientLayer`.
//
// ZF2 renders a dark mask into an offscreen target, then CARVES lights out of it
// (each light a gradient circle that removes darkness), and lays the result over
// the scene. A lit pixel just reveals the daytime art beneath — it can never be
// brighter than day, so it physically can't glare. We reproduce that here with a
// screen-sized RenderTexture: draw the dark mask, `erase` holes where the lights
// are, then draw that light-map over the world.
//
// Why a manual RenderTexture (not additive sprites, not a render-group blend):
//  - Additive lights ADD brightness on top of the scene -> blows out to white.
//  - `erase` only composites correctly inside its OWN render target; a pixi v8
//    render group doesn't isolate it (it erased the live scene). An explicit
//    RenderTexture is that isolated target, and keeps the map screen-sized (a
//    world-space cache of the whole farm would be a huge texture).
import { Container, Graphics, Matrix, RenderTexture, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

// The darkness: a cool dark-blue mask. Its alpha in fully-unlit areas sets how
// dark night is; lights erase this alpha away to reveal the daytime scene.
const NIGHT_MASK = 0x0a1430;
const NIGHT_MASK_ALPHA = 0.72;

// Soft radial brush used to ERASE darkness. Opaque core removes (reveals) fully,
// fading to no effect at the rim, so light pools have gentle edges. For an erase
// brush the COLOUR is irrelevant (erase only touches destination alpha) — only
// this alpha profile matters, so a full-white core reveals daytime, never glares.
let LIGHT_TEX: Texture | null = null;
function lightTexture(): Texture {
  if (LIGHT_TEX) return LIGHT_TEX;
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1.0)");
  g.addColorStop(0.28, "rgba(255,255,255,0.82)");
  g.addColorStop(0.6, "rgba(255,255,255,0.3)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  LIGHT_TEX = Texture.from(cv);
  return LIGHT_TEX;
}

/** A light that carves a hole in the night mask: a soft radial `erase` brush of
 *  `radius` world px. `alpha` is how strongly it reveals (1 = full daylight at the
 *  core, less = a dim glow). `color` is accepted for API symmetry but unused — an
 *  erase brush only removes darkness, it doesn't tint. */
export function makeLight(radius: number, _color = 0xffffff, alpha = 1): Sprite {
  const s = new Sprite(lightTexture());
  s.anchor.set(0.5);
  s.blendMode = "erase"; // subtract this brush's alpha from the mask
  s.alpha = alpha;
  s.width = s.height = radius * 2; // texture radius is S/2 -> scale to `radius`
  return s;
}

// Glowing objects and the reveal-radius of their light. Radius is in the reimpl's
// world px. Colour is kept for reference/future warm-tint work but the erase mask
// reveals true daytime colour regardless.
export const OBJECT_GLOWS: Record<string, { color: number; radius: number }> = {
  // --- Authoritative: objects ZF2 itself lights (pointLights in TileProperties) ---
  fireflies: { color: 0xcfe6ff, radius: 70 },
  sparklers: { color: 0xffffff, radius: 80 },
  swampFence: { color: 0xffd98a, radius: 80 },
  swampShack: { color: 0xffcf78, radius: 120 },
  greatPyramid: { color: 0xfff0c0, radius: 130 },
  antiHolidayIncinerator: { color: 0xffb060, radius: 90 },
  // ZF2 self-illuminates these via a night-sprite swap (no cast light); we give them
  // a soft glow so they read as light sources at night.
  candleAltarDay: { color: 0xffe0a0, radius: 120 },
  candleAltarNight: { color: 0xffe0a0, radius: 120 },
  glowFlowerDay: { color: 0xaef0ff, radius: 60 },
  glowFlowerNight: { color: 0xaef0ff, radius: 60 },
  glowMushroomDay: { color: 0x9affc0, radius: 60 },
  glowMushroomNight: { color: 0x9affc0, radius: 60 },
  glowSkullDay: { color: 0xd7b0ff, radius: 60 },
  glowSkullNight: { color: 0xd7b0ff, radius: 60 },
  glowStoneDay: { color: 0xbfe0ff, radius: 60 },
  glowStoneNight: { color: 0xbfe0ff, radius: 60 },

  // --- Reimpl additions: obvious real light sources the original never wired up.
  // Open flame (warm orange), candles (amber), and lamps/lanterns (soft amber). ---
  bonfire: { color: 0xff8a3c, radius: 110 },
  pixelCampfire: { color: 0xff8a3c, radius: 100 },
  fireRing: { color: 0xff7a30, radius: 130 },
  fancyFireplace: { color: 0xff8a3c, radius: 90 },
  tikiTorch: { color: 0xffa845, radius: 70 },
  candle: { color: 0xffdca0, radius: 55 },
  bunchOfCandles: { color: 0xffdca0, radius: 65 },
  skullCandle: { color: 0xffdca0, radius: 55 },
  heartCandle: { color: 0xffc0d0, radius: 55 },
  eggLamp: { color: 0xffe6b0, radius: 90 },
  cityLamp: { color: 0xffe6b0, radius: 95 },
  streetLight: { color: 0xffe6b0, radius: 105 },
  boxoLantern: { color: 0xffa64a, radius: 70 }, // lit jack-o'-lantern
};

/** The night layer. Owns an offscreen light-map (a dark mask with light-holes
 *  erased into it) and lays it over the world so unlit = dark, lit = true daytime
 *  colour, never glare. It's a child of `world`, added before the label/cursor
 *  layers so those stay above the darkness.
 *
 *  Lights (`this.lights`) are positioned in WORLD coordinates — the same as the
 *  farm — and rendered into the map at their on-screen positions each frame.
 *  Toggle `.visible`; call `update(renderer, world)` every frame from the loop. */
export class NightLayer extends Container {
  // Lights live here, OFF the display tree — they're rendered into the map only.
  readonly lights = new Container();
  private darkness = new Graphics();
  private maskScene = new Container(); // darkness + lights, rendered to the texture
  private rt: RenderTexture;
  private display = new Sprite(); // shows the light-map over the world
  private worldM = new Matrix();
  private sw = 0;
  private sh = 0;

  constructor() {
    super();
    // Unit rect, rescaled to the screen each frame so the mask always fills view.
    this.darkness.rect(0, 0, 1, 1).fill({ color: NIGHT_MASK, alpha: NIGHT_MASK_ALPHA });
    this.maskScene.addChild(this.darkness, this.lights);
    this.rt = RenderTexture.create({ width: 2, height: 2 });
    this.display.texture = this.rt;
    this.addChild(this.display);
    this.visible = false;
  }

  /** Rebuild the light-map for this frame and lay it screen-aligned over the farm.
   *  `world` is the camera container; lights inside `this.lights` are world-space. */
  update(renderer: Renderer, world: Container) {
    if (!this.visible) return;
    const sw = Math.max(2, Math.ceil(renderer.screen.width));
    const sh = Math.max(2, Math.ceil(renderer.screen.height));
    if (sw !== this.sw || sh !== this.sh) {
      this.rt.resize(sw, sh, renderer.resolution);
      this.darkness.scale.set(sw, sh); // unit rect -> full screen
      this.sw = sw;
      this.sh = sh;
    }

    // World -> screen transform (camera has translate + uniform scale, no rotation).
    const sx = world.scale.x, sy = world.scale.y;
    const m = this.worldM;
    m.a = sx; m.b = 0; m.c = 0; m.d = sy;
    m.tx = world.position.x - sx * world.pivot.x;
    m.ty = world.position.y - sy * world.pivot.y;

    // Render the lights at their on-screen positions: give the lights holder the
    // camera transform (its children are world-space), so they land on the mask
    // where they sit on the farm.
    this.lights.setFromMatrix(m);
    renderer.render({ container: this.maskScene, target: this.rt, clear: true });

    // Lay the (screen-sized) map back over the screen. This layer is a child of
    // `world`, so counter the camera transform to pin the map to the viewport.
    this.display.setFromMatrix(m.clone().invert());
  }
}
