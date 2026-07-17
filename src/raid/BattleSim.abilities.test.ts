import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id,
    str: 5,
    dex: 5,
    con: 30,
    focus: 100,
    hp: 3000,
    maxHp: 3000,
    attackCooldownMs: 1000,
    attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    ...over,
  };
}

describe("Mini Buddy", () => {
  it("preserves mutation state for the raid renderer", () => {
    const player = unit({
      id: "mutant", sourceKey: "ZombieActorRegularTier1", team: "player", mutation: 1 | 8,
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([player], [enemy], null, true);
    expect(sim.units.find((candidate) => candidate.id === "mutant")?.mutation).toBe(1 | 8);
  });

  it("mounts before deployment, doubles the carrier run, then deploys both with a stun", () => {
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([brute, mini], [enemy], null, true);

    expect(sim.activatedStatus()).toContainEqual({ key: "attachMini", ready: 1 });
    expect(sim.activate("attachMini")).toBe(true);
    const b = sim.units.find((u) => u.id === "brute")!;
    const m = sim.units.find((u) => u.id === "mini")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    expect(b.buddyId).toBe("mini");
    expect(m.state).toBe("carried");

    for (let i = 0; i < 5000 && m.state === "carried"; i++) sim.step(50);
    expect(m.state).not.toBe("carried");
    expect(b.buddyId).toBeNull();
    expect(m.buddyCarrierId).toBeNull();
    expect(["advance", "fight"]).toContain(m.state);
    expect(e.stunMs).toBeGreaterThan(0);
  });
});

describe("Garden healing and formation depth", () => {
  it("holds a healer behind the line and restores a damaged deployed ally", () => {
    const fighter = unit({ id: "fighter", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier1", team: "player",
      isGarden: true, abilities: ["heal"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([fighter, healer], [enemy], null, true);
    const f = sim.units.find((u) => u.id === "fighter")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    f.state = "advance";
    h.state = "advance";
    f.formOrder = 0;
    h.formOrder = 1;
    f.hp -= 1000;

    sim.step(50);
    expect(h.slotX).toBeLessThan(f.slotX - 200);
    expect(f.hp).toBeGreaterThan(2000);
    expect(f.healFxSeq).toBe(1);
    expect(h.healCastSeq).toBe(1);
  });

  it("carries the faithful unbanded base damage on both sides (enemies NOT doubled)", () => {
    // Ground truth: base per-hit = finalPower(str×10) × mult, no flat scalar, no enemy ×2.
    // str 5, mult 1 → 50 on both sides. The player's lineup-depth band is applied at hit time.
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([player], [enemy], null, true);
    expect(sim.units.find((u) => u.id === "player")!.damage).toBe(50);
    expect(sim.units.find((u) => u.id === "enemy")!.damage).toBe(50);
  });

  it("doubles boss projectile damage", () => {
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const wall = unit({ id: "wall", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const boss = unit({ id: "boss", sourceKey: "FarmStageActorBoss", team: "enemy", isBoss: true, con: 300 });
    const sim = new BattleSim([player], [wall, boss], {
      intervalMs: 50,
      options: [{ damage: 6, weight: 1, sprite: "throw.png", spriteSize: 32 }],
    }, true);
    sim.units.find((u) => u.id === "player")!.state = "advance";
    sim.step(50);
    expect(sim.projectiles[0]?.damage).toBe(120); // raw 6 × power scale 10 × projectile multiplier 2
  });

  it("places combat priority from visual front to back within a column", () => {
    const first = unit({ id: "first", sourceKey: "ZombieActorHeadlessTier1", team: "player", isHeadless: true });
    const second = unit({ id: "second", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([first, second], [enemy], null, true);
    const a = sim.units.find((u) => u.id === "first")!;
    const b = sim.units.find((u) => u.id === "second")!;
    a.state = "advance";
    b.state = "advance";
    a.formOrder = 0;
    b.formOrder = 1;

    sim.step(50);
    expect(a.slotX).toBe(b.slotX);
    expect(a.slotY).toBeGreaterThan(b.slotY);
  });
});
