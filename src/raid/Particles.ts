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

const rand = (v: number) => (Math.random() * 2 - 1) * v;

export class ParticleField {
  readonly container = new Container();
  private tex = softDotTexture();
  private pool: P[] = [];

  /** Emit a one-shot burst of `cfg` at (x,y). `scale` trims the count (per-hit dust
   *  wants far fewer than the source's maxParticles); `rainbow` recolours per
   *  particle (confetti). */
  burst(cfg: ParticleConfig, x: number, y: number, scale = 1, rainbow = false) {
    const live = this.pool.reduce((n, p) => n + (p.live ? 1 : 0), 0);
    const want = Math.max(1, Math.round(cfg.maxParticles * scale));
    const n = Math.min(want, MAX_LIVE - live);
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
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.live = false;
        p.sp.visible = false;
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
    for (const p of this.pool) if (!p.live) return p;
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
