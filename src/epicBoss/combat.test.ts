import { describe, expect, it } from "vitest";
import {
  DR_GROUNDHOG, EPIC_BOSSES, epicBossById, epicBossDamage, epicBossDamageTiming,
  epicBossUnlockLevel,
} from "./catalog";
// Read off disk, the same way the other asset invariants do it: the app carries no
// @types/node, so this built-in has to be imported past the typechecker.
// @ts-ignore
import { existsSync } from "node:fs";
import { buildEpicBossSetup, isEpicBossKey, rollEpicBossDrops, rollEpicBossLoot } from "./combat";
import { EPIC_LOOT_ROLLS, epicBrainTicketChance, epicLootWeight } from "./rewards";
import { BattleSim } from "../raid/BattleSim";
import { buildPlayerUnits } from "../raid/CombatEngine";
import { deriveAttackIntervalMs } from "../raid/combatStats";
import { makeOwned } from "../zombie/types";
import { bitOf } from "../zombie/mutations";
import type { CombatUnit } from "../raid/types";
import zombieRows from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";

describe("Epic Boss attack timing", () => {
  // Every boss used to be hardcoded to 0.88. Two of them don't punch — Dr. Groundhog and
  // Loco Locust bite, and Attacks.json connects a bite a QUARTER into the swing. Nothing
  // read the number until the attack strip started being driven off it, at which point
  // their impact frame was landing two thirds of a swing late.
  it("takes each boss's connect point from the attack it actually swings", () => {
    const byAttack: Record<string, number> = {
      EpicBossAttack: 0.88,
      VideoGameZombieBite: 0.25,
    };
    const seen = new Set<string>();
    for (const boss of EPIC_BOSSES) {
      const attacks = boss.unitStats.attacks;
      expect(attacks.length, boss.id).toBeGreaterThan(0);
      const named = attacks[0].name;
      seen.add(named);
      expect(byAttack[named], `${boss.id} swings an unexpected attack: ${named}`).toBeDefined();
      expect(epicBossDamageTiming(boss), boss.id).toBe(byAttack[named]);
    }
    // Both attacks are in play, so a regression to one shared constant cannot pass.
    expect([...seen].sort()).toEqual(["EpicBossAttack", "VideoGameZombieBite"]);
    expect(epicBossDamageTiming(DR_GROUNDHOG)).toBe(0.25);
    expect(new Set(EPIC_BOSSES.map(epicBossDamageTiming)).size).toBe(2);
  });

  it("falls back to BattleSim's own default when an attack names no timing", () => {
    const bare = { unitStats: { attacks: [{ name: "Mystery", frequency: 100 }] } };
    expect(epicBossDamageTiming(bare as Parameters<typeof epicBossDamageTiming>[0])).toBe(0.5);
  });
});

describe("Epic Boss fallback loot", () => {
  it("unlocks source rewards by defeated level and prefers missing rewards", () => {
    // Loot rungs moved with the ladder (20 -> 10), so the first prize now unlocks on
    // rung 1 and nothing is gated above the top.
    expect(rollEpicBossLoot(DR_GROUNDHOG, 0, new Set(), () => 0)).toBeNull();
    expect(rollEpicBossLoot(DR_GROUNDHOG, 1, new Set(), () => 0)?.name).toContain("Evil Device");
    const owned = new Set(["Dr. Groundhog's Evil Device"]);
    expect(rollEpicBossLoot(DR_GROUNDHOG, 2, owned, () => 0)?.name).toContain("Tricycle");
    expect(DR_GROUNDHOG.loot.every((l) => l.level <= DR_GROUNDHOG.maxLevel)).toBe(true);
  });

  it("does not duplicate the pet once collected", () => {
    const owned = new Set(DR_GROUNDHOG.loot.map((loot) => loot.name));
    const result = rollEpicBossLoot(DR_GROUNDHOG, 20, owned, () => 0);
    expect(result?.stageActor).toBeUndefined();
  });

  it("makes the ladder's top prize RARER than its first rung", () => {
    // The regression: a uniform pick gave the level-20 prize exactly the same odds as the
    // level-2 one, so climbing bought no better chance at what climbing unlocks.
    const top = DR_GROUNDHOG.loot.reduce((a, b) => (b.level > a.level ? b : a));
    const first = DR_GROUNDHOG.loot.reduce((a, b) => (b.level < a.level ? b : a));
    const counts = new Map<string, number>();
    let seed = 0.5;
    const random = () => {
      seed = (seed * 9301 + 0.49297) % 1; // deterministic spread, no Math.random in tests
      return seed;
    };
    for (let i = 0; i < 20_000; i++) {
      const loot = rollEpicBossLoot(DR_GROUNDHOG, top.level, new Set(), random);
      if (loot) counts.set(loot.name, (counts.get(loot.name) ?? 0) + 1);
    }
    const topHits = counts.get(top.name) ?? 0;
    const firstHits = counts.get(first.name) ?? 0;
    expect(topHits).toBeGreaterThan(0); // still reachable — rarer, not gated off
    expect(topHits * 2).toBeLessThan(firstHits); // and clearly rarer than the first rung
  });

  it("rolls decor twice per clear and never pays the same prize in both", () => {
    // Two rolls at 0.35 rather than one at 0.70: the expectation matches, but only two
    // rolls can hand over two DIFFERENT prizes, which is what lets a 10-rung ladder
    // finish a collection. A duplicate would be a wasted drop on a `unique` item.
    const always = () => 0;
    const drops = rollEpicBossDrops(DR_GROUNDHOG, DR_GROUNDHOG.maxLevel, new Set(), always);
    expect(drops).toHaveLength(2);
    expect(new Set(drops.map((d) => d.name)).size).toBe(2);
    // …and both rolls can miss.
    expect(rollEpicBossDrops(DR_GROUNDHOG, DR_GROUNDHOG.maxLevel, new Set(), () => 0.99)).toEqual([]);
    // Never more than the roll count, whatever the RNG does.
    for (const r of [() => 0, () => 0.2, () => 0.34]) {
      expect(rollEpicBossDrops(DR_GROUNDHOG, 10, new Set(), r).length).toBeLessThanOrEqual(EPIC_LOOT_ROLLS);
    }
  });

  it("scales the Brain Ticket drop with how deep the rung was", () => {
    // 1.5% per rung: shallow rungs are one attempt, the top rung is many.
    expect(epicBrainTicketChance(1)).toBeCloseTo(0.015, 10);
    expect(epicBrainTicketChance(9)).toBeCloseTo(0.135, 10);
    // The fight that ends a ladder guarantees one, at each event's own top rung.
    expect(epicBrainTicketChance(10)).toBe(1);
    expect(epicBrainTicketChance(20, 20)).toBe(1);
    expect(epicBrainTicketChance(10, 20)).toBeCloseTo(0.15, 10);
    // Monotone below the guarantee, and bounded either side however odd the input.
    for (let rung = 2; rung < 10; rung++) {
      expect(epicBrainTicketChance(rung)).toBeGreaterThan(epicBrainTicketChance(rung - 1));
    }
    expect(epicBrainTicketChance(0)).toBe(0);
    expect(epicBrainTicketChance(-5)).toBe(0);
    expect(epicBrainTicketChance(10_000, 20)).toBe(1);
    // 1.5% x (1+2+...+9), plus the guaranteed final one.
    let expected = 0;
    for (let rung = 1; rung <= 10; rung++) expected += epicBrainTicketChance(rung);
    expect(expected).toBeCloseTo(1.675, 10);
  });

  it("weights strictly by the unlocking rung", () => {
    expect(epicLootWeight(5)).toBeGreaterThan(epicLootWeight(10));
    expect(epicLootWeight(20)).toBeGreaterThan(epicLootWeight(40));
    expect(epicLootWeight(0)).toBe(epicLootWeight(1)); // level 0 can't divide by zero
  });
});

// ---------------------------------------------------------------------------
// Damage-ramp calibration, MEASURED rather than modelled.
//
// The per-boss attack power in the catalogs (tools/prep_all_epic_bosses.py
// EPIC_BOSS_DAMAGE) was tuned against real BattleSim fights, because two properties
// of the epic fight break any closed-form estimate:
//   * only a handful of zombies are engaged at once, so a 20-strong army does not
//     bring 20 zombies' worth of damage, and incoming damage concentrates on the
//     front slot rather than spreading across the line;
//   * a level takes many attempts and damage carries over, so nearly every attempt
//     runs the full window. Casualties are permanent, so a boss that kills the
//     front unit costs one zombie PER ATTEMPT, not one per level.
// Together those mean the ramp has to be read as "which zombies can survive a full
// attempt in the front slot", which is exactly what these tests pin.
//
// THE WINDOW IS PART OF THE CALIBRATION. It is 60 s (EPIC_BOSS_FIGHT_MS), not the
// source's 30 s. The window is what makes the ramp legible at all: at 30 s the spread
// from the entry boss to the top one was worth about one zombie, because the boss barely
// had time to work through a single front-liner. At 60 s the specials that can safely
// hold the line fall 30 -> 5 across the ladder. Read `WINDOW_MS` as a calibration input —
// changing it re-tunes every assertion below, which is why it lives here as a constant.
//
// THERE ARE TWO RAMPS, AND EVERY ASSERTION BELOW HAS TO SAY WHICH IT MEANS.
//   * ACROSS events: EPIC_BOSS_DAMAGE, "higher unlock level, harder boss" (48 -> 140 DPS
//     at rung 1). Tests about which EVENT demands what pass `bossOf(boss, 1)`.
//   * WITHIN an event: 5% compounding per rung (epicBossDamage, raid ruleset v29), so the
//     top of a ladder hits 1.55x its own entry fight. `bossOf` DEFAULTS to the top rung,
//     because that is where the bounding rule binds — a rule checked against
//     `unitStats.str` alone would pass no matter what this ramp did.
// ---------------------------------------------------------------------------
const defs = zombieRows as ZombieDef[];
const defByName = (name: string) => defs.find((z) => z.name === name)!;

/** A 20-strong line with `front` in the first slot, backed by ordinary damage-dealers. */
function line(front: string, backer = "Zomtar"): CombatUnit[] {
  const owned = [
    makeOwned("front", defByName(front), 0, 0, 0, 0),
    ...Array.from({ length: 19 }, (_, i) =>
      makeOwned(`b${i}`, defByName(backer), 0, 0, 0, 0)),
  ];
  return buildPlayerUnits(owned, {
    concentration: true, abilityUnlocked: () => true, playerLevel: 45,
  });
}

/** The attempt window these assertions are calibrated against — mirrors
 *  EPIC_BOSS_FIGHT_MS in tools/prep_all_epic_bosses.py and every catalog's `fightMs`. */
const WINDOW_MS = 60_000;

/** Best legal mutation in every slot. A headless zombie cannot wear a head or hair/eye
 *  bit (Pumpking is the one exception, authored for the family), so a tank's mask is
 *  built from what it can actually hold — `makeOwned` strips the rest either way. */
const TANK_MUTATIONS = bitOf("pumpking") | bitOf("flytrap") | bitOf("heartichoke");
const FULL_MUTATIONS = TANK_MUTATIONS | bitOf("dragon");

/** What a player at each point in the ladder is assumed to be able to field: a headless
 *  wall and a healer of the grade the game has handed them by then. Silver-grade for the
 *  events unlocking through level 30, specials from 30-35, epic prizes and specials above
 *  that — the progression the events themselves are gated on. */
const BANDS = {
  silver: { tank: "Party Zombie", healer: "Zombee" },
  special: { tank: "Bombie", healer: "Pink Cupid Zombie" },
  epic: { tank: "Bombie", healer: "Pink Cupid Zombie" },
} as const;
const bandFor = (unlockLevel: number) =>
  unlockLevel <= 30 ? BANDS.silver : unlockLevel <= 35 ? BANDS.special : BANDS.epic;

/** The bounding party: a best-mutated level-appropriate headless in front, two
 *  level-appropriate healers immediately behind it (they deploy next, so they are healing
 *  by the time the tank is taking hits), and the rest of the line filling in. */
function supportedTank(unlockLevel: number, healers = 2): CombatUnit[] {
  const { tank, healer } = bandFor(unlockLevel);
  const owned = [
    makeOwned("tank", defByName(tank), 0, 0, 5, TANK_MUTATIONS),
    ...Array.from({ length: healers }, (_, i) =>
      makeOwned(`h${i}`, defByName(healer), 0, 0, 5, FULL_MUTATIONS)),
    ...Array.from({ length: 19 - healers }, (_, i) =>
      makeOwned(`b${i}`, defByName("Zomtar"), 0, 0, 5, FULL_MUTATIONS)),
  ];
  return buildPlayerUnits(owned, {
    concentration: true, abilityUnlocked: () => true, playerLevel: 45,
  });
}

/** As `line`, but the front unit is developed (max veterancy, best legal mutations).
 *  Used where the question is "can THIS unit hold the slot", separately from the
 *  supported-party rule above. */
function mutated(front: string, backer = "Zomtar"): CombatUnit[] {
  const owned = [
    makeOwned("front", defByName(front), 0, 0, 5, FULL_MUTATIONS),
    ...Array.from({ length: 19 }, (_, i) =>
      makeOwned(`b${i}`, defByName(backer), 0, 0, 0, 0)),
  ];
  return buildPlayerUnits(owned, {
    concentration: true, abilityUnlocked: () => true, playerLevel: 45,
  });
}

/** An unkillable boss, so the fight always runs the full window. */
function endlessBoss(str: number, dex: number): CombatUnit {
  return {
    id: "boss", sourceKey: "EpicBoss:test", team: "enemy", name: "Boss",
    str, dex, con: 20, focus: 0, hp: 10_000_000, maxHp: 10_000_000,
    attackCooldownMs: deriveAttackIntervalMs(dex, "enemy"),
    attacks: [{ name: "", frequency: 100, mult: 1 }], isBoss: true, alive: true,
    isGarden: false, isHeadless: false, abilities: [], attackDamageTiming: 0.88,
  };
}

/** Did ONE named unit die? Total party losses are the wrong question for every rule about
 *  who can hold the front slot — once the ramp is high enough, a squishy backer dying
 *  dominates the count and says nothing about whether the front unit held. */
function unitDied(players: CombatUnit[], boss: CombatUnit, id: string): boolean {
  const sim = new BattleSim(players, [boss], null, false, [], WINDOW_MS,
    null, null, true, true, true, 150);
  for (let i = 0; i < WINDOW_MS / 50 + 60 && !sim.finished; i++) {
    sim.step(50);
    const bubble = sim.chargingBubble();
    if (bubble) sim.popBubble(bubble.id);
  }
  return !sim.snapshot().units.find((u) => u.id === id)?.alive;
}
const tankDied = (p: CombatUnit[], b: CombatUnit) => unitDied(p, b, "tank");
const frontDied = (p: CombatUnit[], b: CombatUnit) => unitDied(p, b, "front");

/** Run one full epic attempt; report casualties and how wide the line got. */
function fight(players: CombatUnit[], boss: CombatUnit) {
  const sim = new BattleSim(players, [boss], null, false, [], WINDOW_MS,
    null, null, true, true, true, 150);
  let widest = 0;
  for (let i = 0; i < WINDOW_MS / 50 + 60 && !sim.finished; i++) {
    sim.step(50);
    const bubble = sim.chargingBubble();
    if (bubble) sim.popBubble(bubble.id);
    widest = Math.max(widest, sim.snapshot().units
      .filter((u) => u.team === "player" && u.state === "fight").length);
  }
  return { widest, losses: sim.outcome().losses.length };
}

describe("Epic Boss damage ramp", () => {
  const locust = epicBossById("loco-locust")!;
  const groundhog = epicBossById("dr-groundhog")!;
  /** The boss as it fights on `rung`. Defaults to the TOP rung, because that is where
   *  every rule below actually binds: damage compounds 5% per rung (epicBossDamage), so
   *  `unitStats.str` is only the entry fight and a rule checked against it would pass no
   *  matter what the ramp did above. */
  const bossOf = (def: (typeof EPIC_BOSSES)[number], rung = def.maxLevel) =>
    endlessBoss(epicBossDamage(def, rung), def.unitStats.dex);

  it("engages only a fraction of the army at once, however deep the line", () => {
    // The load-bearing fact behind the ramp: a 20-strong army does NOT bring 20
    // zombies' worth of damage, and the boss's damage lands on a handful of units
    // rather than spreading across the line. If this widens, the ramp is wrong in
    // both directions at once (clears get faster, front-liners get safer).
    //
    // The bound tracks the window, because the window IS what limits it: zombies
    // enter one every CHARGE_MS (3.6 s), so the line can only be as wide as the
    // attempt is long. Measured 6 at 30 s, 9 at 40 s, 10 at 45 s. Half the army is
    // still the ceiling — a bound of 12 leaves room for sim jitter without letting
    // "a fraction of the army" quietly become "all of it".
    const { widest } = fight(line("Scrooge Zombie"), bossOf(groundhog));
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(14);
  });

  // THE BOUNDING RULE. Every event must be survivable by the army the game has actually
  // handed the player by the time it unlocks: a level-appropriate headless wall, best
  // mutated, held up by two level-appropriate healers.
  //
  // This replaces an older rule — "each event's signature prize survives its own event" —
  // which read well but turned out to be a statement about one zombie's HP rather than
  // about what a player can field. It broke the moment the attempt window moved, and no
  // damage ramp could buy it back, because the fix was always "make the top boss as weak
  // as the entry boss". The rule below is stated on the army instead, so it stays
  // meaningful when the window or the ramp changes.
  it("lets a level-appropriate supported wall hold every event", () => {
    for (const boss of EPIC_BOSSES) {
      const unlock = epicBossUnlockLevel(boss);
      expect(fight(supportedTank(unlock), bossOf(boss)).losses, boss.name).toBe(0);
    }
  });

  it("makes that same wall FAIL without its healers, from mid-ladder up", () => {
    // The other half of the rule, and the reason the ramp crosses the unaided wall's
    // death line partway up instead of sitting under it. An army that brings nothing but
    // damage keeps its front-liner through the early events on a visibly narrowing margin
    // and then starts losing it every attempt — and casualties are permanent.
    //
    // Without this, "survives with two healers" is satisfied by any ramp at all, because
    // the wall survives unaided too and the healers are decoration. Support has to be a
    // real decision, which means there must be events where skipping it costs you.
    // Measured at each event's ENTRY rung, so this stays a statement about which EVENT
    // demands support rather than which rung — the per-rung ramp is the next test.
    const unaidedDeaths = EPIC_BOSSES.filter(
      (boss) => tankDied(supportedTank(epicBossUnlockLevel(boss), 0), bossOf(boss, 1))
    );
    // The entry event never demands healers…
    expect(tankDied(supportedTank(24, 0), bossOf(groundhog, 1))).toBe(false);
    // …the hardest one always does…
    expect(tankDied(supportedTank(42, 0), bossOf(locust, 1))).toBe(true);
    // …and the switchover is partway up rather than at either end.
    expect(unaidedDeaths.length).toBeGreaterThanOrEqual(3);
    expect(unaidedDeaths.length).toBeLessThanOrEqual(6);
  });

  it("makes the ramp bite WITHIN an event, not just across the ladder", () => {
    // What the 5%-per-rung ramp is for (raid ruleset v29). Play-testing found a maxed army
    // clearing the hardest event without a single casualty: HP alone could not gate it,
    // because HP only ever buys more attempts. Damage can, and it is deliberately
    // REGRESSIVE — it costs a thin roster far more than a developed one, which is the
    // gate. So an unaided wall that walks into an event comfortably must NOT still be
    // comfortable at the top of it.
    //
    // Stated on the mid-ladder events, because the early ones are meant to stay gentle
    // throughout and the late ones already fail unaided on rung 1 (the test above).
    const midLadder = EPIC_BOSSES.filter((boss) => {
      const unlock = epicBossUnlockLevel(boss);
      return unlock >= 30 && unlock <= 38;
    });
    expect(midLadder.length).toBeGreaterThan(0);
    const flipped = midLadder.filter((boss) => {
      const unlock = epicBossUnlockLevel(boss);
      const entryOk = !tankDied(supportedTank(unlock, 0), bossOf(boss, 1));
      const topFails = tankDied(supportedTank(unlock, 0), bossOf(boss, boss.maxLevel));
      return entryOk && topFails;
    });
    expect(flipped.length, "no event gets harder for an unaided wall as it climbs")
      .toBeGreaterThan(0);
  });

  it("keeps the bounding rule true at the TOP rung, where it binds", () => {
    // The rule above runs at each event's top rung by default (see bossOf). Restated
    // explicitly because it is the one assertion the ramp could break: the supported wall
    // must hold 1.05^9 = 1.55x the authored damage, which on Loco Locust is 217 DPS.
    for (const boss of EPIC_BOSSES) {
      const top = epicBossDamage(boss, boss.maxLevel);
      expect(top, boss.name).toBeGreaterThan(boss.unitStats.str);
      expect(fight(supportedTank(epicBossUnlockLevel(boss)), bossOf(boss, boss.maxLevel)).losses,
        boss.name).toBe(0);
    }
  });

  it("would break that rule if the ramp climbed far enough", () => {
    // The guard rail, measured: the supported wall finally dies at 800 DPS, ten times the
    // top boss. That is a wide margin, and deliberately so — a rule that only just passes
    // is a rule that flips on the next tuning nudge. If this stops failing, either sim
    // pacing changed or the ramp has room the calibration did not account for.
    expect(fight(supportedTank(42), endlessBoss(40, 2)).losses).toBeGreaterThan(0);
  });

  it("still punishes a thin front-liner at the top of the ramp", () => {
    // Zomtar (1575 HP) is a damage-dealer, not a tank. Leading with it costs it — even
    // fully developed, at the top of the ladder.
    expect(frontDied(line("Zomtar"), bossOf(locust))).toBe(true);
    expect(frontDied(mutated("Zomtar"), bossOf(locust))).toBe(true);
  });

  it("leaves the entry boss harmless to a wall, developed or not", () => {
    // The entry event is the one a player meets at level 24, before the brain economy has
    // paid for anything. It must not punish a unit brought for the job — every headless
    // wall holds it on base stats alone, with no veterancy and no mutations.
    for (const front of ["Bombie", "Scrooge Zombie", "Party Zombie", "Skull Head"]) {
      expect(frontDied(line(front), bossOf(groundhog, 1)), front).toBe(false);
    }
  });

  it("teaches the support lesson at the entry event, cheaply", () => {
    // A glass cannon led from the front dies to even the entry boss, and DEVELOPING IT IS
    // NOT THE FIX — Proto Zombie at 1150 HP reaches ~2400 fully veteran and mutated,
    // against 48 DPS over a 60 s attempt. Bringing the right body is the fix.
    //
    // That is deliberate and it is why the lesson lands here rather than at Foul Owl: the
    // entry event is the cheapest place to learn that a front slot needs a wall, and the
    // cost of learning it is one attempt on a 3-brain event rather than a lost omega on a
    // 5-brain one.
    //
    // (Zomtar was the example until the 2026-09-07 Epic re-fit lifted it to 1720 HP —
    // developed, it now just outlasts the 60 s attempt. It is still no tank: see the
    // Loco Locust test above, where it dies at the top of the ramp either way.)
    for (const front of ["Proto Zombie", "Old McZombie"]) {
      expect(frontDied(line(front), bossOf(groundhog, 1)), front).toBe(true);
      expect(frontDied(mutated(front), bossOf(groundhog, 1)), front).toBe(true);
    }
  });

  it("makes an UNDEVELOPED wall run out of road part-way up the ladder", () => {
    // The gradient the ramp exists to create, stated from the other side. A bare wall is
    // fine early and stops being enough later, which is what makes developing one worth
    // doing — and is exactly what the supported-party rule above allows for. If a bare
    // wall ever clears the whole ladder the ramp has gone flat; if it clears none of it,
    // the entry event has stopped being an entry event.
    const bareBombieFails = EPIC_BOSSES.filter((boss) => frontDied(line("Bombie"), bossOf(boss, 1)));
    expect(bareBombieFails.length).toBeGreaterThan(0);
    expect(bareBombieFails.length).toBeLessThan(EPIC_BOSSES.length);
  });

  it("keeps the Market's own wall a legal answer to every event", () => {
    // Bombie is Market-bought, so the answer to the ladder is never gated behind a drop.
    // Developed and supported — the same party the bounding rule is stated on — it holds
    // every event, which is what stops the ramp becoming "own the one right zombie or do
    // not play". The Silver band's wall (Party Zombie) is a crop, so it is ungated too.
    for (const boss of EPIC_BOSSES) {
      expect(tankDied(supportedTank(epicBossUnlockLevel(boss)), bossOf(boss)), boss.name).toBe(false);
    }
  });
});

// Reported as the Dr. Groundhog battle "not loading" and showing a green screen. The
// battle build was waiting on `assets/raids/enemies/EpicBoss:dr-groundhog.png` — a file
// that names an EVENT, not a sprite, and so can never exist. `Assets.load` spends about
// three seconds discovering that, never caches the failure, and the whole build sits on
// that await: the farm is already hidden and the battle HUD lives inside the scene, so
// there is nothing on screen but the stage's clear colour for the entire wait. On a
// phone on mobile data it is far longer than three seconds.
describe("an Epic Boss is drawn from its own folder, never the shared enemy art", () => {
  it("recognises the source key a boss actually fights under", () => {
    for (const boss of EPIC_BOSSES) {
      const units = buildEpicBossSetup(
        boss,
        {
          runId: "r", bossId: boss.id, level: 1, maxHp: 100, currentHp: 100,
          activatedAt: 0, expiresAt: 1, encounterStartedAt: 0, retryReadyAt: 0,
          tokenCount: 0, completedAt: 0, attackOrder: [],
        },
        [],
        { farmer: {} } as never,
        { level: 1, abilityUnlocked: () => true, farmerZombieStrengthMult: () => 1,
          farmerZombieLifeMult: () => 1 } as never,
      );
      const bossUnit = units.enemyUnits.find((unit) => unit.isBoss)!;
      expect(isEpicBossKey(bossUnit.sourceKey), boss.id).toBe(true);
    }
  });

  it("does not mistake an ordinary raid enemy for one", () => {
    // The guard SKIPS a texture request, so a false positive here would leave a real
    // enemy undrawn — a far worse failure than the stall it removes.
    for (const key of [
      "FarmStageActorBoss", "PirateStageActorMinion1", "NinjaStageActorBoss",
      "AlienStageActorMinion", "VideoGameStageActorBoss", "carrotWall", "junkWall",
    ]) {
      expect(isEpicBossKey(key), key).toBe(false);
    }
  });

  it("ships every boss the art its own key cannot resolve to", () => {
    // The other half of the same rule: skipping the shared-enemy request is only safe
    // because each boss carries its own combat art. A boss that shipped without it would
    // now fall through to the portrait circle instead of a three-second wait for nothing.
    for (const boss of EPIC_BOSSES) {
      expect(boss.bossTexture, boss.id).toBeTruthy();
      const asset = (file: string) =>
        new URL(`../../public/assets/epic-bosses/${boss.id}/${file}`, import.meta.url);
      expect(existsSync(asset(boss.bossTexture)), boss.id).toBe(true);
      for (const [name, animation] of Object.entries(boss.animations)) {
        expect(existsSync(asset(animation.file)), `${boss.id} ${name}`).toBe(true);
      }
    }
  });
});
