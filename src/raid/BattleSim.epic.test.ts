import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import type { CombatUnit } from "./types";

const unit = (id: string, team: "player" | "enemy", boss = false): CombatUnit => ({
  id, sourceKey: id, team, name: id, str: 1, dex: 1, con: 100, focus: 0,
  hp: 10_000, maxHp: 10_000, attackCooldownMs: 10_000,
  attacks: [{ name: "", frequency: 1, mult: 1 }], isBoss: boss, alive: true,
  isGarden: false, isHeadless: false, abilities: [],
});

describe("Epic Boss BattleSim mode", () => {
  it("ends with an escape at the hard 30-second-style deadline", () => {
    const sim = new BattleSim([unit("p", "player")], [unit("boss", "enemy", true)], null, false, [], null, 1_000, null, null, true, true);
    for (let i = 0; i < 25 && !sim.finished; i++) sim.step(50);
    expect(sim.finished).toBe(true);
    expect(sim.outcome().escaped).toBe(true);
    expect(sim.outcome().win).toBe(false);
  });

  it("suppresses butterflies but still waits for the final brain bubble", () => {
    const sim = new BattleSim([unit("p", "player")], [unit("boss", "enemy", true)], null, false, [], null, 60_000, null, null, true, false);
    for (let i = 0; i < 300 && !sim.chargingBubble(); i++) sim.step(50);
    const charging = sim.chargingBubble();
    expect(charging?.kind).toBe("brain");
    expect(sim.popBubble("p")).toBe(true);
  });
});
