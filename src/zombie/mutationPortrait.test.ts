import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { GameAssets, ZombieModel } from "../assets";
import { buildZombiePortraitRig } from "./mutationPortrait";

const model: ZombieModel = {
  name: "Test", neck: { x: 2, y: -20 }, scale: 1, color: [100, 120, 140],
  parts: [
    { file: "baseBody", group: "root", px: 0, py: -20, ax: 0.5, ay: 0.5, z: 3, tint: true },
    { file: "baseArmF", group: "root", px: 8, py: -25, ax: 1, ay: 0.5, z: 7, tint: true },
    { file: "face", group: "head", px: 2, py: -30, ax: 0.5, ay: 0.5, z: 10, tint: false },
  ],
};

const assets = {
  zombieModels: { test: model, ZombieActorRegularTier1: model },
  zombiePartTex: {
    baseBody: Texture.EMPTY, baseArmF: Texture.EMPTY, face: Texture.EMPTY,
    tomato: Texture.EMPTY, turnip: Texture.EMPTY, lima: Texture.EMPTY,
  },
  mutationParts: {
    "1": { file: "tomato", group: "head", headRel: true, ox: 1, oy: 4, ax: 0.5, ay: 0.5, z: 4 },
    "8": { file: "turnip", group: "root", headRel: false, ox: 8, oy: 25, ax: 1, ay: 0.5, z: 8, replaces: "armF" },
    "1024": { file: "lima", group: "root", headRel: false, ox: 0, oy: 20, ax: 0.5, ay: 0.5, z: 4, replaces: "body" },
  },
} as unknown as GameAssets;

describe("mutation-aware zombie portraits", () => {
  it("renders every mutation and hides the base parts they replace", () => {
    const rig = buildZombiePortraitRig(assets, "test", 1 | 8 | 1024);
    const children = rig.children as unknown as { label: string; visible: boolean }[];

    expect(children.map((child) => child.label)).toEqual([
      "baseBody", "baseArmF", "face", "tomato", "turnip", "lima",
    ]);
    expect(children.find((child) => child.label === "baseBody")?.visible).toBe(false);
    expect(children.find((child) => child.label === "baseArmF")?.visible).toBe(false);
  });
});
