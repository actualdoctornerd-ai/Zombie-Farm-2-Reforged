import { describe, expect, it } from "vitest";
import {
  nextTutorialStep, recoverTutorialCropStep, TUTORIAL_SEQUENCE, TutStep,
  tutorialBoostPurchaseAllowed,
} from "./steps";

describe("tutorial sequence", () => {
  it("requires real plowing before planting and ends after the raid", () => {
    expect(TUTORIAL_SEQUENCE).toEqual([
      TutStep.Welcome,
      TutStep.Plow,
      TutStep.PlantZombie,
      TutStep.BuyInstaGrow,
      TutStep.RipenCrop,
      TutStep.Harvest,
      TutStep.Invade,
      TutStep.Done,
    ]);
  });

  it("advances through the explicit non-contiguous persisted step ids", () => {
    expect(nextTutorialStep(TutStep.Welcome)).toBe(TutStep.Plow);
    expect(nextTutorialStep(TutStep.Plow)).toBe(TutStep.PlantZombie);
    expect(nextTutorialStep(TutStep.Invade)).toBe(TutStep.Done);
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

  it("rewinds missing tutorial crops to the earliest valid recovery action", () => {
    expect(recoverTutorialCropStep(TutStep.RipenCrop, false, true, false)).toBe(TutStep.PlantZombie);
    expect(recoverTutorialCropStep(TutStep.Harvest, false, false, false)).toBe(TutStep.Plow);
  });
});
