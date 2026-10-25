import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import { raidProfile } from "./dualInvasion";
import { RAID_TIME_LIMIT_MS } from "./BattleSim";
import {
  ELITE_NIGHT_OFFSET, FIRST_NIGHT, MAX_NIGHT, NIGHT_TIME_LIMIT_MS, clampNight, hasNights,
  nightBrainLuck, nightDamageMult, nightDifficulty, nightGoldShare, nightHpMult, nightLabel, nightProfile, nightPrompt, nightStage,
  nightTimeLimitMs, nightZombieLuck,
} from "./halloweenNights";
import { flyFight } from "./harness/pilot";
import { EXPERT, makePilot } from "./harness/pilots";
import { harnessFight } from "./harness/raidFight";
import { buildRoster } from "./harness/roster";
import { markRoster } from "./harness/unlockArmy";
import { HALLOWEEN_RAID_ID } from "./zombieDrops";

describe("Halloween nights: the rules", () => {
  it("belong to the Halloween invasion alone", () => {
    expect(hasNights(HALLOWEEN_RAID_ID)).toBe(true);
    for (const id of [1, 2, 10, 11, 12]) expect(hasNights(id)).toBe(false);
  });

  it("leave night 1, the ordinary invasion, exactly as it was", () => {
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 1 })).toEqual(raidProfile(HALLOWEEN_RAID_ID));
    expect(nightProfile(FIRST_NIGHT, null)).toBeNull();
    expect(nightTimeLimitMs(HALLOWEEN_RAID_ID, 1, RAID_TIME_LIMIT_MS)).toBe(RAID_TIME_LIMIT_MS);
  });

  it("scale hit points and damage up every hour, hit points fastest late on", () => {
    for (let night = 2; night <= MAX_NIGHT; night++) {
      const p = nightProfile(night, null)!;
      expect(p.con).toBeCloseTo(nightHpMult(night));
      expect(p.bossCon).toBeCloseTo(nightHpMult(night));
      expect(p.str).toBeCloseTo(nightDamageMult(night));
      expect(nightHpMult(night)).toBeGreaterThan(nightHpMult(night - 1));
      expect(nightDamageMult(night)).toBeGreaterThan(nightDamageMult(night - 1));
    }
    // From Hour 5 on the curve is HP-led again: the late hours are lost on the clock.
    for (let night = 5; night <= MAX_NIGHT; night++) {
      expect(nightHpMult(night)).toBeGreaterThan(nightDamageMult(night));
    }
  });

  it("layer over a fight's own profile rather than replacing it", () => {
    const base = { str: 2, con: 3, dex: 1.5, throwDamage: 2, throwRate: 1.2, wallHp: 1, specialDamage: 2 };
    const p = nightProfile(3, base)!;
    expect(p.con).toBeCloseTo(3 * nightHpMult(3));
    expect(p.str).toBeCloseTo(2 * nightDamageMult(3));
    expect(p.dex).toBe(1.5);
    expect(p.throwRate).toBe(1.2);
  });

  it("run on a two-minute clock from hour 2", () => {
    expect(NIGHT_TIME_LIMIT_MS).toBe(120_000);
    expect(nightTimeLimitMs(HALLOWEEN_RAID_ID, 2, RAID_TIME_LIMIT_MS)).toBe(120_000);
    expect(nightTimeLimitMs(10, 2, RAID_TIME_LIMIT_MS)).toBe(RAID_TIME_LIMIT_MS);
  });

  it("climb the old curve slowly: Hour 12 at old rung 6.85, two thirds of its hit points", () => {
    expect(nightDifficulty(1)).toBe(1);
    expect(nightDifficulty(12)).toBeCloseTo(6.85);
    for (let n = 2; n <= 12; n++) {
      expect(nightDifficulty(n) - nightDifficulty(n - 1)).toBeCloseTo(5.85 / 11);
    }
    const oldHp = (s: number) => (1 + (s * (s - 1)) / 2) * Math.pow(1.2, s - 1);
    expect(nightHpMult(1)).toBe(1);
    for (let n = 2; n <= 12; n++) expect(nightHpMult(n)).toBeCloseTo((2 / 3) * oldHp(nightDifficulty(n)));
    // The table the owner signed off on (2026-10-25).
    expect(nightHpMult(2)).toBeCloseTo(1.03, 1);
    expect(nightHpMult(6)).toBeCloseTo(6.3, 0);
    expect(nightHpMult(12)).toBeCloseTo(40.7, 0);
    expect(nightDamageMult(2)).toBeCloseTo(1.66, 1);
    expect(nightDamageMult(6)).toBeCloseTo(4.32, 1);
    expect(nightDamageMult(12)).toBeCloseTo(8.31, 1);
  });

  it("pay a quarter of the win gold from hour 2, rising with the difficulty, never below", () => {
    expect(nightGoldShare(1)).toBe(1);
    expect(nightGoldShare(2)).toBe(0.25); // floored: hour 2 sits below old rung 2
    expect(nightGoldShare(6)).toBeCloseTo(0.333, 2);
    expect(nightGoldShare(12)).toBeCloseTo(0.4925, 3);
    for (let n = 3; n <= 12; n++) {
      expect(nightGoldShare(n)).toBeGreaterThanOrEqual(nightGoldShare(n - 1));
      expect(nightGoldShare(n)).toBeGreaterThanOrEqual(0.25);
    }
    expect(nightGoldShare(12)).toBeGreaterThan(nightGoldShare(6));
  });

  it("make the rare zombie and brains likelier on the same slow step as the fight", () => {
    expect(nightZombieLuck(1)).toBe(1);
    expect(nightBrainLuck(1)).toBe(0.294); // ~0.29 of the rung's odds, from night 1
    const step = 5.85 / 11;
    for (let night = 2; night <= MAX_NIGHT; night++) {
      expect(nightZombieLuck(night) / nightZombieLuck(night - 1)).toBeCloseTo(Math.pow(1.5, step));
      expect(nightBrainLuck(night) / nightBrainLuck(night - 1)).toBeCloseTo(Math.pow(1.1, step));
    }
    expect(nightZombieLuck(12)).toBeCloseTo(Math.pow(1.5, 5.85)); // ~10.7x by Hour 12
  });

  it("start a Brain Ticket run two nights in, and keep counting from 1 on the label", () => {
    expect(ELITE_NIGHT_OFFSET).toBe(2);
    expect(nightStage(1, true)).toBe(3);
    expect(nightStage(2, true)).toBe(4);
    expect(nightStage(1, false)).toBe(1);
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 1, elite: true })).toEqual(nightProfile(3, null));
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 2, elite: true })).toEqual(raidProfile(HALLOWEEN_RAID_ID, { night: 4 }));
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 1, elite: false })).toBeNull();
    // Capped at Hour 12: Elite Hours 10, 11 and 12 are all Hour 12's fight.
    for (const n of [10, 11, 12]) expect(nightStage(n, true)).toBe(MAX_NIGHT);
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 11, elite: true })).toEqual(nightProfile(12, null));
    expect(nightTimeLimitMs(HALLOWEEN_RAID_ID, nightStage(1, true), RAID_TIME_LIMIT_MS)).toBe(NIGHT_TIME_LIMIT_MS);
    expect(nightLabel(1, true)).toBe("Elite Hour 1");
    expect(nightLabel(3, false)).toBe("Hour 3");
    // Twelve hours make the night: Hour 12 is the last, and nothing labels past it.
    expect(MAX_NIGHT).toBe(12);
    expect(nightLabel(99, false)).toBe("Hour 12");
  });

  it("clamp a night off the wire", () => {
    expect(clampNight(undefined)).toBe(FIRST_NIGHT);
    expect(clampNight("abc")).toBe(FIRST_NIGHT);
    expect(clampNight(-4)).toBe(FIRST_NIGHT);
    expect(clampNight(2.9)).toBe(2);
    expect(clampNight(9999)).toBe(MAX_NIGHT);
  });

  it("say a different, darker thing before each night, and that nothing won is lost", () => {
    const titles = [2, 3, 4, 5, 6].map((night) => nightPrompt(night).title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(nightPrompt(2).title).toBe("The night is still young.");
    for (let night = 2; night <= 9; night++) {
      const { body } = nightPrompt(night);
      expect(body).toContain(`Hour ${night}`);
      expect(body).toContain("Win or lose, you keep everything you've already won.");
      expect(body.length).toBeLessThan(160); // short
    }
    expect(nightPrompt(2, true).body).toContain("Elite Hour 2");
  });
});

// The design target, measured in the real simulation (see NIGHT_LAST_DIFFICULTY for the
// tables): a maxed-but-not-optimised level-45 army (16 bodies, no Concentration) earns the
// Hour 6 statue easily and still wins Hour 10 near the clock, but Hour 12 is beyond it.
// Hour 12 is for the best real armies, played well; see the constant's comment.
describe("Halloween nights: the curve, in the sim", () => {
  const fly = (night: number, seed: number) => {
    const roster = buildRoster(markRoster("ceiling", 45));
    const waveSeed = `nights-test:${night}:${seed}`;
    const { spec } = harnessFight({
      raidId: HALLOWEEN_RAID_ID, night, playerLevel: 45, playerUnits: roster.units, waveSeed,
    });
    return flyFight(buildFight(spec), makePilot(EXPERT), { seed: waveSeed });
  };

  // Measured 2026-10-25: Hour 6 in 63-64 s, Hour 10 in 114 s, Hours 11-12 out of time with
  // all 16 standing. Pinned loosely enough to survive small wave retunes.
  it("lets a maxed level-45 army through Hour 10, but only near the two-minute clock", () => {
    for (const seed of [0, 1]) {
      const statue = fly(6, seed);
      expect(statue.win).toBe(true);
      expect(statue.secs).toBeLessThan(90);
      const flight = fly(10, seed);
      expect(flight.win).toBe(true);
      expect(flight.secs).toBeGreaterThan(90);
      expect(flight.secs).toBeLessThan(NIGHT_TIME_LIMIT_MS / 1000);
    }
  }, 120_000);

  it("runs that army out of time on Hour 12, without wiping it", () => {
    for (const seed of [0, 1]) {
      const flight = fly(12, seed);
      expect(flight.win).toBe(false);
      expect(flight.timedOut).toBe(true);
      expect(flight.survivors).toBeGreaterThan(0);
    }
  }, 120_000);
});
