import { Container, Graphics } from "pixi.js";
import { SLOT_MASK } from "./mutations";
import { maskIntersect } from "./mutationMask";

export type SpecialHeadFxKind = "kindle" | "flame" | "confetti" | "plasma" | "sparkle";

const SPECIAL_HEAD_FX: Readonly<Record<string, SpecialHeadFxKind>> = {
  ZombieActorHeadlessTier2: "kindle",
  ZombieActorHeadlessTier3: "flame",
  ZombieActorHeadlessTier4: "confetti",
  // The Obsidian tier (tools/obsidian_zombies.py): the Plasmahead's head IS a plasma
  // orb, and the Zomchantress is ringed by twinkling sparkles.
  ZombieActorHeadlessTier6: "plasma",
  ZombieActorGirlTier6: "sparkle",
};

/** Effects that stand in for a missing head, and so yield to a head mutation.
 *  Sparkles decorate a zombie that still has its own head, so they stay. */
const REPLACES_HEAD: ReadonlySet<SpecialHeadFxKind> = new Set(["kindle", "flame", "confetti", "plasma"]);

// Headless rigs store neck=(0, 0), so use their visible shoulder opening.
const HEAD_X = 5;
const HEAD_Y = -51;
const AURA_ORB_RADIUS = 9.5 * 0.8;
const CONFETTI_COLORS = [0xf94144, 0xf9c74f, 0x43aa8b, 0x577590, 0xe36bae, 0xf3722c];

/** The looping effect that stands in for this species' missing head — unless a head
 *  mutation has taken the slot. A Pumpking IS the zombie's head, so a Flamehead
 *  wearing one shows the pumpkin instead of a flame where its head would be. */
export function specialHeadFxKind(key: string, mutation = 0): SpecialHeadFxKind | null {
  const kind = SPECIAL_HEAD_FX[key] ?? null;
  if (kind && REPLACES_HEAD.has(kind) && maskIntersect(mutation, SLOT_MASK.head) !== 0) return null;
  return kind;
}

interface ConfettiPiece {
  graphic: Graphics;
  age: number;
  life: number;
  vx: number;
  vy: number;
  spin: number;
}

interface AuraMote {
  graphic: Graphics;
  age: number;
  life: number;
  vx: number;
  vy: number;
  phase: number;
}

type AuraKind = "kindle" | "flame" | "plasma";

const AURA_COLORS: Record<AuraKind, { core: number; mote: number }> = {
  kindle: { core: 0xff5151, mote: 0x5268ff },
  flame: { core: 0x5862ef, mote: 0xff665e },
  plasma: { core: 0xbe50ff, mote: 0xffc8ff },
};

// Plasma arcs: short jagged bolts from the orb's centre, re-rolled a few times a
// second so the orb crackles. Deterministic per zombie is not needed — nothing reads it.
const PLASMA_ARCS = 6;
const PLASMA_ARC_REROLL_S = 0.09;

// Sparkles: four-point stars that grow, twinkle and fade at random spots around the
// Zomchantress's head and shoulders. Centred on her head; the spread is rig units.
const SPARKLE_X = 4;
const SPARKLE_Y = -50;
const SPARKLE_COUNT = 6;
const SPARKLE_SPREAD_X = 24;
const SPARKLE_SPREAD_Y = 30;

interface Sparkle {
  graphic: Graphics;
  age: number;
  life: number;
}

/** Actor-local looping effects for zombies whose animation is their head. */
export class SpecialHeadFx {
  readonly container = new Container();
  readonly kind: SpecialHeadFxKind;
  private time = 0;
  private auraMotes: AuraMote[] = [];
  private confetti: ConfettiPiece[] = [];
  private arcs: Graphics | null = null;
  private arcTimer = 0;
  private sparkles: Sparkle[] = [];

  constructor(kind: SpecialHeadFxKind) {
    this.kind = kind;
    this.container.position.set(HEAD_X, HEAD_Y);
    this.container.zIndex = 6;
    if (kind === "confetti") this.buildConfetti();
    else if (kind === "sparkle") this.buildSparkles();
    else this.buildAura(kind);
  }

  private buildAura(kind: AuraKind) {
    const { core, mote } = AURA_COLORS[kind];
    // Concentric translucent discs approximate the soft-edged constant orb from
    // the source art without requiring a dedicated bitmap or an expensive filter.
    const halo = new Graphics().circle(0, 0, 15).fill({ color: core, alpha: 0.10 });
    const glow = new Graphics().circle(0, 0, 12).fill({ color: core, alpha: 0.18 });
    const orb = new Graphics().circle(0, 0, AURA_ORB_RADIUS).fill({ color: core, alpha: 0.58 });
    this.container.addChild(halo, glow, orb);

    const moteCount = 9;
    for (let i = 0; i < moteCount; i++) {
      const radius = 2 + (i % 3);
      const graphic = new Graphics().circle(0, 0, radius).fill({ color: mote, alpha: 0.45 });
      const particle: AuraMote = { graphic, age: 0, life: 1, vx: 0, vy: 0, phase: 0 };
      this.auraMotes.push(particle);
      // Motes sit behind the stable core and remain visible through its alpha.
      this.container.addChildAt(graphic, 0);
      this.resetAuraMote(particle, i / moteCount);
    }
    if (kind === "plasma") {
      // A white-hot centre and the crackling arcs, in front of the violet core.
      this.arcs = new Graphics();
      const heart = new Graphics().circle(0, 0, AURA_ORB_RADIUS * 0.55).fill({ color: 0xfff0ff, alpha: 0.95 });
      this.container.addChild(this.arcs, heart);
      this.drawArcs();
    }
  }

  private drawArcs() {
    const arcs = this.arcs!;
    arcs.clear();
    for (let i = 0; i < PLASMA_ARCS; i++) {
      let angle = (i / PLASMA_ARCS) * Math.PI * 2 + Math.random() * 0.8;
      arcs.moveTo(0, 0);
      for (let step = 1; step <= 3; step++) {
        angle += (Math.random() - 0.5) * 1.1;
        const r = step * 4 + Math.random() * 1.5;
        arcs.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
    }
    arcs.stroke({ width: 1.2, color: AURA_COLORS.plasma.mote, alpha: 0.9 });
  }

  private buildSparkles() {
    this.container.position.set(SPARKLE_X, SPARKLE_Y);
    // In front of the whole rig: the sparkles float over her hair and dress.
    this.container.zIndex = 50;
    for (let i = 0; i < SPARKLE_COUNT; i++) {
      const r = 3 + (i % 3);
      const w = r * 0.25;
      const graphic = new Graphics()
        .circle(0, 0, r * 1.3).fill({ color: 0xf0c8ff, alpha: 0.35 })
        .poly([0, -r, w, -w, r, 0, w, w, 0, r, -w, w, -r, 0, -w, -w]).fill({ color: 0xfff5ff });
      const sparkle: Sparkle = { graphic, age: 0, life: 1 };
      this.sparkles.push(sparkle);
      this.container.addChild(graphic);
      this.resetSparkle(sparkle, i / SPARKLE_COUNT);
    }
  }

  private resetSparkle(sparkle: Sparkle, progress = 0) {
    sparkle.life = 0.7 + Math.random() * 0.6;
    sparkle.age = progress * sparkle.life;
    sparkle.graphic.position.set(
      (Math.random() * 2 - 1) * SPARKLE_SPREAD_X,
      (Math.random() * 2 - 1) * SPARKLE_SPREAD_Y,
    );
    sparkle.graphic.rotation = Math.random() * 0.6 - 0.3;
  }

  private resetAuraMote(mote: AuraMote, progress = 0) {
    const index = this.auraMotes.indexOf(mote);
    mote.life = 0.8 + (index % 4) * 0.16;
    mote.age = progress * mote.life;
    mote.phase = index * 2.31;
    mote.vx = Math.cos(mote.phase) * (5 + (index % 3) * 3);
    mote.vy = -10 - (index % 3) * 4;
    mote.graphic.position.set(
      Math.sin(mote.phase) * 8 + mote.vx * mote.age,
      3 + mote.vy * mote.age,
    );
  }

  private buildConfetti() {
    for (let i = 0; i < 9; i++) {
      const graphic = new Graphics().rect(-2, -1, 4, 2).fill(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      const piece: ConfettiPiece = { graphic, age: 0, life: 1, vx: 0, vy: 0, spin: 0 };
      this.confetti.push(piece);
      this.container.addChild(graphic);
      this.resetConfetti(piece, i / 9);
    }
  }

  private resetConfetti(piece: ConfettiPiece, progress = 0) {
    const index = this.confetti.indexOf(piece);
    const phase = index * 2.399;
    piece.life = 0.9 + (index % 4) * 0.12;
    piece.age = progress * piece.life;
    piece.vx = Math.cos(phase) * (12 + (index % 3) * 5);
    piece.vy = -28 - (index % 4) * 5;
    piece.spin = (index % 2 ? 1 : -1) * (4 + (index % 3));
    piece.graphic.position.set(piece.vx * piece.age, piece.vy * piece.age + 30 * piece.age * piece.age);
    piece.graphic.rotation = phase + piece.spin * piece.age;
    piece.graphic.alpha = 1;
  }

  update(dt: number) {
    this.time += dt;
    if (this.kind === "sparkle") {
      for (const sparkle of this.sparkles) {
        sparkle.age += dt;
        if (sparkle.age >= sparkle.life) this.resetSparkle(sparkle);
        // Grow in, flash, shrink out: one sine hump across the sparkle's life.
        const hump = Math.sin((sparkle.age / sparkle.life) * Math.PI);
        sparkle.graphic.scale.set(0.2 + hump * 0.8);
        sparkle.graphic.alpha = hump;
      }
      return;
    }
    if (this.arcs) {
      this.arcTimer += dt;
      if (this.arcTimer >= PLASMA_ARC_REROLL_S) {
        this.arcTimer = 0;
        this.drawArcs();
      }
    }
    if (this.kind !== "confetti") {
      for (const mote of this.auraMotes) {
        mote.age += dt;
        if (mote.age >= mote.life) this.resetAuraMote(mote);
        const progress = mote.age / mote.life;
        mote.graphic.x += (mote.vx + Math.sin(this.time * 5 + mote.phase) * 5) * dt;
        mote.graphic.y += mote.vy * dt;
        mote.graphic.alpha = Math.sin(progress * Math.PI) * 0.55;
        const scale = 0.75 + Math.sin(progress * Math.PI) * 0.45;
        mote.graphic.scale.set(scale);
      }
      return;
    }

    for (const piece of this.confetti) {
      piece.age += dt;
      if (piece.age >= piece.life) this.resetConfetti(piece);
      const t = piece.age;
      piece.graphic.x += piece.vx * dt;
      piece.graphic.y += (piece.vy + 60 * t) * dt;
      piece.graphic.rotation += piece.spin * dt;
      piece.graphic.alpha = Math.min(1, (piece.life - piece.age) / 0.22);
    }
  }
}
