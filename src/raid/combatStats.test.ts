import { describe, it, expect } from "vitest";
import {
  finalPower,
  finalAttackInterval,
  finalDamageReduction,
  finalHitPoints,
  applyDamage,
  veterancyScale,
  pickByFrequency,
  VET_RANK_STEP,
  levelScaleT,
  levelScaleStat,
  LEVEL_SCALE_ENDPOINTS,
  deriveMaxHp,
  deriveAttackIntervalMs,
  deriveHitDamage,
  lineupDamageBand,
  LINEUP_DAMAGE_BANDS,
  lineupSpeedBand,
  LINEUP_SPEED_BANDS,
  mirroredAttackIntervalSec,
  mirrorIntervalSec,
  pirateBossSlamIntervalSec,
  MIRROR_FLOOR_SEC,
  SCALLYWAG_MIRROR_DIVISOR,
  SCALLYWAG_KEY,
  PIRATE_BOSS_KEY,
  PIRATE_BOSS_MIRROR_DIVISOR,
  PIRATE_BOSS_MIN_SLAM_SEC,
  PIRATE_BOSS_HEADLESS_SLAM_SEC,
  HEADLESS_SPECIES_CYCLE_SEC,
  farmRaidEnemyPace,
  ALIEN_LASER_DAMAGE,
  laserHitDamage,
  LASER_DAMAGE_PER_STR,
  BURN_MAX_HP_FRACTION_PER_SEC,
  POWER_PER_STR,
  HP_PER_CON,
} from "./combatStats";
import { PIXEL_FIRE_BURN_MS } from "./videoGameStage";

// Ground truth: Actor calculateFinal* / Actor damage: / rollAgainstFrequencyInArray:
// (docs/mechanics/COMBAT_STATS_RECOVERED.md). Each `final*` folds a passive + a
// temporary modifier channel onto a base stat with the binary's exact caps.

describe("finalPower — power × max(0, 1 + passive + temporary)", () => {
  it("is the base when unmodified", () => expect(finalPower(100)).toBe(100));
  it("adds passive + temporary as a multiplier", () =>
    expect(finalPower(100, 0.2, 0.3)).toBeCloseTo(150));
  it("floors the multiplier at 0 (combined ≤ −1 zeroes output)", () => {
    expect(finalPower(100, -1.5)).toBe(0);
    expect(finalPower(100, -0.7, -0.7)).toBe(0);
  });
});

describe("finalAttackInterval — interval × (1 − change)", () => {
  it("is the base when unmodified", () => expect(finalAttackInterval(1000)).toBe(1000));
  it("a positive change shortens the interval (faster)", () =>
    expect(finalAttackInterval(1000, 0.3)).toBeCloseTo(700));
  it("caps the passive contribution at +0.5", () =>
    expect(finalAttackInterval(1000, 0.9)).toBeCloseTo(500)); // min(.9,.5)=.5
  it("floors the combined change at −0.5 (multiplier ≤ 1.5)", () =>
    expect(finalAttackInterval(1000, -0.9)).toBeCloseTo(1500));
  it("passive is capped BEFORE temporary is added", () =>
    // min(0.9,0.5)=0.5, +0.2 temp = 0.7 change -> 1000*0.3
    expect(finalAttackInterval(1000, 0.9, 0.2)).toBeCloseTo(300));
});

describe("finalDamageReduction — clamp(passive, ±0.5) + temporary", () => {
  it("passes small passive DR through", () => expect(finalDamageReduction(0.3)).toBeCloseTo(0.3));
  it("caps passive DR at +0.5", () => expect(finalDamageReduction(0.9)).toBeCloseTo(0.5));
  it("floors passive DR at −0.5", () => expect(finalDamageReduction(-0.9)).toBeCloseTo(-0.5));
  it("stacks temporary DR uncapped on top", () =>
    expect(finalDamageReduction(0.5, 0.2)).toBeCloseTo(0.7));
});

describe("finalHitPoints — max(1, hp × (1 + change))", () => {
  it("is the base when unmodified", () => expect(finalHitPoints(250)).toBe(250));
  it("scales by the change", () => expect(finalHitPoints(250, 0.1)).toBeCloseTo(275));
  it("never drops below 1", () => expect(finalHitPoints(250, -5)).toBe(1));
});

describe("applyDamage — max(0, incoming − armor) × (1 − DR)", () => {
  it("passes plain damage through", () => expect(applyDamage(100)).toBe(100));
  it("subtracts flat armor first", () => expect(applyDamage(100, 30)).toBe(70));
  it("applies % reduction after armor", () => expect(applyDamage(100, 20, 0.5)).toBe(40));
  it("armor ≥ incoming fully blocks", () => expect(applyDamage(50, 80)).toBe(0));
  it("cannot go negative", () => expect(applyDamage(10, 0, 2)).toBeLessThanOrEqual(0));
});

describe("veterancyScale — +5% per survived-invasion rank", () => {
  it("uses the 0.05 coefficient literal from the binary", () => expect(VET_RANK_STEP).toBe(0.05));
  it("rank 0 is 1.0", () => expect(veterancyScale(0)).toBe(1));
  it("rank 5 (Master) is 1.25", () => expect(veterancyScale(5)).toBeCloseTo(1.25));
  it("clamps negative ranks to 0", () => expect(veterancyScale(-3)).toBe(1));
});

describe("levelScaleT — 0 at level ≤8, 1 at level ≥25", () => {
  it("is 0 at or below level 8", () => {
    expect(levelScaleT(8)).toBe(0);
    expect(levelScaleT(1)).toBe(0);
  });
  it("is 1 at or above level 25", () => {
    expect(levelScaleT(25)).toBe(1);
    expect(levelScaleT(60)).toBe(1);
  });
  it("is 0.5 at the midpoint (level 16.5)", () => expect(levelScaleT(16.5)).toBeCloseTo(0.5));
});

describe("levelScaleStat — lerp(endpoint, base, t) for str/con/dex", () => {
  it("returns the group floor at level ≤8", () => {
    expect(levelScaleStat("Headless", "con", 29.7, 8)).toBeCloseTo(11.0); // Headless con floor
    expect(levelScaleStat("Large", "str", 23.32, 5)).toBeCloseTo(8.5); // Large str floor
  });
  it("returns the full base stat at level ≥25", () => {
    expect(levelScaleStat("Headless", "con", 29.7, 25)).toBeCloseTo(29.7);
    expect(levelScaleStat("Small", "str", 7.5, 30)).toBeCloseTo(7.5);
  });
  it("interpolates linearly in between", () => {
    // Headless con 11 -> 29.7 at t=0.5 (level 16.5)
    expect(levelScaleStat("Headless", "con", 29.7, 16.5)).toBeCloseTo((11 + 29.7) / 2);
  });
  it("is flat where the dex floor equals the base (the mapping proof)", () => {
    // Large/Headless/Regular/Garden have endpoint dex == base dex, so dex never changes.
    for (const lvl of [1, 8, 15, 25, 40]) {
      expect(levelScaleStat("Large", "dex", 1.3, lvl)).toBeCloseTo(1.3);
      expect(levelScaleStat("Headless", "dex", 1.0, lvl)).toBeCloseTo(1.0);
      expect(levelScaleStat("Regular", "dex", 2.0, lvl)).toBeCloseTo(2.0);
    }
  });
  it("can shrink a stat when the floor exceeds the base (Regular str 5→2)", () => {
    expect(levelScaleStat("Regular", "str", 2.0, 8)).toBeCloseTo(5.0); // floor above base
    expect(levelScaleStat("Regular", "str", 2.0, 25)).toBeCloseTo(2.0);
  });
  it("falls back to default endpoints for an unknown group", () => {
    // default {str:5, con:5, dex:2}
    expect(levelScaleStat("Nonsense", "str", 100, 8)).toBeCloseTo(5.0);
    expect(levelScaleStat("Nonsense", "dex", 100, 8)).toBeCloseTo(2.0);
  });
  it("exposes the transcribed endpoint table", () => {
    expect(LEVEL_SCALE_ENDPOINTS.Headless).toEqual({ str: 3.0, con: 11.0, dex: 1.0 });
    expect(LEVEL_SCALE_ENDPOINTS.Large).toEqual({ str: 8.5, con: 6.5, dex: 1.3 });
    expect(LEVEL_SCALE_ENDPOINTS.Small).toEqual({ str: 3.125, con: 2.75, dex: 4.0 });
  });
});

describe("stat -> fight-data conversion (initFightDataAfterLoad)", () => {
  it("hitPointsTotal = con × 100", () => {
    expect(HP_PER_CON).toBe(100);
    expect(deriveMaxHp(2)).toBe(200); // basic zombie con 2 -> 200 HP
    expect(deriveMaxHp(0)).toBe(1); // floored at 1
  });

  it("power = str × 10", () => {
    expect(POWER_PER_STR).toBe(10);
  });

  it("attack interval = C/dex sec — enemies (C=1) attack twice as fast as zombies (C=2)", () => {
    expect(deriveAttackIntervalMs(2, "player")).toBeCloseTo(1000); // 2.0/2 s
    expect(deriveAttackIntervalMs(2, "enemy")).toBeCloseTo(500); // 1.0/2 s
    // same dex → enemy interval is exactly half the zombie's
    expect(deriveAttackIntervalMs(5, "enemy")).toBeCloseTo(deriveAttackIntervalMs(5, "player") / 2);
  });

  it("guards dex=0 against an infinite interval", () => {
    expect(Number.isFinite(deriveAttackIntervalMs(0, "player"))).toBe(true);
  });

  it("per-swing base damage = finalPower × attackMult (no flat scalar; band applied later)", () => {
    // basic zombie: power = str2×10 = 20; ZombieBite mult 1 -> 20 × 1 = 20
    expect(deriveHitDamage(20, 1)).toBeCloseTo(20);
    // a 2× attack multiplier doubles it
    expect(deriveHitDamage(20, 2)).toBeCloseTo(40);
    // default multiplier is 1 (matches the binary's damageMultiplier default for mult-less attacks)
    expect(deriveHitDamage(20)).toBeCloseTo(20);
  });
});

describe("lineupDamageBand — player-zombie depth falloff (Actor damageIn: ground truth)", () => {
  it("front band of five is full damage (1.0)", () => {
    expect(LINEUP_DAMAGE_BANDS[0]).toBe(1);
    for (let i = 0; i < 5; i++) expect(lineupDamageBand(i)).toBe(1);
  });
  it("falls off in groups of five: 0.85 / 0.7 / 0.55", () => {
    expect(lineupDamageBand(5)).toBe(0.85);
    expect(lineupDamageBand(9)).toBe(0.85);
    expect(lineupDamageBand(10)).toBe(0.7);
    expect(lineupDamageBand(14)).toBe(0.7);
    expect(lineupDamageBand(15)).toBe(0.55);
    expect(lineupDamageBand(999)).toBe(0.55); // clamps to the rearmost band
  });
  it("bypass (special-attack states) and invalid index → full 1.0", () => {
    expect(lineupDamageBand(12, true)).toBe(1); // Bash/Explode ignore depth
    expect(lineupDamageBand(-1)).toBe(1);
  });
});

describe("pickByFrequency — cumulative arc4random_uniform(Σfreq)", () => {
  const E = [
    { name: "a", frequency: 10 },
    { name: "b", frequency: 30 },
    { name: "c", frequency: 60 },
  ];
  it("selects by cumulative weight, not index", () => {
    expect(pickByFrequency(E, () => 0.05)!.name).toBe("a"); // 5 < 10
    expect(pickByFrequency(E, () => 0.3)!.name).toBe("b"); // 30 in (10,40]
    expect(pickByFrequency(E, () => 0.99)!.name).toBe("c"); // 99 in (40,100]
  });
  it("returns null for an empty or all-zero-weight list", () => {
    expect(pickByFrequency([], () => 0.5)).toBeNull();
    expect(pickByFrequency([{ frequency: 0 }], () => 0.5)).toBeNull();
  });
  it("treats frequency as a weight (a 90-weight entry dominates)", () => {
    const skew = [
      { name: "rare", frequency: 10 },
      { name: "common", frequency: 90 },
    ];
    let common = 0;
    for (let i = 0; i < 100; i++) {
      if (pickByFrequency(skew, () => (i + 0.5) / 100)!.name === "common") common++;
    }
    expect(common).toBe(90); // exactly the 90% weight band
  });
});

// ---------------------------------------------------------------------------
// Attack cadence — ground truth `-[Actor getFightAttackSpeed]` + the two
// startAnim:interrupt: overrides that schedule doneAttacking: at that interval.
// These pin the rules that retired the old ENEMY_ATTACK_PACE=2 fudge.

describe("lineupSpeedBand — player-zombie depth SLOWDOWN (getFightAttackSpeed)", () => {
  it("front band of five keeps the raw clock", () => {
    expect(LINEUP_SPEED_BANDS[0]).toBe(1);
    for (let i = 0; i < 5; i++) expect(lineupSpeedBand(i)).toBe(1);
  });
  it("stretches the interval in groups of five: ×1.425 / ×2 / ×4", () => {
    expect(lineupSpeedBand(5)).toBe(1.425);
    expect(lineupSpeedBand(9)).toBe(1.425);
    expect(lineupSpeedBand(10)).toBe(2);
    expect(lineupSpeedBand(15)).toBe(4);
    expect(lineupSpeedBand(999)).toBe(4); // clamps to the rearmost band
  });
  it("bypass (special-attack states) and invalid index → raw clock", () => {
    expect(lineupSpeedBand(12, true)).toBe(1);
    expect(lineupSpeedBand(-1)).toBe(1);
  });
  it("is the cadence twin of the damage band — same grouping, opposite direction", () => {
    expect(LINEUP_SPEED_BANDS).toHaveLength(LINEUP_DAMAGE_BANDS.length);
    // a rear zombie hits softer AND slower
    expect(lineupDamageBand(15)).toBeLessThan(1);
    expect(lineupSpeedBand(15)).toBeGreaterThan(1);
  });
});

describe("mirroredAttackIntervalSec — the Pirate Scallywag override", () => {
  it("mirrors the opponent's cycle as opp² / 0.8", () => {
    expect(mirroredAttackIntervalSec(2)).toBeCloseTo(5); // vs a dex-1 zombie (2 s)
    expect(mirroredAttackIntervalSec(1)).toBeCloseTo(1.25); // vs a dex-2 zombie (1 s)
  });
  it("floors at 0.5 s against very fast zombies", () => {
    expect(mirroredAttackIntervalSec(2 / 3)).toBeCloseTo(0.5556); // dex 3 → above the floor
    expect(mirroredAttackIntervalSec(0.4)).toBe(0.5); // dex 5 → clamped
    expect(mirroredAttackIntervalSec(0)).toBe(0.5);
  });
  it("keeps the recovered 0.8 for anyone who is not the boss", () => {
    expect(SCALLYWAG_MIRROR_DIVISOR).toBe(0.8);
    // The dispatcher reads the EFFECTIVE cycle for everyone but Arrrnold, and ignores
    // the species cycle handed to it entirely.
    for (const key of [SCALLYWAG_KEY, "PirateStageActorSwashbuckler"]) {
      expect(mirrorIntervalSec(key, 1.6, 2.0)).toBeCloseTo(3.2);
      expect(mirrorIntervalSec(key, 1, 99)).toBeCloseTo(1.25);
      expect(mirrorIntervalSec(key, 0.4, 99)).toBe(MIRROR_FLOOR_SEC);
    }
  });
});

describe("Arrrnold's slam is priced on the SPECIES in front of him (v44)", () => {
  // Catalog dex per body, so 2 s / dex is the species cycle:
  //   Headless & Bombie 1 · Large 1.3 · Regular 2 · Female 3.5 · Small 4
  const SPECIES: [string, number, number][] = [
    ["Headless / Bombie", 1, 6.5],
    ["Large", 1.3, 3.845],
    ["Regular", 2, 1.625],
    ["Female", 3.5, 1.25], // floored
    ["Small", 4, 1.25], // floored
  ];

  it("holds a Headless-led line to one slam every 6.5 s", () => {
    expect(HEADLESS_SPECIES_CYCLE_SEC).toBe(2);
    expect(PIRATE_BOSS_HEADLESS_SLAM_SEC).toBe(6.5);
    expect(pirateBossSlamIntervalSec(HEADLESS_SPECIES_CYCLE_SEC)).toBeCloseTo(6.5);
  });

  it("prices every body in the catalog off its base dex", () => {
    for (const [what, dex, expected] of SPECIES) {
      expect(pirateBossSlamIntervalSec(2 / dex), what).toBeCloseTo(expected, 2);
    }
  });

  it("never slams faster than 1.25 s, however fast the species", () => {
    expect(PIRATE_BOSS_MIN_SLAM_SEC).toBe(1.25);
    for (const dex of [3.5, 4, 8, 20]) {
      expect(pirateBossSlamIntervalSec(2 / dex)).toBe(PIRATE_BOSS_MIN_SLAM_SEC);
    }
    // The floor bites from a 0.877 s species cycle (base dex 2.28) down.
    expect(pirateBossSlamIntervalSec(0.878)).toBeGreaterThan(PIRATE_BOSS_MIN_SLAM_SEC);
    expect(pirateBossSlamIntervalSec(0.876)).toBe(PIRATE_BOSS_MIN_SLAM_SEC);
  });

  it("is deaf to everything except the body — rank, mutations, buffs, depth", () => {
    // Same Headless species cycle, wildly different CURRENT cycles: one answer.
    for (const effective of [0.2, 0.8, 1.6, 2, 8]) {
      expect(mirrorIntervalSec(PIRATE_BOSS_KEY, effective, 2)).toBeCloseTo(6.5);
    }
    // …and a Scallywag standing next to him in the same fight reads exactly those
    // effective cycles instead, which is what keeps the raid's "too fast" rule alive.
    expect(mirrorIntervalSec(SCALLYWAG_KEY, 0.8, 2)).toBeCloseTo(0.8);
    expect(mirrorIntervalSec(SCALLYWAG_KEY, 2, 2)).toBeCloseTo(5);
  });

  it("still rewards a slower body, monotonically, above the floor", () => {
    let prev = 0;
    for (const cycle of [0.9, 1, 1.538, 2]) {
      const v = pirateBossSlamIntervalSec(cycle);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("derives the divisor from the tuning point, so the two cannot drift apart", () => {
    expect(PIRATE_BOSS_MIRROR_DIVISOR)
      .toBeCloseTo((HEADLESS_SPECIES_CYCLE_SEC ** 2) / PIRATE_BOSS_HEADLESS_SLAM_SEC);
    expect(mirrorIntervalSec(PIRATE_BOSS_KEY, 99, 2)).toBeCloseTo(PIRATE_BOSS_HEADLESS_SLAM_SEC);
  });
});

describe("farmRaidEnemyPace — Old McDonnell's level ramp (raid 1 only)", () => {
  it("speeds the farm's enemies up as the player out-levels it", () => {
    expect(farmRaidEnemyPace(1, 9)).toBe(1);
    expect(farmRaidEnemyPace(1, 10)).toBe(0.66);
    expect(farmRaidEnemyPace(1, 14)).toBe(0.66);
    expect(farmRaidEnemyPace(1, 15)).toBe(0.44);
    expect(farmRaidEnemyPace(1, 60)).toBe(0.44);
  });
  it("leaves every other raid (and an unknown level) alone", () => {
    expect(farmRaidEnemyPace(2, 40)).toBe(1);
    expect(farmRaidEnemyPace(9, 50)).toBe(1);
    expect(farmRaidEnemyPace(1, undefined)).toBe(1);
    expect(farmRaidEnemyPace(undefined, 40)).toBe(1);
  });
});

describe("recovered flat hazard values", () => {
  it("the alien laser bolt is a hard 200", () => expect(ALIEN_LASER_DAMAGE).toBe(200));
  it("burning costs 5% of MAX hp per second", () => {
    // The RATE is ground truth (`damage: hitPointsTotal/20 × dt`) and is the half of
    // pixelFire we did not change. What we changed is how long it lasts: the shipped game
    // exits the burning state after a single frame, and we burn for PIXEL_FIRE_BURN_MS.
    // The two numbers multiply, so this one moving would quietly re-scale the whole effect.
    expect(BURN_MAX_HP_FRACTION_PER_SEC).toBe(0.05);
  });
  it("a full untapped burn is a real but survivable bite out of a zombie", () => {
    // The deliberate divergence, pinned as a number rather than left implicit. It has to
    // stay heavy enough to be worth reacting to and light enough that a healthy zombie
    // lives through one it never noticed — see raid/videoGameStage.ts.
    const share = BURN_MAX_HP_FRACTION_PER_SEC * (PIXEL_FIRE_BURN_MS / 1000);
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.5);
  });
});

describe("the walking laser is priced in strength alone", () => {
  // The one divergence: ground truth pays 10 % of Power (= exactly the firer's strength),
  // the reimpl pays 20 %. Both anchors are pinned so a change to either has to be deliberate.
  it("pays 2 damage per point of strength, i.e. 20 % of Power", () => {
    expect(LASER_DAMAGE_PER_STR).toBe(2);
    for (const str of [2.1, 5.25, 8.4, 12.6, 23.32, 42]) {
      expect(laserHitDamage(str * POWER_PER_STR)).toBe(Math.round(str * 2));
    }
  });

  it("is twice the binary's rate, rounded once at the end", () => {
    // The binary pays `round(power x 0.10)`; this pays `round(power x 0.20)`. Rounding ONCE
    // on the doubled rate is the point of stating it this way: doubling the binary's already-
    // rounded bolt would quantise every half-strength zombie down (str 5.25 -> 10, not 11).
    for (const str of [2.1, 5.25, 8.4, 12.6, 23.32, 42]) {
      const power = str * POWER_PER_STR;
      expect(laserHitDamage(power)).toBe(Math.max(1, Math.round(power * 0.20)));
    }
  });

  it("never drops a bolt to zero, however feeble the firer", () => {
    expect(laserHitDamage(0)).toBe(1);
    expect(laserHitDamage(0.1)).toBe(1);
  });
});
