// Ruleset v38 — the two pirate-raid changes, pinned end-to-end in the real sim.
//
// (a) Protect covers Headless. The aura was gated `group === "Headless" ? 0 : …` at BOTH
//     places that compute damage reduction — the CombatEngine build AND the per-tick
//     BattleSim.refreshTeamAuras. Fixing only one would have been silently undone on the
//     first tick, so the runtime half is pinned here rather than at the build site. A
//     carrier still does not shield ITSELF; it shields the rest of the line.
// (b) The Dread Pirate Arrrnold mirrors the attack speed of the zombie he is facing,
//     as the Scallywag already does. His authored 5000-damage slam exceeds the max hit
//     points of every zombie in the game, so con cannot answer him; his CLOCK is the dial
//     instead. A slow Headless front line holds him below his authored 2.5 s.
//
// v44 rebuilds his half of it. He no longer shares the Scallywag's recovered constants:
// he reads the front zombie's SPECIES BASE cycle (catalog dex alone — no veterancy, no
// mutations, no level ramp, no ability buff, no lineup band), on his own derived divisor,
// with his own 1.25 s floor. A Headless-led line holds him to one slam every 6.5 s and
// keeps holding it however upgraded that Headless is; the fastest body in the game (Small,
// dex 4) still only eats one every 1.25 s. Measured through the real sim, not the formula
// alone, because cycleMs is what has to reach for the species field for any of it to
// land in a fight — and the Scallywag standing next to him has to keep reading the other
// number in that same tick.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  mirroredAttackIntervalSec,
  pirateBossSlamIntervalSec,
  MIRROR_SPEED_KEYS,
  PIRATE_BOSS_KEY,
  PIRATE_BOSS_MIN_SLAM_SEC,
  SCALLYWAG_KEY,
} from "./combatStats";
import zombiesJson from "../../public/assets/zombies.json";
import { buildPlayerUnits } from "./CombatEngine";
import { makeOwned } from "../zombie/types";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** Arrrnold against one zombie of a species whose base cycle is `speciesCycleMs`. Its
 *  EFFECTIVE cycle starts equal to that; override `attackCooldownMs` through `playerOver`
 *  to drive the two apart, which is how the "he reads the body, not the build" tests work. */
function duel(
  speciesCycleMs: number,
  playerOver: Partial<CombatUnit> = {},
  backline: CombatUnit[] = []
) {
  const player = unit({
    id: "p", sourceKey: "ZombieActorBombie", team: "player", str: 1,
    con: 50, hp: 5000, maxHp: 5000,
    attackCooldownMs: speciesCycleMs, speciesCycleMs, ...playerOver,
  });
  const boss = unit({
    id: "boss", sourceKey: PIRATE_BOSS_KEY, team: "enemy", isBoss: true,
    str: 500, dex: 0.4, con: 5_000_000, attackCooldownMs: 2500, mirrorsOpponentSpeed: true,
  });
  const sim = new BattleSim(
    [player, ...backline], [boss], null, true, [],
    10 * 60 * 1000, null, null, false, false, false, 60, null, null
  );
  sim.units.find((u) => u.id === "p")!.state = "advance";
  return sim;
}

/** Gaps between the boss's landed swings, in ms. */
function swingGaps(sim: BattleSim, ticks = 2000) {
  const boss = sim.units.find((u) => u.isBoss)!;
  for (const p of sim.units.filter((u) => u.team === "player")) {
    p.hp = p.maxHp = 500_000_000; // immortal, so the measurement is not cut short
  }
  const at: number[] = [];
  let t = 0;
  for (let i = 0; i < ticks; i++) {
    if (!sim.step(50)) break;
    t += 50;
    if (boss.struckThisTick) at.push(t);
  }
  return at.slice(1).map((s, i) => s - at[i]);
}

describe("Arrrnold mirrors the zombie he is facing", () => {
  it("is flagged as a mirror, and no one outside the pirate family is", () => {
    expect(MIRROR_SPEED_KEYS.has(PIRATE_BOSS_KEY)).toBe(true);
    expect(MIRROR_SPEED_KEYS.has(SCALLYWAG_KEY)).toBe(true);
    expect(MIRROR_SPEED_KEYS.has("PirateStageActorSwashbuckler")).toBe(false);
    expect(MIRROR_SPEED_KEYS.size).toBe(2);
  });

  it("slams a Headless-led line once every 6.5 s", () => {
    // Headless / Bombie catalog dex 1 → a 2 s species cycle.
    const gaps = swingGaps(duel(2000));
    expect(gaps.length).toBeGreaterThan(3);
    // Landed swings are quantised to the 50 ms sim tick, so allow exactly one tick.
    for (const g of gaps) expect(Math.abs(g - 6500)).toBeLessThanOrEqual(50);
    expect(pirateBossSlamIntervalSec(2) * 1000).toBeCloseTo(6500);
    // …far slower than the 2.5 s clock he keeps when he is not mirroring.
    expect(6500).toBeGreaterThan(2500);
  });

  it("reads the BODY, not the build — rank and mutations do not speed him up", () => {
    // Same Headless body, but this one swings at 0.8 s: Master veterancy, mutations,
    // a speed ability, the level ramp. Under the effective-cycle reading that would
    // have been 0.8 s between slams; the species reading holds him at 6.5 s.
    const gaps = swingGaps(duel(2000, { attackCooldownMs: 800 }));
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(Math.abs(g - 6500)).toBeLessThanOrEqual(50);
  });

  it("…while a Scallywag in that same fight still reads the effective cycle", () => {
    const sim = duel(2000, { attackCooldownMs: 800 });
    const boss = sim.units.find((u) => u.isBoss)!;
    boss.sourceKey = SCALLYWAG_KEY; // same unit, minion's key: 0.8²/0.8 = 0.8 s
    const gaps = swingGaps(sim);
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(Math.abs(g - 800)).toBeLessThanOrEqual(50);
    expect(mirroredAttackIntervalSec(0.8) * 1000).toBeCloseTo(800);
  });

  it("a FAST species is held at the 1.25 s floor, not driven below it", () => {
    const gaps = swingGaps(duel(500)); // Small, catalog dex 4 → 0.5 s species cycle
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(Math.abs(g - 1250)).toBeLessThanOrEqual(50);
  });

  it("prices the middle of the catalog between the two", () => {
    for (const [speciesMs, expected] of [[1538, 3846], [1000, 1625]] as [number, number][]) {
      const gaps = swingGaps(duel(speciesMs));
      expect(gaps.length).toBeGreaterThan(3);
      for (const g of gaps) expect(Math.abs(g - expected)).toBeLessThanOrEqual(50);
    }
  });

  it("never swings faster than the floor, whatever the species", () => {
    for (const cycle of [10, 50, 100, 200]) {
      for (const g of swingGaps(duel(cycle), 400)) expect(g).toBeGreaterThanOrEqual(1250);
    }
  });
});

describe("Protect covers Headless too", () => {
  it("survives the per-tick aura refresh, not just the build", () => {
    // Two Headless carriers: each takes the OTHER's 20%. Pre-v38 both sat at zero, and
    // refreshTeamAuras re-applied that exclusion on every one of the 40 steps below —
    // which is why the runtime half is pinned and not just the build.
    const tankUnit = (id: string) => unit({
      id, sourceKey: "ZombieActorBombie", team: "player",
      abilities: ["protect"], str: 1, con: 50, hp: 5000, maxHp: 5000,
    });
    const boss = unit({
      id: "boss", sourceKey: PIRATE_BOSS_KEY, team: "enemy", isBoss: true,
      str: 500, dex: 0.4, con: 5_000_000, attackCooldownMs: 2500, mirrorsOpponentSpeed: true,
    });
    const sim = new BattleSim(
      [tankUnit("tank"), tankUnit("tank2")], [boss], null, true, [],
      10 * 60 * 1000, null, null, false, false, false, 60, null, null
    );
    const tank = sim.units.find((u) => u.id === "tank")!;
    tank.state = "advance";
    sim.units.find((u) => u.id === "tank2")!.state = "advance";
    for (let i = 0; i < 40; i++) sim.step(50);
    expect(tank.damageReduction).toBeCloseTo(0.2);
  });

  it("a lone carrier is still worth nothing to itself", () => {
    const solo = duel(2000, { abilities: ["protect"] });
    for (let i = 0; i < 40; i++) solo.step(50);
    expect(solo.units.find((u) => u.team === "player")!.damageReduction).toBe(0);
  });

  it("mitigates the slam the front zombie is standing in", () => {
    // A Bombie backed by ONE other Protect carrier — the case the old exclusion could
    // never reach, and the one that matters: Arrrnold's 5000 lands as 4000.
    const plain = duel(2000);
    swingGaps(plain, 400);
    const bare = plain.units.find((u) => u.id === "p")!;

    const shielded = duel(2000, {}, [
      unit({ id: "backer", sourceKey: "ZombieActorBombie", team: "player", abilities: ["protect"] }),
    ]);
    swingGaps(shielded, 400);
    const front = shielded.units.find((u) => u.id === "p")!;

    expect(front.damageReduction).toBeCloseTo(0.2);
    expect(front.damageFxTaken).toBeCloseTo(bare.damageFxTaken * 0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// Where `speciesCycleMs` COMES FROM.
// ---------------------------------------------------------------------------
// Everything above hands the sim a fixture unit with `speciesCycleMs` already set, so
// all of it passes whatever `buildPlayerUnits` actually derives — including the v43
// reading v44 exists to replace. Swapping `rawDex` for `bDex * v` in CombatEngine (i.e.
// letting the level ramp and veterancy back in, the precise bug) kept the whole suite
// green. These tests are the ones that go red.
//
// They read the REAL catalog rather than restating dex values, because the second thing
// worth pinning is a property of the data: the counter-play rests on every Headless
// being dex 1, not on the formula.
describe("buildPlayerUnits derives the species cycle from the catalog body", () => {
  const defs = zombiesJson as Array<Record<string, unknown>>;
  const byGroup = (group: string) => defs.filter((z) => z.group === group);
  const build = (def: Record<string, unknown>, invasions: number, mutation: number, level?: number) =>
    buildPlayerUnits(
      [makeOwned("z0", def as unknown as Parameters<typeof makeOwned>[1], 0, 0, invasions, mutation)],
      { concentration: true, abilityUnlocked: () => true, playerLevel: level }
    )[0];

  it("sets it to 2 s / CATALOG dex, for every body in the roster", () => {
    for (const def of defs.filter((z) => z.group && typeof z.dex === "number")) {
      const u = build(def, 0, 0);
      expect(u.speciesCycleMs, String(def.key)).toBeCloseTo(2000 / (def.dex as number), 5);
    }
  });

  // THE INVARIANT THE WHOLE RULESET BUMP IS FOR. Under v43 the boss read the effective
  // cycle, so each of these made his one-shot land MORE often; the species cycle must
  // not move for any of them, while the effective cycle demonstrably does.
  it("is deaf to veterancy and the level ramp — which do move the EFFECTIVE cycle", () => {
    const headless = byGroup("Headless")[0];
    const fresh = build(headless, 0, 0);
    const upgraded = build(headless, 500, 0xffff, 45); // Master rank, every legal bit, level 45

    expect(fresh.speciesCycleMs).toBeCloseTo(2000, 5);
    expect(upgraded.speciesCycleMs).toBeCloseTo(2000, 5);
    // The upgrade is real: it genuinely sped this zombie up.
    expect(upgraded.attackCooldownMs).toBeLessThan(fresh.attackCooldownMs);
    // …and bought Arrrnold nothing.
    expect(pirateBossSlamIntervalSec(upgraded.speciesCycleMs! / 1000)).toBeCloseTo(6.5);
    expect(pirateBossSlamIntervalSec(fresh.speciesCycleMs! / 1000)).toBeCloseTo(6.5);
  });

  // Separate case, and not on a Headless, because a Headless CANNOT WEAR the dex
  // mutations — makeOwned's body-type restriction strips them — so asserting
  // "mutations don't matter" there proves nothing. On a Large they all stick, and they
  // are the largest single input of the four: +5 flat dex takes its cycle from 1538 ms
  // to 317 ms. Under v43 that alone drove Arrrnold onto the 0.5 s Scallywag floor —
  // a 5000-damage one-shot twice a second — which is the sharpest illustration of what
  // this ruleset removed.
  it("is deaf to a DEX MUTATION too, on a body that can actually carry one", () => {
    const large = byGroup("Large")[0];
    const DEX_MUTATIONS = (1 << 2) | (1 << 5) | (1 << 14);
    const plain = build(large, 0, 0);
    const mutated = build(large, 0, DEX_MUTATIONS);

    expect(mutated.attackCooldownMs).toBeLessThan(plain.attackCooldownMs / 3); // it really stuck
    expect(mutated.speciesCycleMs).toBeCloseTo(plain.speciesCycleMs!, 5);
    expect(pirateBossSlamIntervalSec(mutated.speciesCycleMs! / 1000))
      .toBeCloseTo(pirateBossSlamIntervalSec(plain.speciesCycleMs! / 1000));
  });

  // The counter-play is "lead with a Headless", so it has to hold for ANY Headless a
  // player might own, not just the tuning point. That is a fact about the catalog: all
  // seven share dex 1. A future Headless authored faster would quietly weaken the
  // counter-play everywhere it is stated — the tip, the guide, the ruleset note.
  it("holds the 6.5 s counter-play for every Headless in the catalog", () => {
    const headless = byGroup("Headless");
    expect(headless.length).toBeGreaterThan(0);
    for (const def of headless) {
      const u = build(def, 500, 0, 45);
      expect(pirateBossSlamIntervalSec(u.speciesCycleMs! / 1000), String(def.key)).toBeCloseTo(6.5);
    }
  });

  // Deliberately NOT per-family: `speciesCycleMs` is per catalog ENTRY, and Regular
  // spans dex 1 to 8. A dex-1 Regular holds him at 6.5 s exactly like a Headless; a
  // fast one sits on the floor. Pinned because the ruleset note's table reads as one
  // row per family, and "fixing" this toward a per-family constant would be a rules
  // change wearing a tidy-up's clothes.
  it("prices two bodies of the SAME family differently when the catalog does", () => {
    const regulars = byGroup("Regular").filter((z) => typeof z.dex === "number");
    const slowest = regulars.reduce((a, b) => ((a.dex as number) <= (b.dex as number) ? a : b));
    const fastest = regulars.reduce((a, b) => ((a.dex as number) >= (b.dex as number) ? a : b));
    expect(slowest.dex).toBeLessThan(fastest.dex as number);

    const slow = pirateBossSlamIntervalSec(build(slowest, 0, 0).speciesCycleMs! / 1000);
    const fast = pirateBossSlamIntervalSec(build(fastest, 0, 0).speciesCycleMs! / 1000);
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBe(PIRATE_BOSS_MIN_SLAM_SEC);
  });
});
