import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import { buildFight } from "./buildFight";
import { buildPlayerUnits, buildUnitsForKeys } from "./CombatEngine";
import {
  applyEndlessBoon, applyEndlessOrder, beginEndlessRun, endlessBossDraft, endlessMaxStartTier,
  endlessPlayerUnits, endlessWavePlan, ENDLESS_MAX_DEPLOY_REDUCTION, ENDLESS_MODIFIERS, ENDLESS_TEMPORARY_ZOMBIES,
  type EndlessBuildBoon, type EndlessModifierId,
} from "./endless";
import { endlessApplyBoon, endlessCarryFromSim, endlessFightConfig, endlessSimFor } from "./endlessFight";
import { endlessExpectedZwamps, endlessLootWeightTotal, endlessMilestoneRewards, rollEndlessBossLoot, rollEndlessLocationZombie } from "./endlessLoot";
import { makeOwned } from "../zombie/types";
import type { ZombieDef } from "../assets";
import type { CombatUnit, EnemyStat } from "./types";

const ZOMBIES = zombiesJson as ZombieDef[];
const party = (keys: string[]): CombatUnit[] => buildPlayerUnits(
  keys.map((key, i) => makeOwned(`z${i}`, ZOMBIES.find((z) => z.key === key) as never, 0, 0, 0, 0)),
  { abilitySlotUnlocked: () => true, playerLevel: 45 },
);
const enemy = (key: string) => buildUnitsForKeys([key], null, enemyStats as unknown as Record<string, EnemyStat>, attacks)[0];
const REGULAR = "ZombieActorRegularTier1";
const HEADLESS = "ZombieActorHeadlessTier1";
const GARDEN = "ZombieActorGardenTier1";

describe("Endless modifiers", () => {
  it("never reach the boss", () => {
    for (const modifier of Object.keys(ENDLESS_MODIFIERS) as EndlessModifierId[]) {
      const stop = { location: "pirate" as const, modifier };
      const run = { ...beginEndlessRun("endless", []), nextWave: 6, stop };
      const config = endlessFightConfig(run, 45);
      expect(endlessWavePlan("endless", 6, stop).modifier).toBeNull();
      expect(config.modifier).toBeNull();
      expect(config.location).toBe("pirate");
      const plain = endlessFightConfig({ ...run, stop: { location: "pirate", modifier: null } }, 45);
      expect(config.enemyUnits[0].maxHp).toBe(plain.enemyUnits[0].maxHp);
      expect(config.enemyUnits[0].str).toBe(plain.enemyUnits[0].str);
      expect(config.enemyUnits[0].stunResist).toBeUndefined();
      expect(config.timeLimitMs).toBe(plain.timeLimitMs);
    }
  });
});

describe("Endless build boons", () => {
  const keys = [REGULAR, REGULAR, REGULAR, REGULAR, REGULAR, REGULAR, REGULAR, REGULAR];
  const base = beginEndlessRun("endless", party(keys));
  const units = (kind: EndlessBuildBoon, run = base) => endlessPlayerUnits(applyEndlessBoon(run, { kind }));

  it("read the army's order, so reordering changes who gets them", () => {
    const plain = endlessPlayerUnits(base);
    const vanguard = units("vanguard");
    expect(vanguard[0].maxHp).toBeGreaterThan(plain[0].maxHp);
    expect(vanguard[3].maxHp).toBeLessThan(plain[3].maxHp);
  });

  it("halves the back of the line's falloff with Rearguard, rather than trading stats", () => {
    const run = { ...applyEndlessBoon(base, { kind: "rearguard" }), nextWave: 1 };
    expect(endlessPlayerUnits(run).map((u) => u.attacks[0].mult)).toEqual(endlessPlayerUnits(base).map((u) => u.attacks[0].mult));
    expect(endlessFightConfig(run, 45).endlessMechanics?.rearguard).toBe(true);
    expect(endlessFightConfig({ ...base, nextWave: 1 }, 45).endlessMechanics?.rearguard).toBeFalsy();
  });

  it("lifts one stat for everyone, or every stat for one class", () => {
    const mixed = beginEndlessRun("endless", party([REGULAR, HEADLESS, GARDEN]));
    const plain = endlessPlayerUnits(mixed);
    const teeth = units("sharp-teeth", mixed);
    teeth.forEach((u, i) => expect(u.attacks[0].mult).toBeCloseTo((plain[i].attacks[0].mult ?? 1) * 1.1, 6));
    const quick = units("quick-hands", mixed);
    quick.forEach((u, i) => expect(u.attackCooldownMs).toBe(Math.round(plain[i].attackCooldownMs / 1.1)));
    const drill = units("drill-headless", mixed);
    expect(drill[1].maxHp).toBeGreaterThan(plain[1].maxHp);
    expect(drill[1].attackCooldownMs).toBeLessThan(plain[1].attackCooldownMs);
    expect(drill[0].maxHp).toBe(plain[0].maxHp);
  });

  it("trades within what a class is for", () => {
    const mixed = beginEndlessRun("endless", party([REGULAR, HEADLESS, GARDEN]));
    const plain = endlessPlayerUnits(mixed);
    const ram = units("battering-ram", mixed);
    expect(ram[1].attackCooldownMs).toBe(Math.round(plain[1].attackCooldownMs / 1.4));
    expect(ram[1].maxHp).toBeLessThan(plain[1].maxHp);
    expect(ram[0]).toEqual(plain[0]);
    expect(units("bulwark", mixed)[1].maxHp).toBe(Math.round(plain[1].maxHp * 1.25));
    expect(units("green-thumb", mixed)[2].healMult).toBe(1.5);
    expect(units("green-thumb", mixed)[0].healMult ?? 1).toBe(1);
  });

  it("caps deployment boons at an 80% cut to the deploy charge", () => {
    let run = base;
    for (let i = 0; i < 6; i++) run = applyEndlessBoon(run, { kind: "deployment", percent: 20 });
    expect(run.deploymentSpeedBonus).toBe(ENDLESS_MAX_DEPLOY_REDUCTION);
    const sim = endlessSimFor(endlessFightConfig({ ...run, nextWave: 1 }, 45));
    expect((sim as unknown as { focusChargeMs: number }).focusChargeMs).toBeCloseTo(3600 * 0.2, 6);
  });

  it("sends the loaned Special in with the army's third deploy, past the queue", () => {
    const lent = ENDLESS_TEMPORARY_ZOMBIES[0];
    const run = { ...endlessApplyBoon(base, { kind: "temporary-zombie", key: lent.key, name: lent.name }, 45), nextWave: 1 };
    const sim = endlessSimFor(endlessFightConfig(run, 45));
    const players = sim.units.filter((u) => u.team === "player") as unknown as { id: string; state: string }[];
    const loaned = players.find((u) => u.id.startsWith("temp-"))!;
    const own = players.filter((u) => u !== loaned);
    const out = () => own.filter((u) => u.state !== "waiting" && u.state !== "charging").length;
    let loanedAt = -1;
    for (let i = 0; i < 4000 && loanedAt < 0; i++) {
      sim.step(50);
      if (loaned.state !== "waiting" && loaned.state !== "charging") loanedAt = out();
    }
    expect(loanedAt).toBe(3);
  });

  it("carries a fight's health as a share, so a boosted body comes back in step", () => {
    const run = { ...applyEndlessBoon(base, { kind: "vanguard" }), nextWave: 1 };
    const sim = endlessSimFor(endlessFightConfig(run, 45));
    const first = sim.units.find((u) => u.team === "player")!;
    first.hp = first.maxHp / 2;
    const carried = endlessCarryFromSim(run, sim).units[0];
    expect(carried.hp / carried.maxHp).toBeCloseTo(0.5, 1);
    expect(carried.maxHp).toBe(base.units[0].maxHp);
  });

  it("lends a temporary zombie for the run, at the back and off the roster", () => {
    const lent = ENDLESS_TEMPORARY_ZOMBIES[0];
    const run = endlessApplyBoon(base, { kind: "temporary-zombie", key: lent.key, name: lent.name }, 45);
    expect(run.units).toHaveLength(base.units.length + 1);
    const added = run.units[run.units.length - 1];
    expect(added.sourceKey).toBe(lent.key);
    expect(added.id).toMatch(/^temp-/);
    const twice = endlessApplyBoon(run, { kind: "temporary-zombie", key: lent.key, name: lent.name }, 45);
    expect(new Set(twice.units.map((u) => u.id)).size).toBe(twice.units.length);
  });

  it("offers real catalog zombies, the same one all week", () => {
    for (const { key } of ENDLESS_TEMPORARY_ZOMBIES) expect(ZOMBIES.some((z) => z.key === key)).toBe(true);
    for (let wave = 3; wave < 60; wave += 3) {
      const offers = endlessBossDraft("endless", wave, "7").boons.filter((b) => b.kind === "temporary-zombie");
      expect(offers).toEqual(endlessBossDraft("endless", wave, "7").boons.filter((b) => b.kind === "temporary-zombie"));
    }
  });
});

describe("Endless army order", () => {
  const run = beginEndlessRun("endless", party([REGULAR, REGULAR, REGULAR]));
  it("takes exactly the zombies brought, in any order", () => {
    const ids = run.units.map((u) => u.id);
    expect(applyEndlessOrder(run, [...ids].reverse())?.units.map((u) => u.id)).toEqual([...ids].reverse());
  });
  it("refuses anything else", () => {
    const ids = run.units.map((u) => u.id);
    expect(applyEndlessOrder(run, ids.slice(1))).toBeNull();
    expect(applyEndlessOrder(run, [ids[0], ids[0], ids[1]])).toBeNull();
    expect(applyEndlessOrder(run, [...ids.slice(1), "mausoleum-zombie"])).toBeNull();
    expect(applyEndlessOrder(run, "nope")).toBeNull();
  });
});

describe("Endless tier skipping", () => {
  it("opens one tier per 5 levels, up to T4 at level 45, in normal Endless only", () => {
    expect([30, 34, 35, 40, 44, 45, 50].map((l) => endlessMaxStartTier("endless", l))).toEqual([1, 1, 2, 3, 3, 4, 4]);
    expect(endlessMaxStartTier("nightmare", 50)).toBe(1);
  });
  it("starts the run at that tier's first wave", () => {
    const run = beginEndlessRun("endless", [], "0", 4);
    expect(run.startWave).toBe(10);
    expect(run.nextWave).toBe(10);
  });
});

describe("Endless Zwamp Thing and milestones", () => {
  const zwamps = (tier: number, swamp: number, soFar = 1) =>
    rollEndlessBossLoot(tier, "farm", 0, 0, swamp, soFar).filter((r) => r.name === "Zwamp Thing").length;
  it("rises from T3, gives a run its first at T7, and drops at every boss from T8", () => {
    expect(zwamps(2, 0)).toBe(0);
    expect(zwamps(3, 0.04)).toBe(1);
    expect(zwamps(3, 0.06)).toBe(0);
    expect(zwamps(6, 0.12)).toBe(1);
    expect(zwamps(6, 0.13)).toBe(0);
    expect(zwamps(7, 0.99, 0)).toBe(1); // none yet this run: T7 guarantees one
    expect(zwamps(7, 0.99, 1)).toBe(0);
    expect(zwamps(7, 0.1, 1)).toBe(1); // 15% otherwise
    expect(zwamps(8, 0.99)).toBe(1); // one at every boss from T8, never two
    expect(zwamps(12, 0)).toBe(1);
  });
  it("averages about two by the end of T8 on a repeat run", () => {
    expect(endlessExpectedZwamps(8)).toBeGreaterThan(1.9);
    expect(endlessExpectedZwamps(8)).toBeLessThan(2.2);
  });
  it("lets each location turn up its own invasion's rare zombies, at that invasion's rate", () => {
    expect(rollEndlessLocationZombie("pirate", 0.0139, 0)).toMatchObject({ key: "ZombieActorMerZombie" });
    expect(rollEndlessLocationZombie("pirate", 0.0139, 0.9)).toMatchObject({ key: "ZombieActorPoseidon" });
    expect(rollEndlessLocationZombie("pirate", 0.0141, 0)).toBeNull();
    expect(rollEndlessLocationZombie("ninja", 0.0159, 0.5)).toMatchObject({ key: "ZombieActorNinjombie" });
    expect(rollEndlessLocationZombie("ninja", 0.0159, 0.7)).toMatchObject({ key: "ZombieActorMasterNinjombie" });
    expect(rollEndlessLocationZombie("alien", 0.0199, 0)).toMatchObject({ key: "ZombieActorZastronaut" });
    expect(rollEndlessLocationZombie("farm", 0.0099, 0.99)).toMatchObject({ key: "ZombieActorOldMcZombie" });
    expect(rollEndlessLocationZombie("video-game", 0.0199, 0.1)).toMatchObject({ key: "ZombieActorRegularVideoGame" });
  });
  it("keeps every loot row's weights summing to 100", () => {
    for (const tier of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(endlessLootWeightTotal("boss", tier), `boss T${tier}`).toBe(100);
      expect(endlessLootWeightTotal("floor", tier), `floor T${tier}`).toBe(100);
    }
  });
  it("pays the first clears, with Medusa only on Nightmare", () => {
    expect(endlessMilestoneRewards("endless", 1)).toEqual([expect.objectContaining({ key: "brain_ticket", quantity: 2 })]);
    expect(endlessMilestoneRewards("endless", 2)).toEqual([expect.objectContaining({ kind: "brains", quantity: 1 })]);
    expect(endlessMilestoneRewards("endless", 3)).toEqual([expect.objectContaining({ key: "ZombieActorZwampThing" })]);
    expect(endlessMilestoneRewards("nightmare", 5)).toEqual([expect.objectContaining({ key: "ZombieActorMedusa" })]);
    expect(endlessMilestoneRewards("endless", 4)).toEqual([expect.objectContaining({ kind: "brains", quantity: 3 })]);
    expect(endlessMilestoneRewards("endless", 5)).toEqual([expect.objectContaining({ kind: "perk", perk: "crypt" })]);
    expect(endlessMilestoneRewards("endless", 6)).toEqual([expect.objectContaining({ kind: "perk", perk: "shed" })]);
    expect(endlessMilestoneRewards("endless", 7)).toEqual([expect.objectContaining({ kind: "perk", perk: "expansion" })]);
    expect(endlessMilestoneRewards("endless", 8)).toEqual([expect.objectContaining({ kind: "perk", perk: "veterancy" })]);
    // Past T8 there is no first-clear prize: every boss win pays brains instead.
    expect(endlessMilestoneRewards("endless", 9)).toEqual([]);
  });
});

/** The private corners of the sim these rules live in. */
interface SimInside {
  boss: { state: string; stunMs: number; stoneMs: number; chargeFrac: number } | null;
  bossFreezeMs: number;
  bossFreezeLockMs: number;
  pendingSpecial: unknown;
  specialCast: number;
  actionCd: number;
  releaseCharger(p: unknown): void;
  stepMedusa(dt: number): void;
  stepBossActions(dt: number): void;
  runSpecial(sp: unknown): void;
}

describe("Medusa", () => {
  const fight = (keys: string[], foe: CombatUnit) => {
    const sim = buildFight({ playerUnits: party(keys), enemyUnits: [foe] });
    return { sim, inside: sim as unknown as SimInside };
  };
  const bossUnit = () => ({ ...enemy("FarmStageActorBoss"), isBoss: true });

  it("freezes a perched boss for 5 s on deploy, then cannot again for 20 s", () => {
    const { sim, inside } = fight(["ZombieActorMedusa", "ZombieActorMedusa"], bossUnit());
    inside.boss!.state = "structure";
    const [a, b] = sim.units.filter((u) => u.team === "player");
    inside.releaseCharger(a);
    expect(inside.bossFreezeMs).toBe(5_000);
    expect(inside.boss!.stoneMs).toBe(5_000);
    inside.stepMedusa(1_000);
    expect(inside.bossFreezeMs).toBe(4_000);
    inside.releaseCharger(b);
    expect(inside.bossFreezeMs).toBe(4_000);
  });

  it("stalls what the boss was doing, rather than cancelling it", () => {
    const { inside } = fight(["ZombieActorMedusa"], bossUnit());
    inside.pendingSpecial = { name: "launch", castMs: 1_000, cooldownMs: 1_000, damage: 1, weight: 1 };
    inside.specialCast = 500;
    inside.bossFreezeMs = 1_000;
    (inside as unknown as { actions: unknown[] }).actions = [{}];
    inside.boss!.state = "structure";
    inside.stepBossActions(50);
    expect(inside.specialCast).toBe(500);
    expect(inside.pendingSpecial).toBeTruthy();
  });

  it("does not touch a boss off the perch, and only other zombies do nothing at all", () => {
    const { sim, inside } = fight(["ZombieActorMedusa"], bossUnit());
    inside.boss!.state = "fight";
    inside.releaseCharger(sim.units.find((u) => u.team === "player"));
    expect(inside.bossFreezeMs).toBe(0);
    const other = fight([REGULAR], bossUnit());
    other.inside.boss!.state = "structure";
    other.inside.releaseCharger(other.sim.units.find((u) => u.team === "player"));
    expect(other.inside.bossFreezeMs).toBe(0);
  });

  it("needs her card slots: Stone Gaze opens with slot 3 and Petrify with slot 4", () => {
    const locked = (open: number) => buildFight({
      playerUnits: buildPlayerUnits(
        [makeOwned("m", ZOMBIES.find((z) => z.key === "ZombieActorMedusa") as never, 0, 0, 0, 0)],
        { abilitySlotUnlocked: (slot) => slot <= open, playerLevel: 45 },
      ),
      enemyUnits: [bossUnit()],
    });
    for (const [open, freezes] of [[2, false], [3, false], [4, true]] as const) {
      const sim = locked(open);
      const inside = sim as unknown as SimInside;
      inside.boss!.state = "structure";
      const medusa = sim.units.find((u) => u.team === "player")! as unknown as { gazeReady: boolean };
      inside.releaseCharger(medusa);
      expect(inside.bossFreezeMs > 0).toBe(freezes);
      expect(medusa.gazeReady).toBe(open >= 3);
    }
  });

  it("stuns the first enemy she sees for 2 s, once, and greys it out", () => {
    const { sim, inside } = fight(["ZombieActorMedusa"], enemy("FarmStageActorFarmhand"));
    const foe = sim.units.find((u) => u.team === "enemy")! as unknown as { state: string; stunMs: number; stoneMs: number };
    foe.state = "fight";
    inside.releaseCharger(sim.units.find((u) => u.team === "player"));
    inside.stepMedusa(50);
    expect(foe.stunMs).toBe(2_000);
    expect(foe.stoneMs).toBe(2_000);
    foe.stunMs = 0;
    inside.stepMedusa(50);
    expect(foe.stunMs).toBe(0);
  });

  it("honours stun resistance", () => {
    const { sim, inside } = fight(["ZombieActorMedusa"], { ...enemy("FarmStageActorFarmhand"), stunResist: 1 });
    const foe = sim.units.find((u) => u.team === "enemy")! as unknown as { state: string; stunMs: number; stoneMs: number };
    foe.state = "fight";
    inside.releaseCharger(sim.units.find((u) => u.team === "player"));
    inside.stepMedusa(50);
    expect(foe.stunMs).toBe(0);
    expect(foe.stoneMs).toBe(0);
  });
});

describe("Dr. Groundhog in Endless", () => {
  const bossAt = (nextWave: number) => endlessFightConfig({ ...beginEndlessRun("endless", party([REGULAR])), nextWave }, 45);

  it("adds a move a tier: bite only, then the slam, then the launch", () => {
    expect(bossAt(3).enemyUnits[0].charge).toBeFalsy();
    expect(bossAt(3).bossSpecials).toEqual([]);
    expect(bossAt(6).enemyUnits[0].charge).toMatchObject({ target: "front-deployed", tapReduce: 0.1 });
    expect(bossAt(6).bossSpecials).toEqual([]);
    expect(bossAt(9).bossSpecials.map((s) => s.name)).toEqual(["launch"]);
  });

  it("weakens a slam by tapping during its wind-up, to half at most, and not otherwise", () => {
    const sim = endlessSimFor(bossAt(6));
    const boss = sim.units.find((u) => u.team === "enemy")! as unknown as { id: string; chargeMs: number; chargeTapScale: number };
    expect(sim.tapCharge(boss.id)).toBe(false);
    boss.chargeMs = 1_000;
    expect(sim.tapCharge(boss.id)).toBe(true);
    expect(boss.chargeTapScale).toBeCloseTo(0.9);
    for (let i = 0; i < 10; i++) sim.tapCharge(boss.id);
    expect(boss.chargeTapScale).toBeCloseTo(0.5);
    expect(sim.tapCharge(boss.id)).toBe(false);
  });

  it("launches the front zombie to the back of the lane", () => {
    const sim = endlessSimFor(bossAt(9));
    const zombie = sim.units.find((u) => u.team === "player")! as unknown as { state: string; x: number; knockBackToX: number; knockBackSpeed: number; hp: number };
    zombie.state = "fight";
    zombie.x = 600;
    const before = zombie.hp;
    (sim as unknown as SimInside).runSpecial({ name: "launch", damage: 1, castMs: 0, cooldownMs: 0, weight: 1 });
    expect(zombie.knockBackSpeed).toBeGreaterThan(0);
    expect(zombie.knockBackToX).toBeLessThan(600);
    expect(zombie.state).toBe("advance");
    expect(zombie.hp).toBeLessThan(before);
  });

  it("loses a move mid-cast to a stun, in Endless", () => {
    const sim = endlessSimFor(bossAt(9));
    const inside = sim as unknown as SimInside;
    (inside as unknown as { actions: unknown[] }).actions = [{ kind: "special", weight: 1, special: bossAt(9).bossSpecials[0] }];
    inside.boss!.state = "fight";
    inside.pendingSpecial = bossAt(9).bossSpecials[0];
    inside.boss!.stunMs = 500;
    inside.stepBossActions(50);
    expect(inside.pendingSpecial).toBeNull();
  });
});
