// Who stands at the front of the line, and therefore who dies.
//
// This sim's enemies do not chip the whole front row — `playerInRange` picks the single
// front-most zombie down the lane and commits everything to it. Formation geometry is
// therefore gameplay: body-specific spacing must not silently reorder the FIFO line.
// Headless is the deliberate exception and always pushes into position zero.
import { describe, expect, it } from "vitest";
import { BattleSim, ENEMY_HOLD_X } from "./BattleSim";
import type { CombatUnit } from "./types";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

const mini = (id: string) =>
  unit({ id, sourceKey: "ZombieActorSmallTier1", group: "Small", team: "player" });
const regular = (id: string) =>
  unit({ id, sourceKey: "ZombieActorRegularTier1", group: "Regular", team: "player" });
const large = (id: string) =>
  unit({ id, sourceKey: "ZombieActorLargeTier1", group: "Large", team: "player" });
const headless = (id: string) =>
  unit({ id, sourceKey: "ZombieActorHeadlessTier1", group: "Headless", team: "player", isHeadless: true });

/** An army deployed onto the lane against one indestructible enemy, stepped far enough
 *  for everyone to reach their slot. Returns the sim so slots can be read off it. */
function deployed(players: CombatUnit[]) {
  const enemy = unit({
    id: "e", sourceKey: "FarmStageActorBoss", team: "enemy", con: 100000, str: 1, dex: 1,
  });
  const sim = new BattleSim(
    players, [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
  );
  for (const p of players) sim.units.find((u) => u.id === p.id)!.state = "advance";
  for (let t = 0; t < 8000; t += 50) sim.step(50);
  return sim;
}

/** The zombie standing nearest the enemy — the one `playerInRange` hands every blow to. */
const frontMostId = (sim: BattleSim): string =>
  sim.units
    .filter((u) => u.team === "player" && u.alive)
    .reduce((best, u) => (u.x > best.x ? u : best)).id;

describe("a Mini does not push to the front of the line", () => {
  // Deploy order still decides the lead slot — that is what "the same priority as the
  // other bodies" means. What a Mini must no longer do is OVERTAKE the bodies sent in
  // ahead of it, which is exactly what the disassembled `Small` bucket made it do.
  it("does not overtake the bodies deployed before it", () => {
    const sim = deployed([regular("r"), large("l"), mini("m")]);
    expect(frontMostId(sim)).toBe("r");
  });

  it("stands level with a Regular rather than ahead of it", () => {
    const sim = deployed([mini("m"), regular("r")]);
    const m = sim.units.find((u) => u.id === "m")!;
    const r = sim.units.find((u) => u.id === "r")!;
    const enemyX = sim.units.find((u) => u.id === "e")!.x;
    // Same bucket, same standoff: the pair still fan across their row's slots, but the
    // gap between them is a slot step, not the body-type gulf the source's -15 opened.
    expect(Math.abs(m.x - r.x)).toBeLessThanOrEqual(Math.abs(m.x - enemyX) * 0.15);
  });

  it("takes no more of the incoming damage than the body beside it", () => {
    // The report was that Minis get themselves killed. Sent in behind a Regular, the
    // Mini must not be the one soaking the fight.
    const players = [regular("r"), mini("m")];
    const enemy = unit({
      id: "e", sourceKey: "FarmStageActorBoss", team: "enemy", con: 100000, str: 8, dex: 4,
    });
    const sim = new BattleSim(
      players, [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
    );
    for (const p of players) sim.units.find((u) => u.id === p.id)!.state = "advance";
    for (let t = 0; t < 30_000; t += 50) sim.step(50);
    const hpLost = (id: string) => {
      const u = sim.units.find((x) => x.id === id)!;
      return u.maxHp - Math.max(0, u.alive ? u.hp : 0);
    };
    expect(hpLost("m")).toBeLessThanOrEqual(hpLost("r"));
  });
});

describe("a Headless still pushes to the front of the line", () => {
  it("takes the lead slot ahead of every ordinary body", () => {
    const sim = deployed([regular("r"), large("l"), headless("h")]);
    expect(frontMostId(sim)).toBe("h");
  });

  it("takes it ahead of a Mini too", () => {
    const sim = deployed([mini("m"), headless("h")]);
    expect(frontMostId(sim)).toBe("h");
  });
});

// Where the line stands, in the coordinates a player actually sees. RaidScene insets the
// combat lane by 10 % of the stage width at each end, so a sim x renders at
// `art = 48 + (x/1000)*384` of the 480-wide background — which is what these fractions
// are checked against. Both numbers came from a playtest note about placement.
describe("where the army plants itself on the stage", () => {
  /** Sim x as a fraction across the visible stage art. */
  const stageFraction = (simX: number) => (48 + (simX / 1000) * 384) / 480;

  const garden = (id: string) =>
    unit({ id, sourceKey: "ZombieActorGardenTier1", group: "Garden", team: "player", isGarden: true });

  it("holds the wave in the doorway, with the front rank closing to melee on it", () => {
    const sim = deployed([regular("r0"), regular("r1"), regular("r2")]);
    const enemy = sim.units.find((u) => u.team === "enemy")!;
    expect(enemy.x).toBe(ENEMY_HOLD_X);
    const front = sim.units.find((u) => u.id === frontMostId(sim))!;
    // The front rank stands one melee gap short of the wave, not back in the field.
    expect(enemy.x - front.x).toBeCloseTo(60, 0);
    expect(stageFraction(front.x)).toBeGreaterThan(0.8);
  });

  it("stations Garden healers at 3/10 across the stage", () => {
    // Their old setback hung off the front line and dropped them into the milling crowd
    // at roughly a sixth of the way across; they now hold a fixed support station.
    const sim = deployed([regular("r0"), regular("r1"), garden("g0"), garden("g1")]);
    for (const id of ["g0", "g1"]) {
      const g = sim.units.find((u) => u.id === id)!;
      expect(stageFraction(g.x), id).toBeGreaterThan(0.25);
      expect(stageFraction(g.x), id).toBeLessThan(0.34);
    }
    // …and well behind the front rank, so they stay out of the combat band.
    const front = sim.units.find((u) => u.id === frontMostId(sim))!;
    expect(front.x - sim.units.find((u) => u.id === "g0")!.x).toBeGreaterThan(300);
  });
});

// Reported as: sending out a Regular or a Headless makes the enemy STOP ATTACKING what
// it was fighting, until the new zombie has walked all the way up and taken the front
// slot. The row hangs off its front-most member's body standoff, so a lighter body
// taking the lead shifts everyone behind it back — correct once that body is standing
// there, and a self-inflicted hole in the line for the three seconds before it is. See
// ROW_ANCHOR_EPS in BattleSim.ts.
describe("a reinforcement does not open a hole in the line while it walks up", () => {
  /** Field one zombie, let it engage, then release a second mid-fight. Reports how many
   *  ticks the enemy spent with nothing in reach, and how far the first one gave way. */
  function reinforce(first: CombatUnit, second: CombatUnit) {
    const enemy = unit({
      id: "e", sourceKey: "FarmStageActorEnemy", team: "enemy", con: 100_000, str: 1, dex: 1,
    });
    // concentration OFF: the focus bubble is what lets the test choose WHEN each zombie
    // is released, which is the whole scenario.
    const sim = new BattleSim(
      [first, second], [enemy], null, false, [], 10 * 60 * 1000,
      null, null, false, false, false, 60, null, null,
    );
    const a = sim.units.find((u) => u.id === first.id)!;
    const b = sim.units.find((u) => u.id === second.id)!;
    const e = sim.units.find((u) => u.id === "e")!;

    for (let t = 0; t < 12_000; t += 50) {
      sim.step(50);
      const bubble = sim.chargingBubble();
      if (bubble?.id === a.id) sim.popBubble(bubble.id);
      // Wait for the first zombie to be STANDING at its slot, not merely trading blows:
      // since v40's reach-of-last-resort both sides enter "fight" while it is still
      // crossing the combat zone, and this scenario needs it planted on the line.
      if (a.state === "fight" && e.state === "fight" && Math.abs(a.x - a.slotX) <= 2) break;
    }
    expect(e.state, "the first zombie should be engaged before the second is sent").toBe("fight");
    const engagedAt = a.x;

    for (let t = 0; t < 4_000; t += 50) {
      sim.step(50);
      const bubble = sim.chargingBubble();
      if (bubble?.id === b.id) { sim.popBubble(bubble.id); break; }
    }
    let idleTicks = 0;
    let gaveGround = 0;
    for (let t = 0; t < 8_000; t += 50) {
      sim.step(50);
      if (e.state !== "fight") idleTicks++;
      gaveGround = Math.max(gaveGround, engagedAt - a.x);
    }
    return { idleTicks, gaveGround, a, b, e };
  }

  it("keeps the enemy in contact while a Headless crosses the field", () => {
    const { idleTicks } = reinforce(large("l"), headless("h"));
    expect(idleTicks).toBe(0);
  });

  it("keeps it in contact without letting a later Regular overtake a heavier body", () => {
    const ordinary = reinforce(large("l"), regular("r"));
    expect(ordinary.idleTicks).toBe(0);
    expect(ordinary.a.x).toBeGreaterThan(ordinary.b.x);
    expect(reinforce(regular("r"), headless("h")).idleTicks).toBe(0);
  });

  it("still re-forms the row once the newcomer is standing on the line", () => {
    // The fix is a matter of TIMING, not of geometry: the Headless must still end up in
    // front, with the heavier body stepping back behind it exactly as it always did.
    const { gaveGround, a, b } = reinforce(large("l"), headless("h"));
    expect(gaveGround).toBeGreaterThan(20); // the Large did give way — once, at the end
    expect(b.x).toBeGreaterThan(a.x);       // ...and the Headless leads the row
  });
});

// Resurrection is a new arrival: it gets a fresh tail order. A Headless then applies its
// defining exception and pushes that new arrival into position zero.
describe("a resurrected zombie rejoins the line", () => {
  const medic = (id: string) =>
    unit({
      id, sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });

  /** Deploy the party through the real charge queue (so every zombie claims a distinct
   *  `formOrder`), let it settle on the line, then kill `victim` and let the medic revive
   *  it. Returns the army's rank order before the death and after the revive. */
  function reviveInLine(players: CombatUnit[], victimId: string) {
    const enemy = unit({
      id: "e", sourceKey: "FarmStageActorEnemy", team: "enemy", con: 100_000, str: 1, dex: 1,
      hp: 1e12, maxHp: 1e12,
    });
    const sim = new BattleSim(
      players, [enemy], null, true, [], 10 * 60 * 1000, null, null, false, false, false, 60, null, null
    );
    const e = sim.units.find((u) => u.id === "e")!;
    const roster = sim.units.filter((u) => u.team === "player");
    // An indestructible punching bag: this is about the formation, not about who wins.
    const settle = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        e.hp = e.maxHp = 1e12;
        sim.step(50);
      }
    };
    for (let t = 0; t < 120_000; t += 50) {
      e.hp = e.maxHp = 1e12;
      sim.step(50);
      if (roster.every((u) => u.state !== "waiting" && u.state !== "charging")) break;
    }
    settle(20_000);
    const rank = () => roster.slice()
      .sort((a, b) => a.lineupIndex - b.lineupIndex).map((u) => u.id);
    const before = rank();
    const victim = sim.units.find((u) => u.id === victimId)!;
    (sim as any).dealDamage(victim, victim.maxHp, false);
    settle(20_000);
    expect(victim.alive, "the medic should have revived it").toBe(true);
    return { before, after: rank(), victim, sim, frontMost: () => frontMostId(sim) };
  }

  it("gives a revived Headless a new order but puts it at the head of the line", () => {
    const { before, after, victim, sim, frontMost } = reviveInLine(
      [headless("h"), regular("r0"), regular("r1"), regular("r2"), medic("g")], "h"
    );
    expect(before[0]).toBe("h");
    expect(after[0]).toBe("h");
    expect(victim.formOrder).toBeGreaterThan(
      Math.max(...sim.units.filter((u) => u.team === "player" && u.id !== "h").map((u) => u.formOrder))
    );
    expect(frontMost()).toBe("h");
  });

  it("pushes a resurrected Headless ahead of a Headless already at the front", () => {
    const { before, after } = reviveInLine(
      [headless("h0"), headless("h1"), regular("r0"), regular("r1"), regular("r2"),
        regular("r3"), regular("r4"), medic("g")], "h0"
    );
    expect(before.slice(0, 2)).toEqual(["h1", "h0"]);
    expect(after.slice(0, 2)).toEqual(["h0", "h1"]);
  });

  it("puts a resurrected ordinary body at the back", () => {
    const { before, after } = reviveInLine(
      [regular("r0"), regular("r1"), regular("r2"), medic("g")], "r0"
    );
    expect(before[0]).toBe("r0");
    expect(after).toEqual(["r1", "r2", "g", "r0"]);
  });
});
