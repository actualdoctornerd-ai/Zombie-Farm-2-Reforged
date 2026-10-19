import { describe, expect, it } from "vitest";
import type { PlaceableDef } from "./assets";
import { Field } from "./Field";
import { TILE_H, TILE_W } from "./iso";
import { COST_BARRIER, COST_GATE_CLOSED, COST_GATE_OPEN, COST_GROUND, COST_PATH, COST_POND } from "./pathCosts";
import { findPath } from "./pathfind";

// Same trick as Field.objectWork.test.ts: skip the Pixi constructor, since only the
// occupancy bookkeeping matters for what a tile costs to walk on.
const def = (key: string, tileW = 1, tileH = 1) =>
  ({ key, tileW, tileH, movable: true, rotations: 1 }) as unknown as PlaceableDef;

interface Placed { key: string; oc: number; or: number; tileW?: number; tileH?: number }

function makeField(placed: Placed[], overhangs: Record<string, string[]> = {}, w = 20, h = 20) {
  const field: Field = Object.create(Field.prototype);
  const objects = new Map<string, unknown>();
  const tileObject = new Map<string, string>();
  const pathObject = new Map<string, Set<string>>();
  placed.forEach((p, i) => {
    const id = `o${i}`;
    const d = def(p.key, p.tileW ?? 1, p.tileH ?? 1);
    objects.set(id, { id, def: d, oc: p.oc, or: p.or, flipped: false });
    const w = p.tileW ?? 1, h = p.tileH ?? 1;
    for (let r = p.or; r < p.or + h; r++) for (let c = p.oc; c < p.oc + w; c++) {
      const k = `${c},${r}`;
      const inset = /hedge/i.test(p.key) ? (h >= 4 ? (r === p.or || r === p.or + h - 1) : w >= 4 ? (c === p.oc || c === p.oc + w - 1) : false) : false;
      if (!inset) tileObject.set(k, id);
      let owners = pathObject.get(k);
      if (!owners) pathObject.set(k, (owners = new Set()));
      owners.add(id);
    }
  });
  const fenceBlock = new Map<string, Set<string>>();
  for (const [tile, ids] of Object.entries(overhangs)) fenceBlock.set(tile, new Set(ids));
  // Every lazily-derived cache starts empty. `Object.create` skips the class field
  // initializers that would otherwise do this, and an `undefined` here is not the same
  // as a `null`: the getters test for null, so leaving one out makes that getter answer
  // `undefined` forever instead of computing anything.
  Object.assign(field, {
    w, h, objects, tileObject, pathObject, tilePlot: new Map(), reserved: new Set(), fenceBlock, portals: null, paths: null, walkOpts: null,
  });
  return field;
}

// Put an object down the way placeObject does, as far as the occupancy bookkeeping
// this file models goes — and ring the same bell it rings.
function place(field: Field, p: Placed, id: string) {
  const inner = field as unknown as {
    objects: Map<string, unknown>;
    tileObject: Map<string, string>;
    pathObject: Map<string, Set<string>>;
    topologyChanged(): void;
  };
  const d = def(p.key, p.tileW ?? 1, p.tileH ?? 1);
  inner.objects.set(id, { id, def: d, oc: p.oc, or: p.or, flipped: false });
  const w = p.tileW ?? 1, h = p.tileH ?? 1;
  for (let r = p.or; r < p.or + h; r++) for (let c = p.oc; c < p.oc + w; c++) {
    const k = `${c},${r}`;
    const inset = /hedge/i.test(p.key) ? (h >= 4 ? (r === p.or || r === p.or + h - 1) : w >= 4 ? (c === p.oc || c === p.oc + w - 1) : false) : false;
    if (!inset) inner.tileObject.set(k, id);
    let owners = inner.pathObject.get(k);
    if (!owners) inner.pathObject.set(k, (owners = new Set()));
    owners.add(id);
  }
  inner.topologyChanged();
}

describe("Field.tileCost", () => {
  it("prices bare ground, paths, ponds and solid objects", () => {
    const field = makeField([
      { key: "roadStraight", oc: 2, or: 2, tileW: 2, tileH: 2 },
      { key: "pond1", oc: 6, or: 6, tileW: 3, tileH: 3 },
      { key: "mausoleum3", oc: 10, or: 10, tileW: 3, tileH: 3 },
    ]);

    expect(field.tileCost(0, 0)).toBe(COST_GROUND);
    expect(field.tileCost(3, 3)).toBe(COST_PATH);
    expect(field.tileCost(7, 7)).toBe(COST_POND);
    expect(field.tileCost(11, 11)).toBe(Infinity);
    expect(field.tileCost(-1, 0)).toBe(Infinity); // off the field
  });

  it("makes a hedge crossable but never somewhere to be", () => {
    const field = makeField([{ key: "hedge_01", oc: 4, or: 4 }]);

    expect(field.tileCost(4, 4)).toBe(COST_BARRIER);
    expect(field.isPassable(4, 4)).toBe(true); // the old blocker trapped zombies
    expect(field.isOpenGround(4, 4)).toBe(false);
    // A pond, by contrast, is somewhere a walker may perfectly well end up.
    const pond = makeField([{ key: "pond1", oc: 4, or: 4 }]);
    expect(pond.isOpenGround(4, 4)).toBe(true);
  });

  it("lets long hedge ends overlap while keeping both full hedge footprints in pathfinding", () => {
    const field = makeField([]);
    const hedge = def("hedge_01", 1, 5);
    place(field, { key: "hedge_01", oc: 5, or: 5, tileW: 1, tileH: 5 }, "first");
    // The second hedge starts two tiles before the first ends. Their soft ends
    // overlap, but their central placement hitboxes remain separate.
    expect(field.canPlaceObject(5, 8, hedge)).toBe(true);
    place(field, { key: "hedge_01", oc: 5, or: 8, tileW: 1, tileH: 5 }, "second");
    for (let row = 5; row <= 12; row++)
      expect(field.tileCost(5, row), `hedge path cost at row ${row}`).toBe(COST_BARRIER);
    expect(field.pathOptions().cost?.(5, 5)).toBe(COST_BARRIER);
    expect(field.canPlaceObject(5, 7, def("smallStatue"))).toBe(false);
    const opts = field.pathOptions();
    const path = findPath({ col: 4, row: 8 }, { col: 6, row: 8 },
      (c, r) => field.isPassable(c, r), opts);
    expect(path.length).toBeGreaterThan(0);
    expect(path.some(({ col, row }) => field.tileCost(col, row) >= COST_BARRIER)).toBe(false);
  });

  it("charges a fence panel's overhang at the fence's own price", () => {
    // The panel bridges into (5,4) without owning it for placement.
    const field = makeField([{ key: "pen_01", oc: 4, or: 4 }], { "5,4": ["o0"] });
    expect(field.tileCost(5, 4)).toBe(COST_BARRIER);
    expect(field.isOpenGround(5, 4)).toBe(false);
  });

  it("does not let a neighbouring fence seal the gate it butts against", () => {
    // Every fence run ends at its gate, overhanging the gate's tile so the posts
    // meet. If the overhang won, the door would cost as much as the wall.
    const field = makeField(
      [{ key: "pen_01", oc: 4, or: 4 }, { key: "fenceGate_01_open", oc: 5, or: 4 }],
      { "5,4": ["o0"] },
    );
    expect(field.tileCost(5, 4)).toBe(COST_GATE_OPEN);
    expect(field.isOpenGround(5, 4)).toBe(true);

    const shut = makeField(
      [{ key: "pen_01", oc: 4, or: 4 }, { key: "fenceGate_01_closed", oc: 5, or: 4 }],
      { "5,4": ["o0"] },
    );
    expect(shut.tileCost(5, 4)).toBe(COST_GATE_CLOSED);
  });
});

describe("a fence panel blocks what it is drawn on", () => {
  // The rail is about two tiles wide and bridges into the next tile along, so the
  // panel is BOTH centred on and blocks that pair. Getting the two out of step is
  // what let walkers stroll through a fence line that looked perfectly solid.
  const FENCE = {
    key: "pen_01", tileW: 1, tileH: 1, nativeW: 68, nativeH: 76,
    collideExtend: [{ dc: 0, dr: 1 }],
  } as unknown as PlaceableDef;

  // The tiles a panel at (oc,or) holds against movement, in placement order.
  const blocked = (oc: number, or: number, flipped: boolean) => {
    const field = makeField([]);
    const inner = field as unknown as {
      extensionTiles(d: PlaceableDef, c: number, r: number, f: boolean): string[];
    };
    return [`${oc},${or}`, ...inner.extensionTiles(FENCE, oc, or, flipped)];
  };

  it("bridges along the row axis unflipped, and the col axis mirrored", () => {
    // The rail's own axis — the same one the 1x5 gates run along. Pointing the
    // overhang at the OTHER one puts the extra collision beside the fence instead of
    // along it, which is both a phantom wall and a gap in the real one.
    expect(blocked(5, 5, false)).toEqual(["5,5", "5,6"]);
    expect(blocked(5, 5, true)).toEqual(["5,5", "6,5"]);
  });

  it("stands its posts on the lattice corners either end of that pair", () => {
    // The panel is a wall segment on the EDGE between two tiles, not a thing standing
    // on one, and the half-tile drop is what lands its posts on the corners of that
    // edge. Everything meeting everything else — run to run, corner, run to gate —
    // rests on all of them landing on the same lattice, so this pins the drop and
    // the post positions it produces.
    const field = makeField([]);
    const inner = field as unknown as {
      objectRenderY(d: PlaceableDef, y: number): number;
      footprintAnchor(c: number, r: number, w: number, h: number): { x: number; y: number };
    };
    const base = inner.footprintAnchor(5, 5, 1, 1);
    const y = inner.objectRenderY(FENCE, base.y);
    expect(y - base.y).toBeCloseTo(TILE_H / 2, 6);

    // Post centres measured off pen_01.png: art x=10 and x=58 of 68, bases y=75/51
    // of 76, drawn bottom-centred at (base.x, y) and scaled to our tile.
    const s = TILE_W / 48;
    const w = 68 * s;
    const post = (artX: number, artY: number) => {
      const px = base.x - w / 2 + artX * s;
      const py = y - (76 - artY) * s;
      const half = px / (TILE_W / 2);
      const sum = py / (TILE_H / 2) - 1;
      return { col: (half + sum) / 2, row: (sum - half) / 2 };
    };
    const far = post(58, 51);
    const near = post(10, 75);
    expect(far.col).toBeCloseTo(5.5, 1);
    expect(far.row).toBeCloseTo(4.5, 1);   // the corner one row BEFORE the panel
    expect(near.col).toBeCloseTo(5.5, 1);
    expect(near.row).toBeCloseTo(6.5, 1);  // and one row after its overhang
  });

  it("seals a run laid every other tile, which still looks solid", () => {
    // The rail is wide enough that a spaced run reads as one unbroken fence, so the
    // collision underneath has to be unbroken too or walkers go through the gaps.
    const placed: Placed[] = [];
    const overhangs: Record<string, string[]> = {};
    for (let i = 0; i < 5; i++) {
      const r = 4 + i * 2;
      placed.push({ key: "pen_01", oc: 6, or: r });
      overhangs[`6,${r + 1}`] = [`o${i}`];
    }
    const field = makeField(placed, overhangs);
    for (let r = 4; r <= 13; r++) {
      expect(field.isOpenGround(6, r), `gap at 6,${r}`).toBe(false);
    }
  });
});

describe("Field wormhole links", () => {
  it("links a placed pair both ways, over every tile of each pad", () => {
    const field = makeField([
      { key: "spaceWormHoleA", oc: 3, or: 3, tileW: 1, tileH: 2 },
      { key: "spaceWormHoleB", oc: 14, or: 15, tileW: 2, tileH: 1 },
    ]);

    // Either tile of A comes out at B's origin, and B comes back to A's.
    expect(field.portalExit(3, 3)).toEqual({ col: 14, row: 15 });
    expect(field.portalExit(3, 4)).toEqual({ col: 14, row: 15 });
    expect(field.portalExit(14, 15)).toEqual({ col: 3, row: 3 });
    expect(field.portalExit(15, 15)).toEqual({ col: 3, row: 3 });
    expect(field.portalExit(0, 0)).toBeNull();
    // The pad is walkable ground — you have to be able to step onto it.
    expect(field.tileCost(3, 3)).toBe(COST_GROUND);
  });

  it("leaves an unpaired pad inert, and withholds the portal edge entirely", () => {
    const field = makeField([{ key: "spaceWormHoleA", oc: 3, or: 3, tileW: 1, tileH: 2 }]);
    expect(field.portalExit(3, 3)).toBeNull();
    // No `portal` option means the search keeps its heuristic on a farm with no
    // working wormholes on it.
    expect(field.pathOptions().portal).toBeUndefined();
  });

  it("pairs two of each into two separate links, not one junction", () => {
    const field = makeField([
      { key: "spaceWormHoleA", oc: 1, or: 1 },
      { key: "spaceWormHoleA", oc: 9, or: 1 },
      { key: "spaceWormHoleB", oc: 1, or: 9 },
      { key: "spaceWormHoleB", oc: 9, or: 9 },
    ]);

    expect(field.portalExit(1, 1)).toEqual({ col: 1, row: 9 });
    expect(field.portalExit(9, 1)).toEqual({ col: 9, row: 9 });
    expect(field.portalExit(1, 9)).toEqual({ col: 1, row: 1 });
    expect(field.portalExit(9, 9)).toEqual({ col: 9, row: 1 });
    expect(field.pathOptions().portal).toBeTypeOf("function");
  });
});

describe("what is derived from placement is dropped when placement changes", () => {
  // Three things are held rather than recomputed: the wormhole links, the has-a-path
  // flag, and the search options built out of both. They are held because they are read
  // constantly — a wandering zombie asks for the options once per candidate destination,
  // for every unit on the farm — which makes all three exactly as correct as their
  // invalidation. `topologyChanged` is the single funnel every add / move / rotate /
  // remove passes through, so this is the whole guarantee in one test.
  it("rebuilds the links, the path flag and the options after a placement", () => {
    const field = makeField([{ key: "spaceWormHoleA", oc: 3, or: 3 }]);
    // Read all three FIRST, so each cache is warm before the farm changes underneath it.
    expect(field.hasPaths()).toBe(false);
    expect(field.portalExit(3, 3)).toBeNull();
    expect(field.pathOptions().portal).toBeUndefined();

    place(field, { key: "spaceWormHoleB", oc: 9, or: 9 }, "pad");
    place(field, { key: "roadStraight", oc: 5, or: 5 }, "road");

    expect(field.hasPaths()).toBe(true);
    expect(field.portalExit(3, 3)).toEqual({ col: 9, row: 9 });
    expect(field.pathOptions().portal).toBeTypeOf("function");
  });

  it("hands every walker the same options while the farm holds still", () => {
    // The point of holding them. Nothing may write to the shared object — the farmer's
    // `crossBarriers` is spread into a copy of it, never set on it.
    const field = makeField([]);
    expect(field.pathOptions()).toBe(field.pathOptions());
  });
});
