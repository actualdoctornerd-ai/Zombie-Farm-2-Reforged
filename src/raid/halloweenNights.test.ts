import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import { raidProfile } from "./dualInvasion";
import { RAID_TIME_LIMIT_MS } from "./BattleSim";
import {
  ELITE_NIGHT_OFFSET, FIRST_NIGHT, MAX_NIGHT, NIGHT_TIME_LIMIT_MS, clampNight, hasNights,
  nightBrainLuck, nightDamageMult, nightGoldShare, nightHpMult, nightLabel, nightProfile, nightPrompt, nightStage,
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

  it("scale chiefly by hit points, and damage by less", () => {
    for (let night = 2; night <= 6; night++) {
      const p = nightProfile(night, null)!;
      expect(p.con).toBeCloseTo(nightHpMult(night));
      expect(p.bossCon).toBeCloseTo(nightHpMult(night));
      expect(p.str).toBeCloseTo(nightDamageMult(night));
      expect(p.con).toBeGreaterThan(p.str); // HP-led: nights are lost on the clock
      expect(nightHpMult(night)).toBeGreaterThan(nightHpMult(night - 1));
      expect(nightDamageMult(night)).toBeGreaterThan(nightDamageMult(night - 1));
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

  it("run on a three-minute clock from night 2", () => {
    expect(NIGHT_TIME_LIMIT_MS).toBe(180_000);
    expect(nightTimeLimitMs(HALLOWEEN_RAID_ID, 2, RAID_TIME_LIMIT_MS)).toBe(180_000);
    expect(nightTimeLimitMs(10, 2, RAID_TIME_LIMIT_MS)).toBe(RAID_TIME_LIMIT_MS);
  });

  it("follow the owner's curve: HP 1, 2.4, 5.76, 12.1 ...; damage x1, x2, x3 ...", () => {
    expect(nightHpMult(1)).toBe(1);
    expect(nightHpMult(2)).toBeCloseTo(2 * 1.2);
    expect(nightHpMult(3)).toBeCloseTo(4 * 1.44);
    expect(nightHpMult(4)).toBeCloseTo(7 * 1.728);
    expect(nightHpMult(5)).toBeCloseTo(11 * 2.0736);
    for (let n = 1; n <= 8; n++) expect(nightDamageMult(n)).toBeCloseTo(n);
  });

  it("pay a quarter of the win gold from night 2", () => {
    expect(nightGoldShare(1)).toBe(1);
    for (let n = 2; n <= 8; n++) expect(nightGoldShare(n)).toBe(0.25);
  });

  it("make the rare zombie x1.5 likelier every night, and brains gently likelier", () => {
    expect(nightZombieLuck(1)).toBe(1);
    expect(nightBrainLuck(1)).toBe(0.5); // half the rung's odds, from night 1
    for (let night = 2; night <= 8; night++) {
      expect(nightZombieLuck(night) / nightZombieLuck(night - 1)).toBeCloseTo(1.5);
      expect(nightBrainLuck(night) / nightBrainLuck(night - 1)).toBeCloseTo(1.1);
    }
  });

  it("start a Brain Ticket run two nights in, and keep counting from 1 on the label", () => {
    expect(ELITE_NIGHT_OFFSET).toBe(2);
    expect(nightStage(1, true)).toBe(3);
    expect(nightStage(2, true)).toBe(4);
    expect(nightStage(1, false)).toBe(1);
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 1, elite: true })).toEqual(nightProfile(3, null));
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 2, elite: true })).toEqual(raidProfile(HALLOWEEN_RAID_ID, { night: 4 }));
    expect(raidProfile(HALLOWEEN_RAID_ID, { night: 1, elite: false })).toBeNull();
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

// The design target, measured in the real simulation (see NIGHT_HP_GROWTH for the table):
// night 5 is a strain on a maxed level-45 army, and the night after it runs the clock out.
describe("Halloween nights: the curve, in the sim", () => {
  const fly = (night: number, seed: number) => {
    const roster = buildRoster(markRoster("ceiling", 45));
    const waveSeed = `nights-test:${night}:${seed}`;
    const { spec } = harnessFight({
      raidId: HALLOWEEN_RAID_ID, night, playerLevel: 45, playerUnits: roster.units, waveSeed,
    });
    return flyFight(buildFight(spec), makePilot(EXPERT), { seed: waveSeed });
  };

  // Pinned loosely enough to hold whatever the base wave's own tuning is doing: night 5 is a
  // real fight and night 8 is past the wall (measured: unbuffed wave clears 7, buffed 6).
  it("lets a maxed level-45 army through night 5, but only after a long fight", () => {
    for (const seed of [0, 1]) {
      const flight = fly(5, seed);
      expect(flight.win).toBe(true);
      expect(flight.secs).toBeGreaterThan(80);
      expect(flight.secs).toBeLessThan(NIGHT_TIME_LIMIT_MS / 1000);
    }
  }, 120_000);

  it("runs that army out of time on night 8, without wiping it", () => {
    for (const seed of [0, 1]) {
      const flight = fly(8, seed);
      expect(flight.win).toBe(false);
      expect(flight.timedOut).toBe(true);
      expect(flight.survivors).toBeGreaterThan(0);
    }
  }, 120_000);
});
