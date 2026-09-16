// What /bootstrap tells a client so it can light the "you were invaded" dot.
//
// The dot is only ever as truthful as this one value, and the trap it exists to avoid
// is specific: expireLivePvp stamps `finished_at` on ABANDONED attacks — rows that
// carry the would-be defender's id but never fought and never reached a verdict. The
// History tab filters them out (`win IS NOT NULL`), so counting one here would put a
// dot on a screen that has nothing to show for it.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lastInvadedAt } from "../src/v3/pvp";

const NOW = 1_700_000_000_000;
const ME = "acct-defender";
const THEM = "acct-attacker";

function open(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  for (const [id, sub, code] of [[ME, "sub-me", "AAAA1111"], [THEM, "sub-them", "BBBB2222"]]) {
    raw.prepare(`INSERT INTO accounts (id, google_sub, username, friend_code, created_at, last_online_at)
      VALUES (?, ?, NULL, ?, ?, ?)`).run(id, sub, code, NOW, NOW);
  }
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => raw.prepare(sql).get(...(params as never[])) ?? null,
      }),
    }),
  } as unknown as D1Database;
  return { db, raw };
}

/** One PvP session row. `win` null = never settled (live, or swept as abandoned). */
function session(
  raw: DatabaseSync,
  over: { id: string; defender_id?: string; finished_at?: number | null; win?: number | null },
): void {
  raw.prepare(`INSERT INTO pvp_sessions_v3
      (id, attacker_id, defender_id, config_json, ruleset_version, attack_score, defense_score,
       started_at, earliest_finish_at, expires_at, finished_at, win)
     VALUES (?, ?, ?, '{}', 1, 100, 100, ?, ?, ?, ?, ?)`)
    .run(
      over.id, THEM, over.defender_id ?? ME, NOW - 60_000, NOW - 44_000, NOW + 60_000,
      over.finished_at ?? null, over.win ?? null,
    );
}

describe("when this farm was last invaded", () => {
  it("is null for a farm nobody has ever invaded", async () => {
    const { db } = open();
    expect(await lastInvadedAt(db, ME)).toBeNull();
  });

  it("reports the newest SETTLED invasion, whichever way it went", async () => {
    const { db, raw } = open();
    session(raw, { id: "older", finished_at: NOW - 100_000, win: 1 }); // they beat me
    session(raw, { id: "newer", finished_at: NOW - 10_000, win: 0 });  // I held
    expect(await lastInvadedAt(db, ME)).toBe(NOW - 10_000);
  });

  it("ignores an attack that was abandoned rather than fought", async () => {
    const { db, raw } = open();
    session(raw, { id: "real", finished_at: NOW - 100_000, win: 1 });
    // expireLivePvp's shape: finished_at stamped, win still NULL.
    session(raw, { id: "abandoned", finished_at: NOW - 1_000, win: null });
    expect(await lastInvadedAt(db, ME)).toBe(NOW - 100_000);
  });

  it("ignores a fight still in progress", async () => {
    const { db, raw } = open();
    session(raw, { id: "live", finished_at: null, win: null });
    expect(await lastInvadedAt(db, ME)).toBeNull();
  });

  it("does not count invasions against somebody else", async () => {
    const { db, raw } = open();
    session(raw, { id: "theirs", defender_id: THEM, finished_at: NOW, win: 1 });
    expect(await lastInvadedAt(db, ME)).toBeNull();
  });
});
