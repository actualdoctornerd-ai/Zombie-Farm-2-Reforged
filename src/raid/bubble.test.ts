// The saucer's bubble (raid 15). See docs/POST_45_PROGRESSION.md Part 2B and dualInvasion.ts.
//
// What these pin is the LADDER and the SHAPE: that each rung adds the one thing it names,
// that the cycle is fixed, that five cancels is the whole fight's budget, that a cancel
// stops the action and not the clock, the t9 lockout, the t10 dual cast, and that each cast
// does the one thing it is for. The damage and windows are tuning and will move.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  abducteesAt, ABDUCTEE_TIER, bubbleFor, BUBBLE_CANCELS, BUBBLE_CYCLE, BUBBLE_CYCLE_BASE,
  BUBBLE_INTERVAL_MS, BUBBLE_INTERVAL_MS_FAST, BUBBLE_RAID_ID, BUBBLE_ROBOT_KEY, DUAL_CAST_TIER,
  FAST_CAST_TIER, GIANT_BOT_TIER, LOCKOUT_TIER, MAX_TIER, MIN_TIER, type BubbleConfig,
} from "./dualInvasion";
import { bubbleRobotFor, bubbleWallFor } from "./fightConfig";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const assets = {
  enemyStats: enemyStatsJson as Record<string, EnemyStat>,
  raidAttacks: attacksJson as Record<string, AttackDef>,
};
const raid15 = (raidsJson as RaidDef[]).find((r) => r.id === BUBBLE_RAID_ID)!;

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 10, dex: 2, con: 10, focus: 100, hp: 1000, maxHp: 1000,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;
const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };
const tank = (id: string) => unit({ id, group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 });

/** The rung's bubble with the real robot attached, as composeFight builds it. */
const cfgAt = (tier: number): BubbleConfig =>
  ({ ...bubbleFor(BUBBLE_RAID_ID, tier)!, robot: bubbleRobotFor(assets, raid15) });

/** A raid-15-shaped fight at a rung: punchbag wave, the real bubble, the real wall. */
function bubbleFight(tier: number, players: CombatUnit[], extraEnemies: CombatUnit[] = []) {
  const enemies = [
    unit({ id: "alien", sourceKey: "AlienStageActorMinion", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
    unit({ id: "alien2", sourceKey: "AlienStageActorMinion", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
    unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
    ...extraEnemies,
  ];
  return new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, undefined, null, null, false, null, null, null,
    cfgAt(tier), bubbleWallFor(assets, raid15),
  );
}

/** Step until the saucer is charging something, and hand back the cast. */
function waitForCast(sim: BattleSim) {
  for (let i = 0; i < 4_000 && !sim.bubbleCast(); i++) sim.step(50);
  return sim.bubbleCast();
}

/** Step until the cast on the table resolves. */
function waitForResolve(sim: BattleSim) {
  for (let i = 0; i < 4_000 && sim.bubbleCast(); i++) sim.step(50);
}

describe("the ladder", () => {
  it("belongs to this invasion alone", () => {
    for (const other of [1, 6, 9, 12, 13, 14]) expect(bubbleFor(other, 1)).toBeNull();
  });

  it("opens on walls, portals and robots, with five cancels, every ten seconds", () => {
    const cfg = bubbleFor(BUBBLE_RAID_ID, MIN_TIER)!;
    expect(cfg.cycle).toEqual([...BUBBLE_CYCLE_BASE]);
    expect(cfg.cycle).toEqual(["wall", "portal", "robot"]);
    expect(cfg.cancels).toBe(BUBBLE_CANCELS);
    expect(BUBBLE_CANCELS).toBe(5);
    expect(cfg.castMs + cfg.gapMs).toBe(BUBBLE_INTERVAL_MS);
    expect(BUBBLE_INTERVAL_MS).toBe(10_000);
    expect(cfg.lockout).toBe(false);
    expect(cfg.dualCast).toBe(false);
    expect(cfg.giantBot).toBe(false);
  });

  it("adds each rung's one change at its own rung and not before", () => {
    // t3: abductees.
    expect(abducteesAt(BUBBLE_RAID_ID, ABDUCTEE_TIER - 1)).toBe(false);
    expect(abducteesAt(BUBBLE_RAID_ID, ABDUCTEE_TIER)).toBe(true);
    expect(abducteesAt(6, MIN_TIER), "the ordinary Aliens always abduct").toBe(true);
    // t5: the giant bot, and with it the blast and the army stun.
    expect(bubbleFor(BUBBLE_RAID_ID, GIANT_BOT_TIER - 1)!.cycle).not.toContain("aoe");
    const bot = bubbleFor(BUBBLE_RAID_ID, GIANT_BOT_TIER)!;
    expect(bot.giantBot).toBe(true);
    expect(bot.cycle).toEqual([...BUBBLE_CYCLE]);
    expect(bot.cycle).toContain("aoe");
    expect(bot.cycle).toContain("stunAll");
    // t7: a cast every seven seconds.
    const slow = bubbleFor(BUBBLE_RAID_ID, FAST_CAST_TIER - 1)!;
    const fast = bubbleFor(BUBBLE_RAID_ID, FAST_CAST_TIER)!;
    expect(slow.castMs + slow.gapMs).toBe(BUBBLE_INTERVAL_MS);
    expect(fast.castMs + fast.gapMs).toBe(BUBBLE_INTERVAL_MS_FAST);
    expect(BUBBLE_INTERVAL_MS_FAST).toBe(7_000);
    // t9 lockout, t10 dual cast.
    expect(bubbleFor(BUBBLE_RAID_ID, LOCKOUT_TIER - 1)!.lockout).toBe(false);
    expect(bubbleFor(BUBBLE_RAID_ID, LOCKOUT_TIER)!.lockout).toBe(true);
    expect(bubbleFor(BUBBLE_RAID_ID, DUAL_CAST_TIER - 1)!.dualCast).toBe(false);
    expect(bubbleFor(BUBBLE_RAID_ID, DUAL_CAST_TIER)!.dualCast).toBe(true);
    // The budget never moves: five for the whole fight at every rung.
    for (let rung = MIN_TIER; rung <= MAX_TIER; rung++) {
      expect(bubbleFor(BUBBLE_RAID_ID, rung)!.cancels, `t${rung}`).toBe(BUBBLE_CANCELS);
    }
  });

  it("keeps the two big casts apart in the cycle", () => {
    const i = BUBBLE_CYCLE.indexOf("aoe");
    const j = BUBBLE_CYCLE.indexOf("stunAll");
    expect(Math.abs(i - j)).toBeGreaterThan(1);
  });
});

describe("the cancels", () => {
  it("walks its cycle in the same order every fight", () => {
    const sim = bubbleFight(GIANT_BOT_TIER, [tank("z0")]);
    const seen: string[] = [];
    for (let i = 0; i < BUBBLE_CYCLE.length; i++) {
      const cast = waitForCast(sim);
      if (cast) seen.push(cast.actions[0]);
      waitForResolve(sim);
    }
    expect(seen).toEqual([...BUBBLE_CYCLE]);
  });

  it("stops the action, not the clock", () => {
    const cfg = cfgAt(MIN_TIER);
    const sim = bubbleFight(MIN_TIER, [tank("z0")]);
    expect(waitForCast(sim)!.actions).toEqual([cfg.cycle[0]]);
    const before = sim.cancelsLeft();
    expect(sim.cancelCast()).toBe(true);
    expect(sim.cancelsLeft()).toBe(before - 1);
    expect(sim.bubbleCast(), "nothing is charging after the cancel").toBeNull();
    expect(sim.units.some((u) => u.isWall), "and the wall never landed").toBe(false);
    // The next cast arrives after the ORDINARY gap — a cancel buys no extra quiet.
    let ms = 0;
    while (!sim.bubbleCast() && ms < 30_000) { sim.step(50); ms += 50; }
    expect(ms).toBeLessThanOrEqual(cfg.gapMs + 50);
    expect(sim.bubbleCast()!.actions).toEqual([cfg.cycle[1]]);
  });

  it("runs dry after five", () => {
    const sim = bubbleFight(MIN_TIER, [tank("z0")]);
    expect(sim.cancelCast(), "nothing is up yet").toBe(false);
    for (let i = 0; i < BUBBLE_CANCELS; i++) {
      expect(waitForCast(sim), `cast ${i}`).not.toBeNull();
      expect(sim.cancelCast(), `cancel ${i}`).toBe(true);
    }
    expect(sim.cancelsLeft()).toBe(0);
    expect(waitForCast(sim)).not.toBeNull();
    expect(sim.cancelCast(), "and then they are gone").toBe(false);
  });

  it("locks out a cancel on the activation straight after a cancelled one (t9)", () => {
    const sim = bubbleFight(LOCKOUT_TIER, [tank("z0")]);
    waitForCast(sim);
    expect(sim.cancelCast()).toBe(true);
    waitForCast(sim);
    expect(sim.cancelLocked()).toBe(true);
    expect(sim.cancelCast(), "consecutive cancels are refused").toBe(false);
    waitForResolve(sim);
    waitForCast(sim);
    expect(sim.cancelLocked()).toBe(false);
    expect(sim.cancelCast(), "one activation later it is open again").toBe(true);
  });

  it("never locks below t9", () => {
    const sim = bubbleFight(LOCKOUT_TIER - 1, [tank("z0")]);
    waitForCast(sim);
    expect(sim.cancelCast()).toBe(true);
    waitForCast(sim);
    expect(sim.cancelLocked()).toBe(false);
    expect(sim.cancelCast()).toBe(true);
  });

  it("casts in pairs at t10, and one cancel stops one of the pair", () => {
    const sim = bubbleFight(DUAL_CAST_TIER, [tank("z0")]);
    const cast = waitForCast(sim)!;
    expect(cast.actions).toEqual([BUBBLE_CYCLE[0], BUBBLE_CYCLE[1]]);
    expect(sim.cancelCast(2), "there is no third slot").toBe(false);
    expect(sim.cancelCast(0)).toBe(true);
    expect(sim.bubbleCast()!.cancelled).toBe(0);
    expect(sim.bubbleAction(), "the other one is still coming").toBe(BUBBLE_CYCLE[1]);
    expect(sim.cancelCast(1), "one cancel per activation").toBe(false);
    waitForResolve(sim);
    expect(sim.units.some((u) => u.isWall), "the cancelled wall never landed").toBe(false);
    // The pair counts as ONE activation for the lockout.
    const next = waitForCast(sim)!;
    expect(next.actions).toEqual([BUBBLE_CYCLE[2], BUBBLE_CYCLE[3]]);
    expect(sim.cancelLocked()).toBe(true);
  });

  it("survives a checkpoint mid-pair", () => {
    const sim = bubbleFight(DUAL_CAST_TIER, [tank("z0")]);
    waitForCast(sim);
    sim.cancelCast(1);
    const snap = sim.snapshot();
    const twin = bubbleFight(DUAL_CAST_TIER, [tank("z0")]);
    twin.restore(snap);
    expect(twin.bubbleCast()).toEqual(sim.bubbleCast());
    expect(twin.cancelsLeft()).toBe(sim.cancelsLeft());
  });

  it("does nothing at all on an invasion without one", () => {
    const sim = new BattleSim(
      [unit({ id: "z0", group: "Regular" })],
      [unit({ id: "boss", team: "enemy", isBoss: true, hp: 1e6, maxHp: 1e6 })],
    );
    run(sim, 30_000);
    expect(sim.bubbleCast()).toBeNull();
    expect(sim.cancelsLeft()).toBe(0);
    expect(sim.cancelCast()).toBe(false);
    expect(sim.bubbleGiantBot()).toBe(false);
  });
});

describe("what the casts do", () => {
  /** Run the fight until the named action has fired, then hand back whether it did. */
  function fireOnce(sim: BattleSim, want: string): boolean {
    for (let i = 0; i < 8_000; i++) {
      const before = sim.bubbleCast();
      sim.step(50);
      if (before?.actions.includes(want as never) && !sim.bubbleCast()) return true;
    }
    return false;
  }

  it("drops its wall inside the player's own half, behind the line", () => {
    const sim = bubbleFight(MIN_TIER, [tank("z0")]);
    expect(fireOnce(sim, "wall")).toBe(true);
    const wall = sim.units.find((u) => u.isWall);
    expect(wall, "the saucer has no `wall` action of its own — it borrows the JunkBot's")
      .toBeDefined();
    expect(wall!.isBlocker).toBe(true);
    expect(wall!.x).toBeLessThan(900);
  });

  it("beams down ONE robot at a time", () => {
    const sim = bubbleFight(MIN_TIER, [tank("z0")]);
    expect(fireOnce(sim, "robot")).toBe(true);
    const bots = () => sim.units.filter((u) => u.isBubbleRobot && u.alive);
    expect(bots()).toHaveLength(1);
    expect(bots()[0].sourceKey).toBe(BUBBLE_ROBOT_KEY);
    expect(bots()[0].isBoss).toBeFalsy();
    // The next robot cast fizzles while the first still stands.
    expect(fireOnce(sim, "robot")).toBe(true);
    expect(bots()).toHaveLength(1);
  });

  it("chunks every deployed zombie with the blast", () => {
    const cfg = cfgAt(GIANT_BOT_TIER);
    const sim = bubbleFight(GIANT_BOT_TIER, [tank("out"), tank("waiting")]);
    run(sim, 6_000);
    const out = sim.units.find((u) => u.id === "out")!;
    const before = out.hp;
    expect(fireOnce(sim, "aoe")).toBe(true);
    expect(before - out.hp, "took the hit").toBeGreaterThanOrEqual(cfg.aoeDamage);
  });

  it("holds the whole army with stun-all", () => {
    const sim = bubbleFight(GIANT_BOT_TIER, [tank("z0")]);
    run(sim, 6_000);
    expect(fireOnce(sim, "stunAll")).toBe(true);
    expect(sim.units.find((u) => u.id === "z0")!.stunMs).toBeGreaterThan(0);
  });

  it("throws half the line back through the wall with the portal", () => {
    const army = Array.from({ length: 6 }, (_, i) => tank(`z${i}`));
    const sim = bubbleFight(MIN_TIER, army);
    run(sim, 30_000);
    const deployed = () => sim.units.filter(
      (u) => u.team === "player" && u.alive && (u.state === "advance" || u.state === "fight"));
    const before = deployed().map((u) => u.x);
    expect(before.length, "some of the army is out").toBeGreaterThan(1);
    expect(fireOnce(sim, "portal")).toBe(true);
    const after = deployed().map((u) => u.x);
    expect(Math.min(...after), "somebody is back at the staging slot")
      .toBeLessThan(Math.min(...before) + 1);
  });
});

describe("the robots", () => {
  it("are summoned rather than scheduled, and the wave itself is aliens only", () => {
    const robot = bubbleRobotFor(assets, raid15)!;
    expect(robot.sourceKey).toBe(BUBBLE_ROBOT_KEY);
    expect(robot.isBoss).toBeFalsy();
    const weighted = raid15.stages[0].weighted ?? [];
    expect(weighted.every((w) => w.enemy.startsWith("AlienStage"))).toBe(true);
  });

  it("belong to this invasion alone", () => {
    for (const other of (raidsJson as RaidDef[]).filter((r) => r.id !== BUBBLE_RAID_ID)) {
      expect(bubbleRobotFor(assets, other)).toBeNull();
      expect(bubbleWallFor(assets, other)).toBeNull();
    }
  });
});
