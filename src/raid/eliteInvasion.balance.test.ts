// Balance regression for elite (Brain Ticket) invasions.
//
// The profiles in eliteInvasion.ts are numbers with no local meaning — 5.3x strength is
// only "right" relative to what the fight then plays like. So this test does not assert
// the multipliers; it runs the REAL BattleSim, headlessly, against a fixed synthetic
// army and asserts the properties the tuning exists to produce:
//
//   1. every elite invasion is meaningfully harder than its normal self,
//   2. the ladder the profiles were fitted to (Lawyers-elite ~ Robots-normal, and so on)
//      still holds — plus a durability floor for Old McDonnell's, which is deliberately
//      off its rung,
//   3. the three hardest invasions land in one band on a Brain Ticket, and
//   4. no elite fight runs anywhere near the four-minute replay cap, which is the one
//      failure that would make a won invasion impossible to settle.
//
// The army is deliberately crude — the six best catalog zombies, repeated, at a stat
// multiplier standing in for mutations and monoliths. It is a MEASURING STICK, not a
// model of a real roster: what matters is that the same stick measures every raid.
import { describe, expect, it } from "vitest";
import raidsJson from "../../public/assets/raids/raids.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { BattleSim } from "./BattleSim";
import { buildEnemyUnits, buildPlayerUnits } from "./CombatEngine";
import { fightStage, resolveStageWave, seededRandom } from "./RaidCatalog";
import { eliteBossSpecials, eliteBossThrow, eliteProfile, ELITE_PROFILES } from "./eliteInvasion";
import { RAID_MAX_TICKS, RAID_TICK_MS } from "./replay";
import { waveCadenceFor } from "./alienStage";
import {
  bossSpecialsFor, bossThrowFor, summonFor, turnedTemplateFor, wallTemplateFor,
} from "./fightConfig";
import { makeOwned } from "../zombie/types";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const raids = raidsJson as RaidDef[];
const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;
const zombieDefs = zombiesJson as Array<Record<string, unknown>>;

/** Measuring-stick army: the six strongest catalog zombies, repeated to `size`, with
 *  every stat multiplied by `power` (mutations, monoliths, farmer heads — all the
 *  channels this test does not model individually). */
function stickArmy(size: number, power: number): CombatUnit[] {
  const pool = zombieDefs
    .filter((z) => z.category !== "special")
    .sort((a, b) => ((b.str as number) + (b.con as number)) - ((a.str as number) + (a.con as number)))
    .slice(0, 6)
    .map((z) => ({ ...z, str: (z.str as number) * power, con: (z.con as number) * power }));
  const party = Array.from({ length: size }, (_, i) =>
    makeOwned(`z${i}`, pool[i % pool.length] as Parameters<typeof makeOwned>[1], 0, 0, 5, 0)
  );
  return buildPlayerUnits(party, { concentration: true, abilityUnlocked: () => true, playerLevel: 45 });
}

/** The fight configs the SHIPPED invasion carries, from the same builders RaidManager
 *  uses (raid/fightConfig.ts). This file used to keep its own transcriptions of all four
 *  — which is how a measuring stick ends up measuring something the player never fights. */
const fightAssets = { enemyStats, raidAttacks: attacks };

interface Result { win: boolean; losses: number; secs: number; timedOut: boolean }

function fight(raid: RaidDef, elite: boolean, size: number, power: number, seed = 0): Result {
  const profile = eliteProfile(raid.id, elite);
  const stage = resolveStageWave(fightStage(raid, 45)!, seededRandom(`balance:${raid.id}:${seed}`));
  const enemyUnits = buildEnemyUnits(stage, enemyStats, attacks, {
    raidId: raid.id, playerLevel: 45, elite: profile,
  });
  const sim = new BattleSim(
    stickArmy(size, power),
    enemyUnits,
    eliteBossThrow(bossThrowFor(fightAssets, raid, stage, 99), profile),
    true,
    eliteBossSpecials(bossSpecialsFor(fightAssets, stage), profile),
    undefined,
    summonFor(fightAssets, raid, stage, 45, profile),
    wallTemplateFor(fightAssets, stage, profile),
    false, false, false, undefined, null, null,
    waveCadenceFor(raid.id),
    turnedTemplateFor(fightAssets, raid, stage, 45, profile)
  );
  let ticks = 0;
  while (!sim.finished && ticks < RAID_MAX_TICKS) {
    sim.step(RAID_TICK_MS);
    ticks++;
  }
  const outcome = sim.outcome();
  return {
    win: sim.finished && outcome.win,
    losses: outcome.losses.length,
    secs: (ticks * RAID_TICK_MS) / 1000,
    timedOut: !sim.finished,
  };
}

/** Difficulty as one number: the weakest measuring-stick army (16 zombies) that still
 *  wins. Lower is easier. Averaged over three wave seeds so the Robots' random boss
 *  cannot decide the answer on its own. */
function weakestWinningArmy(raid: RaidDef, elite: boolean): number {
  const perSeed = [0, 1, 2].map((seed) => {
    let lo = 0.05;
    let hi = 6;
    if (!fight(raid, elite, 16, hi, seed).win) return hi;
    for (let i = 0; i < 11; i++) {
      const mid = (lo + hi) / 2;
      if (fight(raid, elite, 16, mid, seed).win) hi = mid;
      else lo = mid;
    }
    return hi;
  });
  return perSeed.reduce((a, b) => a + b, 0) / perSeed.length;
}

/** The power the "maxed roster" measuring stick runs at. It moved 2.2 -> 3.0 when the raid
 *  ruleset went to v23: faithful knockback (a randomised 0.9-2.7 melee-gap SLIDE that costs
 *  the victim a depth band, replacing a flat 150-unit teleport) made the ORDINARY Video
 *  Games invasion ~20% harder, and that raid is built out of knockback enemies. At 2.2 the
 *  stick was consumed by the ordinary fight alone — measured: elite Video Games only stayed
 *  winnable if its profile was flattened to exactly the ordinary wave — so the number was
 *  measuring the stick's own ceiling rather than the tuning. This is a measuring stick, not
 *  a claim about the game's ceiling (see the file header). */
const MAXED_STICK = 3.0;

const byId = (id: number) => raids.find((r) => r.id === id)!;
const ALL = Object.keys(ELITE_PROFILES).map(Number);

describe("elite invasion balance", () => {
  // One shared measurement pass — the binary search is the expensive part.
  const p: Record<number, { normal: number; elite: number }> = {};
  for (const id of ALL) {
    p[id] = { normal: weakestWinningArmy(byId(id), false), elite: weakestWinningArmy(byId(id), true) };
  }

  it("has a profile for every playable invasion", () => {
    const playable = raids.filter((r) => r.playable).map((r) => r.id).sort((a, b) => a - b);
    expect(ALL.sort((a, b) => a - b)).toEqual(playable);
  });

  it("makes every invasion meaningfully harder", () => {
    for (const id of ALL) {
      // A Brain Ticket is never a rounding error.
      expect(p[id].elite / p[id].normal, byId(id).name).toBeGreaterThan(1.15);
    }
    // EVERY invasion gets at least half again as much army demanded of it — the Video
    // Games included, which they were not until ruleset 31. They used to be exempted
    // here, because their ORDINARY fight measured 2.11-2.72 and there was no headroom
    // left to put an elite step into; what a Brain Ticket bought on that raid was the
    // brains, not a different fight. That difficulty turned out to be `turnZombie`
    // deleting a front zombie outright (see BattleSim), and with the conversion in place
    // the raid has room for a real step again. The exemption is gone deliberately: if
    // this line starts failing on raid 9, the question to ask is whether something has
    // put the ordinary fight back up near the ceiling.
    for (const id of ALL) {
      expect(p[id].elite / p[id].normal, byId(id).name).toBeGreaterThan(1.5);
    }
  });

  it("puts each elite invasion on the rung it was tuned to", () => {
    // "X on a Brain Ticket is about as hard as Y normally is." Bands are wide (±35%)
    // because the tuning targets a feel, not a fixed point; they exist to catch a
    // profile drifting a whole rung, not to pin the third decimal.
    const near = (elite: number, normal: number, label: string) => {
      expect(p[elite].elite / p[normal].normal, label).toBeGreaterThan(0.65);
      expect(p[elite].elite / p[normal].normal, label).toBeLessThan(1.35);
    };
    near(2, 5, "Lawyers -> Robots");
    near(8, 5, "Circus -> Robots");
    near(3, 9, "Pirates -> Video Games");
    near(4, 9, "Ninjas -> Video Games");
    for (const id of [7, 10, 11]) {
      // The three rec-8 invasions sit between Pirates and Robots.
      expect(p[id].elite, byId(id).name).toBeGreaterThan(p[3].normal * 0.8);
      expect(p[id].elite, byId(id).name).toBeLessThan(p[5].normal * 1.35);
    }
  });

  it("climbs the late elite invasions as a ramp, topping out on the Video Games", () => {
    // The five late invasions are a RAMP, not a band (see eliteInvasion.ts): each one's
    // elite fight is a step harder than the one unlocked before it, so a player working
    // up the ladder meets a Brain Ticket fight that keeps getting harder, and the last
    // invasion they unlock is the hardest elite fight in the game.
    //
    // This replaces a "three hardest share one band" assertion. That band existed only
    // because the Video Games' ordinary fight was a cliff (the `turnZombie` instant kill)
    // with no headroom above it to ramp into; there is headroom now.
    const RAMP = [3, 4, 5, 6, 9]; // Pirates → Ninjas → Robots → Aliens → Video Games
    const rungs = RAMP.map((id) => p[id].elite);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i], `${byId(RAMP[i]).name} above ${byId(RAMP[i - 1]).name}`)
        .toBeGreaterThan(rungs[i - 1]);
    }
    // …and a SMOOTH climb, not a flat run with one cliff in it: no single step may be
    // more than half the whole ramp's rise. This is the assertion that would have caught
    // the old shape, where four raids sat together and the fifth was miles above.
    const rise = rungs[rungs.length - 1] - rungs[0];
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i] - rungs[i - 1], `step ${RAMP[i - 1]}→${RAMP[i]}`).toBeLessThan(rise * 0.5);
    }
    // The top of the ramp is a real step past the hardest ORDINARY invasion, which is the
    // same raid: a Brain Ticket there has to change the fight, not just the drops.
    expect(rungs[rungs.length - 1]).toBeGreaterThan(p[9].normal * 1.3);
  });

  it("gives Old McDonnell's elite wave the bulk of an ordinary Pirates invasion", () => {
    // This raid is not held to a p* rung (see eliteInvasion.ts): p* only asks "can you
    // win", and a maxed army beats his wave either way, so it could not tell a
    // tutorial-with-bigger-numbers apart from a real fight. DURABILITY is what was
    // actually wrong and what was actually asked for, so durability is what is pinned —
    // stated against the Pirates rather than as bare numbers, because "as bulky as the
    // Pirates" is the intent and 40,000/12,000 is merely how it happens to arithmetic.
    const wave = (raidId: number, elite: boolean) => {
      const raid = byId(raidId);
      const stage = resolveStageWave(fightStage(raid, 45)!, seededRandom(`balance:${raidId}:0`));
      const units = buildEnemyUnits(stage, enemyStats, attacks, {
        raidId, playerLevel: 45, elite: eliteProfile(raidId, elite),
      });
      return {
        total: units.reduce((sum, unit) => sum + unit.maxHp, 0),
        boss: units.find((unit) => unit.isBoss)?.maxHp ?? 0,
      };
    };
    const plain = wave(1, false);
    const elite = wave(1, true);
    const pirates = wave(3, false);

    // Both halves of the wave, because one multiplier cannot place both (see `bossCon`)
    // and the boss is the part a player actually feels grinding down.
    expect(elite.total).toBeGreaterThanOrEqual(pirates.total);
    expect(elite.boss).toBeGreaterThanOrEqual(pirates.boss);
    // A step change, not a nudge: the ordinary wave is under a tenth of it.
    expect(elite.total).toBeGreaterThan(plain.total * 7);
    // …and still the gentlest elite on the ladder — it is the tutorial raid.
    expect(p[1].elite).toBeLessThan(p[3].elite * 0.75);
  });

  it("keeps a winning elite fight well inside the round", () => {
    // BattleSim hard-stops at four minutes (MAX_SIM_MS, and the same wall as
    // RAID_MAX_TICKS), scoring whatever is standing — so a profile that buys its
    // difficulty in enemy HP does not make the fight harder so much as longer, and at
    // the limit turns a win into a four-minute stalemate scored as a loss. Measured on
    // the army that wins, since that is the run a player is meant to have.
    const capSecs = (RAID_MAX_TICKS * RAID_TICK_MS) / 1000;
    for (const id of ALL) {
      const result = fight(byId(id), true, 20, 2.2);
      expect(result.secs, byId(id).name).toBeLessThan(capSecs * 0.75);
    }
  });

  it("stays winnable by a maxed roster", () => {
    for (const id of ALL) {
      expect(fight(byId(id), true, 20, MAXED_STICK).win, byId(id).name).toBe(true);
    }
  });
});
