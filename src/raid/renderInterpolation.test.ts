import { describe, expect, it } from "vitest";
import {
  extrapolatePosition,
  interpolateFixedStep,
  interpolatePosition,
  isOffstageBossReentryFrame,
  knockBackDrawX,
  playerStagingOffset,
  visualCountdown,
} from "./renderInterpolation";

describe("raid render interpolation", () => {
  it("moves smoothly between 50 ms simulation samples", () => {
    expect(interpolateFixedStep(10, 20, 25, 50)).toBe(15);
  });

  it("clamps interpolation to the current sample", () => {
    expect(interpolateFixedStep(10, 20, 80, 50)).toBe(20);
  });

  it("snaps teleports instead of sliding across the battlefield", () => {
    expect(interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 20 }, 10, 50, 40)).toEqual({ x: 100, y: 20 });
  });

  it("walks a released zombie out of its left staging offset without teleporting", () => {
    expect(playerStagingOffset("waiting", 100, 220, 75)).toBe(75);
    expect(playerStagingOffset("charging", 220, 220, 75)).toBe(75);
    expect(playerStagingOffset("advance", 220, 220, 75)).toBe(75);
    expect(playerStagingOffset("advance", 250, 220, 75)).toBe(45);
    expect(playerStagingOffset("advance", 295, 220, 75)).toBe(0);
    expect(playerStagingOffset("fight", 295, 220, 75)).toBe(0);
  });

  it("keeps the boss's perch-to-ground wrap transition offstage", () => {
    expect(isOffstageBossReentryFrame("emerging", -150, 365, -150)).toBe(true);
    expect(isOffstageBossReentryFrame("emerging", 365, 365, -150)).toBe(false);
    expect(isOffstageBossReentryFrame("descending", -150, -150, -150)).toBe(false);
  });

  it("advances visual countdowns between simulation ticks", () => {
    expect(visualCountdown(800, 20, 50)).toBe(780);
    expect(visualCountdown(10, 20, 50)).toBe(0);
  });

  it("extrapolates projectiles using their retained velocity", () => {
    expect(extrapolatePosition(10, 20, 100, -50, 25, 50)).toEqual({ x: 12.5, y: 18.75 });
  });
});

describe("knockback shove easing", () => {
  // The slide the SIMULATION runs is linear and its timing is ground truth (`force: 5.0`
  // -> knockBackSpeed), replayed by the server. Only the curve the renderer draws it on
  // is ours, and it has to hand over cleanly at both ends or the zombie snaps.
  const FROM = 700;
  const TO = 600; // shoved 100 units back down the lane

  it("starts and lands exactly where the simulation does", () => {
    expect(knockBackDrawX(FROM, FROM, TO)).toBe(FROM);
    expect(knockBackDrawX(TO, FROM, TO)).toBe(TO);
  });

  it("is ahead of the linear slide the whole way, and fastest off the mark", () => {
    // Half way through the simulation's slide the shove is already three quarters home:
    // that is what makes it read as a shove instead of a walk.
    expect(knockBackDrawX(650, FROM, TO)).toBeCloseTo(625, 6);
    // Ahead at every sample, never behind — a drawn position that lagged would look like
    // the zombie resisting the hit.
    for (let t = 0.05; t < 1; t += 0.05) {
      const simX = FROM + (TO - FROM) * t;
      expect(knockBackDrawX(simX, FROM, TO)).toBeLessThan(simX);
    }
  });

  it("does not run past the destination, or back off a zero-length shove", () => {
    // The sim floors the shove at the staging slot, so a zombie already behind it gets
    // a span of zero — there is no curve to draw and nothing to divide by.
    expect(knockBackDrawX(FROM, FROM, FROM)).toBe(FROM);
    // Clamped: a stray sample past either end cannot throw the rig off the lane.
    expect(knockBackDrawX(TO - 50, FROM, TO)).toBe(TO);
    expect(knockBackDrawX(FROM + 50, FROM, TO)).toBe(FROM);
  });
});
