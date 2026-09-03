// Two starts that tie on the live-session index must be told "in progress", not 500.
//
// Run against the real schema in node:sqlite so the message matched is the one
// SQLite actually produces for each of the three partial unique indexes — the whole
// helper is a string match, and a guessed string would be the classic silent no-op.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLiveSessionCollision } from "../src/v3/liveSessionRace";

const NOW = 1_700_000_000_000;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  for (const id of ["acct-a", "acct-b"]) {
    db.prepare(`INSERT INTO accounts (id, google_sub, friend_code, created_at, last_online_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, `sub-${id}`, `code-${id}`, NOW, NOW);
  }
  return db;
}

/** Run `insert` twice and hand back what the second one threw. */
function secondInsertError(insert: (id: string) => void): unknown {
  insert("first");
  try {
    insert("second");
  } catch (error) {
    return error;
  }
  throw new Error("the second live session was accepted — the unique index is gone");
}

describe("isLiveSessionCollision", () => {
  it("recognises a second live invasion (idx_raid_v3_live)", () => {
    const db = openDb();
    const error = secondInsertError((id) => db.prepare(`INSERT INTO raid_sessions_v3
      (id, account_id, raid_id, roster_json, started_at, earliest_finish_at, expires_at)
      VALUES (?, 'acct-a', '1', '[]', ?, ?, ?)`).run(id, NOW, NOW, NOW));
    expect(isLiveSessionCollision(error)).toBe(true);
  });

  it("recognises a second live epic-boss fight (idx_epic_boss_session_live_v3)", () => {
    const db = openDb();
    const error = secondInsertError((id) => db.prepare(`INSERT INTO epic_boss_sessions_v3
      (id, account_id, run_id, level, starting_hp, roster_json, config_json, started_at, expires_at)
      VALUES (?, 'acct-a', 'run', 1, 100, '[]', '{}', ?, ?)`).run(id, NOW, NOW));
    expect(isLiveSessionCollision(error)).toBe(true);
  });

  it("recognises a second live friend invasion (idx_pvp_live)", () => {
    const db = openDb();
    const error = secondInsertError((id) => db.prepare(`INSERT INTO pvp_sessions_v3
      (id, attacker_id, defender_id, config_json, ruleset_version, attack_score, defense_score,
       started_at, earliest_finish_at, expires_at)
      VALUES (?, 'acct-a', 'acct-b', '{}', 1, 0, 0, ?, ?, ?)`).run(id, NOW, NOW, NOW));
    expect(isLiveSessionCollision(error)).toBe(true);
  });

  it("does not claim a finished session blocks anything", () => {
    // The index is partial: a finished fight and a new live one coexist. Nothing
    // throws, so there is nothing for the helper to match — pinned so the index's
    // WHERE clause cannot quietly go missing from schema.sql.
    const db = openDb();
    const insert = (id: string, finished: number | null) => db.prepare(`INSERT INTO raid_sessions_v3
      (id, account_id, raid_id, roster_json, started_at, earliest_finish_at, expires_at, finished_at)
      VALUES (?, 'acct-a', '1', '[]', ?, ?, ?, ?)`).run(id, NOW, NOW, NOW, finished);
    insert("done", NOW);
    expect(() => insert("live", null)).not.toThrow();
  });

  it("leaves every other failure to be a real error", () => {
    expect(isLiveSessionCollision(new Error("no such table: combine_jobs"))).toBe(false);
    expect(isLiveSessionCollision(new Error("UNIQUE constraint failed: accounts.google_sub"))).toBe(false);
    expect(isLiveSessionCollision(new Error("FOREIGN KEY constraint failed"))).toBe(false);
    expect(isLiveSessionCollision("D1_ERROR: network")).toBe(false);
  });
});
