// The fight configs a boss and a stage bring, and the rule that there is only one copy
// of them.
//
// These builders used to be private methods on RaidManager. Two other places wanted the
// same answers — the elite balance test, and now the raid lab — and one of them had
// already grown its own transcription, which is how a measuring stick ends up measuring
// a fight the player never has. The extraction is only worth anything if it stays the
// single source, so the last test here says so in a way that fails if a copy comes back.
// @ts-ignore - node types are test-environment only, as in rigClips.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import attacksJson from "../../public/assets/raids/attacks.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import raidsJson from "../../public/assets/raids/raids.json";
import { eliteProfile } from "./eliteInvasion";
import {
  bossSpecialsFor, bossThrowFor, crabFor, grabberFor, summonFor, turnedTemplateFor,
  wallTemplateFor, type FightAssets,
} from "./fightConfig";
import { fightStage, resolveStageWave, seededRandom } from "./RaidCatalog";
import type { AttackDef, EnemyStat, RaidDef } from "./types";

const raids = raidsJson as RaidDef[];
const assets: FightAssets = {
  enemyStats: enemyStatsJson as Record<string, EnemyStat>,
  raidAttacks: attacksJson as Record<string, AttackDef>,
};
const playable = raids.filter((r) => r.playable && r.stages.length);

/** The stage each raid fights at its own recommended level, wave roll resolved. */
const stageOf = (raid: RaidDef) => {
  const base = fightStage(raid, raid.recommendedLevel + 2);
  return base ? resolveStageWave(base, seededRandom(`cfg:${raid.id}`)) : null;
};

describe("fight config", () => {
  it("every authored boss action reaches the fight as a throw or a special", () => {
    // The two builders split one list, and a name that fell between them would be an
    // action the boss simply never performs — silent, and invisible in play.
    const missed: string[] = [];
    for (const raid of playable) {
      const stage = stageOf(raid);
      if (!stage?.bossKey || stage.throwingDisabled) continue;
      const authored = assets.enemyStats[stage.bossKey]?.bossActions ?? [];
      const throws = bossThrowFor(assets, raid, stage, 0)?.options.length ?? 0;
      const specials = bossSpecialsFor(assets, stage);
      // A throw entry with no sprite is dropped on purpose (nothing to draw).
      const throwable = authored.filter((a) => a.name === "throw" && a.sprite).length;
      if (throws !== throwable) missed.push(`${raid.name}: ${throwable} throws authored, ${throws} built`);
      for (const a of authored) {
        if (a.name === "throw") continue;
        if (!specials.some((s) => s.name === a.name)) missed.push(`${raid.name}: "${a.name}" never fires`);
      }
    }
    expect(missed.join("\n")).toBe("");
  });

  it("a stage with no boss, or with throwing disabled, brings nothing", () => {
    const raid = playable[0];
    const bare = { enemyKeys: [] };
    expect(bossThrowFor(assets, raid, bare, 0)).toBeNull();
    expect(bossSpecialsFor(assets, bare)).toEqual([]);
    expect(wallTemplateFor(assets, bare)).toBeNull();
    expect(summonFor(assets, raid, bare, 30)).toBeNull();
    expect(turnedTemplateFor(assets, raid, bare, 30)).toBeNull();

    // `throwingDisabled` is the early-boss-wave rule: the boss comes down to fight but
    // brings none of its repertoire, so the gate has to cover the SPECIALS too.
    const boss = playable.map(stageOf).find((s) => s?.bossKey)!;
    const muted = { ...boss, throwingDisabled: true };
    expect(bossThrowFor(assets, raids[0], muted, 0)).toBeNull();
    expect(bossSpecialsFor(assets, muted)).toEqual([]);
  });

  it("the wall stands the action's own art up at the action's own HP", () => {
    const walled = playable
      .map((raid) => ({ raid, stage: stageOf(raid) }))
      .filter((r) => r.stage && wallTemplateFor(assets, r.stage!));
    expect(walled.length).toBeGreaterThan(0); // the Ninjas and JunkBot both carry one
    for (const { raid, stage } of walled) {
      const wall = wallTemplateFor(assets, stage!)!;
      const authored = (assets.enemyStats[stage!.bossKey!]?.bossActions ?? [])
        .find((a) => a.name === "wall")!;
      // maxHp IS the wall's health: the sim's toSim() reads maxHp, so a wall whose hp
      // and maxHp disagreed would be a blocker with the wrong number of hits in it.
      expect(wall.hp, raid.name).toBe(wall.maxHp);
      expect(wall.hp, raid.name).toBe(Math.max(1, Math.round(authored.hp ?? 1500)));
      expect(wall.sourceKey, raid.name).toBe((authored.sprite ?? "carrotWall.png").replace(/\.png$/i, ""));
      expect(wall.sourceKey.endsWith(".png"), raid.name).toBe(false);
    }
  });

  it("elite scales the wall and leaves the ordinary fight alone", () => {
    const target = playable.map((raid) => ({ raid, stage: stageOf(raid) }))
      .find((r) => r.stage && wallTemplateFor(assets, r.stage!))!;
    const plain = wallTemplateFor(assets, target.stage!, null)!;
    const elite = wallTemplateFor(assets, target.stage!, eliteProfile(target.raid.id, true))!;
    expect(elite.hp).toBeGreaterThanOrEqual(plain.hp);
  });

  it("the two rescue hazards belong to exactly the raids whose STAGE ships their art", () => {
    // Both are keyed off authored data (hasGrab + a sprite table; initialSpawnClass),
    // not a hand-kept list of ids, so this is a check that the data still says so.
    //
    // The Circus & Video Games invasion is fought ON the Circus stage — same backdrop,
    // same big top, same trapeze rigged over the lane — so it has the trapeze too. It did
    // not until the grab sprite was keyed through `stageRaidId`: the table was asked about
    // raid 14, had never heard of it, and quietly deleted a hazard from a fight built
    // around it. See borrowedStage.test.ts.
    const grabs = playable.filter((r) => grabberFor(r)).map((r) => r.name);
    const crabs = playable.filter((r) => crabFor(r)).map((r) => r.name);
    expect(grabs).toEqual(["Zombies vs Circus", "Zombies vs Circus & Video Games"]);
    expect(crabs).toEqual(["Summer Break"]);
    for (const raid of playable) {
      const crab = crabFor(raid);
      if (crab) expect(crab.limit).toBe(raid.obstacleLimit);
    }
  });

  it("the alien summon and the pixel zombie stay with their own boss", () => {
    const summons = playable.filter((r) => {
      const stage = stageOf(r);
      return stage && summonFor(assets, r, stage, 30);
    }).map((r) => r.name);
    const turned = playable.filter((r) => {
      const stage = stageOf(r);
      return stage && turnedTemplateFor(assets, r, stage, 30);
    }).map((r) => r.name);
    // Raid 15 is fought on the alien stage with the alien boss, so it gets the rota too —
    // the abductee is part of that fight by design (positioned beside the bubble's wall).
    expect(summons).toEqual(["Zombies vs Aliens", "Zombies vs Aliens & Robots"]);
    expect(turned).toEqual(["Zombies vs Video Games"]);
  });

  it("every fight derives its config here and nowhere else", () => {
    // The failure this guards against is a re-transcription creeping back — reading
    // `bossActions` again somewhere, and drifting from what the server's verifier and
    // the difficulty harness measure. The builders are called from ONE composer now
    // (composeFight.ts); RaidManager, the verifier and the harness call that. If a new
    // builder genuinely belongs in a fight, put it in fightConfig.ts and call it from
    // the composer; don't relax this.
    const composer = readFileSync(new URL("./composeFight.ts", import.meta.url), "utf-8");
    expect(composer.includes("bossActions")).toBe(false);
    for (const fn of ["bossThrowFor", "bossSpecialsFor", "grabberFor", "crabFor",
      "summonFor", "wallTemplateFor", "turnedTemplateFor", "bubbleWallFor",
      "farmerSquadFor", "pirateCaptainFor", "circusStacksFor", "robotEscortFor"]) {
      expect(composer.includes(fn), fn).toBe(true);
    }
    for (const file of ["./RaidManager.ts", "../../server/src/raidVerifier.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(src.includes("bossActions"), file).toBe(false);
      expect(src.includes("composeFight"), file).toBe(true);
    }
  });
});
