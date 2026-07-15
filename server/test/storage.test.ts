import { describe, it, expect } from "vitest";
import { planClaim, planStore, planRetrieve } from "../src/storage";
import { SHED_SLOTS, BASE_SHED_SLOTS } from "../src/objectCatalog";

describe("planClaim — Received -> the thing it represents", () => {
  it("claims a boost drop into the boost inventory, by NAME", () => {
    expect(planClaim("Insta-Plow", 1)).toEqual({ ok: true, kind: "boost", boostKey: "insta_plow" });
    expect(planClaim("Invasion Voucher", 2)).toEqual({ ok: true, kind: "boost", boostKey: "invasion_voucher" });
  });

  it("claims a decoration into the placeable it becomes (drops.json `tile`)", () => {
    expect(planClaim("Windmill", 1)).toEqual({ ok: true, kind: "object", objectKey: "windmill" });
  });

  it("refuses to claim an item that isn't there", () => {
    // The guard that matters: without it, claiming would GRANT from nothing.
    expect(planClaim("Windmill", 0)).toMatchObject({ ok: false, error: "none_owned" });
  });

  it("refuses an unknown item and an empty name", () => {
    expect(planClaim("NotARealDrop", 5)).toMatchObject({ ok: false, error: "bad_item" });
    expect(planClaim("", 5)).toMatchObject({ ok: false, error: "bad_item" });
  });

  it("refuses a BRAIN entry — an edited save must not mint premium currency", () => {
    // No loot table drops brains today (the brain roll is deferred while `win` is
    // client-asserted), so a brain entry in Received could only come from a pre-T2 save.
    expect(planClaim("10 Brains", 1)).toMatchObject({ ok: false, error: "brains_deferred" });
  });

  it("refuses a trophy with no placeable (nothing to claim it INTO)", () => {
    // Rusty Fragment is a key-piece: no `tile`, so it just sits in Received.
    expect(planClaim("Rusty Fragment", 1)).toMatchObject({ ok: false, error: "not_claimable" });
  });
});

describe("planStore / planRetrieve — the shed", () => {
  it("packs an owned object away when there's room", () => {
    expect(planStore("Windmill", 1, 0, 8)).toEqual({ ok: true, kind: "object", objectKey: "windmill" });
  });
  it("refuses to store an object you don't own", () => {
    expect(planStore("Windmill", 0, 0, 8)).toMatchObject({ ok: false, error: "none_owned" });
  });
  it("refuses once the shed is full", () => {
    expect(planStore("Windmill", 1, 8, 8)).toMatchObject({ ok: false, error: "shed_full" });
  });
  it("takes a stored item back out, and refuses when there's none", () => {
    expect(planRetrieve("Windmill", 1)).toEqual({ ok: true, kind: "object", objectKey: "windmill" });
    expect(planRetrieve("Windmill", 0)).toMatchObject({ ok: false, error: "none_owned" });
  });
  it("refuses an item with no placeable on either move", () => {
    expect(planStore("Rusty Fragment", 5, 0, 8)).toMatchObject({ ok: false, error: "bad_item" });
    expect(planRetrieve("Rusty Fragment", 5)).toMatchObject({ ok: false, error: "bad_item" });
  });
});

describe("shed capacity catalog", () => {
  it("mirrors placeables.json storageSlots, 8 per tier", () => {
    expect(SHED_SLOTS.storage01).toBe(BASE_SHED_SLOTS); // the free starter shed
    expect(SHED_SLOTS.storage08).toBe(64); // the biggest
    expect(Object.keys(SHED_SLOTS)).toHaveLength(8);
  });
});
