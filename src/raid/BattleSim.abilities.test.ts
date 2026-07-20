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
    expect(sim.projectiles[0]?.damage).toBe(22); // round(raw 6 × chip scale 1.75) × projectile multiplier 2
  });

  it("preserves explicitly harmless debris at zero damage", () => {
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const wall = unit({ id: "wall", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const boss = unit({ id: "boss", sourceKey: "BeachStageActorBoss", team: "enemy", isBoss: true, con: 300 });
    const sim = new BattleSim([player], [wall, boss], {
      intervalMs: 50,
      options: [{ damage: 0, weight: 1, sprite: "harmless.png", spriteSize: 32 }],
    }, true);
    sim.units.find((u) => u.id === "player")!.state = "advance";
    sim.step(50);
    expect(sim.projectiles[0]?.damage).toBe(0);
  });

  it("applies the player-zombie one-shot floor to boss projectiles", () => {
    const player = unit({
      id: "player", sourceKey: "ZombieActorRegularTier1", team: "player",
      hp: 100, maxHp: 100, con: 1, dex: 1,
    });
    const wall = unit({
      id: "wall", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      str: 0, dex: 0.01, attackCooldownMs: 100_000, con: 300,
    });
    const boss = unit({
      id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true,
      str: 0, dex: 0.01, attackCooldownMs: 100_000, con: 300,
    });
    const sim = new BattleSim([player], [wall, boss], null, true, [
      { name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 100_000, damage: 100 },
    ]);
    const p = sim.units.find((u) => u.id === "player")!;
    p.state = "advance";
    sim.step(16); // select the special
    sim.step(16); // launch the straight projectile
    for (let i = 0; i < 200 && p.hp === 100; i++) sim.step(16);
    expect(p.hp).toBe(1);
    expect(p.alive).toBe(true);
  });

  it("advances specials independently when a boss has no throw actions", () => {
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const wall = unit({ id: "wall", sourceKey: "AlienStageActorMinion", team: "enemy", con: 300 });
    const boss = unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, con: 300 });
    const sim = new BattleSim([player], [wall, boss], null, true, [
      { name: "summonBoss", weight: 50, castMs: 50, cooldownMs: 300, damage: 0 },
      { name: "alienLaser", weight: 30, castMs: 50, cooldownMs: 300, damage: 0 },
    ]);
    sim.units.find((u) => u.id === "player")!.state = "advance";
    const seen = new Set<string>();
    for (let i = 0; i < 200 && seen.size < 2; i++) {
      sim.step(50);
      const pending = sim.snapshot().pendingSpecial;
      if (pending) seen.add(pending.name);
    }
    expect(seen).toEqual(new Set(["summonBoss", "alienLaser"]));
    expect(sim.snapshot().throwCount).toBe(0);
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
