import { Container, Graphics } from "pixi.js";

export type SpecialHeadFxKind = "kindle" | "flame" | "confetti";

const SPECIAL_HEAD_FX: Readonly<Record<string, SpecialHeadFxKind>> = {
  ZombieActorHeadlessTier2: "kindle",
  ZombieActorHeadlessTier3: "flame",
  ZombieActorHeadlessTier4: "confetti",
};

// Headless rigs store neck=(0, 0), so use their visible shoulder opening.
const HEAD_X = 5;
const HEAD_Y = -51;
const CONFETTI_COLORS = [0xf94144, 0xf9c74f, 0x43aa8b, 0x577590, 0xe36bae, 0xf3722c];

export function specialHeadFxKind(key: string): SpecialHeadFxKind | null {
  return SPECIAL_HEAD_FX[key] ?? null;
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

const AURA_COLORS: Record<"kindle" | "flame", { core: number; mote: number }> = {
  kindle: { core: 0xff5151, mote: 0x5268ff },
  flame: { core: 0x5862ef, mote: 0xff665e },
};

/** Actor-local looping effects for zombies whose animation is their head. */
export class SpecialHeadFx {
  readonly container = new Container();
  readonly kind: SpecialHeadFxKind;
  private time = 0;
  private auraMotes: AuraMote[] = [];
  private confetti: ConfettiPiece[] = [];

  constructor(kind: SpecialHeadFxKind) {
    this.kind = kind;
    this.container.position.set(HEAD_X, HEAD_Y);
    this.container.zIndex = 6;
    if (kind === "confetti") this.buildConfetti();
    else this.buildAura(kind);
  }

  private buildAura(kind: "kindle" | "flame") {
    const { core, mote } = AURA_COLORS[kind];
    // Concentric translucent discs approximate the soft-edged constant orb from
    // the source art without requiring a dedicated bitmap or an expensive filter.
    const halo = new Graphics().circle(0, 0, 15).fill({ color: core, alpha: 0.10 });
    const glow = new Graphics().circle(0, 0, 12).fill({ color: core, alpha: 0.18 });
    const orb = new Graphics().circle(0, 0, 9.5).fill({ color: core, alpha: 0.58 });
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
