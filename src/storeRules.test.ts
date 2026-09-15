import { describe, expect, it } from "vitest";
import {
  storeBlock, storeBlockLabel, storeBlockMessage, type StorableDef,
} from "./storeRules";

const ROOM = { used: 2, cap: 8 };
const FULL = { used: 8, cap: 8 };
const DECOR: StorableDef = {};
const POT: StorableDef = { zombiePot: true };
const SHED: StorableDef = { storageSlots: 16 };
const MAUSOLEUM: StorableDef = { zombieStorage: true };

describe("storeBlock", () => {
  it("takes an ordinary decoration while the shed has room", () => {
    expect(storeBlock(DECOR, ROOM)).toBeNull();
  });

  it("refuses anything once the shed is full", () => {
    expect(storeBlock(DECOR, FULL)).toBe("full");
  });

  // The shed cannot contain itself, and packing the Mausoleum would take the crypt
  // out from under the zombies resting in it. The Worker enforces the same rule.
  it("never stores a building that holds things, however empty the shed", () => {
    expect(storeBlock(SHED, ROOM)).toBe("holds");
    expect(storeBlock(MAUSOLEUM, ROOM)).toBe("holds");
  });

  it("stores an idle Zombie Pot", () => {
    expect(storeBlock(POT, ROOM, { potInUse: false })).toBeNull();
    expect(storeBlock(POT, ROOM)).toBeNull(); // no subject = nothing running in it
  });

  // Both parents are eaten when a combine STARTS, so shelving a pot mid-job would
  // destroy two zombies and yield nothing. Same for a finished-but-uncollected one.
  it("refuses a Zombie Pot with a combine in it", () => {
    expect(storeBlock(POT, ROOM, { potInUse: true })).toBe("potInUse");
  });

  // The fix for a busy pot ("collect it") is nothing like the fix for a full shed
  // ("make room"), so a busy pot must not be reported as a full shed.
  it("blames the combine, not the shed, when both would refuse", () => {
    expect(storeBlock(POT, FULL, { potInUse: true })).toBe("potInUse");
  });

  // potInUse is only ever set for a pot, but the flag must not leak onto anything
  // else if a caller gets sloppy about which subject it passes.
  it("ignores potInUse on a def that is not a pot", () => {
    expect(storeBlock(DECOR, ROOM, { potInUse: true })).toBeNull();
  });
});

describe("refusal wording", () => {
  it("labels every refusal short enough for a button", () => {
    for (const block of ["holds", "potInUse", "full"] as const) {
      expect(storeBlockLabel(block).length).toBeLessThanOrEqual(16);
    }
  });

  it("names the object and the fix in the dropped-on-the-shed message", () => {
    expect(storeBlockMessage("potInUse", "Zombie Pot"))
      .toContain("collect the combine inside it first");
    expect(storeBlockMessage("full", "Daisy")).toContain("Daisy");
  });
});
