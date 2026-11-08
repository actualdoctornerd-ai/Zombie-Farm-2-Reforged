// Endless run settlement against the real schema, on node:sqlite: the writes are guarded
// statements whose behaviour a fake database cannot show (a loot grant that must stop the run
// advancing, milestones that pay once, a weekly board keyed off the run having just finished).
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import zombiesJson from "../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../src/raid/CombatEngine";
import { beginEndlessRun, endlessBossDraft, endlessWeekSeed, type EndlessRunState } from "../../src/raid/endless";
import { endlessFightConfig, endlessSimFor } from "../../src/raid/endlessFight";
import { flyFight } from "../../src/raid/harness/pilot";
import { EXPERT, makePilot } from "../../src/raid/harness/pilots";
import { RAID_RULESET_VERSION } from "../../src/raid/replay";
import { makeOwned } from "../../src/zombie/types";
import type { ZombieDef } from "../../src/assets";
import { abandonEndless, chooseEndlessBossReward, finishEndlessWave, startEndless } from "../src/v3/endless";
import { listEndlessLeaderboard } from "../src/db";

const ME = "account-1";
const SESSION = "run-1";
const LATER = 3_600_000;

function openDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: async () => raw.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...(params as never[])) }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(params as never[])).changes) } }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => ({
          meta: { changes: Number(raw.prepare(s.sql).run(...(s.params as never[])).changes) },
        }));
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, raw };
}

const ZWAMP = (zombiesJson as ZombieDef[]).find((z) => z.key === "ZombieActorZwampThing")!;
const army = () => buildPlayerUnits(
  Array.from({ length: 20 }, (_, i) => makeOwned(`z${i}`, ZWAMP, 0, 0, 5, 0)),
  { abilitySlotUnlocked: () => true, playerLevel: 45 },
);

describe("Endless settlement on the real schema", () => {
  let db: D1Database;
  let raw: DatabaseSync;
  const seedRun = (wave: number, run: EndlessRunState, pending?: object) => {
    const payload = { run: { ...run, nextWave: wave }, playerLevel: 45, durationMs: 0, ...(pending ? { pendingBossChoice: pending } : {}) };
    const fight = pending ? {} : endlessFightConfig(payload.run, 45);
    raw.prepare(`INSERT INTO endless_runs_v3
      (id,account_id,mode,current_wave,run_state_json,army_json,fight_config_json,ruleset_version,started_at,fight_started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(SESSION, ME, run.mode, wave, JSON.stringify(payload), "[]", JSON.stringify(fight), RAID_RULESET_VERSION, 0, 0);
    return fight;
  };
  const winFloor = (fight: unknown, wave: number) => {
    const flight = flyFight(endlessSimFor(fight as never), makePilot(EXPERT), { seed: `w${wave}` });
    expect(flight.win).toBe(true);
    return { sessionId: SESSION, wave, finalTick: flight.ticks, inputs: flight.inputs };
  };
  const inventory = () => JSON.parse((raw.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").get(ME) as { current_json: string }).current_json).inventory as Record<string, number>;
  const received = () => JSON.parse((raw.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").get(ME) as { current_json: string }).current_json).storage.received as Record<string, number>;
  const brains = () => (raw.prepare("SELECT brains FROM balances WHERE account_id=?").get(ME) as { brains: number }).brains;
  const gold = () => (raw.prepare("SELECT gold FROM balances WHERE account_id=?").get(ME) as { gold: number }).gold;

  beforeEach(() => {
    ({ db, raw } = openDb());
    raw.prepare(`INSERT INTO accounts (id, google_sub, friend_code, created_at, last_online_at, username)
      VALUES (?, 'sub', 'CODE', 0, 0, 'Grog')`).run(ME);
    raw.prepare("INSERT INTO balances (account_id, gold, brains, xp) VALUES (?, 0, 5, 218000)").run(ME);
    raw.prepare(`INSERT INTO gameplay_documents_v3 (account_id, current_json, updated_at) VALUES (?, ?, 0)`)
      .run(ME, JSON.stringify({ inventory: {}, storage: { received: {}, stored: {} } }));
  });

  it("grants a floor's loot and advances together", async () => {
    const fight = seedRun(1, beginEndlessRun("endless", army(), "9"));
    const result = await finishEndlessWave(db, ME, winFloor(fight, 1), LATER);
    expect(result.status).toBe(200);
    const [loot] = result.body.floorLoot as { key: string; quantity: number }[];
    expect(inventory()[loot.key]).toBe(loot.quantity);
    expect((raw.prepare("SELECT current_wave FROM endless_runs_v3").get() as { current_wave: number }).current_wave).toBe(2);
  });

  it("neither grants nor advances when a farm save got in first", async () => {
    const fight = seedRun(1, beginEndlessRun("endless", army(), "9"));
    const finish = winFloor(fight, 1);
    const realBatch = db.batch.bind(db);
    (db as unknown as { batch: unknown }).batch = async (statements: never[]) => {
      raw.prepare("UPDATE gameplay_documents_v3 SET current_json=? WHERE account_id=?")
        .run(JSON.stringify({ inventory: { golden_dice: 1 }, storage: { received: {}, stored: {} } }), ME);
      return realBatch(statements);
    };
    const result = await finishEndlessWave(db, ME, finish, LATER);
    expect(result.status).toBe(409);
    expect((raw.prepare("SELECT current_wave FROM endless_runs_v3").get() as { current_wave: number }).current_wave).toBe(1);
    expect(inventory()).toEqual({ golden_dice: 1 });
  });

  it("pays milestones with the boss win, once, and records the best tier", async () => {
    const run = beginEndlessRun("endless", army(), "9");
    const fight = seedRun(3, run);
    const result = await finishEndlessWave(db, ME, winFloor(fight, 3), LATER);
    expect(result.status).toBe(200);
    expect(inventory().brain_ticket).toBeGreaterThanOrEqual(2);
    expect((raw.prepare("SELECT best_tier FROM endless_progress WHERE account_id=? AND mode='endless'").get(ME) as { best_tier: number }).best_tier).toBe(1);
    raw.prepare("DELETE FROM endless_runs_v3").run();
    raw.prepare("UPDATE gameplay_documents_v3 SET current_json=? WHERE account_id=?").run(JSON.stringify({ inventory: {}, storage: { received: {}, stored: {} } }), ME);
    const again = seedRun(3, run);
    const repeat = await finishEndlessWave(db, ME, winFloor(again, 3), LATER);
    expect(repeat.status).toBe(200);
    const names = (repeat.body.bossLoot as { name: string; quantity: number }[]);
    // A repeat pays only the boss's own single roll now, never the milestone's 2 tickets.
    expect(names).toHaveLength(1);
  });

  it("pays brains from a milestone into the balance and the ledger", async () => {
    raw.prepare("INSERT INTO endless_progress (account_id,mode,best_tier,updated_at) VALUES (?,'endless',1,0)").run(ME);
    const run = beginEndlessRun("endless", army(), "9");
    const fight = seedRun(6, run);
    const before = brains();
    const result = await finishEndlessWave(db, ME, winFloor(fight, 6), LATER);
    expect(result.status).toBe(200);
    expect(brains()).toBe(before + 1);
    expect(raw.prepare("SELECT delta FROM ledger WHERE account_id=? AND reason='endless_milestone'").get(ME)).toMatchObject({ delta: 1 });
  });

  // Strong enough to clear any boss quickly, so a deep tier settles like a shallow one.
  const titans = () => army().map((u) => ({ ...u, str: u.str * 400, con: u.con * 400, maxHp: u.maxHp * 400, hp: u.maxHp * 400 }));
  const core = () => JSON.parse((raw.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?").get(ME) as { current_json: string }).current_json) as Record<string, unknown>;

  it("unlocks a perk on its first clear by recording the best tier on the core document", async () => {
    raw.prepare("INSERT INTO endless_progress (account_id,mode,best_tier,updated_at) VALUES (?,'endless',3,0)").run(ME);
    const fight = seedRun(12, beginEndlessRun("endless", titans(), "9"));
    const result = await finishEndlessWave(db, ME, winFloor(fight, 12), LATER);
    expect(result.status).toBe(200);
    expect(result.body.bossLoot).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "perk", perk: "crypt" })]));
    expect(core().endlessBestTier).toBe(4);
    // A perk is not an item: nothing lands in Received for it.
    expect(Object.keys(received()).some((name) => name.includes("Mausoleum"))).toBe(false);
  });

  it("gives a skipper its chest at its first boss: skipped rolls and milestones", async () => {
    const run = beginEndlessRun("endless", army(), "9", 3);
    const fight = seedRun(9, run);
    const result = await finishEndlessWave(db, ME, winFloor(fight, 9), LATER);
    expect(result.status).toBe(200);
    // T3's own roll, T1's and T2's skipped rolls, and T1-T3's milestones.
    const rewards = result.body.bossLoot as { kind: string; name: string }[];
    expect(rewards.length).toBeGreaterThanOrEqual(6);
    expect(rewards.some((r) => r.name === "Zwamp Thing")).toBe(true);
    expect(Object.keys(received()).length).toBeGreaterThan(0);
    expect(brains()).toBe(6);
  });

  it("records all-time and weekly scores on going home, each keeping only a best", async () => {
    const week = endlessWeekSeed(90_000);
    const run = beginEndlessRun("endless", [], week);
    seedRun(6, run, { wave: 6 });
    const result = await abandonEndless(db, ME, SESSION, 90_000);
    expect(result.body).toMatchObject({ deepestFloor: 6, gold: 3_000 });
    expect(gold()).toBe(3_000);
    expect(await listEndlessLeaderboard(db, "endless")).toMatchObject([{ username: "Grog", deepest_floor: 6 }]);
    expect(await listEndlessLeaderboard(db, "endless", week)).toMatchObject([{ username: "Grog", deepest_floor: 6 }]);
    expect(await listEndlessLeaderboard(db, "endless", "another-week")).toEqual([]);

    // A real run has its own id; this test reuses one, and the ledger keys on it.
    raw.prepare("DELETE FROM ledger").run();
    raw.prepare("DELETE FROM endless_runs_v3").run();
    seedRun(3, run, { wave: 3 });
    await abandonEndless(db, ME, SESSION, 95_000);
    expect(await listEndlessLeaderboard(db, "endless", week)).toMatchObject([{ deepest_floor: 6 }]);

    // A worse run elsewhere in the week still counts on a week it is the best of.
    raw.prepare("DELETE FROM ledger").run();
    raw.prepare("DELETE FROM endless_runs_v3").run();
    seedRun(3, beginEndlessRun("endless", [], "next-week"), { wave: 3 });
    await abandonEndless(db, ME, SESSION, 96_000);
    expect(await listEndlessLeaderboard(db, "endless", "next-week")).toMatchObject([{ deepest_floor: 3 }]);
    expect(await listEndlessLeaderboard(db, "endless")).toMatchObject([{ deepest_floor: 6 }]);
  });

  it("starts no Nightmare run while Nightmare is held back", async () => {
    raw.prepare("UPDATE balances SET xp=9000000 WHERE account_id=?").run(ME);
    raw.prepare(`INSERT INTO roster_v3 (account_id, unit_id, zombie_key, mutation, invasions, stored, created_at)
      VALUES (?, 'z0', 'ZombieActorZwampThing', 0, 0, 0, 0)`).run(ME);
    const started = await startEndless(db, ME, { mode: "nightmare", orderedUnitIds: ["z0"], rulesetVersion: RAID_RULESET_VERSION }, LATER);
    expect(started).toMatchObject({ status: 404, body: { error: "mode_closed" } });
    expect(brains()).toBe(5);
  });

  it("refuses a starting tier above the account's level", async () => {
    raw.prepare("UPDATE balances SET xp=61000 WHERE account_id=?").run(ME);
    raw.prepare(`INSERT INTO roster_v3 (account_id, unit_id, zombie_key, mutation, invasions, stored, created_at)
      VALUES (?, 'z0', 'ZombieActorZwampThing', 0, 0, 0, 0)`).run(ME);
    const body = { mode: "endless", orderedUnitIds: ["z0"], rulesetVersion: RAID_RULESET_VERSION };
    expect((await startEndless(db, ME, { ...body, startTier: 4 }, LATER)).status).toBe(403);
  });

  it("starts a skipped run on its opening draft, charging the entry and holding the fight back", async () => {
    raw.prepare(`INSERT INTO roster_v3 (account_id, unit_id, zombie_key, mutation, invasions, stored, created_at)
      VALUES (?, 'z0', 'ZombieActorZwampThing', 0, 0, 0, 0)`).run(ME);
    const body = { mode: "endless", orderedUnitIds: ["z0"], rulesetVersion: RAID_RULESET_VERSION };
    const started = await startEndless(db, ME, { ...body, startTier: 2 }, LATER);
    expect(started.status).toBe(200);
    expect(brains()).toBe(4);
    expect(started.body).toMatchObject({ stage: "boss-choice", opening: true, wave: 3, tier: 1 });
    expect(started.body.fight).toBeUndefined();
    const draft = endlessBossDraft("endless", 3, endlessWeekSeed(LATER), "farm");
    const chosen = await chooseEndlessBossReward(db, ME, {
      sessionId: started.body.sessionId, boon: draft.boons[0], curse: draft.curses[0], location: draft.locations[0],
    }, LATER);
    expect(chosen.status).toBe(200);
    expect(chosen.body.fight).toMatchObject({ wave: 4, ...draft.locations[0] });
  });
});
