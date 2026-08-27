// Where a rig is in its swing, and the two ways the old reading got it wrong.
//
// The renderer used to compute this as `1 - timerMs / cooldownMs`. Both halves of that
// are assumptions the sim does not honour: the timer is armed by `BattleSim.cycleMs`,
// which equals `cooldownMs` only for a front-rank zombie and a non-mirroring enemy, and
// progress 0 means "a blow just landed" — which is not true of a fighter that has only
// just found something to hit. Arrrnold breaks both at once, so he is the case here.
import { describe, expect, it } from "vitest";
// @ts-ignore - node types are test-environment only, as in rigClips.test.ts
import { readFileSync } from "node:fs";
import { BattleSim } from "./BattleSim";
import type { CombatUnit } from "./types";
import { evalKeys, smooth } from "./rigClips.js";
import {
  ageAttackPhase, attackProgress, markStruck, newAttackPhase, observeAttackTimer,
  postContactTail,
} from "./attackPhase";
import { PIRATE_BOSS_HEADLESS_SLAM_SEC, PIRATE_BOSS_KEY } from "./combatStats";

const DAMAGE_TIMING = 0.95; // PirateBossSlash, attacks.json (ground truth)
const TAIL = 1 - DAMAGE_TIMING;
/** The pirate's swing runs on the SOURCE timeline, so it really does have a tail. */
const SLAM_TAIL = postContactTail(DAMAGE_TIMING, true);
const RAW_COOLDOWN_MS = 2500; // the boss's own dex clock: 1 / 0.4
const REAL_CYCLE_MS = PIRATE_BOSS_HEADLESS_SLAM_SEC * 1000; // what he is ARMED with

/** The engine's cooldown→clip-time rotation (EnemyActor.sourceAttackProgress). */
const clipTime = (prog: number) => (prog <= TAIL ? DAMAGE_TIMING + prog : prog - TAIL);

const CLIPS = JSON.parse(
  readFileSync(new URL("../../public/assets/raids/enemies/clips.json", import.meta.url), "utf-8")
);
const FRONT_ARM = CLIPS[PIRATE_BOSS_KEY].attack.tracks.find(
  (t: { name: string }) => t.name === "front arm hack"
);
/** The front arm's angle in degrees at a point in the swing. */
const armAt = (prog: number) => evalKeys(FRONT_ARM.keys, clipTime(prog), FRONT_ARM.ease);

describe("attack phase", () => {
  it("scales the swing by the interval the timer was armed with, not cooldownMs", () => {
    const phase = newAttackPhase(RAW_COOLDOWN_MS);
    // The blow lands and the sim arms the mirrored clock: 6.5 s off a 2.5 s cooldown.
    observeAttackTimer(phase, REAL_CYCLE_MS, true);
    expect(phase.cycleMs).toBe(REAL_CYCLE_MS);
    // Halfway through that cycle the rig is halfway through its wind-up. Under the old
    // reading `1 - 3250/2500` is negative and clamps to 0, freezing the rig instead.
    expect(attackProgress(phase, REAL_CYCLE_MS / 2, SLAM_TAIL)).toBeCloseTo(0.5, 6);
    expect(1 - REAL_CYCLE_MS / 2 / RAW_COOLDOWN_MS).toBeLessThan(0); // the old reading
  });

  it("holds a swing at rest until a blow actually lands", () => {
    const phase = newAttackPhase(RAW_COOLDOWN_MS);
    // Freshly engaged: a full timer, and nothing struck. Progress 0 would draw the
    // follow-through of a slam that never happened.
    observeAttackTimer(phase, RAW_COOLDOWN_MS, true);
    expect(attackProgress(phase, RAW_COOLDOWN_MS, SLAM_TAIL)).toBe(TAIL);
    expect(armAt(TAIL)).toBe(0); // …which is the rig standing at rest

    markStruck(phase);
    expect(attackProgress(phase, RAW_COOLDOWN_MS, SLAM_TAIL)).toBe(0);
    expect(armAt(0)).toBeGreaterThan(88); // …and that IS the contact frame, arms up
  });

  it("does not replay the slam every time a target steps in and out of reach", () => {
    // A front row that dies and refills (or a knockback shoving its victim past the
    // engage band) leaves the enemy with no foe for a tick or two, and the sim re-arms
    // its clock on every one of those ticks. Each re-engage used to restart the drawn
    // swing at progress 0 — a full 225° slam, dealing nothing.
    const phase = newAttackPhase(RAW_COOLDOWN_MS);
    let timerMs = REAL_CYCLE_MS * 0.4; // mid wind-up when the target is lost
    let drawnSlams = 0;
    let prevArm = armAt(attackProgress(phase, timerMs, SLAM_TAIL));
    for (let i = 0; i < 40; i++) {
      const fighting = i % 4 >= 2; // in reach, out of reach, in reach…
      timerMs = fighting ? Math.max(0, timerMs - 16.7) : RAW_COOLDOWN_MS; // sim's `hold`
      observeAttackTimer(phase, timerMs, fighting);
      const arm = armAt(attackProgress(phase, timerMs, SLAM_TAIL));
      if (fighting) {
        if (prevArm > -40 && arm <= -40) drawnSlams++;
        prevArm = arm;
      }
      ageAttackPhase(phase, 16.7);
    }
    expect(drawnSlams).toBe(0);
  });

  it("still draws the follow-through of a blow that did land", () => {
    const phase = newAttackPhase(REAL_CYCLE_MS);
    observeAttackTimer(phase, REAL_CYCLE_MS, true);
    markStruck(phase);
    let lowest = 0;
    for (let ms = 0; ms < TAIL * REAL_CYCLE_MS; ms += 16.7) {
      lowest = Math.min(lowest, armAt(attackProgress(phase, REAL_CYCLE_MS - ms, SLAM_TAIL)));
      ageAttackPhase(phase, 16.7);
    }
    // Sampled at 60 Hz, as the renderer is: the -135° bottom itself falls between two
    // frames, so what this pins is that the drawn arm really does plunge through it.
    expect(lowest).toBeLessThan(-120);
  });
});

function unit(
  over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">
): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** Arrrnold against a Headless front — the slowest body in the game, and the one his
 *  6.5 s slam is tuned against, so the gap between his armed clock and his `cooldownMs`
 *  is at its widest. Run the fight, and draw it the way RaidScene does. */
function traceArm() {
  const players = Array.from({ length: 6 }, (_, i) =>
    unit({
      id: `p${i}`, sourceKey: "ZombieActorHeadlessTier1", team: "player", str: 1, dex: 1,
      speciesCycleMs: 2000, hp: 400, maxHp: 400, isHeadless: true,
    })
  );
  const bossUnit = unit({
    id: "boss", sourceKey: PIRATE_BOSS_KEY, team: "enemy", isBoss: true, con: 100000,
    str: 500, dex: 0.4, mirrorsOpponentSpeed: true, attackCooldownMs: RAW_COOLDOWN_MS,
    attacks: [{ name: "PirateBossSlash", frequency: 100, mult: 1 }],
  });
  const sim = new BattleSim(
    players, [bossUnit], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
  );
  for (const p of players) sim.units.find((u) => u.id === p.id)!.state = "advance";
  const boss = sim.units.find((u) => u.team === "enemy")!;

  const phase = newAttackPhase(boss.cooldownMs);
  const TICK = 1000 / 60;
  const armAtHit: number[] = [];
  let slamsDrawn = 0, slamsOnAHit = 0, hits = 0;
  let stillMs = 0, longestStillMs = 0, prevArm = 0;
  for (let i = 0; i < 60 * 40; i++) {
    sim.step(TICK);
    const fighting = boss.state === "fight" && boss.alive;
    if (boss.struckThisTick) markStruck(phase);
    observeAttackTimer(phase, boss.timerMs, fighting);
    const arm = armAt(attackProgress(phase, boss.timerMs, SLAM_TAIL));
    if (fighting) {
      if (boss.struckThisTick) { hits++; armAtHit.push(arm); }
      // A slam is the arm crossing down past the halfway point of its plunge.
      if (prevArm > -40 && arm <= -40) {
        slamsDrawn++;
        if (phase.sinceStrikeMs <= TAIL * phase.cycleMs + 64) slamsOnAHit++;
      }
      if (Math.abs(arm - prevArm) < 0.05) stillMs += TICK;
      else { longestStillMs = Math.max(longestStillMs, stillMs); stillMs = 0; }
      prevArm = arm;
    }
    ageAttackPhase(phase, TICK);
  }
  return { hits, armAtHit, slamsDrawn, slamsOnAHit, longestStillMs, cycleMs: phase.cycleMs };
}

describe("Arrrnold's slam, drawn against the real fight", () => {
  const t = traceArm();

  it("takes his mirrored clock, not his dex clock", () => {
    expect(t.hits).toBeGreaterThan(2);
    expect(t.cycleMs).toBeGreaterThan(REAL_CYCLE_MS * 0.9);
  });

  it("lands every blow on the contact frame, arms overhead", () => {
    for (const arm of t.armAtHit) expect(arm).toBeGreaterThan(88);
  });

  it("draws one slam per blow and none without one", () => {
    expect(t.slamsDrawn).toBe(t.hits);
    expect(t.slamsOnAHit).toBe(t.hits);
  });

  it("never parks the arms mid-swing", () => {
    // The old reading clamped progress to 0 for the 4 s by which his mirrored cycle
    // overran `cooldownMs`, holding both arms overhead dead still for most of the fight.
    expect(t.longestStillMs).toBeLessThan(400);
  });
});

describe("the clip those numbers are read from", () => {
  it("puts the slam and its recovery inside the post-contact tail", () => {
    // The renderer holds an unstruck swing at clip time 0, so clip time 0 has to BE the
    // rest pose — which means the lift back out of the slam has to finish by then.
    expect(armAt(TAIL)).toBe(0);
    expect(evalKeys(FRONT_ARM.keys, 1, FRONT_ARM.ease)).toBe(0);
    expect(evalKeys(FRONT_ARM.keys, 0, FRONT_ARM.ease)).toBe(0);
  });

  it("reaches the top only at the contact frame, so the slam follows immediately", () => {
    // The source's two-key smoothstep raise was within 10° of the top for the last fifth
    // of the cycle; scaled onto a 6.5 s clock that is over a second of standing still.
    const dwell = (at: (t: number) => number) => {
      for (let i = 0; i <= 950; i++) if (at(i / 1000) >= 80) return 0.95 - i / 1000;
      return 0;
    };
    const authored = dwell((x) => evalKeys(FRONT_ARM.keys, x, FRONT_ARM.ease));
    const source = dwell((x) => 90 * smooth(x / 0.95)); // the two-key original
    expect(authored).toBeLessThan(source / 2);
  });
});
