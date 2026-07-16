import { Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";
import type { PetAnimationDef, PetDef } from "./assets";
import { BASE } from "./base";
import { setFootprint } from "./depthSort";
import { screenToGrid } from "./iso";

/** Cosmetic-only farm companion. It follows world coordinates and never enters
 * collision, pathfinding, combat, quest, or economy systems. */
export class PetActor {
  readonly container = new Container();
  private readonly sprite: Sprite;
  private readonly frames: Texture[];
  private animation: PetAnimationDef;
  private frame = 0;
  private frameTime = 0;
  private moving = false;
  private initialized = false;
  private lastFarmerX = 0;
  private lastFarmerY = 0;
  private trailX = -1;
  private trailY = 0;

  private constructor(readonly def: PetDef, strip: Texture) {
    this.frames = Array.from({ length: def.sheet.frameCount }, (_, index) => new Texture({
      source: strip.source,
      frame: new Rectangle(index * def.sheet.cellWidth, 0, def.sheet.cellWidth, def.sheet.cellHeight),
    }));
    this.animation = this.pick("idle");
    this.sprite = new Sprite(this.frames[this.animation.frames[0] ?? 0]);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.scale.set(def.scale);
    const [r, g, b] = def.color;
    this.sprite.tint = (r << 16) | (g << 8) | b;
    this.container.addChild(this.sprite);
  }

  static async load(def: PetDef): Promise<PetActor> {
    const strip = await Assets.load(`${BASE}assets/pets/${def.sheet.file}`) as Texture;
    return new PetActor(def, strip);
  }

  private pick(state: "idle" | "move"): PetAnimationDef {
    const choices = this.def.states[state] ?? [];
    const total = choices.reduce((sum, choice) => sum + Math.max(0, choice.probability), 0);
    let roll = Math.random() * Math.max(1, total);
    let name = choices[0]?.animation;
    for (const choice of choices) {
      roll -= Math.max(0, choice.probability);
      if (roll <= 0) { name = choice.animation; break; }
    }
    name ??= Object.keys(this.def.animations)[0];
    const selected = this.def.animations[name];
    if (!selected?.frames.length) return { frames: [0], frameSeconds: 0.15 };
    return selected;
  }

  private setState(moving: boolean) {
    if (this.moving === moving && this.animation.frames.length) return;
    this.moving = moving;
    this.animation = this.pick(moving ? "move" : "idle");
    this.frame = 0;
    this.frameTime = 0;
  }

  update(dt: number, farmerX: number, farmerY: number) {
    if (!this.initialized) {
      this.lastFarmerX = farmerX;
      this.lastFarmerY = farmerY;
      const [ox, oy] = this.def.playerOffset;
      this.container.position.set(farmerX + ox, farmerY + oy);
      this.initialized = true;
    }

    const fdx = farmerX - this.lastFarmerX;
    const fdy = farmerY - this.lastFarmerY;
    const farmerStep = Math.hypot(fdx, fdy);
    if (farmerStep > 0.1) {
      this.trailX = -fdx / farmerStep;
      this.trailY = -fdy / farmerStep;
    }
    this.lastFarmerX = farmerX;
    this.lastFarmerY = farmerY;

    const distance = Math.max(28, Math.hypot(...this.def.playerOffset));
    const targetX = farmerX + this.trailX * distance;
    const targetY = farmerY + this.trailY * distance + 6;
    const dx = targetX - this.container.x;
    const dy = targetY - this.container.y;
    const remaining = Math.hypot(dx, dy);
    const shouldMove = remaining > 5;
    this.setState(shouldMove);
    if (shouldMove) {
      const step = Math.min(remaining, Math.max(90, this.def.walkingSpeed * 80) * dt);
      this.container.x += dx / remaining * step;
      this.container.y += dy / remaining * step;
      if (Math.abs(dx) > 0.1) this.sprite.scale.x = Math.abs(this.def.scale) * (dx > 0 ? -1 : 1);
    }

    this.frameTime += dt;
    const seconds = Math.max(0.025, this.animation.frameSeconds);
    while (this.frameTime >= seconds) {
      this.frameTime -= seconds;
      this.frame++;
      if (this.frame >= this.animation.frames.length) {
        this.animation = this.pick(this.moving ? "move" : "idle");
        this.frame = 0;
      }
    }
    this.sprite.texture = this.frames[this.animation.frames[this.frame] ?? 0];
    const grid = screenToGrid(this.container.x, this.container.y);
    const col = Math.round(grid.col), row = Math.round(grid.row);
    setFootprint(this.container, col, row, col, row, 0.4);
  }

  destroy() {
    this.container.removeFromParent();
    this.container.destroy({ children: true });
    for (const frame of this.frames) frame.destroy(false);
  }
}
