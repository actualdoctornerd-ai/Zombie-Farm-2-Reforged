// The Lawyer boss's RULINGS (raid 12). See docs/POST_45_PROGRESSION.md Part 2B and
// dualInvasion.ts.
//
// What these pin is the MECHANIC and the LADDER, not the numbers: that the fight asks a
// question rather than announcing an answer, that the two bubbles never punish the same
// build, that the player's tap decides which comes into force, that each ruling does the
// one thing it names, that ignoring the question costs something (a coin; both bubbles
// under contempt), that precedent keeps two in force, and that the whole thing ends when
// the lawyer climbs down.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  autoPickFor, CONTEMPT_TIER, FARMER_MOB_TIER, FARMER_SQUAD_MINIONS, MIDPOINT_WAVE_FRAC,
  PAIRED_SIGN_TIER, PRECEDENT_TIER, RULING_POOL, RULING_SLOW, RULING_WEAKEN, rulingKey, rulingTag,
  SEVERE_TIER, SIGN_BOTH, SIGN_DWELL_MS, SIGN_GROUPS, SIGN_MAX_SLOTS, SIGN_RAID_ID, signFor,
  type Ruling,
} from "./dualInvasion";
import { farmerSquadFor } from "./fightConfig";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 10, dex: 2, con: 10, focus: 100, hp: 1000, maxHp: 1000,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const SEED = "sign-test";
const NO_ENRAGE_MS = 10 * 60 * 1000;

/** A fight with one zombie of each named class and a perched lawyer handing down rulings.
 *  The enemies are PUNCHBAGS (huge HP, str 0) so these tests are about what the rulings do
 *  and never about whether somebody died. */
function signedFight(groups: string[], tier = 1, extraEnemies: CombatUnit[] = [], seed = SEED) {
  const players = groups.map((group, i) => unit({
    id: `z${i}`, name: group, group,
    isGarden: group === "Garden", isHeadless: group === "Headless",
  }));
  const enemies = [
    unit({ id: "minion", sourceKey: "CityStageActorLawyer", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
    unit({ id: "boss", sourceKey: "CityStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
    ...extraEnemies,
  ];
  return new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, undefined, null, signFor(SIGN_RAID_ID, tier, seed)
  );
}

const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };

/** Advance to the end of the offer on the table, so whatever was picked is now in force. */
function resolveOffer(sim: BattleSim): void {
  const index = sim.signOfferIndex();
  for (let i = 0; i < 400 && sim.signOfferIndex() === index; i++) sim.step(50);
}

/** Take the next offer with a bubble that does (or does not) contain a ruling matching
 *  `match`, pick it, and advance until it is in force. */
function choose(sim: BattleSim, match: (r: Ruling) => boolean, want = true): void {
  for (let guard = 0; guard < 2_000; guard++) {
    const offer = sim.signOffer();
    const index = sim.signOfferIndex();
    if (offer && index !== null && sim.signPick() === null) {
      const option = offer.findIndex((bubble) => bubble.some(match) === want);
      if (option >= 0 && sim.pickSign(index, option)) {
        resolveOffer(sim);
        return;
      }
    }
    sim.step(50);
  }
  throw new Error("never got the chance");
}
const kind = (k: string) => (r: Ruling) => r.kind === k;
const barredGroup = (g: string) => (r: Ruling) => r.kind === "barred" && r.group === g;

describe("the offer", () => {
  it("only exists on the invasion that has it", () => {
    for (const other of [1, 2, 9, 13, 14, 15]) expect(signFor(other, 1, SEED)).toBeNull();
  });

  it("draws from a small pool of icon-sized rulings", () => {
    const kinds = new Set(RULING_POOL.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(
      ["barred", "emboldened", "immunity", "orderInCourt", "overruled", "slowed", "weakened"]);
    expect(RULING_POOL.filter((r) => r.kind === "barred").map((r) => r.group).sort())
      .toEqual([...SIGN_GROUPS].sort());
  });

  it("is always two bubbles, one ruling each low down and two each from the paired rung", () => {
    const low = signFor(SIGN_RAID_ID, PAIRED_SIGN_TIER - 1, SEED)!;
    const high = signFor(SIGN_RAID_ID, PAIRED_SIGN_TIER, SEED)!;
    expect(low.offers).toHaveLength(SIGN_MAX_SLOTS);
    for (const offer of low.offers) {
      expect(offer).toHaveLength(2);
      for (const bubble of offer) expect(bubble).toHaveLength(1);
    }
    for (const offer of high.offers) for (const bubble of offer) expect(bubble).toHaveLength(2);
  });

  it("never offers two rulings that punish the same build", () => {
    for (const tier of [1, PAIRED_SIGN_TIER, PRECEDENT_TIER]) {
      for (const seed of ["a", "b", "c", "d"]) {
        for (const offer of signFor(SIGN_RAID_ID, tier, seed)!.offers) {
          const tags = [...offer[0], ...offer[1]].map(rulingTag);
          expect(new Set(tags).size, `t${tier} ${seed}: ${tags}`).toBe(tags.length);
        }
      }
    }
  });

  it("never offers a class in two consecutive slots", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const offers = signFor(SIGN_RAID_ID, PRECEDENT_TIER, seed)!.offers;
      for (let s = 1; s < offers.length; s++) {
        const classes = (i: number) => new Set(
          [...offers[i][0], ...offers[i][1]].filter((r) => r.kind === "barred").map((r) => r.group));
        for (const g of classes(s)) expect(classes(s - 1).has(g), `${seed} slot ${s}: ${g}`).toBe(false);
      }
    }
  });

  it("pre-draws everything once, from the session seed", () => {
    const a = signFor(SIGN_RAID_ID, 1, "session-a")!;
    expect(signFor(SIGN_RAID_ID, 1, "session-a")).toEqual(a);
    expect(signFor(SIGN_RAID_ID, 1, "session-b")).not.toEqual(a);
    expect([0, 1]).toContain(autoPickFor(a, SIGN_MAX_SLOTS + 3));
  });

  it("puts nothing in force in the opening slot, with the first question already up", () => {
    const sim = signedFight(["Headless", "Regular"]);
    sim.step(50);
    expect(sim.signOffer()).not.toBeNull();
    expect(sim.activeRulings()).toEqual([]);
  });
});

describe("the choice", () => {
  it("brings in what the player picked, and not the other one", () => {
    const sim = signedFight(["Headless", "Regular"]);
    sim.step(50);
    const offer = sim.signOffer()!;
    expect(sim.pickSign(0, 1)).toBe(true);
    resolveOffer(sim);
    expect(sim.activeRulings().map(rulingKey)).toEqual(offer[1].map(rulingKey));
  });

  it("falls through to the pinned coin when nobody chooses, below contempt", () => {
    const sign = signFor(SIGN_RAID_ID, 1, SEED)!;
    const sim = signedFight(["Headless", "Regular"]);
    run(sim, SIGN_DWELL_MS + 100);
    const expected = sign.offers[0][autoPickFor(sign, 0)];
    expect(sim.activeRulings().map(rulingKey)).toEqual(expected.map(rulingKey));
  });

  it("applies BOTH bubbles to a player who ignores it, from contempt", () => {
    const sign = signFor(SIGN_RAID_ID, CONTEMPT_TIER, SEED)!;
    expect(autoPickFor(sign, 0)).toBe(SIGN_BOTH);
    expect(signFor(SIGN_RAID_ID, CONTEMPT_TIER - 1, SEED)!.contempt).toBe(false);
    const sim = signedFight(["Headless", "Regular"], CONTEMPT_TIER);
    run(sim, SIGN_DWELL_MS + 100);
    const both = [...sign.offers[0][0], ...sign.offers[0][1]].map(rulingKey);
    expect(sim.activeRulings().map(rulingKey).sort()).toEqual([...new Set(both)].sort());
  });

  it("keeps two slots in force at once under precedent, and only there", () => {
    expect(signFor(SIGN_RAID_ID, PRECEDENT_TIER - 1, SEED)!.inForce).toBe(1);
    const sign = signFor(SIGN_RAID_ID, PRECEDENT_TIER, SEED)!;
    expect(sign.inForce).toBe(2);
    const sim = signedFight(["Headless", "Regular"], PRECEDENT_TIER);
    sim.step(50);
    sim.pickSign(0, 0);
    resolveOffer(sim);
    sim.pickSign(1, 1);
    resolveOffer(sim);
    const expected = new Set([...sign.offers[0][0], ...sign.offers[1][1]].map(rulingKey));
    expect(new Set(sim.activeRulings().map(rulingKey))).toEqual(expected);
  });

  it("refuses a pick that is not an answer to the question on the table", () => {
    const sim = signedFight(["Headless"]);
    sim.step(50);
    expect(sim.pickSign(1, 0), "a future offer").toBe(false);
    expect(sim.pickSign(0, 2), "a third bubble").toBe(false);
    expect(sim.pickSign(0, 0)).toBe(true);
    expect(sim.pickSign(0, 1), "no take-backs").toBe(false);
  });

  it("refuses everything on an invasion that has no rulings", () => {
    const sim = new BattleSim(
      [unit({ id: "z0", group: "Regular" })],
      [unit({ id: "boss", team: "enemy", isBoss: true, hp: 1e6, maxHp: 1e6 })],
    );
    run(sim, SIGN_DWELL_MS * 2);
    expect(sim.signOffer()).toBeNull();
    expect(sim.pickSign(0, 0)).toBe(false);
    expect(sim.activeRulings()).toEqual([]);
    expect(sim.hasSign()).toBe(false);
  });

  it("survives a checkpoint — a restored fight remembers what is in force", () => {
    const sim = signedFight(["Headless", "Garden"]);
    sim.step(50);
    expect(sim.pickSign(0, 1)).toBe(true);
    resolveOffer(sim);
    expect(sim.pickSign(1, 0)).toBe(true);
    const inForce = sim.activeRulings().map(rulingKey);
    const resumed = signedFight(["Headless", "Garden"]);
    resumed.restore(sim.snapshot());
    expect(resumed.activeRulings().map(rulingKey)).toEqual(inForce);
    expect(resumed.signPick()).toBe(0);
    resolveOffer(sim);
    resolveOffer(resumed);
    expect(resumed.activeRulings().map(rulingKey)).toEqual(sim.activeRulings().map(rulingKey));
  });
});

describe("what each ruling does", () => {
  it("Barred sends the named class backwards and leaves everyone else fighting", () => {
    const sim = signedFight(["Headless", "Regular"]);
    run(sim, 8_000);
    const barred = sim.units.find((u) => u.id === "z0")!;
    const free = sim.units.find((u) => u.id === "z1")!;
    choose(sim, barredGroup("Headless"));
    expect(sim.signedGroups()).toContain("Headless");
    const before = barred.x;
    const freeBefore = free.x;
    run(sim, 1_500);
    expect(barred.x, "the barred zombie walks away from the line").toBeLessThan(before);
    expect(barred.inLine).toBe(false);
    expect(free.x).toBeGreaterThanOrEqual(freeBefore - 1);
  });

  it("Order in Court stops healing, and only while it stands", () => {
    const sim = signedFight(["Garden", "Regular"]);
    const hurt = sim.units.find((u) => u.id === "z1")!;
    sim.units.find((u) => u.id === "z0")!.abilities = ["heal"];
    run(sim, 8_000);
    const SPAN = 1_500;
    const WOUND = hurt.maxHp / 2;
    choose(sim, (r) => r.kind === "orderInCourt" || (r.kind === "barred" && r.group === "Garden"), false);
    hurt.hp = WOUND;
    run(sim, SPAN);
    expect(hurt.hp, "a free healer heals").toBeGreaterThan(WOUND);
    choose(sim, kind("orderInCourt"));
    hurt.hp = WOUND;
    run(sim, SPAN);
    expect(hurt.hp, "nobody heals under the ruling").toBeLessThanOrEqual(WOUND);
  });

  it("Slowed and Weakened stretch the swing and soften the blow, harder when severe", () => {
    expect(RULING_SLOW.severe).toBeGreaterThan(RULING_SLOW.normal);
    expect(RULING_WEAKEN.severe).toBeLessThan(RULING_WEAKEN.normal);
    expect(signFor(SIGN_RAID_ID, SEVERE_TIER - 1, SEED)!.severe).toBe(false);
    expect(signFor(SIGN_RAID_ID, SEVERE_TIER, SEED)!.severe).toBe(true);
    // Measured in the fight: damage dealt to the minion over a span, with and without.
    const dealt = (pick: (r: Ruling) => boolean, want: boolean) => {
      const sim = signedFight(["Regular"]);
      run(sim, 8_000);
      choose(sim, pick, want);
      const minion = sim.units.find((u) => u.id === "minion")!;
      const before = minion.hp;
      run(sim, 3_000);
      return before - minion.hp;
    };
    const offense = (r: Ruling) => r.kind === "slowed" || r.kind === "weakened";
    expect(dealt(kind("weakened"), true)).toBeLessThan(dealt(offense, false));
    expect(dealt(kind("slowed"), true)).toBeLessThan(dealt(offense, false));
  });

  it("Overruled takes the move off the strip", () => {
    const sim = signedFight(["Small", "Regular"]);
    sim.units.find((u) => u.id === "z0")!.abilities = ["explode"];
    run(sim, 8_000);
    choose(sim, (r) => r.kind === "overruled" && r.ability === "explode");
    expect(sim.activate("explode"), "refused while it stands").toBe(false);
  });

  it("comes down with the boss", () => {
    const sim = signedFight(["Headless"]);
    run(sim, SIGN_DWELL_MS + 100);
    expect(sim.activeRulings().length).toBeGreaterThan(0);
    for (const e of sim.units) if (e.team === "enemy" && !e.isBoss) { e.alive = false; e.hp = 0; }
    run(sim, 3_000);
    expect(sim.units.find((u) => u.id === "boss")!.state).not.toBe("structure");
    expect(sim.activeRulings()).toEqual([]);
    expect(sim.signOffer(), "and there is nothing left to choose").toBeNull();
  });
});

describe("the angry farmer mob", () => {
  const assets = {
    enemyStats: enemyStatsJson as Record<string, EnemyStat>,
    raidAttacks: attacksJson as Record<string, AttackDef>,
  };
  const raid12 = (raidsJson as RaidDef[]).find((r) => r.id === SIGN_RAID_ID)!;

  it("is the t3 rung, and absent below it", () => {
    expect(farmerSquadFor(assets, raid12, FARMER_MOB_TIER - 1)).toEqual([]);
    expect(farmerSquadFor(assets, raid12, FARMER_MOB_TIER)).toHaveLength(FARMER_SQUAD_MINIONS + 1);
  });

  it("is a leader plus three farmhands, waiting on the midpoint, none of them a boss", () => {
    const squad = farmerSquadFor(assets, raid12, FARMER_MOB_TIER);
    for (const member of squad) {
      expect(member.deployAtWaveFrac).toBe(MIDPOINT_WAVE_FRAC);
      expect(member.isBoss).toBeFalsy();
    }
    expect(squad.filter((u) => u.sourceKey === "FarmStageActorBoss")).toHaveLength(1);
  });

  it("belongs to this invasion alone", () => {
    for (const other of (raidsJson as RaidDef[]).filter((r) => r.id !== SIGN_RAID_ID)) {
      expect(farmerSquadFor(assets, other, FARMER_MOB_TIER)).toEqual([]);
    }
  });

  it("walks on together once half the wave is down, and not before", () => {
    const squad = farmerSquadFor(assets, raid12, FARMER_MOB_TIER);
    const wave = Array.from({ length: 4 }, (_, i) => unit({
      id: `w${i}`, sourceKey: "CityStageActorLawyer", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6,
    }));
    const sim = signedFight(["Regular"], FARMER_MOB_TIER, [...wave, ...squad]);
    const deployed = () => sim.units.filter((u) => u.id.startsWith("squad") && u.state !== "queued").length;
    run(sim, 20_000);
    expect(deployed(), "nothing before the midpoint").toBe(0);
    // Five wave bodies (the minion + four): down three and the midpoint is past.
    for (const id of ["minion", "w0", "w1"]) {
      const e = sim.units.find((u) => u.id === id)!;
      e.alive = false; e.hp = 0; e.state = "dead";
    }
    run(sim, 1_000);
    expect(deployed(), "then all four at once").toBe(FARMER_SQUAD_MINIONS + 1);
  });
});
