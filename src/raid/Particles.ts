// A compact player for the game's cocos2d "Particle Designer" configs
// (data/json/particles/*.json, gravity mode / emitterType 0). We don't emulate the
// full spec — just the gravity-mode fields the raid effects use: a burst of
// particles with per-particle direction/speed, constant gravity, a size and colour
// lerp over life, and optional spin. Enough for melee-impact dust and victory
// confetti. cocos2d is y-UP; screen is y-DOWN, so vy and gravity-y are negated.
import { Container, Sprite, Texture } from "pixi.js";

export interface ParticleConfig {
  maxParticles: number;
  angle: number; angleVariance: number;
  speed: number; speedVariance: number;
  gravityx: number; gravityy: number;
  particleLifespan: number; particleLifespanVariance: number;
  startParticleSize: number; finishParticleSize: number;
  sourcePositionVariancex: number; sourcePositionVariancey: number;
  startColorRed: number; startColorGreen: number; startColorBlue: number; startColorAlpha: number;
  finishColorAlpha: number;
  rotatePerSecond: number;
  blendFuncDestination: number; // 1 (GL_ONE) => additive glow (sparks); else normal
}

interface P {
  sp: Sprite;
  x: number; y: number; vx: number; vy: number; gx: number; gy: number;
  age: number; life: number; size0: number; size1: number;
  r: number; g: number; b: number; a0: number; a1: number; spin: number; live: boolean;
}

const MAX_LIVE = 600; // hard cap so a flurry of hits can't runaway
const CONFETTI_HUES = [0xf94144, 0xf9c74f, 0x90be6d, 0x577590, 0x43aa8b, 0xf3722c, 0xe36bae];

/** A soft radial-gradient dot, drawn once to a canvas and reused for every particle. */
function softDotTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.55, "rgba(255,255,255,0.75)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  return Texture.from(c);
}

/** A small soft leaf silhouette (a pointed ellipse with a midrib), drawn once and
 *  reused. Reproduces the source's `leafFX.png` for the fertilize effect; tinted
 *  per-particle to the yellow-green fertilize colour. */
export function leafTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  // Pointed-oval leaf (tip up, base down) with soft edges.
  g.translate(16, 16);
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.beginPath();
  g.moveTo(0, -14);
  g.quadraticCurveTo(11, -3, 0, 14);
  g.quadraticCurveTo(-11, -3, 0, -14);
  g.fill();
  // Midrib: a faint darker line so it reads as a leaf, not a blob.
  g.strokeStyle = "rgba(0,0,0,0.25)";
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(0, -12);
  g.lineTo(0, 12);
  g.stroke();
  return Texture.from(c);
}

/** A single cherry blossom petal: a rounded wedge with the notched tip a sakura
 *  petal has, drawn once and reused. Tinted per-particle like every other texture
 *  here, so the blossom pink lives in the config rather than in the art.
 *
 *  The notch is the whole point — an un-notched petal at this size is a pink oval,
 *  indistinguishable from the soft dot, and a screen of them reads as snow. */
export function petalTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.translate(16, 16);
  g.fillStyle = "rgba(255,255,255,0.96)";
  g.beginPath();
  // Narrow base at the bottom, flaring out to a wide tip at the top...
  g.moveTo(0, 13);
  g.bezierCurveTo(-10, 6, -11, -6, -6, -12);
  // ...where the two lobes meet in a shallow V.
  g.lineTo(0, -7);
  g.lineTo(6, -12);
  g.bezierCurveTo(11, -6, 10, 6, 0, 13);
  g.fill();
  // A touch of shading down the fold, so a tumbling petal still has a front and a
  // back rather than flashing as a flat shape.
  g.strokeStyle = "rgba(0,0,0,0.16)";
  g.lineWidth = 1.1;
  g.beginPath();
  g.moveTo(0, 11);
  g.lineTo(0, -6);
  g.stroke();
  return Texture.from(c);
}

/** A five-pointed star, drawn once and reused — the source's `starFX.png`, which is
 *  what `stun.plist` emits over a stunned actor's head. Drawn rather than loaded for
 *  the same reason the leaf and petal are: the extracted PNG is premultiplied twice
 *  (see the premultiplied-alpha note in the art pipeline) and would carry a dark rim
 *  against the additive-ish yellow the config tints it. Tinted per-particle like
 *  every other texture here, so the colour stays in the config. */
export function starTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.translate(16, 16);
  g.rotate(-Math.PI / 2); // point up
  const OUTER = 15;
  const INNER = 6.2;
  g.fillStyle = "rgba(255,255,255,1)";
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? OUTER : INNER;
    const a = (i * Math.PI) / 5;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  // A thin darker outline so a pale star still reads against the bright stage art
  // (the stars land over heads, which are the busiest part of the frame).
  g.strokeStyle = "rgba(0,0,0,0.3)";
  g.lineWidth = 1.1;
  g.stroke();
  return Texture.from(c);
}

const rand = (v: number) => (Math.random() * 2 - 1) * v;

export class ParticleField {
  readonly container = new Container();
  private tex: Texture;
  private pool: P[] = [];
  private liveCount = 0; // running total so burst() doesn't rescan the pool
  private cursor = 0; // rolling free-slot scan start, so acquire() is O(1) amortised

  /** `texture` overrides the default soft radial dot (e.g. a leaf for the farm's
   *  fertilize effect). It is still tinted per-particle by the config's colour. */
  constructor(texture?: Texture) {
    this.tex = texture ?? softDotTexture();
  }

  /** Emit a one-shot burst of `cfg` at (x,y). `scale` trims the count (per-hit dust
   *  wants far fewer than the source's maxParticles); `rainbow` recolours per
   *  particle (confetti). */
  burst(cfg: ParticleConfig, x: number, y: number, scale = 1, rainbow = false) {
    const want = Math.max(1, Math.round(cfg.maxParticles * scale));
    const n = Math.min(want, MAX_LIVE - this.liveCount);
    const additive = cfg.blendFuncDestination === 1;
    for (let i = 0; i < n; i++) {
      const dir = (cfg.angle + rand(cfg.angleVariance)) * (Math.PI / 180);
      const spd = cfg.speed + rand(cfg.speedVariance);
      const life = Math.max(0.15, cfg.particleLifespan + rand(cfg.particleLifespanVariance));
      let r = cfg.startColorRed, g = cfg.startColorGreen, b = cfg.startColorBlue;
      if (rainbow) {
        const c = CONFETTI_HUES[(Math.random() * CONFETTI_HUES.length) | 0];
        r = ((c >> 16) & 0xff) / 255; g = ((c >> 8) & 0xff) / 255; b = (c & 0xff) / 255;
      }
      const p = this.acquire();
      p.x = x + rand(cfg.sourcePositionVariancex);
      p.y = y + rand(cfg.sourcePositionVariancey);
      p.vx = Math.cos(dir) * spd;
      p.vy = -Math.sin(dir) * spd; // y-up -> y-down
      p.gx = cfg.gravityx;
      p.gy = -cfg.gravityy;
      p.age = 0; p.life = life;
      p.size0 = cfg.startParticleSize; p.size1 = cfg.finishParticleSize;
      p.r = r; p.g = g; p.b = b;
      p.a0 = cfg.startColorAlpha; p.a1 = cfg.finishColorAlpha;
      p.spin = cfg.rotatePerSecond * (Math.PI / 180) + (rainbow ? rand(6) : 0);
      p.sp.tint = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
      p.sp.blendMode = additive ? "add" : "normal";
      p.sp.rotation = rainbow ? Math.random() * Math.PI : 0;
      p.sp.visible = true;
      p.live = true;
      this.liveCount++;
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.live = false;
        p.sp.visible = false;
        this.liveCount--;
        continue;
      }
      const t = p.age / p.life;
      p.vx += p.gx * dt;
      p.vy += p.gy * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const size = p.size0 + (p.size1 - p.size0) * t;
      const fade = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1; // ease out over the last 30%
      p.sp.position.set(p.x, p.y);
      p.sp.scale.set(size / 32);
      p.sp.alpha = (p.a0 + (p.a1 - p.a0) * t) * fade;
      p.sp.rotation += p.spin * dt;
    }
  }

  private acquire(): P {
    // Scan from a rolling cursor instead of the pool head: a 140-particle burst
    // against a warmed 600-slot pool would otherwise walk ~84k slots in one frame.
    const len = this.pool.length;
    for (let i = 0; i < len; i++) {
      const p = this.pool[(this.cursor + i) % len];
      if (!p.live) {
        this.cursor = (this.cursor + i + 1) % len;
        return p;
      }
    }
    const sp = new Sprite(this.tex);
    sp.anchor.set(0.5);
    this.container.addChild(sp);
    const p: P = {
      sp, x: 0, y: 0, vx: 0, vy: 0, gx: 0, gy: 0, age: 0, life: 1,
      size0: 8, size1: 8, r: 1, g: 1, b: 1, a0: 1, a1: 1, spin: 0, live: false,
    };
    this.pool.push(p);
    return p;
  }
}
