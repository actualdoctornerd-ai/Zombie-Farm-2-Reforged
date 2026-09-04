// Data-fidelity regression for the SHIPPED raid waves (public/assets/raids/raids.json).
//
// ZF2 picks the fought stage once — `stageSettings[playerLevel − recommendedLevel]`,
// clamped, with no in-fight wave advance — so a raid authoring a single stage fights
// that one wave at EVERY level. Only Old McDonnell ships a real 7-stage ladder.
//
// `tools/prep_raids.py` used to extrapolate McDonnell's ladder onto all 11 raids, which
// both under-fielded the mid raids (Circus 4500 HP against an authored 6300) and wildly
// over-fielded the late ones (Video Games 1,078,000 against an authored 121,200). These
// tests pin each raid's authored population so a regenerate can't silently drift again.
import { describe, it, expect } from "vitest";
import raidsJson from "../../public/assets/raids/raids.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import { fightStage, resolveStageWave, seededRandom, weightedPopulation } from "./RaidCatalog";
import type { EnemyStat, RaidDef } from "./types";

const raids = raidsJson as unknown as RaidDef[];
const enemyStats = enemyStatsJson as unknown as Record<string, EnemyStat>;
const byId = (id: number) => raids.find((r) => r.id === id)!;

/** Authored `population` per raid, transcribed from the source Enemies.json — either
 *  the raid's single `stageSettings` entry (2 / 10 / 11) or its top-level field (the
 *  other seven). McDonnell is absent: it is a ladder, not one wave. */
const AUTHORED_POPULATION: Record<number, number> = {
  2: 10, 3: 6, 4: 10, 5: 2, 6: 20, 7: 8, 8: 8, 9: 8, 10: 8, 11: 8,
};

describe("raid waves — authored composition, not an extrapolated ladder", () => {
  it("only Old McDonnell ships a multi-stage ladder", () => {
    const laddered = raids.filter((r) => r.stages.length > 1).map((r) => r.id);
    expect(laddered).toEqual([1]);
    expect(byId(1).stages).toHaveLength(7);
  });

  it("every other raid ships exactly one authored wave", () => {
    for (const r of raids.filter((raid) => raid.id !== 1)) {
      expect(`${r.id}:${r.stages.length}`).toBe(`${r.id}:1`);
    }
  });

  it("a single-stage raid fights the same wave at every player level", () => {
    for (const r of raids.filter((raid) => raid.id !== 1)) {
      const at = (lvl: number) => fightStage(r, lvl);
      const base = at(r.recommendedLevel);
      expect(base).toBeTruthy();
      for (const lvl of [1, r.recommendedLevel - 5, r.recommendedLevel + 1, 40, 99]) {
        expect(at(lvl)).toBe(base);
      }
    }
  });

  it("each raid keeps its source-authored population", () => {
    for (const [id, population] of Object.entries(AUTHORED_POPULATION)) {
      const stage = byId(Number(id)).stages[0];
      expect(`raid${id} pop ${stage.population}`).toBe(`raid${id} pop ${population}`);
    }
  });

  it("Circus fields the authored 8-strong 20/80 minion mix plus the Ringmaster", () => {
    const stage = byId(8).stages[0];
    expect(stage.bossKey).toBe("CircusStageActorBoss");
    expect(stage.population).toBe(8);
    expect(stage.weighted).toEqual([
      { enemy: "CircusStageActorMinion1", frequency: 20 },
      { enemy: "CircusStageActorMinion2", frequency: 80 },
    ]);
  });

  it("every population wave carries a boss and a spawnable minion pool", () => {
    // A `population` stage with no weighted pool makes buildEnemyUnits spawn the boss
    // alone.
    for (const r of raids) {
      for (const stage of r.stages) {
        if (!stage.population) continue;
        const total = (stage.weighted ?? []).reduce((sum, w) => sum + w.frequency, 0);
        expect(`raid${r.id} pool ${total > 0}`).toBe(`raid${r.id} pool true`);
      }
    }
    // Robots names no boss because it draws one per fight (`randomBoss`); every other
    // raid must name one, or its wave pays no boss loot, brains or ability unlock.
    for (const r of raids.filter((raid) => raid.id !== 1)) {
      const stage = r.stages[0];
      expect(`raid${r.id} boss ${!!(stage.bossKey || stage.randomBoss)}`).toBe(`raid${r.id} boss true`);
    }
  });
});

// ---- Zombies vs Robots: the random boss --------------------------------------
//
// Source: `randomBoss: true` on Enemies.json entry 5, honoured by `-[ZFFightMan
// initialSpawn]` — copy the raid's `enemies` array (one entry per bot), draw one at
// random as the boss, REMOVE it, then spawn the survivors one at a time. The wiki says
// the same thing from the player's side: three types of robot, population 3, "any one
// of them has a random chance to be the Boss".
//
// The old frequency allocation could not produce that. 33/33/34 over a population of 2
// floors every share to 0 and hands both leftover slots to the largest remainders —
// BrainBot and BroBot, every single time — behind a hardcoded BrainBot boss. So JunkBot
// never appeared, the boss never changed, and the order never changed: exactly the three
// things a player reported.
describe("Zombies vs Robots — randomBoss", () => {
  const stage = byId(5).stages[0];
  const BOTS = ["RobotStageActorBroBot", "RobotStageActorJunkBot", "RobotStageActorBrainBot"];

  it("ships a random-boss wave with all three bots and no fixed boss", () => {
    expect(stage.randomBoss).toBe(true);
    expect(stage.bossKey).toBeUndefined();
    expect((stage.weighted ?? []).map((w) => w.enemy).sort()).toEqual([...BOTS].sort());
  });

  it("fields each bot exactly once, whoever leads", () => {
    for (let i = 0; i < 200; i++) {
      const wave = resolveStageWave(stage, seededRandom(`seed-${i}`));
      expect([wave.bossKey!, ...wave.enemyKeys].sort()).toEqual([...BOTS].sort());
      expect(wave.population).toBe(2); // the two survivors; +1 boss = the wiki's 3
      expect(wave.weighted).toBeUndefined(); // no frequency re-derivation downstream
    }
  });

  it("gives every bot a real chance at leading the invasion", () => {
    const led = new Set<string>();
    for (let i = 0; i < 200; i++) led.add(resolveStageWave(stage, seededRandom(`s${i}`)).bossKey!);
    expect([...led].sort()).toEqual([...BOTS].sort());
  });

  it("varies the spawn order of the two survivors", () => {
    const orders = new Set<string>();
    for (let i = 0; i < 200; i++) orders.add(resolveStageWave(stage, seededRandom(`o${i}`)).enemyKeys.join(">"));
    expect(orders.size).toBe(6); // 3 boss choices x 2 orderings of the rest
  });

  it("draws the SAME wave from the same seed — client and server must agree", () => {
    // Online, the seed is the raid session id: the server pins its wave from it at
    // /raid/start and the client redraws from the id in the response. Any divergence
    // here is a fight the deterministic replay would reject.
    for (const seed of ["session-a", "session-b", "0", "8f14e45f-ea3f-4f2b-9f2c-000000000000"]) {
      const a = resolveStageWave(stage, seededRandom(seed));
      const b = resolveStageWave(stage, seededRandom(seed));
      expect(a).toEqual(b);
    }
  });

  it("only a JunkBot boss brings the junk wall", () => {
    // Ground truth (and the wiki note): "A Robot will only use their special abilities
    // when they are the boss of the invasion." The junk wall is authored on JunkBot
    // alone, so hoisting it onto whoever leads is what had BrainBot summoning junk.
    const walled = Object.entries(enemyStats)
      .filter(([, s]) => (s.bossActions ?? []).some((a) => a.name === "wall"))
      .map(([key]) => key);
    expect(walled.filter((k) => k.startsWith("RobotStageActor"))).toEqual(["RobotStageActorJunkBot"]);
    // ...and telekinesis is BrainBot's alone, the same way.
    const telekinetic = Object.entries(enemyStats)
      .filter(([, s]) => (s.bossActions ?? []).some((a) => a.name === "telekinesis"))
      .map(([key]) => key);
    expect(telekinetic).toEqual(["RobotStageActorBrainBot"]);
  });

  it("leaves an authored enemyKeys wave untouched", () => {
    // McDonnell's tutorial rungs spell their spawn order out (lumberjack last at the
    // Invade beat); nothing is drawn for them.
    for (const r of raids) {
      for (const s of r.stages) {
        if (s.randomBoss || s.weighted) continue;
        expect(resolveStageWave(s, seededRandom("x"))).toBe(s);
      }
    }
  });
});

// Ruleset 48: every other weighted wave emerges in a seeded shuffle of its exact
// multiset. Before this the allocation's grouped order WAS the emergence order, so every
// fight of an invasion sent the same enemies in the same sequence.
describe("weighted waves — seeded shuffle of the authored multiset (ruleset 48)", () => {
  const weightedStages = raids.flatMap((r) =>
    r.stages.map((s, i) => ({ raid: r, index: i, stage: s }))
      .filter(({ stage }) => stage.weighted && !stage.randomBoss && !(stage.enemyKeys?.length)));

  it("covers the raids the bump names, and only those", () => {
    // 2, 3, 4, 6, 7, 8, 9, 10, 11 (their single wave) plus McDonnell's rungs 5 and 6.
    expect(weightedStages.map(({ raid, index }) => `${raid.id}#${index}`)).toEqual([
      "1#5", "1#6", "2#0", "3#0", "4#0", "6#0", "7#0", "8#0", "9#0", "10#0", "11#0",
    ]);
  });

  it("draws the SAME order from the same seed — client and server must agree", () => {
    for (const { stage } of weightedStages) {
      for (const seed of ["session-a", "session-b", "0", "8f14e45f-ea3f-4f2b-9f2c-000000000000"]) {
        expect(resolveStageWave(stage, seededRandom(seed)))
          .toEqual(resolveStageWave(stage, seededRandom(seed)));
      }
    }
  });

  it("keeps the exact authored multiset — counts per type never change", () => {
    for (const { raid, index, stage } of weightedStages) {
      const authored = [...weightedPopulation(stage)].sort();
      expect(authored.length, `${raid.name} #${index}`).toBe(stage.population);
      for (let i = 0; i < 20; i++) {
        const wave = resolveStageWave(stage, seededRandom(`m${i}`));
        expect([...wave.enemyKeys].sort(), `${raid.name} #${index} seed ${i}`).toEqual(authored);
        expect(wave.population).toBe(stage.population);
        expect(wave.weighted).toBeUndefined(); // no grouped re-derivation downstream
        expect(wave.bossKey).toBe(stage.bossKey);
      }
    }
  });

  it("never puts the boss in the spawn list", () => {
    for (const { stage } of weightedStages) {
      const wave = resolveStageWave(stage, seededRandom("boss"));
      expect(wave.enemyKeys).not.toContain(stage.bossKey);
    }
  });

  it("actually varies between seeds wherever there is more than one type to order", () => {
    for (const { raid, index, stage } of weightedStages) {
      const types = new Set(weightedPopulation(stage));
      const orders = new Set<string>();
      for (let i = 0; i < 40; i++) orders.add(resolveStageWave(stage, seededRandom(`o${i}`)).enemyKeys.join(">"));
      if (types.size < 2) expect(orders.size, `${raid.name} #${index}`).toBe(1); // Aliens: one type
      else expect(orders.size, `${raid.name} #${index}`).toBeGreaterThan(1);
    }
  });

  it("no longer emerges grouped by type every fight", () => {
    // The order that used to be the only one. Across forty seeds at least one fight must
    // differ from it, for every wave with something to shuffle.
    for (const { raid, index, stage } of weightedStages) {
      const grouped = weightedPopulation(stage).join(">");
      if (new Set(weightedPopulation(stage)).size < 2) continue;
      const anyDifferent = Array.from({ length: 40 }, (_, i) =>
        resolveStageWave(stage, seededRandom(`g${i}`)).enemyKeys.join(">")).some((order) => order !== grouped);
      expect(anyDifferent, `${raid.name} #${index}`).toBe(true);
    }
  });
});
