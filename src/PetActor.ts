import { Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";
import type { PetAnimationDef, PetDef } from "./assets";
import { BASE } from "./base";
import { setFootprint } from "./depthSort";
import { screenToGrid, tileCenter } from "./iso";

export interface PetPenBounds { oc: number; or: number; tileW: number; tileH: number }

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
  private penTarget: { col: number; row: number } | null = null;
  private penPause = 0;

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

  /** Cosmetic pen movement. Targets stay one tile inside the fence and are joined
   * by straight lines inside the pen's convex isometric footprint. */
  updateInPen(dt: number, bounds: PetPenBounds) {
    const minCol = bounds.oc + 1, maxCol = bounds.oc + bounds.tileW - 2;
    const minRow = bounds.or + 1, maxRow = bounds.or + bounds.tileH - 2;
    const current = screenToGrid(this.container.x, this.container.y);
    const outside = !this.initialized || current.col < minCol - 0.5 || current.col > maxCol + 0.5 ||
      current.row < minRow - 0.5 || current.row > maxRow + 0.5;
    if (outside) {
      const col = minCol + Math.random() * Math.max(0, maxCol - minCol);
      const row = minRow + Math.random() * Math.max(0, maxRow - minRow);
      const start = tileCenter(col, row);
      this.container.position.set(start.x, start.y);
      this.initialized = true;
      this.penTarget = null;
      this.penPause = 0.5 + Math.random() * 2;
    }

    if (this.penPause > 0) {
      this.penPause -= dt;
      this.setState(false);
    } else {
      if (!this.penTarget) {
        this.penTarget = {
          col: minCol + Math.random() * Math.max(0, maxCol - minCol),
          row: minRow + Math.random() * Math.max(0, maxRow - minRow),
        };
      }
      const target = tileCenter(this.penTarget.col, this.penTarget.row);
      const dx = target.x - this.container.x, dy = target.y - this.container.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining < 2) {
        this.penTarget = null;
        this.penPause = 1.5 + Math.random() * 4;
        this.setState(false);
      } else {
        this.setState(true);
        const step = Math.min(remaining, Math.max(35, this.def.walkingSpeed * 45) * dt);
        this.container.x += dx / remaining * step;
        this.container.y += dy / remaining * step;
        if (Math.abs(dx) > 0.1) this.sprite.scale.x = Math.abs(this.def.scale) * (dx > 0 ? -1 : 1);
      }
    }

    this.advanceAnimation(dt);
    const grid = screenToGrid(this.container.x, this.container.y);
    // The pen is one transparent-center sprite. Sort occupants behind it so the
    // near rails naturally occlude their feet while they remain visible inside.
    setFootprint(this.container, Math.round(grid.col), Math.round(grid.row),
      Math.round(grid.col), Math.round(grid.row), -100);
  }

  private advanceAnimation(dt: number) {
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
  }

  destroy() {
    this.container.removeFromParent();
    this.container.destroy({ children: true });
    for (const frame of this.frames) frame.destroy(false);
  }
}
