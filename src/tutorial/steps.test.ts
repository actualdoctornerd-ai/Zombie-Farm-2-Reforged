import { describe, expect, it } from "vitest";
import { nextTutorialStep, TUTORIAL_SEQUENCE, TutStep, tutorialBoostPurchaseAllowed } from "./steps";

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
});
