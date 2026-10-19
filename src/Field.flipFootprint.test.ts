import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { PlaceableDef } from "./assets";
import { Field, objectFootprint } from "./Field";
import { gridToScreen, HW } from "./iso";

// Turning a long decor used to leave an invisible barrier lying across the diagonal
// it USED to run down: the art mirrored but the footprint did not, so a 1x5 hedge
// turned to run east-west still blocked five tiles running north-south. Nothing
// square ever showed it (371 of the 460 placeables are square), which is why it sat
// in the game for so long. See objectFootprint for why the mirror is a transpose.
//
// Same trick as Field.objectWork.test.ts: skip the Pixi constructor and hand the
// Field only the bookkeeping these paths touch.
const HEDGE = {
  key: "hedge_01", name: "Hedge", category: "decor",
  sprite: "hedge_01.png", tileW: 1, tileH: 5,
  nativeW: 153, nativeH: 114,
} as unknown as PlaceableDef;

const TILE = { key: "daisy", name: "Daisy", category: "decor", sprite: "daisy.png", tileW: 1, tileH: 1 } as unknown as PlaceableDef;

const makeField = (w = 12, h = 12): Field => {
  const field: Field = Object.create(Field.prototype);
  Object.assign(field, {
    w, h,
    plots: new Map(),
    tilePlot: new Map(),
    reserved: new Set(),
    tileObject: new Map(),
    pathObject: new Map(),
    fenceBlock: new Map(),
    objects: new Map(),
    nextObjId: 1,
    entityLayer: new Container(),
    groundObjectLayer: new Container(),
    objectLights: new Container(),
    assets: { field: { tileW: 48 }, objects: { "hedge_01.png": Texture.EMPTY, "daisy.png": Texture.EMPTY } },
  });
  return field;
};

/** Every tile still blocked for movement by an object, as "col,row". */
const blocked = (field: Field): string[] =>
  [...(field as unknown as { pathObject: Map<string, Set<string>> }).pathObject.keys()].sort();

const footprintOf = (oc: number, or: number, w: number, h: number): string[] => {
  const out: string[] = [];
  for (let r = or; r < or + h; r++) for (let c = oc; c < oc + w; c++) out.push(`${c},${r}`);
  return out.sort();
};

describe("objectFootprint", () => {
  it("transposes a turned object and leaves a square one alone", () => {
    expect(objectFootprint({ tileW: 1, tileH: 5 }, false)).toEqual({ w: 1, h: 5 });
    expect(objectFootprint({ tileW: 1, tileH: 5 }, true)).toEqual({ w: 5, h: 1 });
    expect(objectFootprint({ tileW: 3, tileH: 3 }, true)).toEqual({ w: 3, h: 3 });
  });
});

describe("Field: a turned object blocks the tiles it is drawn over", () => {
  it("claims the transposed footprint, not the one it was authored with", () => {
    const field = makeField();
    expect(field.placeObject(HEDGE, 3, 3, "hedge", undefined, 1)).toBe("hedge");
    expect(blocked(field)).toEqual(footprintOf(3, 3, 5, 1));
  });

  it("frees the tiles the old footprint used to steal", () => {
    const field = makeField();
    field.placeObject(HEDGE, 3, 3, "hedge", undefined, 1);
    // (3,7) is the far end of the run the UNTURNED hedge would have covered — the
    // invisible barrier from the report. A glow flower goes there now.
    expect(field.canPlaceObject(3, 7, TILE)).toBe(true);
    expect(field.placeObject(TILE, 3, 7, "flower")).toBe("flower");
    // The soft end can overlap for placement, while the hedge keeps blocking the
    // whole run for movement.
    expect(field.canPlaceObject(7, 3, TILE)).toBe(true);
    expect(field.placeObject(TILE, 7, 3, "flower")).toBe("flower");
    expect((field as unknown as { pathObject: Map<string, Set<string>> })
      .pathObject.get("7,3")?.has("hedge")).toBe(true);
  });

  it("mirrors the art about the origin tile, so art and footprint agree", () => {
    const field = makeField();
    field.placeObject(HEDGE, 3, 3, "straight");
    const straight = (field as unknown as { objects: Map<string, { sprite: Sprite }> })
      .objects.get("straight")!.sprite.x;
    field.removeObject("straight");
    field.placeObject(HEDGE, 3, 3, "turned", undefined, 1);
    const turned = (field as unknown as { objects: Map<string, { sprite: Sprite }> })
      .objects.get("turned")!.sprite.x;
    // The mirror line is the origin tile's own centre — the same reflection the
    // footprint transpose is, so the sprite lands over its blocked tiles.
    const originX = gridToScreen(3, 3).x;
    expect(turned - originX).toBeCloseTo(originX - straight, 5);
    expect(turned).toBeCloseTo(originX + 2 * HW, 5); // 1x5 turned: centre 2 tiles east
  });

  it("rejects a placement whose turned footprint runs off the farm", () => {
    const field = makeField(6, 6);
    // 5 tiles of run fit going south from (2,0) but not going east.
    expect(field.canPlaceObject(2, 0, HEDGE)).toBe(true);
    expect(field.canPlaceObject(2, 0, HEDGE, undefined, true)).toBe(false);
  });
});

describe("Field.moveObject / flipObject", () => {
  it("re-claims the transposed tiles when a carried object is turned on drop", () => {
    const field = makeField();
    field.placeObject(HEDGE, 3, 3, "hedge");
    expect(blocked(field)).toEqual(footprintOf(3, 3, 1, 5));
    expect(field.moveObject("hedge", 3, 3, 1)).toBe(true);
    expect(blocked(field)).toEqual(footprintOf(3, 3, 5, 1));
  });

  it("refuses a turn with no room and leaves the occupancy untouched", () => {
    const field = makeField();
    field.placeObject(HEDGE, 3, 3, "hedge");
    field.placeObject(TILE, 6, 3, "wall"); // sits across the turned hedge's path
    const before = blocked(field);
    expect(field.flipObject("hedge")).toBe(false);
    expect(!!field.objectTurnOf("hedge")).toBe(false);
    expect(blocked(field)).toEqual(before);
  });

  it("turns in place when there is room", () => {
    const field = makeField();
    field.placeObject(HEDGE, 3, 3, "hedge");
    expect(field.flipObject("hedge")).toBe(true);
    expect(!!field.objectTurnOf("hedge")).toBe(true);
    expect(blocked(field)).toEqual(footprintOf(3, 3, 5, 1));
  });
});

describe("Field.restoreObjects with a pre-transpose save", () => {
  const resolve = (key: string) => (key === HEDGE.key ? HEDGE : undefined);

  it("nudges a turned object back inside the farm rather than dropping it", () => {
    const field = makeField(6, 6);
    // Legal when it was saved (1 wide, 5 deep from column 5); its real turned
    // footprint now needs columns 5..9, which a 6-wide farm does not have.
    field.restoreObjects([{ id: "hedge", key: "hedge_01", oc: 5, or: 0, rotation: 1 }], resolve);
    expect(field.objectOriginOf("hedge")).toEqual({ oc: 1, or: 0 });
    expect(!!field.objectTurnOf("hedge")).toBe(true);
  });

  it("gives up the turn before it gives up the object", () => {
    const field = makeField(3, 8); // no row anywhere can hold a 5-wide run
    field.restoreObjects([{ id: "hedge", key: "hedge_01", oc: 1, or: 1, rotation: 1 }], resolve);
    expect(field.objectOriginOf("hedge")).toEqual({ oc: 1, or: 1 });
    expect(!!field.objectTurnOf("hedge")).toBe(false);
  });
});

// A road bend does not turn by mirroring: in iso a mirror swaps the two grid axes, so
// it maps a bend's arms onto each other and hands back the SAME corner, redrawn from a
// mirrored pivot a few pixels out of line. The source authored the corners as separate
// tiles, so turning one steps through its `turns` instead — see ROAD_TURNS in
// tools/prep_placeables.py and Field.flatTile.test.ts for the geometry.
const BEND = {
  key: "roadBend_01", name: "Road Bend", category: "decor", sprite: "bend0.png",
  tileW: 2, tileH: 2, nativeW: 133, nativeH: 58, flatTile: true, anchorX: 0.3, anchorY: 0.17,
  turns: [
    { sprite: "bend0.png", nativeW: 133, nativeH: 58, anchorX: 0.3, anchorY: 0.17 },
    { sprite: "bend1.png", nativeW: 133, nativeH: 58, anchorX: 0.31, anchorY: 0.06, dr: -1 },
    { sprite: "bend2.png", nativeW: 112, nativeH: 70, anchorX: 0.21, anchorY: 0.12 },
    { sprite: "bend2.png", nativeW: 112, nativeH: 70, anchorX: 0.21, anchorY: 0.12, flip: true },
  ],
} as unknown as PlaceableDef;

const bendField = (): Field => {
  const field = makeField();
  const assets = (field as unknown as { assets: { objects: Record<string, Texture> } }).assets;
  for (const t of BEND.turns!) assets.objects[t.sprite] = Texture.EMPTY;
  return field;
};
const spriteOf = (field: Field, id: string) =>
  (field as unknown as { objects: Map<string, { sprite: Sprite; def: PlaceableDef }> })
    .objects.get(id)!.sprite;

describe("Field: turning a road bend", () => {
  it("steps through all four corners and back, without moving the block", () => {
    const field = bendField();
    field.placeObject(BEND, 3, 3, "bend");
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect(field.flipObject("bend")).toBe(true);
      seen.push(field.objectTurnOf("bend"));
      // The corner changes; the 2x2 the player put down does not.
      expect(blocked(field)).toEqual(footprintOf(3, 3, 2, 2));
    }
    expect(seen).toEqual([1, 2, 3, 0]);
  });

  it("draws the corner it is turned to, not a mirror of the first", () => {
    const field = bendField();
    field.placeObject(BEND, 3, 3, "bend");
    const at = () => {
      const s = spriteOf(field, "bend");
      return { x: Math.round(s.x * 100) / 100, mirrored: s.scale.x < 0 };
    };
    const corners = [at()];
    for (let i = 0; i < 3; i++) { field.flipObject("bend"); corners.push(at()); }
    // Four distinct placements, and only the fourth is drawn mirrored — the corner
    // the source never authored. The old behaviour was four mirrors of one sprite.
    expect(corners.map((c) => c.mirrored)).toEqual([false, false, false, true]);
    expect(new Set(corners.map((c) => c.x)).size).toBe(4);
  });

  it("saves the corner as a turn, and restores an older save unturned", () => {
    const field = bendField();
    field.placeObject(BEND, 3, 3, "bend");
    field.flipObject("bend");
    field.flipObject("bend");
    const saved = field.serializeObjects().find((o) => o.id === "bend")!;
    expect([saved.turn, saved.rotation]).toEqual([2, undefined]);

    const resolve = (key: string) => (key === BEND.key ? BEND : undefined);
    const back = bendField();
    back.restoreObjects([saved], resolve);
    expect(back.objectTurnOf("bend")).toBe(2);
    // A bend saved before the corners existed carries `rotation: 1` — a mirror of the
    // one corner it had. It comes back as that corner, drawn properly, rather than as
    // a different corner the player never chose.
    const legacy = bendField();
    legacy.restoreObjects([{ id: "bend", key: "roadBend_01", oc: 3, or: 3, rotation: 1 }], resolve);
    expect(legacy.objectTurnOf("bend")).toBe(0);
  });
});
