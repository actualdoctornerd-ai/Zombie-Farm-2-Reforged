import { describe, expect, it } from "vitest";
import { applyBatch } from "../src/v3/db";
import { GAMEPLAY_PROTOCOL } from "../../src/net/protocol";

// `active_batch_id` is a SHARED marker: /commands sets and clears it inside one D1
// batch, but `beginOperation` also sets it for every raid, epic-boss, gift,
// black-market, /presentation and /save request, and only `endOperation` clears those.
// A Worker killed between the two leaves one behind, and nothing sweeps it — D1 has no
// TTL, which is why every other reader evaluates the expiry lazily instead.
//
// `applyBatch` was the last reader that did not, in TWO places: the early return and
// the CAS. An orphan therefore answered every batch with 409 for good, and the account
// sat on a live, renewing lease that applied nothing — indistinguishable, from the
// player's side, from "Gameplay paused — reconnect to continue" on a healthy
// connection. `release` had this same bug and was fixed; see writerIdle.test.ts.

const NOW = 1_000_000;

const runtimeRow = (over: Record<string, unknown> = {}) => ({
  account_id: "acct",
  account_version: 4,
  writer_device_id: "this-device",
  writer_session_id: "sess",
  writer_token_hash: "hash",
  writer_generation: 2,
  writer_last_activity_at: NOW,
  active_batch_id: null,
  active_batch_expires_at: 0,
  command_window_start: 0,
  command_window_count: 0,
  last_batch_id: null,
  last_first_sequence: 0,
  last_result_json: null,
  ...over,
});

const tables = (runtime: Record<string, unknown>): Record<string, unknown> => ({
  account_runtime_v3: runtime,
  balances: { gold: 500, brains: 10, xp: 0 },
  farm_documents_v3: { version: 0, current_json: "{}", previous_version: 0, previous_json: "{}" },
  object_documents_v3: { version: 0, current_json: "[]" },
  quest_documents_v3: { version: 0, current_json: JSON.stringify({ completed: [], progress: [] }) },
  periodic_quest_documents_v3: { version: 0, current_json: "{}" },
  gameplay_documents_v3: {
    current_json: JSON.stringify({
      inventory: {}, storage: { received: {}, stored: {} }, ownedPets: [], activePet: null,
      penPets: [], zombieMax: 16, farmSize: 30, climates: ["grass"], farmerHeads: [1],
      farmerHeadId: 1, tutorialRewarded: false,
    }),
  },
  presentations_v3: { version: 0, current_json: "{}" },
  raid_state_v3: { last_started_at: 0, progress_json: "{}" },
});

class Statement {
  args: unknown[] = [];
  constructor(readonly sql: string, private readonly rows: Record<string, unknown>) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    // Longest match wins: "quest_documents_v3" also contains "documents_v3".
    const table = Object.keys(this.rows)
      .filter((name) => this.sql.includes(name))
      .sort((a, b) => b.length - a.length)[0];
    return (table ? this.rows[table] : null) as T;
  }
  async all<T>() { return { results: [] as T[] }; }
  async run() { return { meta: { changes: 1 } }; }
}

const fakeDb = (rows: Record<string, unknown>) => {
  const batched: Statement[][] = [];
  return {
    batched,
    db: {
      prepare: (sql: string) => new Statement(sql, rows),
      batch: async (st: Statement[]) => {
        batched.push(st);
        return st.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
  };
};

const batchBody = () => ({
  protocolVersion: GAMEPLAY_PROTOCOL,
  deviceId: "this-device",
  batchId: "batch-1",
  firstSequence: 1,
  expectedAccountVersion: 4,
  writerGeneration: 2,
  commands: [{ sequence: 1, command: { type: "farm.plow" as const, oc: 0, or: 0 } }],
});

describe("an orphaned operation marker cannot wedge the command lane", () => {
  it("still refuses a batch while an operation is genuinely live", async () => {
    const { db } = fakeDb(tables(runtimeRow({
      active_batch_id: "raid-in-flight", active_batch_expires_at: NOW + 30_000,
    })));

    const result = await applyBatch(db, "acct", batchBody() as never, NOW);

    expect(result).toMatchObject({ status: 409, error: "batch_in_progress" });
  });

  it("tells the client how long to wait, so a busy lock is retried rather than re-synced", async () => {
    const { db } = fakeDb(tables(runtimeRow({
      active_batch_id: "presentation-save", active_batch_expires_at: NOW + 30_000,
    })));

    const result = await applyBatch(db, "acct", batchBody() as never, NOW);

    expect(result).toMatchObject({ status: 409, error: "batch_in_progress", body: { retryAfterMs: 250 } });
  });

  it("applies a batch once the marker is past its TTL", async () => {
    const { db, batched } = fakeDb(tables(runtimeRow({
      active_batch_id: "killed-mid-request", active_batch_expires_at: NOW - 1,
    })));

    const result = await applyBatch(db, "acct", batchBody() as never, NOW);

    expect(result.status).toBe(200);
    // The CAS has to agree with the early return. It used to require
    // `active_batch_id IS NULL` outright, so relaxing only the early return would have
    // moved the player from a permanent `batch_in_progress` to a permanent
    // `state_conflict` — still a farm that never applies anything.
    const cas = batched[batched.length - 1]?.[0]; // the commit batch, after ensureV3's
    expect(cas?.sql).toContain("active_batch_expires_at <= ?");
    expect(cas?.sql).not.toContain("AND active_batch_id IS NULL");
  });
});
