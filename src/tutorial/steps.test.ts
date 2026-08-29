import { describe, expect, it } from "vitest";
import {
  nextTutorialStep, recoverTutorialCropStep, recoverTutorialInvadeStep, TUTORIAL_SEQUENCE,
  TutStep, reconcileTutorialCompletion, tutorialBoostPurchaseAllowed, tutorialStepNeedsTarget,
} from "./steps";

describe("tutorial sequence", () => {
  it("requires real plowing before planting and visits the guide after the raid", () => {
    expect(TUTORIAL_SEQUENCE).toEqual([
      TutStep.Welcome,
      TutStep.Plow,
      TutStep.PlantZombie,
      TutStep.BuyInstaGrow,
      TutStep.RipenCrop,
      TutStep.Harvest,
      TutStep.Invade,
      TutStep.OpenGuide,
      TutStep.Done,
    ]);
  });

  it("advances through the explicit non-contiguous persisted step ids", () => {
    expect(nextTutorialStep(TutStep.Welcome)).toBe(TutStep.Plow);
    expect(nextTutorialStep(TutStep.Plow)).toBe(TutStep.PlantZombie);
    expect(nextTutorialStep(TutStep.Invade)).toBe(TutStep.OpenGuide);
    expect(nextTutorialStep(TutStep.OpenGuide)).toBe(TutStep.Done);
    expect(nextTutorialStep(TutStep.Done)).toBeNull();
  });

  it("allows only Insta-Grow to be purchased during the guided boost beat", () => {
    expect(tutorialBoostPurchaseAllowed(true, TutStep.BuyInstaGrow, "insta_grow")).toBe(true);
    expect(tutorialBoostPurchaseAllowed(true, TutStep.BuyInstaGrow, "insta_harvest")).toBe(false);
    expect(tutorialBoostPurchaseAllowed(true, TutStep.Plow, "insta_grow")).toBe(false);
    expect(tutorialBoostPurchaseAllowed(false, TutStep.Done, "insta_harvest")).toBe(true);
  });

  it("returns a reconciled unripe Harvest crop to the Insta-Grow step", () => {
    expect(recoverTutorialCropStep(TutStep.Harvest, true, false, false)).toBe(TutStep.RipenCrop);
    expect(recoverTutorialCropStep(TutStep.Harvest, true, false, true)).toBe(TutStep.Harvest);
  });

  // The tutorial zombie ripens on its own in ten minutes. A player who waits it out
  // used to be held at the boost beats anyway — asked to buy an Insta-Grow they no
  // longer needed, out of the single brain a new farm starts with.
  it("sends a crop that grew on its own straight to Harvest", () => {
    expect(recoverTutorialCropStep(TutStep.BuyInstaGrow, true, false, true)).toBe(TutStep.Harvest);
    expect(recoverTutorialCropStep(TutStep.RipenCrop, true, false, true)).toBe(TutStep.Harvest);
    // Still growing: both beats stand.
    expect(recoverTutorialCropStep(TutStep.BuyInstaGrow, true, false, false)).toBe(TutStep.BuyInstaGrow);
    expect(recoverTutorialCropStep(TutStep.RipenCrop, true, false, false)).toBe(TutStep.RipenCrop);
  });

  it("rewinds missing tutorial crops to the earliest valid recovery action", () => {
    expect(recoverTutorialCropStep(TutStep.RipenCrop, false, true, false)).toBe(TutStep.PlantZombie);
    expect(recoverTutorialCropStep(TutStep.Harvest, false, false, false)).toBe(TutStep.Plow);
  });

  // A plot beat only accepts taps on its own target plot and highlights no menu, so
  // one that has lost its target accepts nothing at all — the game freezes behind the
  // overlay, and the beat is persisted, so a reload does not clear it.
  it("knows which beats are unreachable without a target plot", () => {
    expect(tutorialStepNeedsTarget(TutStep.PlantZombie)).toBe(true);
    expect(tutorialStepNeedsTarget(TutStep.RipenCrop)).toBe(true);
    expect(tutorialStepNeedsTarget(TutStep.Harvest)).toBe(true);
    // Plow accepts any tillable ground, so it is the safe landing spot.
    expect(tutorialStepNeedsTarget(TutStep.Plow)).toBe(false);
    // Narrative and menu beats point at their own controls.
    expect(tutorialStepNeedsTarget(TutStep.Welcome)).toBe(false);
    expect(tutorialStepNeedsTarget(TutStep.BuyInstaGrow)).toBe(false);
    expect(tutorialStepNeedsTarget(TutStep.Invade)).toBe(false);
    expect(tutorialStepNeedsTarget(TutStep.OpenGuide)).toBe(false);
    expect(tutorialStepNeedsTarget(TutStep.Done)).toBe(false);
    // A step id this build does not know must not claim to need a target.
    expect(tutorialStepNeedsTarget(6 as TutStep)).toBe(false);
  });

  // Losing the tutorial invasion kills the player's only zombie. Every farm tap and
  // every menu but Invade is gated on that beat, so without this rewind there was no
  // way to grow a replacement — a permanent, save-persisted freeze.
  it("rewinds the invasion beat when the army is gone", () => {
    expect(recoverTutorialInvadeStep(TutStep.Invade, false, true)).toBe(TutStep.PlantZombie);
    expect(recoverTutorialInvadeStep(TutStep.Invade, false, false)).toBe(TutStep.Plow);
  });

  it("leaves the invasion beat alone while the player still has an army", () => {
    expect(recoverTutorialInvadeStep(TutStep.Invade, true, true)).toBe(TutStep.Invade);
    // An empty army on any other beat is normal — that beat is how you get one.
    expect(recoverTutorialInvadeStep(TutStep.Harvest, false, true)).toBe(TutStep.Harvest);
    expect(recoverTutorialInvadeStep(TutStep.Plow, false, false)).toBe(TutStep.Plow);
  });

  it("lets the authoritative completion reward override a stale Invade checkpoint", () => {
    const stale = { done: false, step: TutStep.Invade, target: { col: 4, row: 8 } };
    expect(reconcileTutorialCompletion(stale, true)).toEqual({
      done: true,
      step: TutStep.Done,
      target: { col: 4, row: 8 },
    });
    expect(reconcileTutorialCompletion(stale, false)).toBe(stale);
    expect(reconcileTutorialCompletion(undefined, true)).toEqual({
      done: true,
      step: TutStep.Done,
      target: undefined,
    });
  });
});
