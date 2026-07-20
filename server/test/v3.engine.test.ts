import { describe, expect, it } from "vitest";
import type { SequencedCommand } from "../../src/net/protocol";
import { createCombineRandom } from "../../src/zombie/combineSpecies";
import plantRows from "../../public/assets/plants.json";
import {
  applyCommandBatch,
  applyQuestEvents,
  freshGameplayState,
  zombieDefaultMutation,
} from "../src/v3/engine";
import { QUEST_DEFINITIONS } from "../src/questCatalog";

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

const rareCombinePairIds = (): [string, string] => {
  for (let index = 0; index < 10_000; index++) {
    const ids: [string, string] = [`rare-a-${index}`, `rare-b-${index}`];
    if (createCombineRandom(...ids)() < 0.10) return ids;
  }
  throw new Error("could not find deterministic rare-combine test pair");
};

describe("protocol v3 command engine", () => {
  it("can claim the ordered writer lane without changing gameplay state", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands({ type: "writer.claim" }), { now: 1 });
    expect(result.results).toEqual([{ sequence: 1, status: "applied" }]);
    expect(result.state).toEqual(state);
  });

  it("authoritatively buys, equips, and hides cosmetic pets", () => {
    const state = freshGameplayState();
    state.balance.brains = 10_000;
    expect(state.ownedPets).toEqual([]);
    expect(state.activePet).toBeNull();

    const bought = applyCommandBatch(state, commands({ type: "pet.buy", petKey: "catActor" }), { now: 1 });
    expect(bought.results[0]).toMatchObject({ status: "applied" });
    expect(bought.state.balance.brains).toBe(state.balance.brains - 50);
    expect(bought.state.balance.xp).toBe(state.balance.xp + 1);
    expect(bought.state.ownedPets).toEqual(["catActor"]);
    expect(bought.state.activePet).toBe("catActor");

    const duplicate = applyCommandBatch(bought.state, commands({ type: "pet.buy", petKey: "catActor" }), { now: 2 });
    expect(duplicate.results[0]).toMatchObject({ status: "rejected", error: "already_owned" });
    const unowned = applyCommandBatch(bought.state, commands({ type: "pet.equip", petKey: "alienActor" }), { now: 3 });
    expect(unowned.results[0]).toMatchObject({ status: "rejected", error: "not_owned" });
    const hidden = applyCommandBatch(bought.state, commands({ type: "pet.equip", petKey: null }), { now: 4 });
    expect(hidden.results[0]).toMatchObject({ status: "applied" });
    expect(hidden.state.activePet).toBeNull();
  });

  it("authoritatively replaces the selected follower instead of activating two", () => {
    const state = freshGameplayState();
    state.balance.brains = 10_000;
    const bought = applyCommandBatch(state, commands(
      { type: "pet.buy", petKey: "catActor" },
      { type: "pet.buy", petKey: "alienActor" },
    ), { now: 1 });
    expect(bought.state.ownedPets).toEqual(["catActor", "alienActor"]);
    expect(bought.state.activePet).toBe("alienActor");

    const switched = applyCommandBatch(bought.state, commands(
      { type: "pet.equip", petKey: "catActor" },
    ), { now: 2 });
    expect(switched.results[0]).toMatchObject({ status: "applied" });
    expect(switched.state.ownedPets).toEqual(["catActor", "alienActor"]);
    expect(switched.state.activePet).toBe("catActor");
  });

  it("authoritatively limits pen deployment to four owned pets", () => {
    const state = freshGameplayState();
    state.ownedPets = ["catActor", "alienActor", "dogActor", "pinkBunny"];
    state.activePet = "catActor";
    const deployed = applyCommandBatch(state, commands({
      type: "pet.pen", petKeys: ["catActor", "alienActor", "dogActor", "pinkBunny"],
    }), { now: 1 });
    expect(deployed.results[0]).toMatchObject({ status: "applied" });
    expect(deployed.state.penPets).toEqual(["catActor", "alienActor", "dogActor", "pinkBunny"]);
    expect(deployed.state.activePet).toBeNull();

    const invalid = applyCommandBatch(state, commands({ type: "pet.pen", petKeys: ["catActor", "missing"] }), { now: 2 });
    expect(invalid.results[0]).toMatchObject({ status: "rejected", error: "not_owned" });
    const duplicate = applyCommandBatch(state, commands({ type: "pet.pen", petKeys: ["catActor", "catActor"] }), { now: 3 });
    expect(duplicate.results[0]).toMatchObject({ status: "rejected", error: "bad_selection" });
  });

  it("rejects invalid, locked, and unaffordable pet purchases", () => {
    const state = freshGameplayState();
    state.balance.brains = 49;
    expect(applyCommandBatch(state, commands({ type: "pet.buy", petKey: "catActor" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "insufficient" });
    expect(applyCommandBatch(freshGameplayState(), commands({ type: "pet.buy", petKey: "not-a-pet" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "bad_item" });
    expect(applyCommandBatch(freshGameplayState(), commands({ type: "pet.buy", petKey: "bullyfrogpetActor" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "locked" });
  });

  it("starts with free Farmer heads and authoritatively buys a priced head once", () => {
    const state = freshGameplayState();
    expect(state.farmerHeads).toEqual(expect.arrayContaining([0, 1, 4, 5, 10, 11]));
    expect(state.farmerHeads).not.toContain(12);

    const bought = applyCommandBatch(state, commands({ type: "farmer.buy", headId: 12 }), { now: 1 });
    expect(bought.results[0]).toMatchObject({ status: "applied" });
    expect(bought.state.farmerHeads).toContain(12);
    expect(bought.state.balance.brains).toBe(state.balance.brains - 15);

    const equipped = applyCommandBatch(bought.state, commands({ type: "farmer.equip", headId: 12 }), { now: 2 });
    expect(equipped.results[0]).toMatchObject({ status: "applied" });
    expect(equipped.state.farmerHeadId).toBe(12);

    const duplicate = applyCommandBatch(equipped.state, commands({ type: "farmer.buy", headId: 12 }), { now: 3 });
    expect(duplicate.results[0]).toMatchObject({ status: "rejected", error: "already_owned" });
  });

  it("applies equipped Farmer effects to authoritative harvests and zombie growth", () => {
    const harvestState = freshGameplayState();
    harvestState.farmerHeads.push(12);
    harvestState.farmerHeadId = 12;
    harvestState.farm.plots["0:0"] = {
      state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1,
      sell: 100, xp: 1, fertilized: false, zombie: false,
    };
    const harvested = applyCommandBatch(harvestState, commands({ type: "farm.harvest", oc: 0, or: 0 }), { now: 1_000 });
    expect(harvested.state.balance.gold - harvestState.balance.gold).toBe(110);

    const growState = freshGameplayState();
    growState.farmerHeads.push(13);
    growState.farmerHeadId = 13;
    growState.farm.plots["0:0"] = { state: "plowed" };
    const planted = applyCommandBatch(
      growState,
      commands({ type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" }),
      { now: 1 }
    );
    const plot = planted.state.farm.plots["0:0"];
    expect(plot.state === "planted" ? plot.growMs : 0).toBe(450_000);
  });

  it("authoritatively grants crop tokens only while an Epic Boss event is active", () => {
    const state = freshGameplayState();
    state.epicBoss = {
      runId: "run", bossId: "dr-groundhog", activatedAt: 1, expiresAt: 10_000,
      level: 1, maxHp: 2_000, currentHp: 2_000, encounterStartedAt: 0,
      retryReadyAt: 0, tokenCount: 2, completedAt: 0, attackOrder: [],
    };
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "lima_beans", plantedAt: -86_400_000, growMs: 86_400_000,
      sell: 205, xp: 1, fertilized: false, zombie: false,
    };
    const won = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 0, or: 0 }), {
      now: 1_000, random: () => 0,
    });
    expect(won.state.epicBoss?.tokenCount).toBe(3);

    const expired = freshGameplayState();
    expired.epicBoss = { ...state.epicBoss, expiresAt: 999 };
    expired.farm.plots["0:0"] = { ...state.farm.plots["0:0"] };
    const ignored = applyCommandBatch(expired, commands({ type: "farm.harvest", oc: 0, or: 0 }), {
      now: 1_000, random: () => 0,
    });
    expect(ignored.state.epicBoss?.tokenCount).toBe(2);
  });

  it("accepts the freely placed, non-grid-aligned plot used by the tutorial", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 15, or: 12 },
      { type: "farm.plant", oc: 15, or: 12, cropKey: "ZombieActorRegularTier1" },
      { type: "power.buy", key: "insta_grow" },
    ), { now: 1_000 });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied", "applied"]);
    expect(result.state.farm.plots["15:12"]).toMatchObject({
      state: "planted", cropKey: "ZombieActorRegularTier1", zombie: true,
    });
    expect(result.state.balance).toMatchObject({ gold: 355, brains: 19 });
  });

  it("rejects a new free-placed plot whose footprint overlaps another plot", () => {
    const state = freshGameplayState();
    state.farm.plots["5:5"] = { state: "spent" };
    const result = applyCommandBatch(state, commands({ type: "farm.plow", oc: 7, or: 7 }), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "plot_overlap" });
  });

  it("applies a causally ordered mixed farm batch with server timestamps", () => {
    const state = freshGameplayState();
    const now = 1_000_000;
    const planted = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.harvest", oc: 0, or: 0 },
    ), { now, random: () => 1, id: () => "unit" });

    expect(planted.results.map((result) => result.status)).toEqual(["applied", "applied", "rejected"]);
    expect(planted.results[2].error).toBe("not_grown");
    expect(planted.state.balance.gold).toBe(385);
    expect(planted.state.farm.plots["0:0"]).toMatchObject({
      state: "planted",
      cropKey: "carrot",
      plantedAt: now,
      growMs: 900_000,
      sell: 16,
    });
  });

  it("accepts every seasonal crop shipped in the client catalog", () => {
    for (const crop of plantRows.filter((entry) => entry.seasonal)) {
      const state = freshGameplayState();
      state.balance.gold = 1_000_000;
      state.balance.xp = 1_000_000;
      state.farm.plots["0:0"] = { state: "plowed" };
      const result = applyCommandBatch(
        state,
        commands({ type: "farm.plant", oc: 0, or: 0, cropKey: crop.key }),
        { now: 1 }
      );
      expect(result.results[0], crop.key).toMatchObject({ status: "applied" });
    }
  });

  it("treats an empty quest subject as a wildcard and completes it only once", () => {
    const state = freshGameplayState();
    state.quests.completed = ["70"];
    const first = applyQuestEvents(state.balance, state.quests, [
      { type: "kCropPlantedNotification", subject: "Carrot" },
    ]);
    expect(first).toContainEqual(expect.objectContaining({ questId: "71", completed: true }));
    expect(state.quests.completed.filter((id) => id === "71")).toHaveLength(1);

    const repeated = applyQuestEvents(state.balance, state.quests, [
      { type: "kCropPlantedNotification", subject: "Tomato" },
    ]);
    expect(repeated.some((change) => change.questId === "71")).toBe(false);
    expect(state.quests.completed.filter((id) => id === "71")).toHaveLength(1);
  });

  it("grants a harvested market mutant with its catalog mutation", () => {
    const state = freshGameplayState();
    state.farm.plots["0:0"] = {
      state: "planted",
      cropKey: "ZombieActorRegularTier1Carrots",
      plantedAt: 0,
      growMs: 1,
      sell: 0,
      xp: 1,
      fertilized: false,
      zombie: true,
    };
    const result = applyCommandBatch(
      state,
      commands({ type: "farm.harvest", oc: 0, or: 0 }),
      { now: 1_000, id: () => "carrot-zombie" }
    );
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "carrot-zombie",
      key: "ZombieActorRegularTier1Carrots",
      mutation: 4,
    }));
    expect(zombieDefaultMutation("ZombieActorRegularTier1Tomatoes")).toBe(1);
    expect(zombieDefaultMutation("ZombieActorRegularTier1")).toBe(0);
  });

  it("marks same-resource followers dependency_failed while independent commands continue", () => {
    const state = freshGameplayState();
    state.balance.gold = 0;
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.remove", oc: 4, or: 0 },
    ), { now: 1 });
    expect(result.results).toEqual([
      { sequence: 1, status: "rejected", error: "insufficient" },
      { sequence: 2, status: "dependency_failed", error: "prior_command_failed" },
      { sequence: 3, status: "rejected", error: "nothing_to_remove" },
    ]);
  });

  it("reports a duplicate plant as occupied instead of claiming the soil is unplowed", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
    ), { now: 1, random: () => 1 });
    expect(result.results).toEqual([
      { sequence: 1, status: "applied" },
      { sequence: 2, status: "applied" },
      { sequence: 3, status: "rejected", error: "plot_occupied" },
    ]);
  });

  it("removing a visual plot deletes its paid soil and crop without refund", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.remove", oc: 0, or: 0 },
    ), { now: 10_000, random: () => 1 });
    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
    expect(result.state.farm.plots["0:0"]).toBeUndefined();
    expect(result.state.balance.gold).toBe(385);
  });

  it("moves Plowing Monolith XP from plows to time-gated harvests", () => {
    const state = freshGameplayState();
    state.quests.completed = Object.keys(QUEST_DEFINITIONS);
    state.objects.objects.push({
      instanceId: "plow-monolith", catalogKey: "monolithPlowing", status: "placed",
    });
    const replowed = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.remove", oc: 0, or: 0 },
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.remove", oc: 0, or: 0 },
      { type: "farm.plow", oc: 0, or: 0 },
    ), { now: 1 });

    expect(replowed.results.every((entry) => entry.status === "applied")).toBe(true);
    expect(replowed.state.balance.gold).toBe(state.balance.gold);
    expect(replowed.state.balance.xp).toBe(state.balance.xp);

    replowed.state.farm.plots["4:0"] = {
      state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1,
      sell: 16, xp: 1, fertilized: false, zombie: false,
    };
    const harvested = applyCommandBatch(
      replowed.state,
      commands({ type: "farm.harvest", oc: 4, or: 0 }),
      { now: 1_000 }
    );
    expect(harvested.state.balance.xp - replowed.state.balance.xp).toBe(2);
  });

  it("Harvest power is one atomic command, orders zombies oldest-first, and leaves excess planted", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.zombieMax = 1;
    state.farm.plots = {
      "0:0": { state: "planted", cropKey: "carrot", plantedAt: 100, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:0": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 10, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "8:0": { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 20, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    };
    const ids = ["server-z1", "server-z2"];
    const result = applyCommandBatch(state, commands({ type: "power.use", key: "insta_harvest" }), {
      now: 1_000,
      id: () => ids.shift() ?? "unexpected",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("applied");
    expect(result.results[0].createdZombieSources).toEqual([{ id: "server-z1", oc: 4, or: 0 }]);
    expect(result.state.inventory.insta_harvest).toBe(0);
    expect(result.state.roster.find((unit) => unit.id === "server-z1")).toMatchObject({ key: "ZombieActorRegularTier1", stored: false });
    expect(result.state.farm.plots["4:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.farm.plots["8:0"]).toMatchObject({ state: "planted", cropKey: "ZombieActorGirlTier1" });
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "spent", zombie: false });
  });

  it("uses current catalog XP when harvesting a zombie plot with the old bad reward", () => {
    const state = freshGameplayState();
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "ZombieActorRegularTier1Carrots", plantedAt: 0,
      growMs: 1, sell: 0, xp: 900, fertilized: false, zombie: true,
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 0, or: 0 },
    ), { now: 1_000, id: () => "carrot-zombie" });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.xp).toBe(1);
  });

  it("authoritatively stacks four cardinal mutation crops to 100% at zombie harvest", () => {
    const state = freshGameplayState();
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      // Different plantedAt values represent different growth stages; all still count.
      "0:4": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
      "8:4": { state: "planted", cropKey: "carrot", plantedAt: 500, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:0": { state: "planted", cropKey: "carrot", plantedAt: 900, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:8": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
      "12:4": { state: "planted", cropKey: "tomato", plantedAt: 0, growMs: 99_999, sell: 30, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 4, or: 4 },
    ), { now: 1_000, random: () => 1, id: () => "mutated-zombie" });

    expect(result.results[0]).toMatchObject({
      status: "applied",
      createdIds: ["mutated-zombie"],
      createdZombieSources: [{ id: "mutated-zombie", oc: 4, or: 4 }],
    });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "mutated-zombie", mutation: 4,
    }));
  });

  it("rolls multiple non-conflicting adjacent crops independently", () => {
    const state = freshGameplayState();
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "0:4": { state: "planted", cropKey: "tomato", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "8:4": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "4:0": { state: "planted", cropKey: "celery", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "4:8": { state: "planted", cropKey: "lima_beans", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 4, or: 4 },
    ), { now: 1_000, random: () => 0.1, id: () => "multi-mutant" });
    expect(result.state.roster[0].mutation).toBe(1 | 4 | 64 | 1024);
  });

  it("makes an adjacent crop guaranteed with a placed Mutant Monolith", () => {
    const state = freshGameplayState();
    state.objects.objects.push({ instanceId: "mutation-monolith", catalogKey: "monolithMutation", status: "placed" });
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "0:4": { state: "planted", cropKey: "dragon_fruit", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "12:4": { state: "planted", cropKey: "tomato", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 4, or: 4 },
    ), { now: 1_000, random: () => 1, id: () => "guaranteed-mutant" });
    expect(result.state.roster[0].mutation).toBe(4096);
  });

  it("snapshots adjacency for atomic Insta-Harvest before removing ripe crops", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.farm.plots = {
      "0:4": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 1, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    };
    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "insta_harvest" },
    ), { now: 1_000, random: () => 0.1, id: () => "power-mutant" });
    expect(result.state.farm.plots["0:4"].state).toBe("spent");
    expect(result.state.roster[0].mutation).toBe(4);
  });

  it("keeps the Mutant Monolith's zombie growth reduction authoritative", () => {
    const state = freshGameplayState();
    state.balance.gold = 1_000;
    state.balance.xp = 50_000;
    state.objects.objects.push({ instanceId: "mutation-monolith", catalogKey: "monolithMutation", status: "placed" });
    state.farm.plots["0:0"] = { state: "plowed" };
    const result = applyCommandBatch(state, commands(
      { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1Carrots" },
    ), { now: 1, random: () => 1 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.farm.plots["0:0"]).toMatchObject({ growMs: 10_800_000 });
  });

  it("keeps a ripe zombie planted when the active army is full, even with storage room", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    state.objects.objects.push({ instanceId: "mausoleum", catalogKey: "mausoleum3", status: "placed" });
    state.roster.push({ id: "active", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false });
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 0,
      growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
    };

    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 0, or: 0 },
    ), { now: 1_000, id: () => "should-not-be-used" });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "capacity_full" });
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "planted", cropKey: "ZombieActorGirlTier1" });
    expect(result.state.roster).toHaveLength(1);
  });

  it("overflows an awarded gift zombie into full storage while manual storage stays capped", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    state.inventory.flower_zombie_pot = 1;
    state.objects.objects.push({ instanceId: "mausoleum", catalogKey: "mausoleum3", status: "placed" });
    state.roster.push({ id: "active", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false });
    for (let index = 0; index < 15; index++) {
      state.roster.push({ id: `stored-${index}`, key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true });
    }

    const manual = applyCommandBatch(state, commands(
      { type: "roster.status", unitId: "active", stored: true },
    ), { now: 1 });
    expect(manual.results[0]).toMatchObject({ status: "rejected", error: "storage_full" });

    const awarded = applyCommandBatch(state, commands(
      { type: "power.use", key: "flower_zombie_pot" },
    ), { now: 2, id: () => "overflow-award" });
    expect(awarded.results[0]).toMatchObject({ status: "applied", createdIds: ["overflow-award"] });
    expect(awarded.state.roster.find((unit) => unit.id === "overflow-award")).toMatchObject({
      key: "ZombieActorGardenTier3GreenFlower",
      stored: true,
    });
    expect(awarded.state.roster.filter((unit) => unit.stored)).toHaveLength(16);
  });

  it("does not consume Harvest power when capacity blocks its only ripe zombie", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.zombieMax = 1;
    state.roster.push({ id: "existing", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false });
    state.farm.plots["0:0"] = { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true };
    const result = applyCommandBatch(state, commands({ type: "power.use", key: "insta_harvest" }), { now: 1_000 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "no_effect" });
    expect(result.state.inventory.insta_harvest).toBe(1);
    expect(result.state.farm.plots["0:0"].state).toBe("planted");
  });

  it("consumes Insta-Grow when targeting a placed Zombie Pot", () => {
    const state = freshGameplayState();
    state.inventory.insta_grow = 1;
    state.objects.objects.push({ instanceId: "pot", catalogKey: "zombieCombiner", status: "placed" });
    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "insta_grow", target: "zombie_pot" }
    ), { now: 1 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.inventory.insta_grow).toBe(0);
  });

  it("accepts a restored Pot boost before collecting a rare special result", () => {
    const state = freshGameplayState();
    state.inventory.insta_grow = 1;
    state.balance.xp = 20_500;
    const [parentAId, parentBId] = rareCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorHeadlessTier3", mutation: 0, invasions: 0, stored: false },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "insta_grow", target: "zombie_pot" },
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 },
    ), { now: 1, id: () => "special-child" });

    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(result.state.inventory.insta_grow).toBe(0);
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "special-child",
      key: "ZombieActorHeadlessTier5",
    }));
  });

  it("accepts Insta-Grow in the harvest latency-grace window", () => {
    const state = freshGameplayState();
    state.inventory.insta_grow = 1;
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0,
      growMs: 60_000, sell: 0, xp: 1, fertilized: false, zombie: true,
    };
    // Harvest considers this ripe because of its 15-second network grace, while
    // the client still correctly displays five seconds of growth remaining.
    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "insta_grow", oc: 0, or: 0 }
    ), { now: 55_000 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.inventory.insta_grow).toBe(0);
  });

  it("Plow power changes spent plots only and is not consumed on no-op", () => {
    const state = freshGameplayState();
    state.inventory.insta_plow = 2;
    state.farm.plots = {
      "0:0": { state: "spent" },
      "4:0": { state: "plowed" },
      "8:0": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
    };
    const first = applyCommandBatch(state, commands({ type: "power.use", key: "insta_plow" }), { now: 1 });
    expect(first.results[0].status).toBe("applied");
    expect(first.state.inventory.insta_plow).toBe(1);
    expect(first.state.farm.plots["0:0"].state).toBe("plowed");
    expect(first.state.farm.plots["8:0"].state).toBe("planted");
    const second = applyCommandBatch(first.state, commands({ type: "power.use", key: "insta_plow" }), { now: 2 });
    expect(second.results[0]).toMatchObject({ status: "rejected", error: "no_effect" });
    expect(second.state.inventory.insta_plow).toBe(1);
  });

  it("coalesces duplicate tree ids and aggregates rewards into state once", () => {
    const state = freshGameplayState();
    state.objects.objects.push({ instanceId: "tree-1", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 });
    const result = applyCommandBatch(state, commands({ type: "object.harvest_trees", instanceIds: ["tree-1", "tree-1"] }), { now: 100 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.gold).toBeGreaterThan(200);
    expect(result.state.objects.objects[0].readyAt).toBeGreaterThan(100);
  });

  it("adds 1 xp per harvested fruit tree with a placed Plowing Monolith", () => {
    const state = freshGameplayState();
    state.objects.objects.push(
      { instanceId: "monolith", catalogKey: "monolithPlowing", status: "placed" },
      { instanceId: "tree-1", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 },
      { instanceId: "tree-2", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 },
    );
    const result = applyCommandBatch(
      state,
      commands({ type: "object.harvest_trees", instanceIds: ["tree-1", "tree-2"] }),
      { now: 100 }
    );
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.xp - state.balance.xp).toBe(2);
  });

  it("adopts the untracked free starter shed on its first paid upgrade", () => {
    const state = freshGameplayState();
    state.balance.gold = 20_000;
    const upgraded = applyCommandBatch(state, commands({
      type: "object.upgrade",
      instanceId: "starter-shed",
      catalogKey: "storage02",
    }), { now: 100 });

    expect(upgraded.results[0].status).toBe("applied");
    expect(upgraded.state.balance.gold).toBe(5_000);
    expect(upgraded.state.objects.objects).toContainEqual({
      instanceId: "starter-shed",
      catalogKey: "storage02",
      status: "placed",
    });

    const invalidMissingSource = applyCommandBatch(upgraded.state, commands({
      type: "object.upgrade",
      instanceId: "not-owned",
      catalogKey: "storage03",
    }), { now: 101 });
    expect(invalidMissingSource.results[0]).toMatchObject({ status: "rejected", error: "not_owned" });
  });

  it("persists Zombie Pot ownership and charges the permanent repeat price", () => {
    const state = freshGameplayState();
    state.balance.gold = 1_000;
    state.balance.brains = 100;
    state.balance.xp = 75; // level 3 unlocks the Zombie Pot

    const bought = applyCommandBatch(state, commands(
      { type: "object.buy", catalogKey: "zombieCombiner", clientInstanceId: "pot-1" },
      { type: "object.buy", catalogKey: "zombieCombiner", clientInstanceId: "pot-2" },
    ), { now: 100 });

    expect(bought.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(bought.state.zombiePotBought).toBe(true);
    expect(bought.state.balance.gold).toBe(500);
    expect(bought.state.balance.brains).toBe(97); // 3 spent on the repeat pot; leveling grants no brains
    expect(bought.state.objects.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: "pot-1", catalogKey: "zombieCombiner", purchaseCost: 500, purchaseCurrency: "gold" }),
      expect.objectContaining({ instanceId: "pot-2", catalogKey: "zombieCombiner", purchaseCost: 3, purchaseCurrency: "brains" }),
    ]));

    const sold = applyCommandBatch(bought.state, commands(
      { type: "object.refund", instanceId: "pot-1" },
      { type: "object.refund", instanceId: "pot-2" },
    ), { now: 101 });
    expect(sold.state.balance.gold).toBe(600);
    expect(sold.state.balance.brains).toBe(98); // +1 refund on the 3-brain repeat pot (floor(3*0.2)=0 → min 1)
    expect(sold.state.zombiePotBought).toBe(true);
  });

  it("advances the Apple Harvest quest for a harvested Apple Tree", () => {
    const state = freshGameplayState();
    state.quests.completed = ["62"];
    state.objects.objects.push({
      instanceId: "apple-tree",
      catalogKey: "fruitTreeApple",
      status: "placed",
      readyAt: 100,
    });
    const result = applyCommandBatch(state, commands(
      { type: "object.harvest_trees", instanceIds: ["apple-tree"] }
    ), { now: 100 });
    expect(result.results[0].status).toBe("applied");
    expect(result.questChanges).toContainEqual(expect.objectContaining({
      questId: "63",
      counts: [1],
      completed: false,
    }));
  });

  it("derives combine output and id from server-held parents", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 1, invasions: 5, stored: false },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 2, invasions: 9, stored: false },
    ];
    const result = applyCommandBatch(state, commands({ type: "roster.combine", parentAId: "a", parentBId: "b" }), {
      now: 1,
      random: () => 0,
      id: () => "server-child",
    });
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["server-child"] });
    expect(result.state.roster).toEqual([
      { id: "server-child", key: "ZombieActorRegularTier1", mutation: 2, invasions: 0, stored: false },
    ]);
  });

  it("consumes both active parent slots when a timed Pot starts", () => {
    const state = freshGameplayState();
    state.zombieMax = 2;
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 1, invasions: 0, stored: false },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 2, invasions: 0, stored: false },
    ];
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "ZombieActorHeadlessTier1", plantedAt: 0,
      growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
    };

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine_start", potId: "pot-1", parentAId: "a", parentBId: "b" },
      { type: "farm.harvest", oc: 0, or: 0 },
    ), { now: 1_000, id: () => "harvested" });

    expect(result.results).toEqual([
      { sequence: 1, status: "applied" },
      { sequence: 2, status: "applied", createdIds: ["harvested"],
        createdZombieSources: [{ id: "harvested", oc: 0, or: 0 }] },
    ]);
    expect(result.state.roster.filter((unit) => !unit.stored).map((unit) => unit.id))
      .toEqual(["harvested"]);
    expect(result.state.roster.filter((unit) => unit.lockedByRaid === "pot:pot-1").map((unit) => unit.id))
      .toEqual(["a", "b"]);
  });

  it("keeps a ready Pot pending while all active slots are full", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    state.roster = [
      { id: "active", key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: "a", key: "ZombieActorRegularTier1", mutation: 1, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 2, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "a", parentBId: "b" },
    ), { now: 1, id: () => "child" });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "capacity_full" });
    expect(result.state.roster).toEqual(state.roster);
  });

  it("replaces reserved parents with one active child when a slot is free", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 1, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 2, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "a", parentBId: "b" },
    ), { now: 1, id: () => "child" });

    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["child"] });
    expect(result.state.roster).toEqual([
      { id: "child", key: "ZombieActorRegularTier1", mutation: 2, invasions: 0, stored: false },
    ]);
  });

  it("stores a combine award when stored parents do not free an active slot", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    state.roster = [
      { id: "active", key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
    ), { now: 1, id: () => "stored-child" });

    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["stored-child"] });
    expect(result.state.roster.find((unit) => unit.id === "stored-child")).toMatchObject({ stored: true });
  });

  it("uses a mutant only as the mutation donor and never invents mutations", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "crazy", key: "ZombieActorRegularCrazy", mutation: 0, invasions: 0, stored: false },
      { id: "tomato", key: "ZombieActorRegularTier1Tomatoes", mutation: 1, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "crazy", parentBId: "tomato" }
    ), { now: 1, random: () => 0.99, id: () => "child" });
    expect(result.state.roster).toEqual([
      { id: "child", key: "ZombieActorRegularCrazy", mutation: 1, invasions: 0, stored: false },
    ]);
  });

  it("does not let the Zombie Pot clone an Epic reward zombie", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "epic", key: "ZombieActorBandido", mutation: 0, invasions: 0, stored: false },
      { id: "base", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "epic", parentBId: "base" }
    ), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "reward_only" });
    expect(result.state.roster).toHaveLength(2);
  });

  it("rejects a pair of otherwise-combinable specials", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "crazy", key: "ZombieActorRegularCrazy", mutation: 0, invasions: 0, stored: false },
      { id: "bombie", key: "ZombieActorBombie", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "crazy", parentBId: "bombie" }
    ), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "special_pair" });
    expect(result.state.roster).toHaveLength(2);
  });

  it("makes one combinable special the guaranteed output species", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "crazy", key: "ZombieActorRegularCrazy", mutation: 0, invasions: 0, stored: false },
      { id: "silver", key: "ZombieActorLargeTier4", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "crazy", parentBId: "silver" }
    ), { now: 1, random: () => 0.99, id: () => "child" });
    expect(result.state.roster[0].key).toBe("ZombieActorRegularCrazy");
  });

  it("awards the matching combining special on a successful level-25 roll", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    const [parentAId, parentBId] = rareCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorHeadlessTier3", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster[0].key).toBe("ZombieActorHeadlessTier5");
  });

  it("does not unlock the rare roll when the combine started below level 25", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    const [parentAId, parentBId] = rareCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorHeadlessTier3", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 24 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster[0].key).toBe("ZombieActorHeadlessTier3");
  });

  it("advances the parent-pair combine quest when the result is collected", () => {
    const state = freshGameplayState();
    state.quests.completed = ["55"];
    state.roster = [
      { id: "carrot", key: "ZombieActorRegularTier1Carrots", mutation: 4, invasions: 0, stored: false },
      { id: "tomato", key: "ZombieActorRegularTier1Tomatoes", mutation: 1, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "carrot", parentBId: "tomato" }
    ), { now: 1, id: () => "combined-zombie" });
    expect(result.results[0].status).toBe("applied");
    expect(result.questChanges).toContainEqual(expect.objectContaining({ questId: "56", completed: true }));
  });

  it("grants the tutorial completion bonus exactly once", () => {
    const state = freshGameplayState();
    const first = applyCommandBatch(state, commands({ type: "tutorial.complete" }), { now: 1 });
    expect(first.results[0].status).toBe("applied");
    expect(first.state.balance.gold).toBe(600);
    expect(first.state.tutorialRewarded).toBe(true);
    const repeated = applyCommandBatch(first.state, commands({ type: "tutorial.complete" }), { now: 2 });
    expect(repeated.results[0]).toMatchObject({ status: "rejected", error: "already_claimed" });
    expect(repeated.state.balance.gold).toBe(600);
  });

  it("atomically claims Received rewards into inventory or owned objects", () => {
    const state = freshGameplayState();
    state.storage.received = { "Insta-Plow": 1, Windmill: 1 };
    const result = applyCommandBatch(state, commands(
      { type: "storage.claim", itemName: "Insta-Plow" },
      { type: "storage.claim", itemName: "Windmill", clientInstanceId: "reward-windmill" },
    ), { now: 10, id: () => "unused" });
    expect(result.results).toEqual([
      { sequence: 1, status: "applied" },
      { sequence: 2, status: "applied", createdIds: ["reward-windmill"] },
    ]);
    expect(result.state.storage.received).toEqual({ "Insta-Plow": 0, Windmill: 0 });
    expect(result.state.inventory.insta_plow).toBe(1);
    expect(result.state.objects.objects).toContainEqual(expect.objectContaining({
      instanceId: "reward-windmill", catalogKey: "windmill", status: "placed",
    }));
  });

  it("cannot claim a Received reward twice", () => {
    const state = freshGameplayState();
    state.storage.received = { "Insta-Plow": 1 };
    const result = applyCommandBatch(state, commands(
      { type: "storage.claim", itemName: "Insta-Plow" },
      { type: "storage.claim", itemName: "Insta-Plow" },
    ), { now: 10 });
    expect(result.results[0].status).toBe("applied");
    expect(result.results[1]).toMatchObject({ status: "rejected", error: "none_owned" });
    expect(result.state.inventory.insta_plow).toBe(1);
  });

  it("advances the complete Dr. Groundhog milestone chain only when Epic processing is enabled", () => {
    const state = freshGameplayState();
    const groundhog = new Set(["1000", "1001", "1002", "1003", "1010", "1011"]);
    const event = (level: number) => [{
      type: "kEpicStageEnemyDefeatedNotification",
      subject: String(level),
    }];
    expect(applyQuestEvents(state.balance, state.quests, event(5))).toEqual([]);
    expect(applyQuestEvents(state.balance, state.quests, event(5), { includeEpic: true, epicQuestIds: groundhog }))
      .toContainEqual(expect.objectContaining({ questId: "1000", completed: true }));
    expect(applyQuestEvents(state.balance, state.quests, event(10), { includeEpic: true, epicQuestIds: groundhog }))
      .toContainEqual(expect.objectContaining({ questId: "1001", completed: true }));
    const brains = state.balance.brains;
    expect(applyQuestEvents(state.balance, state.quests, event(15), { includeEpic: true, epicQuestIds: groundhog }))
      .toContainEqual(expect.objectContaining({ questId: "1002", completed: true }));
    expect(state.balance.brains).toBe(brains + 1);
    const final = applyQuestEvents(state.balance, state.quests, event(20), { includeEpic: true, epicQuestIds: groundhog });
    expect(final).toEqual(expect.arrayContaining([
      expect.objectContaining({ questId: "1003", completed: true }),
      expect.objectContaining({ questId: "1011", completed: true }),
    ]));
  });
});
