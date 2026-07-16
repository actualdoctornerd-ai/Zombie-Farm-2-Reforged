import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { EnemyModel } from "../assets";
import { EnemyActor } from "./EnemyActor";

const arm = (px: number, py: number, back: boolean) => ({
  rx: 0, ry: 0, rw: 1, rh: 1, px, py, ax: 0.5, ay: 0, z: back ? 0 : 1,
  rot: 0, group: "arm" as const, back,
});

describe("EnemyActor pirate attacks", () => {
  it("rotates both Pirate Boss arms around their authored shoulders", () => {
    const model: EnemyModel = {
      parts: [arm(-3, -4, true), arm(3, -4, false)],
      neck: null,
      slam: true,
      shoulder: { x: 2, y: 0 },
      pivots: [{ name: "back-shoulder", x: -2, y: 0 }],
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "PirateStageActorBoss");
    const arms = (actor as unknown as {
      arms: { sp: { x: number; y: number; rotation: number }; back: boolean }[];
    }).arms;

    // u=0.5225 is the top of the raise for a 0.95 damage-timing slam.
    actor.update(0, false, { atkProg: 0.28 + 0.72 * 0.5225, damageTiming: 0.95 });

    for (const a of arms) {
      const pivot = a.back ? { x: -2, y: 0 } : { x: 2, y: 0 };
      expect(a.sp.rotation).toBeCloseTo(-2.5, 5);
      expect(Math.hypot(a.sp.x - pivot.x, a.sp.y - pivot.y)).toBeCloseTo(Math.sqrt(17), 5);
    }
  });

  it("gives the Scallywag club a slower, higher primary-hand wind-up", () => {
    const model: EnemyModel = {
      parts: [arm(3, -4, false)],
      neck: null,
      shoulder: { x: 2, y: 0 },
    };
    const normal = new EnemyActor(Texture.EMPTY, model, "PirateStageActorSwashbuckler");
    const heavy = new EnemyActor(Texture.EMPTY, model, "PirateStageActorScallywag");
    const attack = { atkProg: 0.28 + 0.72 * 0.5, damageTiming: 1 };
    normal.update(0, false, attack);
    heavy.update(0, false, attack);
    const rotation = (actor: EnemyActor) => (actor as unknown as {
      arms: { sp: { rotation: number } }[];
    }).arms[0].sp.rotation;

    expect(rotation(heavy)).toBeGreaterThan(1);
    expect(rotation(heavy)).toBeGreaterThan(rotation(normal));
  });
});
