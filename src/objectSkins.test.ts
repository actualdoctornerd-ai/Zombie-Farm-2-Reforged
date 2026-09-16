import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import { objectSkinOptions, resolveObjectSkin, skinCompatible } from "./objectSkins";
import type { PlaceableDef } from "./assets";

const catalog = placeables as PlaceableDef[];
const byKey = new Map(catalog.map((def) => [def.key, def]));
const def = (key: string): PlaceableDef => {
  const found = byKey.get(key);
  if (!found) throw new Error(`no such placeable: ${key}`);
  return found;
};
const keys = (list: PlaceableDef[]) => list.map((d) => d.key);

describe("objectSkinOptions", () => {
  // The whole unlock rule, and the reason no new saved state exists: the Market
  // sells exactly one shed at a time — the next tier above the placed one — so a
  // farm cannot skip a rung, and the tiers at or below the current one ARE the
  // sheds it has owned.
  it("offers every shed at or below the placed tier, earliest first", () => {
    expect(keys(objectSkinOptions(def("storage04"), catalog)))
      .toEqual(["storage01", "storage02", "storage03", "storage04"]);
  });

  it("offers nothing above the placed tier", () => {
    const options = keys(objectSkinOptions(def("storage03"), catalog));
    expect(options).not.toContain("storage04");
    expect(options).not.toContain("storage09");
  });

  it("gives the starter shed only its own look, which hides the picker", () => {
    expect(keys(objectSkinOptions(def("storage01"), catalog))).toEqual(["storage01"]);
  });

  // Two tiers, one picture: the Zombie Warehouse reuses McDonnell's Barn's sprite.
  // Showing it twice would offer the player a choice that changes nothing, and
  // keeping the LOWER of the pair would leave a top-tier farm unable to find its own
  // shed in the list.
  it("shows a shared piece of art once, as the highest tier wearing it", () => {
    expect(def("storage09").sprite).toBe(def("storage08").sprite); // the premise
    const options = keys(objectSkinOptions(def("storage09"), catalog));
    expect(options).toContain("storage09");
    expect(options).not.toContain("storage08");
    expect(options.length).toBe(new Set(options).size);
  });

  it("has no opinion about anything that is not a shed", () => {
    expect(objectSkinOptions(def("daisy"), catalog)).toEqual([]);
  });
});

describe("resolveObjectSkin", () => {
  it("resolves an unlocked tier's def", () => {
    expect(resolveObjectSkin(def("storage05"), "storage02", catalog)?.key).toBe("storage02");
  });

  // "No skin" and "skinned as myself" have to be one state. A self-skin that
  // survived would outlive the next upgrade and pin the shed to art it outgrew.
  it("reads the object's own key as no skin at all", () => {
    expect(resolveObjectSkin(def("storage05"), "storage05", catalog)).toBeNull();
    expect(resolveObjectSkin(def("storage05"), undefined, catalog)).toBeNull();
  });

  // A hand-edited save, or a friend's presentation blob rendered on a visit: the
  // skin key is client-authored, so nothing may take it on trust.
  it("refuses a tier the object has not unlocked, and a key that is not a shed", () => {
    expect(resolveObjectSkin(def("storage02"), "storage08", catalog)).toBeNull();
    expect(resolveObjectSkin(def("storage05"), "daisy", catalog)).toBeNull();
    expect(resolveObjectSkin(def("storage05"), "nonesuch", catalog)).toBeNull();
  });
});

describe("skinCompatible", () => {
  it("accepts sheds, which share a footprint and are plain stills", () => {
    expect(skinCompatible(def("storage08"), def("storage01"))).toBe(true);
  });

  // The guard that makes the render seam safe: a skin swaps the PICTURE, while the
  // footprint, blocked tiles and state machine stay with the object's real def. Art
  // that is positioned or animated by rules of its own cannot be borrowed.
  it("refuses art that would not sit where the object's own art does", () => {
    const shed = def("storage08");
    const wider: PlaceableDef = { ...def("storage01"), tileW: 4 };
    const flat: PlaceableDef = { ...def("storage01"), flatTile: true };
    const stateful: PlaceableDef = { ...def("storage01"), busySprite: "lid.png" };
    expect(skinCompatible(shed, wider)).toBe(false);
    expect(skinCompatible(shed, flat)).toBe(false);
    expect(skinCompatible(shed, stateful)).toBe(false);
  });
});
