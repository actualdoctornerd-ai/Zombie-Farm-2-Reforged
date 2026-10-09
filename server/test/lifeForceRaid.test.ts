import { describe, expect, it } from "vitest";
import { lifeForceLevelOfObjects } from "../src/raidVerifier";
import { lifeForceKeysOf, lifeForceOf } from "../src/objectCatalog";

// The server derives the Life Force level that opens a fight's ability slots from the
// objects it holds as PLACED. A stored decoration adds nothing, and a bad blob is an
// empty farm rather than an error.

const objects = (...rows: { catalogKey: string; status: string }[]) => JSON.stringify(rows);

describe("lifeForceLevelOfObjects", () => {
  it("is 0 for an empty or missing document", () => {
    expect(lifeForceLevelOfObjects(undefined)).toBe(0);
    expect(lifeForceLevelOfObjects(null)).toBe(0);
    expect(lifeForceLevelOfObjects("[]")).toBe(0);
  });

  it("counts placed objects: two Gazebos (32) are level 1, five (80) are level 2", () => {
    const gazebos = (n: number) => objects(...Array.from({ length: n }, () => ({ catalogKey: "gazeboNormal", status: "placed" })));
    expect(lifeForceLevelOfObjects(gazebos(1))).toBe(0); // 16
    expect(lifeForceLevelOfObjects(gazebos(2))).toBe(1); // 32
    expect(lifeForceLevelOfObjects(gazebos(5))).toBe(2); // 80
    expect(lifeForceLevelOfObjects(gazebos(29))).toBe(10); // 464, past the 450 cap
  });

  it("ignores stored objects and unknown keys", () => {
    const stored = Array.from({ length: 10 }, () => ({ catalogKey: "gazeboNormal", status: "stored" }));
    expect(lifeForceLevelOfObjects(objects(...stored, { catalogKey: "notAThing", status: "placed" }))).toBe(0);
  });

  it("treats a corrupt document as an empty farm", () => {
    expect(lifeForceLevelOfObjects("{not json")).toBe(0);
    expect(lifeForceLevelOfObjects('{"a":1}')).toBe(0);
  });
});

// The starter shed (storage01, 9 Life Force) is never a server object, but the client
// counts it, so the server must too or a farm the player sees at one level is a level
// lower here.
describe("the starter shed counts toward Life Force", () => {
  const gazebo = { catalogKey: "gazeboNormal", status: "placed" };

  it("lifts a farm over a threshold: 4 gazebos are 64, short of 65, until the shed adds 9", () => {
    expect(lifeForceOf("gazeboNormal")).toBe(16);
    expect(lifeForceLevelOfObjects(objects(gazebo, gazebo, gazebo, gazebo))).toBe(2);
    expect(lifeForceKeysOf([gazebo])).toEqual(["gazeboNormal", "storage01"]);
  });

  it("stops adding it once a bought shed is placed, which replaces it on the client", () => {
    const bought = { catalogKey: "storage02", status: "placed" };
    expect(lifeForceKeysOf([gazebo, bought])).toEqual(["gazeboNormal", "storage02"]);
  });
});
