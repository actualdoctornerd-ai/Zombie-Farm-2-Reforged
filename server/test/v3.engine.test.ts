import { describe, expect, it } from "vitest";
import type { RosterUnitProjection, SequencedCommand } from "../../src/net/protocol";
import { DR_GROUNDHOG, EPIC_BOSSES } from "../../src/epicBoss/catalog";
import { XP_THRESHOLDS } from "../src/levels";
import { COMBINE_SPECIAL_CHANCE, createCombineRandom } from "../../src/zombie/combineSpecies";
import { encodeReceivedZombie } from "../../src/zombie/receivedReward";
import { EPIC_PRIZE_SELL, RAID_DROP_SELL } from "../../src/awardSellValue";
import plantRows from "../../public/assets/plants.json";
import {
  applyCommandBatch,
  applyQuestEvents,
  freshGameplayState,
  zombieDefaultMutation,
  type MutableGameplayState,
} from "../src/v3/engine";
import { QUEST_DEFINITIONS } from "../src/questCatalog";

const commands = (...values: SequencedCommand["command"][]): SequencedCommand[] =>
  values.map((command, index) => ({ sequence: index + 1, command }));

const rareCombinePairIds = (): [string, string] => {
  for (let index = 0; index < 10_000; index++) {
    const ids: [string, string] = [`rare-a-${index}`, `rare-b-${index}`];
    if (createCombineRandom(...ids)() < COMBINE_SPECIAL_CHANCE) return ids;
  }
  throw new Error("could not find deterministic rare-combine test pair");
};

/** The inverse: a pair whose stable roll misses the tier-5 promotion, so the
 *  ordinary rules (slot 1 / matched-pair silver) decide the species. Both helpers
 *  read the live chance — hardcoding it let a retune silently reclassify a pair. */
const commonCombinePairIds = (): [string, string] => {
  for (let index = 0; index < 10_000; index++) {
    const ids: [string, string] = [`common-a-${index}`, `common-b-${index}`];
    if (createCombineRandom(...ids)() >= COMBINE_SPECIAL_CHANCE) return ids;
  }
  throw new Error("could not find deterministic common-combine test pair");
};

describe("protocol v3 command engine", () => {
  it("starts fresh players with the tutorial's one-brain balance", () => {
    expect(freshGameplayState().balance).toEqual({ gold: 400, brains: 1, xp: 0 });
  });

  it("can claim the ordered writer lane without changing gameplay state", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands({ type: "writer.claim" }), { now: 1 });
    expect(result.results).toEqual([{ sequence: 1, status: "applied" }]);
    expect(result.state).toEqual(state);
  });

  it("resets the authoritative invasion cooldown when XP crosses a level", () => {
    const state = freshGameplayState();
    state.balance.xp = 24;
    state.raids.lastRaidAt = 123_456;
    const result = applyCommandBatch(state, commands({ type: "farm.plow", oc: 0, or: 0 }), { now: 1 });
    expect(result.state.balance.xp).toBe(25);
    expect(result.state.raids.lastRaidAt).toBe(0);
  });

  it("keeps the invasion cooldown when XP does not cross a level", () => {
    const state = freshGameplayState();
    state.raids.lastRaidAt = 123_456;
    const result = applyCommandBatch(state, commands({ type: "farm.plow", oc: 0, or: 0 }), { now: 1 });
    expect(result.state.raids.lastRaidAt).toBe(123_456);
  });

  it("authoritatively buys, equips, and hides cosmetic pets", () => {
    const state = freshGameplayState();
    state.balance.brains = 10_000;
    expect(state.ownedPets).toEqual([]);
    expect(state.activePet).toBeNull();

    const bought = applyCommandBatch(state, commands({ type: "pet.buy", petKey: "catActor" }), { now: 1 });
    expect(bought.results[0]).toMatchObject({ status: "applied" });
    expect(bought.state.balance.brains).toBe(state.balance.brains - 5);
    expect(bought.state.balance.xp).toBe(state.balance.xp + 500);
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
    state.balance.brains = 4;
    expect(applyCommandBatch(state, commands({ type: "pet.buy", petKey: "catActor" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "insufficient" });
    expect(applyCommandBatch(freshGameplayState(), commands({ type: "pet.buy", petKey: "not-a-pet" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "bad_item" });
    expect(applyCommandBatch(freshGameplayState(), commands({ type: "pet.buy", petKey: "bullyfrogpetActor" }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "bad_item" });
  });

  it("starts with free Farmer heads and authoritatively buys a priced head once", () => {
    const state = freshGameplayState();
    state.balance.brains = 20;
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

  it("pays XP for a bought head, priced off the head's own cost", () => {
    const state = freshGameplayState();
    state.balance.brains = 40;
    // Paper Bag: 15 brains, carries a bonus, so the functional rate (cost * 80).
    const functional = applyCommandBatch(state, commands({ type: "farmer.buy", headId: 12 }), { now: 1 });
    expect(functional.state.balance.xp - state.balance.xp).toBe(1_200);
    // Jester Mask: same 15 brains but purely cosmetic, so the decor rate (cost * 100).
    const cosmetic = applyCommandBatch(functional.state, commands({ type: "farmer.buy", headId: 15 }), { now: 2 });
    expect(cosmetic.state.balance.xp - functional.state.balance.xp).toBe(1_500);
  });

  it("refuses to pay for a head it rejects", () => {
    const state = freshGameplayState();
    state.balance.brains = 1; // can't afford the 15-brain head
    const broke = applyCommandBatch(state, commands({ type: "farmer.buy", headId: 12 }), { now: 1 });
    expect(broke.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(broke.state.balance.xp).toBe(state.balance.xp);
  });

  it("pins a bonus head independently of the one being worn", () => {
    const state = freshGameplayState();
    state.farmerHeads.push(12, 15);
    const pinned = applyCommandBatch(state, commands({ type: "farmer.bonus", headId: 12 }), { now: 1 });
    expect(pinned.results[0]).toMatchObject({ status: "applied" });
    expect(pinned.state.farmerBonusHeadId).toBe(12);

    // Wearing the cosmetic must not disturb the pinned bonus.
    const worn = applyCommandBatch(pinned.state, commands({ type: "farmer.equip", headId: 15 }), { now: 2 });
    expect(worn.state.farmerHeadId).toBe(15);
    expect(worn.state.farmerBonusHeadId).toBe(12);

    const cleared = applyCommandBatch(worn.state, commands({ type: "farmer.bonus", headId: null }), { now: 3 });
    expect(cleared.state.farmerBonusHeadId).toBeNull();
  });

  it("rejects pinning a head that is unowned or has no bonus", () => {
    const state = freshGameplayState();
    state.farmerHeads.push(15);
    expect(applyCommandBatch(state, commands({ type: "farmer.bonus", headId: 12 }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "not_owned" });
    expect(applyCommandBatch(state, commands({ type: "farmer.bonus", headId: 15 }), { now: 1 }).results[0])
      .toMatchObject({ status: "rejected", error: "bad_item" });
  });

  it("harvests with the PINNED head's bonus, not the worn one's", () => {
    const state = freshGameplayState();
    state.farmerHeads.push(12, 15);
    state.farmerHeadId = 15; // wearing a cosmetic
    state.farmerBonusHeadId = 12; // +10% harvest gold pinned
    state.farm.plots["0:0"] = {
      state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1,
      sell: 100, xp: 1, fertilized: false, zombie: false,
    };
    const harvested = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 0, or: 0 }), { now: 1_000 });
    expect(harvested.state.balance.gold - state.balance.gold).toBe(110);
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

  // The token roll now belongs to the client (see `epicBoss.token` in net/protocol.ts):
  // harvesting must not mint one server-side, and the reporting command is taken on
  // trust for the RUNNING event only.
  const activeRun = () => ({
    runId: "run", bossId: "dr-groundhog", activatedAt: 1, expiresAt: 10_000,
    level: 1, maxHp: 2_000, currentHp: 2_000, encounterStartedAt: 0,
    retryReadyAt: 0, tokenCount: 2, completedAt: 0, attackOrder: [],
  });
  const ripeCrop = () => ({
    state: "planted" as const, cropKey: "lima_beans", plantedAt: -86_400_000, growMs: 86_400_000,
    sell: 205, xp: 1, fertilized: false, zombie: false,
  });

  it("does not roll crop tokens server-side any more", () => {
    const state = freshGameplayState();
    state.epicBoss = activeRun();
    state.farm.plots["0:0"] = ripeCrop();
    // random() === 0 wins every roll the old authoritative path could have made.
    const harvested = applyCommandBatch(state, commands({ type: "farm.harvest", oc: 0, or: 0 }), {
      now: 1_000, random: () => 0,
    });
    expect(harvested.results[0].status).toBe("applied");
    expect(harvested.state.epicBoss?.tokenCount).toBe(2);
  });

  it("records client-rolled tokens without re-checking the roll", () => {
    const state = freshGameplayState();
    state.epicBoss = activeRun();
    const granted = applyCommandBatch(state, commands(
      { type: "epicBoss.token", runId: "run" },
      { type: "epicBoss.token", runId: "run", count: 3 },
    ), { now: 1_000 });
    expect(granted.results.every((r) => r.status === "applied")).toBe(true);
    expect(granted.state.epicBoss?.tokenCount).toBe(6);
  });

  it("drops token grants naming a stale, finished or expired event", () => {
    const wrongRun = freshGameplayState();
    wrongRun.epicBoss = activeRun();
    const stale = applyCommandBatch(wrongRun, commands({ type: "epicBoss.token", runId: "other" }), { now: 1_000 });
    expect(stale.results[0].status).toBe("rejected");
    expect(stale.state.epicBoss?.tokenCount).toBe(2);

    const expired = freshGameplayState();
    expired.epicBoss = { ...activeRun(), expiresAt: 999 };
    const late = applyCommandBatch(expired, commands({ type: "epicBoss.token", runId: "run" }), { now: 1_000 });
    expect(late.results[0].status).toBe("rejected");
    expect(late.state.epicBoss?.tokenCount).toBe(2);

    const done = freshGameplayState();
    done.epicBoss = { ...activeRun(), completedAt: 900 };
    const after = applyCommandBatch(done, commands({ type: "epicBoss.token", runId: "run" }), { now: 1_000 });
    expect(after.results[0].status).toBe("rejected");
    expect(after.state.epicBoss?.tokenCount).toBe(2);
  });

  it("refuses an out-of-range token count", () => {
    const state = freshGameplayState();
    state.epicBoss = activeRun();
    const absurd = applyCommandBatch(state, commands({ type: "epicBoss.token", runId: "run", count: 5_000 }), { now: 1_000 });
    expect(absurd.results[0].status).toBe("rejected");
    expect(absurd.state.epicBoss?.tokenCount).toBe(2);
  });

  // The event LURE is the opposite call from the token roll above: it is worth a whole
  // activation and reopens the boss's prize chain, so it stays server-side.
  describe("favourite crop event lure", () => {
    const potatoPlot = () => ({
      state: "planted" as const, cropKey: "potato", plantedAt: -86_400_000, growMs: 86_400_000,
      sell: 99, xp: 5, fertilized: false, zombie: false,
    });
    // Dr. Groundhog unlocks at 24, and potato is its favourite.
    const eligible = () => {
      const state = freshGameplayState();
      state.balance.xp = XP_THRESHOLDS[23];
      state.farm.plots["0:0"] = potatoPlot();
      return state;
    };
    const harvest = (state: MutableGameplayState, random: () => number) =>
      applyCommandBatch(state, commands({ type: "farm.harvest", oc: 0, or: 0 }), { now: 1_000, random });

    it("starts the crop's own event, free, and records the crop that did it", () => {
      const state = eligible();
      const brainsBefore = state.balance.brains;
      const lured = harvest(state, () => 0);
      expect(lured.results[0].status).toBe("applied");
      expect(lured.state.epicBoss?.bossId).toBe("dr-groundhog");
      expect(lured.state.epicBoss?.startedCrop).toBe("potato");
      expect(lured.state.epicBoss?.level).toBe(1);
      expect(lured.state.epicBoss?.tokenCount).toBe(0);
      expect(lured.state.epicBoss?.expiresAt).toBe(1_000 + DR_GROUNDHOG.durationMs);
      // Free means free: harvest gold is still paid, and nothing is deducted for it.
      expect(lured.state.balance.brains).toBe(brainsBefore);
    });

    it("reopens that boss's finished quests exactly as a paid activation does", () => {
      const state = eligible();
      const questId = DR_GROUNDHOG.questIds[0];
      state.quests.completed.push(questId);
      state.quests.progress.push({ questId, counts: [1] });
      const lured = harvest(state, () => 0);
      expect(lured.state.quests.completed).not.toContain(questId);
      expect(lured.state.quests.progress.some((entry) => entry.questId === questId)).toBe(false);
      expect(lured.questChanged).toBe(true);
    });

    it("never lures while an event is already running", () => {
      const state = eligible();
      state.epicBoss = activeRun();
      const harvested = harvest(state, () => 0);
      expect(harvested.state.epicBoss?.runId).toBe("run");
      expect(harvested.state.epicBoss?.startedCrop).toBeUndefined();
    });

    // An expired or completed run is not a running one, so the farm is eligible again.
    it("lures over a finished or expired run", () => {
      const expired = eligible();
      expired.epicBoss = { ...activeRun(), expiresAt: 999 };
      expect(harvest(expired, () => 0).state.epicBoss?.startedCrop).toBe("potato");

      const done = eligible();
      done.epicBoss = { ...activeRun(), completedAt: 900 };
      expect(harvest(done, () => 0).state.epicBoss?.startedCrop).toBe("potato");
    });

    it("stays silent below the boss's unlock level", () => {
      const state = eligible();
      state.balance.xp = XP_THRESHOLDS[22]; // level 23, one short of Dr. Groundhog
      expect(harvest(state, () => 0).state.epicBoss).toBeNull();
    });

    it("ignores a crop that is nobody's favourite", () => {
      const state = eligible();
      state.farm.plots["0:0"] = { ...potatoPlot(), cropKey: "carrot", growMs: 900_000 };
      expect(harvest(state, () => 0).state.epicBoss).toBeNull();
    });

    it("loses the roll on an ordinary harvest", () => {
      expect(harvest(eligible(), () => 0.99).state.epicBoss).toBeNull();
    });

    // A field-wide Insta-Harvest rolls every plot it pulls. It may start ONE event.
    it("starts at most one event per Insta-Harvest sweep", () => {
      const state = eligible();
      state.balance.xp = XP_THRESHOLDS[23];
      state.inventory["insta_harvest"] = 1;
      for (let plot = 0; plot < 6; plot++) state.farm.plots[`${plot * 4}:0`] = potatoPlot();
      const swept = applyCommandBatch(
        state, commands({ type: "power.use", key: "insta_harvest" }), { now: 1_000, random: () => 0 }
      );
      expect(swept.results[0].status).toBe("applied");
      expect(swept.state.epicBoss?.startedCrop).toBe("potato");
      expect(swept.state.epicBoss?.runId).toBeTruthy();
      // Every plot was still harvested; only the extra ACTIVATIONS are suppressed.
      expect(Object.values(swept.state.farm.plots).every((plot) => plot.state === "spent")).toBe(true);
    });
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
    // The free-placed plot costs 45 gold, and buying Insta-Grow consumes the
    // fresh account's one starter brain.
    expect(result.state.balance).toMatchObject({ gold: 355, brains: 0 });
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

  it("persists the client fertilization result for vegetables only", () => {
    const state = freshGameplayState();
    const result = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot", fertilized: true },
      { type: "farm.plow", oc: 4, or: 0 },
      { type: "farm.plant", oc: 4, or: 0, cropKey: "ZombieActorRegularTier1", fertilized: true },
    ), { now: 1_000, random: () => 1 });

    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
    expect(result.state.farm.plots["0:0"]).toMatchObject({ fertilized: true, zombie: false });
    expect(result.state.farm.plots["4:0"]).toMatchObject({ fertilized: false, zombie: true });
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

  it("grants a quest item reward into the authoritative Received bucket", () => {
    const state = freshGameplayState();
    state.balance.xp = 1_000_000; // clear quest 45's level 12 gate
    // Quest 45 "Big Top Bash": beat Zombies vs Circus three times -> Circus Popcorn.
    for (let i = 0; i < 3; i++) {
      applyQuestEvents(state.balance, state.quests, [
        { type: "kInvasionSuccessfulNotification", subject: "Zombies vs Circus" },
      ], { inventory: state.inventory, storage: state.storage });
    }

    expect(state.quests.completed).toContain("45");
    expect(state.storage.received["Circus Popcorn"]).toBe(1);
  });

  it("grants a quest boost reward into the authoritative inventory", () => {
    const state = freshGameplayState();
    state.quests.completed = ["1002"]; // quest 1003's prerequisite
    // Epic quest 1003 pays a Golden Dice at the top of the ladder — rung 10 since the
    // 20 authored rungs were merged in pairs (prep_all_epic_bosses.multipliers).
    applyQuestEvents(state.balance, state.quests, [
      { type: "kEpicStageEnemyDefeatedNotification", subject: "10" },
    ], {
      includeEpic: true,
      epicQuestIds: new Set(["1003"]),
      inventory: state.inventory,
      storage: state.storage,
    });

    expect(state.quests.completed).toContain("1003");
    expect(state.inventory.golden_dice).toBe(1);
    // A boost is never ALSO parked in Received.
    expect(state.storage.received["Golden Dice"]).toBeUndefined();
  });

  it("leaves item rewards dormant when no sink is supplied", () => {
    const state = freshGameplayState();
    state.balance.xp = 1_000_000;
    for (let i = 0; i < 3; i++) {
      applyQuestEvents(state.balance, state.quests, [
        { type: "kInvasionSuccessfulNotification", subject: "Zombies vs Circus" },
      ]);
    }
    expect(state.quests.completed).toContain("45");
    expect(state.storage.received["Circus Popcorn"]).toBeUndefined();
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

  it("keeps all four zombie plots when Insta-Harvest has only two army slots", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.zombieMax = 2;
    state.farm.plots = {
      "0:0": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:0": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 10, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "8:0": { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 20, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "12:0": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 30, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "16:0": { state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 40, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    };
    let id = 0;

    const result = applyCommandBatch(
      state,
      commands({ type: "power.use", key: "insta_harvest" }),
      { now: 1_000, id: () => `harvest-${++id}` },
    );

    expect(result.state.roster).toHaveLength(2);
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "spent", zombie: false });
    expect(result.state.farm.plots["4:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.farm.plots["8:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.farm.plots["12:0"]).toMatchObject({ state: "planted", zombie: true });
    expect(result.state.farm.plots["16:0"]).toMatchObject({ state: "planted", zombie: true });
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

  it("authoritatively stacks touching mutation crops to 100% at zombie harvest", () => {
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

  it("allows mutation crops on all four diagonal plots", () => {
    const state = freshGameplayState();
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "0:0": { state: "planted", cropKey: "tomato", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "8:0": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "0:8": { state: "planted", cropKey: "celery", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "8:8": { state: "planted", cropKey: "lima_beans", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      // Two plots away does not touch and must not contribute.
      "12:12": { state: "planted", cropKey: "dragon_fruit", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 4, or: 4 },
    ), { now: 1_000, random: () => 0.1, id: () => "diagonal-mutant" });

    expect(result.state.roster[0].mutation).toBe(1 | 4 | 64 | 1024);
  });

  it("mutates from crops that touch off the zombie plot's lattice", () => {
    const state = freshGameplayState();
    // Plots plowed in a second stroke share no lattice with the zombie's: these four
    // sit flush against its footprint at origins that are not (±4, ±4) away.
    state.farm.plots = {
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 0, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
      "1:0": { state: "planted", cropKey: "tomato", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "6:0": { state: "planted", cropKey: "carrot", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "0:6": { state: "planted", cropKey: "celery", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "8:7": { state: "planted", cropKey: "lima_beans", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      // Still one clear tile short of touching, on either axis.
      "9:4": { state: "planted", cropKey: "dragon_fruit", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
      "4:9": { state: "planted", cropKey: "garlic", plantedAt: 999, growMs: 99_999, sell: 1, xp: 1, fertilized: false, zombie: false },
    };
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 4, or: 4 },
    ), { now: 1_000, random: () => 0.1, id: () => "offgrid-mutant" });

    expect(result.state.roster[0].mutation).toBe(1 | 4 | 64 | 1024);
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

  it("snapshots diagonal mutation crops for atomic Insta-Harvest", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.farm.plots = {
      "0:0": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 1, sell: 16, xp: 1, fertilized: false, zombie: false },
      "4:4": { state: "planted", cropKey: "ZombieActorRegularTier1", plantedAt: 1, growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true },
    };
    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "insta_harvest" },
    ), { now: 1_000, random: () => 0.1, id: () => "diagonal-power-mutant" });

    expect(result.state.farm.plots["0:0"].state).toBe("spent");
    expect(result.state.roster[0].mutation).toBe(4);
  });

  it("harvests ripe fruit trees in the same Insta-Harvest activation", () => {
    const state = freshGameplayState();
    state.inventory.insta_harvest = 1;
    state.objects.objects.push(
      { instanceId: "monolith", catalogKey: "monolithPlowing", status: "placed" },
      { instanceId: "ripe-tree", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 },
      { instanceId: "growing-tree", catalogKey: "fruitTreeApple", status: "placed", readyAt: 2_000 },
    );
    const goldBefore = state.balance.gold;
    const xpBefore = state.balance.xp;

    const result = applyCommandBatch(
      state,
      commands({ type: "power.use", key: "insta_harvest" }),
      { now: 1_000 },
    );

    expect(result.results[0].status).toBe("applied");
    expect(result.state.inventory.insta_harvest).toBe(0);
    expect(result.state.balance.gold).toBeGreaterThan(goldBefore);
    expect(result.state.balance.xp).toBe(xpBefore);
    expect(result.state.objects.objects[1].readyAt).toBeGreaterThan(1_000);
    expect(result.state.objects.objects[2].readyAt).toBe(2_000);
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

  it("stores a ripe zombie in the Mausoleum when the active army is full", () => {
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
    ), { now: 1_000, id: () => "stored-harvest" });

    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["stored-harvest"] });
    expect(result.state.farm.plots["0:0"]).toMatchObject({ state: "spent", zombie: true });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "stored-harvest", key: "ZombieActorGirlTier1", stored: true,
    }));
  });

  it("refuses every queued harvest once the army is full with no Mausoleum", () => {
    const state = freshGameplayState();
    state.zombieMax = 16;
    state.roster = Array.from({ length: 16 }, (_unit, i) => ({
      id: `z${i}`, key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false,
    }));
    for (const oc of [0, 4, 8]) {
      state.farm.plots[`${oc}:0`] = {
        state: "planted", cropKey: "ZombieActorGirlTier1", plantedAt: 0,
        growMs: 1, sell: 0, xp: 1, fertilized: false, zombie: true,
      };
    }

    // A client whose own fences failed still cannot push a 17th zombie through: each
    // ripe crop is rejected and stays in the ground, ready to harvest after a sale.
    const result = applyCommandBatch(state, commands(
      { type: "farm.harvest", oc: 0, or: 0 },
      { type: "farm.harvest", oc: 4, or: 0 },
      { type: "farm.harvest", oc: 8, or: 0 },
    ), { now: 1_000, id: () => "must-not-exist" });

    expect(result.results).toEqual([
      { sequence: 1, status: "rejected", error: "capacity_full" },
      { sequence: 2, status: "rejected", error: "capacity_full" },
      { sequence: 3, status: "rejected", error: "capacity_full" },
    ]);
    expect(result.state.roster).toHaveLength(16);
    for (const oc of [0, 4, 8]) {
      expect(result.state.farm.plots[`${oc}:0`]).toMatchObject({ state: "planted" });
    }
  });

  it("rejects removed zombie-purchase powers even if stale inventory contains one", () => {
    const state = freshGameplayState();
    state.inventory.flower_zombie_pot = 1;
    const result = applyCommandBatch(state, commands(
      { type: "power.use", key: "flower_zombie_pot" },
    ), { now: 2, id: () => "must-not-be-used" });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "bad_item" });
    expect(result.state.inventory.flower_zombie_pot).toBe(1);
    expect(result.state.roster).toEqual([]);
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
      "0:4": { state: "spent", zombie: true },
      "4:0": { state: "plowed" },
      "8:0": { state: "planted", cropKey: "carrot", plantedAt: 0, growMs: 99_999, sell: 16, xp: 1, fertilized: false, zombie: false },
    };
    const goldBefore = state.balance.gold;
    const xpBefore = state.balance.xp;
    const first = applyCommandBatch(state, commands({ type: "power.use", key: "insta_plow" }), { now: 1 });
    expect(first.results[0].status).toBe("applied");
    expect(first.state.inventory.insta_plow).toBe(1);
    expect(first.state.farm.plots["0:0"].state).toBe("plowed");
    expect(first.state.farm.plots["0:4"].state).toBe("plowed");
    expect(first.state.farm.plots["8:0"].state).toBe("planted");
    expect(first.state.balance.gold).toBe(goldBefore);
    expect(first.state.balance.xp).toBe(xpBefore + 2);
    const second = applyCommandBatch(first.state, commands({ type: "power.use", key: "insta_plow" }), { now: 2 });
    expect(second.results[0]).toMatchObject({ status: "rejected", error: "no_effect" });
    expect(second.state.inventory.insta_plow).toBe(1);
  });

  it("Insta-Plow follows the Plowing Monolith's manual-plow XP rule", () => {
    const state = freshGameplayState();
    state.inventory.insta_plow = 1;
    state.farm.plots["0:0"] = { state: "spent" };
    state.objects.objects.push({
      instanceId: "plow-monolith", catalogKey: "monolithPlowing", status: "placed",
    });
    const xpBefore = state.balance.xp;
    const result = applyCommandBatch(state, commands({ type: "power.use", key: "insta_plow" }), { now: 1 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.xp).toBe(xpBefore);
  });

  it("coalesces duplicate tree ids and aggregates rewards into state once", () => {
    const state = freshGameplayState();
    state.objects.objects.push({ instanceId: "tree-1", catalogKey: "fruitTreeApple", status: "placed", readyAt: 100 });
    const result = applyCommandBatch(state, commands({ type: "object.harvest_trees", instanceIds: ["tree-1", "tree-1"] }), { now: 100 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.balance.gold).toBeGreaterThan(200);
    expect(result.state.objects.objects[0].readyAt).toBeGreaterThan(100);
  });

  it("does not award tree-harvest xp, even with a placed Plowing Monolith", () => {
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
    expect(result.state.balance.xp).toBe(state.balance.xp);
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

  it("refuses to adopt the starter shed under a malformed client instance id", () => {
    // Adoption is the only upgrade that INSERTS a client-named object, so it takes the
    // same id fence as object.buy. It used to accept anything `commandString` allowed,
    // which put an arbitrary 128-character string into a document other players read.
    const state = freshGameplayState();
    state.balance.gold = 20_000;
    for (const instanceId of ["<script>", "has space", "a".repeat(81), "quote\"id"]) {
      const rejected = applyCommandBatch(state, commands({
        type: "object.upgrade", instanceId, catalogKey: "storage02",
      }), { now: 100 });
      expect(rejected.results[0]).toMatchObject({ status: "rejected", error: "not_owned" });
      expect(rejected.state.objects.objects).toEqual([]);
      expect(rejected.state.balance.gold).toBe(20_000);
    }
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
    expect(bought.state.balance.xp).toBe(320); // +5 gold-buy XP, then 3 brains * 80
    expect(bought.state.objects.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: "pot-1", catalogKey: "zombieCombiner", purchaseCost: 500, purchaseCurrency: "gold" }),
      expect.objectContaining({ instanceId: "pot-2", catalogKey: "zombieCombiner", purchaseCost: 3, purchaseCurrency: "brains" }),
    ]));

    const sold = applyCommandBatch(bought.state, commands(
      { type: "object.refund", instanceId: "pot-1" },
      { type: "object.refund", instanceId: "pot-2" },
    ), { now: 101 });
    expect(sold.results).toEqual([
      expect.objectContaining({ status: "rejected", error: "not_sellable" }),
      expect.objectContaining({ status: "rejected", error: "not_sellable" }),
    ]);
    expect(sold.state.balance.gold).toBe(500);
    expect(sold.state.balance.brains).toBe(97);
    expect(sold.state.objects.objects).toHaveLength(2);
    expect(sold.state.zombiePotBought).toBe(true);
  });

  it("derives brain decor XP from the post-revert price instead of raw catalog XP", () => {
    // Evergreen decor on purpose: a seasonal key would be rejected by the theme
    // allow-list, which is a different rule than the one under test here.
    const state = freshGameplayState();
    state.balance.brains = 100;
    const bought = applyCommandBatch(state, commands({
      type: "object.buy",
      catalogKey: "spaceSolarSystem",
      clientInstanceId: "solar-system",
    }), { now: 100 });

    expect(bought.results[0].status).toBe("applied");
    expect(bought.state.balance.brains).toBe(95);
    expect(bought.state.balance.xp).toBe(500); // 5 brains * decor multiplier 100
  });

  it("sells brain-priced decor for 1,000 gold per brain without refunding brains", () => {
    const state = freshGameplayState();
    const initialGold = state.balance.gold;
    state.balance.brains = 100;
    const bought = applyCommandBatch(state, commands({
      type: "object.buy",
      catalogKey: "spaceSolarSystem",
      clientInstanceId: "solar-system",
    }), { now: 100 });

    const sold = applyCommandBatch(bought.state, commands({
      type: "object.refund",
      instanceId: "solar-system",
    }), { now: 101 });

    expect(sold.results[0]).toMatchObject({ status: "applied" });
    expect(sold.state.balance.gold).toBe(initialGold + 5_000);
    expect(sold.state.balance.brains).toBe(95);
  });

  it("refuses to sell decor whose season is not running", () => {
    // heartFountain is labelled `valentines`, which is not on ACTIVE_THEMES. The
    // market hides the card; this is what makes hiding it enforceable.
    const state = freshGameplayState();
    state.balance.brains = 100;
    const bought = applyCommandBatch(state, commands({
      type: "object.buy",
      catalogKey: "heartFountain",
      clientInstanceId: "heart-fountain",
    }), { now: 100 });

    expect(bought.results[0]).toMatchObject({ status: "rejected", error: "locked" });
    expect(bought.state.balance.brains).toBe(100); // nothing charged
  });

  it("still places and stores decor bought in a season that has since ended", () => {
    // Gating is on BUYING only — a farm built during an event must keep working.
    const state = freshGameplayState();
    state.objects.objects.push({
      instanceId: "old-fountain", catalogKey: "heartFountain", status: "placed",
    });

    const stored = applyCommandBatch(state, commands({
      type: "object.status", instanceId: "old-fountain", status: "stored",
    }), { now: 100 });
    expect(stored.results[0]).toMatchObject({ status: "applied" });

    const replaced = applyCommandBatch(stored.state, commands({
      type: "object.status", instanceId: "old-fountain", status: "placed",
    }), { now: 101 });
    expect(replaced.results[0]).toMatchObject({ status: "applied" });
  });

  it("refuses to pack a Mausoleum or a shed into the shed", () => {
    // Shelving the crypt would strip its capacity out from under the zombies inside,
    // leaving them stored in a building the farm no longer has. The client hides the
    // action; this is the authoritative half. (A shed cannot contain itself either.)
    const state = freshGameplayState();
    state.objects.objects.push(
      { instanceId: "tomb", catalogKey: "mausoleum3", status: "placed" },
      { instanceId: "shed", catalogKey: "storage03", status: "placed" },
    );
    state.roster = [
      { id: "occupant", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "object.status", instanceId: "tomb", status: "stored" },
      { type: "object.status", instanceId: "shed", status: "stored" },
    ), { now: 100 });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "not_storable" });
    expect(result.results[1]).toMatchObject({ status: "rejected", error: "not_storable" });
    expect(result.state.objects.objects.every((object) => object.status === "placed")).toBe(true);
    // Moving the Mausoleum around the farm is still fine.
    const moved = applyCommandBatch(result.state, commands({
      type: "object.status", instanceId: "tomb", status: "placed",
    }), { now: 101 });
    expect(moved.results[0]).toMatchObject({ status: "applied" });
  });

  it("moves a bare tilled plot", () => {
    const state = freshGameplayState();
    state.balance.gold = 10_000;
    const plowed = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
    ), { now: 1_000 });

    const moved = applyCommandBatch(plowed.state, commands(
      { type: "farm.move", oc: 0, or: 0, toOc: 8, toOr: 8 },
    ), { now: 2_000 });

    expect(moved.results[0]).toMatchObject({ status: "applied" });
    expect(moved.state.farm.plots["0:0"]).toBeUndefined();
    expect(moved.state.farm.plots["8:8"]).toEqual({ state: "plowed" });
    expect(moved.farmChanged).toBe(true);
  });

  it("refuses to move a plot with a crop on it", () => {
    // Only bare tilled ground moves: a crop's payout and its mutation adjacency are
    // decided where it sits, so a planted plot stays put.
    const state = freshGameplayState();
    state.balance.gold = 10_000;
    const planted = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
    ), { now: 1_000 });
    expect(planted.state.farm.plots["0:0"]?.state).toBe("planted");

    const moved = applyCommandBatch(planted.state, commands(
      { type: "farm.move", oc: 0, or: 0, toOc: 8, toOr: 8 },
    ), { now: 2_000 });

    expect(moved.results[0]).toMatchObject({ status: "rejected", error: "plot_occupied" });
    expect(moved.state.farm.plots["0:0"]?.state).toBe("planted");
    expect(moved.state.farm.plots["8:8"]).toBeUndefined();
  });

  it("lets a plot shuffle one tile, overlapping its own old footprint", () => {
    const state = freshGameplayState();
    state.balance.gold = 10_000;
    const plowed = applyCommandBatch(state, commands({ type: "farm.plow", oc: 4, or: 4 }), { now: 1 });
    const nudged = applyCommandBatch(plowed.state, commands(
      { type: "farm.move", oc: 4, or: 4, toOc: 5, toOr: 4 },
    ), { now: 2 });
    expect(nudged.results[0]).toMatchObject({ status: "applied" });
    expect(nudged.state.farm.plots["5:4"]).toEqual({ state: "plowed" });
  });

  it("refuses a move onto another plot, off the farm, or from nowhere", () => {
    const state = freshGameplayState();
    state.balance.gold = 10_000;
    const two = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plow", oc: 4, or: 0 },
    ), { now: 1 });

    const onto = applyCommandBatch(two.state, commands(
      { type: "farm.move", oc: 0, or: 0, toOc: 2, toOr: 0 },
    ), { now: 2 });
    expect(onto.results[0]).toMatchObject({ status: "rejected", error: "plot_overlap" });

    const offMap = applyCommandBatch(two.state, commands(
      { type: "farm.move", oc: 0, or: 0, toOc: -1, toOr: 0 },
    ), { now: 3 });
    expect(offMap.results[0]).toMatchObject({ status: "rejected", error: "bad_coord" });

    const empty = applyCommandBatch(two.state, commands(
      { type: "farm.move", oc: 12, or: 12, toOc: 16, toOr: 16 },
    ), { now: 4 });
    expect(empty.results[0]).toMatchObject({ status: "rejected", error: "nothing_to_move" });
  });

  it("rejects duplicate functional buys even when the owned copy is stored", () => {
    const state = freshGameplayState();
    state.balance.brains = 100;
    state.objects.objects.push({
      instanceId: "blue-grave",
      catalogKey: "gravestoneBlue",
      status: "stored",
    });
    const result = applyCommandBatch(state, commands({
      type: "object.buy",
      catalogKey: "gravestoneBlue",
      clientInstanceId: "duplicate-grave",
    }), { now: 100 });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "object_limit" });
    expect(result.state.objects.objects).toHaveLength(1);
    expect(result.state.balance.brains).toBe(100);
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
    // The reservation marker is the same on both parents — an older client parses its
    // pot id straight out of it — so slot 1 is recorded beside it instead. It has to
    // survive the hour the pair spends in the Pot: it decides the child's species.
    expect(result.state.potSlots).toEqual({ "pot-1": "a" });
  });

  it("collects the slot-1 species even when the collect command reverses the parents", () => {
    const state = freshGameplayState();
    state.roster = [
      // Creation order puts the slot-2 parent FIRST — exactly what the roster projection
      // hands a client that has to rebuild its Pot job, and what used to get sent back.
      { id: "older-regular", key: "ZombieActorRegularTier1", mutation: 8, invasions: 0, stored: false },
      { id: "newer-garden", key: "ZombieActorGardenTier1", mutation: 0, invasions: 0, stored: false },
    ];

    const started = applyCommandBatch(state, commands(
      { type: "roster.combine_start", potId: "pot-1", parentAId: "newer-garden", parentBId: "older-regular" },
    ), { now: 1 });
    expect(started.results[0].status).toBe("applied");

    const collected = applyCommandBatch(started.state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "older-regular", parentBId: "newer-garden" },
    ), { now: 2, id: () => "child" });

    expect(collected.results[0]).toMatchObject({ status: "applied", createdIds: ["child"] });
    expect(collected.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorGardenTier1", mutation: 8,
    }));
    // The finished job releases its slot record rather than leaking one per pot.
    expect(collected.state.potSlots).toEqual({});
  });

  it("still trusts the command's order for a job started before slots were recorded", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
      { id: "b", key: "ZombieActorGardenTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "b", parentBId: "a" },
    ), { now: 1, id: () => "child" });

    expect(result.results[0]).toMatchObject({ status: "applied" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorGardenTier1",
    }));
  });

  it("leaves the reservation marker readable by clients that predate slot records", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
      { id: "b", key: "ZombieActorGardenTier1", mutation: 0, invasions: 0, stored: false },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine_start", potId: "o1", parentAId: "b", parentBId: "a" },
    ), { now: 1 });

    // An older bundle groups a job by `lockedByRaid.slice(4)`. Both parents must still
    // yield the same pot id, or it reads one combine as two orphans and retires it —
    // which cancels the local job while the server keeps holding the pair.
    expect(new Set(result.state.roster.map((unit) => unit.lockedByRaid?.slice(4))))
      .toEqual(new Set(["o1"]));
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
    // The crypt the parents already occupy — without it there is nowhere to store the
    // child either, and the combine is refused (see the next case).
    state.objects.objects.push({ instanceId: "tomb", catalogKey: "mausoleum3", status: "placed" });
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

  it("refuses a combine whose child would land in a Mausoleum the farm does not have", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    // No Mausoleum placed, so crypt capacity is zero. The army is full and consuming
    // the two stored parents does not free an active slot, so the child has nowhere to
    // exist — it used to be flagged `stored` into a building that isn't there, which is
    // how a farm could own a zombie it could never see, deploy, or raid with.
    state.roster = [
      { id: "active", key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
    ), { now: 1, id: () => "homeless-child" });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "capacity_full" });
    // Rejecting must leave the parents intact — they are only consumed on success.
    expect(result.state.roster.map((unit) => unit.id)).toEqual(["active", "a", "b"]);
  });

  it("lets a crypt-bound parent free the slot its own child then takes", () => {
    const state = freshGameplayState();
    state.zombieMax = 1;
    // A single-slot Mausoleum, both of whose occupants are the parents. Consuming them
    // frees two slots, so the child fits even though the crypt reads full going in.
    state.objects.objects.push({ instanceId: "tomb", catalogKey: "mausoleum3", status: "placed" });
    state.roster = [
      { id: "active", key: "ZombieActorHeadlessTier1", mutation: 0, invasions: 0, stored: false },
      ...Array.from({ length: 13 }, (_, index) => ({
        id: `filler-${index}`, key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true,
      })),
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
    ), { now: 1, id: () => "recycled-slot-child" });

    expect(result.results[0]).toMatchObject({ status: "applied" });
    expect(result.state.roster.find((unit) => unit.id === "recycled-slot-child"))
      .toMatchObject({ stored: true });
  });

  it("breeds a matched pair up one colour class when its grave is placed", () => {
    const twoGreens = (): RosterUnitProjection[] => [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
      { id: "b", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
    ];
    // No Blue Grave: two Regular Zombies stay Regular Zombies.
    const locked = freshGameplayState();
    locked.roster = twoGreens();
    expect(applyCommandBatch(locked, commands(
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
    ), { now: 1, random: () => 0.99, id: () => "child" }).state.roster[0].key)
      .toBe("ZombieActorRegularTier1");

    // With it placed, the pair breeds up to the Regular blue (Zyborg).
    const unlocked = freshGameplayState();
    unlocked.roster = twoGreens();
    unlocked.objects.objects.push({
      instanceId: "grave", catalogKey: "gravestoneBlue", status: "placed",
    });
    expect(applyCommandBatch(unlocked, commands(
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
    ), { now: 1, random: () => 0.99, id: () => "child" }).state.roster[0].key)
      .toBe("ZombieActorRegularTier2");
  });

  it("collects a combine straight into the Mausoleum when the player asks", () => {
    const state = freshGameplayState();
    state.zombieMax = 5; // the farm has room; the crypt is a deliberate choice
    state.objects.objects.push({ instanceId: "tomb", catalogKey: "mausoleum3", status: "placed" });
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "a", parentBId: "b", stored: true },
    ), { now: 1, id: () => "crypt-child" });

    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["crypt-child"] });
    expect(result.state.roster).toEqual([
      { id: "crypt-child", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true },
    ]);
  });

  it("refuses a crypt collection with no Mausoleum to hold it", () => {
    const state = freshGameplayState();
    state.zombieMax = 5;
    state.roster = [
      { id: "a", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
      { id: "b", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true, lockedByRaid: "pot:pot-1" },
    ];

    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", potId: "pot-1", parentAId: "a", parentBId: "b", stored: true },
    ), { now: 1, id: () => "homeless-child" });

    expect(result.results[0]).toMatchObject({ status: "rejected", error: "capacity_full" });
    expect(result.state.roster.map((unit) => unit.id)).toEqual(["a", "b"]);
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

  it("mutates an Epic reward zombie in slot 1 with slot 2's mutations", () => {
    // An Epic prize is never planted beside a crop, so the Pot is the one way it can
    // wear a mutation: it goes in slot 1 like any special, comes back out as itself,
    // and takes the donor's mask. Both parents are consumed, so nothing is cloned.
    const state = freshGameplayState();
    state.roster = [
      { id: "epic", key: "ZombieActorBandido", mutation: 0, invasions: 0, stored: false },
      { id: "tomato", key: "ZombieActorRegularTier1Tomatoes", mutation: 1, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "epic", parentBId: "tomato" }
    ), { now: 1, random: () => 0.99, id: () => "child" });
    expect(result.results[0]).toMatchObject({ status: "applied" });
    expect(result.state.roster).toEqual([
      { id: "child", key: "ZombieActorBandido", mutation: 1, invasions: 0, stored: false },
    ]);
  });

  it("keeps an Epic reward zombie out of slot 2, like every other special", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "base", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
      { id: "epic", key: "ZombieActorBandido", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine_start", potId: "pot1", parentAId: "base", parentBId: "epic" }
    ), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "special_slot" });
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

  // Claiming a Received zombie takes a free ARMY slot first and only falls back to
  // the Mausoleum, so a full crypt cannot strand a reward the player already earned.
  const receivedZombieMarker = encodeReceivedZombie({
    id: "received-zombie", key: "ZombieActorGirlTier1", mutation: 4, invasions: 3,
  });
  const claimState = (activeUnits: number, storedUnits = 0, mausoleum?: string): MutableGameplayState => {
    const state = freshGameplayState();
    if (mausoleum) state.objects.objects.push({ instanceId: "tomb", catalogKey: mausoleum, status: "placed" });
    for (let i = 0; i < activeUnits; i++) {
      state.roster.push({ id: `a${i}`, key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: false });
    }
    for (let i = 0; i < storedUnits; i++) {
      state.roster.push({ id: `s${i}`, key: "ZombieActorGirlTier1", mutation: 0, invasions: 0, stored: true });
    }
    state.storage.received[receivedZombieMarker] = 1;
    return state;
  };
  const claim = (state: MutableGameplayState) => applyCommandBatch(state, commands(
    { type: "storage.claim", itemName: receivedZombieMarker },
  ), { now: 1 });

  it("claims a Received zombie straight onto the farm while the army has room", () => {
    // No Mausoleum placed at all: an empty army is still a valid destination.
    const result = claim(claimState(0));
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["received-zombie"] });
    expect(result.state.storage.received[receivedZombieMarker]).toBe(0);
    expect(result.state.roster).toContainEqual({
      id: "received-zombie", key: "ZombieActorGirlTier1", mutation: 4, invasions: 3, stored: false,
    });
  });

  it("falls back to a Mausoleum slot once the army is full", () => {
    const result = claim(claimState(16, 0, "mausoleum3"));
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["received-zombie"] });
    expect(result.state.roster).toContainEqual({
      id: "received-zombie", key: "ZombieActorGirlTier1", mutation: 4, invasions: 3, stored: true,
    });
  });

  // REGRESSION: three running Zombie Pots hid six crypt occupants from the player.
  // combine_start flips both parents to `stored` with a `pot:` lock, and the client
  // filters those rows out of the roster it reconciles — so the Mausoleum read 21/25
  // in the UI and 27/25 on the server. The claim the client allowed came back
  // `storage_full` and the reward snapped into Received, over and over, with nothing
  // in the game to explain it and no way to free a unit sealed inside a pot.
  it("does not charge Zombie Pot reservations to the Mausoleum", () => {
    const state = claimState(16, 21, "mausoleum5"); // 25 slots, 21 visibly occupied
    for (let i = 0; i < 6; i++) {
      state.roster.push({
        id: `pot${i}`, key: "ZombieActorGirlTier1", mutation: 0, invasions: 0,
        stored: true, lockedByRaid: `pot:pot-${Math.floor(i / 2)}`,
      });
    }
    const result = claim(state);
    expect(result.results[0]).toMatchObject({ status: "applied", createdIds: ["received-zombie"] });
    expect(result.state.roster).toContainEqual({
      id: "received-zombie", key: "ZombieActorGirlTier1", mutation: 4, invasions: 3, stored: true,
    });
  });

  it("still refuses once the VISIBLE crypt is full, pot reservations aside", () => {
    const state = claimState(16, 25, "mausoleum5");
    state.roster.push({
      id: "pot0", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0,
      stored: true, lockedByRaid: "pot:pot-0",
    });
    expect(claim(state).results[0]).toMatchObject({ status: "rejected", error: "storage_full" });
  });

  it("refuses a Received zombie only when BOTH the army and the crypt are full", () => {
    expect(claim(claimState(16)).results[0])
      .toMatchObject({ status: "rejected", error: "need_mausoleum" });
    // mausoleum3 is 15 slots.
    expect(claim(claimState(16, 15, "mausoleum3")).results[0])
      .toMatchObject({ status: "rejected", error: "storage_full" });
  });

  // ---- Mausoleum upgrade ladder (mausoleum3 -> 4 -> ... -> 12, +5 slots each) ----
  const withMausoleum = (catalogKey: string): MutableGameplayState => {
    const state = freshGameplayState();
    state.balance.brains = 100;
    state.balance.xp = 50_000; // above every level gate
    state.objects.objects.push({ instanceId: "tomb", catalogKey, status: "placed" });
    return state;
  };

  it("charges each Mausoleum rung in brains and swaps the building in place", () => {
    const state = withMausoleum("mausoleum3");
    const result = applyCommandBatch(state, commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum4" },
    ), { now: 1 });
    expect(result.results[0].status).toBe("applied");
    expect(result.state.objects.objects).toContainEqual(
      expect.objectContaining({ instanceId: "tomb", catalogKey: "mausoleum4" })
    );
    expect(result.state.balance.brains).toBe(96);

    // ...and every rung above costs the same 4: 96 - 12 = 84.
    const rest = applyCommandBatch(result.state, commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum5" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum6" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum7" },
    ), { now: 2 });
    expect(rest.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
    expect(rest.state.balance.brains).toBe(84);

    // The ladder runs five rungs further, at the same price, to Mausoleum X.
    const top = applyCommandBatch(rest.state, commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum8" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum9" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum10" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum11" },
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum12" },
    ), { now: 3 });
    expect(top.results.map((r) => r.status)).toEqual(Array(5).fill("applied"));
    expect(top.state.balance.brains).toBe(64); // 84 - 5 rungs x 4
    expect(top.state.objects.objects).toContainEqual(
      expect.objectContaining({ instanceId: "tomb", catalogKey: "mausoleum12" })
    );
  });

  it("refuses to skip a rung, to climb from a non-Mausoleum, or to buy a tier outright", () => {
    const skipped = applyCommandBatch(withMausoleum("mausoleum3"), commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum7" },
    ), { now: 1 });
    expect(skipped.results[0]).toMatchObject({ status: "rejected", error: "bad_tier" });
    expect(skipped.state.balance.brains).toBe(100);

    // Nothing sits above Mausoleum X, so the top rung has no upgrade of its own.
    const topped = applyCommandBatch(withMausoleum("mausoleum12"), commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum12" },
    ), { now: 1 });
    expect(topped.results[0]).toMatchObject({ status: "rejected", error: "bad_tier" });

    const notATomb = applyCommandBatch(withMausoleum("gravestoneBlue"), commands(
      { type: "object.upgrade", instanceId: "tomb", catalogKey: "mausoleum4" },
    ), { now: 1 });
    expect(notATomb.results[0]).toMatchObject({ status: "rejected", error: "bad_tier" });

    // A tier is an upgrade only: buying one outright would cost a fraction of the ladder.
    const bought = applyCommandBatch(freshGameplayState(), commands(
      { type: "object.buy", catalogKey: "mausoleum7", clientInstanceId: "cheap-tomb" },
    ), { now: 1 });
    expect(bought.results[0]).toMatchObject({ status: "rejected", error: "bad_item" });
  });

  it("gives each Mausoleum tier five more zombie storage slots", () => {
    const fill = (state: MutableGameplayState) => {
      state.zombieMax = 1;
      state.roster.push({ id: "active", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false });
      for (let i = 0; i < 15; i++) {
        state.roster.push({ id: `s${i}`, key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: true });
      }
      return applyCommandBatch(state, commands(
        { type: "roster.status", unitId: "active", stored: true },
      ), { now: 1 });
    };
    expect(fill(withMausoleum("mausoleum3")).results[0])
      .toMatchObject({ status: "rejected", error: "storage_full" }); // 15 slots, all taken
    expect(fill(withMausoleum("mausoleum4")).results[0]).toMatchObject({ status: "applied" }); // 20
  });

  it("refuses to move a Received zombie into the item shed", () => {
    const marker = encodeReceivedZombie({
      id: "received-zombie", key: "ZombieActorGirlTier1", mutation: 0, invasions: 0,
    });
    const state = freshGameplayState();
    state.storage.received[marker] = 1;
    const result = applyCommandBatch(state, commands(
      { type: "storage.move", itemKey: marker, quantity: 1, direction: "store" },
    ), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "bad_item" });
    expect(result.state.storage.received[marker]).toBe(1);
    expect(result.state.storage.stored[marker]).toBeUndefined();
  });

  it("holds the item shed to the capacity of the shed actually placed", () => {
    // The retired v2 route enforced this (planStore via shedCapacity); v3 dropped it and
    // left the cap client-side only, so an edited client could fill a Shabby Shed
    // without limit. The floor is the free starter shed's 8 slots.
    const state = freshGameplayState();
    state.storage.received.windmill = 20;

    const overflow = applyCommandBatch(state, commands(
      { type: "storage.move", itemKey: "windmill", quantity: 9, direction: "store" },
    ), { now: 1 });
    expect(overflow.results[0]).toMatchObject({ status: "rejected", error: "shed_full" });
    expect(overflow.state.storage.stored.windmill).toBeUndefined();

    const exact = applyCommandBatch(state, commands(
      { type: "storage.move", itemKey: "windmill", quantity: 8, direction: "store" },
      { type: "storage.move", itemKey: "windmill", quantity: 1, direction: "store" },
    ), { now: 1 });
    expect(exact.results[0].status).toBe("applied");
    expect(exact.results[1]).toMatchObject({ status: "rejected", error: "shed_full" });
    expect(exact.state.storage.stored.windmill).toBe(8);

    // A bigger PLACED shed raises the ceiling; taking items back out never checks it.
    const bigger = { ...state, objects: { version: 0,
      objects: [{ instanceId: "shed", catalogKey: "storage03", status: "placed" as const }] } };
    const roomy = applyCommandBatch(bigger, commands(
      { type: "storage.move", itemKey: "windmill", quantity: 20, direction: "store" },
    ), { now: 1 });
    expect(roomy.results[0].status).toBe("applied");
    expect(roomy.state.storage.stored.windmill).toBe(20);

    const emptying = applyCommandBatch(roomy.state, commands(
      { type: "storage.move", itemKey: "windmill", quantity: 20, direction: "take" },
    ), { now: 2 });
    expect(emptying.results[0].status).toBe("applied");
  });

  const specialPair = (): MutableGameplayState => {
    const state = freshGameplayState();
    state.roster = [
      { id: "regular", key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
      { id: "bombie", key: "ZombieActorBombie", mutation: 0, invasions: 0, stored: false },
    ];
    return state;
  };

  it("refuses to START a combine with the special in Zombie Pot slot 2", () => {
    const state = specialPair();
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine_start", potId: "pot-1", parentAId: "regular", parentBId: "bombie" }
    ), { now: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "special_slot" });
    expect(result.state.roster.every((unit) => !unit.lockedByRaid)).toBe(true);
  });

  it("still collects a slot-2 special from a job started before the rule", () => {
    // The client has already consumed both parents for this job, and the species
    // picker preserves the special from either slot — rejecting it at collect would
    // destroy the result rather than enforce anything.
    const state = specialPair();
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "regular", parentBId: "bombie" }
    ), { now: 1, id: () => "child" });
    expect(result.results[0]).toMatchObject({ status: "applied" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorBombie",
    }));
  });

  it("always outputs the slot-1 ordinary species when no special evolution occurs", () => {
    const state = freshGameplayState();
    state.roster = [
      { id: "left", key: "ZombieActorRegularTier1", mutation: 1, invasions: 0, stored: false },
      { id: "right", key: "ZombieActorLargeTier4", mutation: 8, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId: "left", parentBId: "right", playerLevel: 24 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorRegularTier1", mutation: 9,
    }));
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

  it("breeds a matched level-25 pair up to its body type's silver", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorLargeTier4",
    }));
  });

  it("credits the 'combine for a silver' quest when the pair actually breeds up", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    state.quests.completed = ["21"];
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 }
    ), { now: 1, id: () => "child" });
    // Quest 22's requirements are [Party Zombie, Zombarian, Zombee].
    expect(result.state.quests.progress.find((entry) => entry.questId === "22")?.counts).toEqual([0, 1, 0]);
  });

  it("does not credit that quest for re-cooking a silver the player already owns", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    state.quests.completed = ["21"];
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      // Slot 1 wins, so this Zombarian comes straight back out — no breeding happened
      // and the objective must not advance (tester report, 2026-08-05).
      { id: parentAId, key: "ZombieActorLargeTier4", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorLargeTier4",
    }));
    expect(result.state.quests.progress.find((entry) => entry.questId === "22")?.counts ?? [0, 0, 0])
      .toEqual([0, 0, 0]);
  });

  it("does not credit it for a matched pair of silvers that fails to promote either", () => {
    const state = freshGameplayState();
    state.balance.xp = 20_500;
    state.quests.completed = ["21"];
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorLargeTier4", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorLargeTier4", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 25 }
    ), { now: 1, id: () => "child" });
    expect(result.state.quests.progress.find((entry) => entry.questId === "22")?.counts ?? [0, 0, 0])
      .toEqual([0, 0, 0]);
  });

  it("strips head and hair/eye mutations from a headless combine child", () => {
    const state = freshGameplayState();
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      // Slot 1 is headless, so the child is; slot 2 donates carrot eyes (4) it can't
      // wear plus a turnip arm (8) it can.
      { id: parentAId, key: "ZombieActorHeadlessTier3", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorRegularTier1", mutation: 4 | 8, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorHeadlessTier3", mutation: 8,
    }));
  });

  it("returns the parent species for a matched pair below level 25", () => {
    const state = freshGameplayState();
    const [parentAId, parentBId] = commonCombinePairIds();
    state.roster = [
      { id: parentAId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
      { id: parentBId, key: "ZombieActorLargeTier3", mutation: 0, invasions: 0, stored: false },
    ];
    const result = applyCommandBatch(state, commands(
      { type: "roster.combine", parentAId, parentBId, playerLevel: 24 }
    ), { now: 1, id: () => "child" });
    expect(result.state.roster).toContainEqual(expect.objectContaining({
      id: "child", key: "ZombieActorLargeTier3",
    }));
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
    expect(result.state.roster[0].key).toBe("ZombieActorHeadlessTier1");
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

  it("counts decorating quest object families authoritatively", () => {
    const state = freshGameplayState();
    state.quests.completed = ["9"];
    applyQuestEvents(state.balance, state.quests, [
      { type: "kItemBoughtNotification", subject: "Pirate Barrel" },
      { type: "kItemBoughtNotification", subject: "Fire Barrel" },
    ]);
    expect(state.quests.progress.find((entry) => entry.questId === "10")?.counts).toEqual([2, 0]);
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

  it("can sell a Received decoration without leaving it on the farm", () => {
    const state = freshGameplayState();
    state.storage.received = { "Circus Tent": 1 };
    const initialGold = state.balance.gold;
    const result = applyCommandBatch(state, commands(
      { type: "storage.claim", itemName: "Circus Tent", clientInstanceId: "reward-sale-circus-tent" },
      { type: "object.refund", instanceId: "reward-sale-circus-tent" },
    ), { now: 10 });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(result.state.storage.received["Circus Tent"]).toBe(0);
    expect(result.state.objects.objects).toEqual([]);
    // An invasion prize sells for its authored value (src/raidDropValue.ts), not the
    // one-gold floor a cost-0 catalog row would otherwise produce.
    expect(result.state.balance.gold).toBe(initialGold + RAID_DROP_SELL.circusTent);
  });

  it("can sell every Epic Boss prize, at a quarter of its brain price", () => {
    // Two gaps met here. The prizes had no drops.json/raidLootCatalog row, so claiming
    // one was refused as a "bad item"; and 40 of the 50 had no objectCatalog row, so
    // object.refund refused the sale even once the claim worked. They still carry
    // cost 0 (they are never bought), so the payout comes from the authored table:
    // a quarter of the prize's Reforged brain price, at 1,000 gold per brain.
    const prizes = EPIC_BOSSES.flatMap((boss) => boss.loot.filter((prize) => !prize.stageActor));
    expect(prizes.length).toBe(50);
    const state = freshGameplayState();
    state.storage.received = Object.fromEntries(prizes.map((prize) => [prize.name, 1]));
    const initialGold = state.balance.gold;
    const result = applyCommandBatch(state, commands(
      ...prizes.flatMap((prize, i) => [
        { type: "storage.claim" as const, itemName: prize.name, clientInstanceId: `prize-${i}` },
        { type: "object.refund" as const, instanceId: `prize-${i}` },
      ]),
    ), { now: 10 });
    const refused = result.results
      .map((entry, i) => ({ entry, prize: prizes[Math.floor(i / 2)].name }))
      .filter(({ entry }) => entry.status !== "applied")
      .map(({ entry, prize }) => `${prize}: ${JSON.stringify(entry)}`);
    expect(refused).toEqual([]);
    expect(result.state.objects.objects).toEqual([]);
    const expected = prizes.reduce((sum, prize) => sum + EPIC_PRIZE_SELL[prize.tile!], 0);
    expect(result.state.balance.gold).toBe(initialGold + expected);
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
    // Rungs are the 10-rung ladder's: the ordinary prize is pinned to 5, the omega to 10
    // (prep_quests.py EPIC_PRIZE_RUNGS), with the middle milestones spread between.
    expect(applyQuestEvents(state.balance, state.quests, event(5))).toEqual([]);
    // Rung 5 carries both the zombie prize and the voucher milestone.
    expect(applyQuestEvents(state.balance, state.quests, event(5), { includeEpic: true, epicQuestIds: groundhog }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ questId: "1000", completed: true }),
        expect.objectContaining({ questId: "1001", completed: true }),
      ]));
    const brains = state.balance.brains;
    expect(applyQuestEvents(state.balance, state.quests, event(8), { includeEpic: true, epicQuestIds: groundhog }))
      .toContainEqual(expect.objectContaining({ questId: "1002", completed: true }));
    expect(state.balance.brains).toBe(brains + 1);
    const final = applyQuestEvents(state.balance, state.quests, event(10), { includeEpic: true, epicQuestIds: groundhog });
    expect(final).toEqual(expect.arrayContaining([
      expect.objectContaining({ questId: "1003", completed: true }),
      expect.objectContaining({ questId: "1011", completed: true }),
    ]));
  });
});
