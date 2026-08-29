import { describe, expect, it } from "vitest";
import raidsJson from "../../public/assets/raids/raids.json";
import {
  BRAIN_TICKET_KEY,
  DEFAULT_ELITE_PROFILE,
  ELITE_BRAIN_LUCK,
  ELITE_PROFILES,
  eliteBossSpecials,
  eliteBossThrow,
  eliteEnemyStat,
  eliteProfile,
  eliteWallHp,
} from "./eliteInvasion";
import { buildEnemyUnits } from "./CombatEngine";
import type { BossSpecial, BossThrowConfig, EnemyStat, RaidDef, RaidStage } from "./types";

const raids = raidsJson as RaidDef[];

describe("elite profile selection", () => {
  it("is inert for an ordinary invasion", () => {
    expect(eliteProfile(3, false)).toBeNull();
    const stat: EnemyStat = { str: 5, con: 4, dex: 3 };
    expect(eliteEnemyStat(stat, null)).toBe(stat);
    expect(eliteWallHp(1500, null)).toBe(1500);
  });

  it("falls back to the default profile for an unknown raid", () => {
    expect(eliteProfile(999, true)).toBe(DEFAULT_ELITE_PROFILE);
    // …and the fallback is a real step up, so a new invasion can never make a Brain
    // Ticket a 10,000-gold no-op.
    expect(DEFAULT_ELITE_PROFILE.str).toBeGreaterThan(1);
    expect(DEFAULT_ELITE_PROFILE.con).toBeGreaterThan(1);
  });

  it("never scales anything DOWN", () => {
    for (const profile of [...Object.values(ELITE_PROFILES), DEFAULT_ELITE_PROFILE]) {
      for (const value of Object.values(profile)) expect(value).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the Pirates' speed untouched — their mechanic punishes speed, not slowness", () => {
    // The Scallywag mirrors whatever attack cycle it faces, so making pirates FASTER
    // would work against the one rule the raid is built on (see raidTips.ts).
    expect(ELITE_PROFILES[3].dex).toBe(1);
    expect(ELITE_PROFILES[3].throwRate).toBe(1);
    // Their budget goes into raw power instead — the biggest strength step in the table.
    const strongest = Math.max(...Object.values(ELITE_PROFILES).map((p) => p.str));
    expect(ELITE_PROFILES[3].str).toBe(strongest);
  });

  it("gives the Circus the busiest projectiles — its boss is the juggler", () => {
    const profiles = Object.values(ELITE_PROFILES);
    // The juggling act is a RATE, and that is the half of it this raid owns outright.
    expect(ELITE_PROFILES[8].throwRate).toBe(Math.max(...profiles.map((p) => p.throwRate)));
    // Its per-hit multiplier is deliberately NOT the table's largest any more. It used to
    // be (x8), back when `throwDamage` multiplied an authored chip value that did nothing;
    // since the ruleset 34 projectile re-fit it multiplies a throw already fitted to kill
    // the healer it is aimed at, and 8 on top of that deleted the healer outright. The
    // juggling is delivered as MANY LIGHT hits now — which is what juggling looks like.
    expect(ELITE_PROFILES[8].throwDamage)
      .toBeLessThan(Math.max(...profiles.map((p) => p.throwDamage)));
    // What it keeps is the top of the projectile band overall: rate x damage — the whole
    // step an elite Circus buys over its ordinary fight — sits with the seasonal raids at
    // the 4x cap. Raid 6 is excluded because it has no throw table at all, so its two throw
    // fields are inert and are left alone rather than scaled for the look of the table.
    const step = (id: number) => ELITE_PROFILES[id].throwDamage * ELITE_PROFILES[id].throwRate;
    const throwing = Object.keys(ELITE_PROFILES).map(Number).filter((id) => id !== 6);
    expect(step(8)).toBeGreaterThan(3.9);
    expect(step(8)).toBeGreaterThanOrEqual(Math.max(...throwing.map(step)) - 0.05);
  });

  it("only raises the wall on the two raids that summon one", () => {
    // Ninja carrotWall + Robot junkWall. Everywhere else the multiplier is dead weight,
    // and leaving it at 1 keeps that obvious in the table.
    for (const [id, profile] of Object.entries(ELITE_PROFILES)) {
      if (id === "4" || id === "5") expect(profile.wallHp, id).toBeGreaterThan(1);
      else expect(profile.wallHp, id).toBe(1);
    }
  });

  it("keeps enemy cadence readable", () => {
    // Past roughly 1.6x an enemy stops reading as an enemy. The Lawyers are the fastest
    // in the table because speed IS their mechanic, and even they stay under 2x.
    for (const [id, profile] of Object.entries(ELITE_PROFILES)) {
      expect(profile.dex, id).toBeLessThan(2);
    }
    expect(ELITE_PROFILES[2].dex).toBe(
      Math.max(...Object.values(ELITE_PROFILES).map((p) => p.dex))
    );
  });
});

describe("elite scaling", () => {
  const profile = ELITE_PROFILES[1];

  it("multiplies str/con/dex and leaves the raid's own data alone", () => {
    const stat: EnemyStat = {
      str: 2, con: 3, dex: 1.5, focus: 40,
      attacks: [{ frequency: 100, name: "punch" }],
      standardGoldLoot: true,
    };
    const scaled = eliteEnemyStat(stat, profile);
    expect(scaled.str).toBeCloseTo(2 * profile.str, 10);
    expect(scaled.con).toBeCloseTo(3 * profile.con, 10);
    expect(scaled.dex).toBeCloseTo(1.5 * profile.dex, 10);
    expect(scaled.focus).toBe(40);
    expect(scaled.attacks).toEqual(stat.attacks);
    expect(scaled.standardGoldLoot).toBe(true);
  });

  it("turns a throw RATE into a shorter interval, not a longer one", () => {
    const config: BossThrowConfig = {
      intervalMs: 2000,
      options: [{ damage: 10, weight: 1, sprite: "x.png", spriteSize: 32 }],
    };
    const scaled = eliteBossThrow(config, ELITE_PROFILES[8])!;
    expect(scaled.intervalMs).toBeCloseTo(2000 / ELITE_PROFILES[8].throwRate, 10);
    expect(scaled.intervalMs).toBeLessThan(config.intervalMs);
    expect(scaled.options[0].damage).toBeCloseTo(10 * ELITE_PROFILES[8].throwDamage, 10);
    // The source config must not be mutated: the verifier builds a fresh sim from one
    // pinned object every time, so an in-place edit would make the replay stateful.
    expect(config.intervalMs).toBe(2000);
    expect(config.options[0].damage).toBe(10);
  });

  it("scales special damage but not its cast or cooldown", () => {
    const specials: BossSpecial[] = [{ name: "alienLaser", weight: 5, castMs: 900, cooldownMs: 1500, damage: 40 }];
    const scaled = eliteBossSpecials(specials, ELITE_PROFILES[6]);
    expect(scaled[0].damage).toBeCloseTo(40 * ELITE_PROFILES[6].specialDamage, 10);
    // Cast time is the player's window to react; shrinking it makes the fight
    // unreadable rather than harder.
    expect(scaled[0].castMs).toBe(900);
    expect(scaled[0].cooldownMs).toBe(1500);
    expect(specials[0].damage).toBe(40);
  });

  it("carries into the combat units the fight actually runs on", () => {
    const stage: RaidStage = { enemyKeys: ["A"], bossKey: "B" };
    const stats: Record<string, EnemyStat> = {
      A: { str: 2, con: 3, dex: 1 },
      B: { str: 4, con: 10, dex: 2 },
    };
    const plain = buildEnemyUnits(stage, stats, {}, { raidId: 3, playerLevel: 30 });
    const elite = buildEnemyUnits(stage, stats, {}, {
      raidId: 3, playerLevel: 30, elite: ELITE_PROFILES[3],
    });
    for (let i = 0; i < plain.length; i++) {
      expect(elite[i].maxHp).toBeGreaterThan(plain[i].maxHp);
      expect(elite[i].str).toBeGreaterThan(plain[i].str);
      // Pirates keep their cadence exactly — dex is 1x for them.
      expect(elite[i].attackCooldownMs).toBeCloseTo(plain[i].attackCooldownMs, 10);
    }
  });
});

describe("brain ticket wiring", () => {
  it("names the boost key the catalogs use", () => {
    expect(BRAIN_TICKET_KEY).toBe("brain_ticket");
  });

  it("quadruples the odds it exists to buy", () => {
    expect(ELITE_BRAIN_LUCK).toBe(4);
  });

  it("has a profile for every playable invasion, and none for anything else", () => {
    const playable = raids.filter((r) => r.playable).map((r) => r.id).sort((a, b) => a - b);
    expect(Object.keys(ELITE_PROFILES).map(Number).sort((a, b) => a - b)).toEqual(playable);
  });
});

describe("elite recommended level", () => {
  // raids.json `eliteRecommendedLevel` is display-only advice (hud.ts raid cards), but it
  // is advice about THIS table, so it has to keep step with it.
  it("advises a level above the ordinary fight on every playable invasion", () => {
    for (const raid of raids.filter((r) => r.playable)) {
      expect(raid.eliteRecommendedLevel).toBeGreaterThan(raid.recommendedLevel);
    }
  });

  it("climbs with the elite RAMP the profiles are fitted to", () => {
    // The five late invasions are fitted to a smooth climb in ladder order (see the
    // eliteInvasion.ts header). A profile re-fit that reorders them and leaves the advice
    // behind would tell a player the Aliens are a gentler Brain Ticket than the Robots.
    const ramp = [3, 4, 5, 6, 9].map((id) => raids.find((r) => r.id === id)!.eliteRecommendedLevel);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThan(ramp[i - 1]);
  });
});
