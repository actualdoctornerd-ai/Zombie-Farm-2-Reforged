import type {
  BalanceProjection,
  CommandResult,
  FarmPlotProjection,
  GameplayProjection,
  QuestProjection,
  RosterUnitProjection,
  SequencedCommand,
} from "../../../src/net/protocol";
import plantRows from "../../../public/assets/plants.json";
import zombieRows from "../../../public/assets/zombies.json";
import farmerRows from "../../../public/assets/farmer.json";
import petRows from "../../../public/assets/pets/catalog.json";
import objectRows from "../../../public/assets/placeables.json";
import { boostEcon, MAX_STACK } from "../boostCatalog";
import { cropEcon } from "../catalog";
import { levelForXp, levelUpBrains } from "../levels";
import { objectBuyXp, objectEcon, objectRefund } from "../objectCatalog";
import { QUEST_DEFINITIONS, QUEST_REWARD } from "../questCatalog";
import { fertilizeProbability, zombieSell, ZOMBIE_COST } from "../rosterCatalog";
import { climateCost, nextSize, sizeTier } from "../shopCatalog";
import { zombieCropEcon } from "../zombieCropCatalog";
import { farmerGold, farmerZombieGrowMs } from "../../../src/farmer";
import { dropsEpicBossToken } from "../../../src/epicBoss/tokens";

export const MAX_FARM_PLOTS = 225;
export const MAX_FUNCTIONAL_OBJECTS = 512;
export const PLOT_SIZE = 4;
export const GROW_GRACE_MS_V3 = 15_000;
export const PLOW_COST_V3 = 10;

interface ObjectRule {
  name: string;
  armyMax: number;
  storageSlots: number;
  growMs: number;
  harvestValue: number;
  zombiePot?: boolean;
}

interface NamedRule { name: string }
interface ZombieRule extends NamedRule { key: string; mutation?: number; rewardOnly?: boolean }

const plantNames = new Map((plantRows as (NamedRule & { key: string })[]).map((r) => [r.key, r.name]));
const zombieRules = zombieRows as ZombieRule[];
const zombieNames = new Map(zombieRules.map((r) => [r.key, r.name]));
const zombieMutations = new Map(zombieRules.map((r) => [r.key, r.mutation ?? 0]));
const rewardOnlyZombies = new Set(zombieRules.filter((r) => r.rewardOnly).map((r) => r.key));

/** Catalog mutation guaranteed by a market-mutant species (0 for ordinary units). */
export function zombieDefaultMutation(key: string): number {
  return zombieMutations.get(key) ?? 0;
}
const objectRules = new Map(
  (objectRows as (ObjectRule & { key: string })[]).map((r) => [r.key, {
    ...r,
    zombiePot: r.key === "zombieCombiner",
  }])
);
const farmerHeads = new Map(farmerRows.heads.map((head) => [head.id, head]));
const freeFarmerHeads = farmerRows.heads.filter((head) => !head.cost).map((head) => head.id);
const pets = new Map(petRows.pets.map((pet) => [pet.key, pet]));

export interface MutableGameplayState extends GameplayProjection {}

export interface EngineOptions {
  now: number;
  random?: () => number;
  id?: () => string;
}

export interface EngineResult {
  state: MutableGameplayState;
  results: CommandResult[];
  questChanges: { questId: string; counts: number[]; completed: boolean }[];
  createdZombieIds: string[];
  farmChanged: boolean;
  objectChanged: boolean;
  questChanged: boolean;
  balanceBefore: BalanceProjection;
}

export interface QuestEvent { type: string; subject: string }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const plotKey = (oc: number, or: number): string => `${oc}:${or}`;
// Client plots are free-placed 4x4 footprints; their origin is not grid-snapped to a
// multiple of four. Only integer coordinates and containment within the farm matter.
const validCoord = (n: number, size: number): boolean =>
  Number.isInteger(n) && n >= 0 && n + PLOT_SIZE <= size;

function overlapsExistingPlot(
  plots: Record<string, FarmPlotProjection>,
  oc: number,
  or: number
): boolean {
  return Object.keys(plots).some((key) => {
    const [otherC, otherR] = key.split(":").map(Number);
    if (otherC === oc && otherR === or) return false;
    return oc < otherC + PLOT_SIZE && oc + PLOT_SIZE > otherC &&
      or < otherR + PLOT_SIZE && or + PLOT_SIZE > otherR;
  });
}

function isRipe(plot: Extract<FarmPlotProjection, { state: "planted" }>, now: number): boolean {
  return now - plot.plantedAt >= Math.max(0, plot.growMs - GROW_GRACE_MS_V3);
}

function placedCapacity(state: MutableGameplayState): { army: number; storage: number } {
  let army = state.zombieMax;
  let storage = 0;
  for (const obj of state.objects.objects) {
    if (obj.status !== "placed") continue;
    const rule = objectRules.get(obj.catalogKey);
    army += rule?.armyMax ?? 0;
    if (obj.catalogKey === "mausoleum3") storage = Math.max(storage, 15);
  }
  return { army, storage };
}

function addZombie(state: MutableGameplayState, key: string, id: string): boolean {
  const cap = placedCapacity(state);
  const active = state.roster.filter((u) => !u.stored).length;
  const stored = state.roster.filter((u) => u.stored).length;
  if (active >= cap.army && stored >= cap.storage) return false;
  state.roster.push({
    id,
    key,
    mutation: zombieDefaultMutation(key),
    invasions: 0,
    stored: active >= cap.army,
  });
  return true;
}

function rewardHarvest(
  state: MutableGameplayState,
  key: string,
  plot: Extract<FarmPlotProjection, { state: "planted" }>,
  makeId: () => string,
  created: string[],
  now: number,
  random: () => number
): { ok: true; event: QuestEvent } | { ok: false; error: string } {
  if (plot.zombie) {
    const id = makeId();
    if (!addZombie(state, key, id)) return { ok: false, error: "capacity_full" };
    created.push(id);
    state.balance.xp += zombieCropEcon(key)?.xp ?? 0;
    return { ok: true, event: { type: "kCropHarvestedZombieNotification", subject: zombieNames.get(key) ?? key } };
  }
  const harvestValue = plot.sell * (plot.fertilized ? 2 : 1);
  state.balance.gold += farmerGold(harvestValue, state.farmerHeadId);
  state.balance.xp += plot.xp;
  const run = state.epicBoss;
  if (run && !run.completedAt && run.expiresAt > now &&
      dropsEpicBossToken(plot.growMs, harvestValue, random)) {
    run.tokenCount = (run.tokenCount ?? 0) + 1;
  }
  return { ok: true, event: { type: "kCropHarvestedNotification", subject: plantNames.get(key) ?? key } };
}

export function applyQuestEvents(
  balance: BalanceProjection,
  quests: QuestProjection,
  events: QuestEvent[],
  options: { includeEpic?: boolean; epicQuestIds?: ReadonlySet<string> } = {}
): { questId: string; counts: number[]; completed: boolean }[] {
  if (!events.length) return [];
  const completed = new Set(quests.completed);
  const progress = new Map(quests.progress.map((p) => [p.questId, [...p.counts]]));
  const changed = new Set<string>();

  for (const [id, def] of Object.entries(QUEST_DEFINITIONS)) {
    if (completed.has(id) || def.seasonal ||
        (def.epicEvent && (!options.includeEpic || (options.epicQuestIds && !options.epicQuestIds.has(id))))) continue;
    if (def.levelRequired > levelForXp(balance.xp)) continue;
    if (def.prerequisiteQuest >= 0 && !completed.has(String(def.prerequisiteQuest))) continue;
    const counts = progress.get(id) ?? def.requirements.map(() => 0);
    for (const event of events) {
      def.requirements.forEach((req, index) => {
        if (req.notificationID !== event.type) return;
        // An empty object is the quest format's wildcard (for example, "plant any
        // crop"). Match named subjects case-insensitively, like the client engine.
        if (req.notificationObject &&
            req.notificationObject.toLowerCase() !== event.subject.toLowerCase()) return;
        const next = Math.min(req.countTotal, (counts[index] ?? 0) + 1);
        if (next !== counts[index]) {
          counts[index] = next;
          changed.add(id);
        }
      });
    }
    progress.set(id, counts);
    if (!def.requirements.every((req, index) => (counts[index] ?? 0) >= req.countTotal)) continue;
    completed.add(id);
    changed.add(id);
    // Currency rewards are catalog-authoritative. Unresolved item/zombie rewards are
    // deliberately dormant until their keys map to an authoritative catalog.
    if (def.rewardType === QUEST_REWARD.Xp) balance.xp += def.rewardValue;
    else if (def.rewardType === QUEST_REWARD.Gold) balance.gold += def.rewardValue;
    else if (def.rewardType === QUEST_REWARD.Brains) balance.brains += def.rewardValue;
  }

  quests.completed = [...completed];
  quests.progress = [...progress].map(([questId, counts]) => ({ questId, counts }));
  return [...changed].map((questId) => ({
    questId,
    counts: progress.get(questId) ?? [],
    completed: completed.has(questId),
  }));
}

function reject(sequence: number, error: string): CommandResult {
  return { sequence, status: "rejected", error };
}

function applyOne(
  state: MutableGameplayState,
  item: SequencedCommand,
  options: Required<EngineOptions>,
  events: QuestEvent[],
  created: string[]
): CommandResult {
  const { sequence, command } = item;
  const level = levelForXp(state.balance.xp);
  switch (command.type) {
    case "farm.plow": {
      if (!validCoord(command.oc, state.farmSize) || !validCoord(command.or, state.farmSize)) return reject(sequence, "bad_coord");
      const key = plotKey(command.oc, command.or);
      if (state.farm.plots[key]?.state === "planted") return reject(sequence, "plot_occupied");
      if (state.farm.plots[key]?.state === "plowed") return reject(sequence, "already_plowed");
      if (!state.farm.plots[key] && overlapsExistingPlot(state.farm.plots, command.oc, command.or)) {
        return reject(sequence, "plot_overlap");
      }
      const free = state.objects.objects.some((o) => o.status === "placed" && o.catalogKey === "monolithPlowing");
      const cost = free ? 0 : PLOW_COST_V3;
      if (state.balance.gold < cost) return reject(sequence, "insufficient");
      if (!state.farm.plots[key] && Object.keys(state.farm.plots).length >= MAX_FARM_PLOTS) return reject(sequence, "farm_full");
      state.balance.gold -= cost;
      state.balance.xp += 1;
      state.farm.plots[key] = { state: "plowed" };
      events.push({ type: "kSoilPlowedNotification", subject: "Plow" }, { type: "kNewSoilPlowedNotification", subject: "Plow" });
      return { sequence, status: "applied" };
    }
    case "farm.plant": {
      if (!validCoord(command.oc, state.farmSize) || !validCoord(command.or, state.farmSize)) return reject(sequence, "bad_coord");
      const key = plotKey(command.oc, command.or);
      if (state.farm.plots[key]?.state !== "plowed") return reject(sequence, "not_plowed");
      const veg = cropEcon(command.cropKey);
      const zombie = zombieCropEcon(command.cropKey);
      if (!veg && !zombie) return reject(sequence, "bad_crop");
      const required = veg?.level ?? zombie?.level ?? 0;
      if (level < required) return reject(sequence, "locked");
      const currency = zombie?.brains ? "brains" : "gold";
      const cost = veg?.cost ?? zombie?.cost ?? 0;
      if (state.balance[currency] < cost) return reject(sequence, "insufficient");
      state.balance[currency] -= cost;
      const fertilized = !!veg && options.random() < fertilizeProbability(state.roster.filter((u) => !u.stored).map((u) => u.key));
      state.farm.plots[key] = {
        state: "planted",
        cropKey: command.cropKey,
        plantedAt: options.now,
        growMs: zombie
          ? farmerZombieGrowMs(zombie.growMs, state.farmerHeadId)
          : veg?.growMs ?? 0,
        sell: veg?.sell ?? 0,
        xp: veg?.xp ?? zombie?.xp ?? 0,
        fertilized,
        zombie: !!zombie,
      };
      events.push({ type: "kCropPlantedNotification", subject: plantNames.get(command.cropKey) ?? zombieNames.get(command.cropKey) ?? command.cropKey });
      return { sequence, status: "applied" };
    }
    case "farm.harvest": {
      const key = plotKey(command.oc, command.or);
      const plot = state.farm.plots[key];
      if (!plot || plot.state !== "planted") return reject(sequence, "nothing_planted");
      if (!isRipe(plot, options.now)) return reject(sequence, "not_grown");
      const createdBefore = created.length;
      const harvest = rewardHarvest(state, plot.cropKey, plot, options.id, created, options.now, options.random);
      if (!harvest.ok) return reject(sequence, harvest.error);
      state.farm.plots[key] = { state: "spent", zombie: plot.zombie };
      events.push(harvest.event);
      const createdIds = created.slice(createdBefore);
      return { sequence, status: "applied", createdIds,
        createdZombieSources: createdIds.map((id) => ({ id, oc: command.oc, or: command.or })) };
    }
    case "farm.remove": {
      const key = plotKey(command.oc, command.or);
      if (!state.farm.plots[key]) return reject(sequence, "nothing_to_remove");
      delete state.farm.plots[key];
      return { sequence, status: "applied" };
    }
    case "power.buy": {
      const boost = boostEcon(command.key);
      if (!boost) return reject(sequence, "bad_item");
      if (level < boost.level) return reject(sequence, "locked");
      const currency = boost.brains ? "brains" : "gold";
      if (state.balance[currency] < boost.cost) return reject(sequence, "insufficient");
      const have = state.inventory[command.key] ?? 0;
      if (have + boost.perPurchase > MAX_STACK) return reject(sequence, "stack_full");
      state.balance[currency] -= boost.cost;
      state.inventory[command.key] = have + boost.perPurchase;
      return { sequence, status: "applied" };
    }
    case "power.use": {
      const have = state.inventory[command.key] ?? 0;
      if (have < 1) return reject(sequence, "none_owned");
      const boost = boostEcon(command.key);
      if (boost?.gift) {
        if (state.roster.some((unit) => unit.key === boost.gift)) return reject(sequence, "already_owned");
        const id = options.id();
        if (!addZombie(state, boost.gift, id)) return reject(sequence, "capacity_full");
        state.inventory[command.key] = have - 1;
        created.push(id);
        return { sequence, status: "applied", createdIds: [id] };
      }
      let effects = 0;
      const createdBefore = created.length;
      const createdZombieSources: { id: string; oc: number; or: number }[] = [];
      if (command.key === "insta_plow") {
        for (const [key, plot] of Object.entries(state.farm.plots)) {
          if (plot.state !== "spent") continue;
          state.farm.plots[key] = { state: "plowed" };
          effects++;
          events.push({ type: "kSoilPlowedNotification", subject: "Plow" });
        }
      } else if (command.key === "insta_harvest") {
        const ripe = Object.entries(state.farm.plots)
          .filter((entry): entry is [string, Extract<FarmPlotProjection, { state: "planted" }>] => entry[1].state === "planted" && isRipe(entry[1], options.now))
          .sort((a, b) => a[1].plantedAt - b[1].plantedAt || a[0].localeCompare(b[0]));
        for (const [key, plot] of ripe) {
          const createdAt = created.length;
          const harvest = rewardHarvest(state, plot.cropKey, plot, options.id, created, options.now, options.random);
          if (!harvest.ok) continue; // capacity-full zombie crops remain planted
          if (created.length > createdAt) {
            const [oc, or] = key.split(":").map(Number);
            createdZombieSources.push({ id: created[created.length - 1], oc, or });
          }
          state.farm.plots[key] = { state: "spent", zombie: plot.zombie };
          effects++;
          events.push(harvest.event);
        }
      } else if (command.key === "insta_grow") {
        if (command.target === "zombie_pot") {
          effects = state.objects.objects.some((object) =>
            object.status === "placed" && !!objectRules.get(object.catalogKey)?.zombiePot
          ) ? 1 : 0;
        } else {
          const key = plotKey(command.oc ?? -1, command.or ?? -1);
          const plot = state.farm.plots[key];
          if (plot?.state === "planted" && !isRipe(plot, options.now)) {
            plot.plantedAt = options.now - plot.growMs;
            effects = 1;
          }
        }
      } else {
        // Raid-only powers are consumed at raid start, not through ordinary commands.
        return reject(sequence, "wrong_context");
      }
      if (!effects) return reject(sequence, "no_effect");
      state.inventory[command.key] = have - 1;
      const createdIds = created.slice(createdBefore);
      return { sequence, status: "applied", createdIds,
        ...(command.key === "insta_harvest" ? { createdZombieSources } : {}) };
    }
    case "object.buy": {
      const econ = objectEcon(command.catalogKey);
      if (!econ || econ.cost <= 0) return reject(sequence, "bad_item");
      if (state.objects.objects.length >= MAX_FUNCTIONAL_OBJECTS) return reject(sequence, "object_limit");
      if (level < econ.level) return reject(sequence, "locked");
      const currency = econ.brains ? "brains" : "gold";
      if (state.balance[currency] < econ.cost) return reject(sequence, "insufficient");
      const requested = command.clientInstanceId;
      const instanceId = requested && /^[A-Za-z0-9_-]{1,80}$/.test(requested) &&
        !state.objects.objects.some((o) => o.instanceId === requested) ? requested : options.id();
      state.balance[currency] -= econ.cost;
      state.balance.xp += objectBuyXp(econ.cost, econ.xp);
      const rule = objectRules.get(command.catalogKey);
      state.objects.objects.push({ instanceId, catalogKey: command.catalogKey, status: "placed", ...(rule?.growMs ? { readyAt: options.now + rule.growMs } : {}) });
      events.push({ type: "kItemBoughtNotification", subject: rule?.name ?? command.catalogKey });
      return { sequence, status: "applied", createdIds: [instanceId] };
    }
    case "object.refund": {
      const index = state.objects.objects.findIndex((o) => o.instanceId === command.instanceId);
      if (index < 0) return reject(sequence, "not_owned");
      const obj = state.objects.objects[index];
      const econ = objectEcon(obj.catalogKey);
      if (!econ) return reject(sequence, "bad_item");
      state.objects.objects.splice(index, 1);
      state.balance[econ.brains ? "brains" : "gold"] += objectRefund(econ.cost);
      return { sequence, status: "applied" };
    }
    case "object.upgrade": {
      const obj = state.objects.objects.find((candidate) => candidate.instanceId === command.instanceId);
      const econ = objectEcon(command.catalogKey);
      if (!obj) return reject(sequence, "not_owned");
      if (!econ || econ.cost <= 0) return reject(sequence, "bad_item");
      if (level < econ.level) return reject(sequence, "locked");
      const currency = econ.brains ? "brains" : "gold";
      if (state.balance[currency] < econ.cost) return reject(sequence, "insufficient");
      state.balance[currency] -= econ.cost;
      state.balance.xp += objectBuyXp(econ.cost, econ.xp);
      obj.catalogKey = command.catalogKey;
      const rule = objectRules.get(command.catalogKey);
      obj.readyAt = rule?.growMs ? options.now + rule.growMs : undefined;
      events.push({ type: "kItemBoughtNotification", subject: rule?.name ?? command.catalogKey });
      return { sequence, status: "applied" };
    }
    case "object.status": {
      const obj = state.objects.objects.find((o) => o.instanceId === command.instanceId);
      if (!obj) return reject(sequence, "not_owned");
      obj.status = command.status;
      return { sequence, status: "applied" };
    }
    case "object.harvest_trees": {
      const ids = [...new Set(command.instanceIds)].slice(0, MAX_FARM_PLOTS);
      let harvested = 0;
      for (const id of ids) {
        const obj = state.objects.objects.find((o) => o.instanceId === id && o.status === "placed");
        const rule = obj ? objectRules.get(obj.catalogKey) : undefined;
        if (!obj || !rule?.growMs || !rule.harvestValue || (obj.readyAt ?? 0) > options.now) continue;
        state.balance.gold += farmerGold(rule.harvestValue, state.farmerHeadId);
        obj.readyAt = options.now + rule.growMs;
        harvested++;
        events.push({ type: "kCropHarvestedNotification", subject: rule.name });
      }
      return harvested ? { sequence, status: "applied" } : reject(sequence, "no_effect");
    }
    case "roster.sell": {
      const index = state.roster.findIndex((u) => u.id === command.unitId && !u.lockedByRaid);
      if (index < 0) return reject(sequence, "not_owned");
      const [unit] = state.roster.splice(index, 1);
      state.balance.gold += zombieSell(unit.key);
      events.push({ type: "kZombieSoldNotification", subject: zombieNames.get(unit.key) ?? unit.key });
      return { sequence, status: "applied" };
    }
    case "roster.status": {
      const unit = state.roster.find((candidate) => candidate.id === command.unitId && !candidate.lockedByRaid);
      if (!unit) return reject(sequence, "not_owned");
      if (unit.stored === command.stored) return reject(sequence, "no_effect");
      const capacity = placedCapacity(state);
      if (command.stored && state.roster.filter((candidate) => candidate.stored).length >= capacity.storage) return reject(sequence, "storage_full");
      if (!command.stored && state.roster.filter((candidate) => !candidate.stored).length >= capacity.army) return reject(sequence, "army_full");
      unit.stored = command.stored;
      return { sequence, status: "applied" };
    }
    case "roster.combine": {
      if (command.parentAId === command.parentBId) return reject(sequence, "same_parent");
      const a = state.roster.find((u) => u.id === command.parentAId && !u.lockedByRaid);
      const b = state.roster.find((u) => u.id === command.parentBId && !u.lockedByRaid);
      if (!a || !b) return reject(sequence, "not_owned");
      if (rewardOnlyZombies.has(a.key) || rewardOnlyZombies.has(b.key)) return reject(sequence, "reward_only");
      const resultKey = (ZOMBIE_COST[a.key] ?? 0) >= (ZOMBIE_COST[b.key] ?? 0) ? a.key : b.key;
      const id = options.id();
      const mutation = Math.min(0xffff, a.mutation | b.mutation | (1 << Math.floor(options.random() * 8)));
      state.roster = state.roster.filter((u) => u.id !== a.id && u.id !== b.id);
      state.roster.push({ id, key: resultKey, mutation, invasions: 0, stored: false });
      created.push(id);
      events.push({
        type: "kCombinerCombinedNotification",
        subject: [zombieNames.get(a.key) ?? a.key, zombieNames.get(b.key) ?? b.key].sort().join(" "),
      });
      events.push({ type: "kCombinerHarvestedNotification", subject: zombieNames.get(resultKey) ?? resultKey });
      return { sequence, status: "applied", createdIds: [id] };
    }
    case "shop.size": {
      const tier = sizeTier(command.size);
      if (!tier || nextSize(state.farmSize) !== command.size) return reject(sequence, "bad_tier");
      if (level < tier.level) return reject(sequence, "locked");
      const cost = command.currency === "gold" ? tier.gold : tier.brains;
      if (state.balance[command.currency] < cost) return reject(sequence, "insufficient");
      state.balance[command.currency] -= cost;
      state.farmSize = command.size;
      return { sequence, status: "applied" };
    }
    case "shop.climate": {
      const cost = climateCost(command.terrain);
      if (cost === undefined || cost <= 0) return reject(sequence, "bad_climate");
      if (state.climates.includes(command.terrain)) return reject(sequence, "already_owned");
      if (state.balance.gold < cost) return reject(sequence, "insufficient");
      state.balance.gold -= cost;
      state.climates.push(command.terrain);
      return { sequence, status: "applied" };
    }
    case "farmer.buy": {
      const head = farmerHeads.get(command.headId);
      if (!head || !head.cost) return reject(sequence, "bad_item");
      if (state.farmerHeads.includes(head.id)) return reject(sequence, "already_owned");
      const currency = head.brains ? "brains" : "gold";
      if (state.balance[currency] < head.cost) return reject(sequence, "insufficient");
      state.balance[currency] -= head.cost;
      state.farmerHeads.push(head.id);
      return { sequence, status: "applied" };
    }
    case "farmer.equip": {
      if (!state.farmerHeads.includes(command.headId)) return reject(sequence, "not_owned");
      state.farmerHeadId = command.headId;
      return { sequence, status: "applied" };
    }
    case "pet.buy": {
      const pet = pets.get(command.petKey);
      if (!pet || pet.hidden || !pet.brains || pet.cost <= 0) return reject(sequence, "bad_item");
      if (state.ownedPets.includes(pet.key)) return reject(sequence, "already_owned");
      if (levelForXp(state.balance.xp) < pet.level) return reject(sequence, "locked");
      if (state.balance.brains < pet.cost) return reject(sequence, "insufficient");
      state.balance.brains -= pet.cost;
      state.ownedPets.push(pet.key);
      state.activePet = pet.key;
      return { sequence, status: "applied" };
    }
    case "pet.equip": {
      if (command.petKey !== null && !state.ownedPets.includes(command.petKey)) {
        return reject(sequence, "not_owned");
      }
      state.activePet = command.petKey;
      if (command.petKey !== null) state.penPets = state.penPets.filter((key) => key !== command.petKey);
      return { sequence, status: "applied" };
    }
    case "pet.pen": {
      const unique = [...new Set(command.petKeys)];
      if (unique.length !== command.petKeys.length || unique.length > 4) return reject(sequence, "bad_selection");
      if (unique.some((key) => !state.ownedPets.includes(key))) return reject(sequence, "not_owned");
      state.penPets = unique;
      if (state.activePet && unique.includes(state.activePet)) state.activePet = null;
      return { sequence, status: "applied" };
    }
    case "storage.move": {
      if (!Number.isInteger(command.quantity) || command.quantity <= 0 || command.quantity > 225) return reject(sequence, "bad_quantity");
      const from = command.direction === "store" ? state.storage.received : state.storage.stored;
      const to = command.direction === "store" ? state.storage.stored : state.storage.received;
      if ((from[command.itemKey] ?? 0) < command.quantity) return reject(sequence, "insufficient_items");
      from[command.itemKey] -= command.quantity;
      to[command.itemKey] = (to[command.itemKey] ?? 0) + command.quantity;
      return { sequence, status: "applied" };
    }
    case "tutorial.complete": {
      if (state.tutorialRewarded) return reject(sequence, "already_claimed");
      state.tutorialRewarded = true;
      state.balance.gold += 200;
      return { sequence, status: "applied" };
    }
  }
}

export function applyCommandBatch(
  source: MutableGameplayState,
  commands: SequencedCommand[],
  options: EngineOptions
): EngineResult {
  const state = clone(source);
  const balanceBefore = { ...state.balance };
  const farmBefore = JSON.stringify(state.farm.plots);
  const objectsBefore = JSON.stringify(state.objects.objects);
  const questsBefore = JSON.stringify(state.quests);
  const events: QuestEvent[] = [];
  const createdZombieIds: string[] = [];
  const required: Required<EngineOptions> = {
    now: options.now,
    random: options.random ?? Math.random,
    id: options.id ?? (() => crypto.randomUUID()),
  };
  const failedResources = new Set<string>();
  const resources = (item: SequencedCommand): string[] => {
    const command = item.command;
    if (command.type.startsWith("farm.") && "oc" in command && "or" in command) return [`plot:${command.oc}:${command.or}`];
    if (command.type === "object.refund" || command.type === "object.status" || command.type === "object.upgrade") return [`object:${command.instanceId}`];
    if (command.type === "object.harvest_trees") return command.instanceIds.map((id) => `object:${id}`);
    if (command.type === "roster.sell" || command.type === "roster.status") return [`unit:${command.unitId}`];
    if (command.type === "roster.combine") return [`unit:${command.parentAId}`, `unit:${command.parentBId}`];
    if (command.type === "storage.move") return [`storage:${command.itemKey}`];
    if (command.type === "pet.buy" || command.type === "pet.equip") return [`pet:${command.petKey ?? "active"}`];
    if (command.type === "pet.pen") return ["pet:pen"];
    return [];
  };
  const results: CommandResult[] = [];
  for (const item of commands) {
    const keys = resources(item);
    if (keys.some((key) => failedResources.has(key))) {
      results.push({ sequence: item.sequence, status: "dependency_failed", error: "prior_command_failed" });
      keys.forEach((key) => failedResources.add(key));
      continue;
    }
    const result = applyOne(state, item, required, events, createdZombieIds);
    results.push(result);
    if (result.status === "rejected") keys.forEach((key) => failedResources.add(key));
  }
  const questChanges = applyQuestEvents(state.balance, state.quests, events);
  state.balance.brains += levelUpBrains(levelForXp(balanceBefore.xp), levelForXp(state.balance.xp));
  return {
    state,
    results,
    questChanges,
    createdZombieIds,
    farmChanged: farmBefore !== JSON.stringify(state.farm.plots),
    objectChanged: objectsBefore !== JSON.stringify(state.objects.objects),
    questChanged: questsBefore !== JSON.stringify(state.quests),
    balanceBefore,
  };
}

export function freshGameplayState(): MutableGameplayState {
  return {
    // Temporary debugging economy; restore the release values before shipping.
    balance: { gold: 1_000_000, brains: 10_000, xp: 0 },
    farm: { version: 0, plots: {} },
    objects: { version: 0, objects: [] },
    quests: { version: 0, completed: [], progress: [] } satisfies QuestProjection,
    inventory: {},
    storage: { received: {}, stored: {} },
    roster: [] satisfies RosterUnitProjection[],
    farmSize: 30,
    climates: ["grass"],
    farmerHeads: [...freeFarmerHeads],
    farmerHeadId: 1,
    ownedPets: [],
    activePet: null,
    penPets: [],
    zombieMax: 16,
    tutorialRewarded: false,
    raids: { progress: {}, lastRaidAt: 0 },
    epicBoss: null,
  };
}
