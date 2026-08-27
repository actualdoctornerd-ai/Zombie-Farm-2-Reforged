// Zombies vs Aliens (raid 6) — the four recovered divergences, pinned against the
// disassembly in docs/mechanics/ALIEN_RAID_RECOVERED.md §7. Three of them move fight
// outcomes (raid ruleset 27); the fourth is the per-alien tint.
import { describe, expect, it } from "vitest";
import { BattleSim, FIELD_H, FIELD_W, type SimUnit } from "./BattleSim";
import {
  ABDUCTEE_POOL,
  ABDUCTEE_SEED,
  ALIEN_MINION_KEY,
  alienTintFor,
  waveCadenceFor,
} from "./alienStage";
import type { CombatUnit, SummonConfig } from "./types";
// @ts-ignore - node types are test-environment only, as in clipData.test.ts
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const CENTER_Y = FIELD_H / 2;

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

const alien = (i: number) =>
  unit({ id: `a${i}`, sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 });

/** Enemies actually out on the field (not still queued off-screen). */
const onField = (sim: BattleSim) =>
  sim.units.filter((u: SimUnit) => u.team === "enemy" && !u.isBoss && u.state !== "queued").length;

describe("the alien wave is a swarm", () => {
  // `-[ZFFightMan spawnEnemyIn:]` fills a five-slot `enemySlots` array beside the one
  // "current" enemy, and only the `spawnTimer` drip ever fills a slot. `initialSpawn`
  // seeds that timer to 10 s on stage 6 and 3600 s everywhere else.
  it("reads six-at-once with a ten-second drip for raid 6, one-at-a-time for the rest", () => {
    expect(waveCadenceFor(6)).toEqual({ maxActive: 6, dripMs: 10_000 });
    for (const id of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
      expect(waveCadenceFor(id), String(id)).toEqual({ maxActive: 1, dripMs: 0 });
    }
  });

  it("lets exactly one more alien out per drip, up to six", () => {
    const wave = Array.from({ length: 20 }, (_, i) => alien(i));
    const sim = new BattleSim(
      [unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", str: 0, hp: 1e7, maxHp: 1e7 })],
      wave, null, true, [], undefined, null, null, false, false, false, undefined, null, null,
      waveCadenceFor(6)
    );
    const step = (ms: number) => { for (let i = 0; i < ms / 50; i++) sim.step(50); };
    step(1000);
    expect(onField(sim)).toBe(1); // the field starts where every other raid stays
    step(10_000);
    expect(onField(sim)).toBe(2);
    step(10_000);
    expect(onField(sim)).toBe(3);
    step(60_000); // long past the sixth drip
    expect(onField(sim)).toBe(6); // …and it stops at the five slots plus the current one
  });

  it("keeps every other raid to one at a time, however long the fight runs", () => {
    const wave = Array.from({ length: 8 }, (_, i) =>
      unit({ id: `e${i}`, sourceKey: "FarmStageActorFarmhand", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }));
    const sim = new BattleSim(
      [unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", str: 0, hp: 1e7, maxHp: 1e7 })],
      wave, null, true, [], undefined, null, null, false, false, false, undefined, null, null,
      waveCadenceFor(3)
    );
    for (let i = 0; i < 1200; i++) sim.step(50); // a full minute
    expect(onField(sim)).toBe(1);
  });
});

describe("a landed boss has no actions", () => {
  // `-[CivilianActorFight bossUpdate:]` only rolls an action in state 19; a boss that has
  // finished its descent sits in state 9, below the 15..27 window, and drops through to
  // `civilianUpdate`. This used to be enforced for throws and walls but not for specials,
  // which left the saucer firing its laser through the whole ground phase.
  const laserSim = (bossState: SimUnit["state"]) => {
    const sim = new BattleSim(
      [unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e6, maxHp: 1e6 })],
      [
        unit({ id: "bag", sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 }),
        unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 }),
      ],
      null, true, [{ name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 300, damage: 0 }]
    );
    for (let i = 0; i < 40; i++) {
      for (const u of sim.units) {
        u.state = u.team === "enemy" ? (u.isBoss ? bossState : "hold") : "fight";
      }
      sim.step(50);
    }
    return sim;
  };

  it("fires the laser from the perch", () => {
    expect(laserSim("structure").projectiles.length).toBeGreaterThan(0);
  });

  it("fires nothing once it has landed and joined the melee", () => {
    expect(laserSim("fight").projectiles).toHaveLength(0);
    expect(laserSim("hold").projectiles).toHaveLength(0);
  });
});

describe("summonBoss abducts humans", () => {
  const abductees = (): SummonConfig => ({
    queue: ABDUCTEE_SEED.map((key) =>
      unit({ id: key, sourceKey: key, team: "enemy", str: 2, con: 1, hp: 400, maxHp: 400 })),
    pool: [...new Set(ABDUCTEE_POOL)].map((key) =>
      unit({ id: key, sourceKey: key, team: "enemy", str: 2, con: 1, hp: 400, maxHp: 400 })),
  });

  const summonSim = () => {
    const sim = new BattleSim(
      [unit({ id: "p", sourceKey: "ZombieActorRegularTier1", team: "player", str: 0, hp: 1e7, maxHp: 1e7 })],
      [
        unit({ id: "bag", sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 }),
        unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 }),
      ],
      null, true, [{ name: "summonBoss", weight: 1, castMs: 0, cooldownMs: 100, damage: 0 }],
      undefined, abductees()
    );
    return sim;
  };

  const summoned = (sim: BattleSim) => sim.units.filter((u) => u.isSummon);

  it("beams down an abducted HUMAN, not another alien", () => {
    const sim = summonSim();
    for (let i = 0; i < 20 && !summoned(sim).length; i++) sim.step(50);
    const victim = summoned(sim)[0];
    expect(victim).toBeTruthy();
    // The seed order is authored: two lumberjacks, a crazed worker, a ninja boy.
    expect(victim.sourceKey).toBe(ABDUCTEE_SEED[0]);
    expect(victim.sourceKey).not.toBe(ALIEN_MINION_KEY);
    // Straight onto the field rather than queued behind the wave.
    expect(victim.state).not.toBe("queued");
  });

  // `summonBoss:` spawns at `CGPointMake(240, enemyPosition.y)` — 480 on an iPad — which
  // is the horizontal CENTRE of that build's stage, not the doorway every other enemy
  // walks in through. Here it lands on the stage art's SCORCH MARK instead, which sits a
  // little left of that centre; see SUMMON_SPAWN_X.
  it("lands mid-field on the scorch mark, not at the wave's doorway", () => {
    const sim = summonSim();
    for (let i = 0; i < 20 && !summoned(sim).length; i++) sim.step(50);
    const victim = summoned(sim)[0];
    // The burn's core is art x~220 of 480, which through RaidScene's 10 % lane inset is
    // sim 448 — just left of the field's own midpoint. RaidScene centres the DRAWN figure
    // on it (enemy rigs anchor at their left edge); the sim keeps the mark itself.
    expect(victim.x).toBe(448);
    expect(victim.x).toBeLessThan(FIELD_W / 2);
    expect(victim.x).toBeGreaterThan(FIELD_W * 0.4);
    // Well clear of where the wave stands, and past its line rather than behind it.
    const alienX = sim.units.find((u) => u.sourceKey === ALIEN_MINION_KEY)!.x;
    expect(victim.x).toBeLessThan(alienX - 200);
  });

  it("then stands where it landed — an abductee never moves", () => {
    const sim = summonSim();
    for (let i = 0; i < 20 && !summoned(sim).length; i++) sim.step(50);
    const victim = summoned(sim)[0];
    const landedAt = victim.x;
    for (let i = 0; i < 400; i++) sim.step(50); // 20 s of fighting
    expect(victim.x).toBe(landedAt);
    expect(victim.y).toBe(CENTER_Y);
  });

  it("is a mid-lane roadblock the army has to stop and clear", () => {
    const sim = summonSim();
    for (let i = 0; i < 20 && !summoned(sim).length; i++) sim.step(50);
    const victim = summoned(sim)[0];
    for (let i = 0; i < 300; i++) sim.step(50);
    // Zombies pull up short of it instead of filing past to the doorway…
    const front = sim.units
      .filter((u) => u.team === "player" && u.alive && (u.state === "fight" || u.state === "advance"))
      .reduce((a, b) => (b.x > a.x ? b : a));
    expect(front.x).toBeLessThan(victim.x);
    expect(front.x).toBeGreaterThan(victim.x - 120);
    // …so it can actually be killed, rather than chipping the line from out of reach.
    expect(victim.hp).toBeLessThan(victim.maxHp);
  });

  // The roadblock is for units WALKING PAST it. Garden zombies hold at a fixed station
  // far behind the line — behind the scorch mark too — so they never close on an abductee,
  // can never reach one and can never break one. Counting them as blocked by it shut the
  // army's healing off for as long as the abductee lived, on the one raid whose boss
  // re-summons the moment the last one dies.
  it("does not stop the Garden zombies healing — their station is far behind it", () => {
    const healer = unit({
      id: "healer", sourceKey: "ZombieActorGardenTier1", team: "player",
      str: 8, isGarden: true, abilities: ["heal"], attackCooldownMs: 200,
      hp: 1e7, maxHp: 1e7,
    });
    const hurt = unit({
      id: "hurt", sourceKey: "ZombieActorRegularTier1", team: "player",
      str: 0, hp: 1e7, maxHp: 1e7,
    });
    const sim = new BattleSim(
      [hurt, healer],
      [
        unit({ id: "bag", sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 }),
        unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 }),
      ],
      null, true, [{ name: "summonBoss", weight: 1, castMs: 0, cooldownMs: 100, damage: 0 }],
      undefined, abductees()
    );
    for (let i = 0; i < 60 && !summoned(sim).length; i++) sim.step(50);
    const victim = summoned(sim)[0];
    expect(victim).toBeTruthy();
    // Keep THIS abductee standing for the whole test, so the blocker never changes.
    victim.hp = victim.maxHp = 1e7;

    const h = sim.units.find((u) => u.id === "healer")!;
    const w = sim.units.find((u) => u.id === "hurt")!;
    for (let i = 0; i < 200; i++) sim.step(50); // deploy both, abductee already down
    const wounded = w.maxHp / 2;
    w.hp = wounded;
    const castsBefore = h.healCastSeq;
    for (let i = 0; i < 200; i++) sim.step(50);

    expect(victim.alive).toBe(true);
    expect(h.x).toBeLessThan(victim.x); // still behind it, and still healing anyway
    expect(h.healCastSeq).toBeGreaterThan(castsBefore);
    expect(w.hp).toBeGreaterThan(wounded);
    // …while the zombie that DID march at the line is still intercepted and fighting it.
    expect(w.x).toBeLessThan(victim.x);
    expect(w.x).toBeGreaterThan(victim.x - 120);
    expect(victim.hp).toBeLessThan(victim.maxHp);
  });

  it("refuses a second while the first still lives, then re-arms when it dies", () => {
    const sim = summonSim();
    for (let i = 0; i < 200; i++) sim.step(50);
    expect(summoned(sim).filter((u) => u.alive)).toHaveLength(1); // `bossWall` holds one
    for (const u of summoned(sim)) { u.alive = false; u.hp = 0; }
    for (let i = 0; i < 40; i++) sim.step(50);
    expect(summoned(sim).filter((u) => u.alive)).toHaveLength(1); // re-armed
    expect(summoned(sim).length).toBeGreaterThan(1); // …and that is a NEW one
  });

  it("never runs dry — every cast pushes a replacement onto the queue", () => {
    const sim = summonSim();
    // Far more casts than the four seeded names: the roll refills the list each time.
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 60; i++) sim.step(50);
      for (const u of summoned(sim)) { u.alive = false; u.hp = 0; }
    }
    expect(summoned(sim).length).toBeGreaterThan(ABDUCTEE_SEED.length);
    for (const u of summoned(sim)) expect(ABDUCTEE_KEYS_SET.has(u.sourceKey)).toBe(true);
  });

  it("does not hold the boss on its perch — an abductee is off-budget", () => {
    // `civilianUpdate` only decrements `enemyPopulation` for a dying actor that is NOT
    // `bossWall`, so a summon neither counts toward the wave nor blocks the descent.
    // Without this an uncapped summon would deadlock the boss up top forever.
    const sim = summonSim();
    const bag = sim.units.find((u) => u.id === "bag")!;
    for (let i = 0; i < 20; i++) sim.step(50);
    bag.alive = false;
    bag.hp = 0;
    for (let i = 0; i < 200; i++) sim.step(50);
    const boss = sim.units.find((u) => u.isBoss)!;
    expect(boss.state).not.toBe("structure"); // it came down even with an abductee alive
  });
});

const ABDUCTEE_KEYS_SET = new Set([...ABDUCTEE_SEED, ...ABDUCTEE_POOL]);

describe("every alien is a different colour", () => {
  // `-[ZFFightMan spawnEnemy]` rolls three independent
  // `(int)((arc4random() % 100) / 100.0f * 255.0f)` channels per minion, alien stage only.
  // The art is greyscale precisely because it is tinted at runtime.
  it("tints alien minions and nothing else", () => {
    expect(alienTintFor(ALIEN_MINION_KEY, "a1")).not.toBeNull();
    expect(alienTintFor("AlienStageActorBoss", "a1")).toBeNull();
    expect(alienTintFor("FarmStageActorFarmhand", "a1")).toBeNull();
  });

  it("keeps every channel on the source's 100-step ladder", () => {
    for (let i = 0; i < 200; i++) {
      const tint = alienTintFor(ALIEN_MINION_KEY, `spawn${i}`)!;
      for (const channel of [tint >> 16, (tint >> 8) & 0xff, tint & 0xff]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(252); // floor(99/100 * 255)
        expect(channel).toBe(Math.floor((Math.round((channel / 255) * 100) / 100) * 255));
      }
    }
  });

  it("leaves the alien's own face and body detail grey in the shipped rig", () => {
    // `-[AlienStageActorMinion initSprite]` calls `setInheritColor: NO` on minionFace and
    // minionBodyDetail, so the RANDOM tint dresses the uniform (suit, sleeves, boots,
    // helmet) and the alien inside it stays grey. tools/prep_enemies.py writes the flag,
    // but models.json is also round-tripped through the Rig Studio, and an export that
    // dropped `noTint` once already recoloured the alien itself along with its suit.
    const model = read("../../public/assets/raids/enemies/models.json")[ALIEN_MINION_KEY];
    const grey = model.parts.filter((p: { noTint?: boolean }) => p.noTint);
    expect(grey).toHaveLength(2);
    // The face is the top-most head part; the body detail is the zipper over the suit.
    expect(grey.map((p: { z: number }) => p.z).sort((a: number, b: number) => a - b)).toEqual([4, 6]);
    // ...and the uniform still takes the colour: everything else is tintable.
    expect(model.parts.length - grey.length).toBeGreaterThan(4);
  });

  it("is stable per unit but spread across the wave", () => {
    // Stable: a token rebuilt mid-fight must come back the same colour.
    expect(alienTintFor(ALIEN_MINION_KEY, "a7")).toBe(alienTintFor(ALIEN_MINION_KEY, "a7"));
    // Spread: twenty aliens should not read as twenty of the same alien.
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => alienTintFor(ALIEN_MINION_KEY, `a${i}`))
    );
    expect(seen.size).toBeGreaterThan(15);
  });
});

// The abductee is a mid-lane roadblock, and `passedWall` is the latch that says "I was
// already ahead of it when it landed, so it is not in my way". Two paths put a zombie
// BACK behind the blocker after that latch is set — a knockback shove, which keeps it on
// purpose (a shoved zombie does not turn round), and a revive, which is a re-entry from
// the charge slot and had no business keeping it. A revived zombie walked straight through
// the abductee it had marched past in its first life and never traded a blow with it,
// which on the one raid whose boss re-summons the moment the last one dies is a roadblock
// that can only be cleared by zombies that have never died.
describe("a revived zombie re-enters the lane behind the abductee", () => {
  const abductees = (): SummonConfig => ({
    queue: ABDUCTEE_SEED.map((key) =>
      unit({ id: key, sourceKey: key, team: "enemy", str: 2, con: 1, hp: 400, maxHp: 400 })),
    pool: [...new Set(ABDUCTEE_POOL)].map((key) =>
      unit({ id: key, sourceKey: key, team: "enemy", str: 2, con: 1, hp: 400, maxHp: 400 })),
  });
  const summoned = (sim: BattleSim) => sim.units.filter((u: SimUnit) => u.isSummon);

  it("stops short of it and fights it, rather than walking through", () => {
    const fighter = unit({
      id: "f", sourceKey: "ZombieActorRegularTier1", team: "player", str: 5, hp: 5000, maxHp: 5000,
    });
    const medic = unit({
      id: "g", sourceKey: "ZombieActorGardenTier3", team: "player",
      str: 8, isGarden: true, abilities: ["ressurect"], hp: 1e7, maxHp: 1e7,
    });
    const sim = new BattleSim(
      [fighter, medic],
      [
        unit({ id: "bag", sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 }),
        unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 }),
      ],
      // A long summon cooldown so the fighter clears the FIRST abductee and reaches the
      // front line before the next one lands — which is what latches `passedWall`.
      null, true, [{ name: "summonBoss", weight: 1, castMs: 0, cooldownMs: 25_000, damage: 0 }],
      undefined, abductees()
    );
    const f = sim.units.find((u: SimUnit) => u.id === "f")!;
    for (let i = 0; i < 1200; i++) sim.step(50);
    const victim = summoned(sim).filter((u: SimUnit) => u.alive)[0];
    expect(victim).toBeTruthy();
    expect(f.x).toBeGreaterThan(victim.x); // it marched past this one, latch and all
    expect(f.passedWall).toBe(true);
    victim.hp = victim.maxHp = 1e7; // keep THIS abductee standing for the rest of the test

    (sim as any).dealDamage(f, f.maxHp, false);
    for (let i = 0; i < 400; i++) sim.step(50);

    expect(f.alive).toBe(true);
    expect(f.passedWall).toBe(false);
    expect(f.x).toBeLessThan(victim.x);          // …and it is stopped short of the blocker
    expect(f.x).toBeGreaterThan(victim.x - 120); // …close enough to actually reach it
    expect(victim.hp).toBeLessThan(victim.maxHp);
  });
});

// The saucer fires whenever the player has anything on the lane. The recovered rule was
// narrower — only zombies ENGAGED with the wave were candidates — and it could stall the
// raid outright: a Garden zombie holds a fixed spot and closes on nothing, so it is never
// engaged, and an army of nothing but healers (or one whose last ordinary body has died)
// handed the saucer an empty candidate list on every cycle. It fired nothing, they had
// nothing hurt to heal, and the fight ran out its four-minute clock with neither side able
// to touch the other. See laserTarget for the divergence and what is kept from the source.
describe("the saucer shoots whatever is on the lane", () => {
  const gardens = () => ["g0", "g1"].map((id) => unit({
    id, sourceKey: "ZombieActorGardenTier3", team: "player",
    str: 8, isGarden: true, abilities: ["heal"], hp: 1e7, maxHp: 1e7,
  }));
  const laserSaucer = (players: CombatUnit[]) => new BattleSim(
    players,
    [
      unit({ id: "bag", sourceKey: ALIEN_MINION_KEY, team: "enemy", str: 0, hp: 1e7, maxHp: 1e7 }),
      unit({ id: "boss", sourceKey: "AlienStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e7, maxHp: 1e7 }),
    ],
    null, true, [{ name: "alienLaser", weight: 1, castMs: 0, cooldownMs: 300, damage: 0 }]
  );

  /** Fire on this field for 20 s and report what landed, per zombie. */
  const shootAt = (players: CombatUnit[]) => {
    const sim = laserSaucer(players);
    for (let i = 0; i < 400; i++) sim.step(50);
    const zombies = sim.units.filter((u: SimUnit) => u.team === "player");
    return {
      bolts: sim.snapshot().projSeq,
      dealt: Object.fromEntries(zombies.map((u) => [u.id, u.maxHp - u.hp])),
      total: zombies.reduce((sum, u) => sum + (u.maxHp - u.hp), 0),
      states: zombies.map((u) => u.state),
    };
  };

  it("fires at the healers when they are the only zombies on the field", () => {
    const { bolts, total, states } = shootAt(gardens());
    // They are never engaged and never will be — that is what made this field unreachable.
    expect(states.every((st) => st === "advance")).toBe(true);
    expect(bolts).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
  });

  it("fires at a LONE healer too — one Garden is still a field it must be able to reach", () => {
    // The one-zombie case is the stalemate at its purest: nothing else can ever deploy,
    // so an empty candidate list here is an empty candidate list for the whole raid.
    const { bolts, total } = shootAt(gardens().slice(0, 1));
    expect(bolts).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
  });

  it("spreads the fire when an ordinary body is out there with them", () => {
    // The healers stay in it — the draw is over the whole deployed line — but they take a
    // share rather than the whole barrage. The bug this rule replaced aimed the bolt like
    // a THROW, at the rear-most deployed unit, which put every shot on the support station.
    const fighter = unit({
      id: "f", sourceKey: "ZombieActorRegularTier1", team: "player", hp: 1e7, maxHp: 1e7,
    });
    const { dealt, total } = shootAt([fighter, ...gardens()]);
    expect(total).toBeGreaterThan(0);
    expect(dealt.f).toBeGreaterThan(0);
    expect(dealt.g0 + dealt.g1).toBeLessThan(total); // …not all of it on the back line
  });

  it("holds its fire while the lane is empty", () => {
    // Not "nobody is engaged" — nobody is OUT there. An army still in the charge queue is
    // not sniped at the back of the field.
    const sim = laserSaucer(gardens());
    const zombies = sim.units.filter((u: SimUnit) => u.team === "player");
    for (let i = 0; i < 400; i++) {
      for (const z of zombies) z.state = "waiting";
      sim.step(50);
    }
    expect(sim.snapshot().projSeq).toBe(0);
    expect(zombies.every((u) => u.hp === u.maxHp)).toBe(true);
  });
});
