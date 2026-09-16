import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import type { PlaceableDef } from "./assets";
import { Field } from "./Field";

// Wearing an earlier shed's art must change the PICTURE and nothing else: the
// object keeps its own def, so capacity, sale price and every footprint read carry
// on from the tier that is really standing there.
//
// Same trick as Field.objectWork.test.ts: skip the Pixi constructor and hand the
// Field only the bookkeeping these paths touch.
const catalog = placeables as PlaceableDef[];
const def = (key: string): PlaceableDef => {
  const found = catalog.find((d) => d.key === key);
  if (!found) throw new Error(`no such placeable: ${key}`);
  return found;
};

const SHABBY = new Texture();
const BARN = new Texture();
const DAISY = new Texture();

const makeField = (tier = "storage07"): Field => {
  const field: Field = Object.create(Field.prototype);
  Object.assign(field, {
    w: 12, h: 12,
    plots: new Map(), tilePlot: new Map(), reserved: new Set(),
    tileObject: new Map(), fenceBlock: new Map(), objects: new Map(),
    nextObjId: 1,
    entityLayer: new Container(), groundObjectLayer: new Container(),
    objectLights: new Container(),
    assets: {
      field: { tileW: 48 },
      objects: {
        [def("storage01").sprite]: SHABBY,
        [def(tier).sprite]: BARN,
        "daisy.png": DAISY,
      },
    },
  });
  field.placeObject(def(tier), 4, 4, "shed");
  return field;
};

const shedSprite = (field: Field): Sprite =>
  (field as unknown as { objects: Map<string, { sprite: Sprite }> }).objects.get("shed")!.sprite;
const blocked = (field: Field): number =>
  (field as unknown as { tileObject: Map<string, string> }).tileObject.size;

describe("Field.setObjectSkin", () => {
  it("draws the skin's art while the object keeps its own def", () => {
    const field = makeField();
    expect(shedSprite(field).texture).toBe(BARN);

    expect(field.setObjectSkin("shed", def("storage01"))).toBe(true);

    expect(shedSprite(field).texture).toBe(SHABBY);
    // The two things a player must not be able to buy with a paint job.
    expect(field.objectDefOf("shed")?.key).toBe("storage07");
    expect(field.objectDefOf("shed")?.storageSlots).toBe(56);
    expect(blocked(field)).toBe(9); // still the 3x3 it was
  });

  it("puts the object back in its own art", () => {
    const field = makeField();
    field.setObjectSkin("shed", def("storage01"));
    expect(field.setObjectSkin("shed", null)).toBe(true);
    expect(shedSprite(field).texture).toBe(BARN);
    expect(field.objectSkinOf("shed")).toBeNull();
  });

  // "No skin" and "skinned as myself" are one state, or the self-skin outlives the
  // next upgrade and pins the shed to art it has grown out of.
  it("treats a skin of the object's own def as no skin", () => {
    const field = makeField();
    field.setObjectSkin("shed", def("storage07"));
    expect(field.objectSkinOf("shed")).toBeNull();
  });

  // The render-safety guard. Which skins are UNLOCKED is objectSkins' business; this
  // is the line that stops a tampered save or a visited farm dressing a 3x3 shed as
  // something that draws outside its own tiles.
  it("refuses art that does not fit where the object's own art sits", () => {
    const field = makeField();
    expect(field.setObjectSkin("shed", def("daisy"))).toBe(false);
    expect(shedSprite(field).texture).toBe(BARN);
  });

  it("is a no-op for an object that is not there", () => {
    expect(makeField().setObjectSkin("nobody", def("storage01"))).toBe(false);
  });
});

describe("a skin across save and upgrade", () => {
  it("round-trips through the save as a separate field from the real key", () => {
    const field = makeField();
    field.setObjectSkin("shed", def("storage01"));
    const saved = field.serializeObjects().find((o) => o.id === "shed")!;
    expect(saved.key).toBe("storage07"); // the tier that is really placed
    expect(saved.skin).toBe("storage01"); // the tier it looks like

    const back = makeField();
    back.restoreObjects([saved], (key) => catalog.find((d) => d.key === key), catalog);
    expect(back.objectSkinOf("shed")?.key).toBe("storage01");
    expect(back.objectDefOf("shed")?.storageSlots).toBe(56);
  });

  it("writes no skin field for a shed wearing its own look", () => {
    const saved = makeField().serializeObjects().find((o) => o.id === "shed")!;
    expect(saved.skin).toBeUndefined();
  });

  it("drops a skin a restored object has no right to wear", () => {
    const field = makeField("storage01"); // a Shabby Shed claiming the Barn's look
    const saved = { ...field.serializeObjects()[0], skin: "storage07" };
    const back = makeField("storage01");
    back.restoreObjects([saved], (key) => catalog.find((d) => d.key === key), catalog);
    expect(back.objectSkinOf("shed")).toBeNull();
  });

  // An upgrade has to show what was bought. The old look is not lost — it is one
  // tap away in the picker, which has just gained a card.
  it("clears the skin when the shed is upgraded in place", () => {
    const field = makeField();
    field.setObjectSkin("shed", def("storage01"));
    field.replaceObjectDef("shed", def("storage08"));
    expect(field.objectSkinOf("shed")).toBeNull();
    expect(field.objectDefOf("shed")?.key).toBe("storage08");
  });
});
