import { describe, expect, it } from "vitest";
import { BattleSim, CHARGE_X, ENEMY_HOLD_X, type SimUnit } from "./BattleSim";
import {
  PIXEL_FIRE_BURN_MS,
  PIXEL_FIRE_PACE_REACH,
  PIXEL_ZOMBIE_KEY,
  PIXEL_ZOMBIE_TAPS,
} from "./videoGameStage";
import type { CombatUnit, SummonConfig } from "./types";

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

/** A stand-in for the alien boss's `bossSummonList`: abducted humans, not aliens. */
function abducteeQueue(): SummonConfig {
  const human = (key: string) => unit({ id: key, sourceKey: key, team: "enemy", con: 5 });
  return {
    queue: [human("FarmStageActorLumberjack"), human("CityStageActorCrazedWorker")],
    pool: [human("FarmStageActorFarmhand"), human("NinjaStageActorGirl")],
  };
}

/** Step the fight until `done` (or the tick budget runs out) without asserting anything
 *  along the way. Returns the ticks it took. */
function stepUntil(sim: BattleSim, done: () => boolean, limit = 400): number {
  let n = 0;
  while (n < limit && !done()) { sim.step(50); n++; }
  return n;
}
const miniReady = (sim: BattleSim) =>
  sim.activatedStatus().find((s) => s.key === "attachMini")?.ready ?? 0;

describe("Mini Buddy", () => {
  it("preserves mutation state for the raid renderer", () => {
    const player = unit({
      id: "mutant", sourceKey: "ZombieActorRegularTier1", team: "player", mutation: 1 | 8,
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([player], [enemy], null, true);
    expect(sim.units.find((candidate) => candidate.id === "mutant")?.mutation).toBe(1 | 8);
  });

  it("accepts special zombies classified as Large, including Dapper", () => {
    const dapper = unit({
      id: "dapper", sourceKey: "ZombieActorDapper", group: "Large", team: "player",
      abilities: ["attachMini"],
    });
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier4", group: "Small", team: "player",
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([dapper, imp], [enemy], null, true);

    stepUntil(sim, () => miniReady(sim) > 0);
    expect(sim.activatedStatus()).toContainEqual(
      expect.objectContaining({ key: "attachMini", ready: 1 }),
    );
    expect(sim.activate("attachMini")).toBe(true);
    expect(sim.units.find((candidate) => candidate.id === "dapper")?.buddyId).toBe("imp");
  });

  it("mounts before deployment, doubles the carrier run, then deploys both with a stun", () => {
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([brute, mini], [enemy], null, true);

    stepUntil(sim, () => miniReady(sim) > 0);
    expect(sim.activatedStatus()).toContainEqual(
      expect.objectContaining({ key: "attachMini", ready: 1 }),
    );
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

  it("mounts the brute that deploys next, not the one milling furthest forward", () => {
    // The carrier used to be chosen by `outranks` — front-most x — but every eligible
    // carrier is still in the back group, where x is `clusterHome` scatter (three columns,
    // 32 px apart) plus a shuffle that re-rolls every few seconds. So the mount went to an
    // arbitrary brute, and to a different one depending on when in the shuffle the tap
    // landed. Roster slot 2 sits a whole column (~64 px) right of slot 0, so pre-fix the
    // LAST brute in the queue took the mini while the first one deployed empty-handed.
    const large = (id: string) => unit({
      id, sourceKey: "ZombieActorLargeTier2", team: "player", abilities: ["attachMini"],
    });
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    // first deploys, mini, then last — the crowd's third column, and further right.
    const sim = new BattleSim([large("first"), mini, large("last")], [enemy], null, true);

    const first = sim.units.find((u) => u.id === "first")!;
    const last = sim.units.find((u) => u.id === "last")!;
    expect(last.x).toBeGreaterThan(first.x); // the scatter the old rule read as "in front"

    expect(sim.activate("attachMini")).toBe(true);
    expect(first.buddyId).toBe("mini");
    expect(last.buddyId).toBeNull();
  });

  it("rams all the way to the enemy it stuns, not just to its own slot", () => {
    // The move is "the brute runs forward and stuns what it HITS". It used to charge to
    // the carrier's own formation SLOT instead, and a Large's slot is the furthest back
    // of any body type (v23 gave each body its own standoff) — so with a full army the
    // charge stopped short and the stun landed on an enemy it had never reached.
    // Measured on a real party before the fix: the carrier halted 72 units behind its own
    // front rank and stunned a knight 162 units away.
    //
    // A CROWD is what makes this bite: with a two-zombie party the Large's slot is the
    // front line anyway, which is why the test above never caught it.
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const crowd = Array.from({ length: 10 }, (_, i) =>
      unit({ id: `filler${i}`, sourceKey: "ZombieActorRegularTier1", team: "player" }));
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      str: 0, con: 3000, hp: 1e6, maxHp: 1e6,
    });
    // Order matters as much as the crowd does. The carrier deploys ELEVENTH, which is what
    // puts it in a rear depth band (bands are five deep) with ten zombies already parked
    // in front of it — the real party's shape. The tap lands at once (the pair is queued
    // together at the back); the ram itself waits for the carrier's turn to deploy, which
    // comes well past stepUntil's usual 20-second budget — hence the wide loop below.
    const sim = new BattleSim([...crowd, brute, mini], [enemy], null, true);

    stepUntil(sim, () => miniReady(sim) > 0, 4000);
    expect(sim.activate("attachMini")).toBe(true);
    const b = sim.units.find((u) => u.id === "brute")!;
    const m = sim.units.find((u) => u.id === "mini")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    expect(b.buddyId).toBe("mini");

    for (let i = 0; i < 5000 && m.state === "carried"; i++) sim.step(50);
    expect(b.buddyId).toBeNull();
    expect(e.stunMs).toBeGreaterThan(0);
    // The whole point: it is standing ON the thing it just stunned. ENGAGE is 60, so
    // anything much past that means the ram paid out at a distance again.
    expect(Math.abs(e.x - b.x)).toBeLessThanOrEqual(70);
  });
});

// `present` drives whether the battle strip shows a move's button at all. It is a
// deliberately WIDER and steadier window than `ready` (which is a tap's success),
// because a button that blinks out between swings can't be aimed at or timed into.
describe("activated ability display window", () => {
  const presence = (sim: BattleSim, key: string) =>
    sim.activatedStatus().find((s) => s.key === key)?.present ?? false;

  // The window is "an un-mounted Large that has NOT YET DEPLOYED, with a mini still
  // behind it" — queued at the back and out being deployed both count. The button's look
  // and the tap it accepts are the same predicate, so a lit button always means a tap
  // will land. (The window was narrowed to the charge slot alone for a while; that made
  // it a few seconds per fight and easy to lose outright, so v36 restored the full span.)
  const miniSetup = () => {
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    return new BattleSim([brute, mini], [enemy], null, true);
  };

  it("arms from the first frame and stays lit until the Large has deployed", () => {
    const sim = miniSetup();
    const b = sim.units.find((u) => u.id === "brute")!;

    // Queued at the back: the pair is on the field, so the move is offered.
    expect(b.state).toBe("waiting");
    expect(presence(sim, "attachMini")).toBe(true);
    expect(miniReady(sim)).toBe(1);

    // Still armed across the walk out to the slot and the focus fill.
    sim.step(50);
    expect(b.state).toBe("charging");
    expect(b.x).toBeLessThan(CHARGE_X - 2);
    expect(presence(sim, "attachMini")).toBe(true);
    expect(miniReady(sim)).toBe(1);
    stepUntil(sim, () => Math.abs(b.x - CHARGE_X) <= 2);
    expect(presence(sim, "attachMini")).toBe(true);

    // Deployed un-mounted: too late to mount anyone.
    stepUntil(sim, () => b.state === "advance" || b.state === "fight");
    expect(presence(sim, "attachMini")).toBe(false);
    expect(miniReady(sim)).toBe(0);
    expect(sim.activate("attachMini")).toBe(false);
    expect(b.buddyId).toBeNull();
  });

  it("a tap while the Large is still queued mounts the mini where they stand", () => {
    const sim = miniSetup();
    const b = sim.units.find((u) => u.id === "brute")!;
    const m = sim.units.find((u) => u.id === "mini")!;
    const e = sim.units.find((u) => u.id === "enemy")!;

    expect(b.state).toBe("waiting");
    expect(sim.activate("attachMini")).toBe(true);
    expect(b.buddyId).toBe("mini");
    expect(m.state).toBe("carried");

    // The pair still deploys as one: the carrier walks out, charges, rams, and puts
    // the mini down on the enemy it stunned.
    for (let i = 0; i < 5000 && m.state === "carried"; i++) sim.step(50);
    expect(b.buddyId).toBeNull();
    expect(["advance", "fight"]).toContain(m.state);
    expect(e.stunMs).toBeGreaterThan(0);
  });

  it("stays dark with no Mini left to pick up, however the Large is placed", () => {
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const other = unit({ id: "other", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([brute, other], [enemy], null, true);
    const b = sim.units.find((u) => u.id === "brute")!;

    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(b.state);
      expect(presence(sim, "attachMini")).toBe(false);
      expect(miniReady(sim)).toBe(0);
      expect(sim.activate("attachMini")).toBe(false);
      sim.step(50);
    }
    expect(seen).toContain("charging"); // it really did stand in the slot
  });

  it("goes dark again once the only Mini has deployed on its own feet", () => {
    const mini = unit({ id: "mini", sourceKey: "ZombieActorSmallTier1", team: "player" });
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier2", team: "player",
      abilities: ["attachMini"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    // Mini first in the roster, so it takes the charge slot and leaves before the
    // brute ever gets there.
    const sim = new BattleSim([mini, brute], [enemy], null, true);
    const b = sim.units.find((u) => u.id === "brute")!;
    const m = sim.units.find((u) => u.id === "mini")!;

    stepUntil(sim, () => m.state === "advance" || m.state === "fight");
    stepUntil(sim, () => b.state === "charging" && b.x >= CHARGE_X - 2);
    expect(presence(sim, "attachMini")).toBe(false);
    expect(sim.activate("attachMini")).toBe(false);
    expect(b.buddyId).toBeNull();
  });

  it("keeps Bash on screen across its wind-up and recharge", () => {
    const brute = unit({
      id: "brute", sourceKey: "ZombieActorLargeTier3", team: "player", abilities: ["bash"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 4000 });
    const sim = new BattleSim([brute], [enemy], null, true);
    const b = sim.units.find((u) => u.id === "brute")!;

    for (let i = 0; i < 5000 && !sim.activatedStatus()[0].ready; i++) sim.step(50);
    expect(presence(sim, "bash")).toBe(true);
    expect(sim.activate("bash")).toBe(true);

    // Through the wind-up and the full 10s cooldown the button never leaves, even
    // as `state` toggles between "fight" and "advance" behind the scenes.
    for (let i = 0; i < 400 && b.alive && !sim.finished; i++) {
      sim.step(50);
      expect(presence(sim, "bash")).toBe(true);
    }
  });

  it("retires Explode once its zombie has spent it", () => {
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier3", team: "player", abilities: ["explode"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 4000 });
    const sim = new BattleSim([imp], [enemy], null, true);

    for (let i = 0; i < 5000 && !sim.activatedStatus()[0].ready; i++) sim.step(50);
    expect(presence(sim, "explode")).toBe(true);
    expect(sim.activate("explode")).toBe(true);

    for (let i = 0; i < 200 && presence(sim, "explode") && !sim.finished; i++) sim.step(50);
    expect(presence(sim, "explode")).toBe(false);
  });

  // Explode is a suicide move (ruleset 19): the payoff lands, then the performer goes
  // up with it. It is the army's biggest single hit and it costs a zombie.
  it("kills the zombie that explodes, but only after its blast has landed", () => {
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
      abilities: ["explode"], attackCooldownMs: 600,
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6,
    });
    const sim = new BattleSim([imp], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "imp")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    p.state = "fight";
    e.state = "hold";
    expect(sim.activate("explode")).toBe(true);

    const hpBefore = e.hp;
    (sim as any).stepWindup(p, e, 1e6); // run the wind-up straight to its payoff
    expect(e.hp).toBe(hpBefore - p.damage * 10); // the full 10× blast still connected
    expect(e.stunMs).toBe(3000);
    expect(p.alive).toBe(false); // ...and took the exploder with it
    expect(p.explodeFxSeq).toBe(1); // renderer trigger for the fireball
    expect(sim.outcome().losses).toContain("imp");
  });

  // Explode is a fuse the player lights on their own timing (ruleset 20). Standing in
  // the combat zone is enough — an enemy does not have to be in front of the zombie at
  // the moment of the tap, nor at the moment of the blast.
  it("can be lit, and still detonates, with nothing in front of the zombie", () => {
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
      abilities: ["explode"], attackCooldownMs: 600,
    });
    // Two enemies: the second is queued behind the first, so downing the first opens a
    // real gap in which the army is in position with nothing to swing at.
    const first = unit({ id: "e1", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const next = unit({
      id: "e2", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6,
    });
    const sim = new BattleSim([imp], [first, next], null, true);
    const p = sim.units.find((u) => u.id === "imp")!;
    const e1 = sim.units.find((u) => u.id === "e1")!;
    for (let i = 0; i < 600 && p.state !== "fight"; i++) sim.step(50);
    expect(p.state).toBe("fight");

    (sim as any).dealDamage(e1, e1.hp, true); // front enemy down; the next has not walked on
    sim.step(50);
    expect(p.state).toBe("advance"); // in position, but not engaged
    expect(sim.activate("explode")).toBe(true); // ...and the fuse lights anyway

    // The charge keeps burning while the field in front is empty, and pays off on time.
    const charge = p.windupTotal;
    for (let elapsed = 0; elapsed <= charge + 100 && p.alive; elapsed += 50) sim.step(50);
    expect(p.alive).toBe(false);
    expect(p.explodeFxSeq).toBe(1);
  });

  it("detonates into an empty field without a target", () => {
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
      abilities: ["explode"], attackCooldownMs: 600,
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([imp], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "imp")!;
    p.state = "fight";
    expect(sim.activate("explode")).toBe(true);

    // The payoff with no foe at all: the area hit sweeps an empty field, hurts nobody,
    // and still takes the exploder with it. Nothing here may throw on the null target.
    expect(() => (sim as any).stepWindup(p, null, 1e6)).not.toThrow();
    expect(p.alive).toBe(false);
    expect(p.explodeFxSeq).toBe(1);
    expect(sim.outcome().playerDamage).toBe(0);
  });

  it("lands no ordinary attacks while the explosion charges", () => {
    const imp = unit({
      id: "imp", sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
      abilities: ["explode"], attackCooldownMs: 600,
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6,
    });
    const sim = new BattleSim([imp], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "imp")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    for (let i = 0; i < 400 && !sim.activate("explode"); i++) sim.step(50);
    expect(p.windupKey).toBe("explode");

    // Step most of the way through the charge; the enemy must not lose a single point
    // of Life until the blast itself arrives.
    const hpAtCommit = e.hp;
    const charge = p.windupTotal;
    for (let elapsed = 0; elapsed < charge - 100; elapsed += 50) {
      sim.step(50);
      expect(e.hp).toBe(hpAtCommit);
    }
    expect(p.windupKey).toBe("explode"); // still charging, still not swinging
  });
});

// Ruleset 21/26. ZF2's `canRez` refuses a zombie in state 100 — the state
// `-[ZombieActorSmall suicide:]` sets, i.e. one that blew itself up. Reforged
// deliberately does not carry that over: the exploder is a normal casualty, so a Garden
// holder's Resurrect gets its shot at it. What it comes back with is another matter —
// ruleset 26 restores ZF2's own rule that a revived zombie's one-use moves are spent
// (`ressurectZombie:` 0x7d3c2-0x7d436), so there is no second bomb at all.
describe("reviving a zombie that blew itself up", () => {
  const smallExploder = (id: string) => unit({
    id, sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
    abilities: ["explode"], attackCooldownMs: 600,
  });
  const medic = () => unit({
    id: "medic", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
    isGarden: true, abilities: ["ressurect"],
  });
  const tank = () => unit({
    id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", hp: 1e6, maxHp: 1e6,
  });
  const zombies = (sim: BattleSim) => sim.units.filter((u) => u.team === "player");
  /** Run the WHOLE army out onto the field. The medic has to be deployed too —
   *  Resurrect only fires from a holder that is out there. */
  const deployAll = (sim: BattleSim) => {
    const queued = (u: SimUnit) => u.alive && u.state !== "advance" && u.state !== "fight";
    for (let i = 0; i < 2000 && zombies(sim).some(queued); i++) sim.step(50);
    expect(zombies(sim).some(queued)).toBe(false);
  };
  /** …and hold until an exploder has walked far enough forward to light its fuse. */
  const deploy = (sim: BattleSim) => {
    deployAll(sim);
    const ready = () => sim.activatedStatus().some((s) => s.key === "explode" && s.ready > 0);
    for (let i = 0; i < 2000 && !ready(); i++) sim.step(50);
    expect(ready()).toBe(true);
  };
  /** Light the next fuse and burn it down. Returns whoever the sim chose to spend.
   *  The extra step past the blast is the beat a Garden holder polls the corpse backlog
   *  on — the revive is no longer part of the death itself. */
  const detonate = (sim: BattleSim) => {
    deploy(sim);
    expect(sim.activate("explode")).toBe(true);
    const performer = sim.units.find((u) => u.windupKey === "explode")!;
    for (let i = 0; i < 400 && performer.windupKey; i++) sim.step(50);
    expect(performer.explodeFxSeq).toBeGreaterThan(0);
    sim.step(50);
    return performer;
  };

  it("brings the exploder back ALIVE but SPENT — no second fuse", () => {
    const sim = new BattleSim([smallExploder("imp"), medic()], [tank()], null, true);
    const imp = detonate(sim);
    expect(imp.id).toBe("imp");

    expect(imp.alive).toBe(true); // ZF2 would have left it dead (canRez state 100)
    expect(imp.hp).toBe(imp.maxHp);
    expect(sim.outcome().losses).not.toContain("imp");
    expect(imp.usedAbilities).toContain("explode"); // still consumed, exactly as ZF2 leaves it

    // Walk it all the way back up. Position is no longer the question — the move itself
    // is gone, so the strip has nothing to offer and a tap is refused.
    deployAll(sim);
    for (let i = 0; i < 400; i++) sim.step(50);
    expect(sim.activatedStatus().find((s) => s.key === "explode")?.ready).toBe(0);
    expect(sim.activate("explode")).toBe(false);
    expect(imp.alive).toBe(true);
  });

  it("still refuses when there is no healer to do it", () => {
    const sim = new BattleSim([smallExploder("imp")], [tank()], null, true);
    const imp = detonate(sim);
    for (let i = 0; i < 20; i++) sim.step(50); // the backlog is polled, so give it the chance
    expect(imp.alive).toBe(false);
    expect(sim.outcome().losses).toContain("imp");
  });

  it("takes a revived exploder out of the rotation, leaving its squadmate to go", () => {
    const sim = new BattleSim(
      [smallExploder("a"), smallExploder("b"), medic()], [tank()], null, true
    );
    const first = detonate(sim);
    expect(first.alive).toBe(true); // revived…
    expect(first.usedAbilities).toContain("explode"); // …with nothing left to light

    // Put the revived one back in FRONT of its squadmate, so position alone would pick it.
    const other = zombies(sim).find((p) => p.id !== first.id && p.abilities.includes("explode"))!;
    deploy(sim);
    first.x = other.x + 40;

    expect(sim.activate("explode")).toBe(true);
    expect(other.windupKey).toBe("explode"); // the one who still owns a shot spends it
    expect(first.windupKey).toBeNull();
  });

  it("no longer refuses a Small cut down by an ordinary enemy", () => {
    // The old blanket `isSmall` rejection was read off a wrong note in the binary audit,
    // so it also stranded Smalls that never touched an ability.
    const plain = unit({
      id: "runt", sourceKey: "ZombieActorSmallTier1", group: "Small", team: "player",
    });
    const sim = new BattleSim([plain, medic()], [tank()], null, true);
    const runt = sim.units.find((u) => u.id === "runt")!;
    deployAll(sim); // this army carries no Explode at all, so there is no fuse to wait on
    (sim as any).dealDamage(runt, runt.hp, false);
    expect(runt.alive).toBe(false); // the revive is polled, not instant
    sim.step(50);

    expect(runt.alive).toBe(true);
    expect(runt.usedAbilities).toEqual([]); // it owned no one-use move to lose
  });
});

describe("finished combat input", () => {
  it("rejects ability and focus inputs after the decisive tick", () => {
    const player = unit({
      id: "player", sourceKey: "ZombieActorLargeTier2", team: "player", abilities: ["bash"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([player], [enemy], null, true);
    const live = sim.units.find((candidate) => candidate.id === "player")!;
    live.state = "charging";
    live.distracted = true;
    sim.finished = true;

    expect(sim.activate("bash")).toBe(false);
    expect(sim.popBubble("player")).toBe(false);
  });
});

describe("deployed team ability counts", () => {
  it("counts only living carriers on the battlefield", () => {
    const first = unit({
      id: "first", sourceKey: "ZombieActorRegularTier2", team: "player",
      group: "Regular", abilities: ["chivalry"],
    });
    const second = unit({
      id: "second", sourceKey: "ZombieActorRegularTier2", team: "player",
      group: "Regular", abilities: ["chivalry"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([first, second], [enemy], null, true);
    const [a, b] = sim.units.filter((candidate) => candidate.team === "player");

    expect(sim.teamAbilityStatus()).toContainEqual({ key: "chivalry", count: 0 });
    a.state = "advance";
    expect(sim.teamAbilityStatus()).toContainEqual({ key: "chivalry", count: 1 });
    b.state = "fight";
    expect(sim.teamAbilityStatus()).toContainEqual({ key: "chivalry", count: 2 });
    a.alive = false;
    expect(sim.teamAbilityStatus()).toContainEqual({ key: "chivalry", count: 1 });
  });

  it("activates and stacks aura stats only as carriers deploy", () => {
    const girl = unit({
      id: "girl", sourceKey: "ZombieActorFemaleTier1", team: "player", group: "Female",
      str: 12, dex: 6, con: 36, hp: 3600, maxHp: 3600, attackCooldownMs: 2000 / 6,
      teamAuraStats: {
        baseStr: 10, baseDex: 5, baseCon: 30,
        strPerCarrier: 1, dexPerCarrier: 0.5, conPerCarrier: 3,
      },
    });
    const carriers = ["a", "b"].map((id) => unit({
      id, sourceKey: `ZombieActorRegular${id}`, team: "player",
      group: "Regular", abilities: ["chivalry"],
    }));
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000,
    });
    const sim = new BattleSim([girl, ...carriers], [enemy], null, true);
    const liveGirl = sim.units.find((candidate) => candidate.id === "girl")!;
    const [a, b] = carriers.map(({ id }) => sim.units.find((candidate) => candidate.id === id)!);

    expect(liveGirl.maxHp).toBe(3000);
    a.state = "advance";
    sim.step(1);
    expect(liveGirl.maxHp).toBe(3300);
    b.state = "advance";
    sim.step(1);
    expect(liveGirl.maxHp).toBe(3600);
  });
});

describe("Garden healing and formation depth", () => {
  // Knockback costs a zombie its DEPTH BAND, not its slot inside one: `setZombieToLastIndex`
  // moves it to the tail of the deployed block, and `calculateDestinationPoint` then reads a
  // band one deeper off its new index. Six zombies, so the tail is in the second band.
  it("drops a knocked-back zombie into the next depth band, and the row closes up", () => {
    const players = [
      unit({ id: "headless", sourceKey: "ZombieActorHeadlessTier1", team: "player", isHeadless: true }),
      ...Array.from({ length: 5 }, (_, i) =>
        unit({ id: `regular-${i}`, sourceKey: "ZombieActorRegularTier1", team: "player" })
      ),
    ];
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000, attackCooldownMs: 100_000,
    });
    const sim = new BattleSim(players, [enemy], null, true);
    const deployed = sim.units.filter((candidate) => candidate.team === "player");
    deployed.forEach((candidate, i) => {
      candidate.state = "advance";
      candidate.formOrder = i;
    });
    (sim as unknown as { releaseSeq: number }).releaseSeq = deployed.length;
    const foe = sim.units.find((candidate) => candidate.id === "enemy")!;
    foe.state = "hold";

    sim.step(50);
    const headless = deployed[0];
    const spare = deployed[5]; // the one sitting alone in band 1
    // A Headless leans IN (standoff -5), so it takes the front of its row.
    expect(headless.slotX).toBeGreaterThan(deployed[1].slotX);
    expect(headless.slotX).toBeGreaterThan(spare.slotX);
    const headlessFrontX = headless.slotX;

    (sim as unknown as { knockBackZombie(unit: typeof headless): void }).knockBackZombie(headless);
    sim.step(50);

    // It is now the tail of the deployed block, so band 1 — a whole band behind the line,
    // and behind the zombie that was the tail before it.
    expect(headless.slotX).toBeLessThan(headlessFrontX);
    expect(spare.slotX).toBeGreaterThan(headless.slotX);
  });

  // GROUND TRUTH (`Actor knockBackBy:force:` / `Actor movementUpdate:`): the shove is a
  // SLIDE toward a parked knockBackPoint at force*60 px/s, not a teleport, and the zombie
  // is out of melee for its duration.
  it("slides a knocked-back zombie instead of teleporting it", () => {
    const p = unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000, attackCooldownMs: 100_000,
    });
    const sim = new BattleSim([p], [enemy], null, true);
    const live = sim.units.find((u) => u.id === "p")!;
    live.state = "advance";
    sim.units.find((u) => u.id === "enemy")!.state = "hold";
    sim.step(50); // one step to assign the formation slot
    live.x = live.slotX; // stand it on the line — a shove is measured from where it is
    const startX = live.x;

    (sim as unknown as { knockBackZombie(u: SimUnit): void }).knockBackZombie(live);
    expect(live.knockBackSpeed).toBeGreaterThan(0);
    const target = live.knockBackToX;
    // 50-149 source points of shove, converted into field units.
    expect(startX - target).toBeGreaterThan(0);

    sim.step(50);
    expect(live.x).toBeGreaterThan(target); // still travelling — not snapped
    expect(live.x).toBeLessThan(startX);
    expect(live.state).not.toBe("fight"); // out of melee while the point is live

    for (let i = 0; i < 40 && live.knockBackSpeed > 0; i++) sim.step(50);
    expect(live.knockBackSpeed).toBe(0); // point reached and cleared
  });

  // `cantInterrupt` in Attacks.json, on exactly ZombieBash/BashV2/Explode/ExplodeV2.
  // `fightAttack:` writes `canInterrupt = !cantInterrupt` for the swing and `damageIn:`
  // refuses BOTH the stun and the shove while it is NO — super armour on the moves you
  // spend a charge on.
  it("cannot shove or stun a zombie mid-Smash, but can once the swing ends", () => {
    const p = unit({
      id: "p", sourceKey: "ZombieActorRegularTier4", team: "player",
      hp: 1e6, maxHp: 1e6, abilities: ["bashV2"],
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000, knockBack: true, stunMs: 1000,
    });
    const sim = new BattleSim([p], [enemy], null, true);
    const live = sim.units.find((u) => u.id === "p")!;
    const foe = sim.units.find((u) => u.id === "enemy")!;
    live.state = "fight";
    foe.state = "hold";
    sim.step(50);

    live.windupKey = "bashV2"; // mid-Smash
    live.knockBackSpeed = 0;
    live.stunMs = 0;
    for (let i = 0; i < 200 && live.knockBackSpeed === 0 && live.stunMs === 0; i++) {
      live.windupKey = "bashV2";
      live.state = "fight";
      foe.state = "hold";
      sim.step(50);
    }
    expect(live.knockBackSpeed).toBe(0); // never shoved while the Smash is winding up
    expect(live.stunMs).toBe(0); // and never stunned out of it

    // Drop the wind-up and the very same enemy lands both effects.
    for (let i = 0; i < 200 && live.knockBackSpeed === 0; i++) {
      live.windupKey = null;
      live.state = "fight";
      foe.state = "hold";
      sim.step(50);
    }
    expect(live.knockBackSpeed).toBeGreaterThan(0);
  });

  it("fills a front slot when its occupant dies", () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      unit({ id: `player-${i}`, sourceKey: "ZombieActorRegularTier1", team: "player" })
    );
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000, attackCooldownMs: 100_000,
    });
    const sim = new BattleSim(players, [enemy], null, true);
    const deployed = sim.units.filter((candidate) => candidate.team === "player");
    deployed.forEach((candidate, i) => {
      candidate.state = "advance";
      candidate.formOrder = i;
    });
    const foe = sim.units.find((candidate) => candidate.id === "enemy")!;
    foe.state = "hold";

    sim.step(50);
    const fallen = deployed[0];
    const replacement = deployed[4];
    expect(fallen.slotX).toBeGreaterThan(replacement.slotX);
    const replacementSlotX = replacement.slotX;
    const replacementStartX = replacement.x;
    fallen.alive = false;
    fallen.state = "dead";

    sim.step(50);
    // The row is one shorter, so every survivor shuffles one slot forward. (It is a
    // shuffle, not a promotion to the dead zombie's exact spot: the source recomputes each
    // slot from the row's CURRENT membership.)
    expect(replacement.slotX).toBeGreaterThan(replacementSlotX);
    expect(replacement.x).toBeGreaterThan(replacementStartX);
  });

  it("does not let healing re-arm consumed one-shot protection", () => {
    const fighter = unit({
      id: "fighter", sourceKey: "ZombieActorRegularTier1", team: "player",
      hp: 100, maxHp: 100, str: 0.1,
    });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier1", team: "player",
      hp: 100, maxHp: 100, str: 0.1, isGarden: true, abilities: ["heal"],
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      str: 100, hp: 100_000, maxHp: 100_000, attackCooldownMs: 4000,
    });
    const sim = new BattleSim([fighter, healer], [enemy], null, true);
    const f = sim.units.find((u) => u.id === "fighter")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    f.state = "advance";
    h.state = "advance";
    e.state = "hold";
    e.x = 915;
    e.y = 280;

    for (let elapsed = 0; elapsed < 30_000 && !(f.oneShotProtectionUsed && f.hp > 1); elapsed += 50) {
      sim.step(50);
    }
    expect(h.healCastSeq).toBeGreaterThan(0);
    expect(f.oneShotProtectionUsed).toBe(true);
    expect(f.hp).toBeGreaterThan(1);

    const resumed = new BattleSim([fighter, healer], [enemy], null, true);
    resumed.restore(sim.snapshot());
    const restoredFighter = resumed.units.find((u) => u.id === "fighter")!;
    expect(restoredFighter.oneShotProtectionUsed).toBe(true);
    for (let elapsed = 0; elapsed < 30_000 && restoredFighter.alive; elapsed += 50) resumed.step(50);

    expect(restoredFighter.alive).toBe(false);
    expect(restoredFighter.hp).toBe(0);
  });

  it("holds a healer behind the line and restores any damaged deployed ally", () => {
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
    f.hp = 2900; // injured, but still well above half Life

    sim.step(50);
    expect(h.slotX).toBeLessThan(f.slotX - 200);
    expect(f.hp).toBe(2925); // healer Power 50 × 0.5
    expect(f.healFxSeq).toBe(1);
    expect(h.healCastSeq).toBe(1);
  });

  it("fires Heal All every 20 seconds for half the healer's Power", () => {
    const a = unit({ id: "a", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1000 });
    const b = unit({ id: "b", sourceKey: "ZombieActorFemaleTier1", team: "player", hp: 2000 });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier4", team: "player",
      isGarden: true, abilities: ["healAOE"],
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000, attackCooldownMs: 100_000,
    });
    const sim = new BattleSim([a, b, healer], [enemy], null, true);
    for (const id of ["a", "b", "healer"]) sim.units.find((u) => u.id === id)!.state = "advance";

    for (let elapsed = 0; elapsed < 19_950; elapsed += 50) sim.step(50);
    expect(sim.units.find((u) => u.id === "a")!.hp).toBe(1000);
    sim.step(50);
    expect(sim.units.find((u) => u.id === "a")!.hp).toBe(1025);
    expect(sim.units.find((u) => u.id === "b")!.hp).toBe(2025);
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

  it("throws boss debris for its authored damage, unscaled", () => {
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const wall = unit({ id: "wall", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const boss = unit({ id: "boss", sourceKey: "FarmStageActorBoss", team: "enemy", isBoss: true, con: 300 });
    const sim = new BattleSim([player], [wall, boss], {
      intervalMs: 50,
      options: [{ damage: 6, weight: 1, sprite: "throw.png", spriteSize: 32 }],
    }, true);
    sim.units.find((u) => u.id === "player")!.state = "advance";
    sim.step(50);
    // Ground truth: the bossAction's `damage` reaches `[zombie damage:]` verbatim
    // (ZFFightPhysics throwProjectile: → setDamageAmount). No chip scaling.
    expect(sim.projectiles[0]?.damage).toBe(6);
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
    // The laser only fires at an ENGAGED zombie (`allowedToShootBullet`), and the boss's
    // action is resolved before the zombies are stepped, so hold the state across both.
    // The bolt is NOT led (the source aims at the target's position when the trigger is
    // pulled), so the zombie has to stand still for it to connect.
    p.moveSpeed = 0;
    p.state = "fight";
    sim.step(16); // select the special
    p.state = "fight";
    sim.step(16); // launch the straight projectile
    for (let i = 0; i < 400 && p.hp === 100; i++) {
      p.state = "fight";
      sim.step(16);
    }
    expect(p.hp).toBe(1);
    expect(p.alive).toBe(true);
  });

  it("cycles a throw-less boss through its specials on the shared action budget", () => {
    const player = unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const wall = unit({ id: "wall", sourceKey: "AlienStageActorMinion", team: "enemy", con: 300 });
    const boss = unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, con: 300 });
    // An abductee queue is required for `summonBoss` to be performable at all — the
    // source gates it on `allowedToSummonBoss`, and an ungated roll is re-rolled.
    const sim = new BattleSim([player], [wall, boss], null, true, [
      { name: "summonBoss", weight: 50, castMs: 50, cooldownMs: 300, damage: 0 },
      { name: "alienLaser", weight: 30, castMs: 50, cooldownMs: 300, damage: 0 },
    ], undefined, abducteeQueue());
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

  // A row is ordered by BODY TYPE, not by release order: `calculateDestinationPoint`'s
  // bucketed insertion runs Small -> Headless -> Girl -> Regular -> Large -> Garden, and
  // each body carries its own standoff (Headless -5, Regular +8) so a light body plants
  // closer to the enemy. Slot 0 also takes the largest y — nearest the camera, drawn in
  // front, which is what the source's explicit zOrder does.
  it("orders a row by body type, lightest to the front", () => {
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
    expect(a.slotX).toBeGreaterThan(b.slotX); // the Headless leans in past the Regular
    expect(a.slotY).toBeGreaterThan(b.slotY); // ...and stands nearest the camera
  });

  // Release order decides the BAND; body type only decides the slot inside one. A Large
  // released first still leads the row it is in, because its band is shallower.
  it("keeps release order as the band, with body type only sorting inside it", () => {
    const large = unit({ id: "large", sourceKey: "ZombieActorLargeTier1", group: "Large", team: "player" });
    const smalls = Array.from({ length: 5 }, (_, i) =>
      unit({ id: `small-${i}`, sourceKey: "ZombieActorSmallTier1", group: "Small", team: "player" })
    );
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", con: 300 });
    const sim = new BattleSim([large, ...smalls], [enemy], null, true);
    const deployed = sim.units.filter((u) => u.team === "player");
    deployed.forEach((u, i) => { u.state = "advance"; u.formOrder = i; });
    sim.units.find((u) => u.id === "enemy")!.state = "hold";

    sim.step(50);
    const big = deployed[0];
    const bandOneSmall = deployed[5];
    // Inside band 0 the Smalls outrank the Large...
    expect(deployed[1].slotX).toBeGreaterThan(big.slotX);
    // ...but the Small that spilled into band 1 is behind the whole of band 0.
    expect(bandOneSmall.slotX).toBeLessThan(big.slotX);
  });
});

describe("binary-authentic ability procs", () => {
  it("blocks exactly the nine >90 integer results in each 100-roll cycle", () => {
    const blocker = unit({
      id: "blocker", sourceKey: "ZombieActorHeadlessTier4", team: "player",
      hp: 10_000, maxHp: 10_000, abilities: ["block"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([blocker], [enemy], null, true);
    const live = sim.units.find((u) => u.id === "blocker")!;
    for (let i = 0; i < 100; i++) (sim as any).dealEnemyDamage(live, 1);
    expect(live.hp).toBe(10_000 - 91);
  });

  it("adds 29 quarter-Power strikes per 100 attacks", () => {
    const striker = unit({
      id: "striker", sourceKey: "ZombieActorFemaleTier4", team: "player",
      abilities: ["doubleStrike"],
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000,
    });
    const sim = new BattleSim([striker], [enemy], null, true);
    const s = sim.units.find((u) => u.id === "striker")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    for (let i = 0; i < 100; i++) {
      s.timerMs = 0;
      (sim as any).tryAttack(s, e, 0);
    }
    expect(e.hp).toBe(100_000 - 100 * 50 - 29 * 13);
  });

  it("stuns on exactly the four >95 integer results in each 100-roll cycle", () => {
    const stunner = unit({
      id: "stunner", sourceKey: "ZombieActorFemaleTier3", team: "player",
      abilities: ["stun"],
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 100_000, maxHp: 100_000,
    });
    const sim = new BattleSim([stunner], [enemy], null, true);
    const s = sim.units.find((u) => u.id === "stunner")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    let procs = 0;
    for (let i = 0; i < 100; i++) {
      e.stunMs = 0;
      s.timerMs = 0;
      (sim as any).tryAttack(s, e, 0);
      if (e.stunMs === 1000) procs++;
    }
    expect(procs).toBe(4);
  });
});

describe("lasers, resurrection, and activated attacks", () => {
  it("fires the base walking laser for 20 % of Power", () => {
    const laser = unit({
      id: "laser", sourceKey: "ZombieActorRegularTier3", team: "player",
      abilities: ["laserBeam"], attackCooldownMs: 600,
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 10_000, maxHp: 10_000,
    });
    const sim = new BattleSim([laser], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "laser")!;
    const e = sim.units.find((u) => u.id === "enemy")!;
    p.state = "advance";
    p.x = 300;
    e.state = "hold";
    e.x = 915;
    sim.step(200); // finalAttackSpeed / 3
    expect(e.hp).toBe(9990); // str 5 -> power 50 -> 20 %
    expect(p.laserFxSeq).toBe(1);
    expect(p.laserTargetId).toBe("enemy");
  });

  it("emits the upgraded T4 laser presentation at its faster cadence", () => {
    const laser = unit({
      id: "laser-v2", sourceKey: "ZombieActorRegularTier4", team: "player",
      abilities: ["laserBeam", "zomBeam"], attackCooldownMs: 600,
    });
    const enemy = unit({
      id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy",
      hp: 10_000, maxHp: 10_000,
    });
    const sim = new BattleSim([laser], [enemy], null, true);
    const p = sim.units.find((u) => u.id === "laser-v2")!;
    p.state = "advance";
    p.x = 300;
    const e = sim.units.find((u) => u.id === "enemy")!;
    e.state = "hold";
    e.x = 915;

    sim.step(100); // finalAttackSpeed / 6

    expect(p.laserFxSeq).toBe(1);
    expect(p.laserTargetId).toBe("enemy");
    expect(e.hp).toBe(9990); // same bolt as the T3 beam; only the cadence upgrades
  });

  /** A fighter, a Garden medic, and a punching bag. The medic starts deployed unless the
   *  test is specifically about an undeployed one. */
  const rezParty = (deployHealer: boolean) => {
    const fighter = unit({ id: "fighter", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([fighter, healer], [enemy], null, true);
    const f = sim.units.find((u) => u.id === "fighter")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    if (deployHealer) h.state = "advance";
    return { sim, f, h };
  };

  it("resurrects one zombie once at full Life", () => {
    const { sim, f, h } = rezParty(true);

    (sim as any).dealDamage(f, f.maxHp, false);
    expect(f.alive).toBe(false); // the backlog is polled from the Garden's own update…
    sim.step(50);
    expect(f.alive).toBe(true); // …so the revive lands on the next beat
    expect(f.hp).toBe(f.maxHp);
    expect(h.resurrectUsed).toBe(true);

    (sim as any).dealDamage(f, f.maxHp, false);
    sim.step(50);
    expect(f.alive).toBe(false); // one revive per Garden zombie, for the whole fight
  });

  it("does not resurrect while its holder is still queued at the back", () => {
    const { sim, f, h } = rezParty(false);

    (sim as any).dealDamage(f, f.maxHp, false);
    sim.step(50);
    expect(f.alive).toBe(false);
    expect(h.resurrectUsed).toBe(false);
  });

  // The corpse backlog: `defeatedZombies` accumulates for the whole fight and nothing
  // drains it but a revival, so a holder that reaches the field LATER still gets its shot
  // at a zombie that fell before it arrived. The old instant-on-death model lost that
  // casualty for good.
  it("revives a zombie that fell before the holder was deployed", () => {
    const { sim, f, h } = rezParty(false);

    (sim as any).dealDamage(f, f.maxHp, false);
    sim.step(50);
    expect(f.alive).toBe(false); // nobody out there to do it yet

    h.state = "advance"; // the medic finally walks on
    sim.step(50);
    expect(f.alive).toBe(true);
    expect(f.hp).toBe(f.maxHp);
    expect(h.resurrectUsed).toBe(true);
  });

  it("takes the most recent casualty when several are waiting", () => {
    const first = unit({ id: "first", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const second = unit({ id: "second", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([first, second, healer], [enemy], null, true);
    const a = sim.units.find((u) => u.id === "first")!;
    const b = sim.units.find((u) => u.id === "second")!;
    const h = sim.units.find((u) => u.id === "healer")!;

    (sim as any).dealDamage(a, a.maxHp, false);
    (sim as any).dealDamage(b, b.maxHp, false);
    h.state = "advance";
    sim.step(50);

    expect(b.alive).toBe(true); // the last to fall is the one `ressurectZombie:` reads
    expect(a.alive).toBe(false);
  });

  it("counts the revives left across deployed Garden holders", () => {
    const fighter = unit({ id: "fighter", sourceKey: "ZombieActorRegularTier1", team: "player" });
    const medics = ["m1", "m2"].map((id) => unit({
      id, sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    }));
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([fighter, ...medics], [enemy], null, true);
    const f = sim.units.find((u) => u.id === "fighter")!;

    expect(sim.resurrectsLeft()).toBe(0); // both medics still queued at the back
    for (const id of ["m1", "m2"]) sim.units.find((u) => u.id === id)!.state = "advance";
    expect(sim.resurrectsLeft()).toBe(2);
    expect(sim.teamAbilityStatus()).toContainEqual({ key: "ressurect", count: 2 });

    (sim as any).dealDamage(f, f.maxHp, false);
    sim.step(50);
    expect(f.alive).toBe(true);
    expect(sim.resurrectsLeft()).toBe(1); // one spent, one still banked
    expect(sim.teamAbilityStatus()).toContainEqual({ key: "ressurect", count: 1 });

    (sim as any).dealDamage(f, f.maxHp, false);
    sim.step(50);
    expect(f.alive).toBe(true);
    expect(sim.resurrectsLeft()).toBe(0); // …and now the safety net is gone
  });

  // ZF2 marks EVERY consumable ability on the revived actor consumed — including tag 29
  // itself, which is what stops two Garden holders from reviving each other for the rest
  // of the fight. `resurrectUsed` is never cleared either way, so an army is bounded at
  // one revive per Garden zombie it deployed.
  it("brings a Garden holder back without its own Resurrect", () => {
    const medics = ["m1", "m2"].map((id) => unit({
      id, sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    }));
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim(medics, [enemy], null, true);
    const [m1, m2] = ["m1", "m2"].map((id) => sim.units.find((u) => u.id === id)!);
    m1.state = "advance";
    m2.state = "advance";
    expect(sim.resurrectsLeft()).toBe(2);

    (sim as any).dealDamage(m2, m2.maxHp, false);
    sim.step(50);
    expect(m2.alive).toBe(true); // m1 brought it back…
    expect(m1.resurrectUsed).toBe(true); // …spending its own
    expect(m2.resurrectUsed).toBe(true); // …and it returned with nothing to give
    expect(sim.resurrectsLeft()).toBe(0); // so the pair can never chain

    (sim as any).dealDamage(m2, m2.maxHp, false);
    sim.step(50);
    expect(m2.alive).toBe(false);
  });

  it("spends a one-use move the revived zombie never got to use", () => {
    const bomber = unit({
      id: "bomber", sourceKey: "ZombieActorSmallTier3", group: "Small", team: "player",
      abilities: ["explode"],
    });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier3", group: "Garden", team: "player",
      isGarden: true, abilities: ["ressurect"],
    });
    const enemy = unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy" });
    const sim = new BattleSim([bomber, healer], [enemy], null, true);
    const b = sim.units.find((u) => u.id === "bomber")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    b.state = "advance";
    h.state = "advance";

    // Cut down before it ever lit the fuse. The revival is unconditional: coming back is
    // the reward, coming back armed is not.
    (sim as any).dealDamage(b, b.maxHp, false);
    expect(b.usedAbilities).toEqual([]);
    sim.step(50);
    expect(b.alive).toBe(true);
    expect(b.usedAbilities).toContain("explode");
  });

  it("uses shipped Explode damage/stun once and keeps Ver.1 from hitting bosses", () => {
    const mini = unit({
      id: "mini", sourceKey: "ZombieActorSmallTier3", team: "player",
      abilities: ["explode"], attackCooldownMs: 600,
    });
    const boss = unit({
      id: "boss", sourceKey: "FarmStageActorBoss", team: "enemy",
      isBoss: true, hp: 10_000, maxHp: 10_000,
    });
    const sim = new BattleSim([mini], [boss], null, true);
    const p = sim.units.find((u) => u.id === "mini")!;
    const e = sim.units.find((u) => u.id === "boss")!;
    p.state = "fight";
    e.state = "hold";
    expect(sim.activate("explode")).toBe(true);
    (sim as any).stepWindup(p, e, 4000);
    expect(e.hp).toBe(10_000);
    expect(sim.activate("explode")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enemy damage rate + boss hazards, against the disassembled values.
// (See combatStats "Attack CADENCE" and enemy-damage ground truth.)

describe("enemy cadence and boss hazard damage (ground truth)", () => {
  const player = (over: Partial<CombatUnit> = {}) =>
    unit({ id: "player", sourceKey: "ZombieActorRegularTier1", team: "player", ...over });
  const enemy = (over: Partial<CombatUnit> = {}) =>
    unit({ id: "enemy", sourceKey: "FarmStageActorFarmhand", team: "enemy", ...over });
  /** Put the boss on its holding spot and the zombies out fighting, so the special
   *  scheduler is live from the first step (it only runs while the boss is engaged). */
  // A boss casts from its PERCH and nowhere else — `bossUpdate:` only rolls an action in
  // state 19, and a boss that has finished its descent drops through to `civilianUpdate`
  // with no action budget at all. So these helpers leave a boss up top, and the specials
  // sims below field a live minion so the descent never legitimately triggers.
  const onTheLine = (sim: BattleSim) => {
    for (const u of sim.units) {
      u.state = u.team === "enemy" ? (u.isBoss ? "structure" : "hold") : "advance";
    }
  };

  /** Zombies toe-to-toe with the wave — what `isInMeleeRange` reports, and the only
   *  state the alien laser will fire at. */
  const inMelee = (sim: BattleSim) => {
    for (const u of sim.units) {
      u.state = u.team === "enemy" ? (u.isBoss ? "structure" : "hold") : "fight";
    }
  };

  /** A punching-bag minion: keeps the boss legitimately perched (the wave is not clear)
   *  without ever taking part in what the test is measuring. */
  const bagMinion = () =>
    unit({
      id: "bag", sourceKey: "AlienStageActorMinion", team: "enemy",
      str: 0, hp: 1e7, maxHp: 1e7,
    });

  it("an enemy strikes on its raw 1/dex clock — twice per equal-dex zombie swing", () => {
    // dex 2: zombie cycle 1000 ms, enemy cycle 500 ms (CombatEngine derives these; here
    // they arrive pre-derived, so assert the sim honours them without a pace multiplier).
    const p = player({ hp: 1e7, maxHp: 1e7, attackCooldownMs: 1000 });
    const e = enemy({ str: 10, hp: 1e7, maxHp: 1e7, attackCooldownMs: 500 });
    const sim = new BattleSim([p], [e], null, true);
    const zombie = sim.units.find((u) => u.id === "player")!;
    const foe = sim.units.find((u) => u.id === "enemy")!;
    for (let i = 0; i < 400; i++) sim.step(50); // 20 s of contact
    const zombieHits = (zombie.maxHp - zombie.hp) / foe.damage;
    const enemyHits = (foe.maxHp - foe.hp) / zombie.damage;
    expect(zombieHits).toBeGreaterThan(enemyHits * 1.8); // ~2× as many enemy swings
  });

  /** One zombie set alight, stepped only as far as the tick the fire catches on, with a
   *  boss whose cooldown guarantees it never casts a second time. */
  const litFire = () => {
    const a = player({ id: "a", hp: 1e6, maxHp: 1e6 });
    const b = unit({ id: "b", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e6, maxHp: 1e6 });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([a, b], [bagMinion(), boss], null, true, [
      { name: "pixelFire", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 },
    ]);
    // Take melee off the table entirely: these tests measure the FIRE alone, and since
    // v40's reach-of-last-resort an enemy strikes whoever is hitting it even outside
    // melee range — a stray hit of the 1-damage clamp inside the burn window would read
    // as the burn mispaying.
    for (const u of sim.units) if (u.team === "enemy") u.damage = 0;
    onTheLine(sim);
    for (let i = 0; i < 40 && !sim.burningPlayers().length; i++) sim.step(50);
    return sim;
  };

  it("pixelFire lights ONE zombie, never the whole line", () => {
    const sim = litFire();
    // The single-target pick is ground truth (`ZFFightMan pixelFire` chooses one eligible
    // zombie); only the burn's DURATION is ours. The source data labels the action AoE and
    // it has never behaved that way — guard against it drifting back.
    expect(sim.burningPlayers()).toHaveLength(1);
    for (let i = 0; i < 40; i++) sim.step(50);
    const hurt = sim.units.filter((u) => u.team === "player" && u.hp < u.maxHp);
    expect(hurt).toHaveLength(1);
  });

  it("pixelFire burns at 5 % of max HP per second for its whole duration", () => {
    const sim = litFire();
    const victim = sim.burningPlayers()[0];
    // The rate is ground truth (`damage: hitPointsTotal/20 × dt`) and is charged against
    // ELAPSED TIME, not per tick — a 50 ms step and a 16 ms one remove the same HP per
    // second. So a second of burning costs 5 % of max HP, and the second second costs the
    // same again: the burn does not ramp, taper, or stop after one frame.
    const start = victim.hp;
    for (let i = 0; i < 20; i++) sim.step(50);
    const firstSecond = start - victim.hp;
    const mid = victim.hp;
    for (let i = 0; i < 20; i++) sim.step(50);
    const secondSecond = mid - victim.hp;
    expect(firstSecond / victim.maxHp).toBeCloseTo(0.05, 3);
    expect(secondSecond / firstSecond).toBeCloseTo(1, 2);
  });

  it("a burning zombie paces on the spot instead of fighting", () => {
    const sim = litFire();
    const victim = sim.burningPlayers()[0];
    const anchor = victim.burnAnchorX;
    let minX = victim.x;
    let maxX = victim.x;
    for (let i = 0; i < 40; i++) {
      sim.step(50);
      minX = Math.min(minX, victim.x);
      maxX = Math.max(maxX, victim.x);
    }
    // It goes both ways and stays within reach of where the fire caught it — a panic, not
    // a retreat and not an advance.
    expect(minX).toBeLessThan(anchor - 1); // it panics AWAY from the enemy first…
    expect(maxX).toBeGreaterThan(anchor + 1); // …then swings back past where it started
    expect(anchor - minX).toBeLessThanOrEqual(PIXEL_FIRE_PACE_REACH + 1);
    expect(maxX - anchor).toBeLessThanOrEqual(PIXEL_FIRE_PACE_REACH + 1);
  });

  it("the fire goes out on its own, and a tap puts it out early", () => {
    const burnTicks = Math.ceil(PIXEL_FIRE_BURN_MS / 50);
    const alone = litFire();
    for (let i = 0; i < burnTicks + 2; i++) alone.step(50);
    expect(alone.burningPlayers()).toHaveLength(0); // ran its course

    const tapped = litFire();
    const victim = tapped.burningPlayers()[0];
    for (let i = 0; i < 4; i++) tapped.step(50);
    const lostBeforeTap = victim.maxHp - victim.hp;
    expect(tapped.tapFire(victim.id)).toBe(true);
    expect(tapped.tapFire(victim.id)).toBe(false); // nothing left to put out
    for (let i = 0; i < burnTicks + 2; i++) tapped.step(50);
    // Smothered: it stops paying the instant the fire is out, and what it did pay is a
    // small fraction of the full burn it was on course for.
    expect(victim.maxHp - victim.hp).toBe(lostBeforeTap);
    expect(lostBeforeTap).toBeLessThan(
      victim.maxHp * 0.05 * (PIXEL_FIRE_BURN_MS / 1000) * 0.25
    );
  });

  /** A pixel zombie template shaped like the one videoGameStage builds out of
   *  `VideoGameStageZombieActor`: enormous body, ordinary swing. */
  const pixelZombie = () =>
    unit({
      id: "pixel", sourceKey: PIXEL_ZOMBIE_KEY, team: "enemy",
      str: 8, dex: 6, con: 10000, hp: 1e6, maxHp: 1e6,
    });

  /** A fight in which the boss will convert the front zombie on the first tick. */
  const turnedFight = () => {
    const a = player({ id: "a", hp: 1e6, maxHp: 1e6 });
    const b = unit({ id: "b", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e6, maxHp: 1e6 });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim(
      [a, b], [bagMinion(), boss], null, true,
      [{ name: "turnZombie", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 }],
      undefined, null, null, false, false, false, undefined, null, null, undefined,
      pixelZombie()
    );
    onTheLine(sim);
    for (let i = 0; i < 40 && !sim.turnedEnemies().length; i++) sim.step(50);
    return sim;
  };

  it("turnZombie CONVERTS the front zombie — it does not silently kill it", () => {
    // The reported bug: this action used to deal the victim its own remaining HP, so a
    // zombie died on the spot with nothing on screen to explain it, and went home a
    // permanent casualty. It must never be a death again.
    const sim = turnedFight();
    const converted = sim.units.filter((u) => u.team === "player" && u.taken);
    expect(converted).toHaveLength(1);
    expect(converted[0].alive).toBe(true); // taken out of the fight, NOT killed
    expect(sim.units.filter((u) => u.team === "player" && !u.alive)).toHaveLength(0);
    // …and it counts as a survivor, so the raid does not bill the player for it.
    expect(sim.outcome().losses).toHaveLength(0);
    expect(sim.outcome().survivors).toContain(converted[0].id);
  });

  it("the converted zombie stands up mid-field as a tappable pixel zombie", () => {
    const sim = turnedFight();
    const turned = sim.turnedEnemies();
    expect(turned).toHaveLength(1);
    expect(turned[0].sourceKey).toBe(PIXEL_ZOMBIE_KEY);
    expect(turned[0].isSummon).toBe(true); // off the wave budget, like an abductee
    expect(turned[0].turnedFromId).toBe(
      sim.units.find((u) => u.team === "player" && u.taken)!.id
    );
    // Beamed into the middle of the lane, not queued at the wave's doorway.
    expect(turned[0].state).toBe("hold");
    expect(turned[0].x).toBeLessThan(sim.units.find((u) => u.id === "bag")!.x);
  });

  it("only one pixel zombie stands at a time", () => {
    const sim = turnedFight();
    for (let i = 0; i < 400; i++) sim.step(50);
    expect(sim.turnedEnemies()).toHaveLength(1);
  });

  it("tapping a pixel zombie apart hands the zombie back", () => {
    const sim = turnedFight();
    const turned = sim.turnedEnemies()[0];
    const captiveId = turned.turnedFromId!;
    for (let i = 0; i < PIXEL_ZOMBIE_TAPS - 1; i++) {
      expect(sim.tapTurned(turned.id)).toBe(true);
      expect(turned.alive).toBe(true); // still standing — the rescue costs the full count
    }
    expect(sim.tapTurned(turned.id)).toBe(true);
    expect(turned.alive).toBe(false);
    const captive = sim.units.find((u) => u.id === captiveId)!;
    expect(captive.taken).toBe(false);
    expect(captive.alive).toBe(true);
    expect(captive.state).toBe("advance"); // re-enters at the back and walks up again
    expect(sim.tapTurned(turned.id)).toBe(false); // and it takes no more taps
  });

  it("a converted zombie is off the lane for every purpose, not just the renderer", () => {
    // `taken` used to imply the `grabbed` state, because a Beach crab was the only way to
    // get it — so the lane helpers tested the STATE and that was enough. A converted
    // zombie keeps whatever state it was in, so each of these would happily have gone on
    // aiming at a unit that is no longer on the field.
    const sim = turnedFight();
    const gone = sim.units.find((u) => u.team === "player" && u.taken)!;
    const bag = sim.units.find((u) => u.id === "bag")!;
    // Give the wave a real swing — the punching bag deals nothing by default, so without
    // this the assertion below cannot fail however wrong the targeting is.
    bag.damage = 400;
    bag.cooldownMs = 200;
    bag.timerMs = 0;
    // Park the converted zombie right on top of the enemy, where EVERY "front-most" rule
    // picks it ahead of the rest of the army.
    gone.x = bag.x;
    gone.y = bag.y;
    for (let i = 0; i < 200; i++) {
      sim.step(50);
      gone.x = bag.x; // it is off the field; nothing should be moving it back
      gone.y = bag.y;
    }
    expect(gone.hp).toBe(gone.maxHp); // never struck, never thrown at, never shoved
    expect(gone.stunMs).toBe(0);
    expect(gone.burnMs).toBe(0);
    // Control, so this cannot pass vacuously: the converted zombie really is parked where
    // every front-most rule in the sim would pick it — furthest down the lane, and level
    // with the enemy that is swinging. It is skipped because it is off the field, not
    // because it was out of the way. (Removing the `taken` guard from frontMostPlayer
    // fails the assertion above with this setup.)
    const rest = sim.units.filter((u) => u.team === "player" && !u.taken && u.alive);
    expect(rest.length).toBeGreaterThan(0);
    for (const other of rest) expect(gone.x).toBeGreaterThan(other.x);
    // …and the boss does not spend its budget converting a zombie it already took.
    expect(sim.turnedEnemies()).toHaveLength(1);
  });

  it("hands the captive back however the pixel zombie dies, not just by tapping", () => {
    // The release lives on the one choke point every death goes through. A captive
    // stranded by some other damage path would sit `taken` with nothing left able to
    // free it.
    const sim = turnedFight();
    const turned = sim.turnedEnemies()[0];
    const captiveId = turned.turnedFromId!;
    // Kill it without going anywhere near tapTurned.
    turned.hp = 1;
    sim.tapTurned(turned.id);
    const captive = sim.units.find((u) => u.id === captiveId)!;
    expect(turned.alive).toBe(false);
    expect(captive.taken).toBe(false);
    expect(captive.state).toBe("advance");
  });

  it("a pixel zombie left standing never blocks the win", () => {
    // Its authored body is a million hit points. If clearing it were required, every fight
    // Zedzox landed a conversion in would run to the four-minute cap.
    const sim = turnedFight();
    expect(sim.turnedEnemies()).toHaveLength(1);
    for (const e of sim.units) {
      if (e.team === "enemy" && !e.isTurned) { e.alive = false; e.hp = 0; e.state = "dead"; }
    }
    sim.step(50);
    expect(sim.finished).toBe(true);
    expect(sim.playerWon).toBe(true);
    // The captive comes home with the rest of the army rather than marching out short.
    sim.prepareArmyExit();
    expect(sim.units.filter((u) => u.team === "player" && u.taken)).toHaveLength(0);
  });

  it("a conversion does not leave the wave with nothing in reach — the survivors re-anchor the line", () => {
    // Tester's report: "the enemies stop attacking when my headless zombie becomes the
    // pixelated zombie". The converted zombie kept its formation SLOT (armyOrder never
    // tested `taken`) — and a Headless leads its row from the front, and the front
    // fighter is exactly the zombie `turnZombie` takes. So the survivor re-slotted
    // behind a ghost, one body-standoff short of the wave's 60-unit reach, and the wave
    // held with nothing in range for the rest of the fight while the army (whose combat
    // band is 220 deep) kept hitting back.
    const front = unit({
      id: "front", sourceKey: "ZombieActorHeadlessTier1", team: "player",
      isHeadless: true, hp: 1e6, maxHp: 1e6,
    });
    const back = unit({
      id: "back", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e6, maxHp: 1e6,
    });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim(
      [front, back], [bagMinion(), boss], null, true,
      [{ name: "turnZombie", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 }],
      undefined, null, null, false, false, false, undefined, null, null, undefined,
      pixelZombie()
    );
    onTheLine(sim);
    const bag = sim.units.find((u) => u.id === "bag")!;
    bag.x = ENEMY_HOLD_X; // onTheLine sets states, not positions — stand the wave on its mark
    const f = sim.units.find((u) => u.id === "front")!;
    const s = sim.units.find((u) => u.id === "back")!;
    f.x = s.x + 50; // the Headless leads, so Zedzox takes IT — as in the report
    for (let i = 0; i < 40 && !sim.turnedEnemies().length; i++) sim.step(50);
    expect(f.taken).toBe(true);

    // Give the wave a real swing, then let the survivor settle into its slot.
    bag.damage = 400;
    bag.cooldownMs = 500;
    for (let i = 0; i < 400; i++) sim.step(50);

    // The survivor stands ON the line, inside the wave's reach…
    expect(Math.abs(bag.x - s.x)).toBeLessThanOrEqual((sim as any).engageDistance);
    // …and the wave is actually swinging at it: ten more seconds toe-to-toe cost it
    // hit points. (The pixel zombie stands mid-field, far behind the settled slot, so
    // only the wave can be landing these.)
    const settled = s.hp;
    for (let i = 0; i < 200; i++) sim.step(50);
    expect(s.hp).toBeLessThan(settled);
  });

  it("telekinesis knocks back and stuns but deals NO damage", () => {
    const p = player({ hp: 1e6, maxHp: 1e6 });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([p], [bagMinion(), boss], null, true, [
      { name: "telekinesis", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 12 },
    ]);
    onTheLine(sim);
    for (let i = 0; i < 4; i++) sim.step(50);
    const victim = sim.units.find((u) => u.id === "player")!;
    expect(victim.hp).toBe(victim.maxHp);
    expect(victim.stunMs).toBeGreaterThan(0);
  });

  it("the alien laser bolt carries the flat 200 from the binary", () => {
    const p = player({ hp: 1e6, maxHp: 1e6 });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([p], [bagMinion(), boss], null, true, [
      { name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 },
    ]);
    for (let i = 0; i < 5 && !sim.projectiles.length; i++) {
      inMelee(sim);
      sim.step(50);
    }
    expect(sim.projectiles[0]?.damage).toBe(200);
  });

  // `ZFFightMan shootBullet:from:` picks a RANDOM zombie out of the ones that are
  // `isInMeleeRange` (or mid special attack). Garden healers hold at the support line
  // and never enter that set — aiming the bolt like a THROW (rear-most deployed unit)
  // had every shot land on them.
  it("the alien laser burns a FRONT-LINE zombie, never the healers holding back", () => {
    const front = unit({
      id: "front", sourceKey: "ZombieActorRegularTier1", team: "player",
      hp: 1e6, maxHp: 1e6,
    });
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier1", team: "player",
      hp: 1e6, maxHp: 1e6, isGarden: true,
    });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([front, healer], [bagMinion(), boss], null, true, [
      { name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 },
    ]);
    const f = sim.units.find((u) => u.id === "front")!;
    const h = sim.units.find((u) => u.id === "healer")!;
    for (let i = 0; i < 5 && !sim.projectiles.length; i++) {
      for (const u of sim.units) {
        u.state = u.team === "enemy" ? (u.isBoss ? "structure" : "hold") : "advance";
      }
      f.moveSpeed = 0;
      h.moveSpeed = 0;
      f.x = 820; // toe-to-toe with the wave
      h.x = 520; // Garden support line, well behind
      f.y = h.y = 280;
      f.state = "fight"; // only the front zombie is engaged
      sim.step(50);
    }
    const bolt = sim.projectiles[0];
    expect(bolt).toBeTruthy();
    // The bolt is aimed at the position of whoever it targeted, so its bearing points at
    // the engaged zombie up front — not back down the lane at the healer.
    const bearing = Math.atan2(bolt.vy, bolt.vx);
    const toFront = Math.atan2(f.y - bolt.y, f.x - bolt.x);
    const toHealer = Math.atan2(h.y - bolt.y, h.x - bolt.x);
    expect(Math.abs(bearing - toFront)).toBeLessThan(Math.abs(bearing - toHealer));
  });

  it("the alien saucer holds its fire when nobody is engaged", () => {
    const p = player({ hp: 1e6, maxHp: 1e6 });
    const boss = enemy({ id: "boss", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([p], [boss], null, true, [
      { name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 1e6, damage: 0 },
    ]);
    for (let i = 0; i < 40; i++) {
      onTheLine(sim); // everyone still walking up — `allowedToShootBullet` refuses
      sim.step(50);
    }
    expect(sim.projectiles).toHaveLength(0);
  });
});

describe("boss action budget (throws and specials share one roll)", () => {
  const boss = () => unit({ id: "boss", sourceKey: "RobotStageActorBrainBot", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 });
  const player = () => unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e7, maxHp: 1e7 });
  const throwCfg = { intervalMs: 2000, options: [{ damage: 20, weight: 150, sprite: "junk.png", spriteSize: 32 }] };

  /** Count throws launched over `ms`, with and without a competing special. */
  const throwsOver = (specials: { name: string; weight: number; castMs: number; cooldownMs: number; damage: number }[], ms: number) => {
    // A live minion keeps the boss on its perch — that is the only state it throws from.
    const minion = unit({ id: "m", sourceKey: "RobotStageActorJunkBot", team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 });
    const sim = new BattleSim([player()], [minion, boss()], throwCfg, true, specials);
    sim.units.find((u) => u.id === "p")!.state = "advance";
    let launched = 0;
    let seen = 0;
    for (let t = 0; t < ms; t += 50) {
      sim.step(50);
      const seq = sim.snapshot().projSeq;
      if (seq > seen) { launched += seq - seen; seen = seq; }
    }
    return launched;
  };

  it("a special steals throw slots instead of running on its own clock", () => {
    // BrainBot's real list is telekinesis (f=50) + 5 throws (f=30 each = 150), so the
    // source throws on ~75 % of its action cycles. With two independent timers the
    // throws were unaffected by the special — now they compete.
    const alone = throwsOver([], 30_000);
    const shared = throwsOver(
      [{ name: "telekinesis", weight: 50, castMs: 3000, cooldownMs: 3000, damage: 0 }],
      30_000
    );
    expect(alone).toBeGreaterThan(0);
    expect(shared).toBeLessThan(alone);
  });

  it("a boss whose actions are all throws is unaffected by the merge", () => {
    // Every City/Pirate/Farm boss action is a `throw`, so the budget degenerates to a
    // plain interval — those raids must not change.
    const launched = throwsOver([], 20_000);
    expect(launched).toBeGreaterThanOrEqual(9); // ~20 s / 2 s, allowing for the first tick
    expect(launched).toBeLessThanOrEqual(11);
  });
});
