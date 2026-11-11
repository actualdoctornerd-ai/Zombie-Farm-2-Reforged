// Volatile Remains (Endless curse): an enemy that pops on death hurts only the zombies out on
// the field near it. It used to hit every living zombie, queued ones included, so a single
// blast took a quarter of the team bar off bodies no healer could reach.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 1000, maxHp: 1000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

type Sim = {
  players: Array<{ id: string; x: number; state: string; hp: number; maxHp: number }>;
  enemies: Array<{ id: string; x: number; hp: number }>;
  engageDistance: number;
  dealDamage: (target: unknown, dmg: number, fromPlayer: boolean) => void;
};

describe("Volatile Remains blast", () => {
  it("hits deployed zombies near the body, not the rear or the queue", () => {
    const ids = ["front", "second", "healer", "queued"];
    const players = ids.map((id) => unit({ id, sourceKey: "ZombieActorRegularTier1", team: "player" }));
    const enemy = unit({ id: "e", sourceKey: "FarmStageActorBoss", team: "enemy", deathExplosion: { chance: 1, damagePercent: 20 } });
    const sim = new BattleSim(
      players, [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
    ) as unknown as Sim;
    const foe = sim.enemies[0];
    foe.x = 800;
    const at = (id: string) => sim.players.find((p) => p.id === id)!;
    Object.assign(at("front"), { state: "fight", x: foe.x - sim.engageDistance });
    Object.assign(at("second"), { state: "fight", x: foe.x - sim.engageDistance - 90 });
    Object.assign(at("healer"), { state: "fight", x: 250 }); // the Gardens' station
    Object.assign(at("queued"), { state: "waiting", x: 0 });

    sim.dealDamage(foe, foe.hp + 1, true);

    expect(at("front").hp).toBe(800);
    expect(at("second").hp).toBe(800);
    expect(at("healer").hp).toBe(1000);
    expect(at("queued").hp).toBe(1000);
  });
});
