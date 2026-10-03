import { describe, expect, it } from "vitest";
import {
  migrateTutorialSave, nextTutorialStep, recoverTutorialCropStep, reconcileTutorialCompletion,
  STEPS, TUTORIAL_SEQUENCE, TutStep, tutorialInvadeLost, tutorialPlotFor, type TutorialFarmView,
} from "./steps";
import {
  isUntouchedFreshFarm, TUTORIAL_CARROT_PLOT, TUTORIAL_PLOTS, TUTORIAL_ZOMBIE_PLOT,
} from "./freshFarm";

const plot = (over: Partial<TutorialFarmView["zombie"]> = {}) =>
  ({ exists: true, canPlant: true, hasCrop: false, ripe: false, ...over });
const farm = (
  zombie: Partial<TutorialFarmView["zombie"]> = {},
  carrot: Partial<TutorialFarmView["carrot"]> = {}
): TutorialFarmView => ({ zombie: plot(zombie), carrot: plot(carrot) });
const growing = { canPlant: false, hasCrop: true };

describe("tutorial sequence", () => {
  it("plants a zombie and a carrot, grows them, fights, shops, learns Life Force, then tours the side buttons", () => {
    expect(TUTORIAL_SEQUENCE).toEqual([
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
    ]);
  });

  it("has a line for every beat, and still for the persisted-only farewell", () => {
    for (const step of [...TUTORIAL_SEQUENCE, TutStep.Done]) expect(STEPS[step].say.length).toBeGreaterThan(0);
  });

  it("tours the buttons top to bottom, pointing at each", () => {
    const tour = TUTORIAL_SEQUENCE.slice(TUTORIAL_SEQUENCE.indexOf(TutStep.TourZombies));
    expect(tour.map((step) => STEPS[step].pointAt))
      .toEqual(["Zombies", "Boosts", "Storage", "Market", "Social", "Guide"]);
    expect(STEPS[TutStep.TourZombies].say).toContain("Almanac");
  });

  it("advances through the explicit non-contiguous persisted step ids", () => {
    expect(nextTutorialStep(TutStep.Welcome)).toBe(TutStep.PlantZombie);
    expect(nextTutorialStep(TutStep.PlantCarrot)).toBe(TutStep.Grow);
    expect(nextTutorialStep(TutStep.Harvest)).toBe(TutStep.Mutation);
    expect(nextTutorialStep(TutStep.Mutation)).toBe(TutStep.Plow);
    expect(nextTutorialStep(TutStep.Plow)).toBe(TutStep.Invade);
    expect(nextTutorialStep(TutStep.Invade)).toBe(TutStep.Veteran);
    expect(nextTutorialStep(TutStep.LifeForce)).toBe(TutStep.TourZombies);
    // The last stop ends the tutorial: there is no separate farewell beat after it.
    expect(nextTutorialStep(TutStep.TourGuide)).toBeNull();
    expect(nextTutorialStep(TutStep.Done)).toBeNull();
  });

  it("keeps the old ids out of the new flow", () => {
    // A save from the previous tutorial used 0-7, 9 and 10; none may collide with a new beat.
    for (const step of TUTORIAL_SEQUENCE) {
      if (step === TutStep.Done) continue;
      expect([0, 1, 2, 3, 4, 5, 6, 7, 9, 10]).not.toContain(step);
    }
  });
});

describe("migrating a save from the previous tutorial", () => {
  it("closes out an in-progress save of the old flow, with no bonus owed", () => {
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]) {
      const closed = migrateTutorialSave({ done: false, step, target: { col: 4, row: 8 } });
      expect(closed).toEqual({ done: true, step: TutStep.Done });
    }
  });

  it("leaves a finished, absent, or current save alone", () => {
    const finished = { done: true, step: TutStep.Done };
    expect(migrateTutorialSave(finished)).toBe(finished);
    expect(migrateTutorialSave(undefined)).toBeUndefined();
    const midway = { done: false, step: TutStep.Grow };
    expect(migrateTutorialSave(midway)).toBe(midway);
  });

  it("keeps a save that was already at the farewell", () => {
    const farewell = { done: false, step: TutStep.Done };
    expect(migrateTutorialSave(farewell)).toBe(farewell);
  });
});

describe("tutorial plots", () => {
  it("are four distinct plots in a 2x2 block at the centre of a 30x30 farm", () => {
    expect(TUTORIAL_PLOTS).toHaveLength(4);
    expect(new Set(TUTORIAL_PLOTS.map((p) => `${p.oc}:${p.or}`)).size).toBe(4);
    const cols = TUTORIAL_PLOTS.map((p) => p.oc);
    const rows = TUTORIAL_PLOTS.map((p) => p.or);
    expect(Math.min(...cols) + Math.max(...cols) + 4).toBe(30); // centred: equal margin each side
    expect(Math.min(...rows) + Math.max(...rows) + 4).toBe(30);
  });

  it("put the carrot where it touches the zombie", () => {
    expect(Math.abs(TUTORIAL_CARROT_PLOT.oc - TUTORIAL_ZOMBIE_PLOT.oc)).toBeLessThanOrEqual(4);
    expect(Math.abs(TUTORIAL_CARROT_PLOT.or - TUTORIAL_ZOMBIE_PLOT.or)).toBeLessThanOrEqual(4);
    expect(TUTORIAL_CARROT_PLOT).not.toEqual(TUTORIAL_ZOMBIE_PLOT);
  });

  it("name the plot each crop beat points at", () => {
    expect(tutorialPlotFor(TutStep.PlantZombie)).toEqual(TUTORIAL_ZOMBIE_PLOT);
    expect(tutorialPlotFor(TutStep.PlantCarrot)).toEqual(TUTORIAL_CARROT_PLOT);
    expect(tutorialPlotFor(TutStep.Harvest)).toEqual(TUTORIAL_ZOMBIE_PLOT);
    expect(tutorialPlotFor(TutStep.Plow)).toEqual(TUTORIAL_ZOMBIE_PLOT);
    expect(tutorialPlotFor(TutStep.Invade)).toBeNull();
    expect(tutorialPlotFor(TutStep.Mutation)).toBeNull();
    expect(tutorialPlotFor(TutStep.Market)).toBeNull();
  });
});

describe("a farm nobody has played", () => {
  const seeded = Object.fromEntries(TUTORIAL_PLOTS.map((p) => [`${p.oc}:${p.or}`, { state: "plowed" }]));

  it("is the four bare starting plots and nothing else", () => {
    expect(isUntouchedFreshFarm(seeded, 0, 0)).toBe(true);
    expect(isUntouchedFreshFarm({}, 0, 0)).toBe(true);
  });

  it("stops being untouched once anything is planted, placed, or grown", () => {
    const [first] = TUTORIAL_PLOTS;
    expect(isUntouchedFreshFarm({ ...seeded, [`${first.oc}:${first.or}`]: { state: "planted" } }, 0, 0)).toBe(false);
    expect(isUntouchedFreshFarm({ ...seeded, "1:1": { state: "plowed" } }, 0, 0)).toBe(false);
    expect(isUntouchedFreshFarm(seeded, 1, 0)).toBe(false);
    expect(isUntouchedFreshFarm(seeded, 0, 1)).toBe(false);
  });
});

describe("resuming a crop beat from the live farm", () => {
  it("leaves every other beat alone", () => {
    expect(recoverTutorialCropStep(TutStep.Invade, farm())).toBe(TutStep.Invade);
    expect(recoverTutorialCropStep(TutStep.Market, farm())).toBe(TutStep.Market);
    expect(recoverTutorialCropStep(TutStep.Welcome, farm())).toBe(TutStep.Welcome);
  });

  it("gives up when a tutorial plot is gone, rather than freeze the game", () => {
    expect(recoverTutorialCropStep(TutStep.PlantZombie, farm({ exists: false }))).toBeNull();
    expect(recoverTutorialCropStep(TutStep.Grow, farm({}, { exists: false }))).toBeNull();
  });

  it("skips ahead past work that is already done", () => {
    expect(recoverTutorialCropStep(TutStep.PlantZombie, farm(growing))).toBe(TutStep.PlantCarrot);
    expect(recoverTutorialCropStep(TutStep.PlantCarrot, farm(growing, growing))).toBe(TutStep.Grow);
    // The crops grew on their own (the player waited): nothing left to speed up.
    expect(recoverTutorialCropStep(TutStep.Grow, farm({ ...growing, ripe: true }, { ...growing, ripe: true })))
      .toBe(TutStep.Harvest);
  });

  it("keeps a beat whose work is still to do", () => {
    expect(recoverTutorialCropStep(TutStep.PlantZombie, farm())).toBe(TutStep.PlantZombie);
    expect(recoverTutorialCropStep(TutStep.PlantCarrot, farm(growing))).toBe(TutStep.PlantCarrot);
    expect(recoverTutorialCropStep(TutStep.Grow, farm(growing, growing))).toBe(TutStep.Grow);
    expect(recoverTutorialCropStep(TutStep.Harvest, farm({ ...growing, ripe: true }, growing)))
      .toBe(TutStep.Harvest);
  });

  it("rewinds to the earliest beat the surviving state supports", () => {
    // The server refused the zombie: its plot is bare again.
    expect(recoverTutorialCropStep(TutStep.PlantCarrot, farm())).toBe(TutStep.PlantZombie);
    expect(recoverTutorialCropStep(TutStep.Grow, farm(growing))).toBe(TutStep.PlantCarrot);
    expect(recoverTutorialCropStep(TutStep.Harvest, farm())).toBe(TutStep.PlantZombie);
    // A ripening the client showed before the server agreed: Harvest goes back to Grow.
    expect(recoverTutorialCropStep(TutStep.Harvest, farm(growing, growing))).toBe(TutStep.Grow);
  });

  it("moves on to the plow beat once the zombie has been harvested", () => {
    // Spent soil: no crop, and not plantable.
    const spent = { canPlant: false, hasCrop: false };
    expect(recoverTutorialCropStep(TutStep.Harvest, farm(spent, growing))).toBe(TutStep.Plow);
    expect(recoverTutorialCropStep(TutStep.Grow, farm(spent, growing))).toBe(TutStep.Plow);
  });

  it("holds the plow beat until the hole is plowed, then moves on to the fight", () => {
    const spent = { canPlant: false, hasCrop: false };
    expect(recoverTutorialCropStep(TutStep.Plow, farm(spent, growing))).toBe(TutStep.Plow);
    // Plowed again: bare and plantable.
    expect(recoverTutorialCropStep(TutStep.Plow, farm({}, growing))).toBe(TutStep.Invade);
    expect(recoverTutorialCropStep(TutStep.Plow, farm({ exists: false }))).toBeNull();
  });
});

describe("the tutorial fight", () => {
  // Losing the tutorial invasion kills the player's only zombie. Every farm tap and every
  // menu but Invade is gated on that beat, so without a way out there was nothing left to do.
  it("is lost when the army is gone", () => {
    expect(tutorialInvadeLost(TutStep.Invade, false)).toBe(true);
  });

  it("is left alone while the player still has an army", () => {
    expect(tutorialInvadeLost(TutStep.Invade, true)).toBe(false);
    // An empty army on any other beat is normal — those beats are how you get one.
    expect(tutorialInvadeLost(TutStep.Harvest, false)).toBe(false);
    expect(tutorialInvadeLost(TutStep.PlantZombie, false)).toBe(false);
  });
});

describe("tutorial completion", () => {
  it("lets the authoritative completion reward override a stale checkpoint", () => {
    const stale = { done: false, step: TutStep.Invade };
    expect(reconcileTutorialCompletion(stale, true)).toEqual({
      done: true,
      step: TutStep.Done,
      target: undefined,
    });
    expect(reconcileTutorialCompletion(stale, false)).toBe(stale);
    expect(reconcileTutorialCompletion(undefined, true)).toEqual({
      done: true,
      step: TutStep.Done,
      target: undefined,
    });
  });
});
