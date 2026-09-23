// The Circus & Video Games second line (raid 14). See docs/POST_45_PROGRESSION.md and
// dualInvasion.ts.
//
// What these pin is the SHAPE: that a copy is made of the zombie the player chose to send,
// that it lands behind the line and the line does not turn round for it, that it can never
// hang the fight, and that a tower fights at the height its remaining hit points support.
// The counts, the fractions and the grow clock are tuning and will move.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  copiesFor, COPY_PASSIVE_ABILITIES, COPY_RAID_ID, COPY_STATION_X, MAX_TIER, MIN_TIER,
  RINGMASTER_EARLY_TIER, ringmasterDropMs, STACK_COUNT, STACK_MAX_HEIGHT, stacksFor,
} from "./dualInvasion";
import { circusStacksFor } from "./fightConfig";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 10, dex: 2, con: 10, focus: 100, hp: 1000, maxHp: 1000,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;
const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };
const copies = (sim: BattleSim) => sim.units.filter((u) => u.isCopy && u.alive);

/** A zombie sent out FIRST, purely to be the line the trapeze drops behind. Nothing is
 *  copied until somebody is past the drop point, so a fixture that wants to see a copy
 *  has to field at least two. */
const scout = () => unit({ id: "scout", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 });

// The players below are `str: 0` on purpose. A zombie is copied AT THE MOMENT IT DEPLOYS,
// which is the one moment it is standing behind the drop point rather than past it — so it
// is not latched out, and it fights its own reflection on the spot. That is the mechanic
// working (a reinforcement has to cut its way in), and it is also how the first draft of
// these tests failed: every copy was dead again before the assertion ran, and one test
// found the SECOND zombie's copy and reported the wrong species.

/** A raid-14-shaped fight: a punchbag wave, and the copy rule for a rung. */
function copyFight(tier: number, players: CombatUnit[], extraEnemies: CombatUnit[] = []) {
  const enemies = [
    unit({ id: "minion", sourceKey: "CircusStageActorMinion1", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
    unit({ id: "boss", sourceKey: "CircusStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
    ...extraEnemies,
  ];
  return new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, undefined, null, null, false, copiesFor(COPY_RAID_ID, tier)
  );
}

describe("the copies", () => {
  it("belong to this invasion alone, and tighten up the ladder", () => {
    for (const other of [1, 6, 9, 12, 13, 15]) expect(copiesFor(other, 1)).toBeNull();
    const low = copiesFor(COPY_RAID_ID, MIN_TIER)!;
    const top = copiesFor(COPY_RAID_ID, MAX_TIER)!;
    expect(low.maxAlive).toBeLessThan(top.maxAlive);
    expect(low.hpFraction).toBeLessThan(top.hpFraction);
    expect(low.keepPassives, "the passives are the top rung's own dial").toBe(false);
    expect(top.keepPassives).toBe(true);
  });

  it("copies the zombie the player actually sent, when it deploys", () => {
    // Per deployment, which is the whole game of it: the queue order is the player's, so
    // what the circus gets to copy is their choice.
    const sim = copyFight(MIN_TIER, [
      scout(),
      unit({ id: "z0", group: "Large", sourceKey: "ZombieActorLargeTier4", str: 0, con: 20 }),
      unit({ id: "z1", group: "Small", sourceKey: "ZombieActorSmallTier4", str: 0, con: 4 }),
    ]);
    expect(copies(sim), "nothing before anyone has gone out").toHaveLength(0);
    run(sim, 30_000);
    const mirror = copies(sim)[0];
    expect(mirror, "the zombie that deployed behind the line has been copied").toBeDefined();
    expect(mirror.sourceKey).toBe("ZombieActorLargeTier4");
    expect(mirror.team).toBe("enemy");
  });

  it("lands behind the line, and the line does not turn round for it", () => {
    const sim = copyFight(MIN_TIER, [scout(), unit({ id: "z0", group: "Regular", str: 0 })]);
    run(sim, 30_000);
    const mirror = copies(sim)[0];
    expect(mirror.x, "in the army's rear, not at the doorway").toBe(COPY_STATION_X);
    expect(mirror.isBlocker, "which is what keeps the front line out of that fight").toBe(true);
    expect(mirror.anchorsLine, "and what stops the army marching back to meet it").toBe(false);
  });

  it("latches out whoever had already marched past, and nobody else", () => {
    // The two halves of the mechanic, in one fight. A zombie is copied the moment it
    // deploys — when it is standing at the staging slot, BEHIND the drop point — so it is
    // not latched and has to cut its way in past its own reflection. Everyone already up
    // at the line is latched out and never turns round.
    const sim = copyFight(MAX_TIER, [
      unit({ id: "ahead", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 }),
      unit({ id: "behind", group: "Regular", str: 0 }),
    ]);
    run(sim, 30_000);
    const ahead = sim.units.find((u) => u.id === "ahead")!;
    const behind = sim.units.find((u) => u.id === "behind")!;
    const late = copies(sim)[0];
    expect(ahead.x, "the first one is up at the line").toBeGreaterThan(COPY_STATION_X);
    expect(ahead.passedBlockers, "so it never turns round").toContain(late.id);
    expect(behind.passedBlockers, "the one it was made from has to fight through it")
      .not.toContain(late.id);
  });

  it("carries the original's strength at a fraction of its life", () => {
    const cfg = copiesFor(COPY_RAID_ID, MIN_TIER)!;
    const sim = copyFight(MIN_TIER, [scout(), unit({ id: "z0", group: "Regular", str: 0, con: 30 })]);
    run(sim, 30_000);
    const original = sim.units.find((u) => u.id === "z0")!;
    const mirror = copies(sim)[0];
    expect(mirror.damage, "exactly as hard as what it copied").toBe(original.damage);
    expect(mirror.maxHp).toBe(Math.round(original.maxHp * cfg.hpFraction));
    expect(mirror.maxHp).toBeLessThan(original.maxHp);
  });

  it("never holds an activated move, and holds passives only at the top", () => {
    const armed = ["explode", "bash", "attachMini", "laserBeam", "heal"];
    for (const [tier, expected] of [[MIN_TIER, []], [MAX_TIER, ["laserBeam"]]] as const) {
      const sim = copyFight(tier, [scout(), unit({ id: "z0", group: "Regular", str: 0, abilities: [...armed] })]);
      run(sim, 30_000);
      expect(copies(sim)[0].abilities, `tier ${tier}`).toEqual(expected);
    }
    // A tap is the reason: a copy has nobody to press its buttons, exactly as a PvP
    // defender does not. And the heal is off the list on purpose — copies healing each
    // other is a fight the player cannot finish from where they are standing.
    expect(COPY_PASSIVE_ABILITIES).not.toContain("heal");
    expect(COPY_PASSIVE_ABILITIES).not.toContain("explode");
  });

  it("stops at the rung's cap however many zombies deploy", () => {
    const army = [scout(), ...Array.from({ length: 8 }, (_, i) => unit({ id: `z${i}`, group: "Regular", str: 0 }))];
    for (const tier of [MIN_TIER, MAX_TIER]) {
      const sim = copyFight(tier, army.map((u) => ({ ...u })));
      run(sim, 90_000);
      expect(copies(sim).length, `tier ${tier}`).toBeLessThanOrEqual(copiesFor(COPY_RAID_ID, tier)!.maxAlive);
    }
  });

  it("cannot hang the fight it is standing in", () => {
    // A copy nobody can reach must not be able to hold a won fight open to the settle cap
    // — which is exactly the orphaned-wall stall ruleset 59 fixed. Blockers are outside
    // the win condition, and this is the test that says a copy is one of them.
    const sim = copyFight(MAX_TIER, [scout(), unit({ id: "z0", group: "Regular", str: 0 })]);
    run(sim, 30_000);
    expect(copies(sim).length).toBeGreaterThan(0);
    for (const e of sim.units) if (e.team === "enemy" && !e.isCopy) { e.alive = false; e.hp = 0; }
    run(sim, 2_000);
    expect(sim.finished, "the fight ends with the copy still standing").toBe(true);
  });
});

describe("the stacks", () => {
  const assets = {
    enemyStats: enemyStatsJson as Record<string, EnemyStat>,
    raidAttacks: attacksJson as Record<string, AttackDef>,
  };
  const raid14 = (raidsJson as RaidDef[]).find((r) => r.id === COPY_RAID_ID)!;

  it("are three towers on their own clocks, and this invasion's alone", () => {
    const built = circusStacksFor(assets, raid14, MIN_TIER);
    expect(built).toHaveLength(STACK_COUNT);
    expect(built.every((u) => u.stack)).toBe(true);
    const times = built.map((u) => u.deployAtMs!);
    expect([...times].sort((a, b) => a - b), "spaced, not one wall").toEqual(times);
    expect(new Set(times).size, "each on its own beat").toBe(STACK_COUNT);
    for (const other of (raidsJson as RaidDef[]).filter((r) => r.id !== COPY_RAID_ID)) {
      expect(circusStacksFor(assets, other, MIN_TIER)).toEqual([]);
    }
    expect(stacksFor(1, MIN_TIER)).toBeNull();
  });

  it("climbs while it is left alone, and no higher than its ceiling", () => {
    const cfg = stacksFor(COPY_RAID_ID, MIN_TIER)!;
    const [tower] = circusStacksFor(assets, raid14, MIN_TIER);
    const sim = copyFight(MIN_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })],
      [{ ...tower, id: "tower", deployAtMs: 0, str: 0 }]);
    const stack = () => sim.units.find((u) => u.id === "tower")!;
    run(sim, 1_000);
    const opened = stack().stackMax;
    expect(opened, "one midget to start with").toBe(1);
    run(sim, cfg.growMs * (STACK_MAX_HEIGHT + 2));
    expect(stack().stackMax).toBe(cfg.maxHeight);
    expect(cfg.maxHeight).toBe(STACK_MAX_HEIGHT);
  });

  it("fights at the height its hit points still support, and topples when they go", () => {
    // The whole model in one assertion: height is DERIVED, so a hit worth one pool takes
    // a level off and the tower is weaker on the same tick.
    const cfg = stacksFor(COPY_RAID_ID, MAX_TIER)!;
    const [tower] = circusStacksFor(assets, raid14, MAX_TIER);
    // The punchbag needs to SURVIVE the tower, or the fight settles before the assertion
    // and `step` becomes a no-op — which is how this read "the renderer was never told".
    const sim = copyFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })],
      [{ ...tower, id: "tower", deployAtMs: 0 }]);
    const stack = () => sim.units.find((u) => u.id === "tower")!;
    run(sim, cfg.growMs * (STACK_MAX_HEIGHT + 1));
    const tall = stack();
    expect(tall.stackMax).toBe(STACK_MAX_HEIGHT);
    expect(sim.stackHeight(tall)).toBe(STACK_MAX_HEIGHT);
    const before = tall.stackToppleSeq;

    tall.hp -= tall.stackBaseHp; // one pool: one midget off the top
    sim.step(50);
    expect(sim.stackHeight(stack()), "a level shorter").toBe(STACK_MAX_HEIGHT - 1);
    expect(stack().stackToppleSeq, "and the renderer is told").toBeGreaterThan(before);
  });

  it("leaves every other unit at height one, so the multiplier is a no-op", () => {
    const sim = copyFight(MIN_TIER, [unit({ id: "z0", group: "Regular" })]);
    for (const u of sim.units) expect(sim.stackHeight(u)).toBe(1);
  });
});

describe("the ringmaster", () => {
  it("stops waiting for his wave from the fifth rung, and only here", () => {
    expect(ringmasterDropMs(COPY_RAID_ID, RINGMASTER_EARLY_TIER - 1)).toBeNull();
    expect(ringmasterDropMs(COPY_RAID_ID, RINGMASTER_EARLY_TIER)).toBeGreaterThan(0);
    expect(ringmasterDropMs(COPY_RAID_ID, MAX_TIER)).toBeGreaterThan(0);
    for (const other of [1, 6, 12, 13, 15]) expect(ringmasterDropMs(other, MAX_TIER)).toBeNull();
  });

  it("comes down on the clock with his wave still standing, onto a mid-lane station", () => {
    const drop = ringmasterDropMs(COPY_RAID_ID, MAX_TIER)!;
    const players = [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })];
    const enemies = [
      unit({ id: "minion", sourceKey: "CircusStageActorMinion1", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
      unit({ id: "boss", sourceKey: "CircusStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
    ];
    const sim = new BattleSim(
      players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
      undefined, null, null, undefined, null, null, false, null, drop, 640
    );
    const boss = () => sim.units.find((u) => u.id === "boss")!;
    run(sim, drop - 2_000);
    expect(boss().state, "still up there while the clock runs").toBe("structure");
    run(sim, 4_000);
    expect(boss().state, "down, with the minion still alive").not.toBe("structure");
    expect(sim.units.find((u) => u.id === "minion")!.alive).toBe(true);
    expect(boss().stationX, "and he holds the middle of the field").toBe(640);
    expect(boss().anchorsLine, "without dragging the army back to him").toBe(false);
  });
});
