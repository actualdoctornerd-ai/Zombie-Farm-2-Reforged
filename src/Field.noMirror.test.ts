// Objects with writing baked into their art must never be mirrored.
//
// "Rotate" is a horizontal flip, which in isometric art is exactly a quarter turn — and
// which turns the Ice Cream Stand's sign into "MAERC ECI". A player reported it. There is
// no mechanical repair (the letters would have to be re-skewed onto a plank now leaning
// the other way), so those objects do not turn at all, and the tool says why.
//
// The refusal is enforced in Field rather than at the tool, because the tool is not the
// only way a flip arrives: a restored save replays one, and so does a Move that was
// carrying a turned object. Field is the single door.
import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import { canMirrorObject, type PlaceableDef } from "./assets";
import { Field, objectFootprint } from "./Field";

const SIGN = {
  key: "iceCreamStand", name: "Ice Cream Stand", category: "reward",
  sprite: "iceCreamStand.png", tileW: 2, tileH: 1, nativeW: 85, nativeH: 99,
  noMirror: true,
} as unknown as PlaceableDef;

const HEDGE = {
  key: "hedge_01", name: "Hedge", category: "decor",
  sprite: "hedge_01.png", tileW: 1, tileH: 5, nativeW: 153, nativeH: 114,
} as unknown as PlaceableDef;

const makeField = (w = 12, h = 12): Field => {
  const field: Field = Object.create(Field.prototype);
  Object.assign(field, {
    w, h,
    plots: new Map(), tilePlot: new Map(), reserved: new Set(),
    tileObject: new Map(), pathObject: new Map(), fenceBlock: new Map(), objects: new Map(), nextObjId: 1,
    entityLayer: new Container(), groundObjectLayer: new Container(),
    objectLights: new Container(),
    assets: {
      field: { tileW: 48 },
      objects: { "iceCreamStand.png": Texture.EMPTY, "hedge_01.png": Texture.EMPTY },
    },
  });
  return field;
};

describe("objects whose art carries writing", () => {
  it("refuses to turn", () => {
    const field = makeField();
    const id = field.placeObject(SIGN, 2, 2)!;
    expect(field.flipObject(id)).toBe(false);
    expect(!!field.objectTurnOf(id)).toBe(false);
  });

  it("still turns everything else", () => {
    const field = makeField();
    const id = field.placeObject(HEDGE, 2, 2)!;
    expect(field.flipObject(id)).toBe(true);
    expect(!!field.objectTurnOf(id)).toBe(true);
  });

  it("drops a flip a restored save asks for, so art and footprint agree", () => {
    // Anything already saved as turned — from before the flag, or from a farm whose
    // owner has an older client — comes back the right way round rather than as a
    // mirrored sign sitting on a transposed footprint.
    const field = makeField();
    const id = field.placeObject(SIGN, 2, 2, undefined, undefined, 1)!;
    expect(!!field.objectTurnOf(id)).toBe(false);
    expect(objectFootprint(SIGN, !!field.objectTurnOf(id))).toEqual({ w: 2, h: 1 });
  });

  it("drops a flip a Move tries to commit", () => {
    const field = makeField();
    const id = field.placeObject(SIGN, 2, 2)!;
    expect(field.moveObject(id, 5, 5, 1)).toBe(true);
    expect(!!field.objectTurnOf(id)).toBe(false);
  });
});

describe("the shipped catalog", () => {
  const flagged = (placeables as { key: string; noMirror?: boolean }[])
    .filter((entry) => entry.noMirror).map((entry) => entry.key).sort();

  it("flags exactly the objects with lettering in their art", () => {
    // Reviewed by eye across the whole object set. Judge by TEXT: every raid banner is
    // asymmetric and mirrors perfectly well, because its crest is a picture.
    expect(flagged).toEqual([
      "iceCreamStand", "iceCreamTruck", "newYearBannerLeft", "newYearBannerRight",
    ]);
  });

  it("leaves every other object rotatable", () => {
    const rotatable = (placeables as { key: string; noMirror?: boolean }[])
      .filter((entry) => canMirrorObject(entry));
    expect(rotatable).toHaveLength(placeables.length - flagged.length);
  });
});
