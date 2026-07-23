import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { GameAssets, ZombieModel } from "../assets";
import { RaidActor } from "./RaidActor";

const model: ZombieModel = {
  name: "Test Zombie",
  neck: { x: 0, y: 0 },
  scale: 1,
  color: [255, 255, 255],
  parts: [
    { file: "defaultArmB", group: "root", px: -3, py: -25, ax: 1, ay: 0.25, z: 0, tint: true },
    { file: "defaultBody", group: "root", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 3, tint: true },
    { file: "defaultArmF", group: "root", px: 9, py: -28, ax: 1, ay: 0.25, z: 7, tint: true },
  ],
};

function assets(): GameAssets {
  return {
    zombieModels: { test: model },
    zombiePartTex: {
      defaultArmB: Texture.EMPTY,
      defaultBody: Texture.EMPTY,
      defaultArmF: Texture.EMPTY,
      turnipArm: Texture.EMPTY,
    },
    mutationParts: {
      "8": { file: "turnipArm", group: "root", headRel: false, ox: 0, oy: 28, ax: 1, ay: 0.28, z: 8 },
    },
  } as unknown as GameAssets;
}

describe("RaidActor mutation rendering", () => {
  it("replaces the normal front arm and animates the mutation arm", () => {
    const actor = new RaidActor(assets(), "test", 8);
    const root = (actor as unknown as { root: { children: unknown[] } }).root;
    const arms = (actor as unknown as { arms: { rotation: number }[] }).arms;

    // Back arm + body + mutation arm, plus the actor's two placeholder feet.
    expect(root.children).toHaveLength(5);
    expect(arms).toHaveLength(2);

    actor.poseArms(1, false, false, 0, 0);
    expect(arms.every((arm) => arm.rotation === -2.5)).toBe(true);
  });

  it("raises healing arms forward from rest to overhead, then resets", () => {
    const actor = new RaidActor(assets(), "test");
    const arms = (actor as unknown as { arms: { rotation: number }[] }).arms;

    actor.poseArms(0, false, false, 0, 0);
    expect(arms.every((arm) => arm.rotation === -1.5)).toBe(true);

    actor.poseArms(0, false, false, 0, 0, -1, 0.5);
    expect(arms.every((arm) => arm.rotation === 0)).toBe(true);

    actor.poseArms(0, false, false, 0, 0, -1, 1);
    expect(arms.every((arm) => arm.rotation === 1.5)).toBe(true);

    actor.poseArms(0, false, false, 0, 0);
    expect(arms.every((arm) => arm.rotation === -1.5)).toBe(true);
  });
});
