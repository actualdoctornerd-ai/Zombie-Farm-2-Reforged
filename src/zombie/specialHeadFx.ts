import { Container, Graphics } from "pixi.js";

export type SpecialHeadFxKind = "fire" | "confetti";

const SPECIAL_HEAD_FX: Readonly<Record<string, SpecialHeadFxKind>> = {
  ZombieActorHeadlessTier2: "fire",
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

/** Actor-local looping effects for the two zombies whose animation is their head. */
export class SpecialHeadFx {
  readonly container = new Container();
  readonly kind: SpecialHeadFxKind;
  private time = 0;
  private flames: Graphics[] = [];
  private confetti: ConfettiPiece[] = [];

  constructor(kind: SpecialHeadFxKind) {
    this.kind = kind;
    this.container.position.set(HEAD_X, HEAD_Y);
    this.container.zIndex = 6;
    if (kind === "fire") this.buildFire();
    else this.buildConfetti();
  }

  private buildFire() {
    const outer = new Graphics()
      .moveTo(0, 9).bezierCurveTo(-12, 3, -8, -11, 1, -25)
      .bezierCurveTo(3, -14, 12, -8, 10, 2)
      .bezierCurveTo(9, 8, 4, 11, 0, 9).fill(0xf04a24);
    const middle = new Graphics()
      .moveTo(0, 8).bezierCurveTo(-7, 3, -4, -7, 3, -17)
      .bezierCurveTo(3, -9, 8, -5, 7, 2)
      .bezierCurveTo(6, 7, 2, 9, 0, 8).fill(0xffa51f);
    const inner = new Graphics()
      .moveTo(0, 7).bezierCurveTo(-4, 3, -2, -3, 2, -10)
      .bezierCurveTo(5, -3, 5, 4, 0, 7).fill(0xfff176);
    this.flames = [outer, middle, inner];
    this.container.addChild(...this.flames);
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
    if (this.kind === "fire") {
      this.flames.forEach((flame, i) => {
        const wave = Math.sin(this.time * (9 + i * 1.7) + i * 2.1);
        flame.scale.set(1 + wave * 0.06, 1 - wave * 0.08);
        flame.position.set(wave * (1.2 - i * 0.25), Math.sin(this.time * 12 + i) * 0.7);
        flame.rotation = wave * 0.035;
      });
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
