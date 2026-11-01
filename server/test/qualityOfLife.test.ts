// Several Pet Pens, Insta-Harvest without zombies, and buying boosts in bulk.
import { describe, expect, it } from "vitest";
import { MAX_BOOST_BUY_COUNT, MAX_PET_PENS, type SequencedCommand } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState } from "../src/v3/engine";
import { validGameplayCommand } from "../src/index";

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

describe("Pet Pens", () => {
  it("sells up to four pens", () => {
    const state = freshGameplayState();
    state.balance.gold = 10_000;
    const bought = applyCommandBatch(state, commands(
      ...Array.from({ length: MAX_PET_PENS + 1 }, (_, i) =>
        ({ type: "object.buy" as const, catalogKey: "pettingZoo", clientInstanceId: `pen-${i}` })),
    ), { now: 1 });
    expect(bought.results.map((result) => result.status)).toEqual(
      [...Array(MAX_PET_PENS).fill("applied"), "rejected"]);
    expect(bought.results[MAX_PET_PENS]).toMatchObject({ error: "object_limit" });
  });

  it("keeps each pen's pets in its own slots, with blanks holding their place", () => {
    const state = freshGameplayState();
    state.ownedPets = ["a", "b", "c", "d", "e", "f"];
    // Pen 0 holds a and b; pen 1 holds e.
    const deployed = applyCommandBatch(state, commands({
      type: "pet.pen", petKeys: ["a", "b", "", "", "e", "", ""],
    }), { now: 1 });
    expect(deployed.results[0]).toMatchObject({ status: "applied" });
    expect(deployed.state.penPets).toEqual(["a", "b", "", "", "e"]);

    // Following a pet out of pen 0 blanks its slot; pen 1's pet stays in pen 1.
    const equipped = applyCommandBatch(deployed.state, commands({ type: "pet.equip", petKey: "a" }), { now: 2 });
    expect(equipped.state.penPets).toEqual(["", "b", "", "", "e"]);

    const tooMany = applyCommandBatch(state, commands({
      type: "pet.pen", petKeys: Array.from({ length: 17 }, () => ""),
    }), { now: 3 });
    expect(tooMany.results[0]).toMatchObject({ status: "rejected", error: "bad_selection" });
    const twice = applyCommandBatch(state, commands({ type: "pet.pen", petKeys: ["a", "", "", "", "a"] }), { now: 4 });
    expect(twice.results[0]).toMatchObject({ status: "rejected", error: "bad_selection" });
  });

  it("lets blank slots through the command door", () => {
    expect(validGameplayCommand({ type: "pet.pen", petKeys: ["a", "", "", "", "b"] })).toBe(true);
    expect(validGameplayCommand({ type: "pet.pen", petKeys: Array.from({ length: 17 }, () => "") })).toBe(false);
  });
});

describe("Insta-Harvest zombie setting", () => {
  const farm = () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false,
    };
    state.farm.plots["8:0"] = {
      state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1,
      fertilized: false, zombie: true,
    };
    return state;
  };

  it("leaves zombie crops planted when skipZombies is set", () => {
    const swept = applyCommandBatch(farm(), commands({ type: "power.use", key: "insta_harvest", skipZombies: true }),
      { now: 1_000, random: () => 0.99, id: () => "z" });
    expect(swept.results[0]).toMatchObject({ status: "applied" });
    expect(swept.state.farm.plots["0:0"]).toMatchObject({ state: "spent" });
    expect(swept.state.farm.plots["8:0"]).toMatchObject({ state: "planted", zombie: true });
    expect(swept.state.inventory.insta_harvest).toBe(0);
  });

  it("still harvests zombies by default", () => {
    const swept = applyCommandBatch(farm(), commands({ type: "power.use", key: "insta_harvest" }),
      { now: 1_000, random: () => 0.99, id: () => "z" });
    expect(swept.state.farm.plots["8:0"]).toMatchObject({ state: "spent" });
  });

  it("refuses a non-boolean flag at the command door", () => {
    expect(validGameplayCommand({ type: "power.use", key: "insta_harvest", skipZombies: true })).toBe(true);
    expect(validGameplayCommand({ type: "power.use", key: "insta_harvest", skipZombies: "yes" } as never)).toBe(false);
  });
});

describe("bulk boost purchase", () => {
  it("buys `count` packs in one all-or-nothing command", () => {
    const state = freshGameplayState();
    state.balance.gold = 0;
    state.balance.brains = 25;
    const before = state.inventory.insta_grow ?? 0;
    // Insta-Grow costs one brain per 20-use pack.
    const bought = applyCommandBatch(state, commands({ type: "power.buy", key: "insta_grow", count: 20 }), { now: 1 });
    expect(bought.results[0]).toMatchObject({ status: "applied" });
    expect(bought.state.balance.brains).toBe(5);
    expect(bought.state.inventory.insta_grow).toBe(before + 20 * 20); // 20 uses a pack

    const short = applyCommandBatch(bought.state, commands({ type: "power.buy", key: "insta_grow", count: 6 }), { now: 2 });
    expect(short.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(short.state.balance.brains).toBe(5);
  });

  it("caps the count at the command door", () => {
    expect(validGameplayCommand({ type: "power.buy", key: "insta_grow", count: MAX_BOOST_BUY_COUNT })).toBe(true);
    expect(validGameplayCommand({ type: "power.buy", key: "insta_grow", count: MAX_BOOST_BUY_COUNT + 1 })).toBe(false);
    expect(validGameplayCommand({ type: "power.buy", key: "insta_grow", count: 0 })).toBe(false);
  });
});
