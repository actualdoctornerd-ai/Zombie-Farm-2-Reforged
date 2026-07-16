import { describe, expect, it } from "vitest";
import { expireLiveRaid } from "../src/v3/raid";
import { end as endEpicBoss, expireLiveEpicBoss } from "../src/v3/epicBoss";

class Statement {
  args: unknown[] = [];
  constructor(readonly sql: string, private row: unknown) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return this.row as T; }
}

const fakeDb = (row: unknown) => {
  const batched: Statement[][] = [];
  const db = {
    prepare(sql: string) { return new Statement(sql, sql.startsWith("SELECT") ? row : null); },
    async batch(statements: Statement[]) { batched.push(statements); return []; },
  };
  return { db: db as unknown as D1Database, batched };
};

describe("abandoned battle cleanup", () => {
  it("closes an expired invasion and releases its roster locks", async () => {
    const { db, batched } = fakeDb({ id: "raid-old" });
    await expireLiveRaid(db, "account", 10_000);
    expect(batched).toHaveLength(1);
    expect(batched[0].map((s) => s.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE raid_sessions_v3 SET finished_at"),
      expect.stringContaining("UPDATE roster_v3 SET locked_by_raid = NULL"),
    ]));
  });

  it("closes an expired Epic attempt, starts its retry, and releases locks", async () => {
    const { db, batched } = fakeDb({ id: "epic-old", run_id: "run" });
    await expireLiveEpicBoss(db, "account", 10_000);
    expect(batched).toHaveLength(1);
    expect(batched[0].map((s) => s.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE epic_boss_sessions_v3 SET finished_at"),
      expect.stringContaining("UPDATE epic_boss_runs_v3 SET retry_ready_at"),
      expect.stringContaining("UPDATE roster_v3 SET locked_by_raid=NULL"),
    ]));
  });

  it("ending an Epic event closes a live attempt and releases its roster locks", async () => {
    const { db, batched } = fakeDb({
      run_id: "run", boss_id: "dr-groundhog", activated_at: 1, expires_at: 20_000,
      level: 1, max_hp: 2_000, current_hp: 2_000, encounter_started_at: 1,
      retry_ready_at: 0, completed_at: 0, attack_order_json: "[]",
    });
    const result = await endEpicBoss(db, "account", "run", 10_000);
    expect(result.status).toBe(200);
    expect(batched).toHaveLength(1);
    expect(batched[0].map((s) => s.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE epic_boss_sessions_v3 SET finished_at"),
      expect.stringContaining("UPDATE roster_v3 SET locked_by_raid=NULL"),
      expect.stringContaining("UPDATE epic_boss_runs_v3 SET expires_at"),
    ]));
  });
});
