import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import { raidProfile } from "./dualInvasion";
import { RAID_TIME_LIMIT_MS } from "./BattleSim";
import {
  FIRST_NIGHT, MAX_NIGHT, NIGHT_TIME_LIMIT_MS, clampNight, hasNights, nightDamageMult,
  nightHpMult, nightProfile, nightPrompt, nightTimeLimitMs, nightZombieLuck,
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

  it("make the rare zombie likelier the further the night goes", () => {
    expect(nightZombieLuck(1)).toBe(1);
    for (let night = 2; night <= 8; night++) expect(nightZombieLuck(night)).toBeGreaterThan(nightZombieLuck(night - 1));
  });

  it("clamp a night off the wire", () => {
    expect(clampNight(undefined)).toBe(FIRST_NIGHT);
    expect(clampNight("abc")).toBe(FIRST_NIGHT);
    expect(clampNight(-4)).toBe(FIRST_NIGHT);
    expect(clampNight(2.9)).toBe(2);
    expect(clampNight(9999)).toBe(MAX_NIGHT);
  });

  it("open with the line the night is still young", () => {
    expect(nightPrompt(2).title).toBe("The night is still young...");
    expect(nightPrompt(2).body).toContain("Night 2");
    expect(nightPrompt(3).title).not.toBe(nightPrompt(2).title);
    for (let night = 2; night <= 7; night++) expect(nightPrompt(night).body).toContain("keep everything");
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

  it("lets a maxed level-45 army through night 5, but only after a long fight", () => {
    for (const seed of [0, 1]) {
      const flight = fly(5, seed);
      expect(flight.win).toBe(true);
      expect(flight.secs).toBeGreaterThan(120);
      expect(flight.secs).toBeLessThan(NIGHT_TIME_LIMIT_MS / 1000);
    }
  }, 120_000);

  it("runs that army out of time on night 6, without wiping it", () => {
    for (const seed of [0, 1]) {
      const flight = fly(6, seed);
      expect(flight.win).toBe(false);
      expect(flight.timedOut).toBe(true);
      expect(flight.survivors).toBeGreaterThan(0);
    }
  }, 120_000);
});
