// The Tim Buckwheat guided-tutorial beat table. Faithful to the original iOS
// binary's TutorialManager/ZFToolManager dialogue (decoded from the executable);
// the controller (TutorialController.ts) drives detection/advancement per step.
//
// Dialogue is the decoded English source, lightly adapted where the reimpl merges
// two binary beats into one (e.g. "Tap on the Soil" + "Select the Zombie").
import type { TutorialSave } from "../save/schema";

/** The key of the base "Zombie" unit — the only plantable the tutorial allows. */
export const TUTORIAL_ZOMBIE_KEY = "ZombieActorRegularTier1";
export const TUTORIAL_GROW_BOOST_KEY = "insta_grow";

/** Ordered tutorial beats. Numeric so it persists compactly in the save. */
export enum TutStep {
  Welcome = 0,
  PlantZombie = 1,
  BuyInstaGrow = 2,
  RipenCrop = 3,
  Harvest = 4,
  Invade = 5,
  Done = 8, // 6/7 were legacy post-raid beats
  Plow = 9,
  OpenGuide = 10,
}

export const TUTORIAL_SEQUENCE: readonly TutStep[] = [
  TutStep.Welcome,
  TutStep.Plow,
  TutStep.PlantZombie,
  TutStep.BuyInstaGrow,
  TutStep.RipenCrop,
  TutStep.Harvest,
  TutStep.Invade,
  TutStep.OpenGuide,
  TutStep.Done,
];

export function nextTutorialStep(step: TutStep): TutStep | null {
  const i = TUTORIAL_SEQUENCE.indexOf(step);
  return i >= 0 && i + 1 < TUTORIAL_SEQUENCE.length ? TUTORIAL_SEQUENCE[i + 1] : null;
}

/** Server truth wins over a stale presentation checkpoint. Tutorial completion and
 * its 200-gold reward share one authoritative command, while the Tim overlay is saved
 * separately as presentation data; an immediate reload can therefore see the old
 * Invade step alongside an already-applied reward. */
export function reconcileTutorialCompletion(
  save: TutorialSave | undefined,
  rewarded: boolean
): TutorialSave | undefined {
  if (!rewarded) return save;
  return { done: true, step: TutStep.Done, target: save?.target };
}

/** During the guided boost purchase, only the required item may spend currency. */
export function tutorialBoostPurchaseAllowed(active: boolean, step: TutStep, key: string): boolean {
  return !active || (step === TutStep.BuyInstaGrow && key === TUTORIAL_GROW_BOOST_KEY);
}

/** Recover an in-progress crop beat from authoritative farm state. In particular,
 * an optimistic Insta-Grow can briefly look ripe before server reconciliation;
 * Harvest must return to RipenCrop instead of trapping the grow tool on a crop the
 * server still considers unripe. */
export function recoverTutorialCropStep(
  step: TutStep,
  hasCrop: boolean,
  canPlant: boolean,
  isRipe: boolean
): TutStep {
  if (step !== TutStep.BuyInstaGrow && step !== TutStep.RipenCrop && step !== TutStep.Harvest)
    return step;
  if (!hasCrop) return canPlant ? TutStep.PlantZombie : TutStep.Plow;
  // The tutorial zombie finishes on its own in ten minutes, so a player who simply
  // waits (or steps away) comes back to a risen crop with both boost beats already
  // moot: RipenCrop has nothing left to speed up, and BuyInstaGrow would still demand
  // a purchase they no longer need — and, on a single starting brain, may no longer
  // be able to make. A crop that grew itself goes straight to Harvest.
  if (isRipe && (step === TutStep.BuyInstaGrow || step === TutStep.RipenCrop))
    return TutStep.Harvest;
  if (step === TutStep.Harvest && !isRipe) return TutStep.RipenCrop;
  return step;
}

/** Whether a beat is unreachable without a target plot. Plot beats gate world input
 * down to their own target, so one with no target accepts NO tap — and, being a plot
 * beat, it highlights no menu either, freezing the whole game behind the overlay.
 * Plow is the exception: it accepts any tillable ground, so it needs no target and is
 * the safe landing spot when none can be found. */
export function tutorialStepNeedsTarget(step: TutStep): boolean {
  return STEPS[step]?.kind === "plot" && step !== TutStep.Plow;
}

/** The Invade beat is the one step the player cannot re-attempt after losing what it
 * needs: it gates every farm tap and every menu but the Invade shortcut, so a player
 * whose only zombie died in the invasion had no way to grow another and the tutorial
 * (persisted) trapped them for good. Send them back to the earliest farm action the
 * surviving state supports. `canPlant` refers to the beat's own target plot. */
export function recoverTutorialInvadeStep(
  step: TutStep,
  hasArmy: boolean,
  canPlant: boolean
): TutStep {
  if (step !== TutStep.Invade || hasArmy) return step;
  return canPlant ? TutStep.PlantZombie : TutStep.Plow;
}

export type StepKind = "narrative" | "plot" | "menu";

export interface StepDef {
  step: TutStep;
  kind: StepKind;
  /** Speech-bubble text (supports \n). */
  say: string;
  /** Small hint line under the bubble (e.g. "Tap to continue"). */
  hint?: string;
  /** For kind:"menu" — the right-menu button label to point the arrow at. */
  menuLabel?: string;
}

export const STEPS: Record<TutStep, StepDef> = {
  [TutStep.Welcome]: {
    step: TutStep.Welcome,
    kind: "narrative",
    say: "Welcome!\nI'm Tim Buckwheat, I'll be teachin' ya some Zombie Farming.",
    hint: "Tap to continue",
  },
  [TutStep.Plow]: {
    step: TutStep.Plow,
    kind: "plot",
    say: "First, let's prepare the soil.\nPlow any open patch of ground.",
  },
  [TutStep.PlantZombie]: {
    step: TutStep.PlantZombie,
    kind: "plot",
    say: "Now let's grow your first zombie!\nTap the glowing soil, then pick the Zombie.",
  },
  [TutStep.BuyInstaGrow]: {
    step: TutStep.BuyInstaGrow,
    kind: "menu",
    menuLabel: "Market",
    say: "Growing zombies takes time.\nLet's speed it up — grab an Insta-Grow from the Market's Boosts tab!",
  },
  [TutStep.RipenCrop]: {
    step: TutStep.RipenCrop,
    kind: "plot",
    say: "Now tap your growing zombie to Insta-Grow it!",
  },
  [TutStep.Harvest]: {
    step: TutStep.Harvest,
    kind: "plot",
    say: "It's risen! Tap the zombie to harvest it.",
  },
  [TutStep.Invade]: {
    step: TutStep.Invade,
    kind: "menu",
    menuLabel: "Invade",
    say: "Now that you've got a zombie, it's time to start a\nZOMBIE INVASION! Tap Invade and send it into Old McDonnell's Farm.",
  },
  [TutStep.OpenGuide]: {
    step: TutStep.OpenGuide,
    kind: "menu",
    menuLabel: "Guide",
    say: "One last thing! Any question ya got — crops, zombies, invasions — my Farmer's Guide has the answer.\nTap Guide and take a peek.",
  },
  [TutStep.Done]: {
    step: TutStep.Done,
    kind: "narrative",
    say: "That's it — you're a real Zombie Farmer now!\nHere's 200 gold to get you started. And remember, the Guide's always there if ya need it. Happy farmin'!",
    hint: "Tap to finish",
  },
};
