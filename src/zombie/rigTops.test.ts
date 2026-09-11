// The hand-labelled rig tops (public/assets/zombie/tops.json), checked against the
// rigs they describe.
//
// Like clips.json this file is authored by hand in the Rig Studio and nothing
// regenerates it, so a stale key or a line dragged to the wrong side of the art is
// invisible: the runtime guard in RaidActor.getSizingBounds simply ignores a label it
// cannot use, and the zombie goes back to being measured flag and all. The point of a
// label is that it CHANGES the fit, so anything inert is a defect.
// @ts-ignore - node types are test-environment only, as in clipData.test.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyZombieTops, mergeSpecialZombieModel,
  type ZombieDef, type ZombieModel,
} from "../assets";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const has = (p: string) => existsSync(new URL(p, import.meta.url));

const TOPS = "../../public/assets/zombie/tops.json";
type Frame = { x: number; y: number; w: number; h: number };

/** Every rig the game assembles, keyed the way tops.json keys them: the base models
 *  plus each named special merged over its skeleton, exactly as assets.ts does it. */
function assembledModels(): { models: Record<string, ZombieModel>; frames: Record<string, Frame> } {
  const models: Record<string, ZombieModel> = read("../../public/assets/zombie/models.json");
  const frames: Record<string, Frame> = read("../../public/assets/zombie/frames.json");
  const manifests: Record<string, Parameters<typeof mergeSpecialZombieModel>[2]> =
    read("../../public/assets/zombie/special_models.json");
  const specialFrames: Record<string, Frame> =
    read("../../public/assets/zombie/special_frames.json");
  const zombies: ZombieDef[] = read("../../public/assets/zombies.json");
  for (const [key, frame] of Object.entries(specialFrames)) {
    if (key.startsWith("$")) continue; // the sheet stamp, not a part
    const [actor, file] = key.split(/:(.*)/s);
    frames[`special:${actor}:${file}`] = frame;
  }
  for (const z of zombies) {
    const manifest = manifests[z.key];
    if (!manifest) continue;
    const base = models[manifest.base ?? ""]
      ?? models[z.key === "ZombieActorBombie" ? "ZombieActorHeadlessTier1" : "ZombieActorRegularTier1"];
    const assembled = z.key === "ZombieActorBombie" ? { ...manifest, floatingHead: false } : manifest;
    models[z.key] = mergeSpecialZombieModel(
      base, z, assembled, (file) => `special:${z.key}:${file}`,
    );
  }
  return { models, frames };
}

/** The rig's vertical extent in model px, the way the renderer lays the parts out. */
function span(model: ZombieModel, frames: Record<string, Frame>): { top: number; bottom: number } {
  let top = Infinity, bottom = -Infinity;
  for (const part of model.parts) {
    const frame = frames[part.file];
    if (!frame) continue;
    const scale = part.scale ?? 1;
    top = Math.min(top, part.py - part.ay * frame.h * scale);
    bottom = Math.max(bottom, part.py + (1 - part.ay) * frame.h * scale);
  }
  return { top, bottom };
}

describe("hand-labelled rig tops", () => {
  it("ships a table the loader can read", () => {
    expect(has(TOPS), "public/assets/zombie/tops.json is missing").toBe(true);
    const tops = read(TOPS);
    expect(typeof tops).toBe("object");
    expect(Array.isArray(tops)).toBe(false);
  });

  it("labels only real rigs, on a line that actually shrinks the fit", () => {
    const tops: Record<string, unknown> = read(TOPS);
    const { models, frames } = assembledModels();
    const bad: string[] = [];
    for (const [key, top] of Object.entries(tops)) {
      const model = models[key];
      if (!model) { bad.push(`${key}: labelled, but no such zombie rig`); continue; }
      if (typeof top !== "number" || !Number.isFinite(top)) {
        bad.push(`${key}: top is ${JSON.stringify(top)}, not a number`);
        continue;
      }
      const { top: artTop, bottom } = span(model, frames);
      if (!(top > artTop)) {
        bad.push(`${key}: top ${top} is at or above the art (${artTop.toFixed(1)}) — inert`);
      } else if (!(top < bottom)) {
        bad.push(`${key}: top ${top} is at or below the feet (${bottom.toFixed(1)})`);
      }
    }
    expect(bad.join("\n")).toBe("");
  });
});

describe("applyZombieTops", () => {
  const model = (): ZombieModel => ({
    name: "test", neck: { x: 0, y: 0 }, scale: 1, color: [1, 2, 3], parts: [],
  });

  it("writes a label onto the model the raid measures", () => {
    const models = { a: model() };
    applyZombieTops(models, { a: -72 });
    expect(models.a.topY).toBe(-72);
  });

  it("ignores a label for a rig this build does not carry, and junk values", () => {
    const models: Record<string, ZombieModel> = { a: model() };
    expect(() => applyZombieTops(models, {
      gone: -72, a: Number.NaN,
    })).not.toThrow();
    expect(models.gone).toBeUndefined();
    expect(models.a.topY).toBeUndefined();
  });
});
