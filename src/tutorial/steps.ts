// The Tim Buckwheat guided-tutorial beat table. Faithful to the original iOS
// binary's TutorialManager/ZFToolManager dialogue (decoded from the executable);
// the controller (TutorialController.ts) drives detection/advancement per step.
//
// Dialogue is the decoded English source, lightly adapted where the reimpl merges
// two binary beats into one (e.g. "Tap on the Soil" + "Select the Zombie").

/** The key of the base "Zombie" unit — the only plantable the tutorial allows. */
export const TUTORIAL_ZOMBIE_KEY = "ZombieActorRegularTier1";

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
}

export const TUTORIAL_SEQUENCE: readonly TutStep[] = [
  TutStep.Welcome,
  TutStep.Plow,
  TutStep.PlantZombie,
  TutStep.BuyInstaGrow,
  TutStep.RipenCrop,
  TutStep.Harvest,
  TutStep.Invade,
  TutStep.Done,
];

export function nextTutorialStep(step: TutStep): TutStep | null {
  const i = TUTORIAL_SEQUENCE.indexOf(step);
  return i >= 0 && i + 1 < TUTORIAL_SEQUENCE.length ? TUTORIAL_SEQUENCE[i + 1] : null;
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
    say: "First, let's prepare the soil.\nPlow the glowing patch of ground.",
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
  [TutStep.Done]: {
    step: TutStep.Done,
    kind: "narrative",
    say: "That's it — you're a real Zombie Farmer now!\nHere's 200 gold to get you started. Happy farmin'!",
    hint: "Tap to finish",
  },
};
