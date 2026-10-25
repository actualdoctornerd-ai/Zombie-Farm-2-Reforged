// Halloween nights at /raid/start: continuing a won Halloween invasion into the next night
// (src/raid/halloweenNights.ts). Run against the real schema in node:sqlite, because the
// continuation is claimed with json_set / json_extract guards inside one batch, and a
// guard that SQLite reads differently from what was meant is a silent no-op.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { startRaid } from "../src/v3/raid";
import { RAID_RULESET_VERSION } from "../src/raidVerifier";
import { levelForXp } from "../src/levels";
import {
  NIGHT_CONTINUE_WINDOW_MS, NIGHT_TIME_LIMIT_MS, nightHpMult,
} from "../../src/raid/halloweenNights";

const NOW = 1_700_000_000_000;
const ME = "acct-night";
const HALLOWEEN = 16;
const ARMY = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];

/** node:sqlite behind the slice of D1 that startRaid uses: first / all / run, and a batch
 *  that runs as ONE transaction, as D1's does. */
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

function xpForLevel(level: number): number {
  let xp = 0;
  while (levelForXp(xp) < level) xp += 100;
  return xp;
}

/** An account at level 25 that has just won Halloween (session `won`) with ARMY, two of
 *  whom died. Its cooldown started a moment ago, so only a night can launch. */
function seed(over: { result?: unknown; finishedAt?: number; boosts?: unknown } = {}) {
  const { db, raw } = openDb();
  raw.prepare(`INSERT INTO accounts (id, google_sub, friend_code, created_at, last_online_at)
    VALUES (?, 'sub', 'CODE1234', ?, ?)`).run(ME, NOW, NOW);
  raw.prepare("INSERT INTO balances (account_id, gold, brains, xp) VALUES (?, 0, 0, ?)").run(ME, xpForLevel(25));
  raw.prepare("INSERT INTO gameplay_documents_v3 (account_id, current_json, updated_at) VALUES (?, ?, ?)")
    .run(ME, JSON.stringify({ inventory: {}, storage: { received: {}, stored: {} } }), NOW);
  raw.prepare("INSERT INTO object_documents_v3 (account_id, current_json, updated_at) VALUES (?, '[]', ?)").run(ME, NOW);
  raw.prepare("INSERT INTO raid_state_v3 (account_id, last_started_at, progress_json) VALUES (?, ?, ?)")
    .run(ME, NOW - 60_000, JSON.stringify({ [HALLOWEEN]: 1 }));
  for (const id of ARMY) {
    raw.prepare(`INSERT INTO roster_v3 (account_id, unit_id, zombie_key, created_at)
      VALUES (?, ?, 'ZombieActorRegularTier1', ?)`).run(ME, id, NOW);
  }
  const survivors = ARMY.slice(0, 6);
  raw.prepare(`INSERT INTO raid_sessions_v3
    (id, account_id, raid_id, roster_json, boosts_json, config_json, ruleset_version,
     started_at, earliest_finish_at, expires_at, finished_at, result_json)
    VALUES ('won', ?, ?, ?, ?, '"spent"', ?, ?, ?, ?, ?, ?)`).run(
    ME, String(HALLOWEEN), JSON.stringify(ARMY), JSON.stringify(over.boosts ?? {}), RAID_RULESET_VERSION,
    NOW - 60_000, NOW - 45_000, NOW + 600_000, over.finishedAt ?? NOW - 5_000,
    JSON.stringify(over.result ?? { outcome: { win: true, survivors, losses: ARMY.slice(6) } }),
  );
  return { db, raw, survivors };
}

const start = (db: D1Database, over: Record<string, unknown> = {}) => startRaid(db, ME, {
  raidId: HALLOWEEN, orderedUnitIds: ARMY.slice(0, 6), continueFrom: "won",
  rulesetVersion: RAID_RULESET_VERSION, ...over,
}, NOW);

const sessionBoosts = (raw: DatabaseSync, id: string) =>
  JSON.parse((raw.prepare("SELECT boosts_json FROM raid_sessions_v3 WHERE id = ?").get(id) as { boosts_json: string }).boosts_json);

describe("continuing a won Halloween invasion into the next night", () => {
  it("opens night 2 for the survivors while the cooldown is running, and claims the win", async () => {
    const { db, raw, survivors } = seed();
    const res = await start(db);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, night: 2 });
    const id = res.body.sessionId as string;
    expect(sessionBoosts(raw, id)).toMatchObject({ night: 2, chainFrom: "won", elite: false, dice: 0 });
    expect(sessionBoosts(raw, "won").continuedBy).toBe(id);
    // A night rides the cooldown its first fight started: the clock does not move.
    expect((raw.prepare("SELECT last_started_at FROM raid_state_v3").get() as { last_started_at: number })
      .last_started_at).toBe(NOW - 60_000);
    const locked = raw.prepare("SELECT unit_id FROM roster_v3 WHERE locked_by_raid = ? ORDER BY unit_id").all(id)
      .map((row) => (row as { unit_id: string }).unit_id);
    expect(locked).toEqual(survivors);
  });

  it("pins the night's three-minute clock and its bulk", async () => {
    const { db, raw } = seed();
    const res = await start(db);
    const config = JSON.parse((raw.prepare("SELECT config_json FROM raid_sessions_v3 WHERE id = ?")
      .get(res.body.sessionId as string) as { config_json: string }).config_json);
    expect(config.night).toBe(2);
    expect(config.timeLimitMs).toBe(NIGHT_TIME_LIMIT_MS);
    // Against the same account's ORDINARY fight, launched once its cooldown is over.
    const ordinary = seed();
    ordinary.raw.prepare("UPDATE raid_state_v3 SET last_started_at = 0").run();
    const plain = await startRaid(ordinary.db, ME, {
      raidId: HALLOWEEN, orderedUnitIds: ARMY, rulesetVersion: RAID_RULESET_VERSION,
    }, NOW);
    expect(plain.status).toBe(200);
    const plainConfig = JSON.parse((ordinary.raw.prepare("SELECT config_json FROM raid_sessions_v3 WHERE id = ?")
      .get(plain.body.sessionId as string) as { config_json: string }).config_json);
    expect(plainConfig.night).toBeUndefined();
    expect(plainConfig.timeLimitMs).toBeGreaterThan(NIGHT_TIME_LIMIT_MS);
    const bossHp = (c: { enemyUnits: { isBoss?: boolean; maxHp: number }[] }) =>
      c.enemyUnits.find((unit) => unit.isBoss)!.maxHp;
    expect(bossHp(config) / bossHp(plainConfig)).toBeCloseTo(nightHpMult(2), 1);
  });

  it("counts on from the night it continues", async () => {
    const { db } = seed({ boosts: { night: 3, chainFrom: "earlier" } });
    const res = await start(db);
    expect(res.body).toMatchObject({ ok: true, night: 4 });
  });

  it("is taken once: a second continuation of the same win is refused", async () => {
    const { db, raw } = seed();
    const first = await start(db);
    // Free the army again, as a settled night would, so only the claim can refuse it.
    raw.prepare("UPDATE roster_v3 SET locked_by_raid = NULL").run();
    raw.prepare("UPDATE raid_sessions_v3 SET finished_at = ? WHERE id = ?").run(NOW, first.body.sessionId as string);
    const second = await start(db);
    expect(second).toMatchObject({ status: 409, body: { error: "night_taken" } });
  });

  it("writes nothing when a racing continuation claims the win first", async () => {
    const { db, raw } = seed();
    // Both requests have passed the read; the other one's batch commits first.
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: unknown[]) => {
        raw.prepare(`UPDATE raid_sessions_v3 SET boosts_json = json_set(boosts_json, '$.continuedBy', 'other')
          WHERE id = 'won'`).run();
        return (db.batch as (s: unknown[]) => Promise<unknown>)(statements);
      },
    } as unknown as D1Database;
    const res = await start(racing);
    expect(res).toMatchObject({ status: 409, body: { error: "night_taken" } });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM raid_sessions_v3").get()).toMatchObject({ n: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM roster_v3 WHERE locked_by_raid IS NOT NULL").get())
      .toMatchObject({ n: 0 });
  });

  it("is fought only by zombies that came home", async () => {
    const { db } = seed();
    const res = await start(db, { orderedUnitIds: ["u1", "u7"] }); // u7 died
    expect(res).toMatchObject({ status: 409, body: { error: "bad_roster" } });
  });

  it("needs no minimum army: a lone survivor may go on", async () => {
    const { db } = seed();
    const res = await start(db, { orderedUnitIds: ["u3"] });
    expect(res.body).toMatchObject({ ok: true, night: 2 });
  });

  it("follows only a win", async () => {
    const { db } = seed({ result: { outcome: { win: false, survivors: ARMY, losses: [] } } });
    expect(await start(db)).toMatchObject({ status: 409, body: { error: "night_unavailable" } });
  });

  it("lapses once the sitting is over", async () => {
    const { db } = seed({ finishedAt: NOW - NIGHT_CONTINUE_WINDOW_MS - 1 });
    expect(await start(db)).toMatchObject({ status: 409, body: { error: "night_expired" } });
  });

  it("takes no Brain Ticket", async () => {
    const { db } = seed();
    expect(await start(db, { brainTicket: true })).toMatchObject({ status: 409, body: { error: "elite_unavailable" } });
  });

  it("belongs to Halloween only", async () => {
    const { db } = seed();
    expect(await start(db, { raidId: 10 })).toMatchObject({ status: 400, body: { error: "bad_continue" } });
  });
});
