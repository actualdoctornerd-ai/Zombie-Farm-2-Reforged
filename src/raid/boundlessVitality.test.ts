// Boundless Vitality (owner, 2026-11-11; ruleset 90): the Green Flower Zombie gets back up
// after every fight — an invasion's settlement, between Endless floors, and at a run's end.
import { describe, expect, it } from "vitest";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { BattleSim } from "./BattleSim";
import { buildUnitsForKeys } from "./CombatEngine";
import { beginEndlessRun, finishEndlessFight } from "./endless";
import { endlessLosses } from "./endlessRunRules";
import type { CombatUnit } from "./types";
import { activeAbilities } from "../zombie/abilities";
import { BOUNDLESS_VITALITY } from "../zombie/boundlessVitality";
import { ABILITY_POOL, unitAbilityAt } from "../zombie/traits";

const GREEN_FLOWER = "ZombieActorGardenTier3GreenFlower";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

describe("Boundless Vitality", () => {
  it("is the Green Flower's slot-2 ability, in place of the Garden ladder's Fortitude", () => {
    expect(unitAbilityAt(GREEN_FLOWER, "Garden", 2)).toBe(BOUNDLESS_VITALITY);
    expect(unitAbilityAt("ZombieActorGardenTier4", "Garden", 2)).toBe("tankHitPointsBuff");
    expect(ABILITY_POOL[BOUNDLESS_VITALITY].label).toBe("Boundless Vitality");
    // Silver rank: all four slots, like a Zombee.
    const def = (zombiesJson as { key: string; className: string; group: string }[]).find((z) => z.key === GREEN_FLOWER)!;
    expect(def.className).toBe("Silver");
    expect(activeAbilities({ key: GREEN_FLOWER, group: "Garden", className: def.className }, () => true))
      .toEqual(["heal", BOUNDLESS_VITALITY, "ressurect", "healAOE"]);
  });

  it("is reported as a survivor, not a loss, when it falls in a fight", () => {
    const flower = unit({ id: "flower", sourceKey: GREEN_FLOWER, team: "player", isGarden: true, abilities: [BOUNDLESS_VITALITY] });
    const plain = unit({ id: "plain", sourceKey: "ZombieActorGardenTier4", team: "player", isGarden: true });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([flower, plain], [enemy], null, true);
    for (const id of ["flower", "plain"]) sim.units.find((u) => u.id === id)!.alive = false;
    const { survivors, losses } = sim.outcome();
    expect(survivors).toContain("flower");
    expect(losses).toEqual(["plain"]);
  });

  it("does nothing while its slot is still locked (the ability is not in the unit's list)", () => {
    const flower = unit({ id: "flower", sourceKey: GREEN_FLOWER, team: "player", isGarden: true, abilities: ["heal"] });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([flower], [enemy], null, true);
    sim.units.find((u) => u.id === "flower")!.alive = false;
    expect(sim.outcome().losses).toEqual(["flower"]);
  });

  describe("in Endless", () => {
    const units = buildUnitsForKeys(["FarmStageActorFarmhand", "FarmStageActorFarmhand"], null, enemyStats as never, attacks as never, { raidId: 1 })
      .map((u, i) => (i === 0 ? { ...u, abilities: [BOUNDLESS_VITALITY] } : u));
    const bothFell = (run: ReturnType<typeof beginEndlessRun>) =>
      run.units.map((u) => ({ ...u, team: "player" as const, alive: false, hp: 0 }));

    it("stands back up at full Life for the next floor; an ordinary zombie stays down", () => {
      const floor = { ...beginEndlessRun("endless", units), nextWave: 1 };
      const after = finishEndlessFight(floor, bothFell(floor)).units;
      expect(after[0]).toMatchObject({ alive: true, hp: after[0].maxHp });
      expect(after[1].alive).toBe(false);
    });

    it("is never buried when the run ends, whether it fell earlier or in the losing fight", () => {
      const run = beginEndlessRun("endless", units);
      const downInState = { ...run, units: run.units.map((u) => ({ ...u, alive: false, hp: 0 })) };
      expect(endlessLosses(downInState)).toEqual([run.units[1].id]);
      const lastFight = { units: bothFell(run) } as unknown as Parameters<typeof endlessLosses>[1];
      expect(endlessLosses(run, lastFight)).toEqual([run.units[1].id]);
    });
  });
});
