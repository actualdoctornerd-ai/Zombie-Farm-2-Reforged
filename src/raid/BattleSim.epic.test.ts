import { describe, expect, it } from "vitest";
import { BattleSim, EPIC_BOSS_HOLD_X, ENEMY_HOLD_X } from "./BattleSim";
import type { CombatUnit } from "./types";

const unit = (id: string, team: "player" | "enemy", boss = false): CombatUnit => ({
  id, sourceKey: id, team, name: id, str: 1, dex: 1, con: 100, focus: 0,
  hp: 10_000, maxHp: 10_000, attackCooldownMs: 10_000,
  attacks: [{ name: "", frequency: 1, mult: 1 }], isBoss: boss, alive: true,
  isGarden: false, isHeadless: false, abilities: [],
});

describe("Epic Boss BattleSim mode", () => {
  // Player reports 2026-11-18 (ruleset 94): Gardens "just keep attacking" the Epic Boss and
  // never heal. The epic engage put the combat zone's back edge behind the Garden station.
  it("keeps a station Garden healing, not swinging at a boss across the field", () => {
    const fighter = unit("fighter", "player");
    const medic = { ...unit("medic", "player"), isGarden: true, abilities: ["heal"], str: 50, attackCooldownMs: 1_000 };
    const sim = new BattleSim(
      [fighter, medic], [unit("boss", "enemy", true)], null, false, [],
      120_000, null, null, true, true, true, 150,
    );
    let settledTicks = 0;
    let woundedAt = -1;
    let medicFought = false;
    let healed = false;
    for (let i = 0; i < 1600 && !sim.finished && !healed; i++) {
      sim.step(50);
      const bubble = sim.chargingBubble();
      if (bubble) sim.popBubble(bubble.id);
      const f = sim.units.find((u) => u.id === "fighter")!;
      const m = sim.units.find((u) => u.id === "medic")!;
      if (m.state === "fight") medicFought = true;
      // Wait until the medic has stood at its station for 3 s, then wound the fighter.
      if (woundedAt < 0) {
        settledTicks = m.state !== "waiting" && m.state !== "charging" && f.state === "fight" ? settledTicks + 1 : 0;
        if (settledTicks >= 60) { f.hp = f.maxHp / 2; woundedAt = i; }
      } else if (f.hp > f.maxHp / 2) healed = true;
    }
    expect(woundedAt).toBeGreaterThan(0);
    expect(medicFought).toBe(false);
    expect(healed).toBe(true);
  });

  it("starts the zombie waiting crowd close to the left edge", () => {
    const players = Array.from({ length: 8 }, (_, index) => unit(`p${index}`, "player"));
    const sim = new BattleSim(players, [unit("boss", "enemy", true)]);
    const homes = sim.snapshot().units.filter((u) => u.team === "player");
    expect(Math.min(...homes.map((u) => u.x))).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...homes.map((u) => u.x))).toBeLessThanOrEqual(131);
    expect(homes.every((u) => u.state === "waiting")).toBe(true);
  });

  it("preserves an injured boss's starting health", () => {
    const boss = unit("boss", "enemy", true);
    boss.hp = 3_250;
    const sim = new BattleSim([unit("p", "player")], [boss], null, false, [], 60_000, null, null, true, true);
    expect(sim.snapshot().units.find((u) => u.id === "boss")?.hp).toBe(3_250);
  });

  it("ends with an escape at the hard 30-second-style deadline", () => {
    const sim = new BattleSim([unit("p", "player")], [unit("boss", "enemy", true)], null, false, [], 1_000, null, null, true, true);
    for (let i = 0; i < 25 && !sim.finished; i++) sim.step(50);
    expect(sim.finished).toBe(true);
    expect(sim.outcome().escaped).toBe(true);
    expect(sim.outcome().win).toBe(false);
  });

  it("suppresses butterflies but still waits for the final brain bubble", () => {
    const sim = new BattleSim([unit("p", "player")], [unit("boss", "enemy", true)], null, false, [], 60_000, null, null, true, false);
    for (let i = 0; i < 300 && !sim.chargingBubble(); i++) sim.step(50);
    const charging = sim.chargingBubble();
    expect(charging?.kind).toBe("brain");
    expect(sim.popBubble("p")).toBe(true);
  });

  it("drops an Epic Boss from above, then holds it for the landing beat", () => {
    const sim = new BattleSim(
      [unit("p", "player")], [unit("boss", "enemy", true)], null, false, [],
      60_000, null, null, true, true, true, 150
    );
    const before = sim.snapshot().units.find((u) => u.id === "boss")!;
    expect(before.state).toBe("falling");
    expect(before.x).toBe(EPIC_BOSS_HOLD_X);
    expect(before.x).toBeGreaterThan(500);
    expect(before.x).toBeLessThan(700);
    expect(before.y).toBeLessThan(-3_000);
    sim.step(500);
    const falling = sim.snapshot().units.find((u) => u.id === "boss")!;
    expect(falling.state).toBe("falling");
    expect(falling.y).toBeGreaterThan(before.y);
    sim.step(500);
    const landed = sim.snapshot().units.find((u) => u.id === "boss")!;
    expect(landed.state).toBe("landing");
    expect(landed.y).toBe(280);
    sim.step(500);
    expect(sim.snapshot().units.find((u) => u.id === "boss")?.state).toBe("hold");
  });

  it("jumps the Circus Ringmaster directly from its perch to the ground", () => {
    const boss = unit("boss", "enemy", true);
    boss.sourceKey = "CircusStageActorBoss";
    const sim = new BattleSim([unit("p", "player")], [boss]);

    sim.step(50);
    const jumping = sim.snapshot().units.find((u) => u.id === "boss")!;
    expect(jumping.state).toBe("descending");
    expect(jumping.x).toBeLessThan(915);
    expect(jumping.y).toBeGreaterThan(-150);

    for (let i = 0; i < 12; i++) sim.step(50);
    const landed = sim.snapshot().units.find((u) => u.id === "boss")!;
    expect(landed.state).toBe("hold");
    expect(landed.x).toBe(ENEMY_HOLD_X);
    expect(landed.y).toBe(280);
  });
});
