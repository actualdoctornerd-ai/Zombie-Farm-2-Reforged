import { describe, expect, it } from "vitest";
import { nextTutorialStep, TUTORIAL_SEQUENCE, TutStep } from "./steps";

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
});
