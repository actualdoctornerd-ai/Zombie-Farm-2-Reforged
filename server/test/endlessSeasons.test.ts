// The launch-week season freeze (migration 0064) against the real schema, on node:sqlite: the
// all-time board moves into endless_leaderboard_seasons intact, both live boards start empty,
// and the season reads back ranked like the live board.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { listEndlessLeaderboard, listEndlessSeasonLeaderboard } from "../src/db";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function openDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(read("../schema.sql"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: raw.prepare(sql).all(...(params as never[])) }),
  });
  return { db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, raw };
}

describe("Endless launch-week season (migration 0064)", () => {
  it("freezes the all-time board as launch-week and empties both live boards", async () => {
    const { db, raw } = openDb();
    const account = raw.prepare("INSERT INTO accounts (id, google_sub, username, friend_code, created_at) VALUES (?,?,?,?,0)");
    const best = raw.prepare(`INSERT INTO endless_leaderboard
      (account_id, mode, deepest_floor, duration_ms, army_json, achieved_at) VALUES (?, 'endless', ?, ?, ?, ?)`);
    const weekly = raw.prepare(`INSERT INTO endless_weekly_leaderboard
      (week, account_id, mode, deepest_floor, duration_ms, army_json, achieved_at) VALUES ('2026-W46', ?, 'endless', ?, ?, '[]', ?)`);
    for (const [id, name, floor, at] of [["a", "Ashena", 80, 3], ["d", "DeathNote", 76, 2], ["s", "Sirface", 43, 1]] as const) {
      account.run(id, `g-${id}`, name, `ZF-${id}`);
      best.run(id, floor, 60_000, JSON.stringify([{ species: "ZombieActorPoseidon", mutation: 0, veterancy: 5 }]), at);
      weekly.run(id, floor, 60_000, at);
    }

    raw.exec(read("../migrations/0064_endless_launch_week_season.sql"));

    const season = await listEndlessSeasonLeaderboard(db, "endless", "launch-week");
    expect(season.map((row) => [row.username, row.deepest_floor])).toEqual([["Ashena", 80], ["DeathNote", 76], ["Sirface", 43]]);
    expect(JSON.parse(season[0].army_json)).toEqual([{ species: "ZombieActorPoseidon", mutation: 0, veterancy: 5 }]);
    expect(await listEndlessLeaderboard(db, "endless")).toEqual([]);
    expect(await listEndlessLeaderboard(db, "endless", "2026-W46")).toEqual([]);
    // Re-applying (a replayed migration) neither duplicates nor loses the frozen season.
    raw.exec(read("../migrations/0064_endless_launch_week_season.sql"));
    expect(await listEndlessSeasonLeaderboard(db, "endless", "launch-week")).toHaveLength(3);
  });
});
