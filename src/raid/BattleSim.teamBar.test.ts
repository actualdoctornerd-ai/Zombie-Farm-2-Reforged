import { describe, expect, it } from "vitest";
import { BattleSim, type SimUnit } from "./BattleSim";
import { buildPlayerUnits } from "./CombatEngine";
import type { CombatUnit, SummonConfig } from "./types";
import type { OwnedZombie } from "../zombie/types";

// The two top-corner team bars. Their one hard rule is that the numerator and the
// denominator describe the SAME units: the bar has to read FULL while every zombie
// behind it is at full health, whatever the army is made of.
//
// It did not. The scene divided the live HP sum by a constant captured from the
// roster CombatEngine handed over, and that roster's con already carries the full
// team aura, while BattleSim pays the aura only to zombies that have DEPLOYED. An
// army holding a Chivalry or Grace carrier therefore opened every invasion with a
// visibly dark bar and not a point of damage taken.

function enemy(over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id: "e1", sourceKey: "FarmStageActorFarmhand", team: "enemy", name: "e1",
    str: 5, dex: 5, con: 30, focus: 0, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}

const owned = (
  over: Partial<OwnedZombie> & Pick<OwnedZombie, "id" | "key" | "group">
): OwnedZombie => ({
  name: over.id, typeName: over.id, className: "Green", classColor: "#7bd84a",
  mutation: 0, str: 6, dex: 4, con: 8, focus: 100, invasions: 0, col: 0, row: 0,
  ...over,
});

/** A Blue Regular sees ability tier 2 = Chivalry, which lifts every Girl zombie's
 *  str/dex/con by 10 %. Two Girls ride along to receive it. */
function auraParty(): CombatUnit[] {
  return buildPlayerUnits(
    [
      owned({
        id: "knight", key: "ZombieActorRegularTier2", group: "Regular",
        className: "Blue", classColor: "#5aa8ff",
      }),
      owned({ id: "girl1", key: "ZombieActorFemaleTier1", group: "Female" }),
      owned({ id: "girl2", key: "ZombieActorFemaleTier1", group: "Female" }),
    ],
    { abilitySlotUnlocked: () => true, playerLevel: 45 },
  );
}

const totalMaxHp = (units: CombatUnit[]) => units.reduce((s, u) => s + u.maxHp, 0);

describe("team health bars measure the units they are drawn from", () => {
  it("an aura-carrying army starts the fight with a FULL player bar", () => {
    const sim = new BattleSim(auraParty(), [enemy()], null, true);
    const totals = sim.teamTotals();
    expect(totals.playerHp).toBe(totals.playerMax);
  });

  it("the party really does exercise the aura (else the case above proves nothing)", () => {
    // The roster's maxHp is the everyone-deployed figure; the sim opens with nobody
    // deployed, so its own total is strictly smaller. That gap WAS the dark stripe.
    const party = auraParty();
    const sim = new BattleSim(party, [enemy()], null, true);
    expect(sim.teamTotals().playerMax).toBeLessThan(totalMaxHp(party));
  });

  it("stays full while the aura switches on under it (zombies marching in)", () => {
    // A wave that never swings (its attack clock outlasts the test) and cannot be
    // killed inside it, so any reading below full over the next 30 s is the bar
    // drifting away from its own units. `str: 0` alone would NOT do: the resolver
    // floors every hit at 1 damage so a fight can't stall.
    const sim = new BattleSim(
      auraParty(), [enemy({ str: 0, con: 1e5, attackCooldownMs: 1e9 })], null, true,
    );
    for (let i = 0; i < 300; i++) {
      sim.step(100);
      const totals = sim.teamTotals();
      expect(totals.playerHp).toBe(totals.playerMax);
    }
    expect(sim.units.some((u) => u.team === "player" && u.state === "fight")).toBe(true);
  });

  it("drains as zombies take damage, and a death stays lost", () => {
    const sim = new BattleSim(auraParty(), [enemy()], null, true);
    const full = sim.teamTotals();
    const victim = sim.units.find((u) => u.team === "player")!;
    victim.hp = Math.round(victim.maxHp / 2);
    const hurt = sim.teamTotals();
    expect(hurt.playerHp).toBeLessThan(full.playerHp);
    expect(hurt.playerMax).toBe(full.playerMax);

    victim.hp = 0;
    victim.alive = false;
    const bereaved = sim.teamTotals();
    // The fallen zombie keeps its maxHp in the denominator — losing one must not
    // refill the bar by quietly shrinking what it is measured against.
    expect(bereaved.playerMax).toBe(full.playerMax);
    expect(bereaved.playerAlive).toBe(full.playerAlive - 1);
  });
});

describe("the enemy bar measures the WAVE, not the boss's furniture", () => {
  const harmless = (): CombatUnit[] => [{
    id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", name: "p",
    str: 0, dex: 5, con: 100, focus: 100, hp: 1e6, maxHp: 1e6,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  }];

  const abductees = (): SummonConfig => ({
    queue: [enemy({ id: "lumberjack", sourceKey: "FarmStageActorLumberjack", con: 50 })],
    pool: [enemy({ id: "farmhand", sourceKey: "FarmStageActorFarmhand", con: 50 })],
  });

  it("a summoned blocker moves neither side of the enemy bar", () => {
    const sim = new BattleSim(
      harmless(),
      [
        enemy({ id: "bag", str: 0, hp: 1e7, maxHp: 1e7 }),
        enemy({ id: "boss", sourceKey: "AlienStageActorBoss", isBoss: true, str: 0 }),
      ],
      null, true,
      [{ name: "summonBoss", weight: 1, castMs: 0, cooldownMs: 100, damage: 0 }],
      undefined, abductees(),
    );
    const before = sim.teamTotals();
    for (let i = 0; i < 40 && !sim.units.some((u: SimUnit) => u.isSummon); i++) sim.step(50);
    const summoned = sim.units.filter((u: SimUnit) => u.isSummon);
    expect(summoned.length).toBeGreaterThan(0);

    const after = sim.teamTotals();
    // Nothing on either side can hurt anything here, so both halves of the enemy
    // bar must be untouched — counting a summon's HP against a total that never
    // heard of it is what pinned the bar at full for as long as one stood.
    expect(after.enemyMax).toBe(before.enemyMax);
    expect(after.enemyHp).toBe(before.enemyHp);
    // …but it IS a body on the field, so the head count still shows it.
    expect(after.enemyAlive).toBe(before.enemyAlive + summoned.length);
  });
});
