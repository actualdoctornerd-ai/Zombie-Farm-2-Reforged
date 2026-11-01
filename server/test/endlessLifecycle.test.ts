import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  abandonEndless, activeEndless, chooseEndlessBossReward,
} from "../src/v3/endless";
import { beginEndlessRun, endlessBossDraft } from "../../src/raid/endless";
import { RAID_RULESET_VERSION } from "../../src/raid/replay";

type Row = Record<string, unknown>;
class Statement {
  args: unknown[] = [];
  constructor(readonly sql: string, private readonly row: Row | null, private readonly writes: Statement[]) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return this.row as T | null; }
  async run() { this.writes.push(this); return { meta: { changes: 1 } }; }
}

function fakeDb(row: Row) {
  const batches: Statement[][] = [];
  const writes: Statement[] = [];
  const db = {
    prepare(sql: string) {
      return new Statement(sql, sql.startsWith("SELECT") ? row : null, writes);
    },
    async batch(statements: Statement[]) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, batches, writes };
}

function session(wave: number, payload: Row): Row {
  return {
    id: "endless-session", account_id: "account-1", mode: "endless", current_wave: wave,
    run_state_json: JSON.stringify(payload), army_json: "[]", fight_config_json: "{}",
    ruleset_version: RAID_RULESET_VERSION, started_at: 1_000, fight_started_at: 1_000,
    finished_at: null, result_json: null,
  };
}

describe("Endless run checkpoints and early exit", () => {
  it("resumes an old in-battle checkpoint from its pinned fight start", async () => {
    const run = beginEndlessRun("endless", []);
    const checkpoint = session(5, { run, playerLevel: 40, durationMs: 12_000 });
    checkpoint.started_at = 1_000;
    const { db } = fakeDb(checkpoint);

    const result = await activeEndless(db, "account-1");
    expect(result.status).toBe(200);
    expect(result.body.stage).toBe("battle");
    expect(result.body.wave).toBe(5);
    expect(result.body.fight).toEqual({});
  });

  it("resumes a cleared boss at its persisted boon/curse screen", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 9 };
    const checkpoint = session(8, { run, playerLevel: 45, durationMs: 28_000, pendingBossChoice: { wave: 8 } });
    const { db } = fakeDb(checkpoint);

    const result = await activeEndless(db, "account-1");
    expect(result.status).toBe(200);
    expect(result.body.stage).toBe("boss-choice");
    expect(result.body.bossDraft).toEqual(endlessBossDraft("endless", 8));
    expect(result.body.fight).toBeUndefined();
  });

  it("commits a valid boss choice before opening the next battle", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 5 };
    const { db, writes } = fakeDb(session(4, {
      run, playerLevel: 35, durationMs: 21_000, pendingBossChoice: { wave: 4 },
    }));
    const draft = endlessBossDraft("endless", 4);

    const result = await chooseEndlessBossReward(db, "account-1", {
      sessionId: "endless-session", boon: draft.boons[0], curse: draft.curses[0],
    }, 40_000);
    expect(result.status).toBe(200);
    expect(result.body.nextWave).toBe(5);
    expect(result.body.fight).toMatchObject({ wave: 5 });
    expect(writes[0].sql).toContain("UPDATE endless_runs_v3 SET current_wave=?");
    expect(JSON.parse(String(writes[0].args[1])).pendingBossChoice).toBeUndefined();
  });

  it("settles every cleared floor's gold when the player ends early", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 9 };
    const checkpoint = session(8, { run, playerLevel: 45, durationMs: 28_000, pendingBossChoice: { wave: 8 } });
    const { db, batches } = fakeDb(checkpoint);

    const result = await abandonEndless(db, "account-1", "endless-session", 90_000);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ runFinished: true, abandoned: true, deepestFloor: 8, gold: 3_000 });
    expect(batches).toHaveLength(1);
    expect(batches[0].map((statement) => statement.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE balances SET gold=gold+?"),
      expect.stringContaining("INSERT INTO ledger"),
      expect.stringContaining("INSERT INTO endless_leaderboard"),
    ]));
  });
});
