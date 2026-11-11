import { describe, expect, it } from "vitest";
import { call, grantBalance, grantLevel, grantRoster, signIn, uniqueSub } from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import { endlessSimFor, type EndlessFightConfig } from "../../../src/raid/endlessFight";
import { flyFight } from "../../../src/raid/harness/pilot";
import { EXPERT, makePilot } from "../../../src/raid/harness/pilots";

// Endless end to end: the Worker builds a floor, the client's own sim flies it, and the
// Worker replays the transcript and moves the run on. Pointed at staging (IT_BASE), this is
// the check that the deployed Worker and this checkout agree on the battle rules.

// A strong, fully mutated army (every slot's strongest bit), so floor 1 is a sure win.
const ARMY = [
  ...Array.from({ length: 3 }, () => ["ZombieActorLargeTier4", 47616]),
  ...Array.from({ length: 3 }, () => ["ZombieActorGardenTier4", 47616]),
  ...Array.from({ length: 2 }, () => ["ZombieActorHeadlessTier4", 47104]),
  ...Array.from({ length: 12 }, () => ["ZombieActorRegularTier4", 63488]),
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Endless", () => {
  it("plays floor 1, has it verified, and hands back floor 2 with the location's perched boss", async () => {
    const s = await signIn(uniqueSub("endless"));
    // Balance first: the balance fixture rewrites xp, so the level goes on after it.
    await grantBalance(s, { gold: 0, brains: 5, xp: 0 });
    await grantLevel(s, 45);
    const units = ARMY.map(([key, mutation], i) => ({ id: `e2e-${i}`, key, mutation, stored: false }));
    await grantRoster(s, units);
    const ids = units.map((u) => u.id);

    const started = await call<any>("POST", "/endless/start", s.token, {
      mode: "endless", orderedUnitIds: ids, rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const floor1 = started.body.fight as EndlessFightConfig;
    expect(floor1).toMatchObject({ wave: 1, location: "farm" });
    // Floor 1 is enemies only: no boss, no projectiles.
    expect(floor1.enemyUnits.some((u) => u.isBoss)).toBe(false);
    expect(floor1.bossThrow ?? null).toBeNull();

    const flight = flyFight(endlessSimFor(floor1), makePilot(EXPERT), { seed: "e2e" });
    expect(flight.win).toBe(true);
    // The Worker refuses a transcript longer than the wall time since the fight began.
    await sleep(Math.max(0, flight.ticks * 50 - 1500));

    const finished = await call<any>("POST", "/endless/finish", s.token, {
      sessionId: started.body.sessionId, wave: 1, finalTick: flight.ticks, inputs: flight.inputs,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body).toMatchObject({ runFinished: false, nextWave: 2 });

    // Floor 2: Old McDonnell perched at the back, throwing his own projectiles.
    const floor2 = finished.body.fight as EndlessFightConfig;
    expect(floor2.enemyUnits.find((u) => u.isBoss)?.sourceKey).toBe("FarmStageActorBoss");
    expect(floor2.bossThrow?.options.map((o) => o.sprite)).toEqual(["stex0004.png", "chicken.png", "bucket.png"]);

    const ended = await call<any>("POST", "/endless/abandon", s.token, { sessionId: started.body.sessionId });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ runFinished: true });
  }, 240_000);
});
