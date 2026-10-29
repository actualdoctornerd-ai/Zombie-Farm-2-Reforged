// Tapping the Zombie Patch has to put the WHOLE army to bed. Each zombie used to try
// exactly one patch tile and, if the route to it failed, quietly kept wandering — so
// a patch with a fence along one edge left most of the army strolling the farm, and a
// Garden zombie that fertilized mid-nap settled down out in the field instead of
// coming home.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameAssets, ZombieDef } from "../assets";
import type { Field } from "../Field";
import { GameState } from "../GameState";
import { screenToGrid } from "../iso";
import { ZombieField } from "./ZombieField";

const GARDENER = {
  key: "gardener", name: "Garden Zombie", group: "Garden", tier: 5, mutation: 0,
  className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
} as ZombieDef;

const assets = (): GameAssets => ({
  zombieModels: { [GARDENER.key]: { color: [0, 0, 0], neck: { x: 0, y: 0 }, parts: [] } },
  zombiePartTex: {},
  mutationParts: {},
  invasionBubble: undefined,
} as unknown as GameAssets);

type Tile = { col: number; row: number };
const PATCH: Tile[] = [{ col: 9, row: 9 }, { col: 12, row: 9 }];
const PLOT = { col: 2, row: 2 };

/** A 20x20 farm; `blocked` tiles are walls (a fence's footprint, a building). */
const field = (blocked: (c: number, r: number) => boolean): Field => {
  const inBounds = (c: number, r: number) => c >= 0 && r >= 0 && c < 20 && r < 20;
  const open = (c: number, r: number) => inBounds(c, r) && !blocked(c, r);
  return {
    entityLayer: { addChild: () => {}, removeChild: () => {} },
    patchRestTiles: () => PATCH,
    plotFrontSpot: () => ({ x: 0, y: 0 }),
    markFertilized: () => true,
    inBounds,
    isPassable: open,
    isOpenGround: open,
    tileCost: () => 1,
    pathOptions: () => ({ inBounds }),
    zombiePotId: () => null,
    mausoleumId: () => null,
    objectDefOf: () => undefined,
  } as unknown as Field;
};

const farm = (blocked: (c: number, r: number) => boolean, at: Tile[]) => {
  const state = new GameState();
  state.zombieMax = 16;
  const zombies = new ZombieField(
    assets(), field(blocked), state, (key) => (key === GARDENER.key ? GARDENER : undefined)
  );
  zombies.restore(at.map((pos, i) => ({ id: `z${i}`, key: GARDENER.key, pos })) as never);
  return zombies;
};

const tick = (zombies: ZombieField, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) zombies.update(0.016);
};

const tiles = (zombies: ZombieField) => zombies.characterContainers().map(({ position }) => {
  const g = screenToGrid(position.x, position.y);
  return { col: Math.round(g.col), row: Math.round(g.row) };
});

const isPatch = (t: Tile) => PATCH.some((p) => p.col === t.col && p.row === t.row);

afterEach(() => vi.restoreAllMocks());

describe("the Zombie Patch nap", () => {
  it("sends a zombie whose own patch tile is walled off to another patch tile", () => {
    // Tile (9,9) is boxed in on every side; (12,9) is open.
    const wall = (c: number, r: number) =>
      c >= 8 && c <= 10 && r >= 8 && r <= 10 && !(c === 9 && r === 9);
    const zombies = farm(wall, [{ col: 2, row: 15 }, { col: 15, row: 2 }]);
    // z0 is assigned (9,9), the boxed-in tile.

    zombies.toggleGather(PATCH);
    tick(zombies, 20_000);

    expect(tiles(zombies).every(isPatch)).toBe(true);
    expect(zombies.randomBrainBark()).toBeNull(); // every one of them asleep
  });

  it("lies a zombie down where it stands when no patch tile can be reached", () => {
    // A closed ring round the whole patch: nobody outside can get in.
    const ring = (c: number, r: number) =>
      (c >= 7 && c <= 14 && (r === 7 || r === 11)) || ((c === 7 || c === 14) && r >= 7 && r <= 11);
    const zombies = farm(ring, [{ col: 2, row: 15 }]);
    tick(zombies, 2_000);
    const before = tiles(zombies)[0];

    zombies.toggleGather(PATCH);
    tick(zombies, 20_000);

    expect(zombies.randomBrainBark()).toBeNull(); // asleep, not wandering
    expect(tiles(zombies)[0]).toEqual(before);
  });

  it("brings a fertilizing zombie home to any patch tile it can reach", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the tier-5 fertilize roll always wins
    const zombies = farm(() => false, [{ col: 4, row: 4 }]);
    zombies.toggleGather(PATCH);
    tick(zombies, 10_000);
    expect(tiles(zombies).every(isPatch)).toBe(true);

    expect(zombies.tryFertilize(PLOT.col, PLOT.row)).toBe("Garden Zombie");
    tick(zombies, 20_000);

    expect(tiles(zombies).every(isPatch)).toBe(true);
    expect(zombies.randomBrainBark()).toBeNull();
  });

  it("stays awake when the army is woken during a fertilize cast", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const zombies = farm(() => false, [{ col: 4, row: 4 }]);
    zombies.toggleGather(PATCH);
    tick(zombies, 10_000);

    zombies.tryFertilize(PLOT.col, PLOT.row);
    zombies.toggleGather(PATCH); // wake everyone while the cast is still running
    tick(zombies, 20_000);

    expect(zombies.isGathered).toBe(false);
    expect(zombies.randomBrainBark()).not.toBeNull();
  });
});
