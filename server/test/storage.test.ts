import { describe, it, expect } from "vitest";
import { planClaim, planStore, planRetrieve } from "../src/storage";
import { SHED_SLOTS, BASE_SHED_SLOTS } from "../src/objectCatalog";
import { EPIC_BOSSES } from "../../src/epicBoss/catalog";

/** Every epic-boss prize that is claimed out of Received (pets are not). */
const EPIC_PRIZES = EPIC_BOSSES.flatMap((boss) =>
  boss.loot.filter((prize) => !prize.stageActor).map((prize) => ({ boss: boss.id, ...prize })));

describe("planClaim — Received -> the thing it represents", () => {
  it("claims a boost drop into the boost inventory, by NAME", () => {
    expect(planClaim("Insta-Plow", 1)).toEqual({ ok: true, kind: "boost", boostKey: "insta_plow" });
    expect(planClaim("Invasion Voucher", 2)).toEqual({ ok: true, kind: "boost", boostKey: "invasion_voucher" });
  });

  it("claims a decoration into the placeable it becomes (drops.json `tile`)", () => {
    expect(planClaim("Windmill", 1)).toEqual({ ok: true, kind: "object", objectKey: "windmill" });
  });

  it("claims every epic-boss prize into its placeable", () => {
    // The field report: an epic prize placed on the farm came back as a "bad item"
    // and was rolled back. planClaim resolves through dropEcon(name), and no epic
    // prize had drop metadata — so all 50, across all 8 bosses, were unclaimable.
    expect(EPIC_PRIZES.length).toBeGreaterThan(40);
    const refused: string[] = [];
    for (const prize of EPIC_PRIZES) {
      const plan = planClaim(prize.name, 1);
      if (!plan.ok || plan.kind !== "object" || plan.objectKey !== prize.tile) {
        refused.push(`${prize.boss}:${prize.name} -> ${JSON.stringify(plan)}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("lets an epic prize go into the shed and come back out", () => {
    // planStore/planRetrieve read the same table, so they failed the same way — a
    // prize that could not be claimed could not be shelved either.
    for (const prize of EPIC_PRIZES.slice(0, 5)) {
      expect(planStore(prize.name, 1, 0, 8), prize.name)
        .toEqual({ ok: true, kind: "object", objectKey: prize.tile });
      expect(planRetrieve(prize.name, 1), prize.name)
        .toEqual({ ok: true, kind: "object", objectKey: prize.tile });
    }
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
  it("mirrors placeables.json storageSlots: 8 per source tier, 16 per Warehouse rung", () => {
    expect(SHED_SLOTS.storage01).toBe(BASE_SHED_SLOTS); // the free starter shed
    expect(SHED_SLOTS.storage09).toBe(80); // the Warehouse: the first Reforged rung above the source ladder
    expect(SHED_SLOTS.storage17).toBe(208); // Warehouse IX, the top of the expansion ladder
    expect(Object.keys(SHED_SLOTS)).toHaveLength(17);
    // The source ladder (storage01..08) steps by 8; the Reforged rungs above it
    // (Warehouse + its eight expansions) step by 16 for the same prices.
    const ladder = Object.values(SHED_SLOTS).sort((a, b) => a - b);
    expect(ladder.every((slots, i) =>
      slots === (i < 8 ? BASE_SHED_SLOTS + 8 * i : 64 + 16 * (i - 7)))).toBe(true);
  });
});
