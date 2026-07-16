import { describe, expect, it } from "vitest";
import { GameState } from "./GameState";
import type { FarmerCatalog } from "./assets";

const catalog: FarmerCatalog = {
  heads: [
    { id: 1, name: "Free", part: "free.png", bodyId: 0, sort: 1 },
    { id: 2, name: "Paid", part: "paid.png", bodyId: 1, sort: 2, cost: 15, brains: true },
  ],
  bodies: [
    { id: 0, name: "Body A", body: "a.png", arm1: "a1", arm2: "a2", arm3: "a3", arm4: "a4" },
    { id: 1, name: "Body B", body: "b.png", arm1: "b1", arm2: "b2", arm3: "b3", arm4: "b4" },
  ],
};

describe("farmer wardrobe", () => {
  it("unlocks missing-price parts and permits independent owned equips", () => {
    const state = new GameState();
    state.seedFarmerCatalog(catalog);
    expect(state.ownedFarmerHeads).toEqual([1]);
    expect(state.ownedFarmerBodies).toEqual([0, 1]);
    expect(state.equipFarmerHead(2)).toBe(false);

    state.unlockFarmerHead(2, 1);
    expect(state.equipFarmerHead(2)).toBe(true);
    expect(state.equipFarmerBody(0)).toBe(true);
    expect([state.farmerHeadId, state.farmerBodyId]).toEqual([2, 0]);
  });
});
