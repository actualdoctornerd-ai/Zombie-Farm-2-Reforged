// The Video Game Zombie: the "Zombies vs Video Games" invasion's pixel zombie as a
// playable species. Two things make it unlike every other catalog row, and this
// pins both.
//
//  1. It is an ORDINARY zombie with a special's art route. It files under the
//     Market's Normal tab (category "normal"), in the Regular group, with the
//     tier-less Yellow class the Crazy Zombie wears — but it is drawn from the
//     dedicated special-zombie atlas, because its art is authored nowhere on the
//     shared ZombieSheet.
//  2. It is a FLIPBOOK, not a paper doll. Its manifest is complete (no inherited
//     skeleton), holds one sprite, and carries idle/attack frame strips; the rigs
//     swap textures instead of posing bones, and no mutation art can attach.
//
// Its stats are fitted to the prize line at its level 43 — the line the Epic and
// invasion prizes sit on (tools/reforge_economy.py SPECIAL_STAT_REBALANCE) — held a
// little under the Vagabond, the strongest Epic. An elite version is planned above it.
import { describe, expect, it } from "vitest";
// @ts-ignore — node test environment only (the app has no @types/node)
import { existsSync } from "node:fs";
import zombieRows from "../../public/assets/zombies.json";
import specialFrames from "../../public/assets/zombie/special_frames.json";
import specialModels from "../../public/assets/zombie/special_models.json";
import {
  mergeSpecialZombieModel, purchasableZombies, specialZombieFiles,
  type ZombieDef, type ZombieModel,
} from "../assets";
import { almanacEntries, isObtainable, obtainHint } from "./almanac";
import { mutationPartFor } from "./mutationVisual";
import { bitOf } from "./mutations";
import { classify, classTierRank } from "./taxonomy";
import { zombieFarmScale } from "./displayScale";

const KEY = "ZombieActorRegularVideoGame";
const zombies = zombieRows as ZombieDef[];
const row = zombies.find((zombie) => zombie.key === KEY)!;
const crazy = zombies.find((zombie) => zombie.key === "ZombieActorRegularCrazy")!;
const manifest = specialModels[KEY as keyof typeof specialModels] as unknown as {
  complete?: boolean; floatingHead?: boolean; neck: { x: number; y: number };
  color?: [number, number, number];
  parts: Array<{ file: string; group: string; px: number; py: number; ax: number; ay: number; z: number; scale?: number }>;
  flipbook?: { idle: string[]; attack: string[]; fps: number };
};

describe("Video Game Zombie catalog row", () => {
  it("exists and files as an ordinary Regular zombie of the Yellow class", () => {
    expect(row).toBeDefined();
    expect(row.name).toBe("Video Game Zombie");
    expect(row.category).toBe("normal");
    expect(row.group).toBe("Regular");
    expect(row.className).toBe("Yellow");
    expect(row.classColor).toBe(crazy.classColor);
    // The runtime classifier agrees with the baked taxonomy (no Tier token -> Yellow).
    expect(classify(KEY)).toEqual({ group: "Regular", className: "Yellow", classColor: row.classColor });
    // Yellow sees every ability tier, like the Crazy Zombie.
    expect(classTierRank(row.className)).toBe(classTierRank(crazy.className));
    // Same farm silhouette scale as the family it files with.
    expect(zombieFarmScale(row.group, row.className, KEY)).toBe(zombieFarmScale("Regular", "Green", "ZombieActorRegularTier1"));
  });

  it("tops the plantable ladder and sits on the prize line, under the Vagabond", () => {
    expect(row.str).toBeGreaterThan(crazy.str);
    expect(row.dex).toBeGreaterThan(crazy.dex);
    expect(row.con).toBeGreaterThan(crazy.con);
    expect(row.focus).toBe(crazy.focus);
    expect(row.tier).toBe(5);
    // The balance yardstick (see the Zombie Strength Ladder): sqrt(DPS x HP) wearing
    // the five-slot damage set (+9 str, +2 dex, +9 con on a Regular body). The prize
    // line pays 1,500 at level 24 rising 500 over 18 levels; at level 43 that is
    // ~2,028. The owner's brief: ON the line, but at least a bit under the Vagabond.
    const mutated = (z: ZombieDef) =>
      Math.sqrt(500 * (z.str + 9) * (z.dex + 2) * (z.con + 9));
    const vagabond = zombies.find((zombie) => zombie.key === "ZombieActorVagabond")!;
    const line = 1500 + (row.level - 24) * (500 / 18);
    expect(mutated(row)).toBeGreaterThan(line * 0.97);
    expect(mutated(row)).toBeLessThan(mutated(vagabond) * 0.99);
  });

  it("is a plantable Market gravestone, not a sixth permanent special", () => {
    expect(row.rewardOnly).toBe(false);
    expect(row.marketHidden).toBe(false);
    expect(row.brainsNeeded).toBe(true);
    expect(row.cost).toBeGreaterThan(crazy.cost);
    expect(row.level).toBe(43); // the Video Games invasion's own unlock level
    expect(purchasableZombies(zombies).some((zombie) => zombie.key === KEY)).toBe(true);
    expect(purchasableZombies(zombies).filter((zombie) => zombie.category === "special"))
      .not.toContainEqual(expect.objectContaining({ key: KEY }));
  });

  it("appears in the Zombie Almanac as a Market zombie", () => {
    expect(isObtainable(row)).toBe(true);
    const entry = almanacEntries(zombies, {}).find((e) => e.key === KEY);
    expect(entry).toBeDefined();
    const sources = { raidNameById: () => undefined, epicBossNameByQuestId: () => undefined };
    expect(obtainHint(row, sources)).toMatch(/Market gravestone \(level 43, 6 brains\)/);
  });
});

describe("Video Game Zombie art", () => {
  it("ships a complete flipbook manifest whose every frame is on the special atlas", () => {
    expect(row.specialSprite).toBe("video_game_zombie.png");
    expect(manifest.complete).toBe(true);
    expect(manifest.parts).toHaveLength(1);
    // Feet on the origin: bottom edge, roughly centred (the anchor is the idle frame's
    // centre of mass inside the shared box, so it is near but not exactly 0.5).
    expect(manifest.parts[0]).toMatchObject({ group: "root", px: 0, py: 0, ay: 1 });
    expect(manifest.parts[0].ax).toBeGreaterThan(0.4);
    expect(manifest.parts[0].ax).toBeLessThan(0.6);
    expect(manifest.flipbook?.idle).toHaveLength(4);
    expect(manifest.flipbook?.attack).toHaveLength(3);
    expect(manifest.flipbook?.fps).toBeGreaterThan(0);
    expect(manifest.parts[0].file).toBe(manifest.flipbook!.idle[0]);
    const files = specialZombieFiles(manifest as Parameters<typeof specialZombieFiles>[0]);
    expect(files).toHaveLength(7);
    // Every frame is cut to the same box, so swapping them never moves the feet.
    const sizes = new Set(files.map((file) => {
      const frame = specialFrames[`${KEY}:${file}` as keyof typeof specialFrames];
      expect(frame, `${file} is not packed`).toBeDefined();
      return `${frame.w}x${frame.h}`;
    }));
    expect(sizes.size).toBe(1);
    expect(existsSync(new URL(`../../public/assets/zombie/portrait/${KEY}.png`, import.meta.url))).toBe(true);
  });

  it("merges to a single-sprite model that inherits nothing and keeps its strips", () => {
    const base: ZombieModel = {
      name: "Zombie", neck: { x: 7, y: -36 }, scale: 0.9, color: [159, 255, 95],
      parts: [
        { file: "defaultBody", group: "root", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 3, tint: true },
        { file: "defaultHead", group: "head", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 4, tint: true },
      ],
    };
    const model = mergeSpecialZombieModel(
      base, row, manifest as Parameters<typeof mergeSpecialZombieModel>[2], (file) => `special:${KEY}:${file}`,
    );
    expect(model.parts.map((part) => part.file)).toEqual([`special:${KEY}:idle-0.png`]);
    expect(model.parts[0].tint).toBe(false);
    expect(model.flipbook?.idle).toEqual(manifest.flipbook!.idle.map((f) => `special:${KEY}:${f}`));
    expect(model.flipbook?.attack).toEqual(manifest.flipbook!.attack.map((f) => `special:${KEY}:${f}`));
    expect(model.color).toEqual(manifest.color);
    expect(model.scale).toBe(0.9);
  });

  it("hangs no mutation art on a flipbook rig (the stat bonus still applies)", () => {
    const parts = { tomato: { file: "tomatoHead", group: "head", ox: 0, oy: 0, ax: 0.5, ay: 0.5, z: 5 } } as never;
    expect(mutationPartFor(parts, { flipbook: { idle: ["a"], attack: [], fps: 4 } }, bitOf("tomato"))).toBeUndefined();
    expect(mutationPartFor(parts, {}, bitOf("tomato"))?.file).toBe("tomatoHead");
  });
});
