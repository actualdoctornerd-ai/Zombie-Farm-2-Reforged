import type {
  BalanceProjection,
  CommandResult,
  FarmPlotProjection,
  GameplayCommand,
  GameplayProjection,
  QuestProjection,
  RosterUnitProjection,
  FallenUnitProjection,
  SequencedCommand,
} from "../../../src/net/protocol";
import { EPIC_BOSS_TOKEN_GRANT_LIMIT } from "../../../src/net/protocol";
import plantRows from "../../../public/assets/plants.json";
import zombieRows from "../../../public/assets/zombies.json";
import farmerRows from "../../../public/assets/farmer.json";
import petRows from "../../../public/assets/pets/catalog.json";
import objectRows from "../../../public/assets/placeables.json";
import { boostEcon, boostKeyForName, MAX_STACK } from "../boostCatalog";
import { cropEcon } from "../catalog";
import { dropEcon } from "../raidLootCatalog";
import { XP_THRESHOLDS, levelForXp, levelUpBrains } from "../levels";
import { BASE_SHED_SLOTS, objectBuyXp, objectEcon, objectSellGold } from "../objectCatalog";
import { planClaim } from "../storage";
import { QUEST_DEFINITIONS, QUEST_REWARD } from "../questCatalog";
import { isHeadlessZombie, legalMutation, zombieSell } from "../rosterCatalog";
import { climateCost, MAX_FARM_SIZE, nextSize, sizeTier } from "../shopCatalog";
import { zombieCropEcon } from "../zombieCropCatalog";
import {
  activeBonusHeadId, farmerGold, farmerHeadHasEffect, farmerHeadXp, farmerZombieGrowMs,
} from "../../../src/farmer";
import { combineMasks } from "../../../src/zombie/mutations";
import { resolveCropMutations, plotsTouch } from "../../../src/zombie/cropMutations";
import { createCombineRandom, isCombinePromotion, selectCombineSpecies } from "../../../src/zombie/combineSpecies";
import { harvestXp, plowXp } from "../../../src/farmRewards";
import { epicBossById, epicBossHp, epicBossUnlockLevel } from "../../../src/epicBoss/catalog";
import { bossForFavoriteCrop, luresEpicBoss } from "../../../src/epicBoss/favoriteCrops";
import { reopenEpicQuests } from "../../../src/epicBoss/rewards";
import { questSubjectMatches } from "../../../src/quest/matching";
import {
  applyPeriodicEvents, claimPeriodicQuest, generatePeriodicSet, refreshPeriodicState,
  unlockLevel, xpToNextLevel,
} from "../../../src/quest/periodic/generate";
import { periodIndex } from "../../../src/quest/periodic/periods";
import type { PeriodicQuestState } from "../../../src/quest/periodic/types";
import { objectQuestAliases } from "../../../src/quest/objectVariants";
import { decorAvailable } from "../../../src/decorThemes";
import {
  combineSubject, combineSubjectAliases, mutantSubjectIndex, unitQuestSubjects,
  unitSubjectAliases,
} from "../../../src/quest/mutantSubjects";
import { encodeReceivedZombie, parseReceivedZombie } from "../../../src/zombie/receivedReward";

export const MAX_FUNCTIONAL_OBJECTS = 512;

/** The only shape a CLIENT-proposed object instance id may take. Every path that lets
 *  the client name an object it is creating runs its id through this; anything else is
 *  replaced with a server-minted one. Ids reach other players through farm visits and
 *  are used as keys throughout the client, so the document must never carry an
 *  arbitrary 128-character string just because a command field was typed `string`. */
const CLIENT_INSTANCE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** How many UNENSHRINED fallen zombies an account keeps. Oldest are dropped, so the
 *  losses a player is most likely to still want a statue for survive. Zombies already
 *  standing on one are never counted or dropped — a memorial is permanent, and the
 *  cap exists to bound a list nobody is looking at, not to erase a monument.
 *  Mirrored by MAX_REMEMBERED_FALLEN on the client. */
export const MEMORIAL_GRAVEYARD_CAP = 60;
/** SQL literal that empties a spent fight config, for interpolation into an UPDATE
 *  that is already setting `finished_at`. The pinned config of a raid or Epic Boss
 *  encounter is by far the largest thing this server stores — ~14 KB a session, and
 *  56% of the whole database at beta volume — but it is read exactly once, by the
 *  finish path, and only while `finished_at IS NULL`: a settled session answers from
 *  `result_json`, and an already-finished one answers 409. Neither reads it again, so
 *  every path that finishes a session drops it in the same statement. That makes the
 *  30-day purge a backstop rather than the only thing bounding these tables.
 *
 *  Clearing it can only ever race with a live read, and that fails closed: `{}` parses
 *  but does not survive the playerUnits/enemyUnits shape check, so the session closes
 *  as `bad_session_config` instead of settling on an empty fight.
 *
 *  NOT for pvp_sessions_v3 — a PvP config outlives its fight on purpose, so the
 *  defender can re-simulate the attack on their farm (see migration 0055). */
export const CONFIG_SPENT = "'{}'";
export const PLOT_SIZE = 4;
/** How many plots the LARGEST farm on the ladder holds — plots are PLOT_SIZE square
 *  and may not overlap, so a size-N farm fits floor(N / PLOT_SIZE) of them per side.
 *
 *  DERIVED, never a literal. It used to be hard-coded at 225, which was exactly right
 *  for the 60x60 farm that was then the top tier and became a trap the moment 70x70
 *  was added: the farm grew, the cap did not, and the last 64 plots of a 1,250,000-gold
 *  upgrade could never be plowed — every attempt rejected `farm_full` and rolled back.
 *  `validCoord` already keeps a plot inside the account's OWN farm, so this is the
 *  ceiling across every farm size rather than a per-account limit. */
export const MAX_FARM_PLOTS = Math.floor(MAX_FARM_SIZE / PLOT_SIZE) ** 2;
export const GROW_GRACE_MS_V3 = 15_000;
export const PLOW_COST_V3 = 10;

interface ObjectRule {
  name: string;
  /** Base tile this row recolours (see quest/objectVariants). */
  variantOf?: string;
  /** Seasonal label; absent = evergreen (see src/decorThemes). */
  theme?: string;
  category: string;
  armyMax: number;
  storageSlots: number;
  zombieSlots: number; // Mausoleum zombie-storage capacity (0 for everything else)
  growMs: number;
  harvestValue: number;
  zombiePot?: boolean;
}

interface NamedRule { name: string }
interface ZombieRule extends NamedRule {
  key: string;
  mutation?: number;
  rewardOnly?: boolean;
  tier?: number;
  category?: string;
  group?: string;
  className?: string;
}

const plantNames = new Map((plantRows as (NamedRule & { key: string })[]).map((r) => [r.key, r.name]));
const zombieRules = zombieRows as ZombieRule[];
const zombieNames = new Map(zombieRules.map((r) => [r.key, r.name]));
const zombieMutations = new Map(zombieRules.map((r) => [r.key, r.mutation ?? 0]));
const rewardOnlyZombies = new Set(zombieRules.filter((r) => r.rewardOnly).map((r) => r.key));
const zombieRuleByKey = new Map(zombieRules.map((r) => [r.key, r]));
// Mutation bit -> Market mutant species name, so a zombie that grew its mutation in
// the field still satisfies the quests that name the bought mutant (quest 55/56).
const mutantSubjects = mutantSubjectIndex(zombieRules);

/** Every quest identity of a roster unit: its species name plus each mutant species
 *  its carried mutations make it equivalent to. */
function unitSubjects(unit: { key: string; mutation?: number }): string[] {
  return unitQuestSubjects(
    zombieNames.get(unit.key) ?? unit.key,
    unit.mutation ?? 0,
    mutantSubjects
  );
}

/** The Zombie Pot's "combined" event. Its subject is the two parents' species names
 *  sorted and joined; the aliases cover every pairing their mutations also stand for,
 *  so quest 56 accepts two field-mutated Regular Zombies as a Carrot + Tomato pair. */
function combinerCombined(
  a: { key: string; mutation?: number },
  b: { key: string; mutation?: number }
): QuestEvent {
  const [subjectsA, subjectsB] = [unitSubjects(a), unitSubjects(b)];
  return {
    type: "kCombinerCombinedNotification",
    subject: combineSubject(subjectsA[0], subjectsB[0]),
    aliases: combineSubjectAliases(subjectsA, subjectsB),
  };
}

/** Coloured graves this farm has placed. They gate the matched-pair colour ladder
 *  (Green -> Blue -> Red) exactly as they gate planting that class on the client, so
 *  the authoritative result can never award a colour the player has not unlocked. */
const COLOR_GRAVE_KEYS = {
  Blue: "gravestoneBlue",
  Red: "gravestoneRed",
  Silver: "gravestoneSilver",
} as const;

function hasColorGrave(
  state: MutableGameplayState,
  color: "Blue" | "Red" | "Silver"
): boolean {
  const key = COLOR_GRAVE_KEYS[color];
  return state.objects.objects.some(
    (object) => object.status === "placed" && object.catalogKey === key
  );
}

/** Use the same slot-1 species, permanent-special, colour-ladder and rare-promotion
 * rules as the timed client Zombie Pot. */
function combinedSpecies(
  state: MutableGameplayState,
  a: RosterUnitProjection,
  b: RosterUnitProjection,
  playerLevel: number
): string | null {
  const ar = zombieRuleByKey.get(a.key);
  const br = zombieRuleByKey.get(b.key);
  return selectCombineSpecies(
    {
      key: a.key, tier: ar?.tier, group: ar?.group, className: ar?.className,
      isMutant: ar?.category === "mutant", isSpecial: ar?.category === "special",
    },
    {
      key: b.key, tier: br?.tier, group: br?.group, className: br?.className,
      isMutant: br?.category === "mutant", isSpecial: br?.category === "special",
    },
    playerLevel,
    createCombineRandom(a.id, b.id),
    (color) => hasColorGrave(state, color)
  );
}

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
/** Recolour siblings a bought object also answers to, so "buy a Fence" counts a
 *  Blue Fence. Must match the client's own map or the two disagree on progress. */
const objectAliases = objectQuestAliases(objectRows as (ObjectRule & { key: string })[]);
/** The Mausoleum upgrade ladder, cheapest tier first. Each tier is its own catalog
 *  key worth five more zombie slots, and its price is the INCREMENTAL cost of that
 *  step — so the ladder must be climbed one rung at a time (see object.upgrade) or
 *  the later tiers would be reachable for a fraction of their intended cost. */
const mausoleumTiers = [...objectRules.entries()]
  .filter(([, rule]) => (rule.zombieSlots ?? 0) > 0)
  .map(([key, rule]) => ({ key, slots: rule.zombieSlots }))
  .sort((a, b) => a.slots - b.slots);
/** Slots of the only Mausoleum tier that can be BOUGHT (the rest are upgrades). */
const baseMausoleumSlots = mausoleumTiers[0]?.slots ?? 0;
/** The tier that follows a building with `slots` capacity (undefined at the top). */
const nextMausoleumTier = (slots: number) => mausoleumTiers.find((tier) => tier.slots > slots);

/** The Memorial Statue: the one functional object bought in quantity, sellable, and
 *  able to hold a fallen zombie. Keyed off the catalog so the rule follows the item
 *  rather than being spelled out at every site that has to know about it. */
const isMemorial = (catalogKey: string) => catalogKey === "memorialStatue";

/** Take whoever stands on statue `instanceId` back off it. Returns false when the
 *  plinth was already bare, which is what makes memorial.clear reject a no-op.
 *
 *  `now` stamps `releasedAt`, which is what the graveyard's cap orders by from here
 *  on: a player enshrines a memorable — and so usually OLD — loss, and ranking it by
 *  `diedAt` on the way back would drop it straight off the end of a busy farm's list.
 *  It rejoins at the top and ages out behind the next MEMORIAL_GRAVEYARD_CAP losses. */
function releaseMemorial(
  state: MutableGameplayState, instanceId: string, now: number
): boolean {
  const occupant = (state.fallen ?? []).find((f) => f.memorialObjectId === instanceId);
  if (!occupant) return false;
  occupant.memorialObjectId = undefined;
  occupant.releasedAt = now;
  return true;
}

/** Trim a client-supplied memorial name to the same rule the roster uses (24 code
 *  points, no control characters). Returns null when nothing usable is left, which
 *  keeps whatever name the row already had. */
function memorialName(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Filtered by code point rather than by regex so the source carries no literal
  // control characters of its own.
  const printable = [...raw].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  }).join("").replace(/\s+/g, " ").trim();
  const cleaned = [...printable].slice(0, 24).join("");
  return cleaned || null;
}

const farmerHeads = new Map(farmerRows.heads.map((head) => [head.id, head]));
/** The head supplying bonuses: the pinned one, else whichever is being worn. */
const bonusHeadOf = (state: { farmerHeadId: number; farmerBonusHeadId?: number | null }) =>
  activeBonusHeadId(state.farmerHeadId, state.farmerBonusHeadId);
const freeFarmerHeads = farmerRows.heads.filter((head) => !head.cost).map((head) => head.id);
const pets = new Map(petRows.pets.map((pet) => [pet.key, pet]));

export interface MutableGameplayState extends GameplayProjection {}

export interface EngineOptions {
  now: number;
  random?: () => number;
  id?: () => string;
  /** Seeds the daily/weekly quest roll, so two farms are not handed the same board on
   *  the same day. Optional only so the many unit tests that drive the engine directly
   *  need not invent one — every real call site passes the account id. */
  accountId?: string;
}

export interface EngineResult {
  state: MutableGameplayState;
  results: CommandResult[];
  questChanges: { questId: string; counts: number[]; completed: boolean }[];
  createdZombieIds: string[];
  farmChanged: boolean;
  objectChanged: boolean;
  questChanged: boolean;
  periodicChanged: boolean;
  balanceBefore: BalanceProjection;
}

/** `aliases` are extra subjects this same event answers to (mutation identities);
 *  they never add a second increment. See src/quest/mutantSubjects. */
export interface QuestEvent { type: string; subject: string; aliases?: string[] }

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

/** How many ITEMS the account's shed holds. Derived from the placed shed's tier, with
 *  the free starter Shabby Shed as the floor — the same rule the client's own cap uses
 *  (see `itemCap` in main.ts), so this can only ever refuse what the client refuses.
 *
 *  A shed cannot itself be put away (`object.status` rejects any storageSlots object),
 *  so "placed" and "owned" are the same set here; reading the tier rather than a stored
 *  number is what stops an edited client declaring its own capacity. */
function shedCapacity(state: MutableGameplayState): number {
  let cap = BASE_SHED_SLOTS;
  for (const obj of state.objects.objects) {
    if (obj.status !== "placed") continue;
    cap = Math.max(cap, objectRules.get(obj.catalogKey)?.storageSlots ?? 0);
  }
  return cap;
}

/** Items currently occupying shed slots (stacked counts, all keys). */
const storedItemTotal = (state: MutableGameplayState): number =>
  Object.values(state.storage.stored).reduce((total, count) => total + Math.max(0, count), 0);

function placedCapacity(state: MutableGameplayState): { army: number; storage: number } {
  let army = state.zombieMax;
  let storage = 0;
  for (const obj of state.objects.objects) {
    if (obj.status !== "placed") continue;
    const rule = objectRules.get(obj.catalogKey);
    army += rule?.armyMax ?? 0;
    // Zombie storage comes from the placed Mausoleum's TIER (each upgrade tier is a
    // separate catalog key worth five more slots); only one can be placed.
    storage = Math.max(storage, rule?.zombieSlots ?? 0);
  }
  return { army, storage };
}

/** A unit reserved inside a Zombie Pot occupies NEITHER the farm nor the Mausoleum.
 *
 * combine_start flips both parents to `stored` with a `pot:<id>` lock — deliberately,
 * to free their army slots — and the rows survive only so collection can derive and
 * validate the child (they are deleted the moment it is collected). The client hides
 * them outright: main.ts filters `pot:` locks out of the roster it reconciles, so they
 * appear in no count the player can see, and nothing in the UI can reach them to free
 * a slot.
 *
 * Counting them as crypt occupants therefore made the Mausoleum read FULL to the
 * server and roomy to the player: every claim the client allowed came straight back
 * as `storage_full` and the reward snapped into Received again — an unbreakable loop
 * with no visible cause, two hidden slots per running pot. Occupancy means units the
 * player can see and act on. */
const reservedInPot = (unit: RosterUnitProjection): boolean =>
  unit.lockedByRaid?.startsWith("pot:") ?? false;
const activeUnits = (state: MutableGameplayState): number =>
  state.roster.filter((unit) => !unit.stored && !reservedInPot(unit)).length;
const storedUnits = (state: MutableGameplayState): number =>
  state.roster.filter((unit) => unit.stored && !reservedInPot(unit)).length;

/** Does the account already hold this species? A unique award waiting in Received
 * counts as owned, so a second voucher cannot mint a duplicate in the window before
 * the first copy is claimed into the Mausoleum. */
function ownsZombieKey(state: MutableGameplayState, key: string): boolean {
  if (state.roster.some((unit) => unit.key === key)) return true;
  return Object.entries(state.storage.received).some(
    ([name, count]) => count > 0 && parseReceivedZombie(name)?.key === key
  );
}

/** Place a zombie awarded by a non-harvest system. A full active farm sends the
 * unique unit to Received; claiming it later consumes a real Mausoleum slot.
 * Returns true when the unit entered the roster under `id` — a Received award has
 * no roster row yet, so its id must not be reported as created. */
function addAwardedZombie(state: MutableGameplayState, key: string, id: string): boolean {
  const cap = placedCapacity(state);
  const active = activeUnits(state);
  if (active >= cap.army) {
    const marker = encodeReceivedZombie({ id, key, mutation: zombieDefaultMutation(key), invasions: 0 });
    state.storage.received[marker] = 1;
    return false;
  }
  state.roster.push({
    id,
    key,
    mutation: zombieDefaultMutation(key),
    invasions: 0,
    stored: false,
  });
  return true;
}

function hasPlowingMonolith(state: MutableGameplayState): boolean {
  return state.objects.objects.some(
    (object) => object.status === "placed" && object.catalogKey === "monolithPlowing"
  );
}

function hasMutationMonolith(state: MutableGameplayState): boolean {
  return state.objects.objects.some(
    (object) => object.status === "placed" && object.catalogKey === "monolithMutation"
  );
}

/** Every plot touching this 4x4 plot — edge or corner. Plot origins are free-placed
 *  (see `validCoord` above), so this is a footprint test rather than a lookup of the
 *  eight lattice-aligned neighbours; a plot laid down flush but off-lattice mutates
 *  its neighbour exactly like an aligned one. Crop age is deliberately ignored. */
function adjacentCropKeys(
  plots: Record<string, FarmPlotProjection>,
  oc: number,
  or: number
): string[] {
  const keys: string[] = [];
  for (const [key, plot] of Object.entries(plots)) {
    const [otherC, otherR] = key.split(":").map(Number);
    if (!plotsTouch(oc, or, otherC, otherR, PLOT_SIZE)) continue;
    if (plot.state === "planted" && !plot.zombie) keys.push(plot.cropKey);
  }
  return keys;
}

/** Roll a just-harvested crop for an Epic Boss LURE: the rare chance that this crop's
 *  favourite boss (src/epicBoss/favoriteCrops.ts) turns up and starts its own event,
 *  free, when none is running.
 *
 *  UNLIKE the Boss Token roll two functions down, this one is the SERVER'S. A token is
 *  worth a single brain, which is why the client is allowed to mint its own and merely
 *  report them; a lure is worth the boss's whole activation price AND reopens its prize
 *  quest chain, signature zombie included. That is squarely the kind of grant this
 *  project keeps on the authoritative side, and the roll costs nothing extra here — the
 *  harvest is already being replayed and grow-gated against the server's own clock.
 *
 *  The gates are the same three the market card enforces, in the order that makes the
 *  cheapest check first: no event already running, the crop is somebody's favourite,
 *  and that somebody is unlocked at this account's level. A locked boss's crop is a
 *  silent no-op rather than a fallback to some other boss — which boss you might draw
 *  is supposed to be the player's planting decision, not the game's consolation prize.
 *
 *  Returns whether an event was started; the caller uses it only to stop rolling. */
function maybeLureEpicBoss(
  state: MutableGameplayState, cropKey: string, options: Required<EngineOptions>
): boolean {
  const run = state.epicBoss;
  if (run && !run.completedAt && run.expiresAt > options.now) return false;
  const def = epicBossById(bossForFavoriteCrop(cropKey));
  if (!def || levelForXp(state.balance.xp) < epicBossUnlockLevel(def)) return false;
  const econ = cropEcon(cropKey);
  if (!econ || !luresEpicBoss(econ.growMs, options.random)) return false;
  const hp = epicBossHp(def, 1);
  state.epicBoss = {
    runId: options.id(), bossId: def.id, activatedAt: options.now,
    expiresAt: options.now + def.durationMs, level: 1, maxHp: hp, currentHp: hp,
    encounterStartedAt: 0, retryReadyAt: 0, tokenCount: 0, completedAt: 0,
    attackOrder: [],
    // What the client announces on: a run carrying a crop is one the player never
    // asked for. A bought run leaves this unset (v3/epicBoss.ts activate).
    startedCrop: cropKey,
  };
  // Exactly what a paid activation does, and for the same reason — a new run re-offers
  // this boss's chain so its prizes are earnable again. Skipped when nothing of this
  // boss's was ever finished, which is what reopenEpicQuests returning null means.
  const reopened = reopenEpicQuests(state.quests, def.questIds);
  if (reopened) {
    state.quests.completed = reopened.completed;
    state.quests.progress = reopened.progress;
  }
  return true;
}

function rewardHarvest(
  state: MutableGameplayState,
  key: string,
  plot: Extract<FarmPlotProjection, { state: "planted" }>,
  makeId: () => string,
  created: string[],
  random: () => number,
  mutationCropKeys: readonly string[] = []
): { ok: true; event: QuestEvent } | { ok: false; error: string } {
  if (plot.zombie) {
    // A grown zombie enters the active army first, then an available Mausoleum.
    // If both are full, the ripe crop remains planted.
    const cap = placedCapacity(state);
    const active = activeUnits(state);
    const stored = storedUnits(state);
    if (active >= cap.army && stored >= cap.storage) {
      return { ok: false, error: "capacity_full" };
    }
    const id = makeId();
    const rule = zombieRuleByKey.get(key);
    const mutation = resolveCropMutations(zombieDefaultMutation(key), mutationCropKeys, {
      guaranteed: hasMutationMonolith(state),
      headless: rule?.group === "Headless",
      random,
    });
    state.roster.push({ id, key, mutation, invasions: 0, stored: active >= cap.army });
    created.push(id);
    state.balance.xp += harvestXp(zombieCropEcon(key)?.xp ?? 0, hasPlowingMonolith(state));
    return {
      ok: true,
      event: {
        type: "kCropHarvestedZombieNotification",
        subject: zombieNames.get(key) ?? key,
        // A crop-adjacency mutation makes this unit the Market mutant's equal, so the
        // "Harvest a Tomato Zombie" objective counts a home-grown Tomatohead too.
        aliases: unitSubjectAliases(zombieNames.get(key) ?? key, mutation, mutantSubjects),
      },
    };
  }
  const harvestValue = plot.sell * (plot.fertilized ? 2 : 1);
  state.balance.gold += farmerGold(harvestValue, bonusHeadOf(state));
  state.balance.xp += harvestXp(plot.xp, hasPlowingMonolith(state));
  // Boss Tokens are NOT rolled here. The client rolls them at the moment it harvests
  // and reports the result with `epicBoss.token`; see that command and the note on it
  // in protocol.ts for why the authoritative roll was given up.
  return { ok: true, event: { type: "kCropHarvestedNotification", subject: plantNames.get(key) ?? key } };
}

/** Where a quest's Item reward lands. Boost names stack into the boost inventory; a
 * decor/placeable name lands in Received by NAME, exactly like a raid loot drop, so
 * the existing `storage.claim` command turns it into an owned object.
 *
 * An unrecognised name grants nothing rather than inventing an item — several
 * catalog quests still name original-game content this reimplementation has no
 * entry for (see docs/mechanics/QUEST_ITEM_REWARDS.md). Trophy drops with no `tile`
 * (e.g. Rusty Fragment) are still recorded: they are collectibles, not claimables. */
function grantQuestItem(
  name: string,
  sinks: { inventory?: Record<string, number>; received?: Record<string, number> }
): void {
  if (!name) return;
  const boostKey = boostKeyForName(name);
  if (boostKey) {
    if (!sinks.inventory) return;
    sinks.inventory[boostKey] = Math.min(MAX_STACK, (sinks.inventory[boostKey] ?? 0) + 1);
    return;
  }
  const drop = dropEcon(name);
  // A currency drop is paid as currency by its own reward type, never as an item.
  if (!drop || drop.brains || drop.gold) return;
  if (!sinks.received) return;
  sinks.received[name] = (sinks.received[name] ?? 0) + 1;
}

export function applyQuestEvents(
  balance: BalanceProjection,
  quests: QuestProjection,
  events: QuestEvent[],
  options: {
    includeEpic?: boolean;
    epicQuestIds?: ReadonlySet<string>;
    /** Item-reward sinks. Omitted (as in unit tests that only assert progress),
     *  Item rewards stay dormant instead of being granted into nothing. */
    inventory?: Record<string, number>;
    storage?: { received: Record<string, number>; stored: Record<string, number> };
  } = {}
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
        if (!questSubjectMatches(req.notificationObject, event.subject, event.aliases)) return;
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
    // Currency and item rewards are catalog-authoritative. Zombie rewards remain
    // dormant here: every type-5 quest is an epic-boss quest, and those resolve
    // through epicQuestZombieReward so the unit lands in the authoritative roster.
    if (def.rewardType === QUEST_REWARD.Xp) balance.xp += def.rewardValue;
    else if (def.rewardType === QUEST_REWARD.Gold) balance.gold += def.rewardValue;
    else if (def.rewardType === QUEST_REWARD.Brains) balance.brains += def.rewardValue;
    else if (def.rewardType === QUEST_REWARD.Item) {
      grantQuestItem(def.rewardItemKey, {
        inventory: options.inventory,
        received: options.storage?.received,
      });
    }
    // Paid ON TOP of whichever branch above ran. Only the Reforged achievements carry
    // one; every imported quest has it at zero.
    if (def.rewardBrains) balance.brains += def.rewardBrains;
  }

  quests.completed = [...completed];
  quests.progress = [...progress].map(([questId, counts]) => ({ questId, counts }));
  return [...changed].map((questId) => ({
    questId,
    counts: progress.get(questId) ?? [],
    completed: completed.has(questId),
  }));
}

/** The daily/weekly document, materialised on first touch. It is optional on the
 *  projection (a Worker predating the feature omits it), so everything that reaches for
 *  it goes through here rather than assuming it exists. */
export function periodicStateOf(state: MutableGameplayState): PeriodicQuestState {
  if (!state.periodicQuests) state.periodicQuests = { version: 0, daily: null, weekly: null };
  return state.periodicQuests;
}

/** Roll the daily/weekly sets forward to `now` at the player's current level, which is
 *  what generates a new day's quests and discards an unclaimed old day's. Returns true
 *  if a set was replaced. */
export function refreshPeriodic(
  state: MutableGameplayState,
  accountId: string,
  now: number
): boolean {
  const level = levelForXp(state.balance.xp);
  return refreshPeriodicState(periodicStateOf(state), {
    accountId,
    level,
    xpToNext: xpToNextLevel(level, XP_THRESHOLDS),
    now,
  });
}

function reject(sequence: number, error: string): CommandResult {
  return { sequence, status: "rejected", error };
}

/** Apply a bulk farm command as its individual plots, in order, under exactly the
 *  single-plot rules — including the ones that depend on what the earlier plots in the
 *  same command already did (gold spent, XP gained and the level it may cross, the plot
 *  count against MAX_FARM_PLOTS, overlap against soil this command just laid).
 *
 *  A plot the server refuses is skipped, not fatal: a drag-paint stroke that runs out of
 *  gold halfway, or crosses ground that changed under it, should still lay the soil it
 *  can afford. The command as a WHOLE is only rejected when nothing at all applied, so
 *  the client's existing rejection toast still fires for the cases the player must see
 *  (no funds, wrong level). A partial refusal is reported through `rejectedPlots` so it
 *  can be summarised once instead of once per plot.
 *
 *  An empty list is `applied`: there is nothing to refuse, and treating "no work" as a
 *  failure would surface an error for a command the client should never have sent. */
function applyBulkFarm(
  state: MutableGameplayState,
  sequence: number,
  options: Required<EngineOptions>,
  events: QuestEvent[],
  created: string[],
  commands: GameplayCommand[]
): CommandResult {
  let applied = 0;
  let rejectedPlots = 0;
  let firstError = "";
  for (const command of commands) {
    const result = applyOne(state, { sequence, command }, options, events, created);
    if (result.status === "applied") applied++;
    else {
      rejectedPlots++;
      firstError ||= result.error ?? "no_effect";
    }
  }
  if (!applied && rejectedPlots) return reject(sequence, firstError);
  return rejectedPlots
    ? { sequence, status: "applied", rejectedPlots, rejectedPlotError: firstError }
    : { sequence, status: "applied" };
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
    case "writer.claim":
      return { sequence, status: "applied" };
    case "farm.plow": {
      if (!validCoord(command.oc, state.farmSize) || !validCoord(command.or, state.farmSize)) return reject(sequence, "bad_coord");
      const key = plotKey(command.oc, command.or);
      if (state.farm.plots[key]?.state === "planted") return reject(sequence, "plot_occupied");
      if (state.farm.plots[key]?.state === "plowed") return reject(sequence, "already_plowed");
      if (!state.farm.plots[key] && overlapsExistingPlot(state.farm.plots, command.oc, command.or)) {
        return reject(sequence, "plot_overlap");
      }
      const free = hasPlowingMonolith(state);
      const cost = free ? 0 : PLOW_COST_V3;
      if (state.balance.gold < cost) return reject(sequence, "insufficient");
      if (!state.farm.plots[key] && Object.keys(state.farm.plots).length >= MAX_FARM_PLOTS) return reject(sequence, "farm_full");
      state.balance.gold -= cost;
      state.balance.xp += plowXp(free);
      state.farm.plots[key] = { state: "plowed" };
      events.push({ type: "kSoilPlowedNotification", subject: "Plow" }, { type: "kNewSoilPlowedNotification", subject: "Plow" });
      return { sequence, status: "applied" };
    }
    case "farm.plow_many":
      return applyBulkFarm(state, sequence, options, events, created,
        command.plots.map((plot) => ({ type: "farm.plow", oc: plot.oc, or: plot.or })));
    case "farm.plant_many":
      return applyBulkFarm(state, sequence, options, events, created,
        command.plots.map((plot) => ({
          type: "farm.plant", oc: plot.oc, or: plot.or,
          cropKey: command.cropKey, fertilized: plot.fertilized,
        })));
    case "farm.plant": {
      if (!validCoord(command.oc, state.farmSize) || !validCoord(command.or, state.farmSize)) return reject(sequence, "bad_coord");
      const key = plotKey(command.oc, command.or);
      if (state.farm.plots[key]?.state === "planted") return reject(sequence, "plot_occupied");
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
      // Roll this on the live client so the actor animation and leaf effect appear
      // immediately. It remains limited to vegetables and the existing 2x payout.
      const fertilized = !!veg && command.fertilized === true;
      state.farm.plots[key] = {
        state: "planted",
        cropKey: command.cropKey,
        plantedAt: options.now,
        growMs: zombie
          ? farmerZombieGrowMs(
              zombie.growMs * (hasMutationMonolith(state) && zombieDefaultMutation(command.cropKey) ? 0.5 : 1),
              bonusHeadOf(state)
            )
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
      const harvest = rewardHarvest(state, plot.cropKey, plot, options.id, created,
        options.random, adjacentCropKeys(state.farm.plots, command.oc, command.or));
      if (!harvest.ok) return reject(sequence, harvest.error);
      // After the harvest is known to have applied: a rejected one (a full army on a
      // zombie crop) leaves the crop in the ground, and a crop still standing has not
      // been pulled, so it cannot have lured anything.
      if (!plot.zombie) maybeLureEpicBoss(state, plot.cropKey, options);
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
    case "farm.move": {
      // Layout only: the plot record — crop, plantedAt, value, fertilised flag —
      // moves across untouched, so nothing about growth or payout is re-decided.
      if (!validCoord(command.oc, state.farmSize) || !validCoord(command.or, state.farmSize) ||
          !validCoord(command.toOc, state.farmSize) || !validCoord(command.toOr, state.farmSize)) {
        return reject(sequence, "bad_coord");
      }
      const from = plotKey(command.oc, command.or);
      const plot = state.farm.plots[from];
      if (!plot) return reject(sequence, "nothing_to_move");
      // Only BARE tilled ground moves. A planted plot's payout and its mutation
      // adjacency are decided where it sits, and spent soil is not tilled ground.
      if (plot.state !== "plowed") return reject(sequence, "plot_occupied");
      const to = plotKey(command.toOc, command.toOr);
      if (from === to) return { sequence, status: "applied" };
      // The destination may overlap the plot's OWN footprint (a one-tile nudge), so
      // judge the overlap with this plot already lifted off the board.
      const { [from]: _lifted, ...others } = state.farm.plots;
      if (others[to] || overlapsExistingPlot(others, command.toOc, command.toOr)) {
        return reject(sequence, "plot_overlap");
      }
      delete state.farm.plots[from];
      state.farm.plots[to] = plot;
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
      const boost = boostEcon(command.key);
      if (!boost) return reject(sequence, "bad_item");
      const have = state.inventory[command.key] ?? 0;
      if (have < 1) return reject(sequence, "none_owned");
      if (boost?.gift) {
        if (ownsZombieKey(state, boost.gift)) return reject(sequence, "already_owned");
        const id = options.id();
        const placed = addAwardedZombie(state, boost.gift, id);
        state.inventory[command.key] = have - 1;
        // A voucher zombie filed in Received has no roster row until it is claimed,
        // so it must not be aliased onto a client-side unit that cannot exist yet.
        if (!placed) return { sequence, status: "applied" };
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
          // Insta-Plow waives the gold cost, but otherwise rewards each plot like
          // a manual plow (including the Plowing Monolith's XP tradeoff).
          state.balance.xp += plowXp(hasPlowingMonolith(state));
          effects++;
          events.push(
            { type: "kSoilPlowedNotification", subject: "Plow" },
            { type: "kNewSoilPlowedNotification", subject: "Plow" },
          );
        }
      } else if (command.key === "insta_harvest") {
        const mutationPlots = clone(state.farm.plots);
        const ripe = Object.entries(state.farm.plots)
          .filter((entry): entry is [string, Extract<FarmPlotProjection, { state: "planted" }>] => entry[1].state === "planted" && isRipe(entry[1], options.now))
          .sort((a, b) => a[1].plantedAt - b[1].plantedAt || a[0].localeCompare(b[0]));
        for (const [key, plot] of ripe) {
          const createdAt = created.length;
          const [oc, or] = key.split(":").map(Number);
          const harvest = rewardHarvest(state, plot.cropKey, plot, options.id, created,
            options.random, adjacentCropKeys(mutationPlots, oc, or));
          if (!harvest.ok) continue; // capacity-full zombie crops remain planted
          // One sweep can pull dozens of favourite crops. Each rolls, but the first to
          // hit leaves an event running, and maybeLureEpicBoss refuses from then on —
          // so a field-wide Insta-Harvest can start one event, never a queue of them.
          if (!plot.zombie) maybeLureEpicBoss(state, plot.cropKey, options);
          if (created.length > createdAt) {
            createdZombieSources.push({ id: created[created.length - 1], oc, or });
          }
          state.farm.plots[key] = { state: "spent", zombie: plot.zombie };
          effects++;
          events.push(harvest.event);
        }
        // Insta-Harvest includes every ripe placed fruit tree in this same atomic
        // activation, using the normal tree rewards and regrow timing.
        for (const obj of state.objects.objects) {
          if (obj.status !== "placed") continue;
          const rule = objectRules.get(obj.catalogKey);
          if (!rule?.growMs || !rule.harvestValue || (obj.readyAt ?? 0) > options.now) continue;
          state.balance.gold += farmerGold(rule.harvestValue, bonusHeadOf(state));
          obj.readyAt = options.now + rule.growMs;
          effects++;
          events.push({ type: "kCropHarvestedNotification", subject: rule.name });
        }
      } else if (command.key === "insta_grow") {
        if (command.target === "zombie_pot") {
          // Zombie Pot timers/jobs are presentation state until collection. The
          // client emits this command only after finishCombineNow succeeds, while
          // roster.combine separately validates both authoritative parents and
          // derives the result. Requiring a Pot in the functional-object projection
          // here falsely rolls back boosts used on legacy/restored Pots even though
          // the subsequent (including rare-special) collection is valid.
          effects = 1;
        } else {
          const key = plotKey(command.oc ?? -1, command.or ?? -1);
          const plot = state.farm.plots[key];
          // The client uses the exact grow timer while ordinary harvests allow a
          // small latency grace. Accept a targeted planted crop even if it has just
          // entered that grace window; otherwise a legitimate boost followed by a
          // harvest reports a misleading `no_effect` state-change rollback.
          if (plot?.state === "planted") {
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
      // Seasonal decor sells only while its theme is on the allow-list. The market
      // hides those cards; this is what makes hiding them enforceable. BUYING only —
      // object.place/status/restore stay open so an owned decor is never stranded.
      if (!decorAvailable(objectRules.get(command.catalogKey))) return reject(sequence, "locked");
      // Only the base Mausoleum is sold; its upgrade tiers are reachable solely
      // through object.upgrade, one rung at a time.
      const buySlots = objectRules.get(command.catalogKey)?.zombieSlots ?? 0;
      if (buySlots > 0 && buySlots !== baseMausoleumSlots) return reject(sequence, "bad_item");
      const isZombiePot = command.catalogKey === "zombieCombiner";
      // `functional` normally means one per farm. Two exceptions: the Zombie Pot's
      // three, and the Memorial Statue, which has no cap at all — it is bought once
      // per zombie the player wants to remember. Mirrors placeablePurchaseLimit.
      const purchaseLimit = isZombiePot ? 3
        : isMemorial(command.catalogKey) ? undefined
        : objectRules.get(command.catalogKey)?.category === "functional" ? 1 : undefined;
      if (purchaseLimit !== undefined && state.objects.objects.filter((object) =>
        object.catalogKey === command.catalogKey).length >= purchaseLimit) {
        return reject(sequence, "object_limit");
      }
      const cost = isZombiePot ? (state.zombiePotBought ? 3 : 500) : econ.cost;
      const currency = isZombiePot
        ? (state.zombiePotBought ? "brains" : "gold")
        : (econ.brains ? "brains" : "gold");
      if (state.balance[currency] < cost) return reject(sequence, "insufficient");
      const requested = command.clientInstanceId;
      const instanceId = requested && CLIENT_INSTANCE_ID.test(requested) &&
        !state.objects.objects.some((o) => o.instanceId === requested) ? requested : options.id();
      state.balance[currency] -= cost;
      state.balance.xp += objectBuyXp(
        cost,
        econ.xp,
        currency === "brains",
        econ.purchaseLimit !== undefined
      );
      if (isZombiePot) state.zombiePotBought = true;
      const rule = objectRules.get(command.catalogKey);
      state.objects.objects.push({ instanceId, catalogKey: command.catalogKey, status: "placed",
        ...(isZombiePot ? { purchaseCost: cost, purchaseCurrency: currency } : {}),
        ...(rule?.growMs ? { readyAt: options.now + rule.growMs } : {}) });
      events.push({ type: "kItemBoughtNotification", subject: rule?.name ?? command.catalogKey,
        aliases: objectAliases.get(command.catalogKey) as string[] | undefined });
      return { sequence, status: "applied", createdIds: [instanceId] };
    }
    case "object.refund": {
      const index = state.objects.objects.findIndex((o) => o.instanceId === command.instanceId);
      if (index < 0) return reject(sequence, "not_owned");
      const obj = state.objects.objects[index];
      const econ = objectEcon(obj.catalogKey);
      if (!econ) return reject(sequence, "bad_item");
      // Functional buildings are permanent. The Memorial Statue is the exception:
      // it is bought in quantity, so it has to be reversible.
      if (objectRules.get(obj.catalogKey)?.category === "functional" && !isMemorial(obj.catalogKey)) {
        return reject(sequence, "not_sellable");
      }
      // Selling the plinth must not bury the zombie on it a second time.
      releaseMemorial(state, obj.instanceId, options.now);
      state.objects.objects.splice(index, 1);
      const boughtWithBrains = (obj.purchaseCurrency ?? (econ.brains ? "brains" : "gold")) === "brains";
      // An invasion prize has no purchase price, so it sells for its authored value
      // rather than the one-gold floor a cost-0 item would otherwise refund.
      state.balance.gold += objectSellGold(
        obj.catalogKey, econ, obj.purchaseCost ?? null, boughtWithBrains
      );
      return { sequence, status: "applied" };
    }
    case "object.upgrade": {
      let obj = state.objects.objects.find((candidate) => candidate.instanceId === command.instanceId);
      const econ = objectEcon(command.catalogKey);
      // The free starter shed (storage01) is presentation-only and is deliberately
      // never inserted into the server-owned object document. Its first paid upgrade
      // therefore has no source instance to mutate. Adopt that existing client id as
      // a placed storage02 while still charging the full catalog price; every later
      // shed tier must continue to upgrade an owned server object.
      // Adoption is the one upgrade path that INSERTS a client-named object rather than
      // mutating one the server already minted, so it takes the same id fence as
      // object.buy and storage.claim. Without it this was the only door into the object
      // document that accepted any 128-character string the command carried.
      const adoptsFreeStarterShed = !obj && command.catalogKey === "storage02" &&
        CLIENT_INSTANCE_ID.test(command.instanceId);
      if (!obj && !adoptsFreeStarterShed) return reject(sequence, "not_owned");
      if (adoptsFreeStarterShed && state.objects.objects.length >= MAX_FUNCTIONAL_OBJECTS) {
        return reject(sequence, "object_limit");
      }
      if (!econ || econ.cost <= 0) return reject(sequence, "bad_item");
      if (level < econ.level) return reject(sequence, "locked");
      if (state.objects.objects.some((candidate) => candidate !== obj &&
        candidate.catalogKey === command.catalogKey) &&
        objectRules.get(command.catalogKey)?.category === "functional") {
        return reject(sequence, "object_limit");
      }
      // Mausoleum tiers are priced per STEP, so only the rung directly above the
      // building being upgraded is payable — and only a Mausoleum can climb it.
      const targetSlots = objectRules.get(command.catalogKey)?.zombieSlots ?? 0;
      if (targetSlots > 0) {
        const fromSlots = obj ? objectRules.get(obj.catalogKey)?.zombieSlots ?? 0 : 0;
        if (fromSlots <= 0 || nextMausoleumTier(fromSlots)?.key !== command.catalogKey) {
          return reject(sequence, "bad_tier");
        }
      }
      const currency = econ.brains ? "brains" : "gold";
      if (state.balance[currency] < econ.cost) return reject(sequence, "insufficient");
      state.balance[currency] -= econ.cost;
      state.balance.xp += objectBuyXp(
        econ.cost,
        econ.xp,
        currency === "brains",
        econ.purchaseLimit !== undefined
      );
      if (obj) obj.catalogKey = command.catalogKey;
      else {
        obj = { instanceId: command.instanceId, catalogKey: command.catalogKey, status: "placed" };
        state.objects.objects.push(obj);
      }
      const rule = objectRules.get(command.catalogKey);
      obj.readyAt = rule?.growMs ? options.now + rule.growMs : undefined;
      events.push({ type: "kItemBoughtNotification", subject: rule?.name ?? command.catalogKey,
        aliases: objectAliases.get(command.catalogKey) as string[] | undefined });
      return { sequence, status: "applied" };
    }
    case "object.status": {
      const obj = state.objects.objects.find((o) => o.instanceId === command.instanceId);
      if (!obj) return reject(sequence, "not_owned");
      // A building that HOLDS things cannot itself be put away — packing the Mausoleum
      // into the shed would take the crypt out from under its occupants and leave them
      // stored nowhere, and the shed cannot contain itself. The client's `canStore`
      // already refuses both; this is the authoritative half of that rule.
      const rule = objectRules.get(obj.catalogKey);
      if (command.status === "stored" && ((rule?.zombieSlots ?? 0) > 0 || (rule?.storageSlots ?? 0) > 0)) {
        return reject(sequence, "not_storable");
      }
      // The shed holds a key and a count, so a shelved statue is always a bare
      // plinth: its occupant goes back to the graveyard rather than into storage.
      if (command.status === "stored") releaseMemorial(state, obj.instanceId, options.now);
      obj.status = command.status;
      return { sequence, status: "applied" };
    }
    case "memorial.enshrine": {
      const obj = state.objects.objects.find((o) => o.instanceId === command.instanceId);
      if (!obj || obj.status !== "placed" || !isMemorial(obj.catalogKey)) {
        return reject(sequence, "not_owned");
      }
      const fallen = (state.fallen ?? []).find((f) => f.id === command.unitId);
      // Only a zombie this account actually lost, and only one that is not already
      // standing somewhere. Both are what stop a client inventing an occupant.
      if (!fallen) return reject(sequence, "not_owned");
      if (fallen.memorialObjectId) return reject(sequence, "already_enshrined");
      if ((state.fallen ?? []).some((f) => f.memorialObjectId === command.instanceId)) {
        return reject(sequence, "statue_occupied");
      }
      fallen.memorialObjectId = command.instanceId;
      // The name is the one client-authored field, exactly as it is for a living
      // unit. Normalized here so a hostile client cannot park control characters or
      // a novel on a plinth other players can see.
      const named = memorialName(command.name);
      if (named) fallen.name = named;
      return { sequence, status: "applied" };
    }
    case "memorial.clear": {
      const obj = state.objects.objects.find((o) => o.instanceId === command.instanceId);
      if (!obj || !isMemorial(obj.catalogKey)) return reject(sequence, "not_owned");
      if (!releaseMemorial(state, command.instanceId, options.now)) return reject(sequence, "no_effect");
      return { sequence, status: "applied" };
    }
    case "object.harvest_trees": {
      const ids = [...new Set(command.instanceIds)].slice(0, MAX_FARM_PLOTS);
      let harvested = 0;
      for (const id of ids) {
        const obj = state.objects.objects.find((o) => o.instanceId === id && o.status === "placed");
        const rule = obj ? objectRules.get(obj.catalogKey) : undefined;
        if (!obj || !rule?.growMs || !rule.harvestValue || (obj.readyAt ?? 0) > options.now) continue;
        state.balance.gold += farmerGold(rule.harvestValue, bonusHeadOf(state));
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
      if (command.stored && state.roster.filter((candidate) =>
        candidate.stored && !candidate.lockedByRaid?.startsWith("pot:")).length >= capacity.storage) {
        return reject(sequence, "storage_full");
      }
      if (!command.stored && state.roster.filter((candidate) => !candidate.stored).length >= capacity.army) return reject(sequence, "army_full");
      unit.stored = command.stored;
      return { sequence, status: "applied" };
    }
    case "roster.combine_start": {
      if (command.parentAId === command.parentBId) return reject(sequence, "same_parent");
      const marker = `pot:${command.potId}`;
      if (state.roster.some((unit) => unit.lockedByRaid === marker)) return reject(sequence, "pot_busy");
      const a = state.roster.find((unit) => unit.id === command.parentAId && !unit.lockedByRaid);
      const b = state.roster.find((unit) => unit.id === command.parentBId && !unit.lockedByRaid);
      if (!a || !b) return reject(sequence, "not_owned");
      if (rewardOnlyZombies.has(a.key) || rewardOnlyZombies.has(b.key)) return reject(sequence, "reward_only");
      const specialA = zombieRuleByKey.get(a.key)?.category === "special";
      const specialB = zombieRuleByKey.get(b.key)?.category === "special";
      if (specialA && specialB) return reject(sequence, "special_pair");
      if (specialB) return reject(sequence, "special_slot");
      const requestedLevel = Number.isInteger(command.playerLevel) && command.playerLevel! >= 1
        ? command.playerLevel!
        : level;
      if (!combinedSpecies(state, a, b, Math.min(requestedLevel, level))) return reject(sequence, "special_pair");
      // Entering the Pot consumes both active slots immediately. The rows remain
      // reserved internally so collection can derive and validate the exact child.
      a.stored = true;
      b.stored = true;
      a.lockedByRaid = marker;
      b.lockedByRaid = marker;
      // ...and WHICH parent went into slot 1 is remembered here, because that is what
      // picks the child's species and it is the one thing the collect command an hour
      // later cannot be trusted for. See potSlots.
      state.potSlots = { ...state.potSlots, [command.potId]: a.id };
      events.push(combinerCombined(a, b));
      return { sequence, status: "applied" };
    }
    case "roster.combine": {
      if (command.parentAId === command.parentBId) return reject(sequence, "same_parent");
      const marker = command.potId ? `pot:${command.potId}` : undefined;
      // Unlocked fallback keeps pots started by the pre-reservation client
      // collectable after upgrade; new starts always take the marker path.
      const first = state.roster.find((u) => u.id === command.parentAId &&
        (marker ? u.lockedByRaid === marker : !u.lockedByRaid)) ??
        (marker ? state.roster.find((u) => u.id === command.parentAId && !u.lockedByRaid) : undefined);
      const second = state.roster.find((u) => u.id === command.parentBId &&
        (marker ? u.lockedByRaid === marker : !u.lockedByRaid)) ??
        (marker ? state.roster.find((u) => u.id === command.parentBId && !u.lockedByRaid) : undefined);
      if (!first || !second) return reject(sequence, "not_owned");
      const reserved = !!marker && first.lockedByRaid === marker && second.lockedByRaid === marker;
      if (marker && !reserved && (first.lockedByRaid || second.lockedByRaid)) return reject(sequence, "not_owned");
      // WHICH PARENT WAS SLOT 1 comes from what this pot recorded at START, not from the
      // command: slot 1 decides the child's species, and the command's order is only as
      // good as the collecting client's memory of a job it began an hour ago. A client
      // that rebuilt the job from the authoritative roster used to send them back in
      // CREATION order, handing the player slot 2's species. A job started before the pot
      // recorded its slots has nothing to consult, so it keeps trusting the command.
      const startedSlotOne = command.potId ? state.potSlots?.[command.potId] : undefined;
      const [a, b] = startedSlotOne === second.id ? [second, first] : [first, second];
      if (rewardOnlyZombies.has(a.key) || rewardOnlyZombies.has(b.key)) return reject(sequence, "reward_only");
      // The slot-1 restriction is enforced when a job STARTS (combine_start). Collection
      // deliberately does not re-check it: a job persisted before the rule — reserved or
      // not — has already consumed both parents client-side, and selectCombineSpecies
      // preserves the special from either slot, so rejecting here would only destroy the
      // result. Two specials remain impossible (combinedSpecies returns null below).
      // Older clients omit the start level and retain collection-time behavior.
      // New clients send the persisted start level; capping it at the authoritative
      // current level prevents a forged value from unlocking the rare roll early.
      const requestedLevel = Number.isInteger(command.playerLevel) && command.playerLevel! >= 1
        ? command.playerLevel!
        : level;
      const resultKey = combinedSpecies(state, a, b, Math.min(requestedLevel, level));
      if (!resultKey) return reject(sequence, "special_pair");
      const capacity = placedCapacity(state);
      const activeAfterParents = activeUnits(state) - Number(!a.stored) - Number(!b.stored);
      // Where the child lands once both parents are consumed: the Mausoleum when the
      // collecting player asked for it (the Pot offers the crypt directly), otherwise
      // the army — falling back to the crypt for an unreserved legacy job whose farm is
      // full. Neither having room means it has nowhere to exist — and a farm with no
      // Mausoleum placed has NO crypt room at all — so the combine is refused rather
      // than flagging the child `stored` into a building the player does not own.
      // Decided BEFORE the parents leave the roster: rejecting afterwards would destroy
      // them for nothing. Consuming a crypt-bound parent frees its slot.
      const stored = command.stored === true || (!marker && activeAfterParents >= capacity.army);
      if (!stored && activeAfterParents >= capacity.army) {
        return reject(sequence, "capacity_full");
      }
      const freedCrypt = [a, b].filter((parent) => parent.stored && !reservedInPot(parent)).length;
      if (stored && storedUnits(state) - freedCrypt >= capacity.storage) {
        return reject(sequence, "capacity_full");
      }
      const id = options.id();
      // Mutation inheritance never invents a new bit. It carries one mutation per
      // anatomical slot and deterministically resolves a same-slot conflict. A
      // headless child then drops the head/hair-eye bits it cannot wear — the client
      // strips them in makeOwned, so storing them here would diverge (e.g. a
      // carrot-eyed slot-2 parent giving a Party Zombie eyes it can't show).
      const mutation = legalMutation(
        resultKey, combineMasks(a.mutation, b.mutation, isHeadlessZombie(resultKey))
      );
      state.roster = state.roster.filter((u) => u.id !== a.id && u.id !== b.id);
      if (command.potId && state.potSlots?.[command.potId]) {
        const remaining = { ...state.potSlots };
        delete remaining[command.potId];
        state.potSlots = remaining;
      }
      state.roster.push({ id, key: resultKey, mutation, invasions: 0, stored });
      created.push(id);
      if (!reserved) events.push(combinerCombined(a, b));
      // EVERY collection, promotion or not, farm or crypt. "Collect N zombies from the
      // Zombie Pot" needs a signal that fires whenever the Pot hands something over;
      // the promotion-gated event below cannot serve that, and gating on `stored` would
      // punish the player for the one destination a full farm leaves them.
      events.push({
        type: "kCombinerCollectedNotification",
        subject: zombieNames.get(resultKey) ?? resultKey,
        aliases: unitSubjectAliases(zombieNames.get(resultKey) ?? resultKey, mutation, mutantSubjects),
      });
      // The harvest notification (the "Combine for a <silver>" quests) is only
      // earned by a species neither parent was — re-cooking a silver hands slot 1's
      // own species back and must not close the objective. See isCombinePromotion.
      if (isCombinePromotion(resultKey, a.key, b.key)) {
        events.push({
          type: "kCombinerHarvestedNotification",
          subject: zombieNames.get(resultKey) ?? resultKey,
          aliases: unitSubjectAliases(zombieNames.get(resultKey) ?? resultKey, mutation, mutantSubjects),
        });
      }
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
      // XP for the purchase, derived here from the catalog price rather than taken
      // from the client — the optimistic amount the client showed is only a preview.
      state.balance.xp += farmerHeadXp(head);
      state.farmerHeads.push(head.id);
      return { sequence, status: "applied" };
    }
    case "farmer.equip": {
      if (!state.farmerHeads.includes(command.headId)) return reject(sequence, "not_owned");
      state.farmerHeadId = command.headId;
      return { sequence, status: "applied" };
    }
    case "farmer.bonus": {
      // null un-pins: the worn head goes back to supplying the bonus.
      if (command.headId === null) {
        state.farmerBonusHeadId = null;
        return { sequence, status: "applied" };
      }
      if (!state.farmerHeads.includes(command.headId)) return reject(sequence, "not_owned");
      if (!farmerHeadHasEffect(command.headId)) return reject(sequence, "bad_item");
      state.farmerBonusHeadId = command.headId;
      return { sequence, status: "applied" };
    }
    case "pet.buy": {
      const pet = pets.get(command.petKey);
      if (!pet || pet.hidden || !pet.brains || pet.cost <= 0) return reject(sequence, "bad_item");
      if (state.ownedPets.includes(pet.key)) return reject(sequence, "already_owned");
      if (levelForXp(state.balance.xp) < pet.level) return reject(sequence, "locked");
      if (state.balance.brains < pet.cost) return reject(sequence, "insufficient");
      state.balance.brains -= pet.cost;
      state.balance.xp += pet.xp;
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
    case "storage.claim": {
      const have = state.storage.received[command.itemName] ?? 0;
      const zombie = parseReceivedZombie(command.itemName);
      if (zombie) {
        if (have < 1) return reject(sequence, "none_owned");
        const cap = placedCapacity(state);
        if (state.roster.some((unit) => unit.id === zombie.id)) return reject(sequence, "already_owned");
        // The farm first, exactly like addAwardedZombie. This claim used to be
        // Mausoleum-ONLY, so a player whose army had since made room still could not
        // take delivery of a reward they had already earned — a full crypt stranded it
        // indefinitely. Storage is the fallback, not the requirement.
        const stored = activeUnits(state) >= cap.army;
        if (stored) {
          if (cap.storage <= 0) return reject(sequence, "need_mausoleum");
          if (storedUnits(state) >= cap.storage) return reject(sequence, "storage_full");
        }
        state.storage.received[command.itemName] = have - 1;
        state.roster.push({ ...zombie, stored });
        return { sequence, status: "applied", createdIds: [zombie.id] };
      }
      const plan = planClaim(command.itemName, have);
      if (!plan.ok) return reject(sequence, plan.error);
      if (plan.kind === "boost") {
        const count = state.inventory[plan.boostKey] ?? 0;
        if (count >= MAX_STACK) return reject(sequence, "stack_full");
        state.storage.received[command.itemName] = have - 1;
        state.inventory[plan.boostKey] = count + 1;
        return { sequence, status: "applied" };
      }
      if (state.objects.objects.length >= MAX_FUNCTIONAL_OBJECTS) return reject(sequence, "object_limit");
      const requested = command.clientInstanceId;
      const instanceId = requested && CLIENT_INSTANCE_ID.test(requested) &&
        !state.objects.objects.some((object) => object.instanceId === requested) ? requested : options.id();
      state.storage.received[command.itemName] = have - 1;
      const rule = objectRules.get(plan.objectKey);
      state.objects.objects.push({
        instanceId, catalogKey: plan.objectKey, status: "placed",
        ...(rule?.growMs ? { readyAt: options.now + rule.growMs } : {}),
      });
      return { sequence, status: "applied", createdIds: [instanceId] };
    }
    case "storage.move": {
      if (!Number.isInteger(command.quantity) || command.quantity <= 0 || command.quantity > 225) return reject(sequence, "bad_quantity");
      // A Received zombie is not a shed item: moving its marker into the item bucket
      // would strand the unit where nothing can claim it.
      if (parseReceivedZombie(command.itemKey)) return reject(sequence, "bad_item");
      const from = command.direction === "store" ? state.storage.received : state.storage.stored;
      const to = command.direction === "store" ? state.storage.stored : state.storage.received;
      if ((from[command.itemKey] ?? 0) < command.quantity) return reject(sequence, "insufficient_items");
      // The shed's item capacity is authoritative here. The retired v2 route enforced
      // it (planStore, via shedCapacity) and v3 dropped it on the way over, leaving the
      // cap client-side only — so an edited client could stuff a Shabby Shed with any
      // number of items and the server would file every one of them.
      if (command.direction === "store" &&
          storedItemTotal(state) + command.quantity > shedCapacity(state)) {
        return reject(sequence, "shed_full");
      }
      from[command.itemKey] -= command.quantity;
      to[command.itemKey] = (to[command.itemKey] ?? 0) + command.quantity;
      return { sequence, status: "applied" };
    }
    case "quest.periodic_claim": {
      // The set has already been rolled forward to `now` by applyCommandBatch, so a
      // quest id belonging to yesterday is simply absent and lands on `no_such_quest`.
      // That is the expiry rule: an unclaimed daily is worth nothing once its day ends.
      const claim = claimPeriodicQuest(periodicStateOf(state), command.scope, command.questId);
      if (!claim.ok) return reject(sequence, claim.error);
      state.balance.xp += claim.xp;
      return { sequence, status: "applied" };
    }
    case "quest.periodic_author": {
      // The client drew this scope's board itself the instant it qualified (the
      // level-up it saw optimistically, or a rollover) and is asking for the SAME one.
      // Nothing about the board is read off the command: the period comes from the
      // server clock, the level is clamped to the XP the server holds — `level` here
      // already includes what the commands earlier in this batch earned, which is how
      // the batch that crosses level 5 lands its board in its own response — and the
      // generator is the shared deterministic one. A forged command can therefore at
      // most ask for a board sized for a LOWER level than it has earned. A scope that
      // already holds this period's board is left exactly as it is: re-rolling would
      // be a free reset of its counts and claims, which is the per-day cap's backbone.
      const period = periodIndex(command.scope, options.now);
      const authored = Math.min(command.level, level);
      if (authored < unlockLevel(command.scope)) return reject(sequence, "below_unlock");
      const periodic = periodicStateOf(state);
      if (periodic[command.scope]?.period === period) return reject(sequence, "already_authored");
      periodic[command.scope] = generatePeriodicSet({
        accountId: options.accountId, scope: command.scope, period, level: authored,
        xpToNext: xpToNextLevel(authored, XP_THRESHOLDS),
      });
      return { sequence, status: "applied" };
    }
    case "epicBoss.token": {
      // Taken on trust. The client rolled this token when it harvested the crop (see
      // GameplayCommand in protocol.ts); the only things checked are that the event it
      // names is the one actually running and that the batch cannot carry an absurd
      // count. A stale or finished run drops the grant rather than moving it forward.
      const run = state.epicBoss;
      if (!run || run.runId !== command.runId) return reject(sequence, "inactive");
      if (run.completedAt || run.expiresAt <= options.now) return reject(sequence, "inactive");
      const count = command.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > EPIC_BOSS_TOKEN_GRANT_LIMIT) {
        return reject(sequence, "bad_count");
      }
      run.tokenCount = (run.tokenCount ?? 0) + count;
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
    accountId: options.accountId ?? "",
  };
  // Roll the daily/weekly sets over BEFORE anything is applied, so this batch counts
  // against today's quests and a claim naming yesterday's finds nothing to pay.
  const periodicBefore = JSON.stringify(state.periodicQuests ?? null);
  refreshPeriodic(state, required.accountId, required.now);
  const periodic = periodicStateOf(state);
  const failedResources = new Set<string>();
  const resources = (item: SequencedCommand): string[] => {
    const command = item.command;
    if (command.type === "farm.move") {
      return [`plot:${command.oc}:${command.or}`, `plot:${command.toOc}:${command.toOr}`];
    }
    if (command.type.startsWith("farm.") && "oc" in command && "or" in command) return [`plot:${command.oc}:${command.or}`];
    if (command.type === "object.refund" || command.type === "object.status" || command.type === "object.upgrade") return [`object:${command.instanceId}`];
    if (command.type === "object.harvest_trees") return command.instanceIds.map((id) => `object:${id}`);
    if (command.type === "roster.sell" || command.type === "roster.status") return [`unit:${command.unitId}`];
    if (command.type === "roster.combine_start" || command.type === "roster.combine") {
      return [`unit:${command.parentAId}`, `unit:${command.parentBId}`];
    }
    if (command.type === "storage.claim") return [`storage:${command.itemName}`];
    if (command.type === "storage.move") return [`storage:${command.itemKey}`];
    if (command.type === "pet.buy" || command.type === "pet.equip") return [`pet:${command.petKey ?? "active"}`];
    if (command.type === "pet.pen") return ["pet:pen"];
    if (command.type === "quest.periodic_claim") return [`periodic:${command.scope}:${command.questId}`];
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
    const emitted = events.length;
    const result = applyOne(state, item, required, events, createdZombieIds);
    results.push(result);
    if (result.status === "rejected") keys.forEach((key) => failedResources.add(key));
    // Count each command's events against the periodic quests IMMEDIATELY rather than
    // once at the end of the batch. A batch can legitimately hold the harvest that
    // finishes a daily and the claim for it — the client coalesces up to 30s of play
    // into one POST — and deferring would make that claim arrive at a quest the server
    // still saw as incomplete.
    applyPeriodicEvents(periodic, events.slice(emitted));
  }
  const questChanges = applyQuestEvents(state.balance, state.quests, events, {
    inventory: state.inventory,
    storage: state.storage,
  });
  // Roll the sets forward a SECOND time, at the level this batch LEFT the player on
  // (quest rewards included). The pre-loop call ran at the level they arrived with,
  // so the batch that crossed level 5 generated nothing and the board waited for the
  // next batch — one more command and up to thirty seconds away — or a reload. The
  // client now authors its own board the moment it qualifies (quest.periodic_author
  // above); this is the convergence for a second device, a client that could not
  // send the command, or a level crossed by a quest reward alone.
  refreshPeriodic(state, required.accountId, required.now);
  const levelBefore = levelForXp(balanceBefore.xp);
  const levelAfter = levelForXp(state.balance.xp);
  // The original game makes invasions immediately available after a level-up.
  // Keep the reset in the authoritative projection so the D1 commit and client
  // reconciliation cannot disagree about the cooldown.
  if (levelAfter > levelBefore) state.raids.lastRaidAt = 0;
  state.balance.brains += levelUpBrains(levelBefore, levelAfter);
  return {
    state,
    results,
    questChanges,
    createdZombieIds,
    farmChanged: farmBefore !== JSON.stringify(state.farm.plots),
    objectChanged: objectsBefore !== JSON.stringify(state.objects.objects),
    questChanged: questsBefore !== JSON.stringify(state.quests),
    periodicChanged: periodicBefore !== JSON.stringify(state.periodicQuests ?? null),
    balanceBefore,
  };
}

export function freshGameplayState(): MutableGameplayState {
  return {
    balance: { gold: 400, brains: 1, xp: 0 },
    farm: { version: 0, plots: {} },
    objects: { version: 0, objects: [] },
    quests: { version: 0, completed: [], progress: [] } satisfies QuestProjection,
    periodicQuests: { version: 0, daily: null, weekly: null },
    inventory: {},
    storage: { received: {}, stored: {} },
    roster: [] satisfies RosterUnitProjection[],
    fallen: [] satisfies FallenUnitProjection[],
    farmSize: 30,
    climates: ["grass"],
    farmerHeads: [...freeFarmerHeads],
    farmerHeadId: 1,
    farmerBonusHeadId: null,
    ownedPets: [],
    activePet: null,
    penPets: [],
    zombieMax: 16,
    zombiePotBought: false,
    tutorialRewarded: false,
    potSlots: {},
    raids: { progress: {}, lastRaidAt: 0 },
    epicBoss: null,
  };
}
