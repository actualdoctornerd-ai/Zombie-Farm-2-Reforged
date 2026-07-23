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
    { file: "defaultEyeL", group: "head", px: -3, py: -10, ax: 0.5, ay: 0.5, z: 5, tint: true },
    { file: "defaultEyeR", group: "head", px: 3, py: -10, ax: 0.5, ay: 0.5, z: 5, tint: true },
    { file: "defaultJaw", group: "head", px: 0, py: -4, ax: 0.5, ay: 0.5, z: 6, tint: true },
    { file: "defaultArmF", group: "root", px: 9, py: -28, ax: 1, ay: 0.25, z: 7, tint: true },
  ],
};

function assets(): GameAssets {
  return {
    zombieModels: { test: model },
    zombiePartTex: {
      defaultArmB: Texture.EMPTY,
      defaultBody: Texture.EMPTY,
      defaultEyeL: Texture.EMPTY,
      defaultEyeR: Texture.EMPTY,
      defaultJaw: Texture.EMPTY,
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

    // Back arm + body + eyes + mutation arm, plus the actor's placeholder feet.
    expect(root.children).toHaveLength(8);
    expect(arms).toHaveLength(2);

    actor.poseArms(1, false, false, 0, 0);
    expect(arms.every((arm) => arm.rotation === -2.5)).toBe(true);
  });

  it("squashes its eyes only while actively focusing", () => {
    const actor = new RaidActor(assets(), "test");
    const eyes = (actor as unknown as { eyes: { sp: { y: number; scale: { y: number } } }[] }).eyes;

    expect(eyes).toHaveLength(2);
    actor.update(1, false, true);
    expect(eyes.every(({ sp }) => sp.scale.y === 0.76)).toBe(true);

    actor.update(1, false, false);
    expect(eyes.every(({ sp }) => sp.scale.y === 1)).toBe(true);
  });

  it("uses the recovered bite head, jaw, eye, and two-arm pose", () => {
    const actor = new RaidActor(assets(), "test");
    const head = (actor as unknown as { headParts: { sp: { x: number } }[] }).headParts;
    const jaws = (actor as unknown as { jaws: { y: number }[] }).jaws;
    const eyes = (actor as unknown as { eyes: { sp: { y: number; scale: { y: number } } }[] }).eyes;
    const arms = (actor as unknown as { arms: { rotation: number }[] }).arms;
    actor.update(0, false);

    // atkProg .38 maps to source time .13: end of headBite's lunge.
    const beforeX = head[0].sp.x;
    const beforeJawY = jaws[0].y;
    const beforeEyeY = eyes[0].sp.y;
    actor.poseArms(0, true, false, 0.38, 0, -1, 0, "ZombieBite");
    expect(head[0].sp.x).toBeLessThan(beforeX - 7);
    expect(jaws[0].y - beforeJawY).toBeGreaterThan(eyes[0].sp.y - beforeEyeY + 1);
    expect(eyes.every(({ sp }) => sp.scale.y < 1)).toBe(true);
    expect(arms.every((arm) => arm.rotation < -1)).toBe(true);
  });

  it("uses the recovered scratch contact pose instead of the generic arm wave", () => {
    const actor = new RaidActor(assets(), "test");
    const head = (actor as unknown as { headParts: { sp: { x: number } }[] }).headParts;
    const arms = (actor as unknown as { arms: { rotation: number }[] }).arms;
    actor.update(0, false);

    // Scratch contact is source time .5, which coincides with atkProg 0/1.
    actor.poseArms(0, true, false, 1, 0, -1, 0, "ZombieScratch");
    expect(head[0].sp.x).toBeLessThan(-3);
    expect(arms[0].rotation).toBeGreaterThan(0.8);
    expect(arms[1].rotation).toBeLessThan(-0.3);
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
