// A damage number reports the ATTACK, not the health it removed.
//
// The floating figures used to be sampled as an HP delta in RaidScene, so both of the
// fight's damage clamps silently shrank them: a blow bigger than the target's remaining
// health read as that health, and the one-shot protection latch — which snaps a doomed
// zombie to 1 HP — read as "hp - 1". Measuring the Pirate boss that way reported ~2000
// for a swing that is authored to hit for 5000. The sim now publishes the post-mitigation
// size of every hit on `SimUnit.damageFxTaken`, ahead of both clamps, and the scene floats
// increases in THAT. These pin the difference.
//
// Mitigation still counts: `damageFxTaken` is fed after armor / damage reduction / attack
// multipliers, so a reduced hit reads reduced and a fully blocked one is never published.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import { newDamageTally, tallyDamage } from "./combatNumbers";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** One zombie on the lane against one enemy whose swing is `enemyStr x 10`. */
function duel(
  over: Partial<CombatUnit> = {},
  enemyOver: Partial<CombatUnit> = {},
  backline: CombatUnit[] = []
) {
  const player = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", str: 1, ...over });
  const enemy = unit({
    id: "e", sourceKey: "PirateStageActorBoss", team: "enemy",
    con: 100000, str: 500, dex: 0.4, ...enemyOver,
  });
  const sim = new BattleSim(
    [player, ...backline], [enemy], null, true, [],
    10 * 60 * 1000, null, null, false, false, false, 60, null, null
  );
  sim.units.find((u) => u.id === "p")!.state = "advance";
  return sim;
}

const zombieOf = (sim: BattleSim) => sim.units.find((u) => u.id === "p")!;

/** Advance until the zombie has been hit at least `hits` times, or give up. */
function runUntilHits(sim: BattleSim, hits: number, maxTicks = 4000) {
  let struck = 0;
  let last = zombieOf(sim).damageFxTaken;
  for (let t = 0; t < maxTicks && struck < hits; t++) {
    sim.step(50);
    const now = zombieOf(sim).damageFxTaken;
    if (now > last) struck++;
    last = now;
  }
  return struck;
}

describe("damage numbers report the attack, not the health removed", () => {
  it("publishes the whole hit when one-shot protection latches the target", () => {
    // 50 con = 5000 hp, against a 500-str swing: exactly lethal, so the latch fires.
    const sim = duel({ con: 50 });
    expect(runUntilHits(sim, 1)).toBe(1);
    const z = zombieOf(sim);
    expect(z.hp).toBe(1); // latched, still standing
    expect(z.damageFxTaken).toBe(5000); // …and the number reads the real blow, not 4999
  });

  it("publishes overkill in full rather than the health that came off", () => {
    // The latch is one-use, so the SECOND swing kills — and does so with 4999 to spare.
    const sim = duel({ con: 50 });
    expect(runUntilHits(sim, 2)).toBe(2);
    const z = zombieOf(sim);
    expect(z.alive).toBe(false);
    expect(z.hp).toBe(0);
    expect(z.damageFxTaken).toBe(10000); // two whole swings, not 5000 + 1
  });

  it("still reads mitigation: damage reduction shrinks the published figure", () => {
    const plain = duel({ con: 50 });
    runUntilHits(plain, 1);
    expect(zombieOf(plain).damageFxTaken).toBe(5000);
    // A Protect carrier is -20% for everyone on the line EXCEPT itself, so the shielded
    // case needs a second carrier standing behind the one being measured (ruleset v38).
    const armoured = duel({ con: 50 }, {}, [
      unit({ id: "backer", sourceKey: "ZombieActorRegularTier1", team: "player", abilities: ["protect"] }),
    ]);
    // Deploy the carrier explicitly: the aura pays only from DEPLOYED carriers, and since
    // v40's reach-of-last-resort the first hit can land while the measured zombie is
    // still crossing the zone — before auto-release would have fielded the backer.
    armoured.units.find((u) => u.id === "backer")!.state = "advance";
    runUntilHits(armoured, 1);
    expect(zombieOf(armoured).damageReduction).toBeCloseTo(0.1, 5); // aura settles on step
    // The published figure is the MITIGATED blow — the number a player should read —
    // not the raw 5000 the enemy swung for.
    expect(zombieOf(armoured).damageFxTaken).toBeCloseTo(5000 * 0.9, 5);
  });

  it("never publishes a hit the fight never applied", () => {
    const sim = duel({ con: 50 });
    const z = zombieOf(sim);
    expect(z.damageFxTaken).toBe(0); // nothing before the first swing lands
    sim.step(50);
    expect(z.damageFxTaken).toBe(0);
  });

  it("the total only climbs, so a heal cannot rewind a pending number", () => {
    const sim = duel({ con: 50 });
    runUntilHits(sim, 1);
    const z = zombieOf(sim);
    const after = z.damageFxTaken;
    z.hp = z.maxHp; // a Garden heal between numbers
    expect(z.damageFxTaken).toBe(after);
  });

  it("survives a snapshot round trip", () => {
    const sim = duel({ con: 50 });
    runUntilHits(sim, 1);
    const taken = zombieOf(sim).damageFxTaken;
    const restored = duel({ con: 50 });
    restored.restore(sim.snapshot());
    expect(zombieOf(restored).damageFxTaken).toBe(taken);
  });
});

describe("the tally still folds those figures the same way", () => {
  it("accumulates the published increases, not HP drops", () => {
    const tally = newDamageTally();
    expect(tallyDamage(tally, 5000, 0.05)).toBe(5000);
    expect(tallyDamage(tally, 5000, 0.05)).toBeNull(); // inside the gap, held back
    expect(tallyDamage(tally, 0, 0.2)).toBe(5000);
  });
});
