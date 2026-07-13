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
  Welcome,      // slide-up intro
  PlantZombie,  // arrow -> pre-plowed plot; locked plant menu -> plant the Zombie
  BuyInstaGrow, // arrow -> Market; buy an Insta-Grow from the Boosts tab
  RipenCrop,    // auto-equip Insta-Grow; tap the growing zombie to ripen it
  Harvest,      // tap the ripe zombie to harvest it
  Invade,       // arrow -> Invade; win Old McDonnell's Farm
  Veteran,      // "promoted to Veteran" popup (veteran sprite)
  ZombiePot,    // choice: buy a Zombie Pot combiner?
  Done,         // completion + 200 gold
}

export type StepKind = "narrative" | "plot" | "menu" | "choice";

export interface StepDef {
  step: TutStep;
  kind: StepKind;
  /** Speech-bubble text (supports \n). */
  say: string;
  /** Small hint line under the bubble (e.g. "Tap to continue"). */
  hint?: string;
  /** Which sprite rises: Tim (farmer) by default, or the veteran sprite. */
  art?: "farmer" | "veteran";
  /** For kind:"menu" — the right-menu button label to point the arrow at. */
  menuLabel?: string;
  /** For kind:"choice" — the two button labels (yes first). */
  choices?: [string, string];
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
    say: "Let's grow your first zombie!\nTap the glowing soil, then pick the Zombie.",
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
  [TutStep.Veteran]: {
    step: TutStep.Veteran,
    kind: "narrative",
    art: "veteran",
    say: "Zombies get stronger with each invasion.\nAll your zombies have been promoted to \"Veteran\"!",
    hint: "Tap to continue",
  },
  [TutStep.ZombiePot]: {
    step: TutStep.ZombiePot,
    kind: "choice",
    choices: ["Yes!", "Not now"],
    say: "Use a Zombie Pot to combine zombies into stronger ones.\nWould you like to buy one now?",
  },
  [TutStep.Done]: {
    step: TutStep.Done,
    kind: "narrative",
    say: "That's it — you're a real Zombie Farmer now!\nHere's 200 gold to get you started. Happy farmin'!",
    hint: "Tap to finish",
  },
};
