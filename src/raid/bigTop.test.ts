// The big top (raid 14): the ringmaster's whip from the middle, the trapeze drop, the bozo
// stack, and the pixel fire that walks a zombie back. See docs/POST_45_PROGRESSION.md Part 2B
// and dualInvasion.ts.
//
// What these pin is the LADDER and the SHAPE — that the middle is behind the line and only
// the counterplay gets you there, that the whip stuns Gardens and nobody else, that a drop
// lands where the swing is, that a bozo is a zombie you get back, and that trapped zombies
// come home — not the numbers, which are tuning.
import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import {
  BIG_TOP_RAID_ID, bigTopFor, BOZO_CAP, BOZO_CAP_HIGH, BOZO_CAP_TIER, BOZO_CONVERT_MS,
  BOZO_CONVERT_MS_FAST, BOZO_TIER, FAST_CONVERT_TIER, FIRE_WALK_TIER, RINGMASTER_DROP_AFTER_PAST, RINGMASTER_DROP_LATEST_MS,
  RINGMASTER_DROPS_AT_MS,
  RINGMASTER_STATION_X, TRAPEZE_TIER, WHIP_STUN_MS, type BigTopConfig,
} from "./dualInvasion";
import { bozoFor, grabberFor } from "./fightConfig";
import type { BattleSim } from "./BattleSim";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import raidsJson from "../../public/assets/raids/raids.json";
import type { AttackDef, CombatUnit, EnemyStat, RaidDef } from "./types";

const assets = {
  enemyStats: enemyStatsJson as Record<string, EnemyStat>,
  raidAttacks: attacksJson as Record<string, AttackDef>,
};
const raid14 = (raidsJson as RaidDef[]).find((r) => r.id === BIG_TOP_RAID_ID)!;

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 10, dex: 2, con: 10, focus: 100, hp: 1000, maxHp: 1000,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;
const cfgAt = (tier: number): BigTopConfig =>
  ({ ...bigTopFor(BIG_TOP_RAID_ID, tier)!, bozo: bozoFor(assets, raid14) });

/** A raid-14-shaped fight: a punchbag wave at the doorway, the ringmaster as the boss. */
function bigTopFight(tier: number, players: CombatUnit[], ringmasterHp = 1e6) {
  const cfg = cfgAt(tier);
  return buildFight({
    playerUnits: players,
    enemyUnits: [
      unit({ id: "w0", sourceKey: "VideoGameStageKnightActor", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
      unit({ id: "w1", sourceKey: "VideoGameStageKnightActor", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
      unit({
        id: "boss", sourceKey: "CircusStageActorBoss", team: "enemy", isBoss: true,
        str: 1, hp: ringmasterHp, maxHp: ringmasterHp,
      }),
    ],
    concentration: true,
    roundMs: NO_ENRAGE_MS,
    bigTop: cfg,
    bossDropAtMs: cfg.ringmasterDropMs,
    bossGroundStationX: cfg.stationX,
  });
}

const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };
const byId = (sim: BattleSim, id: string) => sim.units.find((u) => u.id === id)!;
const zombies = (n: number, over: Partial<CombatUnit> = {}) =>
  Array.from({ length: n }, (_, i) => unit({ id: `z${i}`, group: "Regular", hp: 1e6, maxHp: 1e6, ...over }));

describe("the ladder", () => {
  it("belongs to this invasion alone, and its trapeze is not the client-only rescue", () => {
    for (const other of [8, 9, 12, 13, 15]) expect(bigTopFor(other, 1)).toBeNull();
    expect(grabberFor(raid14)).toBeNull();
    expect(grabberFor((raidsJson as RaidDef[]).find((r) => r.id === 8)!)).not.toBeNull();
  });

  it("adds each rung's change at its own rung and not before", () => {
    const at = (t: number) => bigTopFor(BIG_TOP_RAID_ID, t)!;
    expect(at(1).ringmasterDropMs).toBe(RINGMASTER_DROPS_AT_MS);
    expect(at(TRAPEZE_TIER - 1).trapeze).toBe(false);
    expect(at(TRAPEZE_TIER).trapeze).toBe(true);
    expect(at(BOZO_TIER - 1).bozos).toBe(false);
    expect(at(BOZO_TIER).bozos).toBe(true);
    expect(at(FIRE_WALK_TIER - 1).fire).toBe(false);
    expect(at(FIRE_WALK_TIER).fire).toBe(true);
    expect(at(BOZO_CAP_TIER - 1).bozoCap).toBe(BOZO_CAP);
    expect(at(BOZO_CAP_TIER).bozoCap).toBe(BOZO_CAP_HIGH);
    expect(BOZO_CAP).toBe(3);
    expect(BOZO_CAP_HIGH).toBe(6);
    expect(at(FAST_CONVERT_TIER - 1).convertMs).toBe(BOZO_CONVERT_MS);
    expect(at(FAST_CONVERT_TIER).convertMs).toBe(BOZO_CONVERT_MS_FAST);
    expect(BOZO_CONVERT_MS_FAST).toBeLessThan(BOZO_CONVERT_MS);
  });
});

describe("the ringmaster", () => {
  it("waits for the front line to form behind his station before he drops", () => {
    // Too few zombies to ever get RINGMASTER_DROP_AFTER_PAST past him: he holds his perch
    // until the backstop.
    const few = bigTopFight(1, zombies(RINGMASTER_DROP_AFTER_PAST - 1));
    run(few, RINGMASTER_DROPS_AT_MS + 3_000);
    expect(byId(few, "boss").state).toBe("structure");
    run(few, RINGMASTER_DROP_LATEST_MS - RINGMASTER_DROPS_AT_MS);
    expect(byId(few, "boss").state).not.toBe("structure");
  });

  it("drops into the middle as a blocker the army that is already past does not turn for", () => {
    const sim = bigTopFight(1, zombies(2));
    run(sim, RINGMASTER_DROP_LATEST_MS + 3_000);
    const boss = byId(sim, "boss");
    expect(boss.state).not.toBe("structure");
    expect(boss.x).toBeCloseTo(RINGMASTER_STATION_X, 0);
    expect(boss.isBlocker).toBe(true);
    for (const z of sim.units.filter((u) => u.team === "player" && u.x > boss.x)) {
      expect(z.passedBlockers, `${z.id} is past him`).toContain("boss");
    }
  });

  it("stops a zombie deployed after he lands", () => {
    const army = zombies(8);
    const sim = bigTopFight(1, army);
    run(sim, RINGMASTER_DROPS_AT_MS + 40_000);
    const boss = byId(sim, "boss");
    const stopped = sim.units.filter((u) =>
      u.team === "player" && u.alive && !u.passedBlockers.includes("boss") &&
      (u.state === "fight" || u.state === "advance") && u.x < boss.x);
    expect(stopped.length, "somebody is fighting him from the left").toBeGreaterThan(0);
  });

  it("whips the nearest zombie on his LEFT, and stuns Gardens only", () => {
    const sim = bigTopFight(1, zombies(1));
    run(sim, RINGMASTER_DROP_LATEST_MS + 3_000);
    const boss = byId(sim, "boss");
    const whip = (sim as unknown as { whipTarget: (e: unknown) => { id: string } | null });
    const left = byId(sim, "z0");
    left.x = boss.x - 100;
    left.state = "advance";
    expect(whip.whipTarget(boss)?.id).toBe("z0");
    // A Garden on the left is stunned by it; a Regular is only hit.
    left.isGarden = true;
    left.stunMs = 0;
    boss.timerMs = 0;
    sim.step(50);
    expect(left.stunMs).toBeGreaterThan(0);
    expect(left.stunMs).toBeLessThanOrEqual(WHIP_STUN_MS);
  });

  it("has to be beaten — the fight is not won with him standing", () => {
    const sim = bigTopFight(1, zombies(1));
    run(sim, RINGMASTER_DROPS_AT_MS + 2_000);
    for (const id of ["w0", "w1"]) { const w = byId(sim, id); w.alive = false; w.hp = 0; w.state = "dead"; }
    sim.step(50);
    expect(sim.finished).toBe(false);
  });
});

describe("the trapeze", () => {
  it("comes from t3, grabs a zombie, and drops it where the swing is when tapped", () => {
    const sim = bigTopFight(TRAPEZE_TIER, zombies(4));
    let trap = sim.activeTrapeze();
    for (let i = 0; i < 2_000 && !trap; i++) { sim.step(50); trap = sim.activeTrapeze(); }
    expect(trap).not.toBeNull();
    run(sim, 700);
    const at = sim.activeTrapeze()!;
    const x = at.x;
    const caught = byId(sim, at.grabbedId!);
    expect(sim.tapGrabber(at.id), "not a rescue — it has its own tap").toBe(false);
    expect(sim.tapTrapeze(at.id)).toBe(true);
    expect(caught.state).toBe("advance");
    // Where the swing was — clamped at the front line, which is as far as a drop goes.
    expect(caught.x).toBeLessThanOrEqual(x + 0.5);
    expect(caught.x).toBeGreaterThan(x - 60);
    expect(sim.tapTrapeze(at.id), "nothing left to drop").toBe(false);
  });

  it("never comes below t3", () => {
    const sim = bigTopFight(TRAPEZE_TIER - 1, zombies(4));
    run(sim, 60_000);
    expect(sim.grabbers.length).toBe(0);
  });
});

describe("the bozos", () => {
  /** A t5+ fight with the ringmaster already down, so conversion starts at once. */
  function bozoFight(tier: number, n = 6) {
    // Zombies that hit for nothing, so the stack is never knocked down by accident.
    const sim = bigTopFight(tier, zombies(n, { str: 0 }));
    run(sim, 30_000);
    const boss = byId(sim, "boss");
    boss.alive = false; boss.hp = 0; boss.state = "dead";
    return sim;
  }

  it("start once the ringmaster falls, and not before t5", () => {
    const early = bigTopFight(BOZO_TIER - 1, zombies(6, { str: 0 }));
    run(early, 30_000);
    const b = byId(early, "boss"); b.alive = false; b.hp = 0; b.state = "dead";
    run(early, BOZO_CONVERT_MS * 3);
    expect(early.bozoStatus()).toBeNull();
    const sim = bozoFight(BOZO_TIER);
    run(sim, BOZO_CONVERT_MS + 100);
    expect(sim.bozoStatus()!.count).toBe(1);
    const stack = sim.units.find((u) => u.isBozoStack)!;
    expect(stack.isBlocker).toBe(true);
    expect(stack.x).toBeCloseTo(RINGMASTER_STATION_X, 0);
    expect(sim.units.filter((u) => u.team === "player" && u.taken)).toHaveLength(1);
  });

  it("stack no higher than the cap: three, then six from t9", () => {
    const low = bozoFight(BOZO_TIER, 10);
    run(low, BOZO_CONVERT_MS * 6);
    expect(low.bozoStatus()!.count).toBe(BOZO_CAP);
    const high = bozoFight(BOZO_CAP_TIER, 10);
    run(high, BOZO_CONVERT_MS * 8);
    expect(high.bozoStatus()!.count).toBe(BOZO_CAP_HIGH);
  });

  it("hand a zombie back for every bozo knocked off", () => {
    const sim = bozoFight(BOZO_TIER);
    run(sim, BOZO_CONVERT_MS * 2 + 200);
    expect(sim.bozoStatus()!.count).toBe(2);
    const stack = sim.units.find((u) => u.isBozoStack)!;
    const hit = (sim as unknown as { dealDamage: (u: unknown, d: number, p: boolean) => void });
    hit.dealDamage(stack, cfgAt(BOZO_TIER).bozoHp + 1, true);
    sim.step(50);
    expect(sim.bozoStatus()!.count).toBe(1);
    expect(sim.units.filter((u) => u.team === "player" && u.taken)).toHaveLength(1);
  });

  it("send trapped zombies home when the fight is won", () => {
    const sim = bozoFight(BOZO_TIER);
    run(sim, BOZO_CONVERT_MS + 200);
    const trapped = sim.units.find((u) => u.team === "player" && u.taken)!;
    for (const id of ["w0", "w1"]) { const w = byId(sim, id); w.alive = false; w.hp = 0; w.state = "dead"; }
    run(sim, 200);
    expect(sim.finished, "the stack is outside the win condition").toBe(true);
    const out = sim.outcome();
    expect(out.win).toBe(true);
    expect(out.losses, "not a casualty").not.toContain(trapped.id);
  });
});

describe("the pixel fire", () => {
  it("walks a burning zombie back from t7, until the middle is ahead of it again", () => {
    const sim = bigTopFight(FIRE_WALK_TIER, zombies(4));
    run(sim, RINGMASTER_DROPS_AT_MS + 2_000);
    let burning = sim.burningPlayers()[0];
    for (let i = 0; i < 1_000 && !burning; i++) { sim.step(50); burning = sim.burningPlayers()[0]; }
    expect(burning).toBeDefined();
    expect(burning.burnWalk).toBe(true);
    const x = burning.x;
    run(sim, 1_000);
    expect(burning.x, "walking back").toBeLessThan(x);
    const boss = byId(sim, "boss");
    if (burning.x < boss.x) expect(burning.passedBlockers).not.toContain("boss");
  });

  it("paces in place below t7, as the ordinary Video Games fire does", () => {
    expect(bigTopFor(BIG_TOP_RAID_ID, FIRE_WALK_TIER - 1)!.fire).toBe(false);
  });
});
