// The template catalog daily / weekly quests are rolled from, plus the count bands
// that size each one to the player's level.
//
// Every template resolves to the same requirement triple the catalog quests use
// (notificationID + notificationObject + countTotal), so progress is driven by the
// existing game events with no new emitters.

import plantRows from "../../../public/assets/plants.json";
import { cropAvailableInMarket } from "../../marketOrder";
import { QuestEvent } from "../events";

interface CropRow {
  key: string;
  name: string;
  level: number;
  growMs: number;
  seasonal?: boolean;
}

const HOUR_MS = 3_600_000;

/** Crops a periodic quest may name. Two exclusions, and they are the same rule twice
 *  over — you cannot buy the seed. Level -4 rows in plants.json are hidden entries
 *  with no shop card at all, and seasonal crops are withheld from every purchase
 *  surface (marketOrder.ts cropAvailableInMarket). A quest naming either is
 *  uncompletable, and because the board ROTATES its pool rather than rolling it, an
 *  ineligible crop is not a rare unlucky day: it comes round on a schedule. */
const CROPS: CropRow[] = (plantRows as CropRow[])
  .filter((crop) => crop.level >= 1 && cropAvailableInMarket(crop))
  .map((crop) => ({ key: crop.key, name: crop.name, level: crop.level, growMs: crop.growMs }));

/** Level bands the counts step through: 5-9, 10-19, 20-29, 30-39, 40+. */
export function levelBand(level: number): number {
  if (level < 10) return 0;
  if (level < 20) return 1;
  if (level < 30) return 2;
  if (level < 40) return 3;
  return 4;
}

const byBand = (band: number, counts: readonly number[]): number =>
  counts[Math.max(0, Math.min(counts.length - 1, band))];

/** Every objective size in one place, expressed as its DAILY target per level band.
 *
 *  Weeklies are not authored separately — each one asks WEEKLY_COUNT_MULTIPLIER times
 *  what its daily counterpart does (see weeklyCount). Two independent tables drifted
 *  apart the moment either was tuned; deriving one from the other makes "a weekly is
 *  five dailies" a property of the code rather than a coincidence of two lists. */
const DAILY_COUNTS = {
  // A NAMED crop is the demanding shape of a farm objective: it pins which seed to buy
  // and which plots to give up, so it is deliberately the smallest count on the board.
  // The wildcard "harvest any" below is what carries the bulk numbers.
  harvestNamed: [15, 20, 25, 30, 35],
  plantNamed: [15, 20, 25, 30, 35],
  // CEILING: 60. Measured against what an hour a day actually produces, the old top
  // bands asked for essentially the whole farm — 165 harvests against the ~176 a level-44
  // player with a full field manages in four sessions, i.e. 94% of the day's total output
  // for ONE of three daily slots, at every band. A slot a normal day cannot clear with
  // room to spare is not an objective, it is a tax, and since the daily board now carries
  // most of the back half's XP it converted straight into slower levelling. The ramp is
  // kept (a level-44 daily should still out-ask a level-6 one) but it now tops out where
  // a short session can still finish it.
  harvestAny: [45, 50, 55, 58, 60],
  // Plowing tracks harvesting one-for-one over time — every spent plot is re-tilled
  // before it is replanted — so this used to run AHEAD of the harvest target, on the
  // reasoning that a plow ask which lagged it was met incidentally and never read as an
  // objective at all.
  //
  // It now shares the harvest ceiling instead. Once harvestAny was capped at 60, a plow
  // target of 140 simply became the binding farm chore and inherited the whole problem
  // the cap was meant to solve — the board still asked for most of the day's field work,
  // just through a different slot. Running level with harvest is the deliberate trade:
  // the two objectives now largely satisfy each other, which is the price of neither of
  // them being able to eat the day.
  plow: [40, 47, 53, 57, 60],
  // A long crop turns over once or twice a day at best, so its "daily" is notional —
  // it exists only to give the weekly long-crop objective something to be five times.
  harvestLong: [6, 9, 12, 15, 18],
  // Capacity-fenced rather than time-fenced: a harvested zombie needs a free army or
  // crypt slot, so a big ask stalls against the 16-slot cap through no fault of the
  // player. Scaled far more gently than the farm chores for that reason.
  harvestZombie: [2, 2, 3, 3, 3],
  // Cooldown-fenced, and capped flat. Two hours between invasions caps a day at ~12
  // wins, so this never scales with level the way a farm chore does.
  invade: [2, 2, 2, 2, 2],
  invadeClean: [1, 1, 1, 1, 1],
} as const;

/** A weekly asks five times what the same objective asks for in a day. */
export const WEEKLY_COUNT_MULTIPLIER = 5;

/** Per-objective overrides of that multiplier.
 *
 *  `harvestAny` needs one because its two ceilings disagree with the 5x rule: the daily
 *  tops out at 60 and a week is not meant to ask beyond 200, but 60 x 5 is 300. Capping
 *  alone would flatten the whole ladder — even the lowest band's 45 x 5 = 225 clears 200,
 *  so every band would land on the ceiling and the weekly would stop scaling with level
 *  entirely. A smaller multiplier keeps the ramp underneath the ceiling instead
 *  (149 → 198 across the bands).
 *
 *  Note what this costs: a weekly still PAYS seven dailies (WEEKLY_MULTIPLIER in
 *  generate.ts) while this one now COSTS 3.3, so the harvest weekly is the most generous
 *  on the board per unit of work. That is deliberate — it is the slot most likely to be
 *  missed by a player who skips a couple of days — but it is the number to revisit first
 *  if weeklies start feeling like free XP.
 *
 *  `plow` has no weekly template of its own (the weekly board's field slot is the harvest
 *  one), so it needs no override — but it shares the DAILY ceiling, since the two chores
 *  track each other one-for-one. */
const WEEKLY_MULTIPLIER_OVERRIDE: Partial<Record<keyof typeof DAILY_COUNTS, number>> = {
  harvestAny: 3.3,
};

/** How many dailies one weekly of `key` COSTS. Exported so the derivation invariant in
 *  generate.test.ts checks the real rule rather than restating a literal 5. */
export const weeklyMultiplierFor = (key: keyof typeof DAILY_COUNTS): number =>
  WEEKLY_MULTIPLIER_OVERRIDE[key] ?? WEEKLY_COUNT_MULTIPLIER;

/** Ceilings the board must respect whatever the bands say. A daily farm chore stays
 *  inside what an hour of play produces; a week may ask for a multiple of that but not an
 *  open-ended one. These bound BOTH field objectives — harvesting and plowing — because
 *  the two track each other one-for-one, so a ceiling on one alone just moves the load.
 *  Asserted directly in generate.test.ts. */
export const DAILY_FIELD_MAX = 60;
export const WEEKLY_FIELD_MAX = 200;

/** Ceilings a weekly may not cross whatever the 5x rule produces.
 *
 *  Only the ordinary invasion win needs one: five times its daily target is ten wins, and
 *  a week is never meant to ask for more than eight. Every other objective is bounded by
 *  the farm rather than by a cooldown, so the multiplier stands.
 *
 *  `invadeClean` is deliberately NOT capped here. A count ceiling is the wrong tool for
 *  it — five flawless wins is a fair week's asking FOR A FARM THAT CAN WIN ONE, and the
 *  real question is whether this farm can. That is a level gate, and both scopes answer
 *  it the same way (see FLAWLESS_MIN_BAND). */
const WEEKLY_MAX: Partial<Record<keyof typeof DAILY_COUNTS, number>> = {
  invade: 8, harvestAny: WEEKLY_FIELD_MAX,
};

/** Below this band, NEITHER scope asks for a flawless invasion.
 *
 *  A flawless win needs an army that can absorb the stage; asking a farm that has not got
 *  one is asking it to lose zombies trying. The daily has always withheld the objective
 *  here — but the weekly did not, so a level-15 farm could be handed "win 5 invasions
 *  without losing a zombie" by the board that had just decided it could not be asked for
 *  one. Both slots fall through to their ordinary-win sibling instead, which is why
 *  neither is ever left empty. */
export const FLAWLESS_MIN_BAND = 2;

const dailyCount = (band: number, key: keyof typeof DAILY_COUNTS): number =>
  byBand(band, DAILY_COUNTS[key]);
export const weeklyCount = (band: number, key: keyof typeof DAILY_COUNTS): number => {
  const scaled = Math.round(
    dailyCount(band, key) * (WEEKLY_MULTIPLIER_OVERRIDE[key] ?? WEEKLY_COUNT_MULTIPLIER)
  );
  const cap = WEEKLY_MAX[key];
  return cap === undefined ? scaled : Math.min(scaled, cap);
};

/** How many level-appropriate crops a roll chooses between. Small on purpose: it keeps
 *  the named crop recent enough to feel current without pinning it to exactly one. */
const CROP_POOL_SIZE = 5;

/** The newest unlocked crops matching a grow-time window, newest first.
 *
 *  DAILIES cap the grow time (see DAILY_MAX_GROW_MS) because a daily naming a 24h crop
 *  is not completable inside its own period unless the player happened to already have
 *  a field of it planted. Weeklies have a whole week, so they take the long crops too. */
export function cropPool(
  level: number,
  window: { maxGrowMs?: number; minGrowMs?: number } = {}
): CropRow[] {
  return CROPS
    .filter((crop) => crop.level <= level)
    .filter((crop) => window.maxGrowMs === undefined || crop.growMs <= window.maxGrowMs)
    .filter((crop) => window.minGrowMs === undefined || crop.growMs >= window.minGrowMs)
    // Newest first, then shortest, then by key so the ordering is total — the roll is
    // seeded, so any ambiguity here would desync two callers on the same seed.
    .sort((a, b) => b.level - a.level || a.growMs - b.growMs || (a.key < b.key ? -1 : 1))
    .slice(0, CROP_POOL_SIZE);
}

/** A daily may only name a crop that can realistically cycle within a day. */
export const DAILY_MAX_GROW_MS = 4 * HOUR_MS;
/** A weekly "long crop" objective draws from the slow, high-value end. */
export const WEEKLY_LONG_MIN_GROW_MS = 8 * HOUR_MS;

const ICON = {
  crops: "Icon_Quest_HarvestVegetables.png",
  zombies: "Icon_Quest_HarvestZombies.png",
  plow: "Icon_Quest_Plowing.png",
  invasion: "Icon_Quest_Invasion.png",
} as const;

export interface TemplateContext {
  level: number;
  band: number;
  /** A per-account, per-period counter used to ROTATE through a pool rather than roll
   *  it. A fair roll over five crops repeats the previous day's crop one day in five,
   *  and over four templates repeats the previous day's chore one day in four — which
   *  reads as the generator being broken rather than as luck. Walking the pool one step
   *  per period guarantees something different every period, while the account term
   *  keeps two players on the same day off the same quests. */
  rotation: number;
}

/** Step `n` places through `items`, wrapping (and tolerating negatives). */
function rotate<T>(items: readonly T[], n: number): T | undefined {
  if (!items.length) return undefined;
  return items[((n % items.length) + items.length) % items.length];
}

/** What a template produces, before the reward is attached. */
export interface BuiltQuest {
  text: string;
  icon: string;
  notificationID: string;
  notificationObject: string;
  countTotal: number;
}

export interface QuestTemplate {
  key: string;
  /** Returns null when the template cannot produce a quest at this level (e.g. no
   *  crop in the window yet); the caller then rolls a different template. */
  build(ctx: TemplateContext): BuiltQuest | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ---------------------------------------------------------------- daily templates

const dailyHarvestNamedCrop: QuestTemplate = {
  key: "daily_harvest_crop",
  build({ level, band, rotation }) {
    const crop = rotate(cropPool(level, { maxGrowMs: DAILY_MAX_GROW_MS }), rotation);
    if (!crop) return null;
    const countTotal = dailyCount(band, "harvestNamed");
    return {
      text: `Harvest ${countTotal} ${crop.name}`,
      icon: ICON.crops,
      notificationID: QuestEvent.CropHarvested,
      notificationObject: crop.name,
      countTotal,
    };
  },
};

const dailyPlantNamedCrop: QuestTemplate = {
  key: "daily_plant_crop",
  build({ level, band, rotation }) {
    // NO grow-time window at all: planting is finished the moment the seed goes in, so
    // unlike a harvest objective this one is not waiting on anything and can name the
    // 24-hour crops. The pool's "newest five unlocked" rule is what keeps that from
    // reaching back for something like Rainbow Crop — level 1 but 500 gold a seed —
    // and handing a level-6 farm a bill it cannot pay.
    const crop = rotate(cropPool(level), rotation + 2);
    if (!crop) return null;
    const countTotal = dailyCount(band, "plantNamed");
    return {
      text: `Plant ${countTotal} ${crop.name}`,
      icon: ICON.plow,
      notificationID: QuestEvent.CropPlanted,
      notificationObject: crop.name,
      countTotal,
    };
  },
};

const dailyHarvestAnyCrop: QuestTemplate = {
  key: "daily_harvest_any",
  build({ band }) {
    const countTotal = dailyCount(band, "harvestAny");
    return {
      // "vegetable" is load-bearing, not flavour: the wildcard listens to
      // kCropHarvestedNotification, and a zombie crop emits the ZOMBIE variant instead
      // (server/test/harvestEventSplit.test.ts). Fruit trees do count, which only ever
      // helps, so the wording errs on the side of promising less than it delivers.
      text: `Harvest ${countTotal} vegetable crops`,
      icon: ICON.crops,
      notificationID: QuestEvent.CropHarvested,
      notificationObject: "",
      countTotal,
    };
  },
};

const dailyPlow: QuestTemplate = {
  key: "daily_plow",
  build({ band }) {
    const countTotal = dailyCount(band, "plow");
    return {
      text: `Plow ${countTotal} ${plural(countTotal, "plot", "plots")}`,
      icon: ICON.plow,
      notificationID: QuestEvent.SoilPlowed,
      notificationObject: "",
      countTotal,
    };
  },
};

const dailyHarvestZombies: QuestTemplate = {
  key: "daily_harvest_zombies",
  build({ band }) {
    // Kept small at every band: a harvested zombie needs a free army or crypt slot, so
    // a large ask can stall against the capacity fence through no fault of the player.
    const countTotal = dailyCount(band, "harvestZombie");
    return {
      text: `Grow and harvest ${countTotal} ${plural(countTotal, "zombie", "zombies")}`,
      icon: ICON.zombies,
      notificationID: QuestEvent.ZombieHarvested,
      notificationObject: "",
      countTotal,
    };
  },
};

const dailyInvade: QuestTemplate = {
  key: "daily_invade",
  build({ band }) {
    // The invasion cooldown is two hours, so even the top band is a fraction of what a
    // day allows. Any raid counts — naming one could point at a stage the player's
    // army cannot yet clear.
    const countTotal = dailyCount(band, "invade");
    return {
      text: `Win ${countTotal} ${plural(countTotal, "invasion", "invasions")}`,
      icon: ICON.invasion,
      notificationID: QuestEvent.InvasionSuccessful,
      notificationObject: "",
      countTotal,
    };
  },
};

const dailyInvadeClean: QuestTemplate = {
  key: "daily_invade_clean",
  build({ band }) {
    // Withheld below FLAWLESS_MIN_BAND, exactly as the weekly is. Returning null here
    // lets the slot fall through to the ordinary win, which is why it is never empty.
    if (band < FLAWLESS_MIN_BAND) return null;
    const countTotal = dailyCount(band, "invadeClean");
    return {
      text: `Win ${countTotal} invasion without losing a zombie`,
      icon: ICON.invasion,
      notificationID: QuestEvent.InvasionPerfectGame,
      notificationObject: "",
      countTotal,
    };
  },
};

// --------------------------------------------------------------- weekly templates

const weeklyHarvestAnyCrop: QuestTemplate = {
  key: "weekly_harvest_any",
  build({ band }) {
    const countTotal = weeklyCount(band, "harvestAny");
    return {
      // "vegetable" is load-bearing, not flavour: the wildcard listens to
      // kCropHarvestedNotification, and a zombie crop emits the ZOMBIE variant instead
      // (server/test/harvestEventSplit.test.ts). Fruit trees do count, which only ever
      // helps, so the wording errs on the side of promising less than it delivers.
      text: `Harvest ${countTotal} vegetable crops`,
      icon: ICON.crops,
      notificationID: QuestEvent.CropHarvested,
      notificationObject: "",
      countTotal,
    };
  },
};

const weeklyHarvestNamedCrop: QuestTemplate = {
  key: "weekly_harvest_crop",
  build({ level, band, rotation }) {
    const crop = rotate(cropPool(level, { maxGrowMs: DAILY_MAX_GROW_MS }), rotation + 1);
    if (!crop) return null;
    const countTotal = weeklyCount(band, "harvestNamed");
    return {
      text: `Harvest ${countTotal} ${crop.name}`,
      icon: ICON.crops,
      notificationID: QuestEvent.CropHarvested,
      notificationObject: crop.name,
      countTotal,
    };
  },
};

const weeklyHarvestLongCrop: QuestTemplate = {
  key: "weekly_harvest_long_crop",
  build({ level, band, rotation }) {
    const crop = rotate(cropPool(level, { minGrowMs: WEEKLY_LONG_MIN_GROW_MS }), rotation + 3);
    if (!crop) return null;
    // Sized against one or two cycles a day rather than the many a short crop allows.
    const countTotal = weeklyCount(band, "harvestLong");
    return {
      text: `Harvest ${countTotal} ${crop.name}`,
      icon: ICON.crops,
      notificationID: QuestEvent.CropHarvested,
      notificationObject: crop.name,
      countTotal,
    };
  },
};

const weeklyHarvestZombies: QuestTemplate = {
  key: "weekly_harvest_zombies",
  build({ band }) {
    const countTotal = weeklyCount(band, "harvestZombie");
    return {
      text: `Grow and harvest ${countTotal} zombies`,
      icon: ICON.zombies,
      notificationID: QuestEvent.ZombieHarvested,
      notificationObject: "",
      countTotal,
    };
  },
};

const weeklyInvade: QuestTemplate = {
  key: "weekly_invade",
  build({ band }) {
    const countTotal = weeklyCount(band, "invade");
    return {
      text: `Win ${countTotal} invasions`,
      icon: ICON.invasion,
      notificationID: QuestEvent.InvasionSuccessful,
      notificationObject: "",
      countTotal,
    };
  },
};

const weeklyPerfectInvade: QuestTemplate = {
  key: "weekly_perfect_invade",
  build({ band }) {
    // Same gate as the daily: a board that will not ask a farm for ONE flawless win must
    // not ask it for five. Falls through to the ordinary weekly win below the band.
    if (band < FLAWLESS_MIN_BAND) return null;
    const countTotal = weeklyCount(band, "invadeClean");
    return {
      text: `Win ${countTotal} ${plural(countTotal, "invasion", "invasions")} without losing a zombie`,
      icon: ICON.invasion,
      notificationID: QuestEvent.InvasionPerfectGame,
      notificationObject: "",
      countTotal,
    };
  },
};

/** Daily slots, in order. Each slot rolls one template from its own pool, so a day is
 *  never all-farm or all-raid: a named crop, a farm chore, then an invasion. */
export const DAILY_SLOTS: readonly (readonly QuestTemplate[])[] = [
  [dailyHarvestNamedCrop],
  [dailyPlantNamedCrop, dailyHarvestAnyCrop, dailyPlow, dailyHarvestZombies],
  // Below level 20 this slot has only one buildable template, so the invasion quest is
  // deliberately the same every day — the dependable half of the board. From 20 it
  // alternates with the flawless-win variant.
  [dailyInvade, dailyInvadeClean],
];

/** Weekly slots: a cumulative growing goal, then a cumulative invasion goal. */
export const WEEKLY_SLOTS: readonly (readonly QuestTemplate[])[] = [
  [weeklyHarvestAnyCrop, weeklyHarvestNamedCrop, weeklyHarvestLongCrop, weeklyHarvestZombies],
  [weeklyInvade, weeklyPerfectInvade],
];
