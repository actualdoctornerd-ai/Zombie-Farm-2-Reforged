// The Lawyer boss's OBJECTION (raid 12). See docs/POST_45_PROGRESSION.md and dualInvasion.ts.
//
// What these pin is the MECHANIC, not its numbers: that the fight asks a question rather
// than announcing an answer, that the player's tap decides which class goes, that ignoring
// the question still costs something, that a barred zombie leaves the fight rather than
// standing in it, that its support work stops with it, and that the whole thing ends when
// the boss climbs down. The dwell and the offer pairings are tuning and will move.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  autoPickFor, FARMER_SQUAD_MINIONS, farmerSquadAtMs, PAIRED_SIGN_TIER, SIGN_DAMAGE_GROUPS,
  SIGN_DWELL_MS, SIGN_MAX_SLOTS, SIGN_OFFERS, SIGN_PAIRED_OFFERS, SIGN_RAID_ID, signFor,
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

/** A fight with one zombie of each named class and a perched lawyer filing motions. */
function signedFight(
  groups: string[], tier = 1, extraEnemies: CombatUnit[] = [], seed = SEED
) {
  const players = groups.map((group, i) => unit({
    id: `z${i}`, name: group, group,
    isGarden: group === "Garden", isHeadless: group === "Headless",
  }));
  // The enemies are PUNCHBAGS: huge HP so the fight never ends, and str 0 so they hit for
  // the minimum. These tests are about what the objection does, and an enemy that can kill
  // the patient turns "was it healed?" into "did it survive?" — which is how the first
  // draft of the healer test below came out green for the wrong reason.
  const enemies = [
    unit({ id: "minion", sourceKey: "CityStageActorLawyer", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
    unit({ id: "boss", sourceKey: "CityStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
    ...extraEnemies,
  ];
  // A round length longer than any test here. The default one ENRAGES the boss part way
  // through, which killed the patient in the healer test below and made it look as though
  // the bar had done it — these tests want a fight that just keeps going.
  const NO_ENRAGE_MS = 10 * 60 * 1000;
  const sim = new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, undefined, null, signFor(SIGN_RAID_ID, tier, seed)
  );
  return sim;
}

const run = (sim: BattleSim, ms: number) => {
  for (let t = 0; t < ms; t += 50) sim.step(50);
};

/** Advance to the end of the offer on the table, so whatever was picked is now in force. */
function resolveOffer(sim: BattleSim): void {
  const index = sim.signOfferIndex();
  for (let i = 0; i < 400 && sim.signOfferIndex() === index; i++) sim.step(50);
}

/** Take the next offer that lets us choose a bubble which does (or does not) name `group`,
 *  and advance until that choice is the one in force. This is how a test says "now bar the
 *  Garden zombie" without hard-coding which slot of which rotation that happens to be. */
function chooseBar(sim: BattleSim, group: string, want: boolean): void {
  for (let guard = 0; guard < 400; guard++) {
    const offer = sim.signOffer();
    const index = sim.signOfferIndex();
    if (offer && index !== null && sim.signPick() === null) {
      const option = offer.findIndex((bubble) => bubble.includes(group) === want);
      if (option >= 0 && sim.pickSign(index, option)) {
        resolveOffer(sim);
        return;
      }
    }
    sim.step(50);
  }
  throw new Error(`never got the chance to ${want ? "bar" : "spare"} ${group}`);
}

describe("the offer", () => {
  it("only exists on the invasion that has one", () => {
    expect(signFor(SIGN_RAID_ID, 1, SEED)).not.toBeNull();
    for (const other of [1, 6, 9, 13, 14, 15]) expect(signFor(other, 1, SEED)).toBeNull();
  });

  it("is always two bubbles, one class each low down and a pair from the paired rung", () => {
    const low = signFor(SIGN_RAID_ID, 1, SEED)!;
    expect(low.offers).toEqual(SIGN_OFFERS);
    expect(low.offers.every((o) => o.length === 2 && o.every((b) => b.length === 1))).toBe(true);
    expect(signFor(SIGN_RAID_ID, PAIRED_SIGN_TIER - 1, SEED)!.offers).toEqual(SIGN_OFFERS);
    const paired = signFor(SIGN_RAID_ID, PAIRED_SIGN_TIER, SEED)!;
    expect(paired.offers).toEqual(SIGN_PAIRED_OFFERS);
    expect(paired.offers.every((o) => o.length === 2 && o.every((b) => b.length === 2))).toBe(true);
  });

  it("never offers the same thing in both bubbles", () => {
    // A dilemma with one answer is not a dilemma. This is the one property of the tables
    // that a future re-pairing must not quietly break.
    for (const table of [SIGN_OFFERS, SIGN_PAIRED_OFFERS]) {
      for (const offer of table) expect(offer[0].join("+")).not.toBe(offer[1].join("+"));
    }
  });

  it("puts every class on the table, so nothing is permanently safe", () => {
    const named = new Set(SIGN_OFFERS.flatMap((offer) => offer.flatMap((bubble) => bubble)));
    expect([...named].sort()).toEqual(
      [...new Set(SIGN_PAIRED_OFFERS.flatMap((o) => o.flatMap((b) => b)))].sort()
    );
    expect(named.size).toBe(6);
  });

  it("walks the offers in the same order every fight, and wraps", () => {
    const sim = signedFight(["Regular"]);
    const seen: string[] = [];
    for (let i = 0; i < SIGN_OFFERS.length + 1; i++) {
      seen.push(sim.signOffer()!.map((b) => b.join("+")).join(" vs "));
      run(sim, SIGN_DWELL_MS);
    }
    const expected = SIGN_OFFERS.map((o) => o.map((b) => b.join("+")).join(" vs "));
    expect(seen).toEqual([...expected, expected[0]]);
  });

  it("bars nobody in the opening slot, with the first question already up", () => {
    const sim = signedFight(["Headless", "Regular"]);
    expect(sim.signOfferIndex(), "askable from the first tick").toBe(0);
    expect(sim.signedGroups(), "and free until it is answered").toEqual([]);
    run(sim, SIGN_DWELL_MS - 100);
    expect(sim.signedGroups()).toEqual([]);
    run(sim, 200);
    expect(sim.signedGroups().length, "then the first bar lands").toBe(1);
  });
});

describe("the choice", () => {
  it("bars what the player picked, and not the other one", () => {
    const sim = signedFight(["Headless", "Garden"]);
    const offer = sim.signOffer()!;
    expect(sim.pickSign(0, 1)).toBe(true);
    expect(sim.signPick(), "and the panel can still show it").toBe(1);
    expect(sim.signedGroups(), "not yet — the pick lands on the NEXT slot").toEqual([]);

    resolveOffer(sim);
    expect(sim.signedGroups()).toEqual(offer[1]);
    expect(sim.signPick(), "the new offer starts unanswered").toBeNull();
    expect(sim.signOfferIndex()).toBe(1);
  });

  it("falls through to the pinned auto-pick when nobody chooses", () => {
    const sign = signFor(SIGN_RAID_ID, 1, SEED)!;
    const sim = signedFight(["Headless", "Garden"]);
    run(sim, SIGN_DWELL_MS + 100);
    expect(sim.signedGroups()).toEqual(SIGN_OFFERS[0][autoPickFor(sign, 0)]);
  });

  it("pre-draws the auto-picks once, from the session seed", () => {
    // Pinned rather than rolled: the client and the verifier have to agree about an
    // unattended slot without exchanging anything (see replay.ts v58).
    const a = signFor(SIGN_RAID_ID, 1, "session-a")!;
    expect(a.autoPicks).toHaveLength(SIGN_MAX_SLOTS);
    expect(a.autoPicks.every((p) => p === 0 || p === 1)).toBe(true);
    expect(signFor(SIGN_RAID_ID, 1, "session-a")!.autoPicks).toEqual(a.autoPicks);
    // A different fight is a different coin. Over 64 draws an identical table would be a
    // 1-in-2^64 coincidence, so this is a real assertion about the seed being used.
    expect(signFor(SIGN_RAID_ID, 1, "session-b")!.autoPicks).not.toEqual(a.autoPicks);
    // And the answer is defined past the end of the table rather than undefined.
    expect([0, 1]).toContain(autoPickFor(a, SIGN_MAX_SLOTS + 3));
  });

  it("refuses a pick that is not an answer to the question on the table", () => {
    const sim = signedFight(["Headless", "Garden"]);
    expect(sim.pickSign(1, 0), "an offer that is not up").toBe(false);
    expect(sim.pickSign(0, 2), "a bubble that does not exist").toBe(false);
    expect(sim.pickSign(0, -1)).toBe(false);
    expect(sim.pickSign(0, 0), "…and the real one still lands").toBe(true);
    expect(sim.pickSign(0, 1), "no take-backs").toBe(false);
    expect(sim.signPick()).toBe(0);

    resolveOffer(sim);
    expect(sim.pickSign(0, 1), "and the closed offer stays closed").toBe(false);
  });

  it("refuses everything on an invasion that has no objection", () => {
    const sim = new BattleSim(
      [unit({ id: "z0", group: "Regular" })],
      [unit({ id: "boss", team: "enemy", isBoss: true, hp: 1e6, maxHp: 1e6 })],
    );
    expect(sim.signOffer()).toBeNull();
    expect(sim.signOfferIndex()).toBeNull();
    expect(sim.pickSign(0, 0)).toBe(false);
    expect(sim.signedGroups()).toEqual([]);
  });

  it("survives a checkpoint — a restored fight remembers what it barred", () => {
    const sim = signedFight(["Headless", "Garden"]);
    expect(sim.pickSign(0, 1)).toBe(true);
    resolveOffer(sim);
    expect(sim.pickSign(1, 0)).toBe(true); // committed but not yet resolved
    const barred = sim.signedGroups();
    const snapshot = sim.snapshot();

    const resumed = signedFight(["Headless", "Garden"]);
    resumed.restore(snapshot);
    expect(resumed.signedGroups(), "the bar in force").toEqual(barred);
    expect(resumed.signPick(), "and the pick already committed").toBe(0);
    // A checkpoint that dropped either would resume barring the wrong class from here.
    resolveOffer(sim);
    resolveOffer(resumed);
    expect(resumed.signedGroups()).toEqual(sim.signedGroups());
  });
});

describe("being barred", () => {
  it("sends the named class backwards and leaves everyone else fighting", () => {
    const sim = signedFight(["Headless", "Regular"]);
    run(sim, 8_000); // let both deploy and reach the line
    const barredUnit = sim.units.find((u) => u.id === "z0")!;
    const free = sim.units.find((u) => u.id === "z1")!;
    chooseBar(sim, "Headless", true);
    expect(sim.signedGroups()).toEqual(["Headless"]);

    const barredBefore = barredUnit.x;
    const freeBefore = free.x;
    run(sim, 1_500);

    expect(barredUnit.x, "the barred zombie walks away from the line").toBeLessThan(barredBefore);
    expect(barredUnit.inLine, "and gives up its place in it").toBe(false);
    expect(free.x, "the class that was not named holds its ground").toBeGreaterThanOrEqual(freeBefore - 1);
  });

  it("stops a barred healer from healing, and only while it is barred", () => {
    // The Garden zombie needs the ability for any of this to mean anything — `isHealer`
    // is `isGarden && has heal`, so a Garden with no abilities heals nobody whether it is
    // barred or not, and a test built on one would pass without testing anything.
    const sim = signedFight(["Garden", "Regular"]);
    const hurt = sim.units.find((u) => u.id === "z1")!;
    const healer = sim.units.find((u) => u.id === "z0")!;
    healer.abilities = ["heal"];
    run(sim, 8_000);

    // Both halves measure a span that fits INSIDE one slot. A choice lands at a slot
    // boundary, so a span of a whole dwell spills into the next one — which is how an
    // earlier draft of this test "failed": the bar worked, and then the slot turned over
    // and the healer got back to work before the measurement ended.
    const SPAN = 1_500;

    // Wound to HALF, not to a sliver. Below ONE_SHOT_FLOOR (10% of maxHp) the next hit of
    // any size trips the one-shot protection and parks the zombie at exactly 1 HP — which
    // an earlier draft of this test mistook for the bar doing something.
    const WOUND = hurt.maxHp / 2;

    // FREE: deliberately spare the Garden and confirm the healer works at all. Without
    // this control the barred assertion below passes for any number of reasons that have
    // nothing to do with the objection.
    chooseBar(sim, "Garden", false);
    expect(sim.signedGroups()).not.toContain("Garden");
    hurt.hp = WOUND;
    run(sim, SPAN);
    expect(hurt.hp, "a free healer heals").toBeGreaterThan(WOUND);

    // BARRED: same wound, same span. `toBeLessThanOrEqual` rather than an exact figure
    // because the punchbag still lands its minimum-damage tick — what is being asserted is
    // that nothing HEALED, and the control above is what gives that assertion teeth.
    chooseBar(sim, "Garden", true);
    expect(sim.signedGroups()).toContain("Garden");
    hurt.hp = WOUND;
    run(sim, SPAN);
    expect(hurt.hp, "a barred healer heals nobody").toBeLessThanOrEqual(WOUND);
  });

  it("comes down with the boss", () => {
    const sim = signedFight(["Headless"]);
    run(sim, SIGN_DWELL_MS + 100);
    expect(sim.signedGroups().length).toBe(1);
    expect(sim.signOffer()).not.toBeNull();

    // Clear the wave: the boss leaves its perch to fight, and the motions go with it.
    for (const e of sim.units) if (e.team === "enemy" && !e.isBoss) { e.alive = false; e.hp = 0; }
    run(sim, 3_000);
    expect(sim.units.find((u) => u.id === "boss")!.state).not.toBe("structure");
    expect(sim.signedGroups()).toEqual([]);
    expect(sim.signOffer(), "and there is nothing left to choose").toBeNull();
    expect(sim.pickSign(0, 0)).toBe(false);
  });
});

describe("the farmer squad", () => {
  const assets = {
    enemyStats: enemyStatsJson as Record<string, EnemyStat>,
    raidAttacks: attacksJson as Record<string, AttackDef>,
  };
  const raid12 = (raidsJson as RaidDef[]).find((r) => r.id === SIGN_RAID_ID)!;
  const sign = (tier: number) => signFor(SIGN_RAID_ID, tier, SEED);

  it("lands on the slot the damage question decides, not at a hard-coded moment", () => {
    // Singles: [Regular] vs [Female] is the third offer, so its bar is in force from the
    // fourth slot. Paired: the damage pair first appears in the second offer.
    for (const tier of [1, PAIRED_SIGN_TIER]) {
      const cfg = sign(tier)!;
      const offer = cfg.offers.findIndex((o) =>
        o.some((bubble) => bubble.some((g) => SIGN_DAMAGE_GROUPS.includes(g))));
      expect(offer, `tier ${tier}: a damage offer exists`).toBeGreaterThanOrEqual(0);
      expect(farmerSquadAtMs(cfg)).toBe((offer + 1) * SIGN_DWELL_MS);
    }
    expect(farmerSquadAtMs(null)).toBeNull();
  });

  it("arrives while the question it is timed against is still on the table", () => {
    // The whole point of the timing: the farmers are visibly walking in WHILE the player
    // decides which half of their damage to give up. One dwell earlier or later and it is
    // just four more enemies.
    const cfg = sign(1)!;
    const at = farmerSquadAtMs(cfg)!;
    const sim = signedFight(["Regular"]);
    run(sim, at - 100);
    const offer = sim.signOffer()!;
    expect(offer.some((bubble) => bubble.some((g) => SIGN_DAMAGE_GROUPS.includes(g)))).toBe(true);
  });

  it("is a leader plus three farmhands, all on the same clock and none of them a boss", () => {
    const squad = farmerSquadFor(assets, raid12, sign(1));
    expect(squad).toHaveLength(FARMER_SQUAD_MINIONS + 1);
    const at = farmerSquadAtMs(sign(1));
    for (const member of squad) {
      expect(member.deployAtMs, "off the drip: it walks on by the clock").toBe(at);
      expect(member.isBoss, "the guest leader is a minion — the lawyer holds the boss slot").toBeFalsy();
    }
    expect(squad.filter((u) => u.sourceKey === "FarmStageActorBoss")).toHaveLength(1);
  });

  it("belongs to this invasion alone", () => {
    for (const other of (raidsJson as RaidDef[]).filter((r) => r.id !== SIGN_RAID_ID)) {
      expect(farmerSquadFor(assets, other, signFor(other.id, 1, SEED))).toEqual([]);
    }
  });

  it("walks on together, and not before its moment", () => {
    const squad = farmerSquadFor(assets, raid12, sign(1));
    // The squad goes in with the wave at construction, which is how a real fight gets it.
    const withSquad = signedFight(["Regular"], 1, squad);
    const at = farmerSquadAtMs(sign(1))!;
    const deployed = () => withSquad.units.filter(
      (u) => u.id.startsWith("squad") && u.state !== "queued"
    ).length;

    run(withSquad, at - 1_000);
    expect(deployed(), "nothing before its moment").toBe(0);
    run(withSquad, 2_000);
    expect(deployed(), "then all four at once").toBe(FARMER_SQUAD_MINIONS + 1);
  });
});
