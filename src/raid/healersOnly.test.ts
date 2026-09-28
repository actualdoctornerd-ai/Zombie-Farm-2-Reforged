// AN ARMY DOWN TO ITS GARDENS HAS LOST (owner, 2026-09-27).
//
// A station Garden cannot hurt anything: it heals, and its laser only fires over a zombie
// standing ahead of it. So once every other zombie is dead, the fight is decided — it used
// to run on until the clock, minutes of Gardens standing at the station. The sim now ends it
// there as an ordinary loss, with the Gardens coming home as survivors.
import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import { RAID_TICK_MS } from "./replay";
import type { CombatUnit } from "./types";

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 0, dex: 2, con: 10, focus: 100, hp: 1e6, maxHp: 1e6,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const garden = (id: string, abilities: string[] = ["heal"]) =>
  unit({ id, sourceKey: "ZombieActorGardenTier1", isGarden: true, abilities });
const enemy = () => unit({ id: "e1", team: "enemy", sourceKey: "AlienStageActorMinion" });

const fight = (players: CombatUnit[]) => buildFight({
  playerUnits: players, enemyUnits: [enemy()], concentration: true, roundMs: 10 * 60 * 1000,
});

function run(sim: ReturnType<typeof fight>, maxTicks = 200): number {
  let t = 0;
  while (sim.step(RAID_TICK_MS) && t < maxTicks) t++;
  return t;
}

describe("the healers-only end", () => {
  it("ends the fight as soon as only station Gardens are standing", () => {
    const sim = fight([garden("g1"), garden("g2")]);
    run(sim);
    expect(sim.finished).toBe(true);
    const out = sim.outcome();
    expect(out.win).toBe(false);
    expect(out.healersOnly).toBe(true);
    expect(out.outOfTime).toBe(false);
    expect(out.survivors.sort()).toEqual(["g1", "g2"]);
  });

  it("keeps going while any fighter is alive, deployed or still waiting", () => {
    const sim = fight([unit({ id: "p1" }), garden("g1")]);
    run(sim, 100);
    expect(sim.finished).toBe(false);
  });

  it("ends it the moment the last fighter falls", () => {
    const sim = fight([unit({ id: "p1" }), garden("g1")]);
    run(sim, 20);
    expect(sim.finished).toBe(false);
    const p1 = sim.units.find((u) => u.id === "p1")!;
    p1.alive = false; p1.hp = 0; p1.state = "dead";
    run(sim, 5);
    expect(sim.finished).toBe(true);
    expect(sim.outcome().healersOnly).toBe(true);
  });

  it("waits while a Garden still has a Resurrect banked for a fallen zombie", () => {
    const sim = fight([unit({ id: "p1" }), garden("g1", ["ressurect"])]);
    run(sim, 20);
    const internals = sim as unknown as { fallen: string[] };
    const p1 = sim.units.find((u) => u.id === "p1")!;
    p1.alive = false; p1.hp = 0; p1.state = "dead";
    internals.fallen.push("p1");
    sim.step(RAID_TICK_MS);
    // Either it revived p1 (a fighter again) or it is still able to — not over yet.
    expect(sim.finished).toBe(false);
  });
});
