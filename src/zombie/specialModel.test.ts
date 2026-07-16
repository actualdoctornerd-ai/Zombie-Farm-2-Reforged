import { describe, expect, it } from "vitest";
import { mergeSpecialZombieModel, type ZombieDef, type ZombieModel } from "../assets";

const base: ZombieModel = {
  name: "Zombie",
  neck: { x: 7, y: -36 },
  scale: 0.9,
  color: [159, 255, 95],
  parts: [
    { file: "defaultArmB", group: "root", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 0, tint: true },
    { file: "defaultBody", group: "root", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 3, tint: true },
    { file: "defaultHead", group: "head", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 4, tint: true },
    { file: "defaultArmF", group: "root", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 7, tint: true },
  ],
};

const skittles = {
  key: "ZombieActorSkittles",
  name: "Skittles Zombie",
  group: "Regular",
} as ZombieDef;

describe("named special-zombie model assembly", () => {
  it("replaces an authored slot while retaining inherited anatomy", () => {
    const model = mergeSpecialZombieModel(base, skittles, {
      name: "skittles_zombie",
      neck: { x: 0, y: 0 },
      color: [120, 240, 80],
      parts: [
        { file: "Body.png", group: "root", px: 8, py: -14, ax: 0.63, ay: 0.66, z: 3, scale: 0.8 },
      ],
    }, (file) => `special:${file}`);

    expect(model.parts.map((part) => part.file)).toEqual([
      "defaultArmB", "special:Body.png", "defaultHead", "defaultArmF",
    ]);
    expect(model.parts.find((part) => part.file === "special:Body.png")?.scale).toBe(0.8);
    expect(model.parts.find((part) => part.file === "special:Body.png")?.tint).toBe(false);
    expect(model.color).toEqual([120, 240, 80]);
  });

  it("keeps an explicitly floating-head actor free of inherited body parts", () => {
    const model = mergeSpecialZombieModel(base, { ...skittles, group: "Headless" }, {
      name: "bombie",
      neck: { x: 2, y: -4 },
      floatingHead: true,
      parts: [{ file: "Head.png", group: "head", px: 2, py: -4, ax: 0.5, ay: 0.5, z: 4 }],
    }, (file) => `special:${file}`);

    expect(model.parts.map((part) => part.file)).toEqual(["special:Head.png"]);
    expect(model.neck).toEqual({ x: 2, y: -4 });
  });

  it("moves inherited facial slots with a replacement head", () => {
    const model = mergeSpecialZombieModel(base, skittles, {
      name: "tall-head",
      neck: { x: 10, y: -44 },
      parts: [{ file: "Head.png", group: "head", px: 10, py: -44, ax: 0.5, ay: 0.5, z: 4 }],
    }, (file) => `special:${file}`);

    const inheritedHeadPart = model.parts.find((part) => part.file === "defaultHead");
    expect(inheritedHeadPart).toBeUndefined();
    // Add a default facial slot to prove it follows the +3/-8 neck delta.
    const faceBase = {
      ...base,
      parts: [...base.parts, {
        file: "defaultEyeL", group: "head" as const, px: -19, py: -49,
        ax: 0.5, ay: 0.5, z: 5, tint: true,
      }],
    };
    const withFace = mergeSpecialZombieModel(faceBase, skittles, {
      name: "tall-head",
      neck: { x: 10, y: -44 },
      parts: [{ file: "Head.png", group: "head", px: 10, py: -44, ax: 0.5, ay: 0.5, z: 4 }],
    }, (file) => `special:${file}`);
    expect(withFace.parts.find((part) => part.file === "defaultEyeL")).toMatchObject({ px: -16, py: -57 });
  });
});
