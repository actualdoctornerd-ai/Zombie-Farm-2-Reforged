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

type At = (c: number, r: number) => boolean;
const none: At = () => false;

/** A 20x20 farm; `blocked` tiles are solid (a building), `hedge` tiles are a fence:
 *  walkable, but a barrier the pathfinder only crosses when told to. */
const field = (blocked: At, hedge: At = none): Field => {
  const inBounds = (c: number, r: number) => c >= 0 && r >= 0 && c < 20 && r < 20;
  const passable = (c: number, r: number) => inBounds(c, r) && !blocked(c, r);
  const open = (c: number, r: number) => passable(c, r) && !hedge(c, r);
  const cost = (c: number, r: number) => (!passable(c, r) ? Infinity : hedge(c, r) ? 10000 : 1);
  return {
    entityLayer: { addChild: () => {}, removeChild: () => {} },
    patchRestTiles: () => PATCH,
    plotFrontSpot: () => ({ x: 0, y: 0 }),
    markFertilized: () => true,
    inBounds,
    isPassable: passable,
    isOpenGround: open,
    tileCost: cost,
    pathOptions: () => ({ inBounds, cost, avoidCost: 100 }),
    zombiePotId: () => null,
    mausoleumId: () => null,
    objectDefOf: () => undefined,
  } as unknown as Field;
};

const farm = (blocked: At, at: Tile[], hedge: At = none) => {
  const state = new GameState();
  state.zombieMax = 16;
  const zombies = new ZombieField(
    assets(), field(blocked, hedge), state, (key) => (key === GARDENER.key ? GARDENER : undefined)
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

  it("brings the army through the hedge round a fenced-in patch", () => {
    // Player report: on a patch inside a sealed fence only the zombies already in the
    // pen went to it; everyone outside lay down out in the field.
    const ring = (c: number, r: number) =>
      (c >= 7 && c <= 14 && (r === 7 || r === 11)) || ((c === 7 || c === 14) && r >= 7 && r <= 11);
    const zombies = farm(none, [{ col: 2, row: 15 }, { col: 17, row: 2 }, { col: 10, row: 9 }], ring);

    zombies.toggleGather(PATCH);
    tick(zombies, 30_000);

    expect(tiles(zombies).every(isPatch)).toBe(true);
    expect(zombies.randomBrainBark()).toBeNull();
  });

  it("follows the patch when it is moved mid-nap, and wakes when it is gone", () => {
    // Player report: zombies asleep in the middle of a field. Moving the patch (or
    // storing it, or applying a farm layout) left the army asleep where it had been.
    const zombies = farm(none, [{ col: 2, row: 15 }, { col: 15, row: 2 }]);
    const field = (zombies as unknown as { field: { patchRestTiles: () => Tile[] | null; topologyVersion: number } }).field;
    field.topologyVersion = 1;
    zombies.toggleGather(PATCH);
    tick(zombies, 20_000);
    expect(tiles(zombies).every(isPatch)).toBe(true);

    const moved: Tile[] = [{ col: 3, row: 3 }, { col: 4, row: 3 }];
    field.patchRestTiles = () => moved;
    field.topologyVersion++;
    tick(zombies, 20_000);
    expect(tiles(zombies).every((t) => moved.some((m) => m.col === t.col && m.row === t.row))).toBe(true);
    expect(zombies.randomBrainBark()).toBeNull();

    field.patchRestTiles = () => null;
    field.topologyVersion++;
    tick(zombies, 100);
    expect(zombies.isGathered).toBe(false);
    expect(zombies.randomBrainBark()).not.toBeNull();
  });

  it("leaves a sleeping army alone when something else is placed", () => {
    const zombies = farm(none, [{ col: 2, row: 15 }]);
    const field = (zombies as unknown as { field: { topologyVersion: number } }).field;
    field.topologyVersion = 1;
    zombies.toggleGather(PATCH);
    tick(zombies, 20_000);
    const before = tiles(zombies);

    field.topologyVersion++; // a fence went down somewhere; the patch did not move
    tick(zombies, 5_000);

    expect(tiles(zombies)).toEqual(before);
    expect(zombies.isGathered).toBe(true);
  });

  it("climbs out of a field walled in by solid decor", () => {
    // Player report: a crop field bordered with flower beds walled in every zombie
    // harvested inside it; they lay down in the field, after a multi-second freeze.
    // Here a closed ring of solid objects encloses the zombie, the patch outside it.
    const ring = (c: number, r: number) =>
      (c >= 1 && c <= 6 && (r === 1 || r === 6)) || ((c === 1 || c === 6) && r >= 1 && r <= 6);
    const zombies = farm(ring, [{ col: 3, row: 3 }]);

    zombies.toggleGather(PATCH);
    tick(zombies, 30_000);

    expect(tiles(zombies).every(isPatch)).toBe(true);
    expect(zombies.randomBrainBark()).toBeNull();
  });

  it("goes round a wall it can go round rather than over it", () => {
    // An open-ended wall between the zombie and the patch: walking round is cheaper
    // than any climb, so the route never enters a solid tile.
    const wall = (c: number, r: number) => c === 6 && r >= 3 && r <= 16;
    const zombies = farm(wall, [{ col: 2, row: 9 }]);
    const unit = (zombies as unknown as { units: { walker: { route?: unknown } }[] }).units[0];
    zombies.toggleGather(PATCH);
    const visited: Tile[] = [];
    for (let elapsed = 0; elapsed < 30_000; elapsed += 16) {
      zombies.update(0.016);
      visited.push(tiles(zombies)[0]);
    }
    expect(unit).toBeDefined();
    expect(tiles(zombies).every(isPatch)).toBe(true);
    expect(visited.some((t) => wall(t.col, t.row))).toBe(false);
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
