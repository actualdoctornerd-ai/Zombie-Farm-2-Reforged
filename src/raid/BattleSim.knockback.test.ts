// An enemy that is being hit has someone to hit.
//
// Ranges in this sim are deliberately asymmetric: a zombie attacks from anywhere in the
// combat zone (a band four rows deep), while an enemy only strikes what stands within
// `engageDistance`. That is what makes holding the front row matter. But the melee band
// can empty while the enemy is still under fire — a knockback shoves its victim 150
// units down the lane (v36's case), and a reserved front slot leaves the walking-up line
// a band-depth back (v40's) — and an enemy with a null target just stood there being
// killed. The reach-of-last-resort answers both: with nobody in melee range, an enemy
// strikes the front-most zombie in attack position. These tests pin that floor, and pin
// that it never overrides normal front-row targeting while a front row stands.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import { advanceRaidArmy } from "./raidOutro";
import { knockBackDrawX } from "./renderInterpolation";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** Zombies already released onto the lane, fighting one enemy, with no round timer in
 *  play. `knockBack` decides whether the enemy's swing shoves its target. */
function laneSim(knockBack: boolean, playerCount = 2) {
  const players = Array.from({ length: playerCount }, (_, i) =>
    unit({ id: `p${i}`, sourceKey: "ZombieActorRegularTier1", team: "player", str: 1 })
  );
  const enemy = unit({
    id: "e", sourceKey: "FarmStageActorBoss", team: "enemy",
    con: 100000, str: 5, dex: 2, knockBack,
  });
  const sim = new BattleSim(
    players, [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
  );
  for (const p of players) sim.units.find((u) => u.id === p.id)!.state = "advance";
  return sim;
}

const enemyOf = (sim: BattleSim) => sim.units.find((u) => u.team === "enemy")!;
const playersOf = (sim: BattleSim) => sim.units.filter((u) => u.team === "player");

/** Run the fight and report how much damage the army took, plus how long the enemy went
 *  without a target while zombies were hitting it. */
function run(sim: BattleSim, ms: number) {
  let idleWhileAttacked = 0;
  let engaged = 0;
  for (let t = 0; t < ms; t += 50) {
    sim.step(50);
    const enemy = enemyOf(sim);
    if (!enemy.alive || (enemy.state !== "fight" && enemy.state !== "hold")) continue;
    const attackers = playersOf(sim).filter((p) => p.alive && p.state === "fight");
    if (!attackers.length) continue;
    engaged++;
    if (enemy.state !== "fight") idleWhileAttacked++;
  }
  const players = playersOf(sim);
  const maxHp = players.reduce((s, p) => s + p.maxHp, 0);
  const left = players.reduce((s, p) => s + (p.alive ? Math.max(0, p.hp) : 0), 0);
  return {
    damageTaken: maxHp ? 1 - left / maxHp : 0,
    idleFrac: engaged ? idleWhileAttacked / engaged : 0,
    enemyHp: enemyOf(sim).hp,
  };
}

/** KNOCKBACK_PX in BattleSim — how far a shove displaces its victim. */
const KNOCKBACK_PX = 150;

describe("an enemy that knocks a zombie back can still reach it", () => {
  it("strikes a zombie parked exactly where a knockback leaves it", () => {
    // The geometry of the defect, held still so nothing else can explain the result: a
    // zombie the shove left 150 units back — inside the attack band (it is still hitting
    // the enemy) and 210 units from an enemy that reaches 60.
    const sim = laneSim(true, 1) as unknown as {
      step: (ms: number) => void;
      players: Array<{ x: number; slotX: number; state: string; hp: number; maxHp: number }>;
      enemies: Array<{ x: number; state: string; hp: number; maxHp: number }>;
      frontX: number;
    };
    const zombie = sim.players[0];
    const enemy = sim.enemies[0];
    const parked = sim.frontX - KNOCKBACK_PX;

    for (let t = 0; t < 8000; t += 50) {
      // Re-park every tick: this test is about reach, not about walking back.
      zombie.x = parked;
      zombie.slotX = parked;
      sim.step(50);
    }

    expect(Math.abs(zombie.x - enemy.x)).toBeGreaterThan(60); // well outside melee reach
    expect(enemy.hp).toBeLessThan(enemy.maxHp); // …yet the zombie is hitting it…
    expect(zombie.hp).toBeLessThan(zombie.maxHp); // …and it hits back.
  });

  it("does not let a knockback enemy stand idle while it is being beaten", () => {
    const knocking = run(laneSim(true, 1), 30_000);
    const plain = run(laneSim(false, 1), 30_000);
    // Shoving its target away may still cost the enemy a beat, but not the long helpless
    // stretches it used to: it stays roughly as busy as one that never shoves.
    expect(knocking.idleFrac).toBeLessThan(plain.idleFrac + 0.15);
  });
});

describe("the reach-of-last-resort answers a standing front row too (v40)", () => {
  it("lets an ordinary enemy answer a STANDING zombie hitting it from out of melee range", () => {
    // v36 scoped the fallback to knockback enemies (the one case where the enemy emptied
    // its OWN melee range). That left every other enemy contractually blind whenever the
    // front slot was merely reserved — a Headless walking to its promotion slot while the
    // rest of the row STOOD a row-depth back, hitting it every swing. v40(b) closes that:
    // a line enemy with an empty melee ring strikes the front-most front-band zombie
    // standing at its slot. See replay.ts's v40 note for the scoping and the ripple.
    const sim = laneSim(false, 1) as unknown as {
      step: (ms: number) => void;
      players: Array<{ x: number; y: number; slotX: number; slotY: number; hp: number; maxHp: number }>;
      enemies: Array<{ x: number; hp: number; maxHp: number }>;
      frontX: number;
      assignFormation: () => void;
    };
    // Freeze the formation so the zombie can be held AT ITS SLOT beyond the enemy's
    // reach — the reserved-slot geometry, distilled. (Live formation would keep
    // re-assigning slot 0 back onto the line.)
    sim.assignFormation = () => {};
    const zombie = sim.players[0];
    const parked = sim.frontX - KNOCKBACK_PX;
    zombie.x = parked;
    zombie.slotX = parked;
    zombie.slotY = zombie.y;
    for (let t = 0; t < 8000; t += 50) sim.step(50);
    expect(Math.abs(zombie.x - sim.enemies[0].x)).toBeGreaterThan(60); // out of melee reach
    expect(sim.enemies[0].hp).toBeLessThan(sim.enemies[0].maxHp); // being hit…
    expect(zombie.hp).toBeLessThan(zombie.maxHp); // …and it hits back.
  });

  it("still ignores a zombie that is mid-walk rather than standing", () => {
    // The scoping that keeps re-forming lines walking in unpunished: the same geometry,
    // but the zombie's SLOT is elsewhere (it is crossing, not standing) — an ordinary
    // enemy has no answer to it, exactly as before v40.
    const sim = laneSim(false, 1) as unknown as {
      step: (ms: number) => void;
      players: Array<{ x: number; slotX: number; hp: number; maxHp: number }>;
      enemies: Array<{ hp: number; maxHp: number }>;
      frontX: number;
      assignFormation: () => void;
    };
    sim.assignFormation = () => {};
    const zombie = sim.players[0];
    for (let t = 0; t < 8000; t += 50) {
      zombie.x = sim.frontX - KNOCKBACK_PX; // held mid-lane…
      zombie.slotX = sim.frontX;            // …with its slot still on the line
      sim.step(50);
    }
    expect(sim.enemies[0].hp).toBeLessThan(sim.enemies[0].maxHp); // being hit…
    expect(zombie.hp).toBe(zombie.maxHp); // …but a walker is not a target.
  });
});

describe("the front row still takes the hits", () => {
  it("strikes only melee-range zombies whenever the front row is actually standing", () => {
    // The reach-of-last-resort must not turn into a free pass to snipe the back row.
    // The invariant is per-tick, not fight-wide: while ANY zombie stands in melee range,
    // the strike lands inside melee range — the fallback fires only in the windows where
    // that range is empty (the line walking up, a reshuffle in progress).
    const sim = laneSim(false, 4);
    let melee = 0;
    for (let t = 0; t < 6000; t += 50) {
      const enemy = enemyOf(sim);
      const before = playersOf(sim).map((p) => ({
        p, hp: p.hp,
        near: p.alive && p.knockBackSpeed <= 0 && Math.abs(p.x - enemy.x) <= 60,
      }));
      const hadMelee = before.some((b) => b.near);
      if (hadMelee) melee++;
      sim.step(50);
      for (const b of before) {
        if (b.p.hp < b.hp && hadMelee) {
          expect(b.near, "struck outside melee reach while the front row stood").toBe(true);
        }
      }
    }
    expect(melee).toBeGreaterThan(0); // the scenario actually exercised a standing front row
  });
});

// A unit does not have "an attack with knockback" — it rolls ONE attack per swing out of
// its list and applies THAT attack's flags, so an effect on a rare entry lands rarely.
// Collapsing the list to a boolean handed every swing the rarest entry's effects: the
// Lumberjack's shove lives on `LumberjackSpecial`, 10 of his 100 frequency, and he was
// shoving on all 100. Reported from a playtest as "his hits knock back every time".
describe("an attack's effects land at that attack's own frequency", () => {
  /** Shoves delivered over five minutes against a single zombie, by a slow attacker —
   *  slow enough that a slide is always over before the next swing, so every refused
   *  re-shove is the roll's doing and not the mid-slide guard's. */
  const shoves = (knockBackChance: number) => {
    const player = unit({
      id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", str: 1, con: 100000,
    });
    const enemy = unit({
      id: "e", sourceKey: "FarmStageActorLumberjack", team: "enemy",
      con: 100000, str: 1, dex: 1, knockBack: true, knockBackChance,
    });
    const sim = new BattleSim(
      [player], [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
    );
    sim.units.find((u) => u.id === "p")!.state = "advance";
    let started = 0;
    let sliding = false;
    for (let t = 0; t < 300_000; t += 50) {
      sim.step(50);
      const p = sim.units.find((u) => u.id === "p")!;
      if (p.knockBackSpeed > 0) {
        if (!sliding) started++;
        sliding = true;
      } else sliding = false;
    }
    return started;
  };

  it("shoves on every swing when the shove is on the unit's only attack", () => {
    expect(shoves(1)).toBeGreaterThan(150);
  });

  it("shoves about one swing in ten at the Lumberjack's authored 10%", () => {
    const every = shoves(1);
    const rare = shoves(0.1);
    expect(rare / every).toBeGreaterThan(0.04);
    expect(rare / every).toBeLessThan(0.2);
  });

  it("never shoves when no entry in the list carries one", () => {
    expect(shoves(0)).toBe(0);
  });
});

describe("a shove does not survive the fight it was landed in", () => {
  it("ends a slide that was still running when the army was sent home", () => {
    // Reported as "some zombies stop at the edge of the screen after an invasion. They
    // just stop walking." A slide is only ever ended by stepKnockBack, and the sim stops
    // stepping the instant the fight is decided — so a zombie caught mid-shove kept
    // `knockBackSpeed`, which the renderer reads twice: it draws a shoved zombie on an
    // ease-out CLAMPED to the slide's own interval (marching the other way leaves that
    // interval, pinning the rig to the spot it was hit on), and it holds the standing
    // pose rather than running the walk cycle. One zombie stood at the front line for the
    // whole victory march while the rest of the army walked past it and off the stage.
    const sim = laneSim(true);
    let shoved: { knockBackSpeed: number; knockBackToX: number; x: number } | undefined;
    for (let t = 0; t < 60_000 && !shoved; t += 50) {
      sim.step(50);
      shoved = playersOf(sim).find((p) => p.alive && p.knockBackSpeed > 0);
    }
    expect(shoved).toBeDefined();
    const slid = shoved!;
    // The clamp that froze it: drawn from where the shove began, the march back out the
    // other way lands outside [from..to] and pins the rig to `from`.
    const from = slid.x + 10;
    expect(knockBackDrawX(slid.x + 200, from, slid.knockBackToX)).toBe(from);

    sim.prepareArmyExit();

    expect(slid.knockBackSpeed).toBe(0);
    // …so the renderer's shove branch is skipped entirely and the march is drawn where
    // the simulation actually put it.
    advanceRaidArmy(sim.units, 1, 230, 1000);
    expect(slid.x).toBeGreaterThan(from);
  });
});
