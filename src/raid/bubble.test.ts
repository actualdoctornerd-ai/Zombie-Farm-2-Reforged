// The saucer's bubble (raid 15). See docs/POST_45_PROGRESSION.md and dualInvasion.ts.
//
// What these pin is the SHAPE: that the cycle is fixed and cheap to learn, that a cancel
// costs the saucer tempo rather than the action, that the budget is smaller than the cycle
// (which is what turns a fixed order into a menu), and that each of the five does the one
// thing it is for. The windows, the damage and the budget are tuning and will move.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  bubbleFor, BUBBLE_CYCLE, BUBBLE_RAID_ID, MAX_TIER, MIN_TIER, PORTAL_TIER,
  ROBOT_ESCORT_KEY,
} from "./dualInvasion";
import { bubbleWallFor, robotEscortFor } from "./fightConfig";
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
    bubbleFor(BUBBLE_RAID_ID, tier), bubbleWallFor(assets, raid15),
  );
}

/** Step until the saucer is charging something, and say what. */
function waitForCast(sim: BattleSim): string | null {
  for (let i = 0; i < 4_000 && !sim.bubbleAction(); i++) sim.step(50);
  return sim.bubbleAction();
}

describe("the bubble", () => {
  it("belongs to this invasion alone, and tightens up the ladder", () => {
    for (const other of [1, 6, 9, 12, 13, 14]) expect(bubbleFor(other, 1)).toBeNull();
    const low = bubbleFor(BUBBLE_RAID_ID, MIN_TIER)!;
    const top = bubbleFor(BUBBLE_RAID_ID, MAX_TIER)!;
    expect(top.castMs, "less time to react").toBeLessThan(low.castMs);
    expect(top.gapMs, "and less quiet between").toBeLessThan(low.gapMs);
    expect(top.cancels, "and fewer answers").toBeLessThan(low.cancels);
    expect(top.aoeDamage).toBeGreaterThan(low.aoeDamage);
  });

  it("holds fewer cancels than it has actions, at every rung", () => {
    // This is the whole reason a FIXED order still asks a question: with fewer charges
    // than actions, the order produces a menu rather than an answer. If the budget ever
    // reaches the cycle length the mechanic quietly stops being a decision.
    for (let rung = MIN_TIER; rung <= MAX_TIER; rung++) {
      const cfg = bubbleFor(BUBBLE_RAID_ID, rung)!;
      expect(cfg.cancels, `tier ${rung}`).toBeLessThan(cfg.cycle.length);
      expect(cfg.cancels).toBeGreaterThan(0);
    }
  });

  it("teaches the portal last, and keeps the swap off the end of the cycle", () => {
    expect(bubbleFor(BUBBLE_RAID_ID, PORTAL_TIER - 1)!.cycle).not.toContain("portal");
    expect(bubbleFor(BUBBLE_RAID_ID, PORTAL_TIER)!.cycle).toContain("portal");
    // The swap needs a non-empty wave queue to have anything to re-stat, so it must never
    // be the last thing in the cycle — a cancel spent on an action that would have fizzled
    // is a cancel the player was cheated out of.
    for (const rung of [MIN_TIER, PORTAL_TIER, MAX_TIER]) {
      const cycle = bubbleFor(BUBBLE_RAID_ID, rung)!.cycle;
      expect(cycle[cycle.length - 1], `tier ${rung}`).not.toBe("swap");
    }
    expect(BUBBLE_CYCLE[0]).toBe("wall");
  });

  it("walks its cycle in the same order every fight", () => {
    const sim = bubbleFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })]);
    const seen: string[] = [];
    for (let i = 0; i < BUBBLE_CYCLE.length; i++) {
      const action = waitForCast(sim);
      if (action) seen.push(action);
      // let it resolve
      for (let t = 0; t < 400 && sim.bubbleAction() === action; t++) sim.step(50);
    }
    expect(seen).toEqual([...BUBBLE_CYCLE]);
  });

  it("spends a cancel to buy tempo, not to delete the action", () => {
    const cfg = bubbleFor(BUBBLE_RAID_ID, MIN_TIER)!;
    const sim = bubbleFight(MIN_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })]);
    const first = waitForCast(sim);
    expect(first).toBe(cfg.cycle[0]);
    const before = sim.cancelsLeft();
    expect(sim.cancelCast()).toBe(true);
    expect(sim.cancelsLeft()).toBe(before - 1);
    expect(sim.bubbleAction(), "nothing is charging during the sulk").toBeNull();
    // …and when it comes back it is on the NEXT action, not a retry of the cancelled one.
    expect(waitForCast(sim)).toBe(cfg.cycle[1]);
  });

  it("refuses a cancel with nothing to cancel, or with the budget spent", () => {
    const cfg = bubbleFor(BUBBLE_RAID_ID, MAX_TIER)!;
    const sim = bubbleFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })]);
    expect(sim.cancelCast(), "nothing is up yet").toBe(false);
    for (let i = 0; i < cfg.cancels; i++) {
      expect(waitForCast(sim), `cast ${i}`).not.toBeNull();
      expect(sim.cancelCast(), `cancel ${i}`).toBe(true);
    }
    expect(sim.cancelsLeft()).toBe(0);
    expect(waitForCast(sim)).not.toBeNull();
    expect(sim.cancelCast(), "and then they are gone").toBe(false);
  });

  it("does nothing at all on an invasion without one", () => {
    const sim = new BattleSim(
      [unit({ id: "z0", group: "Regular" })],
      [unit({ id: "boss", team: "enemy", isBoss: true, hp: 1e6, maxHp: 1e6 })],
    );
    run(sim, 30_000);
    expect(sim.bubbleAction()).toBeNull();
    expect(sim.cancelsLeft()).toBe(0);
    expect(sim.cancelCast()).toBe(false);
  });
});

describe("what the bubble does", () => {
  /** Run the fight until the named action has fired, then hand back the sim. */
  function fireOnce(sim: BattleSim, want: string): boolean {
    for (let i = 0; i < 6_000; i++) {
      const before = sim.bubbleAction();
      sim.step(50);
      if (before === want && sim.bubbleAction() !== want) return true;
    }
    return false;
  }

  it("drops its wall inside the player's own half, behind the line", () => {
    const sim = bubbleFight(MIN_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })]);
    expect(fireOnce(sim, "wall")).toBe(true);
    const wall = sim.units.find((u) => u.isWall);
    expect(wall, "the saucer has no `wall` action of its own — it borrows the JunkBot's")
      .toBeDefined();
    expect(wall!.isBlocker).toBe(true);
    // Behind the front line, which is the counter-intuitive half of the design: it bars
    // reinforcements rather than the zombies already up at the doorway.
    expect(wall!.x).toBeLessThan(900);
  });

  it("chunks every deployed zombie with the shockwave, and only the deployed ones", () => {
    const cfg = bubbleFor(BUBBLE_RAID_ID, MAX_TIER)!;
    const sim = bubbleFight(MAX_TIER, [
      unit({ id: "out", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 }),
      unit({ id: "waiting", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 }),
    ]);
    // Let the first one deploy, then catch the shockwave.
    run(sim, 6_000);
    const out = sim.units.find((u) => u.id === "out")!;
    const before = out.hp;
    expect(fireOnce(sim, "aoe")).toBe(true);
    expect(before - out.hp, "took the hit").toBeGreaterThanOrEqual(cfg.aoeDamage);
  });

  it("re-stats a QUEUED enemy rather than adding one", () => {
    // Needs a real queue behind the front: the swap takes its hit points out of the
    // aliens still waiting, so with nothing waiting it correctly fizzles.
    const sim = bubbleFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })],
      Array.from({ length: 4 }, (_, i) => unit({
        id: `q${i}`, sourceKey: "AlienStageActorMinion", team: "enemy", str: 1,
        hp: 4000, maxHp: 4000, con: 40,
      })));
    // Walls are not bodies for this purpose — the `wall` cast fires earlier in the cycle,
    // so a raw enemy count is one higher by the time the swap lands.
    const count = () => sim.units.filter((u) => u.team === "enemy" && !u.isWall).length;
    const before = count();
    expect(fireOnce(sim, "swap")).toBe(true);
    expect(count(), "no new body — that is what keeps it off the settle budget").toBe(before);
    expect(sim.units.some((u) => u.swapped), "somebody got worse").toBe(true);
  });

  it("takes the hit points OUT OF THE QUEUE rather than inventing them", () => {
    // The budget check, and the one that actually bit: the first cut multiplied, and four
    // swaps took a 130,003-point tier-10 fight to 254,827 — well past anything clearable
    // inside the settle cap. It hung at 240 s in the Raid Lab with the army still alive.
    const sim = bubbleFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })],
      Array.from({ length: 6 }, (_, i) => unit({
        id: `q${i}`, sourceKey: "AlienStageActorMinion", team: "enemy", str: 1,
        hp: 4000, maxHp: 4000, con: 40,
      })));
    const waveHp = () => sim.units
      .filter((u) => u.team === "enemy" && !u.isBoss && !u.isWall && !u.isSummon)
      .reduce((sum, u) => sum + u.maxHp, 0);
    const before = waveHp();
    expect(fireOnce(sim, "swap")).toBe(true);
    expect(waveHp(), "the wave weighs the same after as before").toBeCloseTo(before, -1);
    const beefed = sim.units.find((u) => u.swapped)!;
    expect(beefed.maxHp, "one of them is much worse").toBeGreaterThan(4000);
  });

  it("holds the whole army with stun-all", () => {
    const sim = bubbleFight(MAX_TIER, [unit({ id: "z0", group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 })]);
    run(sim, 6_000);
    expect(fireOnce(sim, "stunAll")).toBe(true);
    expect(sim.units.find((u) => u.id === "z0")!.stunMs).toBeGreaterThan(0);
  });

  it("throws half the line back through the wall with the portal", () => {
    // The signature play: the portal is only in the cycle from PORTAL_TIER, and it clears
    // `passedBlockers` so the wall the player already walked past bars them again.
    const army = Array.from({ length: 6 }, (_, i) =>
      unit({ id: `z${i}`, group: "Regular", str: 0, hp: 1e6, maxHp: 1e6 }));
    const sim = bubbleFight(MAX_TIER, army);
    run(sim, 40_000);
    const deployed = () => sim.units.filter(
      (u) => u.team === "player" && u.alive && (u.state === "advance" || u.state === "fight"));
    const before = deployed().map((u) => u.x).sort((a, b) => b - a);
    expect(before.length, "some of the army is out").toBeGreaterThan(1);
    expect(fireOnce(sim, "portal")).toBe(true);
    const after = deployed().map((u) => u.x).sort((a, b) => b - a);
    expect(Math.min(...after), "somebody is back at the staging slot")
      .toBeLessThan(Math.min(...before) + 1);
  });
});

describe("the robot escort", () => {
  it("is ONE heavy on its own clock, not a wave of them", () => {
    // The robots used to be in the weighted table, which made a 409,000-point fight —
    // four times the settle budget. One of them, appended, is the same shape raids 12 and
    // 13 use for their guest factions.
    const escort = robotEscortFor(assets, raid15);
    expect(escort).toHaveLength(1);
    expect(escort[0].sourceKey).toBe(ROBOT_ESCORT_KEY);
    expect(escort[0].deployAtMs, "off the drip, on its own beat").toBeGreaterThan(0);
    expect(escort[0].isBoss, "a powerful minion — the saucer holds the boss slot").toBeFalsy();
    // And the wave itself is the host faction's, aliens only.
    const weighted = raid15.stages[0].weighted ?? [];
    expect(weighted.every((w) => w.enemy.startsWith("AlienStage"))).toBe(true);
  });

  it("belongs to this invasion alone", () => {
    for (const other of (raidsJson as RaidDef[]).filter((r) => r.id !== BUBBLE_RAID_ID)) {
      expect(robotEscortFor(assets, other)).toEqual([]);
      expect(bubbleWallFor(assets, other)).toBeNull();
    }
  });
});
