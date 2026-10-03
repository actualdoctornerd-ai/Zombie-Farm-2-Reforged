// The Tim Buckwheat guided-tutorial beat table. The voice is the original iOS game's
// TutorialManager/ZFToolManager (decoded from the executable); the flow is this
// build's own, so the lines past "Welcome!" are written to match it.
//
// The controller (TutorialController.ts) drives detection/advancement per step.
import type { TutorialSave } from "../save/schema";
import { TUTORIAL_CARROT_PLOT, TUTORIAL_ZOMBIE_PLOT, type TutorialPlot } from "./freshFarm";

/** The key of the base "Zombie" unit — the first thing the tutorial plants. */
export const TUTORIAL_ZOMBIE_KEY = "ZombieActorRegularTier1";
/** The vegetable planted beside it: the zombie takes its mutation. */
export const TUTORIAL_CARROT_KEY = "carrot";
/** The cheap decor the Market beat asks the player to buy (placeables key). */
export const TUTORIAL_FLOWER_KEY = "daisy";

/** Ordered tutorial beats. Numeric so it persists compactly in the save.
 *
 *  The rework renumbered everything from 20 so an in-progress save from the old flow
 *  (ids 0-7, 9, 10) can never be mistaken for a beat of the new one — see
 *  migrateTutorialSave. `Done` keeps its old id on purpose: that save is already at the
 *  farewell and has nothing left to skip. */
export enum TutStep {
  Welcome = 20,
  PlantZombie = 21,
  PlantCarrot = 22,
  Grow = 23,
  Harvest = 24,
  Invade = 25,
  Market = 27,
  PlaceFlower = 28,
  LifeForce = 29,
  /** The side-button tour, in the order the buttons sit. Social only exists online. */
  TourZombies = 30,
  TourBoosts = 31,
  TourStorage = 32,
  TourMarket = 33,
  TourSocial = 34,
  TourGuide = 35,
  /** Added after the first cut, so numbered after the tour. */
  Mutation = 36,
  Plow = 37,
  Veteran = 38,
  /** Only ever PERSISTED now: the farewell is the last tour stop's line. An old save that
   *  stopped here is finished by tapping once. */
  Done = 8,
}

export const TUTORIAL_SEQUENCE: readonly TutStep[] = [
  TutStep.Welcome,
  TutStep.PlantZombie,
  TutStep.PlantCarrot,
  TutStep.Grow,
  TutStep.Harvest,
  TutStep.Mutation,
  TutStep.Plow,
  TutStep.Invade,
  TutStep.Veteran,
  TutStep.Market,
  TutStep.PlaceFlower,
  TutStep.LifeForce,
  TutStep.TourZombies,
  TutStep.TourBoosts,
  TutStep.TourStorage,
  TutStep.TourMarket,
  TutStep.TourSocial,
  TutStep.TourGuide,
];

export function nextTutorialStep(step: TutStep): TutStep | null {
  const i = TUTORIAL_SEQUENCE.indexOf(step);
  return i >= 0 && i + 1 < TUTORIAL_SEQUENCE.length ? TUTORIAL_SEQUENCE[i + 1] : null;
}

/** Server truth wins over a stale presentation checkpoint. Tutorial completion and
 * its 200-gold reward share one authoritative command, while the Tim overlay is saved
 * separately as presentation data; an immediate reload can therefore see an old
 * step alongside an already-applied reward. */
export function reconcileTutorialCompletion(
  save: TutorialSave | undefined,
  rewarded: boolean
): TutorialSave | undefined {
  if (!rewarded) return save;
  return { done: true, step: TutStep.Done, target: save?.target };
}

/** A save from before the rework was partway through a DIFFERENT tutorial: it has one
 *  hand-plowed plot, no carrot, and (offline) no starting plots to continue on. There is
 *  no sensible place to resume it, so it is closed out instead — no bonus, since the
 *  200 gold is the reward for finishing. Only the farewell (`Done`, id kept) is carried
 *  over, and a finished or absent record is left exactly as it was. */
export function migrateTutorialSave(save: TutorialSave | undefined): TutorialSave | undefined {
  if (!save || save.done) return save;
  if (save.step === TutStep.Done || TUTORIAL_SEQUENCE.includes(save.step as TutStep)) return save;
  return { done: true, step: TutStep.Done };
}

/** The plot a beat points the player at, or null for a beat that is not about a plot.
 *  Fixed rather than saved: the farm starts with the same four plots every time. */
export function tutorialPlotFor(step: TutStep): TutorialPlot | null {
  switch (step) {
    case TutStep.PlantZombie:
    case TutStep.Harvest:
    case TutStep.Plow:
      return TUTORIAL_ZOMBIE_PLOT;
    case TutStep.PlantCarrot:
      return TUTORIAL_CARROT_PLOT;
    default:
      return null;
  }
}

/** What the farm shows about the two tutorial plots, for resuming a beat. */
export interface TutorialFarmView {
  zombie: { exists: boolean; canPlant: boolean; hasCrop: boolean; ripe: boolean };
  carrot: { exists: boolean; canPlant: boolean; hasCrop: boolean; ripe: boolean };
}

/** Where a crop-handling beat should actually be, given the live farm. Returns null when
 *  the farm has lost something the tutorial cannot continue without (a plot that is not
 *  there at all), which the controller treats as "end the tutorial quietly" — a frozen,
 *  persisted overlay is the one outcome worse than a skipped lesson.
 *
 *  Only the five crop beats are corrected; every other beat is returned untouched. */
export function recoverTutorialCropStep(step: TutStep, farm: TutorialFarmView): TutStep | null {
  if (step !== TutStep.PlantZombie && step !== TutStep.PlantCarrot && step !== TutStep.Grow &&
      step !== TutStep.Harvest && step !== TutStep.Plow) return step;
  const { zombie, carrot } = farm;
  if (!zombie.exists || !carrot.exists) return null;
  // Spent soil: a plot with no crop that cannot be planted, i.e. the zombie came up and the
  // hole is still there. Every crop beat before the plow beat lands on it; the plow beat
  // is the one that finishes it (the plot is plantable again) and moves on to the fight.
  const spent = !zombie.hasCrop && !zombie.canPlant;
  if (step === TutStep.Plow) return spent ? step : TutStep.Invade;
  if (spent) return TutStep.Plow;
  switch (step) {
    case TutStep.PlantZombie:
      return zombie.hasCrop ? TutStep.PlantCarrot : step;
    case TutStep.PlantCarrot:
      if (!zombie.hasCrop) return TutStep.PlantZombie;
      return carrot.hasCrop ? TutStep.Grow : step;
    case TutStep.Grow:
      if (!zombie.hasCrop) return TutStep.PlantZombie;
      if (!carrot.hasCrop) return TutStep.PlantCarrot;
      return zombie.ripe && carrot.ripe ? TutStep.Harvest : step;
    case TutStep.Harvest:
      if (!zombie.hasCrop) return TutStep.PlantZombie;
      // A ripening an optimistic client showed before the server agreed: back to Grow.
      return zombie.ripe ? step : TutStep.Grow;
  }
  return step;
}

/** The fight is the one beat the player cannot re-attempt after losing what it needs:
 *  it gates every farm tap and every menu but the Invade shortcut, so a player whose only
 *  zombie died there has no way to grow another. There is no earlier beat to rewind to
 *  (the plots are spent), so the tutorial hands the farm back instead. */
export function tutorialInvadeLost(step: TutStep, hasArmy: boolean): boolean {
  return step === TutStep.Invade && !hasArmy;
}

export type StepKind = "narrative" | "plot" | "menu" | "place";

export interface StepDef {
  step: TutStep;
  kind: StepKind;
  /** Speech-bubble text (supports \n). */
  say: string;
  /** Small hint line under the bubble (e.g. "Tap to continue"). */
  hint?: string;
  /** What the arrow points at: a right-menu button label ("Market", "Zombies"), "Invade"
   *  (the bottom-left shortcut), or one of the HUD pieces named in Hud.tutorialTarget.
   *  On a "menu" beat it is also the one control that stays tappable. */
  pointAt?: string;
  /** Which side of its target the arrow sits on. Defaults to wherever there is room. */
  arrowSide?: "below" | "above";
}

export const STEPS: Record<TutStep, StepDef> = {
  [TutStep.Welcome]: {
    step: TutStep.Welcome,
    kind: "narrative",
    say: "Welcome!\nI'm Tim Buckwheat, I'll be teachin' ya some Zombie Farming.",
    hint: "Tap to continue",
  },
  [TutStep.PlantZombie]: {
    step: TutStep.PlantZombie,
    kind: "plot",
    say: "Tap on the freshly plowed soil to pick what to plant.\nYou can plant crops for money, or zombies to build yer army. Start with a Zombie!",
  },
  [TutStep.PlantCarrot]: {
    step: TutStep.PlantCarrot,
    kind: "plot",
    say: "Now plant a Carrot in the plot right next to him.\nHarvest zombies next to food crops for a possible mutation.",
  },
  [TutStep.Grow]: {
    step: TutStep.Grow,
    kind: "narrative",
    say: "Growing zombies takes time.\nLet's speed it up!",
    hint: "Tap to continue",
  },
  [TutStep.Harvest]: {
    step: TutStep.Harvest,
    kind: "plot",
    say: "Yer Zombie is now ready.\nTime to HARVEST it!",
  },
  [TutStep.Mutation]: {
    step: TutStep.Mutation,
    kind: "narrative",
    say: "WOAH! That's one bizarre zombie!\nThanks to that carrot, your zombie got some traits from the plants next to him. Some mutations increase speed, others increase power or defense. Visit the market to unlock more mutations.",
    hint: "Tap to continue",
  },
  [TutStep.Plow]: {
    step: TutStep.Plow,
    kind: "plot",
    say: "Now that yer zombie is out and about, let's cover up that unsightly hole he came from.\nJust tap it. Plowing will prepare the patch of soil for re-planting.",
  },
  [TutStep.Invade]: {
    step: TutStep.Invade,
    kind: "menu",
    pointAt: "Invade",
    say: "Now that you've got a zombie, it's time to start a\nZOMBIE INVASION!\nTap on \"Invade\" when yer ready to raid Old McDonnell's barn.",
  },
  [TutStep.Veteran]: {
    step: TutStep.Veteran,
    kind: "narrative",
    say: "Zombies get stronger with each invasion.\nAll zombies have been promoted to \"Veteran\".",
    hint: "Tap to continue",
  },
  [TutStep.Market]: {
    step: TutStep.Market,
    kind: "menu",
    pointAt: "Market",
    say: "Looks like someone forgot to decorate this farm.\nOpen the Market and grab a Daisy. It's cheap!",
  },
  [TutStep.PlaceFlower]: {
    step: TutStep.PlaceFlower,
    kind: "place",
    say: "Tap on any open ground to place it.",
  },
  [TutStep.LifeForce]: {
    step: TutStep.LifeForce,
    kind: "narrative",
    pointAt: "LifeForce",
    arrowSide: "below",
    say: "That's yer Life Force! All decorative items give it, but trees give the most.\nLife Force is important for preventing lifeless zombies and good for zombie mutations.",
    hint: "Tap to continue",
  },
  [TutStep.TourZombies]: {
    step: TutStep.TourZombies,
    kind: "narrative",
    pointAt: "Zombies",
    say: "Tap Zombies to see yer army.\nThe Zombie Almanac in there keeps record of every zombie and mutation ya find.",
    hint: "Tap to continue",
  },
  [TutStep.TourBoosts]: {
    step: TutStep.TourBoosts,
    kind: "narrative",
    pointAt: "Boosts",
    say: "Boosts are for when ya need yer zombies and crops right now.",
    hint: "Tap to continue",
  },
  [TutStep.TourStorage]: {
    step: TutStep.TourStorage,
    kind: "narrative",
    pointAt: "Storage",
    say: "Keep it nice n' tidy with Storage!\nIt holds yer rewards and anything ya take off the farm.",
    hint: "Tap to continue",
  },
  [TutStep.TourMarket]: {
    step: TutStep.TourMarket,
    kind: "narrative",
    pointAt: "Market",
    say: "The Market is where ya select stuff to plant, and buy decor and more.",
    hint: "Tap to continue",
  },
  [TutStep.TourSocial]: {
    step: TutStep.TourSocial,
    kind: "narrative",
    pointAt: "Social",
    say: "Welcome to the Social Menu! You can play with yer friends from here.",
    hint: "Tap to continue",
  },
  [TutStep.TourGuide]: {
    step: TutStep.TourGuide,
    kind: "narrative",
    pointAt: "Guide",
    say: "Got a question? The Guide has the answer.\nYee-Haw, you're a real Zombie Farmer now! Here's 200 gold to get ya started.",
    hint: "Tap to finish",
  },
  [TutStep.Done]: {
    step: TutStep.Done,
    kind: "narrative",
    say: "Yee-Haw, you're a real Zombie Farmer now!\nHere's 200 gold to get ya started. The Guide's always in the menu if ya need it.",
    hint: "Tap to finish",
  },
};

/** Tim's word before the tutorial fight, shown on the pre-battle notice (the same one the
 *  hazard tip uses). Where things are, not how the fight works — that's the fight's job. */
export const TUTORIAL_BATTLE_TIP =
  "He's ready for battle when a thought bubble pops up over him. Tap it to send him off!\n" +
  "Any special moves yer zombies have show up as buttons down the left side. Tap one when ya need it.";

/** Tim's consolation when the tutorial fight is lost and there is no zombie left to retry. */
export const TUTORIAL_LOST_TIP =
  "Old McDonnell beat yer zombie somethin' fierce!\nPlant another zombie and give him another go.";
