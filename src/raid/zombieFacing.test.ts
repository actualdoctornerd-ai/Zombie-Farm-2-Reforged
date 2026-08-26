import { describe, expect, it } from "vitest";
import { zombieFacingDelta } from "./zombieFacing";

const zombie = (over: Partial<Parameters<typeof zombieFacingDelta>[0]> = {}) => ({
  state: "fight", vx: 0, windupKey: null, alive: true, ...over,
});
const NORMAL = { exitMarch: false, retreating: false };

// `setFacingFromDelta` reads the SIGN: positive means moving toward the enemy line, which
// is the direction the whole player side fights in.
const facesEnemy = (d: number | null) => d !== null && d > 0;
const facesHome = (d: number | null) => d !== null && d < 0;

describe("player zombie facing", () => {
  it("squares up to the enemy after being re-formed into a rear slot", () => {
    // The reported bug: displaced to a farther-back slot, it walks LEFT to get there…
    expect(facesHome(zombieFacingDelta(zombie({ state: "advance", vx: -80 }), NORMAL))).toBe(true);
    // …and used to keep that facing once it stopped, because `vx` is then zero. Both the
    // arrival and the attacking that follows now point back at the enemy.
    expect(facesEnemy(zombieFacingDelta(zombie({ state: "advance", vx: 0 }), NORMAL))).toBe(true);
    expect(facesEnemy(zombieFacingDelta(zombie({ state: "fight", vx: 0 }), NORMAL))).toBe(true);
  });

  it("keeps fighting forward even while still closing on its slot", () => {
    // `state` flips to "fight" on the tick a foe engages, which can be a tick where the
    // zombie is still sliding the last few pixels backward into formation.
    expect(facesEnemy(zombieFacingDelta(zombie({ state: "fight", vx: -80 }), NORMAL))).toBe(true);
    expect(facesEnemy(zombieFacingDelta(
      zombie({ state: "advance", vx: -80, windupKey: "explode" }), NORMAL
    ))).toBe(true);
  });

  it("still lets the crowd behind the charge slot pace back and forth", () => {
    expect(facesHome(zombieFacingDelta(zombie({ state: "waiting", vx: -40 }), NORMAL))).toBe(true);
    expect(facesEnemy(zombieFacingDelta(zombie({ state: "waiting", vx: 40 }), NORMAL))).toBe(true);
    // Standing still off the field: leave it alone rather than snapping it forward.
    expect(zombieFacingDelta(zombie({ state: "waiting", vx: 0 }), NORMAL)).toBeNull();
    expect(zombieFacingDelta(zombie({ state: "charging", vx: 2 }), NORMAL)).toBeNull();
  });

  it("hands the end-of-fight march the last word", () => {
    const marching = zombie({ state: "fight", vx: 0 });
    expect(facesHome(zombieFacingDelta(marching, { exitMarch: true, retreating: true }))).toBe(true);
    expect(facesEnemy(zombieFacingDelta(marching, { exitMarch: true, retreating: false }))).toBe(true);
  });

  it("a shoved zombie keeps facing the enemy that shoved it", () => {
    // A knockback slides the zombie backwards fast, so `vx` is large and NEGATIVE. Read
    // as travel, that turned it round to face the way it was flying, and a zombie
    // striding away from the fight reads as retreating rather than as one that just got
    // hit. Travel is not intent while something else is doing the travelling.
    const shoved = zombie({ state: "advance", vx: -320, knockBackSpeed: 327 });
    expect(facesEnemy(zombieFacingDelta(shoved, NORMAL))).toBe(true);
    // Same velocity with no shove behind it is an ordinary walk, and still faces the walk.
    expect(facesHome(zombieFacingDelta(zombie({ state: "advance", vx: -320 }), NORMAL))).toBe(true);
    // The end-of-fight march still outranks it: a retreat walks home, shoved or not.
    expect(facesHome(zombieFacingDelta(shoved, { exitMarch: true, retreating: true }))).toBe(true);
  });

  it("leaves the dead where they fell", () => {
    expect(zombieFacingDelta(zombie({ state: "dead", alive: false, vx: -90 }), NORMAL)).toBeNull();
  });
});
